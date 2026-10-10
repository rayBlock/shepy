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
 * The ONLY waits classifier admitted as promise-breach authority: the engine
 * waits census (1.222), invoked on its read-only reconcile path. The receipt
 * must name it exactly; no other classification, quiet signal or liveness
 * reading can found a breach.
 */
export const PROMISE_BREACH_WAITS_CLASSIFIER = "factory.waits.reconcile@read-only-census";
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
        // Only an open promise can breach; closed/voided is acknowledged debt.
        status: Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("voided")]),
        // The valid, immutable deadline. Its expiry is the ONLY breach gate:
        // a complete promise whose deadline is missing, unreadable or
        // unexpired never breaches, whatever any other field says.
        dueAt: strictUtc,
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
    // Required (non-null) exactly when basis is derived-wait: the read-only
    // census output that classified the wait, pinned by hash. Armed promises
    // must carry null — they breach on their own deadline alone.
    classifier: Type.Union([
      Type.Object(
        {
          identity: Type.String({ minLength: 1, maxLength: 256 }),
          classification: Type.Literal("live-past-due"),
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
        // Closed or voided debt is acknowledged — never woken.
        if (receipt.promise.status !== "open") throw new Error("promise-already-resolved");
        // THE breach gate: a complete promise/deadline, fully expired at
        // observation and now. Nothing else — not a dead PID, not quiet, not
        // capacity — can substitute for the expired immutable deadline.
        const due = instant(receipt.promise.dueAt);
        if (!(due < now && due < instant(input.request.observedAt)))
          throw new Error("deadline-not-expired");
        if (receipt.basis === "derived-wait") {
          // Waits breach only through the existing read-only classifier's
          // own census, pinned by hash, never through a re-implementation.
          if (!receipt.classifier) throw new Error("waits-classifier-missing");
          if (receipt.classifier.identity !== PROMISE_BREACH_WAITS_CLASSIFIER)
            throw new Error("waits-classifier-unknown");
          if (instant(receipt.classifier.classifiedAt) > instant(input.request.observedAt))
            throw new Error("waits-classification-stale");
          verifyDemandRef(receipt.classifier.censusRef, source.evidence_roots);
          // Pre-adoption debt is reported once upstream, never woken.
          if (due < instant(source.promise_adoption_since)) throw new Error("pre-adoption-debt");
        } else if (receipt.classifier !== null) {
          // Armed promises breach on their own deadline; they do not ride
          // the waits classifier.
          throw new Error("classifier-not-admitted");
        }
      }
      return { eligible: true, reasonCode: "eligible", checkedAt };
    } catch (error) {
      const reasonCode = error instanceof Error ? error.message : "eligibility-unknown";
      return { eligible: false, reasonCode: `demand:${reasonCode}`, checkedAt };
    }
  }
}
