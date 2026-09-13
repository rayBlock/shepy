import { describe, expect, test } from "vitest";
import { projectClaudeContextHealth } from "@/agent-history/context-health.js";
import type { JsonlEntry } from "@/agent-history/readers.js";

function entry(line: number, value: unknown): JsonlEntry {
  return { line, value: value as Record<string, unknown> };
}

function base(sessionId: string, timestamp: string, gitBranch = "main"): Record<string, unknown> {
  return {
    sessionId,
    timestamp,
    gitBranch,
    cwd: "/repo",
    version: "2.0.14",
  };
}

function assistant(
  uuid: string,
  sessionId: string,
  timestamp: string,
  usage: Record<string, unknown> | null,
  model = "claude-fable-5-1",
  gitBranch = "main",
): unknown {
  return {
    ...base(sessionId, timestamp, gitBranch),
    type: "assistant",
    uuid,
    message: {
      model,
      content: [{ type: "text", text: `synthetic reply ${uuid}` }],
      ...(usage ? { usage: { output_tokens: 571, ...usage } } : {}),
    },
  };
}

function boundary(
  uuid: string,
  sessionId: string,
  timestamp: string,
  compactMetadata: unknown,
  gitBranch = "main",
): unknown {
  return {
    ...base(sessionId, timestamp, gitBranch),
    type: "system",
    subtype: "compact_boundary",
    level: "info",
    uuid,
    compactMetadata,
  };
}

const threeAssistants = [
  entry(
    1,
    assistant("a1", "s1", "2026-09-13T11:01:00.000Z", {
      input_tokens: 2,
      cache_creation_input_tokens: 29551,
      cache_read_input_tokens: 11660,
    }),
  ),
  entry(
    2,
    assistant("a2", "s1", "2026-09-13T11:02:00.000Z", {
      input_tokens: 3,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 200,
    }),
  ),
  entry(
    3,
    assistant("a3", "s1", "2026-09-13T11:03:00.000Z", {
      input_tokens: 4,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 500,
    }),
  ),
];

function project(entries: JsonlEntry[]): ReturnType<typeof projectClaudeContextHealth> {
  return projectClaudeContextHealth("/tmp/claude-session.jsonl", entries);
}

describe("projectClaudeContextHealth", () => {
  test("reads the last assistant entry's billed prompt only", () => {
    const health = project(threeAssistants);
    // 4 + 300 + 500 from the LAST entry only.
    expect(health.usage).toMatchObject({
      current: true,
      kind: "last_reported",
      percent: null,
      reason: null,
      reportedAt: "2026-09-13T11:03:00.000Z",
      tokens: 804,
      window: null,
    });
    expect(health.usage.ref).toContain("entry=a3");
    expect(health.sessionId).toBe("s1");
    expect(health.branch).toBe("main");
    // "anthropic" is not invented.
    expect(health.model).toEqual({ changedAt: null, id: "claude-fable-5-1", provider: null });
    expect(health.limitations).toContain("claude_lineage_by_file_order");
  });

  test("all-zero usage is not a reading (O2)", () => {
    // Claude writes zeros for providers that do not report usage; a billed
    // prompt of 0 is not a reading.
    const health = project([
      entry(
        1,
        assistant("a1", "s1", "2026-09-13T11:01:00.000Z", {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
      ),
    ]);
    expect(health.usage).toMatchObject({
      kind: "unavailable",
      reason: "no_usage_recorded",
      tokens: null,
    });
  });

  test("an empty file records no usage (F1)", () => {
    const health = project([]);
    expect(health.usage).toMatchObject({
      kind: "unavailable",
      reason: "no_usage_recorded",
      tokens: null,
    });
    expect(health.limitations).not.toContain("lineage_unresolved");
  });

  test("maps a manual compact_boundary and blocks usage recorded before it", () => {
    const health = project([
      ...threeAssistants,
      entry(
        4,
        boundary("b1", "s1", "2026-09-13T11:04:00.000Z", {
          trigger: "manual",
          preTokens: 505689,
          postTokens: 18079,
          cumulativeDroppedTokens: 487610,
          durationMs: 106150,
        }),
      ),
    ]);
    expect(health.usage).toMatchObject({
      current: false,
      kind: "unavailable",
      reason: "post_compaction_no_turn",
      tokens: null,
    });
    expect(health.compactionCount).toBe(1);
    expect(health.lastCompaction).toMatchObject({
      durationMs: 106150,
      timestamp: "2026-09-13T11:04:00.000Z",
      tokensAfter: 18079,
      tokensBefore: 505689,
      trigger: "manual",
    });
  });

  test("a compact summary user entry is not a boundary", () => {
    const health = project([
      entry(1, assistant("a1", "s1", "2026-09-13T11:01:00.000Z", { input_tokens: 10 })),
      entry(2, {
        ...base("s1", "2026-09-13T11:02:00.000Z"),
        type: "user",
        uuid: "u1",
        isCompactSummary: true,
        message: { role: "user", content: [{ type: "text", text: "synthetic summary" }] },
      }),
    ]);
    expect(health.compactionCount).toBe(0);
    expect(health.lastCompaction).toBeNull();
  });

  test("a branch change after the reading marks it stale but keeps tokens", () => {
    // The branch change arrives on a user entry: an assistant entry here
    // would also be a later turn without usage (lower precedence marker).
    const health = project([
      entry(
        1,
        assistant("a1", "s1", "2026-09-13T11:01:00.000Z", {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
      ),
      entry(2, {
        ...base("s1", "2026-09-13T11:02:00.000Z", "feature"),
        type: "user",
        uuid: "u1",
        message: { role: "user", content: [{ type: "text", text: "synthetic ask" }] },
      }),
    ]);
    expect(health.usage).toMatchObject({
      current: false,
      kind: "last_reported",
      reason: "branch_changed_since_reading",
      tokens: 10,
    });
    expect(health.branch).toBe("feature");
  });

  test("two distinct session ids keep the last and add a limitation", () => {
    const health = project([
      entry(
        1,
        assistant("a1", "s1", "2026-09-13T11:01:00.000Z", {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
      ),
      entry(
        2,
        assistant("a2", "s2", "2026-09-13T11:02:00.000Z", {
          input_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
      ),
    ]);
    expect(health.sessionId).toBe("s2");
    expect(health.limitations).toContain("session_id_varies");
  });

  test("an unrecognized trigger degrades to unknown", () => {
    const health = project([
      entry(
        1,
        boundary("b1", "s1", "2026-09-13T11:00:30.000Z", {
          trigger: "weird",
          preTokens: 100,
          postTokens: 10,
        }),
      ),
      entry(
        2,
        assistant("a1", "s1", "2026-09-13T11:01:00.000Z", {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
      ),
    ]);
    expect(health.lastCompaction).toMatchObject({ trigger: "unknown" });
    expect(health.usage.kind).toBe("last_reported");
  });

  test("a later assistant entry without usage marks the reading stale (O3 a)", () => {
    const health = project([
      entry(
        1,
        assistant("a1", "s1", "2026-09-13T11:01:00.000Z", {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
      ),
      entry(2, assistant("a2", "s1", "2026-09-13T11:02:00.000Z", null)),
    ]);
    expect(health.usage).toMatchObject({
      current: false,
      kind: "last_reported",
      reason: "later_turn_without_usage",
      tokens: 10,
    });
  });

  test("a later assistant entry with all-zero usage marks the reading stale (O3 b)", () => {
    const health = project([
      entry(
        1,
        assistant("a1", "s1", "2026-09-13T11:01:00.000Z", {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
      ),
      entry(
        2,
        assistant("a2", "s1", "2026-09-13T11:02:00.000Z", {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
      ),
    ]);
    expect(health.usage).toMatchObject({
      current: false,
      kind: "last_reported",
      reason: "later_turn_without_usage",
      tokens: 10,
    });
  });

  test("a model change sets changedAt, and one after the reading invalidates it", () => {
    const changed = [
      entry(
        1,
        assistant("a1", "s1", "2026-09-13T11:01:00.000Z", {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
      ),
      entry(
        2,
        assistant(
          "a2",
          "s1",
          "2026-09-13T11:02:00.000Z",
          {
            input_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          "claude-fable-6",
        ),
      ),
    ];
    const health = project(changed);
    expect(health.model).toMatchObject({
      changedAt: "2026-09-13T11:02:00.000Z",
      id: "claude-fable-6",
    });
    expect(health.usage).toMatchObject({ kind: "last_reported", tokens: 20 });

    const firstOnModelA = changed[0];
    if (!firstOnModelA) throw new Error("Expected first entry");
    const invalidated = project([
      firstOnModelA,
      entry(3, assistant("a3", "s1", "2026-09-13T11:03:00.000Z", null, "claude-fable-6")),
    ]);
    expect(invalidated.usage).toMatchObject({
      kind: "unavailable",
      reason: "model_changed_since_reading",
      tokens: null,
    });
  });

  test("a string compactMetadata still counts a boundary with null numerics", () => {
    const health = project([
      entry(1, boundary("b1", "s1", "2026-09-13T11:00:30.000Z", "not-an-object")),
      entry(
        2,
        assistant("a1", "s1", "2026-09-13T11:01:00.000Z", {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
      ),
    ]);
    expect(health.compactionCount).toBe(1);
    expect(health.lastCompaction).toEqual({
      durationMs: null,
      ref: "/tmp/claude-session.jsonl#entry=b1",
      timestamp: "2026-09-13T11:00:30.000Z",
      tokensAfter: null,
      tokensBefore: null,
      trigger: "unknown",
    });
    expect(health.usage.kind).toBe("last_reported");
    expect(health.limitations).toContain("context_window_not_recorded");
  });

  test("a sidechain assistant never becomes the reading (D10 i)", () => {
    // The sidechain entry is last in the file but is excluded from the
    // reading, the model, and the boundaries.
    const sidechain = {
      ...(assistant(
        "sc1",
        "s1",
        "2026-09-13T11:04:00.000Z",
        {
          input_tokens: 1000,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 1000,
        },
        "claude-mini-x",
      ) as Record<string, unknown>),
      isSidechain: true,
    };
    const health = project([...threeAssistants, entry(4, sidechain)]);
    expect(health.usage).toMatchObject({
      current: true,
      kind: "last_reported",
      tokens: 804,
    });
    expect(health.usage.ref).toContain("entry=a3");
    expect(health.model).toMatchObject({ id: "claude-fable-5-1" });
    expect(health.limitations).toContain("claude_lineage_by_file_order");
  });

  test("a model change away and back still invalidates the reading (D9 m)", () => {
    const health = project([
      entry(
        1,
        assistant("a1", "s1", "2026-09-13T11:01:00.000Z", {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
      ),
      entry(2, assistant("a2", "s1", "2026-09-13T11:02:00.000Z", null, "claude-fable-6")),
      entry(3, assistant("a3", "s1", "2026-09-13T11:03:00.000Z", null)),
    ]);
    expect(health.usage).toMatchObject({
      kind: "unavailable",
      reason: "model_changed_since_reading",
      tokens: null,
    });
    expect(health.model).toMatchObject({
      changedAt: "2026-09-13T11:03:00.000Z",
      id: "claude-fable-5-1",
    });
  });
});
