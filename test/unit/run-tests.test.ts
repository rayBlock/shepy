import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

type Runtime = { root: string; paths: Record<string, string>; socket: string };
type RunTests = {
  repoRoot: string;
  runtimeBase: (base?: string) => string;
  createRuntime: (base?: string, subject?: string) => Runtime;
  testEnvironment: (
    inherited: Record<string, string | undefined>,
    runtime: Runtime,
  ) => Record<string, string>;
  resolveVitest: (subject?: string) => { entry: string; version: string };
  runVitest: (
    args: string[],
    env: Record<string, string>,
    options?: { entry?: string; cwd?: string },
  ) => Promise<number>;
};

const script = resolve("scripts/run-tests.mjs");
const load = async (): Promise<RunTests> => (await import(pathToFileURL(script).href)) as RunTests;
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "shepy-run-tests-")));
const inside = (path: string, root: string) => !relative(root, path).startsWith("..");

function physical(path: string): boolean {
  for (let part = path; part !== dirname(part); part = dirname(part)) {
    if (lstatSync(part).isSymbolicLink()) return false;
  }
  return true;
}

describe("pnpm test entry", () => {
  test("package.json test script is the admitted entry, not the vitest shim", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.test).toBe("node scripts/run-tests.mjs");
    expect(manifest.scripts.check).toContain("pnpm test");
  });

  test("each run gets a fresh physical owner-only runtime disjoint from the repository", async () => {
    const { createRuntime, repoRoot } = await load();
    const base = scratch();
    const linked = join(base, "linked-base");
    mkdirSync(join(base, "real-base"));
    symlinkSync(join(base, "real-base"), linked);
    const first = createRuntime(linked);
    const second = createRuntime(linked);
    expect(first.root).not.toBe(second.root);
    for (const runtime of [first, second]) {
      expect(physical(runtime.root)).toBe(true);
      expect(inside(runtime.root, join(base, "real-base"))).toBe(true);
      expect(inside(runtime.root, repoRoot) || inside(repoRoot, runtime.root)).toBe(false);
      expect(lstatSync(runtime.root).mode & 0o777).toBe(0o700);
      for (const path of [...Object.values(runtime.paths), dirname(runtime.socket)]) {
        expect(lstatSync(path).isDirectory()).toBe(true);
        expect(lstatSync(path).mode & 0o777).toBe(0o700);
        expect(inside(path, runtime.root)).toBe(true);
      }
    }
    expect(() => createRuntime(join(repoRoot, "test"))).toThrow("disjoint");
  });

  test("a caller TMPDIR too long for test socket paths falls back to the physical /tmp", async () => {
    const { runtimeBase } = await load();
    const long = join(scratch(), "x".repeat(40), "y".repeat(40));
    mkdirSync(long, { recursive: true });
    expect(runtimeBase(long)).toBe(realpathSync("/tmp"));
    expect(runtimeBase("/")).toBe("/");
    expect(runtimeBase(long).length + "/shepy-t-XXXXXX/t/".length + 50).toBeLessThanOrEqual(103);
  });

  test("the child environment drops overrides and credentials and binds every path to the runtime", async () => {
    const { createRuntime, testEnvironment } = await load();
    const runtime = createRuntime(scratch());
    const inherited = {
      PATH: "/usr/bin:/bin",
      KEEP_ME: "1",
      NODE_OPTIONS: "--require /tmp/evil.cjs",
      NODE_PATH: "/tmp/shim-node-path",
      HERDR_BIN_PATH: "/tmp/herdr",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/live-herdr.sock",
      SHEPY_HOME: "/Users/someone/.shepy",
      SHEPY_DEMAND_FIXTURE_ROOT: "/",
      XDG_RUNTIME_DIR: "/tmp/xdg-runtime",
      GITHUB_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
      npm_config__authToken: "secret",
      TMP: "/tmp",
      UNSET: undefined,
    };
    const before = JSON.stringify(inherited);
    const env = testEnvironment(inherited, runtime);
    expect(JSON.stringify(inherited)).toBe(before);
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.KEEP_ME).toBe("1");
    for (const key of [
      "NODE_OPTIONS",
      "NODE_PATH",
      "HERDR_BIN_PATH",
      "HERDR_PANE_ID",
      "XDG_RUNTIME_DIR",
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
      "npm_config__authToken",
      "TMP",
      "UNSET",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env).toMatchObject({
      SHEPY_DEMAND_FIXTURE_ROOT: runtime.root,
      SHEPY_DEMAND_FIXTURE_ADMISSION: "isolated-fixture",
      SHEPY_DEMAND_FIXTURE_CLI_MODE: "source",
      HERDR_SOCKET_PATH: runtime.socket,
    });
    for (const key of [
      "HOME",
      "SHEPY_HOME",
      "TMPDIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "HERDR_SOCKET_PATH",
    ]) {
      expect(inside(env[key] ?? "/", runtime.root)).toBe(true);
    }
  });

  test("the entry is the locked vitest package inside this repository", async () => {
    const { resolveVitest, repoRoot } = await load();
    const { entry, version } = resolveVitest();
    expect(inside(entry, repoRoot)).toBe(true);
    expect(lstatSync(entry).isFile()).toBe(true);
    expect(entry).not.toContain(join("node_modules", ".bin"));
    expect(readFileSync("pnpm-lock.yaml", "utf8")).toContain(`\n  vitest@${version}:\n`);
  });

  test("runVitest starts the child once with `run` plus the exact arguments and returns its exit", async () => {
    const { runVitest } = await load();
    const dir = scratch();
    const record = join(dir, "record.json");
    const child = join(dir, "child.mjs");
    writeFileSync(
      child,
      [
        'import { appendFileSync } from "node:fs";',
        "const args = process.argv.slice(2);",
        `appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, nodePath: process.env.NODE_PATH ?? null, admission: process.env.SHEPY_DEMAND_FIXTURE_ADMISSION ?? null, cwd: process.cwd() }) + "\\n");`,
        'if (args.includes("--die")) process.kill(process.pid, "SIGTERM");',
        'process.exit(Number(args.find((a) => a.startsWith("--exit="))?.slice(7) ?? 0));',
      ].join("\n"),
    );
    const env = {
      PATH: process.env.PATH ?? "",
      SHEPY_DEMAND_FIXTURE_ADMISSION: "isolated-fixture",
    };
    const forwarded = ["test/unit/a.test.ts", "-t", "a name with spaces", "--reporter=verbose"];
    expect(await runVitest([...forwarded, "--exit=0"], env, { entry: child, cwd: dir })).toBe(0);
    expect(await runVitest(["--exit=3"], env, { entry: child, cwd: dir })).toBe(3);
    expect(await runVitest(["--die"], env, { entry: child, cwd: dir })).toBe(128 + 15);
    const runs = readFileSync(record, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; nodePath: string | null; cwd: string });
    expect(runs.map((run) => run.args)).toEqual([
      ["run", ...forwarded, "--exit=0"],
      ["run", "--exit=3"],
      ["run", "--die"],
    ]);
    expect(runs.every((run) => run.nodePath === null && realpathSync(run.cwd) === dir)).toBe(true);
    expect(runs.map((run) => (run as { admission?: string }).admission)).toEqual([
      "isolated-fixture",
      "isolated-fixture",
      "isolated-fixture",
    ]);
  });
});
