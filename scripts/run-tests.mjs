#!/usr/bin/env node
/**
 * The supported `pnpm test` entry.
 *
 * test/integration/claude-profile-demand-validation.test.ts runs only inside an
 * explicitly admitted, physically owned runtime root, and it refuses inherited
 * loader overrides such as NODE_PATH. pnpm's generated node_modules/.bin/vitest
 * shim exports NODE_PATH, so a bare `vitest run` can never execute those strict
 * cases. This entry builds that admission instead of weakening the fixture:
 *
 *  1. create a fresh physical runtime root, disjoint from the repository, with
 *     owned private HOME, SHEPY_HOME, TMPDIR, XDG and socket paths. Tests
 *     bind Unix sockets below TMPDIR and macOS caps a socket path at 103
 *     bytes, so when the caller's physical TMPDIR leaves too little room the
 *     root is created under the physical /tmp instead;
 *  2. copy the caller environment WITHOUT loader overrides, Herdr/Shepy
 *     runtime selectors or credentials (the caller's own process.env is never
 *     modified) and set isolated-fixture admission in source CLI mode;
 *  3. start the locked Vitest entry directly with node (no shim), forwarding
 *     every argument after `vitest run` unchanged and propagating its exit.
 *
 * The runtime root is retained after the run; the fixture keeps its captures.
 * The fixture itself is unchanged and still fails closed when started any
 * other way without admission or with an inherited override.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

const LOADER_OVERRIDES = new Set(["NODE_OPTIONS", "NODE_PATH", "HERDR_BIN_PATH"]);
const RUNTIME_PREFIXES = ["HERDR_", "SHEPY_", "XDG_"];
const CREDENTIAL = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|_AUTH/i;
// Measured longest test socket suffix below TMPDIR is 44 bytes; keep a margin.
const SOCKET_PATH_MAX = 103;
const SOCKET_SUFFIX_RESERVE = 50;
const ROOT_PREFIX = "shepy-t-";
const ROOT_LAYOUT = `/${ROOT_PREFIX}XXXXXX/t/`;
const PRIVATE_PATHS = {
  HOME: "home",
  SHEPY_HOME: "shepy",
  TMPDIR: "t",
  XDG_CONFIG_HOME: "xdg-config",
  XDG_DATA_HOME: "xdg-data",
  XDG_CACHE_HOME: "xdg-cache",
  XDG_STATE_HOME: "xdg-state",
};

function contained(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** The physical base for the runtime root: the caller's TMPDIR when sockets still fit. */
export function runtimeBase(base = tmpdir()) {
  const physical = realpathSync(base);
  if (physical.length + ROOT_LAYOUT.length + SOCKET_SUFFIX_RESERVE <= SOCKET_PATH_MAX) {
    return physical;
  }
  return realpathSync("/tmp");
}

/** A fresh, physical, owner-only runtime root that shares no path with `subject`. */
export function createRuntime(base = runtimeBase(), subject = repoRoot) {
  const physicalBase = realpathSync(base);
  // Refuse before creating anything inside the repository.
  if (contained(physicalBase, subject)) {
    throw new Error(`test runtime root must be disjoint from the repository: ${physicalBase}`);
  }
  const root = mkdtempSync(join(physicalBase, ROOT_PREFIX));
  if (realpathSync(root) !== root) throw new Error(`test runtime root is not physical: ${root}`);
  if (contained(root, subject) || contained(subject, root)) {
    throw new Error(`test runtime root must be disjoint from the repository: ${root}`);
  }
  const paths = {};
  for (const [key, name] of Object.entries(PRIVATE_PATHS)) {
    paths[key] = join(root, name);
    mkdirSync(paths[key], { mode: 0o700 });
  }
  mkdirSync(join(root, "sockets"), { mode: 0o700 });
  return { root, paths, socket: join(root, "sockets", "forbidden.sock") };
}

/** A new environment object for the Vitest child; `inherited` is not modified. */
export function testEnvironment(inherited, runtime) {
  const env = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined || key === "TMP" || key === "TEMP") continue;
    if (LOADER_OVERRIDES.has(key) || CREDENTIAL.test(key)) continue;
    if (RUNTIME_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  return {
    ...env,
    ...runtime.paths,
    HERDR_SOCKET_PATH: runtime.socket,
    SHEPY_DEMAND_FIXTURE_ROOT: runtime.root,
    SHEPY_DEMAND_FIXTURE_ADMISSION: "isolated-fixture",
    SHEPY_DEMAND_FIXTURE_CLI_MODE: "source",
  };
}

/** The Vitest entry file that pnpm-lock.yaml installed for this repository. */
export function resolveVitest(subject = repoRoot) {
  const manifestPath = createRequire(join(subject, "package.json")).resolve("vitest/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vitest;
  if (typeof bin !== "string") throw new Error("vitest package declares no vitest bin");
  const entry = realpathSync(join(dirname(manifestPath), bin));
  if (!contained(entry, subject)) throw new Error(`vitest entry is outside the repository: ${entry}`);
  return { entry, version: manifest.version };
}

/** Run `vitest run <args>` and resolve with its exit status (128 + signal when killed). */
export function runVitest(args, env, { entry = resolveVitest().entry, cwd = repoRoot } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry, "run", ...args], { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      resolvePromise(code ?? 128 + (constants.signals[signal] ?? 0)),
    );
  });
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = createRuntime();
  process.stderr.write(`shepy test runtime: ${runtime.root}\n`);
  process.exitCode = await runVitest(process.argv.slice(2), testEnvironment(process.env, runtime));
}
