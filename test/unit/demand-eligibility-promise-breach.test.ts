import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DemandEligibilityProvider,
  PROMISE_BREACH_WAITS_CLASSIFIER,
} from "../../src/observability/demand-eligibility.js";
import type { DemandRequest } from "../../src/observability/profile-demand-ingress.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "shepy-breach-eligibility-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const ADOPTION_SINCE = "2026-10-01T00:00:00.000Z";
const EPISODE_ID = "f".repeat(64);
const GENERATION = {
  herdrSession: "default",
  workspaceId: "w3J",
  paneId: "w3J:pEB",
  terminalId: "term-1",
  nativeSessionRef: "/tmp/owner.jsonl",
};

const file = (name: string, contents: string) => {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return { path, sha256: createHash("sha256").update(contents).digest("hex"), selector: "root" };
};
const sha = (contents: string) => createHash("sha256").update(contents).digest("hex");

// CANONICAL source bytes (engine tools/promises/ledger.ts + tools/waits/*):
// the fixtures pin the ACTUAL source schemas, not invented ones.

/** A v1 promise line (PromiseLine): the whole-line state law. */
const v1Line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    id: "p1",
    at: "2026-10-09T08:00:00+02:00",
    seat: "engine-coordinator",
    kind: "context-budget",
    promise: "hold the breach-adapter fence",
    due: "2026-10-10T10:00:00Z",
    status: "open",
    evidence: null,
    closed_at: null,
    ...over,
  });

/** A v2 arm (ArmLine) with this id's events, in the envelope shape. */
const v2Envelope = (armOver: Record<string, unknown> = {}, events: unknown[] = []) =>
  JSON.stringify({
    arm: {
      v: 2,
      id: "p1",
      at: "2026-10-09T08:00:00Z",
      owner: { seat: "engine-coordinator", worker: "flash-build", pane: "w3J:pTC" },
      kind: "context-budget",
      window: { from: "2026-10-09T08:00:00Z", to: "2026-10-10T10:00:00Z" },
      promise: "hold the breach-adapter fence",
      due: "2026-10-10T10:00:00Z",
      evidence_verb: "report",
      evidence: null,
      wake_path: { rung1: "shepy", rung2: "seat", rung3: "oversight", rung4: "ray-lines" },
      status: "open",
      attempts: [],
      closed_at: null,
      ...armOver,
    },
    events,
  });

/** The waits-ledger opening line for the claimed wait (hash-pinned
 * provenance for derived-wait; the census row is the binding authority). */
const waitsOpening = JSON.stringify({
  wait: "15.267 push #11 context recovery",
  armed: "2026-10-09T20:00Z",
  deadline: "2026-10-10T10:00Z",
  owner: "engine-coordinator",
});

/** An actual `reconcile --json` output (tools/waits/reconcile.ts
 * ReconcileResult) carrying the given rows. */
const censusJson = (rows: unknown[]) =>
  JSON.stringify({
    census: {
      live: 0,
      debt: rows.length,
      pending: 0,
      closed: 0,
      voided: 0,
      nonwait: 0,
      malformed: 0,
    },
    rows,
    unpaired: rows,
    probes: [],
    backfilled: [],
  });

/** One canonical WaitRow. */
const waitRow = (over: Record<string, unknown> = {}) => ({
  id: "w9",
  subject: "15.267 push #11 context recovery",
  deadline: "2026-10-10T10:00Z",
  waitClass: "debt",
  reason: "deadline-passed, no closure",
  citation: null,
  unpaired: true,
  ...over,
});

const sourceRecordRef = file("records/p1.json", v1Line());
// The mutable multi-incident promise ledger the record was copied from.
// Nothing below ever cites it: a selector into this file is not admissible
// evidence.
const ledgerPath = file("ledger.jsonl", `${v1Line()}\n`).path;

const grantRef = file("grant.json", "grant");
const observationRef = file(
  "capacity.json",
  JSON.stringify({
    observedAt: "2026-10-10T11:59:59.000Z",
    seatGeneration: GENERATION,
    activeInvocationIds: [],
    occupiedSlots: 0,
    availableSlots: 1,
    scopeRef: grantRef,
  }),
);
const stopPath = join(root, "STOP");
const seatStatePath = file(
  "state.json",
  JSON.stringify({
    schema: "factory.seat-state.v1",
    seat: "engine-coordinator",
    ts: "2026-10-10T11:59:59.000Z",
    ctxPct: 40,
    zone: "amber",
    unknown: [],
  }),
);
const dutyRef = file(
  "duty.json",
  JSON.stringify({
    schema: "factory.duty.v1",
    seatId: "engine-coordinator",
    profileId: "engine-coordinator",
    ownerGeneration: GENERATION,
    grantRef,
    mode: "on-duty",
    window: {
      startsAt: "2026-10-10T11:00:00.000Z",
      endsAt: "2026-10-10T13:00:00.000Z",
      timezone: "UTC",
    },
    queues: [
      {
        root,
        queuePath: join(root, "queue.json"),
        ownership: [
          {
            rowId: "15.267",
            packetId: "BREACH-ADAPTER",
            actionClass: "execute",
            packetRef: sourceRecordRef,
            grantRef,
          },
        ],
      },
    ],
    capacity: { maxInFlight: 1, observationRef, maxAgeSeconds: 30 },
    stopPaths: [stopPath],
    nextDecision: { reasonRef: grantRef, eventRef: null, revisitAt: "2026-10-10T12:30:00.000Z" },
    successor: { profileId: "successor", routeRef: grantRef, ownerGeneration: null },
    policy: {
      idleGraceSeconds: 60,
      cooldownSeconds: 1200,
      maxWakesPerHour: 3,
      maxReminderCount: 1,
      defaultRevisitSeconds: 1200,
    },
  }),
);

const classifier = (overrides: Record<string, unknown> = {}) => ({
  identity: PROMISE_BREACH_WAITS_CLASSIFIER,
  classifiedAt: "2026-10-10T11:30:00.000Z",
  censusRef: file(
    `census/waits-${sha(JSON.stringify(overrides)).slice(0, 8)}.json`,
    censusJson([waitRow()]),
  ),
  ...overrides,
});

/** One owned per-incident receipt snapshot; every test writes its own file. */
const receipt = (overrides: Record<string, unknown> = {}) => {
  const value = {
    schema: "factory.promise-breach.receipt.v1",
    incidentId: "promise:p1",
    episodeId: EPISODE_ID,
    basis: "armed-promise",
    sourceRecordRef,
    promise: {
      recordId: "p1",
      status: "open",
      dueAt: "2026-10-10T10:00:00.000Z",
      owner: { seat: "engine-coordinator" },
    },
    classifier: null,
    ...overrides,
  };
  return {
    ref: file(
      `receipts/${String(value.incidentId).replace(/[^a-z0-9-]/gi, "-")}.json`,
      JSON.stringify(value),
    ),
    value,
  };
};

const allowlist = (overrides: Record<string, unknown> = {}, name = "allowlist.json") => {
  const path = join(root, name);
  writeFileSync(
    path,
    JSON.stringify({
      schema: "shepy.ingress-allowlist.v1",
      sources: {
        "factory-promise-scan": {
          profiles: ["engine-coordinator"],
          kinds: ["promise-breach"],
          duty_paths: [dutyRef.path],
          grant_hashes: [grantRef.sha256],
          evidence_roots: [root],
          max_expiry_minutes: 60,
          seat_state_path: seatStatePath.path,
          promise_adoption_since: ADOPTION_SINCE,
          ...overrides,
        },
      },
    }),
  );
  return path;
};

const request = (snapshotRef = receipt().ref) => ({
  schema: "factory.demand.v1",
  sourceId: "factory-promise-scan",
  profileId: "engine-coordinator",
  kind: "promise-breach",
  idempotencyKey: `${EPISODE_ID}/promise-breach/1`,
  episodeId: EPISODE_ID,
  actionFingerprint: "b".repeat(64),
  activationRevision: 1,
  seatId: "engine-coordinator",
  ownerGeneration: GENERATION,
  dutyRef,
  grantRef,
  snapshotRef,
  markerRef: grantRef,
  observedAt: "2026-10-10T11:30:00.000Z",
  expiresAt: "2026-10-10T12:30:00.000Z",
  reasonCode: "expired-immutable-deadline",
});

const standardAllowlist = allowlist();

const evaluate = (value: unknown, options: { allowlistPath?: string } = {}) =>
  new DemandEligibilityProvider({
    allowlistPath: options.allowlistPath ?? standardAllowlist,
    now: () => NOW,
    requiredStopPath: stopPath,
  }).evaluate({
    request: value as DemandRequest,
    owner: undefined,
    phase: "publish",
  });

const eligible = (value: unknown, options?: { allowlistPath?: string }) => {
  const result = evaluate(value, options);
  if (!result.eligible) throw new Error(`expected eligible, got ${result.reasonCode}`);
  return result;
};
const refusal = (value: unknown, reasonCode: string, options?: { allowlistPath?: string }) =>
  expect(evaluate(value, options)).toMatchObject({ eligible: false, reasonCode });

/** A derived-wait receipt over the given census rows. */
const waitsRequest = (rows: unknown[], receiptOverrides: Record<string, unknown> = {}) => {
  const { ref } = receipt({
    basis: "derived-wait",
    incidentId: "waits:w9",
    sourceRecordRef: file(
      `records/waits-${sha(JSON.stringify(rows)).slice(0, 8)}.json`,
      waitsOpening,
    ),
    promise: {
      recordId: "w9",
      status: "open",
      dueAt: "2026-10-10T10:00:00.000Z",
    },
    classifier: classifier({
      censusRef: file(`census/w9-${sha(JSON.stringify(rows)).slice(0, 8)}.json`, censusJson(rows)),
    }),
    ...receiptOverrides,
  });
  return request(ref);
};

describe("promise-breach eligibility (armed-promise: bytes bind the claims)", () => {
  it("admits an expired open v1 promise whose receipt claims equal the cited bytes", () => {
    const { ref } = receipt();
    eligible(request(ref));
  });

  it("admits a bare v2 arm whose due instant equals the claim", () => {
    const { ref } = receipt({
      sourceRecordRef: file("records/p1-v2.json", v2Envelope()),
      promise: {
        recordId: "p1",
        status: "open",
        dueAt: "2026-10-10T10:00:00.000Z",
        owner: { seat: "engine-coordinator", worker: "flash-build", pane: "w3J:pTC" },
      },
    });
    eligible(request(ref));
  });

  it("folds v2 closure events: a kept arm is resolved debt", () => {
    const events = [
      { v: 2, event: "keep", id: "p1", at: "2026-10-10T09:00:00Z", citation: "abc1234" },
    ];
    // A receipt claiming "open" over kept bytes is a claim mismatch...
    const { ref } = receipt({
      sourceRecordRef: file("records/p1-v2-kept.json", v2Envelope({}, events)),
    });
    refusal(request(ref), "demand:breach-status-mismatch");
    // ...and an honest receipt over kept bytes is resolved debt, never woken.
    const honest = receipt({
      sourceRecordRef: file("records/p1-v2-kept2.json", v2Envelope({}, events)),
      promise: {
        recordId: "p1",
        status: "kept",
        dueAt: "2026-10-10T10:00:00.000Z",
        owner: { seat: "engine-coordinator", worker: "flash-build", pane: "w3J:pTC" },
      },
    });
    refusal(request(honest.ref), "demand:promise-already-resolved");
  });

  it("folds v2 breach events: recorded debt never re-wakes", () => {
    const events = [
      {
        v: 2,
        event: "breach",
        id: "p1",
        at: "2026-10-10T10:05:00Z",
        rung: 1,
        liveness: null,
        overdue_min: 5,
        pass: null,
        probe: null,
        wake: null,
      },
    ];
    const { ref } = receipt({
      sourceRecordRef: file("records/p1-v2-breached.json", v2Envelope({}, events)),
      promise: {
        recordId: "p1",
        status: "breached",
        dueAt: "2026-10-10T10:00:00.000Z",
        owner: { seat: "engine-coordinator", worker: "flash-build", pane: "w3J:pTC" },
      },
    });
    refusal(request(ref), "demand:promise-already-resolved");
  });

  it("refuses a record whose bytes resolve to a different id, deadline or status", () => {
    const differentId = receipt({ sourceRecordRef: file("records/p2.json", v1Line({ id: "p2" })) });
    refusal(request(differentId.ref), "demand:breach-record-mismatch");
    const futureDue = receipt({
      sourceRecordRef: file("records/p1-future.json", v1Line({ due: "2026-10-10T15:00:00Z" })),
    });
    refusal(request(futureDue.ref), "demand:breach-deadline-mismatch");
    const closed = receipt({
      sourceRecordRef: file(
        "records/p1-kept.json",
        v1Line({ status: "kept", closed_at: "2026-10-10T09:00:00Z" }),
      ),
    });
    refusal(request(closed.ref), "demand:breach-status-mismatch");
    const v1Breached = receipt({
      sourceRecordRef: file(
        "records/p1-breached.json",
        v1Line({
          status: "breached",
          closed_at: "2026-10-10T10:05:00Z",
          pct: 61,
          zone: "fold-now",
        }),
      ),
    });
    refusal(request(v1Breached.ref), "demand:breach-status-mismatch");
  });

  it("refuses a receipt claiming a status the open record does not carry", () => {
    const { ref } = receipt({
      promise: {
        recordId: "p1",
        status: "kept",
        dueAt: "2026-10-10T10:00:00.000Z",
        owner: { seat: "engine-coordinator" },
      },
    });
    refusal(request(ref), "demand:breach-status-mismatch");
  });

  it("binds ownership exactly to what the canonical record supplies", () => {
    const { ref } = receipt({
      promise: { recordId: "p1", status: "open", dueAt: "2026-10-10T10:00:00.000Z" },
    });
    refusal(request(ref), "demand:breach-ownership-mismatch");
    const otherSeat = receipt({
      promise: {
        recordId: "p1",
        status: "open",
        dueAt: "2026-10-10T10:00:00.000Z",
        owner: { seat: "other-seat" },
      },
    });
    refusal(request(otherSeat.ref), "demand:breach-ownership-mismatch");
    const overclaim = receipt({
      promise: {
        recordId: "p1",
        status: "open",
        dueAt: "2026-10-10T10:00:00.000Z",
        owner: { seat: "engine-coordinator", worker: "flash-build" },
      },
    });
    refusal(request(overclaim.ref), "demand:breach-ownership-mismatch");
    const wrongWorker = receipt({
      sourceRecordRef: file("records/p1-v2b.json", v2Envelope()),
      promise: {
        recordId: "p1",
        status: "open",
        dueAt: "2026-10-10T10:00:00.000Z",
        owner: { seat: "engine-coordinator", worker: "someone-else", pane: "w3J:pTC" },
      },
    });
    refusal(request(wrongWorker.ref), "demand:breach-ownership-mismatch");
  });

  it("refuses non-JSON record bytes and unsupported record shapes as UNKNOWN", () => {
    const nonJson = receipt({
      sourceRecordRef: file("records/p1-garbage.json", "这不是 json {{{"),
    });
    refusal(request(nonJson.ref), "demand:breach-record-unknown");
    const inventedShape = receipt({
      sourceRecordRef: file(
        "records/p1-invented.json",
        JSON.stringify({ promiseId: "p1", deadline: "2026-10-10T10:00:00Z", status: "open" }),
      ),
    });
    refusal(request(inventedShape.ref), "demand:breach-record-unknown");
    const impossibleDue = receipt({
      sourceRecordRef: file("records/p1-impossible.json", v1Line({ due: "2026-02-30T10:00:00Z" })),
    });
    refusal(request(impossibleDue.ref), "demand:breach-record-unknown");
  });

  it("refuses an unexpired deadline, the exact due instant, and an observation predating it", () => {
    const future = receipt({
      sourceRecordRef: file("records/p1-unexpired.json", v1Line({ due: "2026-10-10T13:00:00Z" })),
      promise: {
        recordId: "p1",
        status: "open",
        dueAt: "2026-10-10T13:00:00.000Z",
        owner: { seat: "engine-coordinator" },
      },
    });
    refusal(request(future.ref), "demand:deadline-not-expired");
    const dueAtRead = receipt({
      sourceRecordRef: file("records/p1-atread.json", v1Line({ due: "2026-10-10T12:00:00Z" })),
      promise: {
        recordId: "p1",
        status: "open",
        dueAt: "2026-10-10T12:00:00.000Z",
        owner: { seat: "engine-coordinator" },
      },
    });
    refusal(request(dueAtRead.ref), "demand:deadline-not-expired");
    // The observation itself predates the bound deadline: the window stays
    // valid (11:50→12:20) but the breach claim is premature.
    const premature = receipt({
      sourceRecordRef: file("records/p1-premature.json", v1Line({ due: "2026-10-10T11:55:00Z" })),
      promise: {
        recordId: "p1",
        status: "open",
        dueAt: "2026-10-10T11:55:00.000Z",
        owner: { seat: "engine-coordinator" },
      },
    });
    refusal(
      {
        ...request(premature.ref),
        observedAt: "2026-10-10T11:50:00.000Z",
        expiresAt: "2026-10-10T12:20:00.000Z",
      },
      "demand:deadline-not-expired",
    );
  });

  it("never lets a dead PID found a breach: the expired deadline alone gates", () => {
    const aliveButUnexpired = receipt({
      liveness: { pidAlive: false, host: "same-host" },
      sourceRecordRef: file("records/p1-unexpired2.json", v1Line({ due: "2026-10-10T13:00:00Z" })),
      promise: {
        recordId: "p1",
        status: "open",
        dueAt: "2026-10-10T13:00:00.000Z",
        owner: { seat: "engine-coordinator" },
      },
    });
    refusal(request(aliveButUnexpired.ref), "demand:deadline-not-expired");
    const deadAndExpired = receipt({ liveness: { pidAlive: false, host: "same-host" } });
    eligible(request(deadAndExpired.ref));
  });

  it("verifies the owned source-record snapshot by hash and evidence roots", () => {
    const { ref } = receipt({ sourceRecordRef: { ...sourceRecordRef, sha256: "1".repeat(64) } });
    refusal(request(ref), "demand:demand:ref-sha-mismatch");
    // The parent of the evidence root exists but is outside it.
    refusal(
      request({ ...receipt().ref, path: join(root, "..", "outside-receipt.json") }),
      "demand:demand:ref-outside-roots",
    );
  });

  it("refuses citing the mutable ledger (or any non-receipt shape) as the snapshot", () => {
    refusal(
      request({ path: ledgerPath, sha256: sha(`${v1Line()}\n`), selector: "$[0]" }),
      "demand:breach-receipt-unknown",
    );
  });

  it("refuses a receipt bound to a different episode or riding the waits classifier", () => {
    const { ref } = receipt({ episodeId: "e".repeat(64) });
    refusal(request(ref), "demand:breach-receipt-mismatch");
    const withClassifier = receipt({ classifier: classifier() });
    refusal(request(withClassifier.ref), "demand:classifier-not-admitted");
  });

  it("requires an operator-pinned adoption cutoff for any promise-breach source", () => {
    const { ref } = receipt();
    refusal(request(ref), "demand:adoption-cutoff-missing", {
      allowlistPath: allowlist({ promise_adoption_since: undefined }, "allowlist-no-cutoff.json"),
    });
  });
});

describe("promise-breach eligibility (derived-wait: the census row binds the claims)", () => {
  it("admits a post-adoption deadline-passed unpaired row matching the claim", () => {
    eligible(waitsRequest([waitRow()]));
  });

  it("refuses when the census lacks the claimed row or carries it ambiguously", () => {
    refusal(waitsRequest([]), "demand:waits-row-absent");
    refusal(
      waitsRequest([waitRow({ subject: "first" }), waitRow({ subject: "second" })]),
      "demand:waits-row-ambiguous",
    );
  });

  it("refuses rows the canonical classifier does not call deadline-passed debt", () => {
    refusal(
      waitsRequest([
        waitRow({
          waitClass: "live",
          reason: "in flight, deadline unpassed",
          deadline: "2026-10-10T15:00Z",
        }),
      ]),
      "demand:waits-row-not-debt",
    );
    refusal(
      waitsRequest([
        waitRow({
          waitClass: "pending",
          reason: "deadline-fuzzy: 2026-10-10T~1x:3xZ — awaiting pairing",
        }),
      ]),
      "demand:waits-row-not-debt",
    );
    refusal(
      waitsRequest([
        waitRow({
          waitClass: "closed",
          reason: "kept-closure citation abc1234",
          citation: { kind: "closure-line", value: "abc1234", how: "closure" },
          unpaired: false,
        }),
      ]),
      "demand:waits-row-not-debt",
    );
  });

  it("refuses complete-uncollected and closure-without-citation debt by name", () => {
    refusal(
      waitsRequest([waitRow({ reason: "complete-uncollected (commit abc1234 via grep:15.267)" })]),
      "demand:waits-row-reason-unknown",
    );
    refusal(
      waitsRequest([
        waitRow({
          reason:
            "closure-without-citation (subject complete per closure line; kept-closure upgrade needs a citation)",
        }),
      ]),
      "demand:waits-row-reason-unknown",
    );
  });

  it("refuses a row already paired with a closure", () => {
    refusal(waitsRequest([waitRow({ unpaired: false })]), "demand:waits-row-paired");
  });

  it("refuses a row whose deadline does not resolve or is not entirely past", () => {
    refusal(
      waitsRequest([waitRow({ deadline: "none (natural cycle)" })]),
      "demand:waits-row-not-debt",
    );
    refusal(
      waitsRequest([waitRow({ deadline: "2026-10-10T12:30Z" })]),
      "demand:waits-row-not-debt",
    );
  });

  it("refuses a claimed due outside the matched row's resolved window", () => {
    refusal(
      waitsRequest([waitRow({ deadline: "2026-10-10T09:00Z" })]),
      "demand:breach-deadline-mismatch",
    );
  });

  it("refuses bytes that are not an actual reconcile output", () => {
    const { ref } = receipt({
      basis: "derived-wait",
      incidentId: "waits:bad",
      sourceRecordRef: file("records/waits-bad.json", waitsOpening),
      promise: { recordId: "w9", status: "open", dueAt: "2026-10-10T10:00:00.000Z" },
      classifier: classifier({
        censusRef: file(
          "census/bad.json",
          JSON.stringify({ rows: [waitRow()], note: "hand-built" }),
        ),
      }),
    });
    refusal(request(ref), "demand:waits-census-unknown");
  });

  it("verifies the pinned census output by hash", () => {
    const { ref } = receipt({
      basis: "derived-wait",
      incidentId: "waits:w9-tamper",
      sourceRecordRef: file("records/waits-tamper.json", waitsOpening),
      promise: { recordId: "w9", status: "open", dueAt: "2026-10-10T10:00:00.000Z" },
      classifier: classifier({
        censusRef: {
          ...file("census/tamper-src.json", censusJson([waitRow()])),
          sha256: "0".repeat(64),
        },
      }),
    });
    refusal(request(ref), "demand:demand:ref-sha-mismatch");
  });

  it("refuses pre-adoption wait debt as old, never woken", () => {
    const oldRow = waitRow({ id: "w1", deadline: "2026-09-20T10:00Z" });
    const { ref } = receipt({
      basis: "derived-wait",
      incidentId: "waits:old",
      sourceRecordRef: file("records/waits-old.json", waitsOpening),
      promise: { recordId: "w1", status: "open", dueAt: "2026-09-20T10:00:00.000Z" },
      classifier: classifier({ censusRef: file("census/old.json", censusJson([oldRow])) }),
    });
    refusal(request(ref), "demand:pre-adoption-debt");
  });

  it("checks classifier provenance: present, named, not after the observation", () => {
    const missing = receipt({
      basis: "derived-wait",
      incidentId: "waits:m1",
      sourceRecordRef: file("records/waits-m1.json", waitsOpening),
      promise: { recordId: "w9", status: "open", dueAt: "2026-10-10T10:00:00.000Z" },
      classifier: null,
    });
    refusal(request(missing.ref), "demand:waits-classifier-missing");
    const foreign = receipt({
      basis: "derived-wait",
      incidentId: "waits:m2",
      sourceRecordRef: file("records/waits-m2.json", waitsOpening),
      promise: { recordId: "w9", status: "open", dueAt: "2026-10-10T10:00:00.000Z" },
      classifier: classifier({ identity: "my-own-heuristic@v1" }),
    });
    refusal(request(foreign.ref), "demand:waits-classifier-unknown");
    const stale = receipt({
      basis: "derived-wait",
      incidentId: "waits:m3",
      sourceRecordRef: file("records/waits-m3.json", waitsOpening),
      promise: { recordId: "w9", status: "open", dueAt: "2026-10-10T10:00:00.000Z" },
      classifier: classifier({ classifiedAt: "2026-10-10T11:45:00.000Z" }),
    });
    refusal(request(stale.ref), "demand:waits-classification-stale");
  });

  it("refuses a waits receipt claiming a non-open state", () => {
    refusal(
      waitsRequest([waitRow()], {
        promise: { recordId: "w9", status: "kept", dueAt: "2026-10-10T10:00:00.000Z" },
      }),
      "demand:breach-status-mismatch",
    );
  });
});
