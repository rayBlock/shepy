import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ProfileOwner } from "@/db/profile-owners.js";
import {
  type DemandRequest,
  demandSource,
  validateDemandRequest,
  verifyDemandRef,
} from "./profile-demand-ingress.js";

const ref = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    selector: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);
const generation = Type.Object(
  {
    herdrSession: Type.String({ minLength: 1 }),
    workspaceId: Type.String({ minLength: 1 }),
    paneId: Type.String({ minLength: 1 }),
    terminalId: Type.String({ minLength: 1 }),
    nativeSessionRef: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const strictUtc = Type.String({ pattern: "^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$" });
const dutySchema = Type.Object(
  {
    schema: Type.Literal("factory.duty.v1"),
    seatId: Type.String({ minLength: 1 }),
    profileId: Type.String({ minLength: 1 }),
    ownerGeneration: generation,
    grantRef: ref,
    mode: Type.Union([
      Type.Literal("on-duty"),
      Type.Literal("waiting"),
      Type.Literal("deferred"),
      Type.Literal("off-duty"),
    ]),
    window: Type.Object(
      { startsAt: strictUtc, endsAt: strictUtc, timezone: Type.Literal("UTC") },
      { additionalProperties: false },
    ),
    queues: Type.Array(
      Type.Object(
        {
          root: Type.String({ minLength: 1 }),
          queuePath: Type.String({ minLength: 1 }),
          ownership: Type.Array(
            Type.Object(
              {
                rowId: Type.String({ minLength: 1 }),
                packetId: Type.String({ minLength: 1 }),
                actionClass: Type.Union([
                  Type.Literal("execute"),
                  Type.Literal("prepare"),
                  Type.Literal("collect"),
                  Type.Literal("decide"),
                ]),
                packetRef: ref,
                grantRef: ref,
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    capacity: Type.Object(
      {
        maxInFlight: Type.Integer({ minimum: 1 }),
        observationRef: ref,
        maxAgeSeconds: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    stopPaths: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    nextDecision: Type.Object(
      { reasonRef: ref, eventRef: Type.Union([ref, Type.Null()]), revisitAt: strictUtc },
      { additionalProperties: false },
    ),
    successor: Type.Object(
      {
        profileId: Type.String({ minLength: 1 }),
        routeRef: ref,
        ownerGeneration: Type.Union([generation, Type.Null()]),
      },
      { additionalProperties: false },
    ),
    policy: Type.Object(
      {
        idleGraceSeconds: Type.Literal(60),
        cooldownSeconds: Type.Literal(1200),
        maxWakesPerHour: Type.Literal(3),
        maxReminderCount: Type.Literal(1),
        defaultRevisitSeconds: Type.Literal(1200),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const capacitySchema = Type.Object(
  {
    observedAt: strictUtc,
    seatGeneration: generation,
    activeInvocationIds: Type.Array(Type.String()),
    occupiedSlots: Type.Integer({ minimum: 0 }),
    availableSlots: Type.Integer({ minimum: 0 }),
    scopeRef: ref,
  },
  { additionalProperties: false },
);
/**
 * Provenance label for the waits classifier cited by a derived-wait receipt:
 * the engine waits census (1.222), invoked on its read-only reconcile path.
 * The actual reconcile output carries neither an identity nor a time field,
 * so these two receipt fields are PROVENANCE ASSERTIONS of the allowlisted
 * receipt writer — checked as provenance only. The semantic authority for a
 * waits breach is the census row itself (bound below); no other class,
 * quiet signal or liveness reading can found a breach.
 */
export const PROMISE_BREACH_WAITS_CLASSIFIER = "factory.waits.reconcile@read-only-census";

// ─── canonical promise-record law ───
// Reimplemented from the engine's tools/promises/ledger.ts (v1 PromiseLine
// + v2 ArmLine/event fold, PROMISE-LEDGER-01/15.263). No engine path is
// imported: shipped Shepy source stays free of machine-specific engine
// dependencies, and these validators bind ONLY the fields the adapter
// derives. Unsupported or ambiguous bytes are UNKNOWN and refused by name,
// never accepted by guessing.

const PROMISE_ID_RE = /^p[0-9]+$/;
const PROMISE_DUE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A due that is shape-valid, a real calendar date AND parseable — the
 * canonical due law. An unparseable due on an open line is UNKNOWN and
 * refuses by name, never "due passed". */
function promiseDueMs(due: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(due);
  if (m === null) return Number.NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return Number.NaN;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dueMonthDays = MONTH_DAYS[mo - 1];
  if (dueMonthDays === undefined || d > (mo === 2 && leap ? 29 : dueMonthDays)) return Number.NaN;
  if (!PROMISE_DUE_RE.test(due)) return Number.NaN;
  const ms = Date.parse(due);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function validRecordDue(due: unknown): due is string {
  return typeof due === "string" && Number.isFinite(promiseDueMs(due));
}

type DerivedPromiseRecord = {
  id: string;
  dueMs: number;
  status: "open" | "kept" | "breached" | "voided";
  owner: { seat: string; worker?: string; pane?: string };
};

function deriveArmRecord(arm: Record<string, unknown>): DerivedPromiseRecord | null {
  const { id, at, owner, kind, window, promise, due, status, evidence_verb, evidence, closed_at } =
    arm;
  if (typeof id !== "string" || !PROMISE_ID_RE.test(id)) return null;
  if (typeof at !== "string" || typeof kind !== "string" || typeof promise !== "string")
    return null;
  if (!validRecordDue(due)) return null;
  if (status !== "open") return null;
  if (evidence_verb !== "commit" && evidence_verb !== "path" && evidence_verb !== "report")
    return null;
  if (evidence !== null && typeof evidence !== "string") return null;
  if (closed_at !== null) return null;
  if (!isRecordObject(owner)) return null;
  const { seat, worker, pane } = owner;
  if (typeof seat !== "string" || typeof worker !== "string" || typeof pane !== "string")
    return null;
  if (!isRecordObject(window) || typeof window.from !== "string" || typeof window.to !== "string")
    return null;
  return { id, dueMs: promiseDueMs(due), status: "open", owner: { seat, worker, pane } };
}

/** Fold ONE promise record from its owned snapshot bytes. Supported shapes
 * (the correction contract): a v1 whole-line state, a bare v2 arm (status
 * open AS OF the snapshot), or a v2 {arm, events} envelope folded under the
 * canonical event law. Anything else is UNKNOWN. */
function derivePromiseRecord(value: unknown): DerivedPromiseRecord | null {
  if (!isRecordObject(value)) return null;
  if (value.v === 1) {
    const { id, at, seat, kind, promise, due, status, evidence, closed_at } = value;
    if (typeof id !== "string" || !PROMISE_ID_RE.test(id)) return null;
    if (typeof at !== "string" || typeof seat !== "string" || typeof kind !== "string") return null;
    if (typeof promise !== "string" || !validRecordDue(due)) return null;
    if (status !== "open" && status !== "kept" && status !== "breached") return null;
    if (evidence !== null && typeof evidence !== "string") return null;
    if (closed_at !== null && typeof closed_at !== "string") return null;
    return { id, dueMs: promiseDueMs(due), status, owner: { seat } };
  }
  if (value.v === 2 && !("arm" in value) && !("events" in value)) {
    return deriveArmRecord(value);
  }
  if (isRecordObject(value.arm)) {
    const arm = deriveArmRecord(value.arm);
    if (arm === null || !Array.isArray(value.events)) return null;
    let status = arm.status;
    for (const event of value.events) {
      if (!isRecordObject(event) || typeof event.id !== "string" || event.id !== arm.id) continue;
      if (event.event === "breach" || event.event === "escalation") status = "breached";
      else if (event.event === "keep") status = "kept";
      else if (event.event === "void") status = "voided";
      // ack and unknown events change nothing (the canonical fold)
    }
    return { ...arm, status };
  }
  return null;
}

/** The receipt's ownership claim must match exactly what the canonical
 * record supplies — and never assert more than the record carries. */
function ownershipMatches(
  record: { seat: string; worker?: string; pane?: string },
  claim: { seat: string; worker?: string; pane?: string } | undefined,
): boolean {
  if (claim === undefined || claim.seat !== record.seat) return false;
  if (record.worker === undefined) {
    return claim.worker === undefined && claim.pane === undefined;
  }
  return claim.worker === record.worker && claim.pane === record.pane;
}

// ─── canonical waits census law ───
// Reimplemented from tools/waits/reconcile.ts (ReconcileResult/WaitRow —
// the actual `reconcile --json` output) and tools/waits/defs.ts (the stamp
// window). The calendar table here is the canonical promises/ledger.ts one:
// where the two tools' tables could disagree on impossible calendar dates
// the adapter resolves UNKNOWN and refuses — fail-closed, never guessed.

const WAIT_CLASSES = ["live", "debt", "pending", "closed"];
const CENSUS_COUNT_KEYS = ["live", "debt", "pending", "closed", "voided", "nonwait", "malformed"];
const STAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T~\s]+([0-9x]{1,2}))?(?::([0-9x]{2}))?(?::([0-9x]{2}))?(?:\s*(Z|[+-]\d{2}(?::?\d{2})?))?/;

/** Mirror of tools/waits/defs.ts stampWindow: one hand-ledger stamp resolved
 * to its bounded window [minMs,maxMs]; null when it resolves to no machine
 * instant (unknown, never a guess). */
function stampWindowMs(text: string): { minMs: number; maxMs: number } | null {
  const m = STAMP_RE.exec(text.trim());
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const stampMonthDays = MONTH_DAYS[mo - 1];
  if (stampMonthDays === undefined || d > (mo === 2 && leap ? 29 : stampMonthDays)) return null;
  const hourRaw = m[4];
  if (hourRaw === undefined) return null; // no time part: no instant of watch
  let hour: number;
  let hourFuzz = false;
  if (hourRaw.includes("x")) {
    hour = Number(hourRaw.replace(/x/g, "0"));
    hourFuzz = true;
  } else hour = Number(hourRaw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const minuteRaw = m[5] ?? "";
  let minute: number;
  let minuteFuzz = false;
  if (minuteRaw.includes("x")) {
    minute = Number(minuteRaw.replace(/x/g, "0"));
    minuteFuzz = true;
  } else minute = Number(minuteRaw);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const secRaw = m[6];
  let sec: number;
  let secFuzz = false;
  if (secRaw === undefined) {
    sec = 0;
    secFuzz = true; // minute precision: the whole minute is the window
  } else if (secRaw.includes("x")) {
    sec = Number(secRaw.replace(/x/g, "0"));
    secFuzz = true;
  } else sec = Number(secRaw);
  if (!Number.isInteger(sec) || sec < 0 || sec > 59) return null;
  const zone = m[7] ?? "Z"; // zoneless resolves as UTC (bounded family)
  let zoneOffsetMs = 0;
  if (zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const hh = Number(zone.slice(1, 3));
    const mm = zone.length > 4 ? Number(zone.slice(-2)) : 0;
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
    zoneOffsetMs = sign * (hh * 60 + mm) * 60000;
  }
  const base = Date.UTC(y, mo - 1, d, hour, minute, sec) - zoneOffsetMs;
  const spread =
    ((hourFuzz ? 10 : 1) - 1) * 3600000 +
    ((minuteFuzz ? 10 : 1) - 1) * 60000 +
    (secFuzz ? 60000 : 0) -
    1;
  return { minMs: base, maxMs: base + Math.max(0, spread) };
}

type DerivedWaitRow = {
  id: string;
  deadline: string | null;
  waitClass: string;
  reason: string;
  unpaired: boolean;
};

/** Parse the ACTUAL `reconcile --json` output (ReconcileResult): exact keys,
 * exact WaitRow shape. Any other shape — including a plausible-looking
 * census of a different producer — is UNKNOWN. */
function deriveCensusRows(value: unknown): DerivedWaitRow[] | null {
  if (!isRecordObject(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 5 ||
    !["census", "rows", "unpaired", "probes", "backfilled"].every((key) => keys.includes(key))
  )
    return null;
  if (!isRecordObject(value.census)) return null;
  const censusKeys = Object.keys(value.census);
  if (
    censusKeys.length !== CENSUS_COUNT_KEYS.length ||
    !CENSUS_COUNT_KEYS.every((key) => censusKeys.includes(key))
  )
    return null;
  for (const key of CENSUS_COUNT_KEYS) {
    const count = value.census[key];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
  }
  for (const key of ["rows", "unpaired", "probes", "backfilled"]) {
    if (!Array.isArray(value[key])) return null;
  }
  const rows: DerivedWaitRow[] = [];
  for (const rowValue of value.rows as unknown[]) {
    if (!isRecordObject(rowValue)) return null;
    const rowKeys = Object.keys(rowValue);
    if (
      rowKeys.length !== 7 ||
      !["id", "subject", "deadline", "waitClass", "reason", "citation", "unpaired"].every((key) =>
        rowKeys.includes(key),
      )
    )
      return null;
    const { id, subject, deadline, waitClass, reason, citation, unpaired } = rowValue;
    if (typeof id !== "string" || typeof subject !== "string") return null;
    if (deadline !== null && typeof deadline !== "string") return null;
    if (typeof waitClass !== "string" || !WAIT_CLASSES.includes(waitClass)) return null;
    if (typeof reason !== "string") return null;
    if (citation !== null && !isRecordObject(citation)) return null;
    if (typeof unpaired !== "boolean") return null;
    rows.push({ id, deadline, waitClass, reason, unpaired });
  }
  return rows;
}
/**
 * Per-incident breach receipt. This is the WHOLE-FILE content behind a
 * demand's snapshotRef: the scanner owns one immutable file per incident, so
 * the whole-file sha256 that verifyDemandRef checks is the receipt's own
 * hash — never a selector into a mutable multi-incident ledger. A later,
 * unrelated append to the source ledger cannot change it, and any mutation
 * of the receipt itself fails the hash at re-validation (publish AND lease).
 */
const breachReceiptSchema = Type.Object(
  {
    schema: Type.Literal("factory.promise-breach.receipt.v1"),
    incidentId: Type.String({ minLength: 1, maxLength: 256 }),
    // Binds the receipt to exactly one demand episode: a receipt cannot be
    // replayed as evidence for a different demand.
    episodeId: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    basis: Type.Union([Type.Literal("armed-promise"), Type.Literal("derived-wait")]),
    // Owned per-record snapshot of the exact source record (a file of its
    // own, whole-file hashed inside evidence roots) — not a live pointer
    // into the mutable ledger the record came from.
    sourceRecordRef: ref,
    promise: Type.Object(
      {
        recordId: Type.String({ minLength: 1, maxLength: 256 }),
        // The claimed standing state — must EQUAL what the cited record's
        // bytes derive (v1 whole-line status, or the v2 arm+event fold).
        // Only "open" can breach; kept/breached/voided is acknowledged or
        // already-recorded debt.
        status: Type.Union([
          Type.Literal("open"),
          Type.Literal("kept"),
          Type.Literal("breached"),
          Type.Literal("voided"),
        ]),
        // The claimed deadline — its INSTANT must equal the cited record's
        // own due (the bytes' due law), not merely be expired.
        dueAt: strictUtc,
        // The ownership the canonical record supplies (v1: seat; v2 arm:
        // seat/worker/pane). Required when the record carries it; the claim
        // must never assert more than the record carries.
        owner: Type.Optional(
          Type.Object(
            {
              seat: Type.String({ minLength: 1, maxLength: 256 }),
              worker: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
              pane: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    // Liveness is metadata, never authority: a dead PID on the same host is
    // recorded here and ignored by every predicate below.
    liveness: Type.Optional(
      Type.Object(
        { pidAlive: Type.Boolean(), host: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),
    // Provenance assertion of the allowlisted receipt writer (the actual
    // reconcile output carries no identity/time fields): WHICH classifier
    // run the receipt cites. Required (non-null) exactly when basis is
    // derived-wait; the census row bound below is the semantic authority.
    // Armed promises must carry null — they breach on their own record.
    classifier: Type.Union([
      Type.Object(
        {
          identity: Type.String({ minLength: 1, maxLength: 256 }),
          classifiedAt: strictUtc,
          censusRef: ref,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
const seatStateSchema = Type.Object(
  {
    schema: Type.Literal("factory.seat-state.v1"),
    seat: Type.String(),
    ts: strictUtc,
    ctxPct: Type.Number({ minimum: 0, maximum: 100 }),
    zone: Type.Union([
      Type.Literal("green"),
      Type.Literal("amber"),
      Type.Literal("red"),
      Type.Literal("never"),
      Type.Literal("unknown"),
    ]),
    unknown: Type.Array(Type.String()),
  },
  { additionalProperties: true },
);

function instant(value: string): number {
  const n = Date.parse(value);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== value) throw new Error("invalid-utc");
  return n;
}
function sameGeneration(a: Static<typeof generation>, b: Static<typeof generation>): boolean {
  return (
    a.herdrSession === b.herdrSession &&
    a.workspaceId === b.workspaceId &&
    a.paneId === b.paneId &&
    a.terminalId === b.terminalId &&
    a.nativeSessionRef === b.nativeSessionRef
  );
}
function ownerMatches(
  owner: ProfileOwner | undefined,
  expected: Static<typeof generation>,
): boolean {
  if (!owner) return false;
  if (
    owner.herdrSessionName !== expected.herdrSession ||
    owner.workspaceId !== expected.workspaceId ||
    owner.paneId !== expected.paneId ||
    owner.terminalId !== expected.terminalId
  )
    return false;
  try {
    const session: unknown = JSON.parse(owner.harnessSessionRefJson);
    return (
      typeof session === "object" &&
      session !== null &&
      "value" in session &&
      session.value === expected.nativeSessionRef
    );
  } catch {
    return false;
  }
}

export type Eligibility = { eligible: boolean; reasonCode: string; checkedAt: string };
/** No client-selected authority paths. All paths originate in the operator allowlist and the pinned duty. */
export class DemandEligibilityProvider {
  constructor(
    private readonly options: {
      allowlistPath?: string;
      now?: () => number;
      requiredStopPath?: string;
    } = {},
  ) {}

  evaluate(input: {
    request: DemandRequest;
    owner: ProfileOwner | undefined;
    phase: "publish" | "lease";
  }): Eligibility {
    const now = this.options.now?.() ?? Date.now();
    const checkedAt = new Date(now).toISOString();
    try {
      validateDemandRequest(input.request, {
        ...(this.options.allowlistPath ? { allowlistPath: this.options.allowlistPath } : {}),
        now,
      });
      const source = demandSource(input.request, this.options.allowlistPath);
      // The daemon has no continuation-disposition writer or admitted successor binding yet.
      // Do not promote a caller assertion of those routes into delivery authority.
      // promise-breach is admitted with its own evidence predicates below;
      // every other kind stays refused.
      if (input.request.kind !== "queue-claimable" && input.request.kind !== "promise-breach")
        throw new Error("route-proof-unavailable");
      // One incident, one demand: promise-breach re-observation is idempotent
      // under the same key, never a caller-selected revision escalation.
      if (input.request.activationRevision !== 1) throw new Error("continuation-proof-unavailable");
      if (!source.seat_state_path || !isAbsolute(source.seat_state_path))
        throw new Error("seat-state-path-unknown");
      if (!source.grant_hashes.includes(input.request.grantRef.sha256))
        throw new Error("grant-not-pinned");
      const dutyValue: unknown = JSON.parse(readFileSync(input.request.dutyRef.path, "utf8"));
      if (!Value.Check(dutySchema, dutyValue)) throw new Error("duty-unknown");
      const duty = dutyValue;
      if (
        duty.seatId !== input.request.seatId ||
        duty.profileId !== input.request.profileId ||
        !sameGeneration(duty.ownerGeneration, input.request.ownerGeneration)
      )
        throw new Error("duty-generation-mismatch");
      if (
        duty.grantRef.sha256 !== input.request.grantRef.sha256 ||
        duty.grantRef.path !== input.request.grantRef.path
      )
        throw new Error("grant-mismatch");
      if (duty.capacity.maxInFlight !== 1) throw new Error("capacity-limit-not-admitted");
      if (
        !duty.stopPaths.includes(this.options.requiredStopPath ?? join(homedir(), ".factory/STOP"))
      )
        throw new Error("stop-binding-missing");
      if (duty.queues.length === 0 || duty.queues.every((queue) => queue.ownership.length === 0))
        throw new Error("ownership-unknown");
      for (const queue of duty.queues) {
        if (!isAbsolute(queue.root) || queue.queuePath !== join(queue.root, "queue.json"))
          throw new Error("queue-binding-invalid");
        for (const entry of queue.ownership) {
          verifyDemandRef(entry.packetRef, source.evidence_roots);
          verifyDemandRef(entry.grantRef, source.evidence_roots);
        }
      }
      if (duty.stopPaths.some((path) => !isAbsolute(path) || existsSync(path)))
        throw new Error("stop-present-or-invalid");
      if (input.phase === "lease" && !input.owner) throw new Error("owner-unclaimed");
      if (input.owner && !ownerMatches(input.owner, input.request.ownerGeneration))
        throw new Error("owner-generation-mismatch");
      if (duty.mode !== "on-duty") throw new Error(`duty-${duty.mode}`);
      const start = instant(duty.window.startsAt),
        end = instant(duty.window.endsAt);
      if (end <= start || end - start > 120 * 60_000 || now < start || now >= end)
        throw new Error("duty-window-closed");
      if (!source.duty_paths.includes(input.request.dutyRef.path))
        throw new Error("duty-not-allowed");
      verifyDemandRef(duty.capacity.observationRef, source.evidence_roots);
      const observation: unknown = JSON.parse(
        readFileSync(duty.capacity.observationRef.path, "utf8"),
      );
      if (!Value.Check(capacitySchema, observation)) throw new Error("capacity-unknown");
      verifyDemandRef(observation.scopeRef, source.evidence_roots);
      if (
        !sameGeneration(observation.seatGeneration, duty.ownerGeneration) ||
        observation.availableSlots + observation.occupiedSlots !== duty.capacity.maxInFlight ||
        observation.availableSlots < 1 ||
        observation.occupiedSlots !== observation.activeInvocationIds.length ||
        now < instant(observation.observedAt) ||
        now - instant(observation.observedAt) > duty.capacity.maxAgeSeconds * 1000
      )
        throw new Error("capacity-unavailable");
      const seatValue: unknown = JSON.parse(readFileSync(source.seat_state_path, "utf8"));
      if (!Value.Check(seatStateSchema, seatValue)) throw new Error("seat-state-unknown");
      const expectedZone =
        seatValue.ctxPct < 35
          ? "green"
          : seatValue.ctxPct < 55
            ? "amber"
            : seatValue.ctxPct < 75
              ? "red"
              : "never";
      if (
        seatValue.seat !== duty.seatId ||
        seatValue.unknown.length ||
        seatValue.zone !== expectedZone ||
        seatValue.zone === "never" ||
        now < instant(seatValue.ts) ||
        now - instant(seatValue.ts) > duty.capacity.maxAgeSeconds * 1000
      )
        throw new Error("seat-state-unavailable");
      if (input.request.kind === "promise-breach") {
        // The adoption cutoff is operator-pinned in the allowlist; a source
        // without one cannot carry promise-breach demands at all.
        if (!source.promise_adoption_since) throw new Error("adoption-cutoff-missing");
        // snapshotRef was whole-file hash-verified against evidence roots by
        // validateDemandRequest. Its content must parse as a SINGLE per-
        // incident receipt: a mutable multi-incident ledger (or any other
        // shape) is refused — a selector never made a ledger line immutable.
        let receiptValue: unknown;
        try {
          receiptValue = JSON.parse(readFileSync(input.request.snapshotRef.path, "utf8"));
        } catch {
          throw new Error("breach-receipt-unknown");
        }
        if (!Value.Check(breachReceiptSchema, receiptValue))
          throw new Error("breach-receipt-unknown");
        const receipt = receiptValue;
        if (receipt.episodeId !== input.request.episodeId)
          throw new Error("breach-receipt-mismatch");
        verifyDemandRef(receipt.sourceRecordRef, source.evidence_roots);
        // THE breach gate (both bases): a complete promise/deadline, fully
        // expired at observation and now. Nothing else — not a dead PID,
        // not quiet, not capacity — can substitute for the expired
        // immutable deadline.
        const due = instant(receipt.promise.dueAt);
        if (!(due < now && due < instant(input.request.observedAt)))
          throw new Error("deadline-not-expired");
        if (receipt.basis === "armed-promise") {
          // Armed promises breach on their own record; they do not ride
          // the waits classifier.
          if (receipt.classifier !== null) throw new Error("classifier-not-admitted");
          // BA-1 binding: the receipt's ID/status/deadline/ownership claims
          // must be DERIVED from the cited record's bytes — a hash proves
          // the bytes, never the semantic claim. Supported shapes are the
          // canonical v1 whole-line state, a bare v2 arm, or a v2
          // {arm, events} envelope folded under the canonical event law;
          // anything else — including non-JSON bytes — is UNKNOWN.
          let recordValue: unknown;
          try {
            recordValue = JSON.parse(readFileSync(receipt.sourceRecordRef.path, "utf8"));
          } catch {
            throw new Error("breach-record-unknown");
          }
          const record = derivePromiseRecord(recordValue);
          if (record === null) throw new Error("breach-record-unknown");
          if (receipt.promise.recordId !== record.id) throw new Error("breach-record-mismatch");
          if (due !== record.dueMs) throw new Error("breach-deadline-mismatch");
          if (receipt.promise.status !== record.status) throw new Error("breach-status-mismatch");
          if (!ownershipMatches(record.owner, receipt.promise.owner))
            throw new Error("breach-ownership-mismatch");
          // Kept/breached/voided is acknowledged or already-recorded debt —
          // never woken.
          if (record.status !== "open") throw new Error("promise-already-resolved");
        } else {
          // Provenance: the receipt must cite the read-only classifier run
          // (identity constant, not after the observation). These two
          // fields are assertions of the allowlisted receipt writer — the
          // actual reconcile output carries neither — and are checked as
          // provenance only. The census row below is the semantic
          // authority for a waits breach.
          if (!receipt.classifier) throw new Error("waits-classifier-missing");
          if (receipt.classifier.identity !== PROMISE_BREACH_WAITS_CLASSIFIER)
            throw new Error("waits-classifier-unknown");
          if (instant(receipt.classifier.classifiedAt) > instant(input.request.observedAt))
            throw new Error("waits-classification-stale");
          verifyDemandRef(receipt.classifier.censusRef, source.evidence_roots);
          // BA-2 binding: the census bytes must be an actual ReconcileResult
          // and must CONTAIN the claimed wait as exactly one matched row,
          // debt by the canonical deadline arm, still unpaired — and the
          // claimed due must lie inside that row's resolved deadline
          // window. The row is the only id-bearing authority for waits
          // (opening lines carry no fold-assigned id), so it — not the
          // ledger-opening snapshot — is what the claims bind to.
          let censusValue: unknown;
          try {
            censusValue = JSON.parse(readFileSync(receipt.classifier.censusRef.path, "utf8"));
          } catch {
            throw new Error("waits-census-unknown");
          }
          const rows = deriveCensusRows(censusValue);
          if (rows === null) throw new Error("waits-census-unknown");
          const matches = rows.filter((row) => row.id === receipt.promise.recordId);
          if (matches.length === 0) throw new Error("waits-row-absent");
          if (matches.length > 1) throw new Error("waits-row-ambiguous");
          const matched = matches[0];
          if (matched === undefined || matched.waitClass !== "debt")
            throw new Error("waits-row-not-debt");
          // The canonical deadline arm ONLY: complete-uncollected and
          // closure-without-citation debt refuse by name (packet law).
          if (matched.reason !== "deadline-passed, no closure")
            throw new Error("waits-row-reason-unknown");
          if (!matched.unpaired) throw new Error("waits-row-paired");
          const window = matched.deadline === null ? null : stampWindowMs(matched.deadline);
          // Unresolvable deadline or a window not entirely past: the row is
          // not a deadline-passed debt at this read (future/live, pending).
          if (window === null || window.maxMs > now) throw new Error("waits-row-not-debt");
          if (!(due >= window.minMs && due <= window.maxMs))
            throw new Error("breach-deadline-mismatch");
          // A wait has no kept/breached state of its own: the breach claim
          // stands only on an open (unpaired) row.
          if (receipt.promise.status !== "open") throw new Error("breach-status-mismatch");
          // Pre-adoption debt is reported once upstream, never woken.
          if (due < instant(source.promise_adoption_since)) throw new Error("pre-adoption-debt");
        }
      }
      return { eligible: true, reasonCode: "eligible", checkedAt };
    } catch (error) {
      const reasonCode = error instanceof Error ? error.message : "eligibility-unknown";
      return { eligible: false, reasonCode: `demand:${reasonCode}`, checkedAt };
    }
  }
}
