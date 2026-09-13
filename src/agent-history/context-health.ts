import type {
  AgentHistoryRef,
  ContextCompactionBoundary,
  ContextHealth,
  ContextUsageReading,
} from "@/observability/contracts.js";
import type { JsonlEntry } from "./readers.js";
import { messageRef, timestampFrom } from "./text.js";

/**
 * Context-health projection (RUN-20260913-06 D2/D4, ADDENDUM 1 D8–D10,
 * CORRECTION 2 D11–D12). Pure functions over already-parsed entries — no
 * I/O, no wall clock. The occupancy rule is the only honest one these
 * sources support: the context size at an assistant turn is the prompt
 * that call was billed for (Pi `input + cacheRead + cacheWrite`, Claude
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`),
 * read as a last_reported sample at that message's timestamp. Usage is
 * never summed across messages; a compaction or branch_summary entry's
 * `usage` is the summariser call, never a current reading. Unknown stays
 * unknown: null with a limitation code, never a manufactured 0%.
 *
 * Pi session files are a TREE: the active lineage is the parentId chain
 * from the last appended entry to the root, and everything is computed
 * over lineage entries only, in root→leaf order. A branch_summary anywhere
 * on that lineage marks the branch boundary (D11) — the marker persists
 * through later appends until a genuinely later assistant reading exists
 * on the lineage. Claude Code does not branch conversations in-file, so
 * Claude stays file order — with subagent (isSidechain) transcripts
 * skipped before any observation (D12): identity, branch, model,
 * boundaries, reading and source freshness all come from manager entries
 * only; a file of nothing but sidechain entries reports no_manager_entries.
 *
 * Staleness marker precedence when several apply:
 * post_compaction_no_turn > model_changed_since_reading >
 * later_turn_without_usage > branch_switched/branch_changed.
 */

const PI_LIMITATIONS = [
  "context_window_not_recorded",
  "compaction_outcome_not_recorded",
  // A /tree move records nothing until the next append re-roots the chain.
  "leaf_move_not_recorded_until_next_append",
];
const CLAUDE_LIMITATIONS = ["context_window_not_recorded", "claude_lineage_by_file_order"];

type UsageCandidate = {
  branch: string | null;
  modelId: string | null;
  position: number;
  ref: string;
  reportedAt: string | null;
  tokens: number;
};

type Boundary = ContextCompactionBoundary & { position: number };

type ModelChange = { position: number; timestamp: string | null };

type ModelObservation = {
  changedAt: string | null;
  id: string | null;
  lastChange: ModelChange | null;
  provider: string | null;
};

export function projectPiContextHealth(path: string, entries: JsonlEntry[]): ContextHealth {
  // F1: an empty file is empty, not broken — decide before any lineage
  // logic so "no entries" never degrades to lineage_unresolved.
  if (entries.length === 0) {
    return finish({
      boundaries: [],
      branch: null,
      limitations: [...PI_LIMITATIONS],
      model: { changedAt: null, id: null, lastChange: null, provider: null },
      sessionId: null,
      source: "pi-jsonl",
      sourceUpdatedAt: null,
      usage: unavailableUsage("no_usage_recorded"),
    });
  }
  const last = entries.at(-1) ?? null;
  const lineage = last ? activeLineage(last, indexById(entries)) : null;
  if (!last || !lineage) {
    // Broken chain (unknown parentId or cycle): the tree cannot be walked,
    // so usage and compaction honesty degrade to lineage_unresolved while
    // the file-order session/model facts still stand.
    const fallback = walkForSessionAndModel(entries);
    return finish({
      boundaries: [],
      branch: null,
      limitations: [...PI_LIMITATIONS, "lineage_unresolved"],
      model: fallback.model,
      sessionId: fallback.sessionId,
      source: "pi-jsonl",
      sourceUpdatedAt: latestTimestamp(entries),
      usage: unavailableUsage("lineage_unresolved"),
    });
  }

  const sessionId: string | null = headerSessionId(entries);
  const model: ModelObservation = { changedAt: null, id: null, lastChange: null, provider: null };

  const boundaries: Boundary[] = [];
  let reading: UsageCandidate | null = null;
  let lastAssistantPosition: number | null = null;
  let lastBranchSummaryPosition: number | null = null;

  lineage.forEach((entry, position) => {
    const type = stringField(entry.value.type);
    if (type === "model_change") {
      observeModel(
        model,
        entry.value.modelId,
        entry.value.provider,
        position,
        timestampFrom(entry.value.timestamp),
      );
      return;
    }
    if (type === "branch_summary") {
      // D11: any branch_summary on the active lineage marks the boundary —
      // not only one at the leaf — so later appends cannot resurrect the
      // pre-branch reading. Its own usage is never a current reading.
      lastBranchSummaryPosition = position;
      return;
    }
    if (type === "compaction") {
      // `usage` on this entry is the summariser call's own billing, and
      // `tokensBefore` is a pre-compaction figure — neither is a current
      // reading, so both are deliberately unread below.
      boundaries.push({
        durationMs: null,
        position,
        ref: messageRef(path, stringField(entry.value.id) ?? undefined, entry.line),
        timestamp: timestampFrom(entry.value.timestamp),
        tokensAfter: null,
        tokensBefore: finiteNonNegative(entry.value.tokensBefore),
        trigger: "unknown",
      });
      return;
    }
    if (type !== "message") return; // branch_summary usage is never a reading
    const message = recordField(entry.value.message);
    if (stringField(message.role) !== "assistant") return;
    // O3: the position is tracked whether or not this turn carried usage —
    // a later turn without usage still grew the context by an unknown amount.
    lastAssistantPosition = position;
    const timestamp = timestampFrom(entry.value.timestamp) ?? timestampFrom(message.timestamp);
    observeModel(model, message.model, message.provider, position, timestamp);
    const tokens = promptTokens(message.usage, ["input", "cacheRead", "cacheWrite"]);
    if (tokens === null) return;
    reading = {
      branch: null,
      modelId: stringField(message.model),
      position,
      ref: messageRef(path, stringField(entry.value.id) ?? undefined, entry.line),
      reportedAt: timestamp,
      tokens,
    };
  });

  const usage = usageReading({
    boundaries,
    branch: null,
    lastAssistantPosition,
    lastBranchSummaryPosition,
    lastModelChange: model.lastChange,
    reading,
  });
  const limitations = [...PI_LIMITATIONS];
  if (usage.reason === "post_compaction_no_turn") limitations.push(usage.reason);
  return finish({
    boundaries,
    branch: null,
    limitations,
    model,
    sessionId,
    source: "pi-jsonl",
    sourceUpdatedAt: latestTimestamp(entries),
    usage,
  });
}

export function projectClaudeContextHealth(path: string, entries: JsonlEntry[]): ContextHealth {
  // D12: a sidechain entry (isSidechain: true) belongs to the subagent
  // transcript. Skipping it before ANY observation keeps the session id,
  // branch, model, boundaries, reading and source freshness the manager's;
  // a file of nothing but sidechain entries reports no_manager_entries.
  const manager = entries.filter((entry) => entry.value.isSidechain !== true);
  const model: ModelObservation = { changedAt: null, id: null, lastChange: null, provider: null };
  const boundaries: Boundary[] = [];
  let reading: UsageCandidate | null = null;
  let lastAssistantPosition: number | null = null;
  let previousAssistantModel: string | null = null;
  let sessionId: string | null = null;
  let branch: string | null = null;
  const sessionIds = new Set<string>();

  manager.forEach((entry, position) => {
    const entrySessionId = stringField(entry.value.sessionId);
    if (entrySessionId) {
      sessionIds.add(entrySessionId);
      sessionId = entrySessionId;
    }
    branch = stringField(entry.value.gitBranch);
    const type = stringField(entry.value.type);
    if (type === "system" && stringField(entry.value.subtype) === "compact_boundary") {
      // A string compactMetadata still counts; its numerics degrade to null.
      const meta = recordField(entry.value.compactMetadata);
      boundaries.push({
        durationMs: finiteNonNegative(meta.durationMs),
        position,
        ref: messageRef(path, stringField(entry.value.uuid) ?? undefined, entry.line),
        timestamp: timestampFrom(entry.value.timestamp),
        tokensAfter: finiteNonNegative(meta.postTokens),
        tokensBefore: finiteNonNegative(meta.preTokens),
        trigger: compactionTrigger(meta.trigger),
      });
      return;
    }
    if (type !== "assistant") return;
    // O3: the position is tracked whether or not this entry carried usage.
    lastAssistantPosition = position;
    const message = recordField(entry.value.message);
    const timestamp = timestampFrom(entry.value.timestamp) ?? timestampFrom(message.timestamp);
    // Claude records no provider on the message; "anthropic" is not invented.
    const modelId = stringField(message.model);
    if (modelId !== null && previousAssistantModel !== null && modelId !== previousAssistantModel) {
      model.lastChange = { position, timestamp };
      model.changedAt = timestamp;
    }
    if (modelId !== null) {
      model.id = modelId;
      previousAssistantModel = modelId;
    }
    const tokens = promptTokens(message.usage, [
      "input_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ]);
    if (tokens === null) return;
    reading = {
      branch: stringField(entry.value.gitBranch),
      modelId,
      position,
      ref: messageRef(path, stringField(entry.value.uuid) ?? undefined, entry.line),
      reportedAt: timestamp,
      tokens,
    };
  });

  const usage = usageReading({
    boundaries,
    branch,
    lastAssistantPosition,
    lastBranchSummaryPosition: null,
    lastModelChange: model.lastChange,
    reading,
  });
  const limitations = [...CLAUDE_LIMITATIONS];
  if (manager.length === 0 && entries.length > 0) {
    limitations.push("no_manager_entries");
  } else if (sessionIds.size > 1) {
    limitations.push("session_id_varies");
  }
  return finish({
    boundaries,
    branch,
    limitations,
    model,
    sessionId,
    source: "claude-jsonl",
    sourceUpdatedAt: latestTimestamp(manager),
    usage,
  });
}

/** The reading + staleness rules of D4, with ADDENDUM D9's "any change". */
function usageReading(input: {
  boundaries: Boundary[];
  branch: string | null;
  lastAssistantPosition: number | null;
  lastBranchSummaryPosition: number | null;
  lastModelChange: ModelChange | null;
  reading: UsageCandidate | null;
}): ContextUsageReading {
  const reading = input.reading;
  if (reading === null) {
    return unavailableUsage(
      input.lastBranchSummaryPosition !== null ? "no_usage_on_active_lineage" : "no_usage_recorded",
    );
  }
  if (input.boundaries.some((boundary) => boundary.position > reading.position)) {
    return unavailableUsage("post_compaction_no_turn");
  }
  // D9: ANY model change after the reading invalidates it — A→B→A must not
  // slip through a final-model comparison.
  if (input.lastModelChange !== null && input.lastModelChange.position > reading.position) {
    return {
      ...unavailableUsage("model_changed_since_reading"),
      ref: reading.ref,
      reportedAt: reading.reportedAt,
    };
  }
  // A later assistant turn with no usable usage means the context grew by
  // an unknown amount: keep the tokens, but they no longer describe this
  // turn. (Precedence: below compaction and model change, above branch
  // markers — see the module comment.)
  if (input.lastAssistantPosition !== null && input.lastAssistantPosition > reading.position) {
    return {
      current: false,
      kind: "last_reported",
      percent: null,
      reason: "later_turn_without_usage",
      ref: reading.ref,
      reportedAt: reading.reportedAt,
      tokens: reading.tokens,
      window: null,
    };
  }
  // current:false markers keep the tokens but say why the reading may no
  // longer describe this turn: a branch boundary later on the lineage than
  // the reading (D11 — it persists until a genuinely later assistant
  // reading) or a git branch change (D4, Claude only).
  let marker: string | null =
    input.lastBranchSummaryPosition !== null && input.lastBranchSummaryPosition > reading.position
      ? "branch_switched_since_reading"
      : null;
  if (
    marker === null &&
    reading.branch !== null &&
    input.branch !== null &&
    input.branch !== reading.branch
  ) {
    marker = "branch_changed_since_reading";
  }
  return {
    current: marker === null,
    kind: "last_reported",
    percent: null,
    reason: marker,
    ref: reading.ref,
    reportedAt: reading.reportedAt,
    tokens: reading.tokens,
    window: null,
  };
}

function finish(input: {
  boundaries: Boundary[];
  branch: string | null;
  limitations: string[];
  model: ModelObservation;
  sessionId: string | null;
  source: AgentHistoryRef["source"];
  sourceUpdatedAt: string | null;
  usage: ContextUsageReading;
}): ContextHealth {
  const lastBoundary = input.boundaries.at(-1) ?? null;
  return {
    branch: input.branch,
    compactionCount: input.boundaries.length,
    lastCompaction: lastBoundary ? boundaryWithoutPosition(lastBoundary) : null,
    limitations: input.limitations,
    model:
      input.model.id === null
        ? null
        : { changedAt: input.model.changedAt, id: input.model.id, provider: input.model.provider },
    sessionId: input.sessionId,
    source: input.source,
    sourceUpdatedAt: input.sourceUpdatedAt,
    usage: input.usage,
  };
}

function unavailableUsage(reason: string): ContextUsageReading {
  return {
    // A reading that does not exist is never current (S1).
    current: false,
    kind: "unavailable",
    percent: null,
    reason,
    ref: null,
    reportedAt: null,
    tokens: null,
    window: null,
  };
}

/** The header entry's id: the first `type: "session"` entry in file order. */
function headerSessionId(entries: JsonlEntry[]): string | null {
  for (const entry of entries) {
    if (stringField(entry.value.type) === "session") return stringField(entry.value.id);
  }
  return null;
}

/** The parentId chain from the leaf to the root, in root→leaf order; null when broken. */
function activeLineage(leaf: JsonlEntry, byId: Map<string, JsonlEntry>): JsonlEntry[] | null {
  const chain: JsonlEntry[] = [leaf];
  const visited = new Set<string>();
  let current = leaf;
  for (;;) {
    const parentId = stringField(current.value.parentId);
    if (!parentId) break;
    if (visited.has(parentId)) return null; // cycle
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return null; // dangling parentId
    chain.push(parent);
    current = parent;
  }
  return chain.reverse();
}

function indexById(entries: JsonlEntry[]): Map<string, JsonlEntry> {
  const byId = new Map<string, JsonlEntry>();
  for (const entry of entries) {
    const id = stringField(entry.value.id);
    if (id && !byId.has(id)) byId.set(id, entry);
  }
  return byId;
}

function walkForSessionAndModel(entries: JsonlEntry[]): {
  model: ModelObservation;
  sessionId: string | null;
} {
  let sessionId: string | null = null;
  const model: ModelObservation = { changedAt: null, id: null, lastChange: null, provider: null };
  entries.forEach((entry, position) => {
    const type = stringField(entry.value.type);
    if (type === "session") {
      sessionId = stringField(entry.value.id) ?? sessionId;
      return;
    }
    if (type === "model_change") {
      observeModel(
        model,
        entry.value.modelId,
        entry.value.provider,
        position,
        timestampFrom(entry.value.timestamp),
      );
      return;
    }
    if (type !== "message") return;
    const message = recordField(entry.value.message);
    if (stringField(message.role) !== "assistant") return;
    observeModel(
      model,
      message.model,
      message.provider,
      position,
      timestampFrom(entry.value.timestamp) ?? timestampFrom(message.timestamp),
    );
  });
  return { model, sessionId };
}

function observeModel(
  model: ModelObservation,
  id: unknown,
  provider: unknown,
  position: number,
  timestamp: string | null,
): void {
  const modelId = stringField(id);
  if (!modelId) return;
  if (model.id !== null && model.id !== modelId) {
    model.lastChange = { position, timestamp };
    model.changedAt = timestamp;
  }
  model.id = modelId;
  model.provider = stringField(provider);
}

function compactionTrigger(value: unknown): ContextCompactionBoundary["trigger"] {
  const trigger = stringField(value);
  if (trigger === "manual" || trigger === "auto") return trigger;
  return "unknown";
}

/** Sum of the billing fields; null when no usage is recorded — a sum of 0 is no usage. */
function promptTokens(usage: unknown, fields: string[]): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  let sum = 0;
  for (const field of fields) {
    const value = finiteNonNegative(record[field]);
    if (value === null) continue;
    sum += value;
  }
  return sum > 0 ? sum : null;
}

function boundaryWithoutPosition(boundary: Boundary): ContextCompactionBoundary {
  return {
    durationMs: boundary.durationMs,
    ref: boundary.ref,
    timestamp: boundary.timestamp,
    tokensAfter: boundary.tokensAfter,
    tokensBefore: boundary.tokensBefore,
    trigger: boundary.trigger,
  };
}

function latestTimestamp(entries: JsonlEntry[]): string | null {
  let latest: string | null = null;
  for (const entry of entries) {
    const timestamp = timestampFrom(entry.value.timestamp);
    if (timestamp && (!latest || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordField(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
