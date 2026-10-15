import type { ContextHealth } from "@/observability/contracts.js";
import type { JsonlEntry } from "./readers.js";
import { messageRef, timestampFrom } from "./text.js";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? timestampFrom(value) : null;
}

/** Codex's last_token_usage.input_tokens includes cached_input_tokens. The latter
 * is a subset, not an additional occupancy charge. total_token_usage is lifetime
 * billing, never a context fill reading.
 *
 * Row 15.309 S3, from real rollout structure: every turn ends with a
 * token_count immediately followed by task_complete, so task_complete settles
 * the reading and only task_started opens a later turn. A compaction writes a
 * top-level `compacted` record and then a token_count with all-zero usage; zero
 * input is no prompt, so neither the zero nor the pre-compaction figure is a
 * reading until a later positive token_count. */
export function projectCodexContextHealth(path: string, entries: JsonlEntry[]): ContextHealth {
  let sessionId: string | null = null;
  let conflictingSessions = false;
  let modelId: string | null = null;
  let changedAt: string | null = null;
  let sourceUpdatedAt: string | null = null;
  let reading: { tokens: number; window: number; model: string; at: string; ref: string } | null =
    null;
  let reason = "no_usage_recorded";
  let laterTurn = false;
  let compactionCount = 0;
  let lastCompaction: ContextHealth["lastCompaction"] = null;
  let compactedSinceReading = false;

  for (const entry of entries) {
    const timestamp = isoTimestamp(entry.value.timestamp);
    if (timestamp) sourceUpdatedAt = timestamp;
    const payload = object(entry.value.payload);
    if (entry.value.type === "session_meta") {
      const id = text(payload?.id);
      if (id && sessionId && sessionId !== id) conflictingSessions = true;
      if (id) sessionId = id;
    }
    if (entry.value.type === "turn_context") {
      const next = text(payload?.model);
      if (next && modelId && next !== modelId) changedAt = timestamp;
      if (next) modelId = next;
    }
    if (entry.value.type === "compacted") {
      // Boundary only: Codex records no token figure for the compacted window.
      compactionCount += 1;
      lastCompaction = {
        durationMs: null,
        ref: messageRef(path, undefined, entry.line),
        timestamp,
        tokensAfter: null,
        tokensBefore: null,
        trigger: "unknown",
      };
      reading = null;
      reason = "post_compaction_no_turn";
      laterTurn = false;
      compactedSinceReading = true;
      continue;
    }
    if (entry.value.type !== "event_msg") continue;
    if (payload?.type === "task_started") laterTurn = true;
    if (payload?.type !== "token_count") continue;
    // The latest token_count supersedes earlier samples even when malformed:
    // falling back to an older value would claim a stale reading is current.
    reading = null;
    reason = "incomplete_token_count";
    laterTurn = false;
    const info = object(payload.info);
    const usage = object(info?.last_token_usage);
    const tokens = count(usage?.input_tokens);
    const cached = count(usage?.cached_input_tokens);
    const window = count(info?.model_context_window);
    if (tokens === 0) {
      reason = compactedSinceReading ? "post_compaction_no_turn" : "zero_usage_reported";
      continue;
    }
    if (
      tokens === null ||
      window === null ||
      window === 0 ||
      (cached !== null && cached > tokens) ||
      !timestamp ||
      !modelId ||
      !sessionId ||
      conflictingSessions
    )
      continue;
    compactedSinceReading = false;
    reading = {
      tokens,
      window,
      model: modelId,
      at: timestamp,
      ref: messageRef(path, undefined, entry.line),
    };
  }
  const valid = reading !== null && reading.model === modelId && !laterTurn && !conflictingSessions;
  return {
    branch: null,
    compactionCount,
    lastCompaction,
    limitations: ["compaction_outcome_not_recorded"],
    model: modelId === null ? null : { changedAt, id: modelId, provider: null },
    sessionId: conflictingSessions ? null : sessionId,
    source: "codex-jsonl",
    sourceUpdatedAt,
    usage:
      valid && reading
        ? {
            current: true,
            kind: "last_reported",
            percent: (reading.tokens / reading.window) * 100,
            reason: null,
            ref: reading.ref,
            reportedAt: reading.at,
            tokens: reading.tokens,
            window: reading.window,
          }
        : {
            current: false,
            kind: "unavailable",
            percent: null,
            reason: conflictingSessions
              ? "session_id_varies"
              : reading
                ? laterTurn
                  ? "later_turn_without_usage"
                  : "model_changed_since_reading"
                : reason,
            ref: null,
            reportedAt: null,
            tokens: null,
            window: null,
          },
  };
}
