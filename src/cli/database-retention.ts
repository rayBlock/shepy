import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openSqlite, SQLITE_BUSY_TIMEOUT_MS } from "@/db/client.js";
import { runRetention } from "@/db/retention.js";

/** Direct maintenance: never starts or contacts the daemon, never creates a DB. */
export async function retainDatabase(input: { dbPath: string; dryRun: boolean; vacuum: boolean }) {
  if (input.dryRun && input.vacuum) throw new Error("--dry-run cannot be combined with --vacuum");
  if (!existsSync(input.dbPath)) throw new Error(`Shepy database not found: ${input.dbPath}`);
  const sqlite = input.dryRun
    ? new DatabaseSync(input.dbPath, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS })
    : openSqlite(input.dbPath).sqlite;
  const started = Date.now();
  try {
    const result = await runRetention(sqlite, { dryRun: input.dryRun });
    if (input.vacuum) sqlite.exec("vacuum");
    return { ...result, elapsedMs: Date.now() - started, vacuumed: input.vacuum };
  } finally {
    sqlite.close();
  }
}
