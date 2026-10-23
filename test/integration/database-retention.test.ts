import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import {
  agentHistoryFormatterVersion,
  createAgentHistoryService,
} from "@/agent-history/service.js";
import { parseCliArgs, runCliCommand } from "@/cli/shepy.js";
import { ObservabilityRpcServer } from "@/daemon/observability-server.js";
import { DeliveryObligationStore } from "@/db/delivery-obligations.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { RetentionStore, runRetention } from "@/db/retention.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import type { CompactAgentHistory } from "@/observability/contracts.js";
import { projectOutcomeContext } from "@/observability/outcome-context.js";
import { projectInboxOutcome } from "@/observability/profile-delivery-service.js";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";
import { RpcTestClient } from "./rpc-test-client.js";

const NOW = Date.parse("2026-10-23T00:00:00Z");
const DAY = 86_400_000;
const history: CompactAgentHistory = {
  contextHealth: null,
  historyRef: null,
  lastAssistantMessage: {
    ref: "session#final",
    text: "finished",
    timestamp: new Date(NOW).toISOString(),
  },
  lastToolResult: null,
  lastUserMessage: null,
  messageCount: 1,
  source: "pi-jsonl",
  updatedAt: new Date(NOW).toISOString(),
};

afterEach(cleanupTempDirs);

function fixture() {
  const db = openObservabilityDbHarness();
  db.herdrSessions.upsertRunning({
    name: "fixture",
    sessionDir: "/fixture",
    socketPath: "/fixture/no.sock",
  });
  db.agents.replaceForSession({
    herdrSessionName: "fixture",
    agents: [
      {
        agent: "pi",
        pane_id: "w1:p1",
        terminal_id: "worker",
        workspace_id: "w1",
        agent_status: "done",
        focused: false,
      },
    ],
  });
  const agentId = db.agents.list()[0]?.id;
  if (!agentId) throw new Error("missing fixture agent");
  const append = (
    age: number,
    type: "agent.done" | "agent.status.changed" = "agent.status.changed",
    workspaceId = "w1",
  ) => {
    const event = db.agentEvents.append({
      agentId,
      herdrSessionName: "fixture",
      workspaceId,
      terminalId: "worker",
      type,
      payload: { from: "working", to: "done", agent: "pi" },
      compactHistory: history,
    });
    db.sqlite
      .prepare("update agent_events set created_at = ? where id = ?")
      .run(NOW - age, event.id);
    return event.id;
  };
  return { ...db, append, agentId };
}

test("only old unreferenced snapshots expire; every obligation state, owned cursor and latest settled event are protected", async () => {
  const db = fixture();
  try {
    const old = db.append(8 * DAY, "agent.done");
    const latest = db.append(8 * DAY, "agent.done");
    const recent = db.append(DAY);
    const boundary = db.append(7 * DAY);
    const protectedIds: number[] = [];
    const profiles = new OrchestratorProfileStore(db.sqlite);
    profiles.createProfile({ profileId: "fixture-seat", displayName: "fixture", projectRoots: [] });
    const subscription = profiles.addSubscription({
      profileId: "fixture-seat",
      herdrSessionName: "fixture",
      agentSelectorJson: JSON.stringify({ kind: "terminalId", value: "worker" }),
      workspaceSelectorJson: JSON.stringify({ herdrSession: "fixture", workspaceId: "w1" }),
    });
    const obligations = new DeliveryObligationStore(db.sqlite);
    for (const state of ["pending", "leased", "delivered", "acked", "dead_letter"]) {
      const id = db.append(8 * DAY);
      protectedIds.push(id);
      const obligation = obligations.project({
        profileId: "fixture-seat",
        subscriptionId: subscription.id,
        agentEventId: id,
      });
      if (!obligation) throw new Error("missing fixture obligation");
      db.sqlite
        .prepare("update delivery_obligations set state = ? where id = ?")
        .run(state, obligation.id);
    }
    const source = db.append(8 * DAY);
    obligations.projectSourceEntry({
      profileId: "fixture-seat",
      subscriptionId: subscription.id,
      agentEventId: source,
      sourceEntryId: "entry",
      contentSha256: "fixture-sha",
    });
    // Projection stamps remain event references even without an obligation.
    db.sqlite.prepare("delete from delivery_obligations where agent_event_id = ?").run(source);
    const cursor = db.append(8 * DAY);
    db.agentOrchestratorScopes.claim({
      herdrSessionName: "fixture",
      workspaceId: "w1",
      ackedEventId: cursor,
      paneId: "w1:p0",
      terminalId: "seat",
    });
    const unread = db.append(8 * DAY);
    const otherWorkspace = db.append(8 * DAY, "agent.status.changed", "w2");
    const beforeObligations = db.sqlite.prepare("select * from delivery_obligations").all();
    const result = await runRetention(db.sqlite, { now: NOW, batchSize: 2, pauseMs: 0 });
    expect(result.eventRows).toBe(2);
    expect(result.estimatedBytesFreed).toBeGreaterThan(0);
    for (const id of [old, otherWorkspace])
      expect(db.agentEvents.get(id).compactHistory).toBeNull();
    for (const id of [latest, recent, boundary, source, cursor, unread, ...protectedIds])
      expect(db.agentEvents.get(id).compactHistory).toEqual(history);
    expect(db.sqlite.prepare("select * from delivery_obligations").all()).toEqual(
      beforeObligations,
    );
    // The timeline and payload survive; all event-store readers and context projection accept null.
    const expired = db.agentEvents.get(old);
    expect(expired.payload).toEqual({ from: "working", to: "done", agent: "pi" });
    expect(db.agentEvents.listAfter({})).toHaveLength(13);
    expect(db.agentEvents.outcomesForAgent(db.agentId)[0]?.compactHistory).toBeNull();
    expect(db.agentEvents.findPriorSettledEvent(db.agentId, latest)?.compactHistory).toBeNull();
    expect(projectOutcomeContext(expired)).toMatchObject({ state: "unavailable", tokens: null });
    expect(projectInboxOutcome(expired)).toMatchObject({
      excerpt: null,
      lastAssistantRef: null,
      context: { state: "unavailable" },
    });
    const reader = createAgentHistoryService({ discover: async () => null });
    const orchestrator = new AgentOrchestratorService({
      agentEvents: db.agentEvents,
      agents: db.agents,
      scopes: db.agentOrchestratorScopes,
    });
    expect(
      orchestrator
        .pending({ herdrSessionName: "fixture", workspaceId: "w1", terminalId: "seat" })
        .map((event) => event.id),
    ).toEqual([unread]);
    const path = (db.sqlite.prepare("pragma database_list").get() as { file: string }).file;
    const socketPath = join(dirname(path), "retention.sock");
    const server = new ObservabilityRpcServer({
      context: new AgentContextService({
        history: reader,
        stores: { agents: db.agents, agentContextSnapshots: db.agentContextSnapshots },
      }),
      history: reader,
      orchestrator,
      socketPath,
      stores: db,
    });
    await server.start();
    const client = await RpcTestClient.connect(socketPath);
    try {
      const wire = (await client.request("agent.events", { herdrSessionName: "fixture" })) as {
        events: {
          id: number;
          compactHistory: CompactAgentHistory | null;
          outcomeContext: { state: string };
        }[];
      };
      expect(wire.events.find((event) => event.id === old)).toMatchObject({
        compactHistory: null,
        outcomeContext: { state: "unavailable" },
      });
      expect(wire.events.find((event) => event.id === protectedIds[0])?.compactHistory).toEqual(
        history,
      );
    } finally {
      client.close();
      await server.stop();
    }
    // Also cover a legacy delivered row whose snapshot was already null.
    obligations.project({
      profileId: "fixture-seat",
      subscriptionId: subscription.id,
      agentEventId: old,
    });
    db.sqlite
      .prepare(
        "update delivery_obligations set state = 'acked', delivered_at = ? where agent_event_id = ?",
      )
      .run(NOW, old);
    expect(
      obligations.recentDeliveredFinals({
        profileId: "fixture-seat",
        subscriptionId: subscription.id,
        since: 0,
      }),
    ).toEqual([]);
  } finally {
    db.sqlite.close();
  }
});

test("dry-run changes nothing; bounded batches resume without skipping rows or deleting the current cache", async () => {
  const db = fixture();
  try {
    const ids = Array.from({ length: 5 }, () => db.append(8 * DAY));
    for (const formatterVersion of [
      "agent-history-v1",
      "agent-history-v2",
      agentHistoryFormatterVersion,
    ])
      db.agentHistoryCache.put({
        compactHistory: history,
        formatterVersion,
        historyRef: { kind: "agent_session", source: "pi-jsonl", value: "/fixture/session" },
        sourcePath: "/fixture/session",
        sourceMtimeMs: 1,
        sourceSize: 1,
      });
    const dump = () =>
      JSON.stringify([
        db.sqlite.prepare("select * from agent_events").all(),
        db.sqlite.prepare("select * from agent_history_cache").all(),
      ]);
    const before = dump();
    const dry = await runRetention(db.sqlite, { now: NOW, dryRun: true, batchSize: 2, pauseMs: 0 });
    expect(dry).toMatchObject({ eventRows: 5, cacheRows: 2, complete: true });
    expect(dump()).toBe(before);
    const store = new RetentionStore(db.sqlite);
    const initial = store.begin(NOW);
    const appendedDuringRun = db.append(8 * DAY, "agent.status.changed", "w2");
    const first = store.batch(initial, { batchSize: 2 });
    expect(first).toMatchObject({ eventRows: 2, scannedRows: 2, complete: false });
    expect(ids.filter((id) => db.agentEvents.get(id).compactHistory === null)).toHaveLength(2);
    // A reference arriving between batches is checked in the write transaction.
    db.agentOrchestratorScopes.claim({
      herdrSessionName: "fixture",
      workspaceId: "w1",
      ackedEventId: ids[2] ?? 0,
      paneId: "w1:p0",
      terminalId: "seat",
    });
    let cursor = first.cursor;
    let complete = false;
    while (!complete) {
      const batch = store.batch(cursor, { batchSize: 2 });
      expect(batch.scannedRows).toBeLessThanOrEqual(2);
      cursor = batch.cursor;
      complete = batch.complete;
    }
    expect(db.agentEvents.get(ids[2] ?? 0).compactHistory).toEqual(history);
    expect(db.sqlite.prepare("select formatter_version from agent_history_cache").all()).toEqual([
      { formatter_version: agentHistoryFormatterVersion },
    ]);
    // The finite high-water mark did not chase a concurrently appended row.
    expect(db.agentEvents.get(appendedDuringRun).compactHistory).toEqual(history);
    expect((await runRetention(db.sqlite, { now: NOW, pauseMs: 0 })).eventRows).toBe(1);
    expect((await runRetention(db.sqlite, { now: NOW, pauseMs: 0 })).eventRows).toBe(0);
  } finally {
    db.sqlite.close();
  }
});

test("an exclusive writer cannot impose the normal five-second timeout on run startup", async () => {
  const db = fixture();
  const path = (db.sqlite.prepare("pragma database_list").get() as { file: string }).file;
  try {
    db.append(8 * DAY);
    const writer = new DatabaseSync(path);
    writer.exec("begin exclusive");
    try {
      const started = performance.now();
      await expect(runRetention(db.sqlite, { now: NOW })).rejects.toThrow("database is locked");
      expect(performance.now() - started).toBeLessThan(1000);
      expect(db.sqlite.prepare("pragma busy_timeout").get()).toMatchObject({ timeout: 5000 });
    } finally {
      writer.exec("rollback");
      writer.close();
    }
    expect((await runRetention(db.sqlite, { now: NOW })).eventRows).toBe(1);
  } finally {
    db.sqlite.close();
  }
});

test("CLI parses maintenance flags strictly and dry-run uses the database without connecting to a daemon", async () => {
  expect(parseCliArgs(["db", "retain", "--dry-run"])).toEqual({
    command: "db-retain",
    dryRun: true,
    vacuum: false,
  });
  expect(() => parseCliArgs(["db", "retain", "--dry-run", "--vacuum"])).toThrow();
  expect(() => parseCliArgs(["db", "retain", "--unknown"])).toThrow();
  const db = fixture();
  try {
    const id = db.append(8 * DAY);
    const output: string[] = [];
    const path = (db.sqlite.prepare("pragma database_list").get() as { file: string }).file;
    await runCliCommand(parseCliArgs(["db", "retain", "--dry-run"]), {
      dbPath: path,
      connect: async () => {
        throw new Error("must not contact daemon");
      },
      output: (line) => output.push(line),
      socketPath: "/not-used",
    });
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      dryRun: true,
      eventRows: 1,
      vacuumed: false,
    });
    expect(db.agentEvents.get(id).compactHistory).toEqual(history);
    await expect(
      runCliCommand(parseCliArgs(["db", "retain"]), {
        dbPath: `${path}.missing`,
        connect: async () => {
          throw new Error("must not connect");
        },
        output: () => {},
        socketPath: "/not-used",
      }),
    ).rejects.toThrow("database not found");
  } finally {
    db.sqlite.close();
  }
});
