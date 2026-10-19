import type { DatabaseSync } from "node:sqlite";

/** Durable once-per-pending-batch fence for best-effort Claude idle wakes. */
export class ClaudeIdleWakeStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  attemptedObligationIds(profileId: string): Set<string> {
    const rows = this.#sqlite
      .prepare(
        `select j.value as id from claude_idle_wakes w, json_each(w.obligation_ids_json) j
       where w.profile_id = ?`,
      )
      .all(profileId) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Records the send attempt before it crosses the Claude messaging socket boundary.
   * A false result means this exact pending batch was attempted previously;
   * ambiguous or failed sends are deliberately not retried.
   */
  recordAttempt(input: {
    batchKey: string;
    now?: number;
    obligationIds: string[];
    profileId: string;
  }): boolean {
    const result = this.#sqlite
      .prepare(
        `insert into claude_idle_wakes (profile_id, batch_key, obligation_ids_json, created_at)
         values (?, ?, ?, ?) on conflict(profile_id, batch_key) do nothing`,
      )
      .run(
        input.profileId,
        input.batchKey,
        JSON.stringify(input.obligationIds),
        input.now ?? Date.now(),
      );
    return result.changes > 0;
  }
}
