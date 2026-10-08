import { DatabaseSync } from "node:sqlite";

/** Busy timeout for every Shepy-owned connection. Concurrent writers (the
 * `shepy` CLI, migration runs, a second daemon during hand-over) trip
 * SQLITE_BUSY instantly at timeout 0, and any un-caught occurrence is a
 * daemon crash — the 2026-10-08 incident root trigger. 5s matches WAL's
 * default checkpoint cadence and far exceeds any Shepy transaction. */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export function openSqlite(path: string) {
  const sqlite = new DatabaseSync(path, { timeout: SQLITE_BUSY_TIMEOUT_MS });

  return { sqlite };
}
