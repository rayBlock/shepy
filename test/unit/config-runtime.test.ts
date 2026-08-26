import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  getShepyHome,
  loadShepyDotEnv,
  resolveRuntime,
  resolveRuntimePath,
  resolveRuntimePaths,
  runtimePathsFromRecordOrDefault,
} from "@/config/runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("Shepy runtime resolver", () => {
  test("uses ~/.shepy when SHEPY_HOME is absent", () => {
    expect(getShepyHome({})).toBe(resolve(homedir(), ".shepy"));
  });

  test("uses explicit SHEPY_HOME", () => {
    expect(getShepyHome({ SHEPY_HOME: "/tmp/shepy-dev" })).toBe("/tmp/shepy-dev");
  });

  test("resolves default runtime paths under Shepy home", () => {
    const homeDir = tempHome();

    const runtime = resolveRuntime({ environment: { SHEPY_HOME: homeDir } });

    expect(runtime.paths).toMatchObject({
      configPath: join(homeDir, "config.yaml"),
      dbPath: join(homeDir, "state.db"),
      envPath: join(homeDir, ".env"),
      homeDir,
      logPath: join(homeDir, "logs/shepy.log"),
      pidPath: join(homeDir, "shepy.pid"),
      piSessionDir: join(homeDir, "pi-sessions"),
      runtimeRecordPath: join(homeDir, "runtime.json"),
      socketPath: join(homeDir, "shepy.sock"),
    });
  });

  test("resolves relative runtime config paths from Shepy home", () => {
    const homeDir = tempHome();
    writeValidConfig(
      homeDir,
      `runtime:
  db_path: data/state.sqlite
  socket_path: sockets/dev.sock
  pid_path: run/dev.pid
  log_path: logs/dev.log
`,
    );

    const runtime = resolveRuntime({ environment: { SHEPY_HOME: homeDir } });

    expect(runtime.paths.dbPath).toBe(join(homeDir, "data/state.sqlite"));
    expect(runtime.paths.socketPath).toBe(join(homeDir, "sockets/dev.sock"));
    expect(runtime.paths.pidPath).toBe(join(homeDir, "run/dev.pid"));
    expect(runtime.paths.logPath).toBe(join(homeDir, "logs/dev.log"));
  });

  test("keeps absolute runtime config paths", () => {
    const homeDir = tempHome();
    writeValidConfig(
      homeDir,
      `runtime:
  db_path: /var/tmp/shepy/state.sqlite
  socket_path: /var/tmp/shepy/shepy.sock
  pid_path: /var/tmp/shepy/shepy.pid
  log_path: /var/tmp/shepy/shepy.log
`,
    );

    const runtime = resolveRuntime({ environment: { SHEPY_HOME: homeDir } });

    expect(runtime.paths.dbPath).toBe("/var/tmp/shepy/state.sqlite");
    expect(runtime.paths.socketPath).toBe("/var/tmp/shepy/shepy.sock");
    expect(runtime.paths.pidPath).toBe("/var/tmp/shepy/shepy.pid");
    expect(runtime.paths.logPath).toBe("/var/tmp/shepy/shepy.log");
  });

  test("loads .env values over shell values while ignoring SHEPY variables", () => {
    const homeDir = tempHome();
    const envPath = join(homeDir, "dotenv-test");
    writeFileSync(
      envPath,
      `EXAMPLE_SERVICE_TOKEN=file-token
OPENAI_API_KEY="file-key"
SHEPY_HOME=/tmp/ignored
SHEPY_INTERNAL_SOCKET_PATH=/tmp/ignored.sock
`,
    );

    const environment = loadShepyDotEnv({
      baseEnvironment: {
        EXISTING: "kept",
        OPENAI_API_KEY: "shell-key",
        SHEPY_HOME: homeDir,
      },
      envPath,
    });

    expect(environment.EXAMPLE_SERVICE_TOKEN).toBe("file-token");
    expect(environment.OPENAI_API_KEY).toBe("file-key");
    expect(environment.EXISTING).toBe("kept");
    expect(environment.SHEPY_HOME).toBe(homeDir);
    expect(environment.SHEPY_INTERNAL_SOCKET_PATH).toBeUndefined();
  });

  test("throws on invalid config unless invalid config is allowed", () => {
    const homeDir = tempHome();
    writeFileSync(join(homeDir, "config.yaml"), "runtime: [");

    expect(() => resolveRuntime({ environment: { SHEPY_HOME: homeDir } })).toThrow(
      "Invalid Shepy config",
    );

    const runtime = resolveRuntime({
      allowInvalidConfig: true,
      environment: { SHEPY_HOME: homeDir },
    });
    expect(runtime.configErrors?.length).toBeGreaterThan(0);
    expect(runtime.paths.dbPath).toBe(join(homeDir, "state.db"));
  });

  test("falls back to runtime record paths for management commands", () => {
    const homeDir = tempHome();
    writeFileSync(join(homeDir, "config.yaml"), "runtime: [");
    writeFileSync(
      join(homeDir, "runtime.json"),
      JSON.stringify({
        dbPath: join(homeDir, "last-state.db"),
        homeDir,
        logPath: join(homeDir, "last.log"),
        pid: 1234,
        pidPath: join(homeDir, "last.pid"),
        socketPath: join(homeDir, "last.sock"),
        startedAt: "2026-06-29T00:00:00.000Z",
        version: 1,
      }),
    );

    const runtime = resolveRuntime({
      allowInvalidConfig: true,
      environment: { SHEPY_HOME: homeDir },
    });
    const paths = runtimePathsFromRecordOrDefault({ environment: runtime.environment });

    expect(runtime.configErrors?.length).toBeGreaterThan(0);
    expect(paths.dbPath).toBe(join(homeDir, "last-state.db"));
    expect(paths.socketPath).toBe(join(homeDir, "last.sock"));
    expect(paths.pidPath).toBe(join(homeDir, "last.pid"));
    expect(paths.logPath).toBe(join(homeDir, "last.log"));
  });

  test("falls back to home defaults when runtime record is missing", () => {
    const homeDir = tempHome();
    writeFileSync(join(homeDir, "config.yaml"), "runtime: [");

    const runtime = resolveRuntime({
      allowInvalidConfig: true,
      environment: { SHEPY_HOME: homeDir },
    });
    const paths = runtimePathsFromRecordOrDefault({ environment: runtime.environment });

    expect(runtime.configErrors?.length).toBeGreaterThan(0);
    expect(paths.dbPath).toBe(join(homeDir, "state.db"));
    expect(paths.socketPath).toBe(join(homeDir, "shepy.sock"));
    expect(paths.pidPath).toBe(join(homeDir, "shepy.pid"));
    expect(paths.logPath).toBe(join(homeDir, "logs/shepy.log"));
  });

  test("resolves explicit runtime path values", () => {
    expect(resolveRuntimePath("/home/shepy", "state.db")).toBe("/home/shepy/state.db");
    expect(resolveRuntimePath("/home/shepy", "/tmp/state.db")).toBe("/tmp/state.db");
  });

  test("resolves paths from an already loaded config", () => {
    const paths = resolveRuntimePaths({
      config: {
        runtime: { db_path: "data/state.db" },
      },
      environment: { SHEPY_HOME: "/tmp/shepy-home" },
    });

    expect(paths.dbPath).toBe("/tmp/shepy-home/data/state.db");
  });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "shepy-runtime-"));
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeValidConfig(homeDir: string, extraYaml = ""): void {
  writeFileSync(
    join(homeDir, "config.yaml"),
    `${extraYaml}observability:
  telemetry: {}
`,
  );
}
