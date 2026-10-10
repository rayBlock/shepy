import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateDemandRequest } from "../../src/observability/profile-demand-ingress.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "shepy-demand-test-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const citation = join(root, "citation.json");
writeFileSync(citation, "{}\n");
const hash = createHash("sha256").update("{}\n").digest("hex");
const ref = { path: citation, sha256: hash, selector: "$.item" };
const config = join(root, "allowlist.json");
writeFileSync(
  config,
  JSON.stringify({
    schema: "shepy.ingress-allowlist.v1",
    sources: {
      "factory-router": {
        profiles: ["engine-coordinator"],
        kinds: ["queue-claimable"],
        duty_paths: [citation],
        grant_hashes: [hash],
        evidence_roots: [root],
        max_expiry_minutes: 60,
      },
    },
  }),
);
const episodeId = "a".repeat(64);
const request = () => ({
  schema: "factory.demand.v1",
  sourceId: "factory-router",
  profileId: "engine-coordinator",
  kind: "queue-claimable",
  idempotencyKey: `${episodeId}/queue-claimable/1`,
  episodeId,
  actionFingerprint: "b".repeat(64),
  activationRevision: 1,
  seatId: "engine-coordinator",
  ownerGeneration: {
    herdrSession: "default",
    workspaceId: "w3J",
    paneId: "w3J:pEB",
    terminalId: "t1",
    nativeSessionRef: "local",
  },
  dutyRef: ref,
  grantRef: ref,
  snapshotRef: ref,
  markerRef: ref,
  observedAt: "2026-10-08T14:00:00.000Z",
  expiresAt: "2026-10-08T14:30:00.000Z",
  reasonCode: "owned-ready-capacity",
});
const validate = (value: unknown) =>
  validateDemandRequest(value, {
    allowlistPath: config,
    now: Date.parse("2026-10-08T14:15:00.000Z"),
  });
describe("demand publish admission", () => {
  it("rejects unknown fields at every level", () => {
    expect(() => validate({ ...request(), extra: true })).toThrow("demand:invalid-schema");
    expect(() => validate({ ...request(), dutyRef: { ...ref, extra: true } })).toThrow(
      "demand:invalid-schema",
    );
  });
  it("rejects requests over 16KiB", () =>
    expect(() => validate({ ...request(), extra: "x".repeat(16384) })).toThrow("demand:oversized"));
  it("rejects unallowlisted and inherited source names", () => {
    expect(() => validate({ ...request(), sourceId: "other" })).toThrow(
      "demand:source-not-allowed",
    );
    expect(() => validate({ ...request(), sourceId: "toString" })).toThrow(
      "demand:source-not-allowed",
    );
  });
  it("refuses missing or unreadable operator allowlist", () => {
    expect(() =>
      validateDemandRequest(request(), { allowlistPath: join(root, "missing.json") }),
    ).toThrow();
    expect(() => validate(undefined)).toThrow("demand:invalid-schema");
  });
  it("enforces the episode generation key, including activation revision", () => {
    expect(() => validate({ ...request(), activationRevision: 2 })).toThrow("demand:invalid-key");
    expect(
      validate({
        ...request(),
        activationRevision: 2,
        idempotencyKey: `${episodeId}/queue-claimable/2`,
      }).activationRevision,
    ).toBe(2);
  });
  it("refuses an empty grant pin allowlist", () => {
    const emptyConfig = join(root, "empty-grant-allowlist.json");
    writeFileSync(
      emptyConfig,
      JSON.stringify({
        schema: "shepy.ingress-allowlist.v1",
        sources: {
          "factory-router": {
            profiles: ["engine-coordinator"],
            kinds: ["queue-claimable"],
            duty_paths: [citation],
            grant_hashes: [],
            evidence_roots: [root],
            max_expiry_minutes: 60,
          },
        },
      }),
    );
    expect(() =>
      validateDemandRequest(request(), {
        allowlistPath: emptyConfig,
        now: Date.parse("2026-10-08T14:15:00.000Z"),
      }),
    ).toThrow("demand:invalid-allowlist");
  });
  it("rejects wrong citation sha", () =>
    expect(() => validate({ ...request(), markerRef: { ...ref, sha256: "0".repeat(64) } })).toThrow(
      "demand:ref-sha-mismatch",
    ));
  it("accepts a verified source", () => expect(validate(request()).episodeId).toBe(episodeId));
});

describe("promise-breach publish admission", () => {
  const breachRoot = realpathSync(mkdtempSync(join(tmpdir(), "shepy-breach-ingress-")));
  afterAll(() => rmSync(breachRoot, { recursive: true, force: true }));
  const breachEpisode = "c".repeat(64);
  const snapshot = join(breachRoot, "receipt-pr-1.json");
  writeFileSync(
    snapshot,
    JSON.stringify({ schema: "factory.promise-breach.receipt.v1", incidentId: "promise:pr-1" }),
  );
  const snapshotRef = {
    path: snapshot,
    sha256: createHash("sha256")
      .update(
        JSON.stringify({ schema: "factory.promise-breach.receipt.v1", incidentId: "promise:pr-1" }),
      )
      .digest("hex"),
    selector: "root",
  };
  // Citations must live inside THIS source's evidence roots.
  writeFileSync(join(breachRoot, "duty.json"), "{}\n");
  const breachRef = {
    path: join(breachRoot, "duty.json"),
    sha256: createHash("sha256").update("{}\n").digest("hex"),
    selector: "root",
  };
  const breachAllowlist = join(breachRoot, "breach-allowlist.json");
  writeFileSync(
    breachAllowlist,
    JSON.stringify({
      schema: "shepy.ingress-allowlist.v1",
      sources: {
        "factory-promise-scan": {
          profiles: ["engine-coordinator"],
          kinds: ["promise-breach"],
          duty_paths: [breachRef.path],
          grant_hashes: [hash],
          evidence_roots: [breachRoot],
          max_expiry_minutes: 60,
          promise_adoption_since: "2026-10-01T00:00:00.000Z",
        },
      },
    }),
  );
  const breachRequest = () => ({
    schema: "factory.demand.v1",
    sourceId: "factory-promise-scan",
    profileId: "engine-coordinator",
    kind: "promise-breach",
    idempotencyKey: `${breachEpisode}/promise-breach/1`,
    episodeId: breachEpisode,
    actionFingerprint: "d".repeat(64),
    activationRevision: 1,
    seatId: "engine-coordinator",
    ownerGeneration: {
      herdrSession: "default",
      workspaceId: "w3J",
      paneId: "w3J:pEB",
      terminalId: "t1",
      nativeSessionRef: "local",
    },
    dutyRef: breachRef,
    grantRef: breachRef,
    snapshotRef,
    markerRef: breachRef,
    observedAt: "2026-10-08T14:00:00.000Z",
    expiresAt: "2026-10-08T14:30:00.000Z",
    reasonCode: "expired-immutable-deadline",
  });
  const validateBreach = (value: unknown, path = breachAllowlist) =>
    validateDemandRequest(value, {
      allowlistPath: path,
      now: Date.parse("2026-10-08T14:15:00.000Z"),
    });

  it("admits a promise-breach request and derives its key route", () => {
    expect(validateBreach(breachRequest()).idempotencyKey).toBe(
      `${breachEpisode}/promise-breach/1`,
    );
  });
  it("keeps the reason code pinned to the kind", () => {
    expect(() =>
      validateBreach({ ...breachRequest(), reasonCode: "owned-ready-capacity" }),
    ).toThrow("demand:invalid-reason");
    expect(() => validateBreach({ ...breachRequest(), reasonCode: "no-response" })).toThrow(
      "demand:invalid-reason",
    );
  });
  it("refuses a source whose operator allowlist does not carry the kind", () => {
    const queueOnly = join(breachRoot, "queue-only-allowlist.json");
    writeFileSync(
      queueOnly,
      JSON.stringify({
        schema: "shepy.ingress-allowlist.v1",
        sources: {
          "factory-promise-scan": {
            profiles: ["engine-coordinator"],
            kinds: ["queue-claimable"],
            duty_paths: [breachRef.path],
            grant_hashes: [hash],
            evidence_roots: [breachRoot],
            max_expiry_minutes: 60,
          },
        },
      }),
    );
    expect(() => validateBreach(breachRequest(), queueOnly)).toThrow("demand:source-not-allowed");
  });
  it("binds the demand to the profile's own seat", () => {
    expect(() => validateBreach({ ...breachRequest(), seatId: "other-seat" })).toThrow(
      "demand:owner-mismatch",
    );
  });
  it("derives the key for a revision escalation; the revision gate lives in eligibility", () => {
    expect(() =>
      validateBreach({
        ...breachRequest(),
        activationRevision: 2,
        idempotencyKey: `${breachEpisode}/promise-breach/2`,
      }),
    ).not.toThrow();
  });
});
