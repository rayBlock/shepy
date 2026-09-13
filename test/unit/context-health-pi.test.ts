import { describe, expect, test } from "vitest";
import { projectPiContextHealth } from "@/agent-history/context-health.js";
import type { JsonlEntry } from "@/agent-history/readers.js";
import type { ContextHealth } from "@/observability/contracts.js";

const T0 = "2026-09-13T10:00:00.000Z";
const ROOT = "pi-session-1";

function entry(line: number, value: unknown): JsonlEntry {
  return { line, value: value as Record<string, unknown> };
}

function header(id: string, timestamp = T0): unknown {
  return { type: "session", version: 3, id, timestamp, cwd: "/repo" };
}

// Real Pi files: the header has no parentId and the first entry re-roots the
// chain with parentId null — nothing ever points at the header id.
function modelChange(
  id: string,
  modelId: string,
  timestamp: string,
  parentId: string | null = null,
): unknown {
  return { type: "model_change", id, parentId, timestamp, provider: "openai-codex", modelId };
}

function assistant(
  id: string,
  timestamp: string,
  usage: Record<string, unknown>,
  parentId: string | null,
  model = "gpt-6-astra",
): unknown {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      provider: "openai-codex",
      model,
      content: [{ type: "text", text: `synthetic reply ${id}` }],
      usage: { output: 7, reasoning: 0, ...usage },
    },
  };
}

function compaction(
  id: string,
  timestamp: string,
  parentId: string | null,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp,
    firstKeptEntryId: "m2",
    tokensBefore: 311646,
    details: { prompt: "synthetic" },
    usage: { input: 4242 },
    fromHook: false,
    ...extra,
  };
}

function branchSummary(id: string, timestamp: string, parentId: string, fromId: string): unknown {
  return {
    type: "branch_summary",
    id,
    parentId,
    fromId,
    timestamp,
    usage: { input: 4321 },
    fromHook: false,
  };
}

const threeMessages = [
  entry(1, header(ROOT)),
  entry(2, modelChange("mc1", "gpt-6-astra", "2026-09-13T10:00:01.000Z")),
  entry(
    3,
    assistant(
      "m1",
      "2026-09-13T10:01:00.000Z",
      {
        input: 1000,
        cacheRead: 100,
        cacheWrite: 10,
        totalTokens: 1160,
      },
      "mc1",
    ),
  ),
  entry(
    4,
    assistant(
      "m2",
      "2026-09-13T10:02:00.000Z",
      {
        input: 2000,
        cacheRead: 200,
        cacheWrite: 20,
        totalTokens: 2280,
      },
      "m1",
    ),
  ),
  entry(
    5,
    assistant(
      "m3",
      "2026-09-13T10:03:00.000Z",
      {
        input: 4000,
        cacheRead: 400,
        cacheWrite: 40,
        totalTokens: 4510,
      },
      "m2",
    ),
  ),
];

function project(entries: JsonlEntry[]): ContextHealth {
  return projectPiContextHealth("/tmp/pi-session.jsonl", entries);
}

describe("projectPiContextHealth", () => {
  test("reads the last assistant message's billed prompt only", () => {
    const health = project(threeMessages);
    // 4000 + 400 + 40. Summing all messages would give 7770; totalTokens
    // would give 4510 — neither may appear.
    expect(health.usage).toMatchObject({
      current: true,
      kind: "last_reported",
      percent: null,
      reason: null,
      reportedAt: "2026-09-13T10:03:00.000Z",
      tokens: 4440,
      window: null,
    });
    expect(health.usage.ref).toContain("entry=m3");
    expect(health.sessionId).toBe("pi-session-1");
    expect(health.model).toEqual({
      changedAt: null,
      id: "gpt-6-astra",
      provider: "openai-codex",
    });
    expect(health.sourceUpdatedAt).toBe("2026-09-13T10:03:00.000Z");
  });

  test("a compaction after the last assistant message makes usage unavailable", () => {
    const health = project([
      ...threeMessages,
      entry(6, compaction("c1", "2026-09-13T10:04:00.000Z", "m3")),
    ]);
    expect(health.usage).toMatchObject({
      current: false,
      kind: "unavailable",
      reason: "post_compaction_no_turn",
      ref: null,
      reportedAt: null,
      tokens: null,
    });
    expect(health.compactionCount).toBe(1);
    expect(health.lastCompaction).toMatchObject({
      durationMs: null,
      timestamp: "2026-09-13T10:04:00.000Z",
      tokensAfter: null,
      tokensBefore: 311646,
      trigger: "unknown",
    });
    expect(health.limitations).toContain("post_compaction_no_turn");
  });

  test("an empty file is empty, not broken (F1)", () => {
    const health = project([]);
    expect(health.usage).toMatchObject({
      kind: "unavailable",
      reason: "no_usage_recorded",
      tokens: null,
    });
    expect(health.sessionId).toBeNull();
    expect(health.limitations).toEqual([
      "context_window_not_recorded",
      "compaction_outcome_not_recorded",
      "leaf_move_not_recorded_until_next_append",
    ]);
  });

  test("a compaction followed by a new assistant message reads the new message", () => {
    const health = project([
      entry(1, header(ROOT)),
      entry(2, modelChange("mc1", "gpt-6-astra", "2026-09-13T10:00:01.000Z")),
      entry(
        3,
        assistant(
          "m1",
          "2026-09-13T10:01:00.000Z",
          { input: 9000, cacheRead: 0, cacheWrite: 0 },
          "mc1",
        ),
      ),
      entry(4, compaction("c1", "2026-09-13T10:02:00.000Z", "m1")),
      entry(
        5,
        assistant(
          "m4",
          "2026-09-13T10:03:00.000Z",
          { input: 1200, cacheRead: 30, cacheWrite: 0 },
          "c1",
        ),
      ),
    ]);
    expect(health.usage).toMatchObject({
      current: true,
      kind: "last_reported",
      tokens: 1230,
    });
    expect(health.usage.ref).toContain("entry=m4");
    expect(health.compactionCount).toBe(1);
  });

  test("a model change after the reading invalidates it", () => {
    const health = project([
      ...threeMessages.slice(0, 3),
      entry(9, modelChange("mc2", "glm-9-flash", "2026-09-13T10:05:00.000Z", "m1")),
    ]);
    expect(health.usage).toMatchObject({
      kind: "unavailable",
      reason: "model_changed_since_reading",
      tokens: null,
      reportedAt: "2026-09-13T10:01:00.000Z",
    });
    expect(health.model).toMatchObject({
      changedAt: "2026-09-13T10:05:00.000Z",
      id: "glm-9-flash",
    });
  });

  test("a non-numeric tokensBefore degrades to null without throwing", () => {
    const health = project([
      ...threeMessages,
      entry(6, compaction("c1", "2026-09-13T10:04:00.000Z", "m3", { tokensBefore: "lots" })),
    ]);
    expect(health.lastCompaction?.tokensBefore).toBeNull();
    expect(health.usage.reason).toBe("post_compaction_no_turn");
  });

  test("no assistant usage at all is unavailable", () => {
    const health = project([
      entry(1, header(ROOT)),
      entry(2, {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-09-13T10:01:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "synthetic ask" }] },
      }),
    ]);
    expect(health.usage).toMatchObject({
      kind: "unavailable",
      reason: "no_usage_recorded",
      tokens: null,
    });
  });

  test("all-zero usage is not a reading (O2)", () => {
    // Pi writes zeros for providers that do not report usage; a billed
    // prompt of 0 is not a reading.
    const health = project([
      entry(1, header(ROOT)),
      entry(2, modelChange("mc1", "gpt-6-astra", "2026-09-13T10:00:01.000Z")),
      entry(
        3,
        assistant(
          "m1",
          "2026-09-13T10:01:00.000Z",
          { input: 0, cacheRead: 0, cacheWrite: 0 },
          "mc1",
        ),
      ),
    ]);
    expect(health.usage).toMatchObject({
      kind: "unavailable",
      reason: "no_usage_recorded",
      tokens: null,
    });
  });

  test("the compaction entry's own usage is never the reading", () => {
    const health = project([
      entry(1, header(ROOT)),
      entry(2, compaction("c1", "2026-09-13T10:04:00.000Z", null, { usage: { input: 999999 } })),
    ]);
    expect(health.usage).toMatchObject({
      kind: "unavailable",
      reason: "no_usage_recorded",
      tokens: null,
    });
    expect(health.usage.tokens).not.toBe(999999);
  });

  test("every projection reports an unrecorded context window", () => {
    for (const health of [
      project(threeMessages),
      project([...threeMessages, entry(6, compaction("c1", "2026-09-13T10:04:00.000Z", "m3"))]),
      project([entry(1, header(ROOT))]),
    ]) {
      expect(health.usage.window).toBeNull();
      expect(health.usage.percent).toBeNull();
      expect(health.limitations).toContain("context_window_not_recorded");
      expect(health.limitations).toContain("compaction_outcome_not_recorded");
      expect(health.limitations).toContain("leaf_move_not_recorded_until_next_append");
      expect(health.branch).toBeNull();
    }
  });

  test("a branch_summary re-roots: the earlier lineage's reading goes stale (D8 i)", () => {
    const health = project([
      entry(1, header(ROOT)),
      entry(2, modelChange("mc1", "gpt-6-astra", "2026-09-13T10:00:01.000Z")),
      // Assistant B lives on the lineage the summary re-roots TO.
      entry(
        3,
        assistant(
          "mB",
          "2026-09-13T10:01:00.000Z",
          { input: 49000, cacheRead: 1000, cacheWrite: 0 },
          "mc1",
        ),
      ),
      // Assistant A (400k) sits on the abandoned branch.
      entry(
        4,
        assistant(
          "mX",
          "2026-09-13T10:02:00.000Z",
          { input: 30000, cacheRead: 0, cacheWrite: 0 },
          "mB",
        ),
      ),
      entry(
        5,
        assistant(
          "mA",
          "2026-09-13T10:03:00.000Z",
          { input: 390000, cacheRead: 10000, cacheWrite: 0 },
          "mX",
        ),
      ),
      entry(6, branchSummary("bs1", "2026-09-13T10:04:00.000Z", "mB", "mA")),
    ]);
    expect(health.usage).toMatchObject({
      current: false,
      kind: "last_reported",
      reason: "branch_switched_since_reading",
      tokens: 50000,
    });
    expect(health.usage.ref).toContain("entry=mB");
  });

  test("a later assistant turn without usage marks the reading stale (O3 a)", () => {
    const health = project([
      entry(1, header(ROOT)),
      entry(2, modelChange("mc1", "gpt-6-astra", "2026-09-13T10:00:01.000Z")),
      entry(
        3,
        assistant(
          "m1",
          "2026-09-13T10:01:00.000Z",
          { input: 4000, cacheRead: 400, cacheWrite: 40 },
          "mc1",
        ),
      ),
      entry(4, {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-09-13T10:02:00.000Z",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-6-astra",
          content: [{ type: "text", text: "synthetic reply m2" }],
        },
      }),
    ]);
    expect(health.usage).toMatchObject({
      current: false,
      kind: "last_reported",
      reason: "later_turn_without_usage",
      tokens: 4440,
    });
  });

  test("a later assistant turn with all-zero usage marks the reading stale (O3 b)", () => {
    const health = project([
      entry(1, header(ROOT)),
      entry(2, modelChange("mc1", "gpt-6-astra", "2026-09-13T10:00:01.000Z")),
      entry(
        3,
        assistant(
          "m1",
          "2026-09-13T10:01:00.000Z",
          { input: 4000, cacheRead: 400, cacheWrite: 40 },
          "mc1",
        ),
      ),
      entry(
        4,
        assistant(
          "m2",
          "2026-09-13T10:02:00.000Z",
          { input: 0, cacheRead: 0, cacheWrite: 0 },
          "m1",
        ),
      ),
    ]);
    expect(health.usage).toMatchObject({
      current: false,
      kind: "last_reported",
      reason: "later_turn_without_usage",
      tokens: 4440,
    });
  });

  test("later_turn_without_usage outranks the branch marker (O3 c)", () => {
    const health = project([
      entry(1, header(ROOT)),
      entry(2, modelChange("mc1", "gpt-6-astra", "2026-09-13T10:00:01.000Z")),
      entry(
        3,
        assistant(
          "m1",
          "2026-09-13T10:01:00.000Z",
          { input: 4000, cacheRead: 400, cacheWrite: 40 },
          "mc1",
        ),
      ),
      entry(4, {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-09-13T10:02:00.000Z",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-6-astra",
          content: [{ type: "text", text: "synthetic reply m2" }],
        },
      }),
      entry(5, branchSummary("bs1", "2026-09-13T10:03:00.000Z", "m2", "m1")),
    ]);
    expect(health.usage).toMatchObject({
      current: false,
      kind: "last_reported",
      reason: "later_turn_without_usage",
      tokens: 4440,
    });
  });

  test("a branch_summary re-root with no assistant usage above (D8 j)", () => {
    const health = project([
      entry(1, header(ROOT)),
      entry(2, modelChange("mc1", "gpt-6-astra", "2026-09-13T10:00:01.000Z")),
      entry(
        3,
        assistant(
          "mA",
          "2026-09-13T10:01:00.000Z",
          { input: 400000, cacheRead: 0, cacheWrite: 0 },
          "mc1",
        ),
      ),
      entry(4, branchSummary("bs1", "2026-09-13T10:02:00.000Z", "mc1", "mA")),
    ]);
    expect(health.usage).toMatchObject({
      kind: "unavailable",
      reason: "no_usage_on_active_lineage",
      tokens: null,
    });
  });

  test("an unknown parentId breaks the lineage (D8 k)", () => {
    const health = project([
      entry(1, header(ROOT)),
      entry(
        2,
        assistant(
          "m1",
          "2026-09-13T10:01:00.000Z",
          { input: 1000, cacheRead: 0, cacheWrite: 0 },
          null,
        ),
      ),
      entry(
        3,
        assistant(
          "m2",
          "2026-09-13T10:02:00.000Z",
          { input: 2000, cacheRead: 0, cacheWrite: 0 },
          "ghost",
        ),
      ),
      entry(4, compaction("c1", "2026-09-13T10:03:00.000Z", "m2")),
    ]);
    expect(health.usage).toMatchObject({
      kind: "unavailable",
      reason: "lineage_unresolved",
      tokens: null,
    });
    expect(health.compactionCount).toBe(0);
    expect(health.lastCompaction).toBeNull();
    expect(health.limitations).toContain("lineage_unresolved");
  });

  test("an off-lineage compaction entry is not counted (D8 l)", () => {
    const health = project([
      entry(1, header(ROOT)),
      entry(2, modelChange("mc1", "gpt-6-astra", "2026-09-13T10:00:01.000Z")),
      entry(
        3,
        assistant(
          "m1",
          "2026-09-13T10:01:00.000Z",
          { input: 4000, cacheRead: 400, cacheWrite: 40 },
          "mc1",
        ),
      ),
      entry(4, compaction("cOff", "2026-09-13T10:02:00.000Z", "ghost")),
      entry(
        5,
        assistant(
          "m2",
          "2026-09-13T10:03:00.000Z",
          { input: 1200, cacheRead: 30, cacheWrite: 0 },
          "m1",
        ),
      ),
    ]);
    expect(health.compactionCount).toBe(0);
    expect(health.lastCompaction).toBeNull();
    expect(health.usage).toMatchObject({ current: true, kind: "last_reported", tokens: 1230 });
  });

  test("a model change away and back still invalidates the reading (D9 m)", () => {
    const health = project([
      entry(1, header(ROOT)),
      entry(2, modelChange("mcA", "gpt-6-astra", "2026-09-13T10:00:01.000Z")),
      entry(
        3,
        assistant(
          "m1",
          "2026-09-13T10:01:00.000Z",
          { input: 1000, cacheRead: 0, cacheWrite: 0 },
          "mcA",
        ),
      ),
      entry(4, modelChange("mcB", "glm-9-flash", "2026-09-13T10:02:00.000Z", "m1")),
      entry(5, modelChange("mcA2", "gpt-6-astra", "2026-09-13T10:03:00.000Z", "mcB")),
    ]);
    expect(health.usage).toMatchObject({
      current: false,
      kind: "unavailable",
      reason: "model_changed_since_reading",
      tokens: null,
    });
    expect(health.model).toMatchObject({
      changedAt: "2026-09-13T10:03:00.000Z",
      id: "gpt-6-astra",
    });
  });
});
