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
 * The window is only what the health reading itself carries (today always
 * unknown); no model name, catalog, planning target or footer fills it.
 */
export type OutcomeContextState = "current" | "stale" | "unavailable";

export type OutcomeContext = {
  /**
   * Seconds from the reading to the event (event time minus reading time).
   * Null when either time is unknown or the reading claims to be later than
   * the event: no age is invented.
   */
  ageSeconds: number | null;
  /** Always the event's own snapshot; never a delivery-time read. */
  basis: "event";
  eventAt: string | null;
  model: string | null;
  percent: number | null;
  reason: string | null;
  ref: string | null;
  reportedAt: string | null;
  source: string | null;
  state: OutcomeContextState;
  tokens: number | null;
  window: number | null;
};

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function token(value: unknown): string | null {
  return typeof value === "string" && TOKEN.test(value) ? value : null;
}

function iso(value: unknown): string | null {
  return typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
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
    ref: null,
    reportedAt: null,
    source: null,
    tokens: null,
    window: null,
    ...extra,
    reason,
    state: "unavailable",
  };
}

/** The bound session's own file is the only source a reading may come from. */
function readingFromBoundFile(ref: string | null, path: string | undefined): boolean {
  return ref !== null && typeof path === "string" && path.length > 0 && ref.startsWith(`${path}#`);
}

export function projectOutcomeContext(event: {
  compactHistory: CompactAgentHistory | null | undefined;
  createdAt: Date | string | null | undefined;
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
  const ref = typeof usage?.ref === "string" ? usage.ref : null;
  const base = { model, source };
  // Identity: only a reading from the event agent's own bound session counts.
  // A discovered-file fallback (latest file in the cwd) is not that agent.
  if (historyRef?.kind !== "agent_session") {
    return unavailable("history_not_session_bound", eventAt, base);
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
  const tokens = count(usage.tokens);
  if (tokens === null || (usage.kind !== "last_reported" && usage.kind !== "measured")) {
    return unavailable("invalid_reading", eventAt, base);
  }
  // A denominator only when the reading itself carries one; never derived.
  const window = count(usage.window);
  const validWindow = window !== null && window > 0 ? window : null;
  const percent =
    validWindow !== null &&
    typeof usage.percent === "number" &&
    Number.isFinite(usage.percent) &&
    usage.percent >= 0
      ? usage.percent
      : null;
  const fresh = usage.current === true && usage.reason === null;
  const age =
    eventAt !== null && reportedAt !== null
      ? Math.floor((Date.parse(eventAt) - Date.parse(reportedAt)) / 1000)
      : null;
  return {
    ageSeconds: age !== null && Number.isSafeInteger(age) && age >= 0 ? age : null,
    basis: "event",
    eventAt,
    model,
    percent: fresh ? percent : null,
    reason: fresh ? null : (token(usage.reason) ?? "not_current"),
    ref,
    reportedAt,
    source,
    state: fresh ? "current" : "stale",
    tokens,
    window: validWindow,
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

const NUMBER = new Intl.NumberFormat("en-US");

/**
 * The one bounded line every delivered outcome carries. Renders only what the
 * DTO proves: no percent without an authoritative window, no fresh-looking
 * number for a stale reading, and an explicit reason when there is none.
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
    return "context: unavailable — context_invalid";
  }
  const reason = token(context.reason) ?? "unknown";
  if (context.state === "unavailable" || count(context.tokens) === null) {
    return `context: unavailable — ${context.state === "unavailable" ? reason : "invalid_reading"}`;
  }
  const tokens = NUMBER.format(context.tokens as number);
  const window = count(context.window);
  const at = iso(context.reportedAt) ?? "time unknown";
  const age = count(context.ageSeconds);
  const event = iso(context.eventAt);
  const share =
    window !== null && window > 0
      ? `${tokens} / ${NUMBER.format(window)} prompt tokens${
          context.state === "current" &&
          typeof context.percent === "number" &&
          Number.isFinite(context.percent)
            ? ` (${context.percent.toFixed(1)}%)`
            : ""
        }`
      : `${tokens} prompt tokens (window unknown)`;
  const provenance = [
    age === null ? `reported ${at}` : `reported ${at} (${formatAge(age)} before event)`,
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
