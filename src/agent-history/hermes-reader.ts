import { DatabaseSync } from "node:sqlite";
import type { AgentHistoryMessage, AgentHistoryRef } from "@/observability/contracts.js";
import { type AgentHistoryReader, compactFromMessages, limitMessages } from "./readers.js";
import { messageRef, textFromContent, timestampFrom } from "./text.js";
import { compactToolResult } from "./tool-compaction.js";

/**
 * Reads conversation history from Hermes' durable store at
 * `${HERMES_HOME:-~/.hermes}/state.db`.
 *
 * Three properties of that schema drive this implementation:
 *
 * - `messages.timestamp` is a REAL unix epoch in *seconds*, not milliseconds.
 *   Passing it to `timestampFrom` unscaled dates every message to 1970.
 *
 * - `messages.active` partitions a session's live context window from history
 *   that compaction has folded away: `active = 1` is exactly complementary to
 *   `compacted = 1`, and the active count equals `sessions.message_count`.
 *   Reading anything else would resurrect content the agent itself no longer
 *   sees, and inflate the message count.
 *
 * - Many sessions share one cwd (92 for `/Users/ray/dev/driffs` on this
 *   machine), so a session id is the only safe selector. This reader never
 *   infers one; it requires `ref.value` and returns nothing without it.
 *
 * Only the `messages` table is touched. `sessions.system_prompt`,
 * `reasoning`, `reasoning_content` and archived/hidden rows are never read.
 */

type HermesRow = {
  content: string | null;
  finish_reason: string | null;
  id: number;
  role: string | null;
  timestamp: number | null;
  tool_name: string | null;
};

/** Hermes stores epoch seconds; the shared helpers expect milliseconds. */
function hermesTimestamp(seconds: number | null): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return timestampFrom(Math.round(seconds * 1000));
}

export class HermesHistoryReader implements AgentHistoryReader {
  canRead(ref: AgentHistoryRef): boolean {
    return ref.source === "hermes-sqlite" && Boolean(ref.path) && Boolean(ref.value);
  }

  async read(
    ref: AgentHistoryRef,
    options: { limit?: number } = {},
  ): Promise<AgentHistoryMessage[]> {
    const dbPath = ref.path;
    // Fail closed. Without an exact session id there is no safe fallback:
    // cwd is not unique across Hermes sessions.
    if (!dbPath || !ref.value) return [];

    let sqlite: DatabaseSync | null = null;
    try {
      sqlite = new DatabaseSync(dbPath, { readOnly: true });
      const rows = sqlite
        .prepare(`
          select
            id,
            role,
            content,
            tool_name,
            finish_reason,
            timestamp
          from messages
          where session_id = ? and active = 1
          order by id asc
        `)
        .all(ref.value) as unknown as HermesRow[];

      const messages: AgentHistoryMessage[] = [];
      for (const row of rows) {
        const timestamp = hermesTimestamp(row.timestamp);
        const refValue = messageRef(dbPath, String(row.id), 0);

        if (row.role === "user" || row.role === "assistant") {
          const text = textFromContent(row.content);
          // Assistant rows that only carry tool_calls have empty content.
          // They are turn scaffolding, not a message anyone said.
          if (!text) continue;
          messages.push({ ref: refValue, role: row.role, text, timestamp });
          continue;
        }

        if (row.role === "tool") {
          const toolName = row.tool_name ?? "unknown";
          const text = row.content ?? "";
          const compact = compactToolResult({
            isError: isToolError(row.content),
            ref: refValue,
            text,
            toolName,
          });
          messages.push({
            compact,
            ref: refValue,
            role: "tool_result",
            text: compact.text,
            timestamp,
            toolName,
          });
        }
        // Any other role (system and friends) is deliberately dropped.
      }

      return limitMessages(messages, options.limit);
    } catch {
      // A busy or WAL-locked database must degrade to "no update", never
      // take the daemon down with it.
      return [];
    } finally {
      sqlite?.close();
    }
  }

  async readCompact(ref: AgentHistoryRef) {
    return compactFromMessages(ref, await this.read(ref));
  }
}

/**
 * Hermes tool results are JSON envelopes whose failure shape varies by tool:
 * `error` (terminal, process), `exit_code` (terminal), `status` (process).
 * A non-JSON payload is treated as success — absence of evidence only.
 */
function isToolError(content: string | null): boolean {
  if (!content) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const record = parsed as Record<string, unknown>;

  if (typeof record.error === "string" && record.error.length > 0) return true;
  if (typeof record.exit_code === "number" && record.exit_code !== 0) return true;
  const status = record.status;
  if (typeof status === "string" && (status === "error" || status === "not_found")) return true;
  return false;
}

/**
 * Session-scoped change token.
 *
 * The service fingerprints a history source by file mtime/size, which for a
 * shared SQLite file changes whenever *any* session writes. This gives a
 * revision that moves only when the requested session does, so callers can
 * tell a real advance from unrelated traffic.
 */
export function hermesSessionRevision(dbPath: string, sessionId: string): string | null {
  let sqlite: DatabaseSync | null = null;
  try {
    sqlite = new DatabaseSync(dbPath, { readOnly: true });
    const row = sqlite
      .prepare(`
        select
          coalesce(max(id), 0) as max_id,
          count(*) as active_count
        from messages
        where session_id = ? and active = 1
      `)
      .get(sessionId) as unknown as { active_count: number; max_id: number } | undefined;
    if (!row) return null;
    return `${row.max_id}:${row.active_count}`;
  } catch {
    return null;
  } finally {
    sqlite?.close();
  }
}
