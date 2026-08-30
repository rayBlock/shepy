#!/usr/bin/env node
/**
 * Smoke-test a REAL installation of this package the way users get it:
 * source-only, from the repo checkout — no npm registry involved.
 *
 *  1. `npm pack` the repo (what `npm install -g .` consumes)
 *  2. install the tarball into an isolated prefix
 *  3. run the installed bin: `--version` and `daemon status`
 *     must succeed; the bin must carry the executable bit
 *
 * Exit 0 = the installed CLI works. Anything else = broken distribution.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "shepy-install-smoke-"));

function fail(message) {
  console.error(`smoke: FAIL — ${message}`);
  process.exitCode = 1;
}

try {
  execFileSync("npm", ["pack", "--pack-destination", work], { cwd: root, stdio: "pipe" });
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack produced no tarball");

  const prefix = join(work, "prefix");
  execFileSync("npm", ["install", "--global", "--prefix", prefix, join(work, tarball)], {
    cwd: work,
    stdio: "pipe",
  });

  const bin = join(prefix, "bin", "shepy");
  const mode = statSync(bin).mode;
  if ((mode & 0o111) === 0) {
    fail(`installed bin is not executable: ${bin}`);
  }

  const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  if (!version.startsWith("shepy ")) fail(`--version printed unexpected output: ${version}`);

  // daemon status must produce valid JSON even when the daemon is down
  const status = execFileSync(bin, ["daemon", "status"], { encoding: "utf8" });
  const parsed = JSON.parse(status);
  if (typeof parsed.state !== "string") fail("daemon status did not return a state field");

  console.log(`smoke: OK — ${version} installs and runs from a packed tarball`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(work, { force: true, recursive: true });
}
