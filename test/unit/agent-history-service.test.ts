import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { CodexHistoryReader } from "@/agent-history/codex-reader.js";
import type { AgentHistoryLookupInput } from "@/agent-history/discovery.js";
import { GeminiHistoryReader } from "@/agent-history/gemini-reader.js";
import { HermesHistoryReader } from "@/agent-history/hermes-reader.js";
import { OpenCodeHistoryReader } from "@/agent-history/opencode-reader.js";
import type { AgentHistoryReader } from "@/agent-history/readers.js";
import {
  agentHistoryFormatterVersion,
  cacheSourcePathForRef,
  createAgentHistoryService,
  emptyCompactHistory,
} from "@/agent-history/service.js";
import { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import type { AgentHistoryRef } from "@/observability/contracts.js";

const tempDirs: string[] = [];
const lookup: AgentHistoryLookupInput = {
  agent: "pi",
  agentSession: null,
  cwd: "/repo",
  foregroundCwd: null,
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function sourceFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shepy-history-service-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, "history\\n");
  return path;
}

function ref(path: string, source: AgentHistoryRef["source"] = "pi-jsonl"): AgentHistoryRef {
  return { kind: "discovered_file", path, source, value: path };
}

function reader(input: { failCompact?: boolean; failRead?: boolean } = {}) {
  const compactRefs: AgentHistoryRef[] = [];
  const readRefs: AgentHistoryRef[] = [];
  const fake: AgentHistoryReader = {
    canRead: (historyRef) =>
      historyRef.source === "pi-jsonl" || historyRef.source === "opencode-sqlite",
    async read(historyRef) {
      readRefs.push(historyRef);
      if (input.failRead) throw new Error("read failed");
      return [{ ref: "entry", role: "assistant", text: "done", timestamp: null }];
    },
    async readCompact(historyRef) {
      compactRefs.push(historyRef);
      if (input.failCompact) throw new Error("compact failed");
      return {
        ...emptyCompactHistory(historyRef.source),
        historyRef,
        lastAssistantMessage: { ref: "entry", text: "done", timestamp: null },
      };
    },
  };
  return { compactRefs, fake, readRefs };
}

function service(input: {
  cache?: Pick<AgentHistoryCacheStore, "getFresh" | "put">;
  discovered: AgentHistoryRef | null;
  reader?: ReturnType<typeof reader>;
}) {
  const fakeReader = input.reader ?? reader();
  let discoveries = 0;
  return {
    discoveries: () => discoveries,
    reader: fakeReader,
    service: createAgentHistoryService({
      ...(input.cache ? { cache: input.cache } : {}),
      discover: async () => {
        discoveries += 1;
        return input.discovered;
      },
      readers: [fakeReader.fake],
    }),
  };
}

describe("agent history service", () => {
  test("an exact session path overrides another same-cwd agent's cached history", async () => {
    const ownerPath = await sourceFile("owner.jsonl");
    const workerPath = await sourceFile("worker.jsonl");
    for (const [path, text] of [
      [ownerPath, "OWNER ONLY"],
      [workerPath, "WORKER ONLY"],
    ] as const) {
      await writeFile(
        path,
        `${JSON.stringify({
          type: "message",
          id: "reply",
          message: { role: "assistant", content: [{ type: "text", text }] },
        })}\n`,
      );
    }
    const realService = createAgentHistoryService();
    const worker = {
      ...lookup,
      agentSession: { agent: "pi", kind: "path" as const, source: "herdr:pi", value: workerPath },
    };
    const preferredRef = ref(ownerPath);

    const compact = await realService.resolveCompactHistory(worker, { preferredRef });
    expect(compact.compactHistory.lastAssistantMessage?.text).toBe("WORKER ONLY");
    expect(compact.historyRef?.path).toBe(workerPath);
    const full = await realService.read(worker, { limit: 1, preferredRef });
    expect(full.messages.map((message) => message.text)).toEqual(["WORKER ONLY"]);
    expect(full.historyRef?.path).toBe(workerPath);

    await rm(workerPath);
    expect(
      (await realService.resolveCompactHistory(worker, { preferredRef })).historyRef,
    ).toBeNull();
    expect(await realService.read(worker, { limit: 1, preferredRef })).toEqual({
      historyRef: null,
      messages: [],
    });
  });

  test("reads a valid preferred ref without discovery and returns its file fingerprint", async () => {
    const path = await sourceFile("preferred.jsonl");
    const preferred = ref(path);
    const fixture = service({ discovered: null });

    const result = await fixture.service.resolveCompactHistory(lookup, { preferredRef: preferred });

    const stats = await stat(path);
    expect(fixture.discoveries()).toBe(0);
    expect(fixture.reader.compactRefs).toEqual([preferred]);
    expect(result).toMatchObject({
      compactHistory: { historyRef: preferred },
      historyRef: preferred,
      sourceFingerprint: { path, mtimeMs: Math.trunc(stats.mtimeMs), size: stats.size },
    });
  });

  test("returns a fresh cached compact history without reading its preferred ref", async () => {
    const path = await sourceFile("cached.jsonl");
    const preferred = ref(path);
    const cached = { ...emptyCompactHistory("pi-jsonl"), historyRef: preferred, messageCount: 4 };
    const fixture = service({
      cache: {
        getFresh: () => ({ compactHistory: cached }) as never,
        put: () => undefined as never,
      },
      discovered: null,
    });

    const result = await fixture.service.resolveCompactHistory(lookup, { preferredRef: preferred });

    expect(result.compactHistory).toEqual(cached);
    expect(fixture.reader.compactRefs).toEqual([]);
    expect(fixture.discoveries()).toBe(0);
  });

  test("force discovery ignores the preferred ref", async () => {
    const preferred = ref(await sourceFile("preferred.jsonl"));
    const discovered = ref(await sourceFile("discovered.jsonl"));
    const fixture = service({ discovered });

    const result = await fixture.service.resolveCompactHistory(lookup, {
      forceDiscovery: true,
      preferredRef: preferred,
    });

    expect(fixture.discoveries()).toBe(1);
    expect(fixture.reader.compactRefs).toEqual([discovered]);
    expect(result.historyRef).toEqual(discovered);
  });

  test("returns empty history when a direct ref source has disappeared", async () => {
    const fixture = service({ discovered: null });
    const result = await fixture.service.readCompactRef(
      ref(join(tmpdir(), "missing-history.jsonl")),
    );

    expect(result).toEqual({
      compactHistory: emptyCompactHistory("pi-jsonl"),
      historyRef: null,
      sourceFingerprint: null,
    });
  });

  test("uses the OpenCode DB path for fingerprints while preserving the session id", async () => {
    const path = await sourceFile("opencode.db");
    const preferred: AgentHistoryRef = {
      kind: "discovered_file",
      path,
      source: "opencode-sqlite",
      value: "session-a",
    };
    const fixture = service({ discovered: null });

    const result = await fixture.service.readCompactRef(preferred);

    expect(result.historyRef).toEqual(preferred);
    expect(result.sourceFingerprint?.path).toBe(path);
    expect(result.compactHistory.historyRef?.value).toBe("session-a");
  });

  test("uses a preferred ref for live reads and falls back once when it is missing", async () => {
    const preferred = ref(await sourceFile("preferred.jsonl"));
    const discovered = ref(await sourceFile("discovered.jsonl"));
    const fixture = service({ discovered });

    await expect(
      fixture.service.read(lookup, { limit: 1, preferredRef: preferred }),
    ).resolves.toMatchObject({
      historyRef: preferred,
      messages: [expect.objectContaining({ text: "done" })],
    });
    expect(fixture.discoveries()).toBe(0);
    expect(fixture.reader.readRefs).toEqual([preferred]);

    const missing = ref(join(tmpdir(), "missing-history.jsonl"));
    await expect(
      fixture.service.read(lookup, { limit: 1, preferredRef: missing }),
    ).resolves.toMatchObject({
      historyRef: discovered,
    });
    expect(fixture.discoveries()).toBe(1);
    expect(fixture.reader.readRefs).toEqual([preferred, discovered]);
  });

  test("rediscovers exactly once when a preferred ref is missing or its reader fails", async () => {
    const discovered = ref(await sourceFile("discovered.jsonl"));
    const missingFixture = service({ discovered });
    const missing = ref(join(tmpdir(), "missing-history.jsonl"));

    await expect(
      missingFixture.service.resolveCompactHistory(lookup, { preferredRef: missing }),
    ).resolves.toMatchObject({ historyRef: discovered });
    expect(missingFixture.discoveries()).toBe(1);

    const failedReader = reader({ failCompact: true });
    const failedFixture = service({
      discovered,
      reader: failedReader,
    });
    await expect(
      failedFixture.service.resolveCompactHistory(lookup, {
        preferredRef: ref(await sourceFile("bad.jsonl")),
      }),
    ).resolves.toEqual({
      compactHistory: emptyCompactHistory("pi-jsonl"),
      historyRef: null,
      sourceFingerprint: null,
    });
    expect(failedFixture.discoveries()).toBe(1);
    expect(failedReader.compactRefs).toHaveLength(2);
  });

  test("uses the same one-fallback rule for reader failures during live reads", async () => {
    const preferred = ref(await sourceFile("preferred.jsonl"));
    const discovered = ref(await sourceFile("discovered.jsonl"));
    const fixture = service({ discovered, reader: reader({ failRead: true }) });

    await expect(
      fixture.service.read(lookup, { limit: 1, preferredRef: preferred }),
    ).resolves.toEqual({
      historyRef: null,
      messages: [],
    });
    expect(fixture.discoveries()).toBe(1);
    expect(fixture.reader.readRefs).toEqual([preferred, discovered]);
  });

  test("keeps getCompactHistory as the compatibility compact-history wrapper", async () => {
    const discovered = ref(await sourceFile("discovered.jsonl"));
    const fixture = service({ discovered });

    await expect(fixture.service.getCompactHistory(lookup)).resolves.toEqual({
      ...emptyCompactHistory("pi-jsonl"),
      historyRef: discovered,
      lastAssistantMessage: { ref: "entry", text: "done", timestamp: null },
    });
  });

  test("uses session-specific cache keys for OpenCode DB refs", () => {
    const first: AgentHistoryRef = {
      kind: "discovered_file",
      path: "/tmp/opencode.db",
      source: "opencode-sqlite",
      value: "session-a",
    };
    const second: AgentHistoryRef = { ...first, value: "session-b" };

    expect(cacheSourcePathForRef(first)).toBe("/tmp/opencode.db#session=session-a");
    expect(cacheSourcePathForRef(second)).toBe("/tmp/opencode.db#session=session-b");
  });

  test("bumped formatter version recomputes v1 cache rows instead of serving them", async () => {
    expect(agentHistoryFormatterVersion).toBe("agent-history-v2");
    const path = await sourceFile("cached-v1.jsonl");
    await writeFile(path, `${JSON.stringify({ type: "session", id: "s1" })}\n`);
    const preferred = ref(path);
    const dir = await mkdtemp(join(tmpdir(), "shepy-history-cache-"));
    tempDirs.push(dir);
    const { sqlite } = openSqlite(join(dir, "cache.sqlite"));
    applyMigrations(sqlite, { migrationsFolder: "drizzle" });
    const cache = new AgentHistoryCacheStore(sqlite);
    const stats = await stat(path);
    const fingerprint = {
      formatterVersion: "agent-history-v1",
      sourceMtimeMs: Math.trunc(stats.mtimeMs),
      sourcePath: path,
      sourceSize: stats.size,
    };
    cache.put({
      compactHistory: { ...emptyCompactHistory("pi-jsonl"), messageCount: 99 },
      historyRef: preferred,
      ...fingerprint,
    });
    // The existing getFresh contract: the stored row is fresh only under its
    // own version.
    expect(cache.getFresh({ ...fingerprint, formatterVersion: "agent-history-v1" })).toBeDefined();
    expect(
      cache.getFresh({ ...fingerprint, formatterVersion: agentHistoryFormatterVersion }),
    ).toBeUndefined();

    const fixture = service({ cache, discovered: null });
    const result = await fixture.service.resolveCompactHistory(lookup, { preferredRef: preferred });
    // The v1 blob (messageCount 99) was NOT served; a fresh read happened.
    expect(result.compactHistory.messageCount).toBe(0);
    expect(result.compactHistory.contextHealth).toBeNull();
    expect(fixture.reader.compactRefs).toEqual([preferred]);
    sqlite.close();
  });

  test("readers without a context projection keep contextHealth null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shepy-history-null-projection-"));
    tempDirs.push(dir);

    const codexPath = join(dir, "rollout.jsonl");
    await writeFile(
      codexPath,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "codex done" } })}\n`,
    );
    await expect(
      new CodexHistoryReader().readCompact({
        kind: "discovered_file",
        path: codexPath,
        source: "codex-jsonl",
        value: codexPath,
      }),
    ).resolves.toMatchObject({ contextHealth: null, messageCount: 1 });

    const geminiPath = join(dir, "gemini.json");
    await writeFile(geminiPath, JSON.stringify([{ type: "gemini", content: "gemini done" }]));
    await expect(
      new GeminiHistoryReader().readCompact({
        kind: "discovered_file",
        path: geminiPath,
        source: "gemini-json",
        value: geminiPath,
      }),
    ).resolves.toMatchObject({ contextHealth: null, messageCount: 1 });

    const hermesPath = join(dir, "hermes.db");
    const hermes = new DatabaseSync(hermesPath);
    hermes.exec(
      "create table messages (id integer primary key autoincrement, session_id text not null, role text not null, content text, tool_name text, finish_reason text, timestamp real not null, active integer not null default 1)",
    );
    hermes
      .prepare("insert into messages (session_id, role, content, timestamp) values (?, ?, ?, ?)")
      .run("s1", "assistant", "hermes done", 1);
    hermes.close();
    await expect(
      new HermesHistoryReader().readCompact({
        kind: "discovered_file",
        path: hermesPath,
        source: "hermes-sqlite",
        value: "s1",
      }),
    ).resolves.toMatchObject({ contextHealth: null, messageCount: 1 });

    const openCodePath = join(dir, "opencode.db");
    const openCode = new DatabaseSync(openCodePath);
    openCode.exec(`
      create table session (id text primary key, directory text not null, time_updated integer not null);
      create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
      create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    `);
    openCode
      .prepare("insert into session (id, directory, time_updated) values (?, ?, ?)")
      .run("oc_1", "/repo", 1);
    openCode
      .prepare(
        "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
      )
      .run("m1", "oc_1", 1, 1, JSON.stringify({ role: "assistant" }));
    openCode
      .prepare(
        "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
      )
      .run("p1", "m1", "oc_1", 2, 2, JSON.stringify({ type: "text", text: "opencode done" }));
    openCode.close();
    await expect(
      new OpenCodeHistoryReader().readCompact({
        kind: "discovered_file",
        path: openCodePath,
        source: "opencode-sqlite",
        value: "oc_1",
      }),
    ).resolves.toMatchObject({ contextHealth: null, messageCount: 1 });
  });
});
