import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { parseCliArgs, runCliCommand } from "@/cli/shepy.js";
import { ObservabilityRpcClient } from "@/daemon/client.js";
import { ObservabilityRpcServer } from "@/daemon/observability-server.js";
import { AgentContextSnapshotStore } from "@/db/agent-context-snapshots.js";
import { AgentEventStore } from "@/db/agent-events.js";
import { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import { AgentOrchestratorScopeStore } from "@/db/agent-orchestrator-scopes.js";
import { AgentStore } from "@/db/agents.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { DeliveryObligationStore } from "@/db/delivery-obligations.js";
import { HerdrSessionStore } from "@/db/herdr-sessions.js";
import { HerdrWorkspaceStore } from "@/db/herdr-workspaces.js";
import {
  OrchestratorProfileStore,
  type ProfileSubscriptionRecord,
} from "@/db/orchestrator-profiles.js";
import { ProfileOwnerStore } from "@/db/profile-owners.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import { AgentIndexService } from "@/observability/agent-index-service.js";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import type { AgentSessionRef } from "@/observability/contracts.js";
import { ProfileDeliveryService } from "@/observability/profile-delivery-service.js";
import { ProfileService } from "@/observability/profile-service.js";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const session = (value: string): AgentSessionRef => ({
  agent: "pi",
  kind: "path",
  source: "herdr:pi",
  value,
});
const firstSession = session("/fixture/first.jsonl");
const nextSession = session("/fixture/replacement.jsonl");
function worker(overrides: Record<string, unknown> = {}) {
  return {
    pane_id: "wA:p1",
    terminal_id: "term_1",
    workspace_id: "wA",
    agent: "pi",
    name: "builder",
    agent_status: "working",
    focused: false,
    cwd: "/fixture",
    agent_session: firstSession,
    ...overrides,
  };
}

type Show = {
  subscriptions: ProfileSubscriptionRecord[];
  resolutions: Array<{
    kind: string;
    bindingState?: string;
    agent?: { paneId: string; terminalId: string; workspaceId: string };
    detail?: string;
    expectedSessionId?: string;
    actualSessionId?: string;
  }>;
};

async function fixture(initial: ReturnType<typeof worker>[] = [worker()]) {
  const dir = mkdtempSync(join(tmpdir(), "s3-"));
  const herdrPath = join(dir, "h.sock");
  const rpcPath = join(dir, "shepy.sock");
  let rows = initial;
  let paneReply: unknown;
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const herdr = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk) => {
      for (const line of decoder.push(chunk.toString("utf8"))) {
        const request = line as { id: string; method: string; params?: { pane_id?: string } };
        requests.push(request.method);
        if (request.method === "pane.get") {
          const pane = rows.find((row) => row.pane_id === request.params?.pane_id);
          socket.write(
            encodeJsonLine(
              paneReply !== undefined
                ? { id: request.id, result: paneReply }
                : pane
                  ? { id: request.id, result: { type: "pane", pane } }
                  : { id: request.id, error: { code: "not_found", message: "pane not found" } },
            ),
          );
        } else if (request.method === "session.snapshot") {
          socket.write(
            encodeJsonLine({
              id: request.id,
              result: {
                type: "session_snapshot",
                snapshot: {
                  protocol: 16,
                  version: "0.9.3",
                  panes: rows,
                  agents: rows.filter((row) => row.agent !== null),
                  tabs: [],
                  workspaces: [{ workspace_id: "wA", focused: true }],
                },
              },
            }),
          );
        } else {
          socket.write(
            encodeJsonLine({
              id: request.id,
              error: { code: "invalid_request", message: request.method },
            }),
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) => herdr.listen(herdrPath, resolve));
  let daemon = await openDaemon();
  cleanups.push(async () => {
    await daemon.server.stop();
    daemon.sqlite.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => herdr.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  async function openDaemon() {
    const { sqlite } = openSqlite(join(dir, "db.sqlite"));
    applyMigrations(sqlite, { migrationsFolder: "drizzle" });
    const agents = new AgentStore(sqlite);
    const agentEvents = new AgentEventStore(sqlite);
    const herdrSessions = new HerdrSessionStore(sqlite);
    const herdrWorkspaces = new HerdrWorkspaceStore(sqlite);
    herdrSessions.upsertRunning({ name: "default", sessionDir: dir, socketPath: herdrPath });
    const profiles = new OrchestratorProfileStore(sqlite);
    profiles.createProfile({ profileId: "seat", displayName: "seat", projectRoots: [] });
    const history = createAgentHistoryService({
      cache: new AgentHistoryCacheStore(sqlite),
      homeDir: dir,
    });
    const context = new AgentContextService({
      history,
      stores: { agents, agentContextSnapshots: new AgentContextSnapshotStore(sqlite) },
    });
    const service = new ProfileService({ agents, history, profiles });
    const delivery = new ProfileDeliveryService({
      agents,
      agentEvents,
      profiles,
      owners: new ProfileOwnerStore({ sqlite }),
      obligations: new DeliveryObligationStore(sqlite),
    });
    const index = new AgentIndexService({
      context,
      onAgentsObserved: (observed) => service.observeAgents(observed),
      stores: { agents, agentEvents, herdrSessions, herdrWorkspaces },
    });
    const server = new ObservabilityRpcServer({
      context,
      history,
      profiles: service,
      delivery,
      registerPiSessionRef: (input) => index.registerPiSessionRef(input),
      orchestrator: new AgentOrchestratorService({
        agents,
        agentEvents,
        scopes: new AgentOrchestratorScopeStore(sqlite),
      }),
      socketPath: rpcPath,
      stores: { agents, agentEvents, herdrSessions, herdrWorkspaces },
    });
    await server.start();
    return { sqlite, agents, agentEvents, profiles, service, delivery, index, server, context };
  }

  async function cli(args: string[]) {
    const output: string[] = [];
    await runCliCommand(parseCliArgs([...args, "--json"]), {
      connect: async () => new ObservabilityRpcClient({ socketPath: rpcPath }),
      socketPath: rpcPath,
      homeDir: dir,
      environment: {},
      output: (line) => output.push(line),
    });
    return JSON.parse(output.join("\n"));
  }
  return {
    cli,
    requests,
    get daemon() {
      return daemon;
    },
    setRows(next: typeof rows) {
      rows = next;
    },
    paneReply(reply: unknown) {
      paneReply = reply;
    },
    diskBytes() {
      return ["", "-wal", "-shm", "-journal"].reduce((total, suffix) => {
        const path = join(dir, `db.sqlite${suffix}`);
        return total + (existsSync(path) ? statSync(path).size : 0);
      }, 0);
    },
    async cliProcess(args: string[]) {
      const runtime = mkdtempSync(join(dir, "cli-"));
      mkdirSync(join(runtime, "h"));
      mkdirSync(join(runtime, "t"));
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "src/cli/shepy.ts", ...args, "--json"],
        {
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: join(runtime, "h"),
            TMPDIR: join(runtime, "t"),
            SHEPY_HOME: dir,
          },
        },
      );
      return JSON.parse(stdout) as unknown;
    },
    async registerPi(sessionRef: AgentSessionRef) {
      const client = new ObservabilityRpcClient({ socketPath: rpcPath });
      try {
        return await client.request("agent.orchestrator.register", {
          herdrSocketPath: herdrPath,
          paneId: "wA:p1",
          workspaceId: "wA",
          sessionRef,
          subscriberId: "fixture-pi",
          subscriberKind: "pi",
        });
      } finally {
        client.close();
      }
    },
    subscribe: (selector = ["--pane", "wA:p1"]) =>
      cli(["profile", "subscribe", "seat", "--workspace", "wA", ...selector]),
    show: () => cli(["profile", "show", "seat"]) as Promise<Show>,
    async refresh() {
      const result = await daemon.index.refreshHerdrSession({
        herdrSessionName: "default",
        sessionDir: dir,
        socketPath: herdrPath,
      });
      // Same publication boundary used by HerdrSessionWatchManager.
      daemon.server.reconcileAgentLocations({ ...result, herdrSessionName: "default" });
      for (const event of result.events) daemon.delivery.projectAgentEvent(event);
    },
    async restart() {
      await daemon.server.stop();
      daemon.sqlite.close();
      daemon = await openDaemon();
    },
    finish(pane = "wA:p1") {
      const row = daemon.agents.findByPane({ herdrSessionName: "default", paneId: pane });
      if (!row) throw new Error("fixture worker missing");
      daemon.delivery.projectAgentEvent(
        daemon.agentEvents.append({
          agentId: row.id,
          herdrSessionName: "default",
          workspaceId: row.workspaceId,
          paneId: row.paneId,
          terminalId: row.terminalId,
          type: "agent.done",
          payload: {
            agent: row.agent,
            from: "working",
            to: "done",
            agentSession: row.agentSession,
          },
          compactHistory: null,
        }),
      );
    },
    inbox: () => cli(["inbox", "list", "seat"]),
  };
}

describe("pane subscription through CLI, daemon, Herdr socket and durable store", () => {
  test("source CLI process and one-call cost use the same isolated daemon boundary", async () => {
    const f = await fixture();
    await f.refresh();
    f.requests.length = 0;
    const processStart = performance.now();
    expect(
      await f.cliProcess(["profile", "subscribe", "seat", "--workspace", "wA", "--pane", "wA:p1"]),
    ).toMatchObject({ subscription: { id: expect.any(Number) } });
    const sourceCliWallMs = performance.now() - processStart;
    expect(f.requests).toEqual(["pane.get"]);
    const diskBefore = f.diskBytes();
    const rssBefore = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage();
    const samples: number[] = [];
    f.requests.length = 0;
    for (let n = 0; n < 20; n++) {
      const start = performance.now();
      await f.subscribe();
      samples.push(performance.now() - start);
    }
    const cpu = process.cpuUsage(cpuBefore);
    const rssAfter = process.memoryUsage().rss;
    const show = await f.show();
    expect(show.subscriptions).toHaveLength(1);
    expect(f.requests.filter((method) => method === "pane.get")).toHaveLength(20);
    console.info(
      "S3 subscribe fixture cost",
      JSON.stringify({
        sourceCliWallMs,
        samplesMs: samples,
        inProcessCpuUserUs: cpu.user,
        inProcessCpuSystemUs: cpu.system,
        workerRssBefore: rssBefore,
        workerRssAfter: rssAfter,
        workerPeakRssKiB: process.resourceUsage().maxRSS,
        diskBytesBeforeRepeatedCalls: diskBefore,
        diskBytesAfterRepeatedCalls: f.diskBytes(),
        rows: show.subscriptions.length,
        selectorBytes: Buffer.byteLength(show.subscriptions[0]?.agentSelectorJson ?? ""),
      }),
    );
  });

  test("pending before detection, first bind while working, then replacement refused after restart", async () => {
    const f = await fixture([worker({ agent: null, agent_session: null })]);
    await f.subscribe();
    expect(f.requests).toEqual(["pane.get"]);
    let show = await f.show();
    expect(show.subscriptions).toHaveLength(1);
    const id = show.subscriptions[0]?.id;
    expect(JSON.parse(show.subscriptions[0]?.agentSelectorJson ?? "null")).toEqual({
      kind: "terminalId",
      value: "term_1",
      agentSession: null,
    });
    expect(show.resolutions[0]?.kind).toBe("pending");
    await f.subscribe();
    expect((await f.show()).subscriptions).toHaveLength(1);
    await f.restart();
    expect((await f.show()).resolutions[0]?.kind).toBe("pending");
    f.setRows([worker()]);
    await f.refresh();
    // Bind before a finish or a profile inspection can trigger it.
    expect(
      JSON.parse(f.daemon.profiles.listSubscriptions("seat")[0]?.agentSelectorJson ?? "null")
        .agentSession,
    ).toEqual(firstSession);
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(1);
    await f.restart();
    f.setRows([worker({ agent_session: nextSession })]);
    await f.refresh();
    f.finish();
    show = await f.show();
    expect(show.subscriptions[0]?.id).toBe(id);
    expect(show.resolutions[0]).toMatchObject({
      kind: "replacement_refused",
      expectedSessionId: firstSession.value,
      actualSessionId: nextSession.value,
    });
    expect(show.resolutions[0]?.detail).toContain("replacement refused");
    expect((await f.inbox()).obligations).toHaveLength(1);
    // Repeating subscribe cannot silently authorize replacement.
    await f.subscribe();
    expect((await f.show()).resolutions[0]?.kind).toBe("replacement_refused");
    f.setRows([worker()]);
    await f.refresh();
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(2);
  });

  test("name reuse elsewhere cannot receive outcomes, while pane move keeps the subscribed terminal", async () => {
    const f = await fixture();
    await f.subscribe();
    f.setRows([
      worker({ pane_id: "wA:p9", name: null }),
      worker({ pane_id: "wA:p2", terminal_id: "term_2", agent_session: nextSession }),
    ]);
    await f.refresh();
    f.finish("wA:p2");
    expect((await f.inbox()).obligations).toHaveLength(0);
    f.finish("wA:p9");
    expect((await f.inbox()).obligations).toHaveLength(1);
    expect((await f.show()).resolutions[0]?.kind).toBe("matched");
  });

  test("missing pane and wrong or missing workspace refuse without creating a row", async () => {
    const f = await fixture();
    await expect(f.subscribe(["--pane", "missing"])).rejects.toThrow(/pane not found/);
    await expect(
      f.cli(["profile", "subscribe", "seat", "--workspace", "wrong", "--pane", "wA:p1"]),
    ).rejects.toThrow(/workspace/);
    await expect(f.cli(["profile", "subscribe", "seat", "--pane", "wA:p1"])).rejects.toThrow(
      /workspace/,
    );
    expect((await f.show()).subscriptions).toHaveLength(0);
    await f.subscribe();
    expect((await f.show()).subscriptions).toHaveLength(1);
  });

  test("name subscription pins identity; terminal and pane repeats keep one row and one notice", async () => {
    const f = await fixture();
    await f.refresh();
    await f.subscribe(["--name", "builder"]);
    await f.subscribe(["--terminal", "term_1"]);
    await f.subscribe();
    const show = await f.show();
    expect(show.subscriptions).toHaveLength(1);
    expect(JSON.parse(show.subscriptions[0]?.agentSelectorJson ?? "null")).toEqual({
      kind: "terminalId",
      value: "term_1",
      agentSession: firstSession,
    });
    f.setRows([
      worker({ name: null }),
      worker({ pane_id: "wA:p2", terminal_id: "term_2", agent_session: nextSession }),
    ]);
    await f.refresh();
    f.finish("wA:p2");
    expect((await f.inbox()).obligations).toHaveLength(0);
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(1);
    await f.subscribe(["--terminal", "term_2"]);
    expect((await f.show()).subscriptions).toHaveLength(2);
    await f.cli(["profile", "unsubscribe", "seat", "--workspace", "wA", "--terminal", "term_1"]);
    expect((await f.show()).subscriptions).toHaveLength(1);
  });

  test("first identity binds before a history read can delay publication", async () => {
    const f = await fixture([worker({ agent: null, agent_session: null })]);
    await f.subscribe();
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = f.daemon.context.refreshAgent.bind(f.daemon.context);
    const spy = vi.spyOn(f.daemon.context, "refreshAgent").mockImplementationOnce(async (input) => {
      entered();
      await gate;
      return original(input);
    });
    f.setRows([worker()]);
    const refreshing = f.refresh();
    await started;
    try {
      expect(
        JSON.parse(f.daemon.profiles.listSubscriptions("seat")[0]?.agentSelectorJson ?? "null")
          .agentSession,
      ).toEqual(firstSession);
    } finally {
      release();
    }
    await refreshing;
    spy.mockRestore();
    f.setRows([worker({ agent_session: nextSession })]);
    await f.refresh();
    expect((await f.show()).resolutions[0]?.kind).toBe("replacement_refused");
  });

  test("stale cached native identity cannot bind a pending row through inspection or repeated terminal subscribe", async () => {
    const f = await fixture();
    await f.refresh();
    f.setRows([worker({ agent_session: null })]);
    await f.subscribe();
    await f.subscribe(["--terminal", "term_1"]);
    expect((await f.show()).resolutions[0]?.bindingState).toBe("pending");
    expect(
      JSON.parse(f.daemon.profiles.listSubscriptions("seat")[0]?.agentSelectorJson ?? "null")
        .agentSession,
    ).toBe(null);
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(0);
    f.setRows([worker({ agent_session: nextSession })]);
    await f.refresh();
    expect(
      JSON.parse(f.daemon.profiles.listSubscriptions("seat")[0]?.agentSelectorJson ?? "null")
        .agentSession,
    ).toEqual(nextSession);
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(1);
  });

  test("guarded subscriptions refuse old events without native identity", async () => {
    const f = await fixture();
    await f.subscribe();
    await f.refresh();
    const row = f.daemon.agents.list({ herdrSessionName: "default" })[0];
    if (!row) throw new Error("fixture worker missing");
    f.daemon.delivery.projectAgentEvent(
      f.daemon.agentEvents.append({
        agentId: row.id,
        terminalId: row.terminalId,
        herdrSessionName: "default",
        workspaceId: "wA",
        paneId: row.paneId,
        type: "agent.done",
        payload: { agent: row.agent, from: "working", to: "done" },
      }),
    );
    expect((await f.inbox()).obligations).toHaveLength(0);
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(1);
  });

  test("re-subscribing legacy names consolidates rows without losing pending notices", async () => {
    const f = await fixture();
    const legacyName = f.daemon.profiles.addSubscription({
      agentSelectorJson: JSON.stringify({ value: "builder", kind: "name" }),
      profileId: "seat",
      herdrSessionName: "default",
      workspaceSelectorJson: JSON.stringify({ herdrSession: "default", workspaceId: "wA" }),
    });
    f.daemon.profiles.addSubscription({
      ...legacyName,
      agentSelectorJson: JSON.stringify({ kind: "name", value: "builder" }),
    });
    const legacyTerminal = f.daemon.profiles.addSubscription({
      agentSelectorJson: JSON.stringify({ kind: "terminalId", value: "term_1" }),
      profileId: "seat",
      herdrSessionName: "default",
      workspaceSelectorJson: legacyName.workspaceSelectorJson,
    });
    await f.refresh();
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(1);
    await f.subscribe(["--name", "builder"]);
    const show = await f.show();
    expect(show.subscriptions).toHaveLength(1);
    expect(show.subscriptions[0]?.id).toBe(legacyTerminal.id);
    expect((await f.inbox()).obligations).toMatchObject([{ subscriptionId: legacyTerminal.id }]);
    f.setRows([
      worker({ name: null }),
      worker({ pane_id: "wA:p2", terminal_id: "term_2", agent_session: nextSession }),
    ]);
    await f.refresh();
    f.finish("wA:p2");
    expect((await f.inbox()).obligations).toHaveLength(1);
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(2);
  });

  test("legacy pane re-subscribe keeps the row id, and old closed-pane rows can still be unsubscribed", async () => {
    const f = await fixture();
    const input = {
      agentSelectorJson: JSON.stringify({ kind: "paneId", value: "wA:p1" }),
      profileId: "seat",
      herdrSessionName: "default",
      workspaceSelectorJson: JSON.stringify({ herdrSession: "default", workspaceId: "wA" }),
    };
    const old = f.daemon.profiles.addSubscription(input);
    await f.subscribe();
    expect((await f.show()).subscriptions.map((row) => row.id)).toEqual([old.id]);
    await f.cli(["profile", "unsubscribe", "seat", "--workspace", "wA", "--terminal", "term_1"]);
    f.daemon.profiles.addSubscription(input);
    f.setRows([]);
    await f.cli(["profile", "unsubscribe", "seat", "--workspace", "wA", "--pane", "wA:p1"]);
    expect((await f.show()).subscriptions).toHaveLength(0);
  });

  test("first binding ignores observations outside the subscribed workspace", async () => {
    const f = await fixture([worker({ agent: null, agent_session: null })]);
    await f.subscribe();
    f.setRows([worker({ workspace_id: "other" })]);
    await f.refresh();
    expect(
      JSON.parse(f.daemon.profiles.listSubscriptions("seat")[0]?.agentSelectorJson ?? "null")
        .agentSession,
    ).toBe(null);
    f.setRows([worker()]);
    await f.refresh();
    expect(
      JSON.parse(f.daemon.profiles.listSubscriptions("seat")[0]?.agentSelectorJson ?? "null")
        .agentSession,
    ).toEqual(firstSession);
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(1);
  });

  test("real indexed working-to-done events deliver only the bound session", async () => {
    const f = await fixture();
    await f.subscribe();
    await f.refresh();
    f.setRows([worker({ agent_status: "done" })]);
    await f.refresh();
    expect((await f.inbox()).obligations).toHaveLength(1);
    expect(
      f.daemon.agentEvents
        .listAfter({ herdrSessionName: "default" })
        .filter((e) => e.type === "agent.done")[0]?.payload,
    ).toMatchObject({ agentSession: firstSession });
    f.setRows([worker({ agent_session: nextSession })]);
    await f.refresh();
    f.setRows([worker({ agent_session: nextSession, agent_status: "done" })]);
    await f.refresh();
    expect((await f.inbox()).obligations).toHaveLength(1);
    expect((await f.show()).resolutions[0]?.kind).toBe("replacement_refused");
  });

  test("Pi presence before agent detection pins the first session, not a later pending hint", async () => {
    const f = await fixture([worker({ agent: null, agent_session: null })]);
    await f.subscribe();
    await f.registerPi(firstSession);
    expect(
      JSON.parse(f.daemon.profiles.listSubscriptions("seat")[0]?.agentSelectorJson ?? "null")
        .agentSession,
    ).toEqual(firstSession);
    await f.registerPi(nextSession);
    f.setRows([worker({ agent_session: nextSession })]);
    await f.refresh();
    expect((await f.show()).resolutions[0]?.kind).toBe("replacement_refused");
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(0);
    f.setRows([worker()]);
    await f.refresh();
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(1);
  });

  test("a fresh Pi session report cannot bind an older cached Herdr session", async () => {
    const f = await fixture();
    await f.refresh();
    f.setRows([worker({ agent_session: null })]);
    await f.subscribe();
    await f.registerPi(nextSession);
    expect(
      JSON.parse(f.daemon.profiles.listSubscriptions("seat")[0]?.agentSelectorJson ?? "null")
        .agentSession,
    ).toEqual(nextSession);
    f.setRows([worker({ agent_session: nextSession })]);
    await f.refresh();
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(1);
  });

  test("fresh Herdr native metadata wins over a stale Pi hint before indexing", async () => {
    const f = await fixture([worker({ agent: null, agent_session: null })]);
    await f.subscribe();
    f.setRows([worker()]);
    await f.registerPi(nextSession);
    expect(
      JSON.parse(f.daemon.profiles.listSubscriptions("seat")[0]?.agentSelectorJson ?? "null")
        .agentSession,
    ).toEqual(firstSession);
    await f.refresh();
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(1);
  });

  test("Pi presence binds its first session without waiting for another inventory tick", async () => {
    const f = await fixture([worker({ agent_session: null })]);
    await f.refresh();
    await f.subscribe();
    await f.registerPi(firstSession);
    expect(
      JSON.parse(f.daemon.profiles.listSubscriptions("seat")[0]?.agentSelectorJson ?? "null")
        .agentSession,
    ).toEqual(firstSession);
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(1);
    await f.registerPi(nextSession);
    expect((await f.show()).resolutions[0]?.kind).toBe("replacement_refused");
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(1);
  });

  test("bad pane identity and malformed session guards fail closed, then good input succeeds", async () => {
    const f = await fixture();
    for (const pane of [
      worker({ pane_id: "different" }),
      worker({ terminal_id: null }),
      worker({ agent_session: { ...firstSession, value: "" } }),
    ]) {
      f.paneReply({ pane });
      await expect(f.subscribe()).rejects.toThrow(/pane|session/);
      expect((await f.show()).subscriptions).toHaveLength(0);
    }
    f.paneReply(undefined);
    await f.subscribe();
    expect((await f.show()).subscriptions).toHaveLength(1);
  });

  test("a delayed replacement event is refused even after the original session returns", async () => {
    const f = await fixture();
    await f.subscribe();
    f.setRows([worker({ agent_session: nextSession })]);
    await f.refresh();
    const row = f.daemon.agents.list({ herdrSessionName: "default" })[0];
    if (!row) throw new Error("fixture worker missing");
    const delayed = f.daemon.agentEvents.append({
      agentId: row.id,
      paneId: row.paneId,
      terminalId: row.terminalId,
      herdrSessionName: "default",
      workspaceId: row.workspaceId,
      type: "agent.done",
      payload: { agent: row.agent, from: "working", to: "done", agentSession: nextSession },
      compactHistory: null,
    });
    f.setRows([worker()]);
    await f.refresh();
    f.daemon.delivery.projectAgentEvent(delayed);
    expect((await f.inbox()).obligations).toHaveLength(0);
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(1);
  });

  test("factory's existing terminal proof works before the first prompt publishes a session", async () => {
    const f = await fixture([worker({ agent_session: null })]);
    await f.refresh();
    await f.subscribe(["--terminal", "term_1"]);
    const show = await f.show();
    // tools/seat/worker.ts:423 needs a matched terminal before it can send
    // the first prompt. A pending session guard must not deadlock that proof.
    expect(
      show.resolutions.some(
        (row) =>
          row.kind === "matched" &&
          row.agent?.paneId === "wA:p1" &&
          row.agent.terminalId === "term_1" &&
          row.agent.workspaceId === "wA",
      ),
    ).toBe(true);
    expect(show.resolutions[0]?.bindingState).toBe("pending");
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(0);
  });

  test("a detected agent without native identity stays pending and cannot be pruned as dead", async () => {
    const f = await fixture([worker({ agent_session: null })]);
    await f.subscribe();
    await f.refresh();
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(0);
    expect((await f.show()).resolutions[0]).toMatchObject({
      kind: "matched",
      bindingState: "pending",
    });
    expect(
      f.daemon.service.pruneSubscriptions({ profileId: "seat", ageMs: 0 }).removed,
    ).toHaveLength(0);
    f.setRows([worker()]);
    await f.refresh();
    f.finish();
    expect((await f.inbox()).obligations).toHaveLength(1);
  });
});
