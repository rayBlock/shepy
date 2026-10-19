import { existsSync, renameSync, writeFileSync } from "node:fs";
import {
  type OwnerFileWriteHooks,
  casOwnerRecord as realCasOwnerRecord,
} from "../../src/cli/owner-file.js";

export * from "../../src/cli/owner-file.js";

// Imported only by the test-owned hook entry, never by the production CLI.
const casGate = process.env.SHEPY_HOOK_TEST_CAS_GATE;
const contended = process.env.SHEPY_HOOK_TEST_LOCK_CONTENDED;
const crashPoint = process.env.SHEPY_HOOK_TEST_WRITE_PAUSE;
const rawPause = Number(process.env.SHEPY_HOOK_TEST_CAS_PAUSE_MS ?? "0");
const pauseMs =
  Number.isFinite(rawPause) && rawPause > 0 ? Math.min(Math.floor(rawPause), 10_000) : 0;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function marker(path: string): void {
  if (existsSync(path)) return;
  writeFileSync(`${path}.tmp`, `${process.pid}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

const hooks: OwnerFileWriteHooks = {
  checked() {
    if (casGate) {
      marker(`${casGate}.ready`);
      const deadline = Date.now() + 10_000;
      while (!existsSync(`${casGate}.release`)) {
        if (Date.now() >= deadline) throw new Error("test CAS gate was not released");
        sleep(5);
      }
    }
    if (pauseMs > 0) sleep(pauseMs);
  },
  lockContended() {
    if (contended) marker(contended);
  },
  beforeRename() {
    if (crashPoint === "before-rename") sleep(Number.POSITIVE_INFINITY);
  },
  afterRename() {
    if (crashPoint === "after-rename") sleep(Number.POSITIVE_INFINITY);
  },
};

export function casOwnerRecord(input: Parameters<typeof realCasOwnerRecord>[0]): boolean {
  return realCasOwnerRecord(input, hooks);
}
