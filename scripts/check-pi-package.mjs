#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Validates the published shepy-pi tarball the way check-root-package.mjs
// validates the root package: parses `npm pack --dry-run --json` and asserts
// the file allowlist and manifest invariants instead of discarding them.
//
// Every expectation below is held HERE, never read back from the manifest:
// `packed.name` is npm echoing the same manifest the script would otherwise
// compare it to, so a manifest-vs-itself check can never fail. Bumping the
// package version means bumping EXPECTED_VERSION in the same commit; that
// friction is the point — the identity of what ships is asserted, not echoed.
const EXPECTED_NAME = "shepy-pi";
const EXPECTED_VERSION = "0.5.0";

// `files: ["src"]` ships everything under src/, so a stray file there is the
// one stray that actually reaches the tarball. The allowlist is exact and
// includes the src/ tree: any file beyond these seven is a failure.
const EXPECTED_FILES = new Set([
  "README.md",
  "package.json",
  "src/agent-display.ts",
  "src/agent-update-ui.ts",
  "src/daemon-client.ts",
  "src/index.ts",
  "src/wake.ts",
]);

const pkgDir = new URL("../packages/shepy-pi/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", pkgDir), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [packed] = JSON.parse(
  extractJson(
    execFileSync(npm, ["pack", "--dry-run", "--json"], {
      cwd: fileURLToPath(pkgDir),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  ),
);
const files = packed?.files?.map(({ path }) => path) ?? [];
const unexpected = files.filter((path) => !EXPECTED_FILES.has(path));
const missing = [...EXPECTED_FILES].filter((path) => !files.includes(path));
const errors = [];

if (packed?.name !== EXPECTED_NAME) {
  errors.push(`name: expected ${EXPECTED_NAME}, received ${packed?.name}`);
}
if (packed?.version !== EXPECTED_VERSION) {
  errors.push(`version: expected ${EXPECTED_VERSION}, received ${packed?.version}`);
}
if (missing.length > 0) errors.push(`missing: ${missing.join(", ")}`);
if (unexpected.length > 0) errors.push(`unexpected: ${unexpected.join(", ")}`);

// The dependency SHAPE is asserted wholesale, not key-by-key — round 3's
// F3-3: a check that only forbids `typebox` in `dependencies` waves through
// every OTHER smuggled runtime dependency (the dead-weight class round 1
// flagged, renamed), and never notices a deleted peer, which silently
// unenforces the engine-compatibility contract.
//
// Pi's extension loader aliases typebox (and typebox/compile, typebox/
// value) to Pi's own bundled copy in every runtime mode, and the extension
// otherwise runs strictly inside the Pi host: a runtime dependency would
// fetch a copy that is never loaded. `dependencies` must be EMPTY — every
// host package is a peerDependency the host satisfies.
const declaredDependencies = Object.keys(manifest.dependencies ?? {});
for (const name of declaredDependencies.sort()) {
  errors.push(
    `dependencies.${name}: no runtime dependency may be declared (received ${JSON.stringify(
      manifest.dependencies[name],
    )}) — the extension runs inside the Pi host; move it to peerDependencies`,
  );
}

// The peer set is the engine-compatibility contract: exact names and exact
// ranges, asserted as a whole. A deleted, renamed, added or re-ranged peer
// all fail this comparison.
const EXPECTED_PEER_DEPENDENCIES = {
  "@earendil-works/pi-coding-agent": ">=0.80.6",
  "@earendil-works/pi-tui": ">=0.80.6",
  typebox: ">=1.1.38",
};
const actualPeers = manifest.peerDependencies ?? {};
for (const name of Object.keys(EXPECTED_PEER_DEPENDENCIES).sort()) {
  if (actualPeers[name] !== EXPECTED_PEER_DEPENDENCIES[name]) {
    errors.push(
      `peerDependencies.${name}: expected ${JSON.stringify(
        EXPECTED_PEER_DEPENDENCIES[name],
      )}, received ${JSON.stringify(actualPeers[name])}`,
    );
  }
}
for (const name of Object.keys(actualPeers).sort()) {
  if (!(name in EXPECTED_PEER_DEPENDENCIES)) {
    errors.push(
      `peerDependencies.${name}: unexpected peer (received ${JSON.stringify(actualPeers[name])})`,
    );
  }
}

if (errors.length > 0) {
  throw new Error(`Invalid shepy-pi npm package:\n- ${errors.join("\n- ")}`);
}

console.log(`${packed.name}@${packed.version}: ${files.length} files`);

/**
 * npm pack --json can leak script banners (pnpm prepack output, postbuild
 * logs) into stdout before the JSON document. Find the first character that
 * starts a JSON value and parse from there.
 */
function extractJson(output) {
  const start = output.search(/[[{]/);
  if (start < 0) throw new Error("npm pack produced no JSON output");
  return output.slice(start);
}
