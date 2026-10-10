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

// The exact source-record copy the scanner owns per incident (never the
// mutable ledger itself).
const LEDGER_LINE = `${JSON.stringify({
  promiseId: "pr-1",
  armedAt: "2026-10-09T08:00:00.000Z",
  deadline: "2026-10-10T10:00:00.000Z",
  status: "open",
})}\n`;
const sourceRecordRef = file("records/pr-1.json", LEDGER_LINE);
// The mutable multi-incident ledger the record was copied from. Nothing
// below ever cites it: a selector into this file is not admissible evidence.
const ledgerPath = file("ledger.jsonl", LEDGER_LINE).path;

const censusRef = file(
  "census/waits-census.json",
  JSON.stringify({
    census: "factory.waits.reconcile",
    mode: "read-only",
    rows: [
      { seat: "engine-coordinator", waitId: "w-9", class: "LIVE", due: "2026-10-10T10:00:00.000Z" },
    ],
  }),
);

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
const seatState = file(
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
  classification: "live-past-due",
  classifiedAt: "2026-10-10T11:30:00.000Z",
  censusRef,
  ...overrides,
});

/** One owned per-incident receipt snapshot; every test writes its own file. */
const receipt = (overrides: Record<string, unknown> = {}) => {
  const value = {
    schema: "factory.promise-breach.receipt.v1",
    incidentId: "promise:pr-1",
    episodeId: EPISODE_ID,
    basis: "armed-promise",
    sourceRecordRef,
    promise: { recordId: "pr-1", status: "open", dueAt: "2026-10-10T10:00:00.000Z" },
    classifier: null,
    ...overrides,
  };
  return { ref: file(`receipts/${String(value.incidentId)}.json`, JSON.stringify(value)), value };
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
          seat_state_path: seatState.path,
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

describe("promise-breach eligibility", () => {
  it("admits an expired open armed promise cited through its owned receipt snapshot", () => {
    const { ref } = receipt();
    eligible(request(ref));
  });

  it("admits a post-adoption derived wait through the read-only classifier census", () => {
    const { ref } = receipt({
      basis: "derived-wait",
      incidentId: "waits:w-9",
      promise: { recordId: "w-9", status: "open", dueAt: "2026-10-10T10:00:00.000Z" },
      classifier: classifier(),
    });
    eligible(request(ref));
  });

  it("refuses resolved debt", () => {
    for (const status of ["closed", "voided"]) {
      const { ref } = receipt({
        promise: { recordId: "pr-1", status, dueAt: "2026-10-10T10:00:00.000Z" },
      });
      refusal(request(ref), "demand:promise-already-resolved");
    }
  });

  it("refuses an unexpired deadline, including the exact due instant", () => {
    const { ref } = receipt({
      promise: { recordId: "pr-1", status: "open", dueAt: "2026-10-10T12:00:00.000Z" },
    });
    refusal(request(ref), "demand:deadline-not-expired");
    const future = receipt({
      promise: { recordId: "pr-1", status: "open", dueAt: "2026-10-10T13:00:00.000Z" },
    });
    refusal(request(future.ref), "demand:deadline-not-expired");
  });

  it("refuses an observation that predates the deadline", () => {
    const { ref } = receipt({
      promise: { recordId: "pr-1", status: "open", dueAt: "2026-10-10T11:55:00.000Z" },
    });
    refusal(
      {
        ...request(ref),
        observedAt: "2026-10-10T11:50:00.000Z",
        expiresAt: "2026-10-10T12:20:00.000Z",
      },
      "demand:deadline-not-expired",
    );
  });

  it("refuses citing the mutable ledger (or any non-receipt shape) as the snapshot", () => {
    refusal(
      request({ path: ledgerPath, sha256: sha(LEDGER_LINE), selector: "$[0]" }),
      "demand:breach-receipt-unknown",
    );
    const jsonl = file(
      "receipts/two-lines.jsonl",
      `${JSON.stringify(receipt().value)}\n${JSON.stringify(receipt().value)}\n`,
    );
    refusal(request(jsonl), "demand:breach-receipt-unknown");
  });

  it("refuses a receipt bound to a different episode", () => {
    const { ref } = receipt({ episodeId: "e".repeat(64) });
    refusal(request(ref), "demand:breach-receipt-mismatch");
  });

  it("refuses a derived wait without the classifier or with a foreign one", () => {
    const noClassifier = receipt({
      basis: "derived-wait",
      promise: { recordId: "w-9", status: "open", dueAt: "2026-10-10T10:00:00.000Z" },
      classifier: null,
    });
    refusal(request(noClassifier.ref), "demand:waits-classifier-missing");
    const foreign = receipt({
      basis: "derived-wait",
      incidentId: "waits:w-9b",
      promise: { recordId: "w-9b", status: "open", dueAt: "2026-10-10T10:00:00.000Z" },
      classifier: classifier({ identity: "my-own-heuristic@v1" }),
    });
    refusal(request(foreign.ref), "demand:waits-classifier-unknown");
  });

  it("refuses a classification observed after the demand's observation", () => {
    const { ref } = receipt({
      basis: "derived-wait",
      incidentId: "waits:w-9c",
      promise: { recordId: "w-9c", status: "open", dueAt: "2026-10-10T10:00:00.000Z" },
      classifier: classifier({ classifiedAt: "2026-10-10T11:45:00.000Z" }),
    });
    refusal(request(ref), "demand:waits-classification-stale");
  });

  it("verifies the pinned census output by hash", () => {
    const { ref } = receipt({
      basis: "derived-wait",
      incidentId: "waits:w-9d",
      promise: { recordId: "w-9d", status: "open", dueAt: "2026-10-10T10:00:00.000Z" },
      classifier: classifier({ censusRef: { ...censusRef, sha256: "0".repeat(64) } }),
    });
    refusal(request(ref), "demand:demand:ref-sha-mismatch");
  });

  it("refuses pre-adoption wait debt as old, never woken", () => {
    const { ref } = receipt({
      basis: "derived-wait",
      incidentId: "waits:old",
      promise: { recordId: "old-1", status: "open", dueAt: "2026-09-20T10:00:00.000Z" },
      classifier: classifier({ classifiedAt: "2026-10-10T11:30:00.000Z" }),
    });
    refusal(request(ref), "demand:pre-adoption-debt");
  });

  it("refuses an armed promise that rides the waits classifier", () => {
    const { ref } = receipt({ classifier: classifier() });
    refusal(request(ref), "demand:classifier-not-admitted");
  });

  it("requires an operator-pinned adoption cutoff for any promise-breach source", () => {
    const { ref } = receipt();
    refusal(request(ref), "demand:adoption-cutoff-missing", {
      allowlistPath: allowlist({ promise_adoption_since: undefined }, "allowlist-no-cutoff.json"),
    });
  });

  it("never lets a dead PID found a breach: the expired deadline alone gates", () => {
    const aliveButUnexpired = receipt({
      liveness: { pidAlive: false, host: "same-host" },
      promise: { recordId: "pr-1", status: "open", dueAt: "2026-10-10T12:00:00.000Z" },
    });
    refusal(request(aliveButUnexpired.ref), "demand:deadline-not-expired");
    const deadAndExpired = receipt({
      liveness: { pidAlive: false, host: "same-host" },
    });
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
});
