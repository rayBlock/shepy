import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * RUN-20260913-04 D1 — daemon identity. The one answer to "WHICH build is
 * answering this socket": a rebuilt dist next to a still-running old daemon
 * is invisible to pid/socket probes alone, so the daemon carries its own
 * version + build stamp + boot identity and serves it over `daemon.info`.
 *
 * `buildStamp` is the ISO mtime of the daemon's own entry file, resolved
 * ONCE at boot: a later rebuild must not rewrite a running daemon's
 * identity, or the skew it exists to expose would hide itself.
 */
export type DaemonInfo = {
  bootId: string;
  bootedAt: string;
  buildStamp: string;
  pid: number;
  version: string;
};

/** ISO mtime of a build artifact, or "unknown" when it cannot be stated. */
export function resolveBuildStamp(entryPath: string | undefined): string {
  if (!entryPath) return "unknown";
  try {
    return new Date(statSync(entryPath).mtimeMs).toISOString();
  } catch {
    return "unknown";
  }
}

/** Walk up from `startDir` to the nearest package.json with a version. */
export function resolvePackageVersion(startDir: string): string {
  let directory = resolve(startDir);
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        version?: unknown;
      };
      if (typeof manifest.version === "string") return manifest.version;
    } catch {
      // keep walking up
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return "unknown";
}

/** Resolved ONCE per boot — hold the result, never re-derive it mid-flight. */
export function createDaemonInfo(input: {
  entryPath?: string | undefined;
  pid: number;
  version: string;
}): DaemonInfo {
  return {
    bootId: randomUUID(),
    bootedAt: new Date().toISOString(),
    buildStamp: resolveBuildStamp(input.entryPath),
    pid: input.pid,
    version: input.version,
  };
}
