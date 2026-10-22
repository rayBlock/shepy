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

  /** Release only after a definite connect failure, never after an ambiguous send. */
  releaseUnconnectedAttempt(input: { batchKey: string; profileId: string }): void {
    this.#sqlite
      .prepare("delete from claude_idle_wakes where profile_id = ? and batch_key = ?")
      .run(input.profileId, input.batchKey);
  }

  /**
   * Reserve before crossing the messaging socket boundary. A false result
   * means this exact pending batch was attempted previously. Only a definite
   * pre-connect failure may release it; ambiguous sends are never retried.
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
