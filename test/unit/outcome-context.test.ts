import { afterEach, describe, expect, test, vi } from "vitest";
import { projectCodexContextHealth } from "@/agent-history/codex-context.js";
import {
  projectClaudeContextHealth,
  projectPiContextHealth,
} from "@/agent-history/context-health.js";
import type { JsonlEntry } from "@/agent-history/readers.js";
import { formatHookContext, type LeasedObligation } from "@/cli/claude-hook.js";
import type {
  AgentHistoryRef,
  CompactAgentHistory,
  ContextHealth,
} from "@/observability/contracts.js";
import {
  formatOutcomeContextLine,
  projectOutcomeContext,
} from "@/observability/outcome-context.js";
import { projectInboxOutcome } from "@/observability/profile-delivery-service.js";
import {
  formatAgentOutcomeUpdates,
  formatProfileObligationUpdates,
  formatOutcomeContextLine as piFormatOutcomeContextLine,
  projectAgentOutcomes,
} from "../../packages/shepy-pi/src/wake.js";

// Row 15.309 qualification table. Every case drives the REAL per-call
// projection (context-health) over synthetic JSONL entries, then the real
// outcome projection and all three delivery renderers. Fixtures are local and
// private; no live daemon, session file or native capture is read.

const PI_PATH = "/fixture/pi/session-a.jsonl";
const CLAUDE_PATH = "/fixture/claude/session-c1.jsonl";
const EVENT_AT = new Date("2026-10-15T09:00:00.000Z");

function entry(line: number, value: unknown): JsonlEntry {
  return { line, value: value as Record<string, unknown> };
}

function piAssistant(
  id: string,
  parentId: string | null,
  at: string,
  usage: unknown,
  model = "gpt-6-luna",
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: at,
    message: {
      role: "assistant",
      provider: "openai-codex",
      model,
      content: [{ type: "text", text: `reply ${id}` }],
      ...(usage ? { usage: { output: 900, reasoning: 0, ...(usage as object) } } : {}),
    },
  };
}

const PI_HEADER = {
  type: "session",
  version: 3,
  id: "pi-a",
  timestamp: "2026-10-15T08:00:00.000Z",
  cwd: "/repo",
};
// Two per-call readings: the newest (300 210) is the context, never the sum (301 360).
const PI_BASE = [
  entry(1, PI_HEADER),
  entry(
    2,
    piAssistant("m1", null, "2026-10-15T08:10:00.000Z", {
      input: 100,
      cacheRead: 1000,
      cacheWrite: 50,
    }),
  ),
  entry(
    3,
    piAssistant("m2", "m1", "2026-10-15T08:20:00.000Z", {
      input: 200,
      cacheRead: 300000,
      cacheWrite: 10,
    }),
  ),
];

function claudeAssistant(
  uuid: string,
  at: string,
  usage: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    sessionId: "c1",
    timestamp: at,
    gitBranch: "main",
    cwd: "/repo",
    type: "assistant",
    uuid,
    message: {
      model: "claude-fable-5-1",
      content: [{ type: "text", text: `reply ${uuid}` }],
      ...(usage ? { usage: { output_tokens: 571, ...(usage as object) } } : {}),
    },
    ...extra,
  };
}

const CLAUDE_BASE = [
  entry(
    1,
    claudeAssistant("u1", "2026-10-15T08:30:00.000Z", {
      input_tokens: 10,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 50000,
    }),
  ),
  // A subagent (sidechain) call is never the manager's context.
  entry(
    2,
    claudeAssistant(
      "s1",
      "2026-10-15T08:31:00.000Z",
      { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 900000 },
      { isSidechain: true },
    ),
  ),
];

const piRef: AgentHistoryRef = {
  kind: "agent_session",
  path: PI_PATH,
  source: "pi-jsonl",
  value: PI_PATH,
};
const claudeRef: AgentHistoryRef = {
  kind: "agent_session",
  path: CLAUDE_PATH,
  source: "claude-jsonl",
  value: "c1",
};

function history(
  health: ContextHealth | null,
  historyRef: AgentHistoryRef | null,
  text = "done: report written",
): CompactAgentHistory {
  return {
    contextHealth: health,
    historyRef,
    lastAssistantMessage: {
      ref: `${historyRef?.path ?? "/x"}#entry=last`,
      text,
      timestamp: "2026-10-15T08:59:00.000Z",
    },
    lastToolResult: null,
    lastUserMessage: null,
    messageCount: 3,
    source: historyRef?.source ?? null,
    updatedAt: null,
  };
}

const AGENT_OF: Record<string, string> = {
  "claude-jsonl": "claude",
  "codex-jsonl": "codex",
  "pi-jsonl": "pi",
};
/** An event whose recorded worker harness is the bound history's own (the normal append). */
function project(event: {
  compactHistory: CompactAgentHistory | null;
  createdAt: Date | string | null;
}) {
  const agent = AGENT_OF[event.compactHistory?.historyRef?.source ?? ""] ?? "pi";
  return projectOutcomeContext({ ...event, payload: { agent } });
}

const pi = (entries: JsonlEntry[], ref: AgentHistoryRef | null = piRef) =>
  project({
    compactHistory: history(projectPiContextHealth(PI_PATH, entries), ref),
    createdAt: EVENT_AT,
  });
const claude = (entries: JsonlEntry[], ref: AgentHistoryRef | null = claudeRef) =>
  project({
    compactHistory: history(projectClaudeContextHealth(CLAUDE_PATH, entries), ref),
    createdAt: EVENT_AT,
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("projectOutcomeContext: correctly bound per-call occupancy", () => {
  test("Pi: newest per-call prompt occupancy, current at the event, window unknown", () => {
    const context = pi(PI_BASE);
    expect(context).toMatchObject({
      ageSeconds: 2400,
      basis: "event",
      state: "current",
      tokens: 300210,
      window: null,
      percent: null,
      reason: null,
      model: "gpt-6-luna",
      source: "pi-jsonl",
      reportedAt: "2026-10-15T08:20:00.000Z",
      eventAt: "2026-10-15T09:00:00.000Z",
    });
    const line = formatOutcomeContextLine(context);
    expect(line).toBe(
      "context: 300,210 prompt tokens (window unknown) · reported 2026-10-15T08:20:00.000Z (40m before event) · as of event 2026-10-15T09:00:00.000Z · model gpt-6-luna · pi-jsonl",
    );
    // Never the session sum, never output tokens, never a manufactured percent.
    expect(line).not.toContain("301,360");
    expect(line).not.toContain("%");
  });

  test("Claude: manager per-call occupancy; sidechain usage never counts", () => {
    const context = claude(CLAUDE_BASE);
    expect(context).toMatchObject({
      state: "current",
      tokens: 52010,
      model: "claude-fable-5-1",
      source: "claude-jsonl",
    });
    expect(formatOutcomeContextLine(context)).not.toContain("900,");
  });

  test("post-compaction before the next turn is unavailable: old tokens are never resurrected", () => {
    const compacted = [
      ...PI_BASE,
      entry(4, {
        type: "compaction",
        id: "k1",
        parentId: "m2",
        timestamp: "2026-10-15T08:40:00.000Z",
        firstKeptEntryId: "m2",
        tokensBefore: 311646,
        usage: { input: 4242 },
        fromHook: false,
      }),
    ];
    const context = pi(compacted);
    expect(context).toMatchObject({
      state: "unavailable",
      reason: "post_compaction_no_turn",
      tokens: null,
    });
    const line = formatOutcomeContextLine(context);
    expect(line).toBe("context: unavailable — post_compaction_no_turn");
    for (const leak of ["300,210", "311,646", "4,242"]) expect(line).not.toContain(leak);
  });

  test("Claude compaction boundary also invalidates until a new reading", () => {
    const compacted = [
      ...CLAUDE_BASE,
      entry(3, {
        sessionId: "c1",
        timestamp: "2026-10-15T08:40:00.000Z",
        gitBranch: "main",
        type: "system",
        subtype: "compact_boundary",
        uuid: "b1",
        compactMetadata: { trigger: "auto", preTokens: 160000 },
      }),
    ];
    expect(formatOutcomeContextLine(claude(compacted))).toBe(
      "context: unavailable — post_compaction_no_turn",
    );
    // An actual new reading after the boundary is current again.
    const after = [
      ...compacted,
      entry(
        4,
        claudeAssistant("u2", "2026-10-15T08:45:00.000Z", {
          input_tokens: 5,
          cache_creation_input_tokens: 9000,
          cache_read_input_tokens: 0,
        }),
      ),
    ];
    expect(claude(after)).toMatchObject({ state: "current", tokens: 9005 });
  });

  test("model change after the reading is unavailable", () => {
    const changed = [
      ...PI_BASE,
      entry(4, {
        type: "model_change",
        id: "mc",
        parentId: "m2",
        timestamp: "2026-10-15T08:41:00.000Z",
        provider: "openai-codex",
        modelId: "gpt-6-sol",
      }),
    ];
    expect(pi(changed)).toMatchObject({
      state: "unavailable",
      reason: "model_changed_since_reading",
      tokens: null,
    });
  });

  test("a later assistant without usage keeps the number but says it is stale", () => {
    const later = [...PI_BASE, entry(4, piAssistant("m3", "m2", "2026-10-15T08:50:00.000Z", null))];
    const context = pi(later);
    expect(context).toMatchObject({
      state: "stale",
      reason: "later_turn_without_usage",
      tokens: 300210,
    });
    expect(formatOutcomeContextLine(context)).toBe(
      "context: stale — later_turn_without_usage; last 300,210 prompt tokens (window unknown) · reported 2026-10-15T08:20:00.000Z (40m before event) · as of event 2026-10-15T09:00:00.000Z · model gpt-6-luna · pi-jsonl",
    );
  });

  test("Claude git branch change marks the reading stale", () => {
    const branched = [
      ...CLAUDE_BASE,
      entry(3, {
        sessionId: "c1",
        timestamp: "2026-10-15T08:50:00.000Z",
        gitBranch: "feature",
        type: "user",
        uuid: "q2",
        message: { role: "user", content: "next" },
      }),
    ];
    expect(claude(branched)).toMatchObject({
      state: "stale",
      reason: "branch_changed_since_reading",
      tokens: 52010,
    });
  });

  test("no usage on any call is unavailable with the recorded reason", () => {
    expect(
      claude([entry(1, claudeAssistant("u1", "2026-10-15T08:30:00.000Z", null))]),
    ).toMatchObject({ state: "unavailable", reason: "no_usage_recorded" });
  });
});

describe("projectOutcomeContext: identity binding and honest absence", () => {
  test("a discovered-file fallback (latest file in the cwd) is not the event agent", () => {
    const fallback: AgentHistoryRef = {
      kind: "discovered_file",
      path: PI_PATH,
      source: "pi-jsonl",
      value: PI_PATH,
    };
    expect(pi(PI_BASE, fallback)).toMatchObject({
      state: "unavailable",
      reason: "history_not_session_bound",
      tokens: null,
    });
  });

  test("a reading from another file than the bound session is refused", () => {
    const other: AgentHistoryRef = {
      ...piRef,
      path: "/fixture/pi/other.jsonl",
      value: "/fixture/pi/other.jsonl",
    };
    expect(pi(PI_BASE, other)).toMatchObject({
      state: "unavailable",
      reason: "reading_not_from_bound_session",
    });
  });

  test("a numeric reading without a ref cannot prove its session and is refused", () => {
    const health = projectPiContextHealth(PI_PATH, PI_BASE);
    expect(
      project({
        compactHistory: history({ ...health, usage: { ...health.usage, ref: null } }, piRef),
        createdAt: EVENT_AT,
      }),
    ).toMatchObject({
      state: "unavailable",
      reason: "reading_not_from_bound_session",
      tokens: null,
    });
  });

  test("Claude native session id must equal the event's bound session", () => {
    expect(claude(CLAUDE_BASE, { ...claudeRef, value: "c-other" })).toMatchObject({
      state: "unavailable",
      reason: "session_mismatch",
      tokens: null,
    });
  });

  test("an event recorded without history or without context health says so", () => {
    expect(project({ compactHistory: null, createdAt: EVENT_AT })).toMatchObject({
      state: "unavailable",
      reason: "context_not_recorded_at_event",
    });
    expect(project({ compactHistory: history(null, piRef), createdAt: EVENT_AT })).toMatchObject({
      state: "unavailable",
      reason: "context_not_recorded_at_event",
    });
  });

  test("non-finite, negative or fractional counts are invalid, never rounded", () => {
    const health = projectPiContextHealth(PI_PATH, PI_BASE);
    for (const tokens of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      const context = project({
        compactHistory: history({ ...health, usage: { ...health.usage, tokens } }, piRef),
        createdAt: EVENT_AT,
      });
      expect(context).toMatchObject({
        state: "unavailable",
        reason: "invalid_reading",
        tokens: null,
      });
    }
  });

  test("a percent renders only with an authoritative positive window on a current reading", () => {
    const health = projectPiContextHealth(PI_PATH, PI_BASE);
    const withWindow = {
      ...health,
      usage: { ...health.usage, percent: 30.021, window: 1_000_000 },
    };
    const current = project({
      compactHistory: history(withWindow, piRef),
      createdAt: EVENT_AT,
    });
    expect(formatOutcomeContextLine(current)).toContain(
      "300,210 / 1,000,000 prompt tokens (30.0%)",
    );
    const zeroWindow = project({
      compactHistory: history(
        { ...health, usage: { ...health.usage, percent: 50, window: 0 } },
        piRef,
      ),
      createdAt: EVENT_AT,
    });
    expect(zeroWindow).toMatchObject({ window: null, windowStatus: "inconsistent", percent: null });
    expect(formatOutcomeContextLine(zeroWindow)).toContain("(window inconsistent)");
    expect(formatOutcomeContextLine(zeroWindow)).not.toContain("%");
    const stale = project({
      compactHistory: history(
        {
          ...withWindow,
          usage: { ...withWindow.usage, current: false, reason: "later_turn_without_usage" },
        },
        piRef,
      ),
      createdAt: EVENT_AT,
    });
    expect(formatOutcomeContextLine(stale)).not.toContain("%");
  });

  test("the line is event-attached: a delayed delivery never relabels it as current-at-delivery", () => {
    const context = pi(PI_BASE);
    const early = formatOutcomeContextLine(context);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
    expect(formatOutcomeContextLine(context)).toBe(early);
    expect(
      formatOutcomeContextLine(
        project({
          compactHistory: history(projectPiContextHealth(PI_PATH, PI_BASE), piRef),
          createdAt: EVENT_AT,
        }),
      ),
    ).toBe(early);
    expect(early).toContain("as of event 2026-10-15T09:00:00.000Z");
    expect(early).not.toContain("2026-10-16");
  });

  test("absent or malformed DTOs render an explicit reason; both renderers agree byte-for-byte", () => {
    const cases: unknown[] = [
      undefined,
      null,
      {},
      [],
      "context",
      { basis: "event", state: "current", tokens: "5" },
      {
        basis: "event",
        state: "current",
        tokens: 5,
        reportedAt: "yesterday",
        eventAt: null,
        model: "x y",
        source: "\u001b[31m",
        window: null,
        percent: 99,
        reason: null,
      },
      { basis: "event", state: "unavailable", reason: "\u001b]0;evil" },
      pi(PI_BASE),
      claude(CLAUDE_BASE),
      pi([...PI_BASE, entry(4, piAssistant("m3", "m2", "2026-10-15T08:50:00.000Z", null))]),
    ];
    expect(formatOutcomeContextLine(undefined)).toBe("context: unavailable — context_not_provided");
    expect(formatOutcomeContextLine({})).toBe("context: unavailable — context_invalid");
    expect(formatOutcomeContextLine(cases[5])).toBe("context: unavailable — invalid_reading");
    for (const value of cases) {
      const line = formatOutcomeContextLine(value);
      expect(piFormatOutcomeContextLine(value)).toBe(line);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no control byte reaches a wake.
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(line.length).toBeLessThan(400);
    }
  });
});

describe("Claude hook short outcome notices", () => {
  const bound = history(projectPiContextHealth(PI_PATH, PI_BASE), piRef, "x".repeat(5_000));
  const record = (id: number, type: string, from = "working") => ({
    agentId: "agent-a",
    compactHistory: bound,
    createdAt: EVENT_AT,
    herdrSessionName: "default",
    id,
    paneId: "wA:p1",
    payload: { agent: "pi", from, name: "worker-a", to: type === "agent.done" ? "done" : "idle" },
    terminalId: "term_a",
    type: type as "agent.done",
    workspaceId: "wA",
  });
  const line300 = "context: 300,210 prompt tokens (window unknown)";

  test("generic Pi wake: done and idle, truncated excerpt, redelivered duplicate, old daemon", () => {
    const wire = (event: ReturnType<typeof record>, withContext = true) => ({
      ...event,
      createdAt: event.createdAt.toISOString(),
      ...(withContext ? { outcomeContext: projectOutcomeContext(event) } : {}),
    });
    const events = [
      wire(record(7, "agent.done")),
      wire(record(8, "agent.idle")),
      wire(record(8, "agent.idle")),
      wire(record(9, "agent.done"), false),
    ];
    const { outcomes } = projectAgentOutcomes(events);
    expect(outcomes.map((outcome) => outcome.eventId)).toEqual([7, 8, 9]);
    const text = formatAgentOutcomeUpdates(outcomes);
    const blocks = text.split("\n- ").slice(1);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain("truncated; run shepy agent read wA:p1");
    expect(blocks[0]).toContain(line300);
    expect(blocks[1]).toContain(line300);
    expect(blocks[2]).toContain("context: unavailable — context_not_provided");
  });

  test("Pi profile wake: leased snapshot carries context; a missing snapshot says why", () => {
    const outcome = projectInboxOutcome(record(11, "agent.done"));
    expect(outcome.context).toMatchObject({ state: "current", tokens: 300210 });
    const text = formatProfileObligationUpdates([
      { agentEventId: 11, obligationId: "ob-11", outcome },
      { agentEventId: 12, obligationId: "ob-12", outcome: null },
    ]);
    const [first, second] = text.split("\n- ").slice(1);
    expect(first).toContain(line300);
    expect(second).toContain("context: unavailable — snapshot_unavailable");
  });

  test("one line per outcome retains the excerpt and truncation hint but omits machine ids and context telemetry", () => {
    const outcome = projectInboxOutcome(record(21, "agent.done"));
    const obligations: LeasedObligation[] = Array.from({ length: 12 }, (_, index) => ({
      agentEventId: 21 + index,
      id: `0000000${index.toString(16)}-0000-4000-8000-000000000000`.slice(0, 36),
      outcome: index === 11 ? null : { ...outcome, eventId: 21 + index },
    }));
    const formatted = formatHookContext("driffs", obligations);
    expect(formatted.representedIds).toHaveLength(12);
    expect(formatted.deferredIds).toEqual([]);
    expect(formatted.context).toContain("worker-a done (pi, wA:p1):");
    expect(formatted.context).toContain("truncated; use shepy agent read before acting");
    expect(formatted.context).not.toContain("event:");
    expect(formatted.context).not.toContain("obligation:");
    expect(formatted.context).not.toContain(line300);
  });

  test("a legacy snapshot absence gets a short fallback notice", () => {
    const { context: _drop, ...legacy } = projectInboxOutcome(record(31, "agent.idle"));
    const formatted = formatHookContext("driffs", [
      { agentEventId: 31, id: "00000031-0000-4000-8000-000000000000", outcome: legacy },
    ]);
    expect(formatted.context).toContain("worker-a done (pi, wA:p1):");
    expect(formatted.context).not.toContain("context_not_provided");
  });
});

// Row 15.309 S3: the corrected Codex reader through the same event-time
// projection. Exact native binding stays a separate requirement: a correct
// reading from a newest-cwd guess is still not this worker's context.
describe("Codex outcomes after the S3 reader fix", () => {
  const CODEX_PATH = "/fixture/codex/rollout-019a.jsonl";
  const codexRef: AgentHistoryRef = {
    kind: "agent_session",
    path: CODEX_PATH,
    source: "codex-jsonl",
    value: "019a-codex",
  };
  const settled = [
    entry(1, {
      type: "session_meta",
      timestamp: "2026-10-15T08:00:00.000Z",
      payload: { id: "019a-codex" },
    }),
    entry(2, {
      type: "turn_context",
      timestamp: "2026-10-15T08:00:01.000Z",
      payload: { model: "gpt-6.1-sol" },
    }),
    entry(3, {
      type: "event_msg",
      timestamp: "2026-10-15T08:35:45.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 117_187, cached_input_tokens: 116_000 },
          total_token_usage: { input_tokens: 9_000_000 },
          model_context_window: 475_000,
        },
      },
    }),
    entry(4, {
      type: "event_msg",
      timestamp: "2026-10-15T08:35:46.000Z",
      payload: { type: "task_complete" },
    }),
  ];
  const codex = (entries: JsonlEntry[], ref: AgentHistoryRef) =>
    project({
      compactHistory: history(projectCodexContextHealth(CODEX_PATH, entries), ref),
      createdAt: EVENT_AT,
    });

  test("an exactly bound settled Codex turn shows tokens over the window Codex reported", () => {
    const context = codex(settled, codexRef);
    expect(context).toMatchObject({
      state: "current",
      tokens: 117_187,
      window: 475_000,
      windowStatus: "reported",
      percent: 24.7,
    });
    expect(context).not.toHaveProperty("ref");
    expect(JSON.stringify(context)).not.toContain(CODEX_PATH);
    expect(formatOutcomeContextLine(context)).toBe(
      "context: 117,187 / 475,000 prompt tokens (24.7%) · reported 2026-10-15T08:35:45.000Z (24m before event) · as of event 2026-10-15T09:00:00.000Z · model gpt-6.1-sol · codex-jsonl",
    );
  });

  test("the same correct reading from a newest-cwd guess is refused as not bound", () => {
    expect(
      codex(settled, {
        kind: "discovered_file",
        path: CODEX_PATH,
        source: "codex-jsonl",
        value: CODEX_PATH,
      }),
    ).toMatchObject({ state: "unavailable", reason: "history_not_session_bound", tokens: null });
  });

  test("after a compaction the Codex line is unavailable, not 0%", () => {
    const compacted = [
      ...settled,
      entry(5, { type: "compacted", timestamp: "2026-10-15T08:40:00.000Z", payload: {} }),
      entry(6, {
        type: "event_msg",
        timestamp: "2026-10-15T08:40:00.010Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 0 }, model_context_window: 475_000 },
        },
      }),
    ];
    const context = codex(compacted, codexRef);
    expect(formatOutcomeContextLine(context)).toBe(
      "context: unavailable — post_compaction_no_turn",
    );
  });

  test("an event stored by the old reader keeps its stored projection; nothing rewrites it", () => {
    const old = projectCodexContextHealth(CODEX_PATH, settled);
    const stored: ContextHealth = {
      ...old,
      usage: {
        current: false,
        kind: "unavailable",
        percent: null,
        reason: "later_turn_without_usage",
        ref: null,
        reportedAt: null,
        tokens: null,
        window: null,
      },
    };
    expect(
      project({ compactHistory: history(stored, codexRef), createdAt: EVENT_AT }),
    ).toMatchObject({ state: "unavailable", reason: "later_turn_without_usage", tokens: null });
  });
});

// Row 15.309 S1 follow-up (adopted plan): the reading's age relative to the
// event, and session_id_varies as ambiguous provenance.
describe("S1 follow-up: event-relative age and ambiguous session provenance", () => {
  test("a Claude file whose entries carry two session ids gives no figure, even when the last id is bound", () => {
    const resumed = [
      ...CLAUDE_BASE,
      entry(3, {
        ...claudeAssistant("u2", "2026-10-15T08:40:00.000Z", {
          input_tokens: 5,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 70000,
        }),
        sessionId: "c2",
      }),
    ];
    expect(claude(resumed, { ...claudeRef, value: "c2" })).toMatchObject({
      state: "unavailable",
      reason: "session_id_varies",
      tokens: null,
      ageSeconds: null,
    });
  });

  test("age is event time minus reading time; unknown or negative age is shown as nothing", () => {
    const later = project({
      compactHistory: history(projectPiContextHealth(PI_PATH, PI_BASE), piRef),
      createdAt: new Date("2026-10-15T08:10:00.000Z"),
    });
    // Correction F2: a reading after its event cannot describe that event.
    expect(later).toMatchObject({
      state: "unavailable",
      reason: "reading_after_event",
      tokens: null,
      ageSeconds: null,
      reportedAt: "2026-10-15T08:20:00.000Z",
      eventAt: "2026-10-15T08:10:00.000Z",
    });
    expect(formatOutcomeContextLine(later)).toBe("context: unavailable — reading_after_event");
    const unknownEvent = project({
      compactHistory: history(projectPiContextHealth(PI_PATH, PI_BASE), piRef),
      createdAt: "not a time",
    });
    expect(unknownEvent).toMatchObject({
      ageSeconds: null,
      eventAt: null,
      state: "stale",
      reason: "event_time_unknown",
    });
  });

  test("age buckets come from the two timestamps, identically in the daemon and Pi renderers; a supplied age is ignored", () => {
    const base = pi(PI_BASE);
    const at = (seconds: number) => new Date(EVENT_AT.getTime() - seconds * 1000).toISOString();
    const cases: Array<[number, string]> = [
      [0, "(0s before event)"],
      [119, "(119s before event)"],
      [120, "(2m before event)"],
      [7199, "(119m before event)"],
      [7200, "(2h 0m before event)"],
      [90061, "(25h 1m before event)"],
    ];
    for (const [seconds, expected] of cases) {
      for (const ageSeconds of [seconds, 5, "40", -5, undefined]) {
        const dto: Record<string, unknown> = { ...base, reportedAt: at(seconds), ageSeconds };
        if (ageSeconds === undefined) delete dto.ageSeconds;
        const line = formatOutcomeContextLine(dto);
        expect(line).toContain(expected);
        expect(piFormatOutcomeContextLine(dto)).toBe(line);
      }
    }
  });
});

// Correction F1–F4 from the independent review of 6800e707 (Sol pZ2,
// review-S1-01). The reviewer's discriminators are adapted here with a matched
// healthy positive for each; every malformed case is its own test.
describe("correction F1: worker harness, history source and reading source agree", () => {
  const piHealth = () => projectPiContextHealth(PI_PATH, PI_BASE);
  const piHistory = () => history(piHealth(), piRef);

  test("matched positive: a Pi event with bound Pi history and Pi health is current; a path ref is never compared with the UUID header", () => {
    const context = projectOutcomeContext({
      compactHistory: piHistory(),
      createdAt: EVENT_AT,
      payload: { agent: "pi" },
    });
    expect(context).toMatchObject({ state: "current", tokens: 300210, source: "pi-jsonl" });
    // The Pi header id ("pi-a") differs from the path-valued ref; that is not a mismatch.
    expect(piHealth().sessionId).toBe("pi-a");
  });

  test("a Claude worker event carrying Pi history and health is refused (pane reused by another harness)", () => {
    expect(
      projectOutcomeContext({
        compactHistory: piHistory(),
        createdAt: EVENT_AT,
        payload: { agent: "claude" },
      }),
    ).toMatchObject({ state: "unavailable", reason: "source_mismatch", tokens: null });
  });

  test("reviewer case: a history source that disagrees with the reading source is refused", () => {
    const mismatched = piHistory();
    mismatched.historyRef = { ...piRef, source: "claude-jsonl" };
    mismatched.source = "claude-jsonl";
    for (const agent of ["claude", "pi"]) {
      expect(
        projectOutcomeContext({
          compactHistory: mismatched,
          createdAt: EVENT_AT,
          payload: { agent },
        }),
      ).toMatchObject({ state: "unavailable", reason: "source_mismatch", tokens: null });
    }
  });

  test("the history's own source field must agree too", () => {
    const mismatched = piHistory();
    mismatched.source = "claude-jsonl";
    expect(
      projectOutcomeContext({
        compactHistory: mismatched,
        createdAt: EVENT_AT,
        payload: { agent: "pi" },
      }),
    ).toMatchObject({ state: "unavailable", reason: "source_mismatch" });
  });

  test.each([
    ["no payload", undefined],
    ["payload without agent", { from: "working" }],
    ["harness without a context reader", { agent: "hermes" }],
    ["non-string agent", { agent: 7 }],
    ["array payload", ["pi"]],
  ])("an event whose worker harness is unknown (%s) gets no figure", (_name, payload) => {
    expect(
      projectOutcomeContext({ compactHistory: piHistory(), createdAt: EVENT_AT, payload }),
    ).toMatchObject({ state: "unavailable", reason: "worker_harness_unknown", tokens: null });
  });

  test("native generation within one harness stays bound by the session id (Claude id ref vs header)", () => {
    expect(claude(CLAUDE_BASE, { ...claudeRef, value: "c-next-generation" })).toMatchObject({
      state: "unavailable",
      reason: "session_mismatch",
    });
    expect(claude(CLAUDE_BASE)).toMatchObject({ state: "current" });
  });
});

describe("correction F2: chronological coherence between reading and event", () => {
  const usageAt = (reportedAt: unknown, current = true) => {
    const health = projectPiContextHealth(PI_PATH, PI_BASE);
    return history(
      {
        ...health,
        usage: {
          ...health.usage,
          current,
          reason: current ? null : "later_turn_without_usage",
          reportedAt: reportedAt as string,
        },
      },
      piRef,
    );
  };

  test("reviewer case: a reading one day after its event is refused and both timestamps are kept", () => {
    const context = project({
      compactHistory: usageAt("2026-10-16T09:00:00.000Z"),
      createdAt: EVENT_AT,
    });
    expect(context).toMatchObject({
      state: "unavailable",
      reason: "reading_after_event",
      tokens: null,
      reportedAt: "2026-10-16T09:00:00.000Z",
      eventAt: "2026-10-15T09:00:00.000Z",
    });
  });

  test("matched positive: a reading at the event instant is current with age 0", () => {
    expect(
      project({ compactHistory: usageAt("2026-10-15T09:00:00.000Z"), createdAt: EVENT_AT }),
    ).toMatchObject({ state: "current", ageSeconds: 0 });
  });

  test.each([
    ["invalid reading time", "yesterday", "reading_time_unknown"],
    ["missing reading time", null, "reading_time_unknown"],
  ])("%s cannot be current: stale with an explicit reason", (_name, reportedAt, reason) => {
    const context = project({ compactHistory: usageAt(reportedAt), createdAt: EVENT_AT });
    expect(context).toMatchObject({ state: "stale", reason, tokens: 300210, reportedAt: null });
    expect(formatOutcomeContextLine(context)).toContain(`context: stale — ${reason}; last 300,210`);
  });

  test("an unknown event time cannot be current either", () => {
    expect(
      project({ compactHistory: usageAt("2026-10-15T08:20:00.000Z"), createdAt: null }),
    ).toMatchObject({ state: "stale", reason: "event_time_unknown", eventAt: null });
  });

  test("an upstream stale reason is kept, never replaced by a time reason", () => {
    expect(
      project({ compactHistory: usageAt("yesterday", false), createdAt: EVENT_AT }),
    ).toMatchObject({ state: "stale", reason: "later_turn_without_usage" });
  });

  test.each([
    ["reading after event", { reportedAt: "2026-10-16T09:00:00.000Z" }],
    ["current without reading time", { reportedAt: null }],
    ["current without event time", { eventAt: null }],
  ])("renderers refuse an incoherent current DTO (%s) identically", (_name, change) => {
    const dto = { ...pi(PI_BASE), ...change };
    expect(formatOutcomeContextLine(dto)).toBe("context: unavailable — context_invalid");
    expect(piFormatOutcomeContextLine(dto)).toBe("context: unavailable — context_invalid");
  });
});

describe("correction F3: coherent windows and percentages, bounded counts", () => {
  const dto = (change: Record<string, unknown>) => ({
    ...pi(PI_BASE),
    tokens: 300,
    window: 1000,
    windowStatus: "reported",
    percent: 30,
    ...change,
  });

  test("matched positive: a coherent reported window renders the derived percentage in both renderers", () => {
    const line = formatOutcomeContextLine(dto({}));
    expect(line).toContain("300 / 1,000 prompt tokens (30.0%)");
    expect(piFormatOutcomeContextLine(dto({}))).toBe(line);
  });

  test.each([
    ["negative", -20],
    ["oversized", 999],
    ["incoherent", 90],
    ["slightly off", 30.2],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["string", "30"],
  ])("a %s supplied percentage is refused, never rendered (both renderers)", (_name, percent) => {
    const value = dto({ percent });
    for (const render of [formatOutcomeContextLine, piFormatOutcomeContextLine]) {
      const line = render(value);
      expect(line).toBe("context: unavailable — context_invalid");
      if (typeof percent === "number") expect(line).not.toContain(`${percent.toFixed(1)}%`);
    }
  });

  test.each([
    ["zero window", { window: 0 }],
    ["negative window", { window: -1000 }],
    ["fractional window", { window: 1000.5 }],
    ["huge window", { window: 2_000_000_000 }],
    ["window below tokens", { window: 200, percent: 150 }],
    ["string window", { window: "1000" }],
    ["percent without a window", { window: null, windowStatus: "unknown" }],
    ["reported status without a window", { window: null, windowStatus: "reported", percent: null }],
    ["inconsistent status with a window", { windowStatus: "inconsistent", percent: null }],
    ["percent on a stale reading", { state: "stale", reason: "later_turn_without_usage" }],
  ])("an unusable %s is refused identically by both renderers", (_name, change) => {
    const value = dto(change);
    expect(formatOutcomeContextLine(value)).toBe("context: unavailable — context_invalid");
    expect(piFormatOutcomeContextLine(value)).toBe("context: unavailable — context_invalid");
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["huge", 2_000_000_000],
  ])("%s tokens are not a reading (both renderers)", (_name, tokens) => {
    const value = dto({ tokens, window: null, windowStatus: "unknown", percent: null });
    expect(formatOutcomeContextLine(value)).toBe("context: unavailable — invalid_reading");
    expect(piFormatOutcomeContextLine(value)).toBe("context: unavailable — invalid_reading");
  });

  const withUsage = (usage: Record<string, unknown>) => {
    const health = projectPiContextHealth(PI_PATH, PI_BASE);
    return project({
      compactHistory: history({ ...health, usage: { ...health.usage, ...usage } }, piRef),
      createdAt: EVENT_AT,
    });
  };

  test.each([
    ["negative", -20],
    ["oversized", 999],
    ["incoherent", 90],
    ["NaN", Number.NaN],
  ])("projector: a %s supplied percentage makes the window unusable but keeps the raw tokens", (_name, percent) => {
    const context = withUsage({ window: 1_000_000, percent });
    expect(context).toMatchObject({
      state: "current",
      tokens: 300210,
      window: null,
      windowStatus: "inconsistent",
      percent: null,
    });
    expect(formatOutcomeContextLine(context)).toContain(
      "300,210 prompt tokens (window inconsistent)",
    );
    expect(formatOutcomeContextLine(context)).not.toContain("%");
  });

  test.each([
    ["rounds up at .x5", 3005, 10_000],
    ["rounds at .x5 with float error", 1, 2000],
    ["large window", 117_187, 475_000],
  ])("projector-rounded percentage at a rounding boundary (%s) renders in both renderers", (_name, tokens, window) => {
    const context = withUsage({ tokens, window, percent: null, ref: `${PI_PATH}#entry=m2` });
    expect(context).toMatchObject({ state: "current", windowStatus: "reported", window });
    const line = formatOutcomeContextLine(context);
    expect(line).toContain(`(${((tokens / window) * 100).toFixed(1)}%)`);
    expect(piFormatOutcomeContextLine(context)).toBe(line);
  });

  test("projector: a coherent supplied percentage, or none, derives the shown value", () => {
    expect(withUsage({ window: 1_000_000, percent: 30.04 })).toMatchObject({
      window: 1_000_000,
      windowStatus: "reported",
      percent: 30,
    });
    expect(withUsage({ window: 1_000_000, percent: null })).toMatchObject({ percent: 30 });
  });

  test("projector: tokens above the window, zero tokens and an absent window", () => {
    expect(withUsage({ window: 100_000, percent: null })).toMatchObject({
      windowStatus: "inconsistent",
      window: null,
      tokens: 300210,
    });
    expect(withUsage({ tokens: 0 })).toMatchObject({
      state: "unavailable",
      reason: "zero_usage_reported",
    });
    expect(withUsage({ window: null, percent: null })).toMatchObject({
      windowStatus: "unknown",
      window: null,
      percent: null,
    });
  });
});

describe("correction F4: the public context object publishes no transcript path", () => {
  test("reviewer case and every projected state: no ref key and no path anywhere in the DTO", () => {
    const states = [
      pi(PI_BASE),
      claude(CLAUDE_BASE),
      pi([...PI_BASE, entry(4, piAssistant("m3", "m2", "2026-10-15T08:50:00.000Z", null))]),
      pi([...PI_BASE], {
        ...piRef,
        path: "/fixture/pi/other.jsonl",
        value: "/fixture/pi/other.jsonl",
      }),
      projectOutcomeContext({
        compactHistory: history(projectPiContextHealth(PI_PATH, PI_BASE), piRef),
        createdAt: EVENT_AT,
        payload: { agent: "claude" },
      }),
    ];
    for (const context of states) {
      expect(context).not.toHaveProperty("ref");
      const json = JSON.stringify(context);
      expect(json).not.toContain("/fixture/");
      expect(json).not.toContain(".jsonl");
      expect(json.length).toBeLessThan(700);
    }
    expect(states.map((context) => context.state)).toEqual([
      "current",
      "current",
      "stale",
      "unavailable",
      "unavailable",
    ]);
  });
});

// Calendar-valid timestamps (independent review-S3-01, Luna pZC): Date.parse
// normalizes impossible dates (2026-02-30 becomes March 2), which produced a
// current reading with age 0. Inputs below are the reviewer's exact probe.
describe("calendar-valid timestamps", () => {
  const withReportedAt = (reportedAt: string, createdAt: string | Date) => {
    const health = projectPiContextHealth(PI_PATH, PI_BASE);
    return project({
      compactHistory: history({ ...health, usage: { ...health.usage, reportedAt } }, piRef),
      createdAt,
    });
  };

  test("reviewer case: an impossible reading date is unknown, never current with age 0", () => {
    const context = withReportedAt("2026-02-30T08:20:00.000Z", "2026-03-02T08:20:00.000Z");
    expect(context).toMatchObject({
      state: "stale",
      reason: "reading_time_unknown",
      reportedAt: null,
      ageSeconds: null,
      eventAt: "2026-03-02T08:20:00.000Z",
    });
    for (const render of [formatOutcomeContextLine, piFormatOutcomeContextLine]) {
      const line = render(context);
      expect(line).toContain("reported time unknown");
      expect(line).not.toContain("2026-02-30");
      expect(line).not.toContain("0s before event");
    }
  });

  test("reviewer case: an impossible event date is unknown, never current with age 0", () => {
    const context = withReportedAt("2026-03-02T08:20:00.000Z", "2026-02-30T08:20:00.000Z");
    expect(context).toMatchObject({
      state: "stale",
      reason: "event_time_unknown",
      eventAt: null,
      ageSeconds: null,
    });
    for (const render of [formatOutcomeContextLine, piFormatOutcomeContextLine]) {
      const line = render(context);
      expect(line).toContain("as of event (time unknown)");
      expect(line).not.toContain("2026-02-30");
      expect(line).not.toContain("before event)");
    }
  });

  const INVALID = [
    "2026-02-29T00:00:00Z",
    "1900-02-29T00:00:00Z",
    "2026-02-30T08:20:00.000Z",
    "2026-13-01T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-10-00T00:00:00Z",
    "2026-10-15T24:00:00Z",
    "2026-10-15T23:60:00Z",
    "2026-10-15T23:59:60Z",
    "2026-10-15T08:00:00+24:00",
    "2026-10-15T08:00:00+05:60",
  ];

  test.each(
    INVALID,
  )("impossible reading time %s: stale and unprinted in the projector and both renderers", (value) => {
    const context = withReportedAt(value, "2026-10-16T00:00:00.000Z");
    expect(context).toMatchObject({
      state: "stale",
      reason: "reading_time_unknown",
      reportedAt: null,
      ageSeconds: null,
    });
    const stale = {
      ...pi(PI_BASE),
      state: "stale",
      reason: "later_turn_without_usage",
      reportedAt: value,
    };
    const current = { ...pi(PI_BASE), reportedAt: value };
    const eventStale = { ...stale, reportedAt: "2026-10-15T08:20:00.000Z", eventAt: value };
    const eventCurrent = { ...pi(PI_BASE), eventAt: value };
    for (const render of [formatOutcomeContextLine, piFormatOutcomeContextLine]) {
      expect(render(stale)).toContain("reported time unknown");
      expect(render(stale)).not.toContain(value);
      expect(render(current)).toBe("context: unavailable — context_invalid");
      expect(render(eventStale)).toContain("as of event (time unknown)");
      expect(render(eventStale)).not.toContain(value);
      expect(render(eventCurrent)).toBe("context: unavailable — context_invalid");
    }
  });

  const VALID = [
    "2024-02-29T12:00:00Z",
    "2000-02-29T00:00:00.000Z",
    "2026-02-28T23:59:59Z",
    "2026-12-31T23:59:59.999999999Z",
    "2026-10-15T14:00:00+05:30",
    "2026-10-15T00:00:00-08:00",
    "2026-10-15T08:00:00.1Z",
    "2026-10-15T08:00:00Z",
  ];

  test.each(
    VALID,
  )("valid reading time %s is kept as written and current; both renderers print it", (value) => {
    const context = withReportedAt(value, "2027-01-01T00:00:00.000Z");
    expect(context).toMatchObject({
      state: "current",
      reportedAt: value,
      eventAt: "2027-01-01T00:00:00.000Z",
    });
    expect(context.ageSeconds).toBe(
      Math.floor((Date.parse("2027-01-01T00:00:00.000Z") - Date.parse(value)) / 1000),
    );
    const line = formatOutcomeContextLine(context);
    expect(line).toContain(`reported ${value} (`);
    expect(piFormatOutcomeContextLine(context)).toBe(line);
  });

  test("a valid offset event time is accepted and kept as written", () => {
    const context = withReportedAt("2026-10-15T08:20:00.000Z", "2026-10-15T11:00:00+02:00");
    expect(context).toMatchObject({
      state: "current",
      eventAt: "2026-10-15T11:00:00+02:00",
      ageSeconds: 2400,
    });
  });
});

// Final common review F3-R1 (Luna pZC, review-common-final-01): the untrusted
// DTO's status fields must agree. Base tuple is the reviewer's probe.
describe("renderer status tuples", () => {
  const VALID = {
    ageSeconds: 60,
    basis: "event",
    eventAt: "2026-10-15T09:00:00.000Z",
    model: "review-model",
    percent: 24.7,
    reason: null,
    reportedAt: "2026-10-15T08:59:00.000Z",
    source: "pi-jsonl",
    state: "current",
    tokens: 117_187,
    window: 475_000,
    windowStatus: "reported",
  };
  const INVALID = "context: unavailable — context_invalid";
  const RENDERERS = [
    ["daemon", formatOutcomeContextLine],
    ["pi", piFormatOutcomeContextLine],
  ] as const;

  const positives: Array<[string, Record<string, unknown>, string]> = [
    [
      "reported window with derived percent",
      {},
      "context: 117,187 / 475,000 prompt tokens (24.7%) ·",
    ],
    [
      "reported window without percent",
      { percent: null },
      "context: 117,187 / 475,000 prompt tokens · reported",
    ],
    [
      "unknown status, tokens only",
      { windowStatus: "unknown", window: null, percent: null },
      "context: 117,187 prompt tokens (window unknown) ·",
    ],
    [
      "inconsistent status, tokens only",
      { windowStatus: "inconsistent", window: null, percent: null },
      "context: 117,187 prompt tokens (window inconsistent) ·",
    ],
    [
      "stale with its reason and a reported window",
      { state: "stale", reason: "later_turn_without_usage", percent: null },
      "context: stale — later_turn_without_usage; last 117,187 / 475,000 prompt tokens ·",
    ],
    [
      "older DTO without windowStatus or window",
      { windowStatus: undefined, window: null, percent: null },
      "context: 117,187 prompt tokens (window unknown) ·",
    ],
  ];
  for (const [name, render] of RENDERERS) {
    test.each(positives)(`${name} renders a coherent tuple: %s`, (_case, change, expected) => {
      const dto: Record<string, unknown> = { ...VALID, ...change };
      if (change.windowStatus === undefined && "windowStatus" in change) delete dto.windowStatus;
      expect(render(dto)).toContain(expected);
    });
  }

  // current/reason relation (one condition).
  const reasonNegatives: Array<[string, unknown]> = [
    ["post_compaction_no_turn", "post_compaction_no_turn"],
    ["later_turn_without_usage", "later_turn_without_usage"],
    ["reading_time_unknown", "reading_time_unknown"],
    ["missing reason field", undefined],
  ];
  // window/status relation (one condition): no number without "reported".
  const relationNegatives: Array<[string, Record<string, unknown>]> = [
    ["unknown status with a window", { windowStatus: "unknown", percent: null }],
    ["inconsistent status with a window", { windowStatus: "inconsistent", percent: null }],
    ["older DTO (no status) with a window", { windowStatus: undefined, percent: null }],
  ];
  // windowStatus enum (one condition), without a window so only the enum can refuse it.
  const enumNegatives: Array<[string, unknown]> = [
    ["unrecognized token", "measured"],
    ["empty token", ""],
    ["case variant", "REPORTED"],
    ["number", 7],
  ];
  // The reviewer's exact six probes (both renderers): fresh-looking 24.7% must be refused.
  const reviewerProbes: Array<[string, Record<string, unknown>]> = [
    ["current with post_compaction_no_turn", { reason: "post_compaction_no_turn" }],
    ["denominator whose status says unknown", { windowStatus: "unknown" }],
    ["unrecognized window status token", { windowStatus: "measured" }],
  ];
  for (const [name, render] of RENDERERS) {
    test.each(reasonNegatives)(`${name} refuses current with reason %s`, (_case, reason) => {
      const dto: Record<string, unknown> = { ...VALID, reason };
      if (reason === undefined) delete dto.reason;
      expect(render(dto)).toBe(INVALID);
    });
    test.each(relationNegatives)(`${name} refuses %s`, (_case, change) => {
      const dto: Record<string, unknown> = { ...VALID, ...change };
      if ("windowStatus" in change && change.windowStatus === undefined) delete dto.windowStatus;
      expect(render(dto)).toBe(INVALID);
    });
    test.each(enumNegatives)(`${name} refuses windowStatus %s`, (_case, windowStatus) => {
      expect(render({ ...VALID, windowStatus, window: null, percent: null })).toBe(INVALID);
    });
    test.each(reviewerProbes)(`${name} refuses reviewer probe: %s`, (_case, change) => {
      const line = render({ ...VALID, ...change });
      expect(line).toBe(INVALID);
      expect(line).not.toContain("24.7%");
    });
    test(`${name} keeps the explicit missing-context fallback`, () => {
      expect(render(undefined)).toBe("context: unavailable — context_not_provided");
      expect(render(null)).toBe("context: unavailable — context_not_provided");
    });
  }

  test("the projector only emits coherent tuples (every projected state renders without context_invalid)", () => {
    const states = [
      pi(PI_BASE),
      claude(CLAUDE_BASE),
      pi([...PI_BASE, entry(4, piAssistant("m3", "m2", "2026-10-15T08:50:00.000Z", null))]),
    ];
    for (const context of states) {
      for (const [, render] of RENDERERS) expect(render(context)).not.toBe(INVALID);
    }
  });
});
