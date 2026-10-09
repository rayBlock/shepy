import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { CodexHistoryReader } from "@/agent-history/codex-reader.js";
import { GeminiHistoryReader } from "@/agent-history/gemini-reader.js";
import { OpenCodeHistoryReader } from "@/agent-history/opencode-reader.js";
import { createAgentHistoryService } from "@/agent-history/service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempHome(name: string) {
  const dir = await mkdtemp(join(tmpdir(), name));
  tempDirs.push(dir);
  return dir;
}

describe("CodexHistoryReader", () => {
  test("normalizes native seconds and milliseconds and preserves ISO timestamps", async () => {
    const home = await tempHome("shepy-codex-time-");
    const path = join(home, "rollout.jsonl");
    await writeFile(path, [
      { type: "event_msg", timestamp: "2026-10-09T12:30:00Z", payload: { type: "task_complete", started_at: 1791548209, last_agent_message: "synthetic" } },
      { type: "event_msg", payload: { type: "task_complete", started_at: 1791548209000, last_agent_message: "milliseconds" } },
      { type: "event_msg", timestamp: "2026-10-09T12:00:00.000Z", payload: { type: "agent_message", message: "iso" } },
      { type: "event_msg", payload: { type: "task_complete", started_at: 1e30, last_agent_message: "invalid" } },
    ].map(JSON.stringify).join("\n"));
    const messages = await new CodexHistoryReader().read({ kind: "discovered_file", path, value: path, source: "codex-jsonl" });
    expect(messages.map((message) => message.timestamp)).toEqual([
      "2026-10-09T12:30:00Z", new Date(1791548209000).toISOString(),
      "2026-10-09T12:00:00.000Z", null,
    ]);
  });

  test("binds two same-cwd sessions by id and never uses cumulative or cached tokens as extra fill", async () => {
    const homeDir = await tempHome("shepy-codex-exact-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "10", "09");
    await mkdir(dir, { recursive: true });
    for (const [id, tokens] of [["thread-a", 50424], ["thread-b", 4000]] as const) {
      await writeFile(join(dir, `${id}.jsonl`), [
        { type: "session_meta", timestamp: "2026-10-09T12:00:00Z", payload: { id, cwd: "/same" } },
        { type: "turn_context", timestamp: "2026-10-09T12:00:01Z", payload: { model: "gpt-6" } },
        { type: "event_msg", timestamp: "2026-10-09T12:00:02Z", payload: { type: "token_count", info: {
          last_token_usage: { input_tokens: tokens, cached_input_tokens: id === "thread-a" ? 46848 : 500, output_tokens: 20 },
          total_token_usage: { input_tokens: 390981 }, model_context_window: 258400,
        } } },
      ].map(JSON.stringify).join("\n"));
    }
    const service = createAgentHistoryService({ homeDir });
    for (const [id, tokens] of [["thread-a", 50424], ["thread-b", 4000]] as const) {
      const result = await service.getCompactHistory({ agent: "codex", agentSession: { agent: "codex", kind: "id", value: id, source: "codex" }, cwd: "/same", foregroundCwd: null });
      expect(result.historyRef?.path).toContain(`${id}.jsonl`);
      expect(result.contextHealth).toMatchObject({
        sessionId: id, source: "codex-jsonl", sourceUpdatedAt: "2026-10-09T12:00:02Z",
        model: { id: "gpt-6" }, usage: { current: true, kind: "last_reported", tokens, window: 258400,
          reportedAt: "2026-10-09T12:00:02Z", percent: tokens / 258400 * 100 },
      });
    }
    const wrongPath = join(dir, "thread-b.jsonl");
    expect(await new CodexHistoryReader().read({ kind: "agent_session", source: "codex-jsonl", value: "thread-a", path: wrongPath })).toEqual([]);
    const missing = await service.getCompactHistory({ agent: "codex", agentSession: { agent: "codex", kind: "id", value: "absent", source: "codex" }, cwd: "/same", foregroundCwd: null });
    expect(missing.contextHealth).toBeNull();
  });

  test("absent, malformed and cumulative-only token_count never report fill", async () => {
    const home = await tempHome("shepy-codex-unknown-");
    const path = join(home, "rollout.jsonl");
    const ref = { kind: "discovered_file" as const, path, value: path, source: "codex-jsonl" as const };
    const header = [
      { type: "session_meta", timestamp: "2026-10-09T12:00:00Z", payload: { id: "t" } },
      { type: "turn_context", timestamp: "2026-10-09T12:00:01Z", payload: { model: "gpt-6" } },
    ];
    await writeFile(path, header.map(JSON.stringify).join("\n"));
    expect((await new CodexHistoryReader().readCompact(ref)).contextHealth?.usage).toMatchObject({ current: false, tokens: null, window: null });
    for (const info of [undefined, { total_token_usage: { input_tokens: 4000 }, model_context_window: 258400 },
      { last_token_usage: { input_tokens: "4000" }, model_context_window: 258400 },
      { last_token_usage: { input_tokens: 4000, cached_input_tokens: 5000 }, model_context_window: 258400 }]) {
      await writeFile(path, [...header, { type: "event_msg", timestamp: "2026-10-09T12:00:02Z", payload: { type: "token_count", info } }].map(JSON.stringify).join("\n"));
      expect((await new CodexHistoryReader().readCompact(ref)).contextHealth?.usage).toMatchObject({ current: false, kind: "unavailable", tokens: null, window: null, percent: null });
    }
    await writeFile(path, [header[0], { type: "event_msg", timestamp: "2026-10-09T12:00:02Z", payload: { type: "token_count", info: {
      last_token_usage: { input_tokens: 50424 }, model_context_window: 258400,
    } } }].map(JSON.stringify).join("\n"));
    expect((await new CodexHistoryReader().readCompact(ref)).contextHealth?.usage.current).toBe(false);
    await writeFile(path, [header[0], header[1], { type: "event_msg", timestamp: "invalid", payload: { type: "token_count", info: {
      last_token_usage: { input_tokens: 50424 }, model_context_window: 258400,
    } } }].map(JSON.stringify).join("\n"));
    expect((await new CodexHistoryReader().readCompact(ref)).contextHealth?.usage.current).toBe(false);
  });
  test("reads user, assistant, and tool output messages", async () => {
    const homeDir = await tempHome("shepy-codex-reader-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "07", "09");
    await mkdir(dir, { recursive: true });
    const path = join(
      dir,
      "rollout-2026-07-09T12-00-00-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl",
    );
    await writeFile(
      path,
      `${[
        { type: "session_meta", payload: { cwd: "/repo", timestamp: "2026-07-09T12:00:00.000Z" } },
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "please inspect",
            timestamp: "2026-07-09T12:00:01.000Z",
          },
        },
        {
          type: "response_item",
          payload: { type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" },
        },
        {
          type: "response_item",
          payload: { type: "function_call_output", call_id: "call_1", output: "line 1\nline 2" },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );

    const messages = await new CodexHistoryReader().read(
      { kind: "discovered_file", path, source: "codex-jsonl", value: path },
      { limit: 20 },
    );

    expect(messages.map((message) => message.role)).toEqual(["user", "tool_result", "assistant"]);
    expect(messages[0]).toMatchObject({ role: "user", text: "please inspect" });
    expect(messages[1]).toMatchObject({ role: "tool_result", toolName: "bash" });
    expect(messages[1]?.compact?.text).toContain("line 1");
    expect(messages[2]).toMatchObject({ role: "assistant", text: "done" });
  });

  test("is registered in the default agent history service", async () => {
    const homeDir = await tempHome("shepy-codex-service-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "07", "09");
    await mkdir(dir, { recursive: true });
    const path = join(
      dir,
      "rollout-2026-07-09T13-00-00-dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl",
    );
    await writeFile(
      path,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } })}\n`,
    );

    const service = createAgentHistoryService({ homeDir });
    await expect(
      service.read(
        { agent: "codex", agentSession: null, cwd: "/repo", foregroundCwd: null },
        { limit: 10 },
      ),
    ).resolves.toMatchObject({
      historyRef: { source: "codex-jsonl", path },
      messages: [expect.objectContaining({ role: "user", text: "hello" })],
    });
  });
});

describe("OpenCodeHistoryReader", () => {
  test("reads text and tool parts from an OpenCode SQLite session", async () => {
    const homeDir = await tempHome("shepy-opencode-reader-");
    const dbPath = join(homeDir, "opencode.db");
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(`
      create table session (id text primary key, directory text not null, time_updated integer not null);
      create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
      create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    `);
    sqlite
      .prepare("insert into session (id, directory, time_updated) values (?, ?, ?)")
      .run("s1", "/repo", 1000);
    sqlite
      .prepare(
        "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
      )
      .run("m1", "s1", 1000, 1000, JSON.stringify({ role: "user" }));
    sqlite
      .prepare(
        "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
      )
      .run("p1", "m1", "s1", 1001, 1001, JSON.stringify({ type: "text", text: "inspect this" }));
    sqlite
      .prepare(
        "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
      )
      .run("m2", "s1", 2000, 2000, JSON.stringify({ role: "assistant", finish: "tool-calls" }));
    sqlite
      .prepare(
        "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "p2",
        "m2",
        "s1",
        2001,
        2001,
        JSON.stringify({
          type: "tool",
          tool: "bash",
          state: { status: "completed", output: "ok" },
        }),
      );
    sqlite
      .prepare(
        "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
      )
      .run("p3", "m2", "s1", 2002, 2002, JSON.stringify({ type: "text", text: "done" }));
    sqlite.close();

    const messages = await new OpenCodeHistoryReader().read(
      { kind: "discovered_file", path: dbPath, source: "opencode-sqlite", value: "s1" },
      { limit: 10 },
    );

    expect(messages.map((message) => message.role)).toEqual(["user", "tool_result", "assistant"]);
    expect(messages[0]).toMatchObject({ role: "user", text: "inspect this" });
    expect(messages[1]).toMatchObject({ role: "tool_result", toolName: "bash" });
    expect(messages[1]?.compact?.text).toContain("ok");
    expect(messages[2]).toMatchObject({ role: "assistant", text: "done" });
  });

  test("returns empty history when the OpenCode DB schema is unreadable", async () => {
    const homeDir = await tempHome("shepy-opencode-bad-db-");
    const dbPath = join(homeDir, "opencode.db");
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec("create table unrelated (id text primary key)");
    sqlite.close();

    await expect(
      new OpenCodeHistoryReader().read(
        { kind: "discovered_file", path: dbPath, source: "opencode-sqlite", value: "s1" },
        { limit: 10 },
      ),
    ).resolves.toEqual([]);
  });
});

describe("GeminiHistoryReader", () => {
  test("reads user and gemini assistant messages from object-shaped session JSON", async () => {
    const homeDir = await tempHome("shepy-gemini-reader-");
    const projectDir = join(homeDir, ".gemini", "tmp", "repo-project");
    const chatsDir = join(projectDir, "chats");
    await mkdir(chatsDir, { recursive: true });
    const sessionPath = join(chatsDir, "session-2026-07-09T12-00-00abcdef.json");
    await writeFile(
      sessionPath,
      JSON.stringify({
        sessionId: "g1",
        messages: [
          {
            id: "u1",
            timestamp: "2026-07-09T12:00:00.000Z",
            type: "user",
            content: [{ text: "please check" }],
          },
          { id: "a1", timestamp: "2026-07-09T12:00:01.000Z", type: "gemini", content: "checked" },
          { id: "i1", timestamp: "2026-07-09T12:00:02.000Z", type: "info", content: "ignored" },
        ],
      }),
    );

    const messages = await new GeminiHistoryReader().read(
      { kind: "discovered_file", path: sessionPath, source: "gemini-json", value: sessionPath },
      { limit: 10 },
    );

    expect(messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "please check",
        timestamp: "2026-07-09T12:00:00.000Z",
      }),
      expect.objectContaining({
        role: "assistant",
        text: "checked",
        timestamp: "2026-07-09T12:00:01.000Z",
      }),
    ]);
  });

  test("reads tool result messages when Gemini session records tool output", async () => {
    const homeDir = await tempHome("shepy-gemini-tool-");
    const sessionPath = join(homeDir, "session.json");
    await writeFile(
      sessionPath,
      JSON.stringify({
        messages: [
          {
            id: "t1",
            timestamp: "2026-07-09T12:00:03.000Z",
            type: "tool",
            tool: "shell",
            content: "ok",
          },
        ],
      }),
    );

    const messages = await new GeminiHistoryReader().read(
      { kind: "discovered_file", path: sessionPath, source: "gemini-json", value: sessionPath },
      { limit: 10 },
    );

    expect(messages).toEqual([expect.objectContaining({ role: "tool_result", toolName: "shell" })]);
    expect(messages[0]?.compact?.text).toContain("ok");
  });

  test("returns empty history when Gemini session JSON is malformed", async () => {
    const homeDir = await tempHome("shepy-gemini-bad-json-");
    const sessionPath = join(homeDir, "session.json");
    await writeFile(sessionPath, "{not-json");

    await expect(
      new GeminiHistoryReader().read(
        { kind: "discovered_file", path: sessionPath, source: "gemini-json", value: sessionPath },
        { limit: 10 },
      ),
    ).resolves.toEqual([]);
  });
});
