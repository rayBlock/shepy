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

// Pi's extension loader aliases typebox (and typebox/compile, typebox/value)
// to Pi's own bundled copy in every runtime mode, so a runtime dependency
// would fetch a copy that is never loaded. It must stay a peer requirement
// the host satisfies, like the Pi packages themselves.
if (manifest.dependencies?.typebox !== undefined) {
  errors.push(
    `dependencies.typebox: must not be declared (received ${manifest.dependencies.typebox}) — typebox is a peerDependency only`,
  );
}
if (manifest.peerDependencies?.typebox !== ">=1.1.38") {
  errors.push(
    `peerDependencies.typebox: expected ">=1.1.38", received ${JSON.stringify(manifest.peerDependencies?.typebox)}`,
  );
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
