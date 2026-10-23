import { realpathSync } from "node:fs";
import { openSqlite } from "@/db/client.js";

/** A separate SQLite exclusive transaction is an OS-backed lifetime lock.
 * It fences daemon startup against offline compaction (including path aliases),
 * releases on crash, and never holds a transaction on the application DB.
 * Keep the sidecar: unlinking it could split the lock across two inodes. */
export function acquireDaemonDatabaseLock(dbPath: string): () => void {
  const { sqlite } = openSqlite(`${realpathSync(dbPath)}.daemon-lock`);
  try {
    sqlite.exec("pragma busy_timeout = 0; begin exclusive");
  } catch (cause) {
    sqlite.close();
    throw new Error(
      "Shepy database is in use by a daemon or maintenance command; stop the daemon before compacting",
      { cause },
    );
  }
  return () => sqlite.close();
}
