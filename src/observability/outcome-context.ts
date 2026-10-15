import type { CompactAgentHistory } from "@/observability/contracts.js";

/**
 * Outcome context (row 15.309): the context reading that rides on every
 * delivered agent outcome. It is a projection of the event's OWN append-time
 * compact history — the same immutable snapshot the excerpt comes from — so a
 * delayed or redelivered outcome reports the context as of its event, never a
 * live re-read and never "current at delivery".
 *
 * The figure is the existing per-call prompt occupancy from context-health
 * (Pi input+cacheRead+cacheWrite, Claude input+cache creation+cache read on
 * the manager lineage). Nothing here sums, estimates or guesses: a reading
 * that is not bound to the event's own agent session, not a finite count, or
 * already marked stale/unavailable upstream stays exactly that, with a reason.
 * The window is only what the health reading itself carries (Codex reports
 * one; Pi and Claude do not); no model name, catalog, planning target or
 * footer fills it, and the percentage is always derived from tokens/window.
 *
 * Correction F1–F4 (independent review of 6800e707): the event's worker
 * harness, the history source and the reading source must agree; a reading
 * dated after its event, or with an unknown time, is never current; supplied
 * percentages are never trusted; and the public object carries no transcript
 * path (binding uses the internal reading ref only).
 */
export type OutcomeContextState = "current" | "stale" | "unavailable";

/** reported: a coherent runtime window; unknown: none recorded; inconsistent: one was recorded but does not fit the reading. */
export type OutcomeContextWindowStatus = "reported" | "unknown" | "inconsistent";

export type OutcomeContext = {
  /**
   * Seconds from the reading to the event (event time minus reading time).
   * Null when either time is unknown; a reading after its event is refused.
   */
  ageSeconds: number | null;
  /** Always the event's own snapshot; never a delivery-time read. */
  basis: "event";
  eventAt: string | null;
  model: string | null;
  /** Derived from tokens/window (one decimal), only for a current reading with a reported window. */
  percent: number | null;
  reason: string | null;
  reportedAt: string | null;
  source: string | null;
  state: OutcomeContextState;
  tokens: number | null;
  window: number | null;
  windowStatus: OutcomeContextWindowStatus;
};

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
// Captures year, month, day, hour, minute, second, and an optional offset
// sign/hour/minute; the shape alone is not validity (see calendarValid).
const ISO =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
/** Upper bound for token counts and windows; anything larger is not a reading. */
const MAX_TOKENS = 1_000_000_000;
/** A supplied percentage may differ from tokens/window by one-decimal rounding only (plus float error). */
const PERCENT_TOLERANCE = 0.05 + 1e-9;

/** The history source each worker harness's own reader produces. */
const WORKER_SOURCE: Readonly<Record<string, string>> = {
  claude: "claude-jsonl",
  codex: "codex-jsonl",
  pi: "pi-jsonl",
};

function token(value: unknown): string | null {
  return typeof value === "string" && TOKEN.test(value) ? value : null;
}

/**
 * Date.parse normalizes impossible dates (2026-02-30 becomes March 2), so
 * every field is range-checked first: Gregorian month lengths and leap years,
 * 24-hour clock without leap seconds, and an offset within ±23:59. Offsets
 * and 1–9 fractional digits stay valid; the original string is kept.
 */
function calendarValid(match: RegExpExecArray): boolean {
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (days === undefined || day < 1 || day > days) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  return match[7] === undefined || (Number(match[8]) <= 23 && Number(match[9]) <= 59);
}

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ISO.exec(value);
  return match && calendarValid(match) && Number.isFinite(Date.parse(value)) ? value : null;
}

/** A positive bounded integer count; zero is no reading. */
function positive(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_TOKENS
    ? value
    : null;
}

function unavailable(
  reason: string,
  eventAt: string | null,
  extra: Partial<OutcomeContext> = {},
): OutcomeContext {
  return {
    ageSeconds: null,
    basis: "event",
    eventAt,
    model: null,
    percent: null,
    reportedAt: null,
    source: null,
    tokens: null,
    window: null,
    windowStatus: "unknown",
    ...extra,
    reason,
    state: "unavailable",
  };
}

/** The bound session's own file is the only source a reading may come from. */
function readingFromBoundFile(ref: string | null, path: string | undefined): boolean {
  return ref !== null && typeof path === "string" && path.length > 0 && ref.startsWith(`${path}#`);
}

function workerSource(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const agent = (payload as { agent?: unknown }).agent;
  if (typeof agent !== "string") return null;
  return Object.hasOwn(WORKER_SOURCE, agent.toLowerCase())
    ? (WORKER_SOURCE[agent.toLowerCase()] ?? null)
    : null;
}

export function projectOutcomeContext(event: {
  compactHistory: CompactAgentHistory | null | undefined;
  createdAt: Date | string | null | undefined;
  payload?: unknown;
}): OutcomeContext {
  const eventAt =
    event.createdAt instanceof Date
      ? Number.isFinite(event.createdAt.getTime())
        ? event.createdAt.toISOString()
        : null
      : iso(event.createdAt);
  const history = event.compactHistory ?? null;
  const health = history?.contextHealth ?? null;
  if (!history || !health) return unavailable("context_not_recorded_at_event", eventAt);
  const source = token(health.source);
  const model = token(health.model?.id ?? null);
  const historyRef = history.historyRef ?? null;
  const usage = health.usage;
  // Internal only: binds the reading to the session file; never published.
  const ref = typeof usage?.ref === "string" ? usage.ref : null;
  const base = { model, source };
  // Identity: only a reading from the event agent's own bound session counts.
  // A discovered-file fallback (latest file in the cwd) is not that agent.
  if (historyRef?.kind !== "agent_session") {
    return unavailable("history_not_session_bound", eventAt, base);
  }
  // F1: the event's worker harness, the bound history and the reading must be
  // the same source. A pane reused by another harness, or a cached history of
  // another reader, is refused rather than shown as this worker's context.
  const expected = workerSource(event.payload);
  if (expected === null) return unavailable("worker_harness_unknown", eventAt, base);
  if (
    health.source !== expected ||
    historyRef.source !== expected ||
    (history.source !== null && history.source !== undefined && history.source !== expected)
  ) {
    return unavailable("source_mismatch", eventAt, base);
  }
  if (!usage) return unavailable("context_not_recorded_at_event", eventAt, base);
  // A numeric reading must name its line in the bound file; a reading with no
  // ref cannot prove it came from this agent (an unavailable one carries none).
  if ((ref !== null || usage.tokens !== null) && !readingFromBoundFile(ref, historyRef.path)) {
    return unavailable("reading_not_from_bound_session", eventAt, base);
  }
  if (
    historyRef.path !== undefined &&
    historyRef.value !== historyRef.path &&
    health.sessionId !== null &&
    health.sessionId !== historyRef.value
  ) {
    return unavailable("session_mismatch", eventAt, base);
  }
  // A file whose entries carry more than one session id cannot prove which
  // session the reading belongs to, even when the last id matches.
  if (Array.isArray(health.limitations) && health.limitations.includes("session_id_varies")) {
    return unavailable("session_id_varies", eventAt, base);
  }
  const reportedAt = iso(usage.reportedAt);
  if (usage.kind === "unavailable" || usage.tokens === null) {
    return unavailable(token(usage.reason) ?? "no_usage_recorded", eventAt, base);
  }
  // F3: a reading is a positive bounded count; zero is no prompt.
  if (usage.tokens === 0) return unavailable("zero_usage_reported", eventAt, base);
  const tokens = positive(usage.tokens);
  if (tokens === null || (usage.kind !== "last_reported" && usage.kind !== "measured")) {
    return unavailable("invalid_reading", eventAt, base);
  }
  // F2: a reading dated after its event cannot describe that event.
  if (eventAt !== null && reportedAt !== null && Date.parse(reportedAt) > Date.parse(eventAt)) {
    return unavailable("reading_after_event", eventAt, { ...base, reportedAt });
  }
  // F3: a denominator only when the reading carries one that fits it; the
  // percentage is derived, and a disagreeing supplied value marks it unusable.
  let window: number | null = null;
  let windowStatus: OutcomeContextWindowStatus = "unknown";
  if (usage.window !== null && usage.window !== undefined) {
    const candidate = positive(usage.window);
    const derived = candidate === null ? null : (tokens / candidate) * 100;
    const supplied = usage.percent;
    const agrees =
      supplied === null ||
      supplied === undefined ||
      (typeof supplied === "number" &&
        Number.isFinite(supplied) &&
        derived !== null &&
        Math.abs(supplied - derived) <= PERCENT_TOLERANCE);
    if (candidate !== null && candidate >= tokens && agrees) {
      window = candidate;
      windowStatus = "reported";
    } else {
      windowStatus = "inconsistent";
    }
  }
  // F2: unknown times cannot prove the reading was current at the event.
  const upstreamFresh = usage.current === true && usage.reason === null;
  const fresh = upstreamFresh && eventAt !== null && reportedAt !== null;
  const reason = fresh
    ? null
    : !upstreamFresh
      ? (token(usage.reason) ?? "not_current")
      : eventAt === null
        ? "event_time_unknown"
        : "reading_time_unknown";
  const age =
    eventAt !== null && reportedAt !== null
      ? Math.floor((Date.parse(eventAt) - Date.parse(reportedAt)) / 1000)
      : null;
  return {
    ageSeconds: age !== null && Number.isSafeInteger(age) && age >= 0 ? age : null,
    basis: "event",
    eventAt,
    model,
    percent: fresh && window !== null ? Math.round((tokens / window) * 100 * 10) / 10 : null,
    reason,
    reportedAt,
    source,
    state: fresh ? "current" : "stale",
    tokens,
    window,
    windowStatus,
  };
}

/** Bounded human age: seconds, then minutes, then hours and minutes. */
function formatAge(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** The context line for a lease whose event snapshot is gone. */
export const SNAPSHOT_UNAVAILABLE_CONTEXT = "context: unavailable — snapshot_unavailable";

const INVALID_CONTEXT = "context: unavailable — context_invalid";
const NUMBER = new Intl.NumberFormat("en-US");

/**
 * The one bounded line every delivered outcome carries. The DTO is untrusted
 * (another daemon build may have produced it): counts must be positive and
 * bounded, a window must fit the tokens, the percentage is re-derived and a
 * disagreeing one refused, the age comes from the two timestamps, and a
 * reading after its event or a current reading without both times is
 * refused rather than shown.
 */
export function formatOutcomeContextLine(value: unknown): string {
  if (value === null || value === undefined) return "context: unavailable — context_not_provided";
  const context = value as Partial<OutcomeContext>;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    context.basis !== "event" ||
    (context.state !== "current" && context.state !== "stale" && context.state !== "unavailable")
  ) {
    return INVALID_CONTEXT;
  }
  const reason = token(context.reason) ?? "unknown";
  if (context.state === "unavailable") return `context: unavailable — ${reason}`;
  const count = positive(context.tokens);
  if (count === null) return "context: unavailable — invalid_reading";
  const at = iso(context.reportedAt);
  const event = iso(context.eventAt);
  if (at !== null && event !== null && Date.parse(at) > Date.parse(event)) return INVALID_CONTEXT;
  if (context.state === "current" && (at === null || event === null)) return INVALID_CONTEXT;
  let window: number | null = null;
  if (context.window !== null && context.window !== undefined) {
    window = positive(context.window);
    if (window === null || window < count || context.windowStatus === "inconsistent") {
      return INVALID_CONTEXT;
    }
  } else if (context.windowStatus === "reported") {
    return INVALID_CONTEXT;
  }
  let percent = "";
  if (context.percent !== null && context.percent !== undefined) {
    const derived = window === null ? null : (count / window) * 100;
    if (
      context.state !== "current" ||
      derived === null ||
      typeof context.percent !== "number" ||
      !Number.isFinite(context.percent) ||
      Math.abs(context.percent - derived) > PERCENT_TOLERANCE
    ) {
      return INVALID_CONTEXT;
    }
    percent = ` (${derived.toFixed(1)}%)`;
  }
  const tokens = NUMBER.format(count);
  const share =
    window !== null
      ? `${tokens} / ${NUMBER.format(window)} prompt tokens${percent}`
      : context.windowStatus === "inconsistent"
        ? `${tokens} prompt tokens (window inconsistent)`
        : `${tokens} prompt tokens (window unknown)`;
  const age =
    at !== null && event !== null ? Math.floor((Date.parse(event) - Date.parse(at)) / 1000) : null;
  const provenance = [
    at === null
      ? "reported time unknown"
      : age === null
        ? `reported ${at}`
        : `reported ${at} (${formatAge(age)} before event)`,
    event ? `as of event ${event}` : "as of event (time unknown)",
    token(context.model) ? `model ${context.model}` : null,
    token(context.source),
  ]
    .filter(Boolean)
    .join(" · ");
  return context.state === "current"
    ? `context: ${share} · ${provenance}`
    : `context: stale — ${reason}; last ${share} · ${provenance}`;
}
