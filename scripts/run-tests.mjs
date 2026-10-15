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
 *     owned private HOME, SHEPY_HOME, TMPDIR, XDG, socket and tool paths.
 *     Tests bind Unix sockets below TMPDIR, so the root goes under the
 *     caller's physical TMPDIR only when the generated TMPDIR plus the longest
 *     test socket suffix fits the platform's socket path limit in UTF-8 bytes;
 *     otherwise under the physical /tmp, which must fit as well;
 *  2. build the child environment from scratch: the private paths, the fixture
 *     admission in source CLI mode, a PATH of exactly the trusted tools the
 *     suite runs (this node, the npm shipped with it, a system git) followed
 *     by /usr/bin:/bin, and a short allowlist of terminal/locale/CI controls.
 *     Nothing else is inherited: no caller PATH, credential, SDK/cloud/Git
 *     config, shell startup or loader selector. The caller's own process.env
 *     is never modified;
 *  3. start the locked Vitest entry directly with node (no shim), forwarding
 *     every argument after `vitest run` unchanged and propagating its exit.
 *
 * The runtime root is retained after the run; the fixture keeps its captures.
 * The fixture itself is unchanged and still fails closed when started any
 * other way without admission or with an inherited override.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

/** sun_path holds 104 (macOS) or 108 (Linux) bytes including the terminating NUL. */
export const SOCKET_PATH_MAX = process.platform === "darwin" ? 103 : 107;
/** The longest socket path any test binds below TMPDIR (test/integration/herdr-orchestration-transport). */
export const LONGEST_TEST_SOCKET_SUFFIX = "/shepy-herdr-orchestration-XXXXXX/herdr.sock";
const ROOT_PREFIX = "shepy-t-";
const ROOT_TMPDIR_LAYOUT = `/${ROOT_PREFIX}XXXXXX/t`;
const PRIVATE_PATHS = {
  HOME: "home",
  SHEPY_HOME: "shepy",
  TMPDIR: "t",
  XDG_CONFIG_HOME: "xdg-config",
  XDG_DATA_HOME: "xdg-data",
  XDG_CACHE_HOME: "xdg-cache",
  XDG_STATE_HOME: "xdg-state",
};
/** Non-sensitive terminal, locale and CI controls a caller may pass to the suite. */
export const PASSTHROUGH = ["CI", "COLORTERM", "FORCE_COLOR", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "TERM", "TZ"];
const SYSTEM_PATH = ["/usr/bin", "/bin"];
const GIT_CANDIDATES = ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];

function contained(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** True when a test socket created below `tmpdir` stays within the socket path limit. */
export function fitsSocketBudget(tmpdir) {
  return Buffer.byteLength(tmpdir) + Buffer.byteLength(LONGEST_TEST_SOCKET_SUFFIX) <= SOCKET_PATH_MAX;
}

/** The physical base for the runtime root: the caller's TMPDIR when sockets fit, else /tmp. */
export function runtimeBase(base = tmpdir()) {
  for (const candidate of [realpathSync(base), realpathSync("/tmp")]) {
    if (fitsSocketBudget(candidate + ROOT_TMPDIR_LAYOUT)) return candidate;
  }
  throw new Error(
    `no runtime base leaves room for test sockets within ${SOCKET_PATH_MAX} bytes: ${base}, /tmp`,
  );
}

/** The executables the suite runs, resolved from trusted locations only. */
export function trustedTools(nodePath = process.execPath, gitCandidates = GIT_CANDIDATES) {
  // The npm package shipped with this node distribution, not a caller or manager wrapper.
  const npm = join(dirname(dirname(nodePath)), "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const git = gitCandidates.find((candidate) => existsSync(candidate));
  if (!existsSync(nodePath)) throw new Error(`required test tool node not found: ${nodePath}`);
  if (!existsSync(npm)) throw new Error(`required test tool npm not found with node: ${npm}`);
  if (git === undefined) {
    throw new Error(`required test tool git not found in ${gitCandidates.join(", ")}`);
  }
  return { node: realpathSync(nodePath), npm: realpathSync(npm), git: realpathSync(git) };
}

/** A fresh, physical, owner-only runtime root that shares no path with `subject`. */
export function createRuntime(base = runtimeBase(), subject = repoRoot, tools = trustedTools()) {
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
  const bin = join(root, "bin");
  mkdirSync(bin, { mode: 0o700 });
  for (const [name, target] of Object.entries(tools)) symlinkSync(target, join(bin, name));
  return { root, paths, bin, socket: join(root, "sockets", "forbidden.sock") };
}

/** The complete environment for the Vitest child; `inherited` is only read. */
export function testEnvironment(inherited, runtime) {
  const env = {};
  for (const key of PASSTHROUGH) if (inherited[key] !== undefined) env[key] = inherited[key];
  return {
    ...env,
    ...runtime.paths,
    PATH: [runtime.bin, ...SYSTEM_PATH].join(":"),
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
  try {
    const runtime = createRuntime();
    if (!fitsSocketBudget(runtime.paths.TMPDIR)) {
      throw new Error(`test runtime TMPDIR leaves no room for test sockets: ${runtime.paths.TMPDIR}`);
    }
    process.stderr.write(`shepy test runtime: ${runtime.root}\n`);
    process.exitCode = await runVitest(process.argv.slice(2), testEnvironment(process.env, runtime));
  } catch (error) {
    process.stderr.write(`shepy test entry: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
