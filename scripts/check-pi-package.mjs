#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Validates the published shepy-pi tarball the way check-root-package.mjs
// validates the root package: parses `npm pack --dry-run --json` and asserts
// the file allowlist and manifest invariants instead of discarding them.
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
const required = [
  "src/agent-display.ts",
  "src/agent-update-ui.ts",
  "src/daemon-client.ts",
  "src/index.ts",
  "src/wake.ts",
];
const allowed = new Set(["README.md", "package.json"]);
const unexpected = files.filter((path) => !allowed.has(path) && !path.startsWith("src/"));
const missing = required.filter((path) => !files.includes(path));
const errors = [];

if (packed?.name !== manifest.name) {
  errors.push(`name: expected ${manifest.name}, received ${packed?.name}`);
}
if (packed?.version !== manifest.version) {
  errors.push(`version: expected ${manifest.version}, received ${packed?.version}`);
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
