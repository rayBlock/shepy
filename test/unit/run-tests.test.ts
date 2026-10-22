import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

type Runtime = { root: string; paths: Record<string, string>; bin: string; socket: string };
type Tools = { node: string; npm: string; git: string };
type RunTests = {
  repoRoot: string;
  SOCKET_PATH_MAX: number;
  LONGEST_TEST_SOCKET_SUFFIX: string;
  PASSTHROUGH: string[];
  fitsSocketBudget: (tmpdir: string) => boolean;
  runtimeBase: (base?: string) => string;
  trustedTools: (nodePath?: string, gitCandidates?: string[]) => Tools;
  npmCandidates: (nodePath?: string) => string[];
  createRuntime: (base?: string, subject?: string, tools?: Tools) => Runtime;
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
const bytes = (text: string) => Buffer.byteLength(text);

function physical(path: string): boolean {
  for (let part = path; part !== dirname(part); part = dirname(part)) {
    if (lstatSync(part).isSymbolicLink()) return false;
  }
  return true;
}

function bind(path: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => resolvePromise(error.code ?? "error"));
    server.listen(path, () => server.close(() => resolvePromise(null)));
  });
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
    const { createRuntime, trustedTools, repoRoot } = await load();
    const base = scratch();
    const linked = join(base, "linked-base");
    mkdirSync(join(base, "real-base"));
    symlinkSync(join(base, "real-base"), linked);
    const first = createRuntime(linked);
    const second = createRuntime(linked);
    expect(first.root).not.toBe(second.root);
    const tools = trustedTools();
    for (const runtime of [first, second]) {
      expect(physical(runtime.root)).toBe(true);
      expect(inside(runtime.root, join(base, "real-base"))).toBe(true);
      expect(inside(runtime.root, repoRoot) || inside(repoRoot, runtime.root)).toBe(false);
      expect(lstatSync(runtime.root).mode & 0o777).toBe(0o700);
      for (const path of [...Object.values(runtime.paths), dirname(runtime.socket), runtime.bin]) {
        expect(lstatSync(path).isDirectory()).toBe(true);
        expect(lstatSync(path).mode & 0o777).toBe(0o700);
        expect(inside(path, runtime.root)).toBe(true);
      }
      for (const [name, target] of Object.entries(tools)) {
        expect(readlinkSync(join(runtime.bin, name))).toBe(target);
      }
    }
    expect(() => createRuntime(join(repoRoot, "test"))).toThrow("disjoint");
  });

  test("the socket budget counts UTF-8 bytes, not UTF-16 characters", async () => {
    const { fitsSocketBudget, SOCKET_PATH_MAX, LONGEST_TEST_SOCKET_SUFFIX } = await load();
    const suffix = bytes(LONGEST_TEST_SOCKET_SUFFIX);
    expect(suffix).toBe(44);
    const ascii = `/${"a".repeat(SOCKET_PATH_MAX - suffix - 1)}`;
    expect(fitsSocketBudget(ascii)).toBe(true);
    expect(fitsSocketBudget(`${ascii}a`)).toBe(false);
    // The review counterexample: 30 characters, 54 bytes of base; 115-byte socket.
    const cjk = `/private/tmp/teq1/${"漢".repeat(12)}/shepy-t-XXXXXX/t`;
    expect(cjk.length + suffix).toBeLessThanOrEqual(SOCKET_PATH_MAX);
    expect(bytes(cjk) + suffix).toBe(115);
    expect(fitsSocketBudget(cjk)).toBe(false);
  });

  test("a caller TMPDIR whose bytes leave no socket room falls back to a fitting physical /tmp", async () => {
    const { runtimeBase, fitsSocketBudget } = await load();
    const multibyte = join(scratch(), "漢".repeat(12));
    mkdirSync(multibyte);
    const chosen = runtimeBase(multibyte);
    expect(chosen).toBe(realpathSync("/tmp"));
    expect(fitsSocketBudget(`${chosen}/shepy-t-XXXXXX/t`)).toBe(true);
  });

  test("this run's TMPDIR binds the longest real test socket and the byte limit is real", async () => {
    const { SOCKET_PATH_MAX } = await load();
    const longest = join(mkdtempSync(join(tmpdir(), "shepy-herdr-orchestration-")), "herdr.sock");
    expect(bytes(longest)).toBeLessThanOrEqual(SOCKET_PATH_MAX);
    expect(await bind(longest)).toBeNull();
    // Fewer characters than the limit, more bytes: the kernel refuses it.
    const base = realpathSync(tmpdir());
    const room = SOCKET_PATH_MAX - base.length - "//s.sock".length;
    const count = Math.ceil((SOCKET_PATH_MAX - bytes(base) - "//s.sock".length + 1) / 3) + 1;
    expect(count).toBeLessThanOrEqual(room);
    const dir = join(base, "漢".repeat(count));
    mkdirSync(dir);
    const tooLong = join(dir, "s.sock");
    expect(tooLong.length).toBeLessThanOrEqual(SOCKET_PATH_MAX);
    expect(bytes(tooLong)).toBeGreaterThan(SOCKET_PATH_MAX);
    expect(["EINVAL", "ENAMETOOLONG"]).toContain(await bind(tooLong));
  });

  test("the child environment is built from scratch: no inherited discovery, config or credentials", async () => {
    const { createRuntime, testEnvironment, PASSTHROUGH } = await load();
    const runtime = createRuntime(scratch());
    const owned = scratch();
    const inherited: Record<string, string | undefined> = {
      PATH: `${owned}:/usr/bin:/bin`,
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      TZ: "UTC",
      CI: "1",
      KEEP_ME: "1",
      AWS_CONFIG_FILE: join(owned, "aws-config"),
      AWS_SHARED_CREDENTIALS_FILE: join(owned, "aws-credentials"),
      AWS_PROFILE: "synthetic",
      CLOUDSDK_CONFIG: join(owned, "gcloud"),
      AZURE_CONFIG_DIR: join(owned, "azure"),
      GIT_CONFIG_GLOBAL: join(owned, "gitconfig"),
      GIT_SSH_COMMAND: join(owned, "ssh"),
      TSX_TSCONFIG_PATH: join(owned, "tsconfig.json"),
      NODE_EXTRA_CA_CERTS: join(owned, "ca.pem"),
      BASH_ENV: join(owned, "bash-env"),
      ENV: join(owned, "sh-env"),
      NODE_OPTIONS: "--require /tmp/evil.cjs",
      NODE_PATH: "/tmp/shim-node-path",
      HERDR_BIN_PATH: "/tmp/herdr",
      HERDR_PANE_ID: "w1:p1",
      SHEPY_HOME: "/Users/someone/.shepy",
      XDG_RUNTIME_DIR: "/tmp/xdg-runtime",
      npm_config_userconfig: join(owned, "npmrc"),
      GITHUB_TOKEN: "synthetic",
      UNSET: undefined,
    };
    const before = JSON.stringify(inherited);
    const env = testEnvironment(inherited, runtime);
    expect(JSON.stringify(inherited)).toBe(before);
    const fixed = [
      "HOME",
      "SHEPY_HOME",
      "TMPDIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "PATH",
      "HERDR_SOCKET_PATH",
    ];
    const passed = PASSTHROUGH.filter((key) => inherited[key] !== undefined);
    expect(passed.sort()).toEqual(["CI", "LANG", "TERM", "TZ"]);
    expect(Object.keys(env).sort()).toEqual([...fixed, ...passed].sort());
    expect(env.PATH).toBe(`${runtime.bin}:/usr/bin:/bin`);
    expect(env).toMatchObject({
      TERM: "xterm-256color",
      HERDR_SOCKET_PATH: runtime.socket,
    });
    for (const key of fixed.filter((key) => key !== "PATH")) {
      expect(inside(env[key] ?? "/", runtime.root)).toBe(true);
    }
  });

  test("an executable on the caller PATH is not discoverable; the trusted tools are", async () => {
    const { createRuntime, testEnvironment } = await load();
    const runtime = createRuntime(scratch());
    const owned = scratch();
    const marker = join(owned, "canary-ran");
    writeFileSync(join(owned, "shepy-path-canary"), `#!/bin/sh\n: > '${marker}'\n`);
    chmodSync(join(owned, "shepy-path-canary"), 0o755);
    const inherited = { PATH: `${owned}:/usr/bin:/bin` };
    // Control: the canary really runs when the caller PATH is used.
    expect(spawnSync("shepy-path-canary", { env: inherited }).status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    const env = testEnvironment(inherited, runtime);
    const hidden = spawnSync("shepy-path-canary", { env });
    expect((hidden.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
    for (const tool of ["node", "npm", "git"]) {
      expect(spawnSync(tool, ["--version"], { env, encoding: "utf8" }).status).toBe(0);
    }
  });

  test("a missing required tool fails with its name instead of falling back to the caller PATH", async () => {
    const { trustedTools } = await load();
    expect(() => trustedTools(process.execPath, ["/nonexistent/git"])).toThrow(
      "required test tool git not found",
    );
    expect(() => trustedTools(join(scratch(), "node"))).toThrow("required test tool");
  });

  describe("the npm shipped with this node", () => {
    const CLI = join("lib", "node_modules", "npm", "bin", "npm-cli.js");
    const git = [process.execPath];

    /** A node install tree: `<prefix>/bin/node` plus the npm package under `<prefix>/lib`. */
    function install(prefix: string, { npm = true } = {}): { node: string; cli: string } {
      mkdirSync(join(prefix, "bin"), { recursive: true });
      const node = join(prefix, "bin", "node");
      writeFileSync(node, "node\n");
      const cli = join(prefix, CLI);
      if (npm) {
        mkdirSync(dirname(cli), { recursive: true });
        writeFileSync(cli, "npm\n");
      }
      return { node, cli };
    }

    /** Homebrew: node lives in the Cellar, npm under the shared prefix, both reached by symlinks. */
    function homebrew(root: string, { launcher = true } = {}) {
      const prefix = join(root, "homebrew");
      const cellar = join(prefix, "Cellar", "node", "26.5.0");
      mkdirSync(join(cellar, "bin"), { recursive: true });
      writeFileSync(join(cellar, "bin", "node"), "node\n");
      const cli = join(prefix, CLI);
      mkdirSync(dirname(cli), { recursive: true });
      writeFileSync(cli, "npm\n");
      if (launcher) symlinkSync(cli, join(cellar, "bin", "npm"));
      mkdirSync(join(prefix, "bin"));
      symlinkSync(join(cellar, "bin", "node"), join(prefix, "bin", "node"));
      return {
        prefix,
        real: join(cellar, "bin", "node"),
        invoked: join(prefix, "bin", "node"),
        cli: realpathSync(cli),
      };
    }

    /** An npm on the caller PATH that is not the one shipped with the node under test. */
    function withPathNpm<T>(root: string, run: (npm: string) => T): T {
      const dir = join(root, "path-bin");
      mkdirSync(dir, { recursive: true });
      const npm = join(dir, "npm");
      writeFileSync(npm, "#!/bin/sh\n");
      chmodSync(npm, 0o755);
      const saved = process.env.PATH;
      process.env.PATH = `${dir}:${saved ?? ""}`;
      try {
        return run(npm);
      } finally {
        process.env.PATH = saved;
      }
    }

    test("classic layout: npm next to the real node path is found", async () => {
      const { trustedTools } = await load();
      const { node, cli } = install(join(scratch(), "classic"));
      expect(trustedTools(node, git).npm).toBe(realpathSync(cli));
    });

    test("Homebrew layout: npm under the prefix is found from the Cellar node and from the bin symlink", async () => {
      const { trustedTools } = await load();
      const brew = homebrew(scratch());
      // The pre-fix lookup, dirname(dirname(real node)), points into the Cellar where no npm package exists.
      expect(existsSync(join(dirname(dirname(brew.real)), CLI))).toBe(false);
      expect(trustedTools(brew.real, git).npm).toBe(brew.cli);
      expect(trustedTools(brew.invoked, git).npm).toBe(brew.cli);
    });

    test("node invoked through a symlink prefix finds the npm beside the link, not beside the real node", async () => {
      const { trustedTools } = await load();
      const root = scratch();
      const real = install(join(root, "real"), { npm: false });
      const linked = join(root, "linked");
      mkdirSync(join(linked, "bin"), { recursive: true });
      symlinkSync(real.node, join(linked, "bin", "node"));
      const cli = join(linked, CLI);
      mkdirSync(dirname(cli), { recursive: true });
      writeFileSync(cli, "npm\n");
      expect(trustedTools(join(linked, "bin", "node"), git).npm).toBe(realpathSync(cli));
      expect(() => trustedTools(real.node, git)).toThrow("npm not found");
    });

    test("the npm launcher next to the node resolves through its symlink when no package path matches", async () => {
      const { trustedTools } = await load();
      const root = scratch();
      const { node } = install(join(root, "odd"), { npm: false });
      const cli = join(root, "elsewhere", "npm", "bin", "npm-cli.js");
      mkdirSync(dirname(cli), { recursive: true });
      writeFileSync(cli, "npm\n");
      symlinkSync(cli, join(dirname(node), "npm"));
      expect(trustedTools(node, git).npm).toBe(realpathSync(cli));
    });

    test("the real-node-path location wins over a different npm at another location", async () => {
      const { trustedTools } = await load();
      const root = scratch();
      const real = install(join(root, "real"));
      const linked = join(root, "linked");
      mkdirSync(join(linked, "bin"), { recursive: true });
      symlinkSync(real.node, join(linked, "bin", "node"));
      mkdirSync(dirname(join(linked, CLI)), { recursive: true });
      writeFileSync(join(linked, CLI), "other npm\n");
      expect(trustedTools(join(linked, "bin", "node"), git).npm).toBe(realpathSync(real.cli));
    });

    test("an unrelated npm on PATH is refused; the Homebrew control is found with the same PATH", async () => {
      const { trustedTools } = await load();
      const root = scratch();
      const { node } = install(join(root, "no-npm"), { npm: false });
      withPathNpm(root, (pathNpm) => {
        let message = "";
        try {
          trustedTools(node, git);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain("required test tool npm not found");
        expect(message).not.toContain(dirname(pathNpm));
        const brew = homebrew(scratch());
        expect(trustedTools(brew.invoked, git).npm).toBe(brew.cli);
      });
    });

    test("a launcher script beside the node that is not the npm package is refused", async () => {
      const { trustedTools } = await load();
      const { node } = install(join(scratch(), "shim"), { npm: false });
      writeFileSync(join(dirname(node), "npm"), '#!/bin/sh\nexec npm "$@"\n');
      chmodSync(join(dirname(node), "npm"), 0o755);
      expect(() => trustedTools(node, git)).toThrow("npm not found");
    });

    test("no npm anywhere: the refusal names every location tried", async () => {
      const { trustedTools, npmCandidates } = await load();
      const root = scratch();
      const real = install(join(root, "real"), { npm: false });
      const linked = join(root, "linked");
      mkdirSync(join(linked, "bin"), { recursive: true });
      symlinkSync(real.node, join(linked, "bin", "node"));
      const invoked = join(linked, "bin", "node");
      const candidates = npmCandidates(invoked);
      expect(candidates).toEqual([
        join(realpathSync(root), "real", CLI),
        join(linked, CLI),
        join(realpathSync(root), "real", "bin", "npm"),
        join(linked, "bin", "npm"),
      ]);
      let message = "";
      try {
        trustedTools(invoked, git);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("required test tool npm not found");
      for (const candidate of candidates) expect(message).toContain(candidate);
    });

    test("this machine's node resolves an npm package", async () => {
      const { trustedTools } = await load();
      const { npm } = trustedTools();
      expect(npm.endsWith(join("npm", "bin", "npm-cli.js"))).toBe(true);
      expect(spawnSync(process.execPath, [npm, "--version"], { encoding: "utf8" }).status).toBe(0);
    });
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
        `appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, nodePath: process.env.NODE_PATH ?? null, cwd: process.cwd() }) + "\\n");`,
        'if (args.includes("--die")) process.kill(process.pid, "SIGTERM");',
        'process.exit(Number(args.find((a) => a.startsWith("--exit="))?.slice(7) ?? 0));',
      ].join("\n"),
    );
    const env = { PATH: process.env.PATH ?? "" };
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
  });
});
