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

const pi = (entries: JsonlEntry[], ref: AgentHistoryRef | null = piRef) =>
  projectOutcomeContext({
    compactHistory: history(projectPiContextHealth(PI_PATH, entries), ref),
    createdAt: EVENT_AT,
  });
const claude = (entries: JsonlEntry[], ref: AgentHistoryRef | null = claudeRef) =>
  projectOutcomeContext({
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
      projectOutcomeContext({
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
    expect(projectOutcomeContext({ compactHistory: null, createdAt: EVENT_AT })).toMatchObject({
      state: "unavailable",
      reason: "context_not_recorded_at_event",
    });
    expect(
      projectOutcomeContext({ compactHistory: history(null, piRef), createdAt: EVENT_AT }),
    ).toMatchObject({ state: "unavailable", reason: "context_not_recorded_at_event" });
  });

  test("non-finite, negative or fractional counts are invalid, never rounded", () => {
    const health = projectPiContextHealth(PI_PATH, PI_BASE);
    for (const tokens of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      const context = projectOutcomeContext({
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
    const current = projectOutcomeContext({
      compactHistory: history(withWindow, piRef),
      createdAt: EVENT_AT,
    });
    expect(formatOutcomeContextLine(current)).toContain(
      "300,210 / 1,000,000 prompt tokens (30.0%)",
    );
    const zeroWindow = projectOutcomeContext({
      compactHistory: history(
        { ...health, usage: { ...health.usage, percent: 50, window: 0 } },
        piRef,
      ),
      createdAt: EVENT_AT,
    });
    expect(formatOutcomeContextLine(zeroWindow)).toContain("(window unknown)");
    expect(formatOutcomeContextLine(zeroWindow)).not.toContain("%");
    const stale = projectOutcomeContext({
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
        projectOutcomeContext({
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

describe("every delivered done/idle block carries the context line", () => {
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

  test("Claude hook: full lines, budget stubs and missing snapshots all keep context", () => {
    const outcome = projectInboxOutcome(record(21, "agent.done"));
    const obligations: LeasedObligation[] = Array.from({ length: 12 }, (_, index) => ({
      agentEventId: 21 + index,
      id: `0000000${index.toString(16)}-0000-4000-8000-000000000000`.slice(0, 36),
      outcome: index === 11 ? null : { ...outcome, eventId: 21 + index },
    }));
    const formatted = formatHookContext("driffs", obligations);
    const blocks = formatted.context
      .split("\n- ")
      .slice(1)
      .filter((block) => !block.startsWith("…"));
    expect(blocks.length).toBeGreaterThan(1);
    const stubs = blocks.filter((block) => block.includes("excerpt omitted for budget"));
    expect(stubs.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block).toMatch(/\n {2}context: /);
    for (const stub of stubs) expect(stub).toContain(line300);
    expect(formatted.representedIds.length + formatted.deferredIds.length).toBe(12);
  });

  test("an old daemon that sends no context still renders an explicit reason in the hook", () => {
    const { context: _drop, ...legacy } = projectInboxOutcome(record(31, "agent.idle"));
    const formatted = formatHookContext("driffs", [
      { agentEventId: 31, id: "00000031-0000-4000-8000-000000000000", outcome: legacy },
    ]);
    expect(formatted.context).toContain("context: unavailable — context_not_provided");
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
    projectOutcomeContext({
      compactHistory: history(projectCodexContextHealth(CODEX_PATH, entries), ref),
      createdAt: EVENT_AT,
    });

  test("an exactly bound settled Codex turn shows tokens over the window Codex reported", () => {
    const context = codex(settled, codexRef);
    expect(context).toMatchObject({
      state: "current",
      tokens: 117_187,
      window: 475_000,
      ref: `${CODEX_PATH}#line=3`,
    });
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
      projectOutcomeContext({ compactHistory: history(stored, codexRef), createdAt: EVENT_AT }),
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
    const later = projectOutcomeContext({
      compactHistory: history(projectPiContextHealth(PI_PATH, PI_BASE), piRef),
      createdAt: new Date("2026-10-15T08:10:00.000Z"),
    });
    expect(later).toMatchObject({ state: "current", ageSeconds: null });
    expect(formatOutcomeContextLine(later)).toContain(
      "reported 2026-10-15T08:20:00.000Z · as of event",
    );
    const unknownEvent = projectOutcomeContext({
      compactHistory: history(projectPiContextHealth(PI_PATH, PI_BASE), piRef),
      createdAt: "not a time",
    });
    expect(unknownEvent).toMatchObject({ ageSeconds: null, eventAt: null });
  });

  test("age buckets render the same in the daemon and the Pi renderer; a 6800-shape DTO without age still renders", () => {
    const base = pi(PI_BASE);
    const cases: Array<[number | undefined | string, string]> = [
      [0, "(0s before event)"],
      [119, "(119s before event)"],
      [120, "(2m before event)"],
      [7199, "(119m before event)"],
      [7200, "(2h 0m before event)"],
      [90061, "(25h 1m before event)"],
      [undefined, "reported 2026-10-15T08:20:00.000Z · as of event"],
      ["40", "reported 2026-10-15T08:20:00.000Z · as of event"],
      [-5, "reported 2026-10-15T08:20:00.000Z · as of event"],
    ];
    for (const [ageSeconds, expected] of cases) {
      const dto: Record<string, unknown> = { ...base, ageSeconds };
      if (ageSeconds === undefined) delete dto.ageSeconds;
      const line = formatOutcomeContextLine(dto);
      expect(line).toContain(expected);
      expect(piFormatOutcomeContextLine(dto)).toBe(line);
    }
  });
});
