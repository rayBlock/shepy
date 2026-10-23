import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { parseCliArgs, runCliCommand } from "@/cli/shepy.js";

const require = createRequire(import.meta.url);

test.each([
  "SIGTERM",
  "SIGKILL",
] as const)("compact refuses a running daemon, including aliases; %s releases the lifetime lock", async (signal) => {
  const dir = mkdtempSync(join(tmpdir(), "shepy-compact-"));
  // A private producer boundary: no live Herdr sessions or socket is used.
  writeFileSync(
    join(dir, "herdr"),
    '#!/bin/sh\n[ "$*" = "session list --json" ] || exit 2\nprintf \'{"sessions":[]}\\n\'\n',
    { mode: 0o700 },
  );
  const child = spawn(
    process.execPath,
    ["--import", require.resolve("tsx"), resolve("src/cli/shepy-daemon.ts")],
    {
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, TMPDIR: dir, SHEPY_HOME: dir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let log = "";
  child.stderr.on("data", (data) => {
    log += data;
  });
  try {
    await new Promise<void>((ready, reject) => {
      child.stdout.on("data", (data) => {
        log += data;
        if (log.includes("Shepy daemon listening")) ready();
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error(log)));
    });
    const path = join(dir, "state.db");
    const alias = join(dir, "alias.db");
    symlinkSync(path, alias);
    const compact = (dbPath: string) =>
      runCliCommand(parseCliArgs(["maintenance", "compact"]), {
        dbPath,
        socketPath: join(dir, "unused.sock"),
        connect: async () => {
          throw new Error("must not contact daemon");
        },
        output: () => {},
      });
    await expect(compact(path)).rejects.toThrow("database is in use");
    await expect(compact(alias)).rejects.toThrow("database is in use");
    child.kill(signal);
    const [code, exitSignal] = await exited;
    expect(signal === "SIGTERM" ? code : exitSignal).toBe(signal === "SIGTERM" ? 0 : "SIGKILL");
    await expect(compact(alias)).resolves.toBeUndefined();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
