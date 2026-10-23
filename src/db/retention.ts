import type { DatabaseSync } from "node:sqlite";
import { setTimeout as pause } from "node:timers/promises";
import { agentHistoryFormatterVersion } from "@/agent-history/formatter-version.js";

export const RETENTION_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const RETENTION_BATCH_SIZE = 100;

export type RetentionCursor = {
  afterCacheId: number;
  afterEventId: number;
  cutoff: number;
  maxCacheId: number;
  maxEventId: number;
};

export type RetentionCounts = {
  cacheRows: number;
  estimatedBytesFreed: number;
  eventRows: number;
  scannedRows: number;
};

export type RetentionResult = RetentionCounts & {
  batches: number;
  cutoff: number;
  complete: boolean;
  dryRun: boolean;
};

const emptyCounts = (): RetentionCounts => ({
  cacheRows: 0,
  estimatedBytesFreed: 0,
  eventRows: 0,
  scannedRows: 0,
});

// All obligations (including acknowledged audit rows) remain references. Owned
// cursors protect both their anchor and unread events in that exact scope.
// Indexed agents still need their outcome ledger: departure recovery replays
// unprojected outcomes and walks prior settled events to reject seen-turn flaps.
// Keep the latest status observation too, including a deferred settlement journal.
// These references cease to protect rows when the agent leaves the index.
const eligibleEvent = `e.created_at < ?
  and not exists (select 1 from delivery_obligations o where o.agent_event_id = e.id)
  and not exists (select 1 from source_entry_deliveries d where d.agent_event_id = e.id)
  and not exists (select 1 from agent_orchestrator_scopes s
    where s.herdr_session_name = e.herdr_session_name and s.workspace_id = e.workspace_id
      and (s.owner_terminal_id is not null or s.owner_pane_id is not null)
      and e.id >= s.acked_event_id)
  and not (e.agent_id is not null and (
    e.type in ('agent.done', 'agent.idle', 'agent.blocked', 'agent.tool.failed')
    or (e.type = 'agent.status.changed' and e.id = (
      select p.id from agent_events p where p.agent_id = e.agent_id
        and p.type in ('agent.status.changed', 'agent.done', 'agent.idle', 'agent.blocked')
      order by p.id desc limit 1))))`;

type Candidate = { bytes: number; id: number };

// This callback is synchronous: no work on the shared daemon connection can
// interleave before its ordinary timeout is restored. Include high-water reads,
// which can also be blocked by an exclusive writer such as manual VACUUM.
function withRetentionTimeout<T>(sqlite: DatabaseSync, operation: () => T): T {
  const timeout = (sqlite.prepare("pragma busy_timeout").get() as { timeout: number }).timeout;
  sqlite.exec("pragma busy_timeout = 25");
  try {
    return operation();
  } finally {
    sqlite.exec(`pragma busy_timeout = ${timeout}`);
  }
}

export class RetentionStore {
  constructor(readonly sqlite: DatabaseSync) {}

  begin(now = Date.now()): RetentionCursor {
    return withRetentionTimeout(this.sqlite, () => {
      const maxId = (table: string) =>
        (
          this.sqlite.prepare(`select coalesce(max(id), 0) as id from ${table}`).get() as {
            id: number;
          }
        ).id;
      return {
        afterCacheId: 0,
        afterEventId: 0,
        cutoff: now - RETENTION_AGE_MS,
        maxCacheId: maxId("agent_history_cache"),
        maxEventId: maxId("agent_events"),
      };
    });
  }

  batch(
    input: RetentionCursor,
    options: { batchSize?: number; dryRun?: boolean } = {},
  ): RetentionCounts & { complete: boolean; cursor: RetentionCursor } {
    const size = options.batchSize ?? RETENTION_BATCH_SIZE;
    if (!Number.isSafeInteger(size) || size < 1 || size > 1_000) {
      throw new Error("Retention batch size must be an integer between 1 and 1000");
    }
    return withRetentionTimeout(this.sqlite, () => {
      const cursor = { ...input };
      const counts = emptyCounts();
      let transaction = false;
      try {
        this.sqlite.exec(options.dryRun ? "begin" : "begin immediate");
        transaction = true;
        const events = cursor.afterEventId < cursor.maxEventId;
        const table = events ? "agent_events" : "agent_history_cache";
        const after = events ? cursor.afterEventId : cursor.afterCacheId;
        const max = events ? cursor.maxEventId : cursor.maxCacheId;
        // Bound the *scan*, not just the number of eligible rows. A long run of
        // protected events cannot turn one batch into a full-table scan.
        const ids = this.sqlite
          .prepare(`select id from ${table} where id > ? and id <= ? order by id limit ?`)
          .all(after, max, size) as { id: number }[];
        const end = ids.at(-1)?.id ?? max;
        counts.scannedRows = ids.length;
        const candidates = events
          ? (this.sqlite
              .prepare(`select e.id, coalesce(length(cast(e.compact_history_json as blob)), 0)
                + length(cast(e.payload_json as blob)) as bytes
              from agent_events e where e.id > ? and e.id <= ? and ${eligibleEvent}`)
              .all(after, end, cursor.cutoff) as Candidate[])
          : (this.sqlite
              .prepare(`select id, length(cast(compact_history_json as blob))
                + length(cast(history_ref_json as blob)) as bytes
              from agent_history_cache where id > ? and id <= ? and formatter_version != ?`)
              .all(after, end, agentHistoryFormatterVersion) as Candidate[]);
        const statement = options.dryRun
          ? null
          : this.sqlite.prepare(
              events
                ? "delete from agent_events where id = ?"
                : "delete from agent_history_cache where id = ?",
            );
        for (const candidate of candidates) {
          statement?.run(candidate.id);
          counts.estimatedBytesFreed += candidate.bytes;
        }
        if (events) {
          counts.eventRows = candidates.length;
          cursor.afterEventId = end;
        } else {
          counts.cacheRows = candidates.length;
          cursor.afterCacheId = end;
        }
        this.sqlite.exec("commit");
        transaction = false;
        return {
          ...counts,
          complete:
            cursor.afterEventId >= cursor.maxEventId && cursor.afterCacheId >= cursor.maxCacheId,
          cursor,
        };
      } catch (error) {
        if (transaction) this.sqlite.exec("rollback");
        throw error;
      }
    });
  }
}

/** Finite high-water marks exclude new writes; yielding lets RPC and watches run. */
export async function runRetention(
  sqlite: DatabaseSync,
  options: {
    batchSize?: number;
    dryRun?: boolean;
    now?: number;
    onBatch?: (counts: RetentionCounts) => void;
    pauseMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<RetentionResult> {
  const store = new RetentionStore(sqlite);
  let cursor = store.begin(options.now);
  const result: RetentionResult = {
    ...emptyCounts(),
    batches: 0,
    cutoff: cursor.cutoff,
    complete: false,
    dryRun: options.dryRun ?? false,
  };
  while (!options.signal?.aborted) {
    const batch = store.batch(cursor, options);
    for (const key of Object.keys(emptyCounts()) as (keyof RetentionCounts)[]) {
      result[key] += batch[key];
    }
    result.batches++;
    result.complete = batch.complete;
    options.onBatch?.(batch);
    if (batch.complete || options.signal?.aborted) break;
    cursor = batch.cursor;
    await pause(options.pauseMs ?? 10);
  }
  return result;
}
