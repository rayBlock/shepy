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
