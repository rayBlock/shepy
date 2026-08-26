import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { discoverAgentHistory, discoverHermesSession } from "@/agent-history/discovery.js";
import { HermesHistoryReader, hermesSessionRevision } from "@/agent-history/hermes-reader.js";
import type { AgentHistoryRef } from "@/observability/contracts.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempHome(name: string) {
  const dir = await mkdtemp(join(tmpdir(), name));
  tempDirs.push(dir);
  return dir;
}

/** Mirrors the real ~/.hermes/state.db columns this reader depends on. */
async function createStateDb(homeDir: string): Promise<string> {
  const dir = join(homeDir, ".hermes");
  await mkdir(dir, { recursive: true });
  const dbPath = join(dir, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table sessions (
      id text primary key,
      cwd text,
      model text,
      message_count integer default 0,
      system_prompt text
    );
    create table messages (
      id integer primary key autoincrement,
      session_id text not null,
      role text not null,
      content text,
      tool_call_id text,
      tool_calls text,
      tool_name text,
      timestamp real not null,
      finish_reason text,
      reasoning text,
      active integer not null default 1,
      compacted integer not null default 0
    );
  `);
  return dbPath;
}

type Msg = {
  active?: number;
  compacted?: number;
  content?: string | null;
  finishReason?: string | null;
  reasoning?: string | null;
  role: string;
  sessionId: string;
  timestamp: number;
  toolCalls?: string | null;
  toolName?: string | null;
};

function insert(dbPath: string, messages: Msg[]) {
  const db = new DatabaseSync(dbPath);
  const stmt = db.prepare(`
    insert into messages
      (session_id, role, content, tool_calls, tool_name, timestamp,
       finish_reason, reasoning, active, compacted)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const m of messages) {
    stmt.run(
      m.sessionId,
      m.role,
      m.content ?? null,
      m.toolCalls ?? null,
      m.toolName ?? null,
      m.timestamp,
      m.finishReason ?? null,
      m.reasoning ?? null,
      m.active ?? 1,
      m.compacted ?? 0,
    );
  }
  db.close();
}

function session(dbPath: string, id: string, cwd: string) {
  const db = new DatabaseSync(dbPath);
  db.prepare("insert into sessions (id, cwd, system_prompt) values (?, ?, ?)").run(
    id,
    cwd,
    "TOP SECRET SYSTEM PROMPT",
  );
  db.close();
}

function ref(dbPath: string, value: string): AgentHistoryRef {
  return { kind: "agent_session", path: dbPath, source: "hermes-sqlite", value };
}

// Epoch *seconds*, as Hermes stores them.
const T0 = 1787759000;

describe("HermesHistoryReader", () => {
  test("reads user, assistant, and tool messages from the active window", async () => {
    const homeDir = await tempHome("shepherd-hermes-reader-");
    const dbPath = await createStateDb(homeDir);
    session(dbPath, "s1", "/Users/ray/dev/driffs");
    insert(dbPath, [
      { content: "run the tests", role: "user", sessionId: "s1", timestamp: T0 },
      {
        content: "",
        finishReason: "tool_calls",
        role: "assistant",
        sessionId: "s1",
        timestamp: T0 + 1,
        toolCalls: '[{"function":{"name":"terminal"}}]',
      },
      {
        content: '{"output": "191 passed", "exit_code": 0, "error": null}',
        role: "tool",
        sessionId: "s1",
        timestamp: T0 + 2,
        toolName: "terminal",
      },
      {
        content: "All 191 tests pass.",
        finishReason: "stop",
        role: "assistant",
        sessionId: "s1",
        timestamp: T0 + 3,
      },
    ]);

    const messages = await new HermesHistoryReader().read(ref(dbPath, "s1"));

    // The tool_calls-only assistant row carries no text and is dropped.
    expect(messages.map((m) => m.role)).toEqual(["user", "tool_result", "assistant"]);
    expect(messages[0]?.text).toBe("run the tests");
    expect(messages[2]?.text).toBe("All 191 tests pass.");
    expect(messages[1]?.toolName).toBe("terminal");
    expect(messages[1]?.compact?.isError).toBe(false);
  });

  test("converts epoch seconds to a real timestamp", async () => {
    const homeDir = await tempHome("shepherd-hermes-ts-");
    const dbPath = await createStateDb(homeDir);
    session(dbPath, "s1", "/tmp/x");
    insert(dbPath, [{ content: "hi", role: "user", sessionId: "s1", timestamp: T0 }]);

    const messages = await new HermesHistoryReader().read(ref(dbPath, "s1"));

    expect(messages[0]?.timestamp).toBe(new Date(T0 * 1000).toISOString());
    // Guards the seconds-vs-milliseconds bug: unscaled, this lands in 1970.
    expect(messages[0]?.timestamp?.startsWith("2026-")).toBe(true);
  });

  test("excludes compacted history and never leaks another session", async () => {
    const homeDir = await tempHome("shepherd-hermes-active-");
    const dbPath = await createStateDb(homeDir);
    session(dbPath, "s1", "/Users/ray/dev/driffs");
    session(dbPath, "s2", "/Users/ray/dev/driffs");
    insert(dbPath, [
      {
        active: 0,
        compacted: 1,
        content: "folded-away history",
        role: "user",
        sessionId: "s1",
        timestamp: T0,
      },
      { content: "live message", role: "user", sessionId: "s1", timestamp: T0 + 1 },
      { content: "OTHER SESSION SECRET", role: "user", sessionId: "s2", timestamp: T0 + 2 },
    ]);

    const messages = await new HermesHistoryReader().read(ref(dbPath, "s1"));
    const blob = JSON.stringify(messages);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("live message");
    expect(blob).not.toContain("folded-away");
    expect(blob).not.toContain("OTHER SESSION SECRET");
  });

  test("never surfaces system prompts or reasoning", async () => {
    const homeDir = await tempHome("shepherd-hermes-privacy-");
    const dbPath = await createStateDb(homeDir);
    session(dbPath, "s1", "/tmp/x");
    insert(dbPath, [
      {
        content: "visible answer",
        reasoning: "PRIVATE CHAIN OF THOUGHT",
        role: "assistant",
        sessionId: "s1",
        timestamp: T0,
      },
    ]);

    const compact = await new HermesHistoryReader().readCompact(ref(dbPath, "s1"));
    const blob = JSON.stringify(compact);

    expect(blob).not.toContain("PRIVATE CHAIN OF THOUGHT");
    expect(blob).not.toContain("TOP SECRET SYSTEM PROMPT");
    expect(compact.lastAssistantMessage?.text).toBe("visible answer");
  });

  test.each([
    ['{"output": "", "exit_code": -1, "error": "BLOCKED"}', true, "error string"],
    ['{"output": "x", "exit_code": 2, "error": null}', true, "non-zero exit_code"],
    ['{"status": "not_found", "error": "no such process"}', true, "status not_found"],
    ['{"output": "ok", "exit_code": 0, "error": null}', false, "clean success"],
    ["not json at all", false, "unparseable payload"],
  ])("classifies tool failure: %s -> %s (%s)", async (content, expected) => {
    const homeDir = await tempHome("shepherd-hermes-err-");
    const dbPath = await createStateDb(homeDir);
    session(dbPath, "s1", "/tmp/x");
    insert(dbPath, [
      { content, role: "tool", sessionId: "s1", timestamp: T0, toolName: "terminal" },
    ]);

    const messages = await new HermesHistoryReader().read(ref(dbPath, "s1"));

    expect(messages[0]?.compact?.isError).toBe(expected);
  });

  test("compact projection reports the last user and assistant turn", async () => {
    const homeDir = await tempHome("shepherd-hermes-compact-");
    const dbPath = await createStateDb(homeDir);
    session(dbPath, "s1", "/tmp/x");
    insert(dbPath, [
      { content: "first ask", role: "user", sessionId: "s1", timestamp: T0 },
      { content: "first answer", role: "assistant", sessionId: "s1", timestamp: T0 + 1 },
      { content: "second ask", role: "user", sessionId: "s1", timestamp: T0 + 2 },
      { content: "second answer", role: "assistant", sessionId: "s1", timestamp: T0 + 3 },
    ]);

    const compact = await new HermesHistoryReader().readCompact(ref(dbPath, "s1"));

    expect(compact.lastUserMessage?.text).toBe("second ask");
    expect(compact.lastAssistantMessage?.text).toBe("second answer");
    expect(compact.messageCount).toBe(4);
    expect(compact.source).toBe("hermes-sqlite");
  });

  test("fails closed without a session id, and survives a missing database", async () => {
    const homeDir = await tempHome("shepherd-hermes-closed-");
    const dbPath = await createStateDb(homeDir);
    const reader = new HermesHistoryReader();

    expect(reader.canRead(ref(dbPath, ""))).toBe(false);
    expect(await reader.read(ref(dbPath, ""))).toEqual([]);
    expect(await reader.read(ref(join(homeDir, "nope.db"), "s1"))).toEqual([]);
  });

  test("session revision advances only for the session that changed", async () => {
    const homeDir = await tempHome("shepherd-hermes-rev-");
    const dbPath = await createStateDb(homeDir);
    session(dbPath, "s1", "/tmp/x");
    session(dbPath, "s2", "/tmp/x");
    insert(dbPath, [{ content: "a", role: "user", sessionId: "s1", timestamp: T0 }]);

    const before = hermesSessionRevision(dbPath, "s1");

    // Unrelated traffic would move the file mtime, but must not move s1.
    insert(dbPath, [{ content: "b", role: "user", sessionId: "s2", timestamp: T0 + 1 }]);
    expect(hermesSessionRevision(dbPath, "s1")).toBe(before);

    insert(dbPath, [{ content: "c", role: "user", sessionId: "s1", timestamp: T0 + 2 }]);
    expect(hermesSessionRevision(dbPath, "s1")).not.toBe(before);
  });
});

describe("Hermes discovery", () => {
  test("resolves an exact session id to the state store", async () => {
    const homeDir = await tempHome("shepherd-hermes-disc-");
    const dbPath = await createStateDb(homeDir);
    session(dbPath, "20260822_115251_c80507", "/Users/ray/dev/driffs");

    const found = discoverHermesSession({ homeDir, sessionId: "20260822_115251_c80507" });

    expect(found).toEqual({
      kind: "agent_session",
      path: dbPath,
      source: "hermes-sqlite",
      value: "20260822_115251_c80507",
    });
  });

  test("refuses to guess between sessions sharing one cwd", async () => {
    const homeDir = await tempHome("shepherd-hermes-ambig-");
    const dbPath = await createStateDb(homeDir);
    // The real machine has 92 sessions on this cwd.
    session(dbPath, "s1", "/Users/ray/dev/driffs");
    session(dbPath, "s2", "/Users/ray/dev/driffs");
    session(dbPath, "s3", "/Users/ray/dev/driffs");

    // No id reported by the pane -> no history, rather than the wrong worker.
    const found = await discoverAgentHistory({
      agent: "hermes",
      agentSession: null,
      cwd: "/Users/ray/dev/driffs",
      foregroundCwd: null,
      homeDir,
    });

    expect(found).toBeNull();
    expect(discoverHermesSession({ homeDir, sessionId: "unknown-id" })).toBeNull();
  });

  test("routes a hermes pane session ref to the hermes-sqlite source", async () => {
    const homeDir = await tempHome("shepherd-hermes-route-");
    const dbPath = await createStateDb(homeDir);
    session(dbPath, "s1", "/tmp/x");

    const found = await discoverAgentHistory({
      agent: "hermes",
      agentSession: { agent: "hermes", kind: "id", source: "herdr:hermes", value: "s1" },
      cwd: "/tmp/x",
      foregroundCwd: null,
      homeDir,
    });

    expect(found?.source).toBe("hermes-sqlite");
    expect(found?.value).toBe("s1");
  });
});
