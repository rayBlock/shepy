import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const hex = Type.String({ pattern: "^[0-9a-f]{64}$" });
const ref = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    selector: Type.String({ minLength: 1, maxLength: 256 }),
    sha256: hex,
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
export const demandRequestSchema = Type.Object(
  {
    schema: Type.Literal("factory.demand.v1"),
    sourceId: Type.String({ minLength: 1 }),
    profileId: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal("queue-claimable"),
      Type.Literal("continuation-missing"),
      Type.Literal("successor-escalation"),
    ]),
    idempotencyKey: Type.String({ maxLength: 192, pattern: "^[\\x21-\\x7e]+/[^/]+/[1-9][0-9]*$" }),
    episodeId: hex,
    actionFingerprint: hex,
    activationRevision: Type.Integer({ minimum: 1 }),
    seatId: Type.String({ minLength: 1 }),
    ownerGeneration: generation,
    dutyRef: ref,
    grantRef: ref,
    snapshotRef: ref,
    markerRef: ref,
    observedAt: Type.String({ minLength: 1 }),
    expiresAt: Type.String({ minLength: 1 }),
    reasonCode: Type.Union([
      Type.Literal("owned-ready-capacity"),
      Type.Literal("missing-disposition"),
      Type.Literal("two-defers"),
      Type.Literal("no-response"),
    ]),
  },
  { additionalProperties: false },
);
export type DemandRequest = Static<typeof demandRequestSchema>;
const sourceSchema = Type.Object(
  {
    profiles: Type.Array(Type.String()),
    kinds: Type.Array(demandRequestSchema.properties.kind),
    duty_paths: Type.Array(Type.String()),
    grant_hashes: Type.Array(hex),
    evidence_roots: Type.Array(Type.String()),
    max_expiry_minutes: Type.Number({ exclusiveMinimum: 0, maximum: 60 }),
  },
  { additionalProperties: false },
);
const allowlistSchema = Type.Object(
  {
    schema: Type.Literal("shepy.ingress-allowlist.v1"),
    sources: Type.Record(Type.String(), sourceSchema),
  },
  { additionalProperties: false },
);

function utc(value: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    throw new Error("demand:invalid-utc");
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value)
    throw new Error("demand:invalid-utc");
  return epoch;
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function verifyRef(input: Static<typeof ref>, roots: string[]): void {
  if (!isAbsolute(input.path) || !roots.some((root) => within(input.path, root)))
    throw new Error("demand:ref-outside-roots");
  let path = input.path;
  // Reject symlinks in EVERY path component, not only the final file.
  while (path !== resolve(path, "..")) {
    if (lstatSync(path).isSymbolicLink()) throw new Error("demand:ref-symlink");
    path = resolve(path, "..");
  }
  if (!lstatSync(input.path).isFile()) throw new Error("demand:ref-not-file");
  if (!roots.some((root) => within(realpathSync(input.path), root)))
    throw new Error("demand:ref-escape");
  const actual = createHash("sha256").update(readFileSync(input.path)).digest("hex");
  if (actual !== input.sha256) throw new Error("demand:ref-sha-mismatch");
}

/** Publish-time validation only. The allowlist is operator-owned; clients cannot supply its path. */
export function validateDemandRequest(
  value: unknown,
  options: { allowlistPath?: string; now?: number } = {},
): DemandRequest {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 16 * 1024)
    throw new Error("demand:oversized");
  if (!Value.Check(demandRequestSchema, value)) throw new Error("demand:invalid-schema");
  const request = value as DemandRequest;
  const allowlistPath =
    options.allowlistPath ?? resolve(homedir(), ".shepy/ingress-allowlist.json");
  const config: unknown = JSON.parse(readFileSync(allowlistPath, "utf8"));
  if (!Value.Check(allowlistSchema, config)) throw new Error("demand:invalid-allowlist");
  const source = config.sources[request.sourceId];
  if (
    !source ||
    !source.profiles.includes(request.profileId) ||
    !source.kinds.includes(request.kind)
  )
    throw new Error("demand:source-not-allowed");
  if (!source.duty_paths.includes(request.dutyRef.path)) throw new Error("demand:duty-not-allowed");
  if (source.grant_hashes.length && !source.grant_hashes.includes(request.grantRef.sha256))
    throw new Error("demand:grant-not-allowed");
  const start = utc(request.observedAt);
  const end = utc(request.expiresAt);
  if (
    end <= start ||
    end - start > source.max_expiry_minutes * 60_000 ||
    end <= (options.now ?? Date.now())
  )
    throw new Error("demand:expired-or-invalid-window");
  const reason = {
    "queue-claimable": ["owned-ready-capacity"],
    "continuation-missing": ["missing-disposition"],
    "successor-escalation": ["two-defers", "no-response"],
  }[request.kind];
  if (!reason.includes(request.reasonCode)) throw new Error("demand:invalid-reason");
  const route = request.kind === "successor-escalation" ? "successor" : request.kind;
  if (request.idempotencyKey !== `${request.episodeId}/${route}/${request.activationRevision}`)
    throw new Error("demand:invalid-key");
  if (request.kind !== "successor-escalation" && request.seatId !== request.profileId)
    throw new Error("demand:owner-mismatch");
  for (const citation of [
    request.dutyRef,
    request.grantRef,
    request.snapshotRef,
    request.markerRef,
  ])
    verifyRef(citation, source.evidence_roots);
  return request;
}
