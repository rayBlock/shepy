import { mkdtempSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, TestRunner, test, vi } from "vitest";
import type { AgentHistoryService } from "@/agent-history/service.js";
import { emptyCompactHistory } from "@/agent-history/service.js";
import {
  HerdrSessionWatchManager,
  SUBSCRIPTION_PRUNE_AGE_MS,
} from "@/daemon/herdr-session-watch-manager.js";
import { DeliveryObligationStore } from "@/db/delivery-obligations.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { ProfileOwnerStore } from "@/db/profile-owners.js";
import { HerdrSocketClient } from "@/herdr/socket-client.js";
import { AgentIndexService } from "@/observability/agent-index-service.js";
import { ProfileDeliveryService } from "@/observability/profile-delivery-service.js";
import type { AgentSelector } from "@/observability/profile-selectors.js";
import { ProfileService } from "@/observability/profile-service.js";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";
import {
  cleanupTempDirs,
  openObservabilityDbHarness,
  tempDirs,
} from "./observability-db-harness.js";

const input = {
  herdrSessionName: "default",
  sessionDir: "/tmp/herdr",
  socketPath: "/tmp/herdr.sock",
};
afterEach(cleanupTempDirs);

function worker(name = "builder", pane = "w1:p1", terminal = "term1", status = "working") {
  return {
    agent: "pi",
    agent_status: status,
    name,
    pane_id: pane,
    terminal_id: terminal,
    workspace_id: pane.split(":")[0],
    cwd: "/repo",
    revision: 1,
  };
}
function snapshot(agents: Record<string, unknown>[], panes: unknown[] = agents) {
  return {
    type: "session_snapshot",
    snapshot: {
      agents,
      panes,
      tabs: [],
      workspaces: [
        { workspace_id: "w1", label: "repo" },
        { workspace_id: "w2", label: "other" },
      ],
    },
  };
}
function fixture(socketPath?: string) {
  const db = openObservabilityDbHarness();
  const profiles = new OrchestratorProfileStore(db.sqlite);
  const obligations = new DeliveryObligationStore(db.sqlite);
  const delivery = new ProfileDeliveryService({
    agentEvents: db.agentEvents,
    agents: db.agents,
    obligations,
    owners: new ProfileOwnerStore({ sqlite: db.sqlite }),
    profiles,
  });
  const history = {
    async resolveCompactHistory() {
      return {
        compactHistory: emptyCompactHistory("pi-jsonl"),
        historyRef: null,
        sourceFingerprint: null,
      };
    },
  } as unknown as AgentHistoryService;
  const service = new ProfileService({ agents: db.agents, history, profiles });
  let current: unknown = snapshot([
    worker(),
    worker("reviewer", "w1:p2", "term2"),
    worker("third", "w1:p3", "term3"),
  ]);
  let fail = false;
  const makeIndex = () =>
    new AgentIndexService({
      stores: db,
      history,
      clientFactory: () =>
        socketPath
          ? new HerdrSocketClient({ socketPath })
          : {
              close() {},
              async sessionSnapshot() {
                if (fail) throw new Error("Herdr unavailable");
                return current;
              },
            },
      onAgentGone: ({ event, previousAgents }) =>
        delivery.projectGoneAgent({ event, previousAgents }),
      onAgentsMoved: (moves) => delivery.moveSubscriptions(moves),
    });
  let index = makeIndex();
  const refresh = async () => {
    const result = await index.refreshHerdrSession(input);
    for (const event of result.events) delivery.projectAgentEvent(event);
    return result;
  };
  const subscribe = (
    profileId = "seat",
    selector: AgentSelector = { kind: "name", value: "builder" },
  ) => {
    service.ensureProfile({ profileId, displayName: profileId, projectRoots: [] });
    return service.addSubscription({
      ...input,
      workspaceId: "w1",
      profileId,
      agentSelector: selector,
    }).subscription;
  };
  const outcomes = (profileId = "seat") =>
    obligations
      .pendingBatch({ profileId, limit: 100 })
      .map((row) => delivery.inboxGet(row.id)?.outcome);
  return {
    ...db,
    profiles,
    delivery,
    service,
    subscribe,
    outcomes,
    refresh,
    set: (value: unknown) => {
      current = value;
    },
    fail: (value: boolean) => {
      fail = value;
    },
    restart: () => {
      index = makeIndex();
    },
    getIndex: () => index,
    snapshot: () => current,
  };
}

describe("subscribed worker lifecycle", () => {
  test.each([
    false,
    true,
  ])("one gone after close; restart=%s, two other workers retained", async (restart) => {
    const f = fixture();
    await f.refresh();
    f.subscribe();
    f.subscribe("seat", { kind: "terminalId", value: "term2" });
    f.subscribe("seat", { kind: "terminalId", value: "term3" });
    if (restart) f.restart();
    f.set(snapshot([worker("reviewer", "w1:p2", "term2"), worker("third", "w1:p3", "term3")]));
    await f.refresh();
    await f.refresh();
    f.restart();
    await f.refresh();
    expect(f.outcomes().map((o) => o?.type)).toEqual(["agent.gone"]);
    expect(f.outcomes()[0]).toMatchObject({
      name: "builder",
      paneId: "w1:p1",
      terminalId: "term1",
      to: "gone",
    });
    expect(f.profiles.listSubscriptions("seat")).toHaveLength(2);
    expect(
      f.agentEvents.listAfter({ limit: 100 }).filter((e) => e.type === "agent.gone"),
    ).toHaveLength(1);
    f.sqlite.close();
  });

  test.each([
    false,
    true,
  ])("agent exit with shell pane present gives gone once; null agent row=%s", async (nullAgent) => {
    const f = fixture();
    await f.refresh();
    f.subscribe();
    f.set(
      snapshot(nullAgent ? [{ ...worker(), agent: null, launch_pending: false }] : [], [
        { pane_id: "w1:p1", terminal_id: "term1", agent: null, workspace_id: "w1" },
      ]),
    );
    await f.refresh();
    await f.refresh();
    expect(f.outcomes().map((o) => o?.type)).toEqual(["agent.gone"]);
    expect(f.profiles.listSubscriptions("seat")).toHaveLength(0);
    f.sqlite.close();
  });

  test("old name never follows a new terminal; explicit new subscription works", async () => {
    const f = fixture();
    await f.refresh();
    f.subscribe();
    f.set(snapshot([worker("builder", "w1:p9", "new-terminal")]));
    await f.refresh();
    expect(f.profiles.listSubscriptions("seat")).toHaveLength(0);
    expect(f.outcomes()).toHaveLength(1);
    f.subscribe("seat", { kind: "terminalId", value: "new-terminal" });
    f.set(snapshot([]));
    await f.refresh();
    expect(f.outcomes().map((o) => o?.terminalId)).toEqual(["term1", "new-terminal"]);
    f.sqlite.close();
  });

  test("each profile gets one gone and removal never erases pending done", async () => {
    const f = fixture();
    await f.refresh();
    f.subscribe();
    f.subscribe("second");
    const agent = f.agents.findByTerminal({ herdrSessionName: "default", terminalId: "term1" });
    if (!agent) throw new Error("missing worker");
    const done = f.agentEvents.append({
      agentId: agent.id,
      herdrSessionName: "default",
      paneId: agent.paneId,
      terminalId: agent.terminalId,
      workspaceId: agent.workspaceId,
      type: "agent.done",
      payload: { agent: "pi", name: "builder", from: "working", to: "done" },
      compactHistory: {
        ...emptyCompactHistory("pi-jsonl"),
        lastAssistantMessage: { ref: "final", text: "finished", timestamp: null },
      },
    });
    // Simulate a crash between append and publication. The close must recover
    // the durable final before deleting its only matching subscription.
    f.restart();
    f.set(snapshot([]));
    await f.refresh();
    for (const profile of ["seat", "second"]) {
      expect(f.outcomes(profile).map((o) => o?.type)).toEqual(["agent.done", "agent.gone"]);
      expect(f.outcomes(profile)[0]?.eventId).toBe(done.id);
      expect(f.profiles.listSubscriptions(profile)).toHaveLength(0);
    }
    f.sqlite.close();
  });

  test("OpenCode's source-entry dedupe composes with atomic close recovery", async () => {
    const f = fixture();
    f.set(snapshot([{ ...worker(), agent: "opencode" }]));
    await f.refresh();
    f.subscribe();
    const agent = f.agents.findByTerminal({ herdrSessionName: "default", terminalId: "term1" });
    if (!agent) throw new Error("worker not indexed");
    f.agentEvents.append({
      agentId: agent.id,
      herdrSessionName: "default",
      paneId: agent.paneId,
      workspaceId: "w1",
      terminalId: "term1",
      type: "agent.done",
      payload: { agent: "opencode", name: "builder", from: "working", to: "done" },
      compactHistory: {
        ...emptyCompactHistory("opencode-sqlite"),
        lastAssistantMessage: {
          ref: "history#entry=msg_S2valid",
          text: "finished",
          timestamp: null,
        },
      },
    });
    f.set(snapshot([]));
    await f.refresh();
    expect(f.outcomes().map((o) => o?.type)).toEqual(["agent.done", "agent.gone"]);
    f.sqlite.close();
  });

  test("close during the missing-final retry publishes done before gone", async () => {
    const f = fixture();
    await f.refresh();
    f.subscribe();
    f.set(snapshot([worker("builder", "w1:p1", "term1", "done")]));
    const pending = f.refresh();
    // Wait until the real index has admitted the deferred final, not a fake clock.
    await new Promise((resolve) => setTimeout(resolve, 30));
    f.set(snapshot([]));
    await f
      .getIndex()
      .handleHerdrEvent({ ...input, event: { type: "pane.closed", pane_id: "w1:p1" } });
    await pending;
    expect(f.outcomes().map((o) => o?.type)).toEqual(["agent.done", "agent.gone"]);
    expect(f.outcomes()[0]?.excerpt).toBeNull();
    f.sqlite.close();
  });

  test.each([
    "paneId",
    "terminalId",
    "name",
  ] as const)("move preserves %s subscription across workspace and pane ids", async (kind) => {
    const f = fixture();
    await f.refresh();
    f.subscribe("seat", {
      kind,
      value: kind === "paneId" ? "w1:p1" : kind === "terminalId" ? "term1" : "builder",
    });
    f.set(snapshot([worker("builder", "w2:p8", "term1")]));
    await f.refresh();
    expect(f.outcomes()).toHaveLength(0);
    expect(f.service.resolveSubscriptions("seat")[0]?.kind).toBe("matched");
    f.set(snapshot([]));
    await f.refresh();
    expect(f.outcomes().map((o) => o?.type)).toEqual(["agent.gone"]);
    f.sqlite.close();
  });

  test("P1 launch-pending null agents preserve presence without freezing another worker's close", async () => {
    const f = fixture();
    await f.refresh();
    f.subscribe();
    f.subscribe("third", { kind: "terminalId", value: "term3" });
    f.subscribe("starting", { kind: "terminalId", value: "term5" });
    const pending = {
      ...worker("starting", "w1:p5", "term5", "unknown"),
      agent: null,
      launch_pending: true,
    };
    f.set(
      snapshot([
        worker(),
        worker("reviewer", "w1:p2", "term2"),
        worker("third", "w1:p3", "term3"),
        pending,
      ]),
    );
    await f.refresh();
    expect(
      f.agents.findByTerminal({ herdrSessionName: "default", terminalId: "term5" }),
    ).toBeUndefined();
    f.set(
      snapshot([worker("reviewer", "w1:p2", "term2"), worker("third", "w1:p3", "term3"), pending]),
    );
    const refreshed = await f.refresh();
    if (!refreshed.presence) throw new Error("missing snapshot presence");
    expect(refreshed.presence.terminalIds).toContain("term5");
    expect(
      f.service.pruneSubscriptions({
        profileId: "starting",
        herdrSessionName: "default",
        ageMs: SUBSCRIPTION_PRUNE_AGE_MS,
        now: Date.now() + 121000,
        presence: refreshed.presence,
      }).removed,
    ).toHaveLength(0);
    await f.refresh();
    expect(f.outcomes().map((o) => o?.type)).toEqual(["agent.gone"]);
    expect(f.outcomes("third")).toHaveLength(0);
    expect(
      f.agents.findByTerminal({ herdrSessionName: "default", terminalId: "term3" })?.agent,
    ).toBe("pi");
    expect(f.outcomes("starting")).toHaveLength(0);
    expect(f.profiles.listSubscriptions("starting")).toHaveLength(1);
    f.sqlite.close();
  });

  test.each([
    "shift",
    "swap",
  ])("P2 and P2b compute the entire %s before rewriting any subscriptions", async (mode) => {
    const f = fixture();
    f.set(snapshot([worker("a", "w1:p1", "termA"), worker("b", "w1:p2", "termB")]));
    await f.refresh();
    const a = f.subscribe("pa", { kind: "paneId", value: "w1:p1" });
    const b = f.subscribe("pb", { kind: "paneId", value: "w1:p2" });
    const sameA = f.subscribe("seat", { kind: "paneId", value: "w1:p1" });
    const sameB = f.subscribe("seat", { kind: "paneId", value: "w1:p2" });
    f.set(
      snapshot([
        worker("a", "w1:p2", "termA"),
        worker("b", mode === "swap" ? "w1:p1" : "w1:p3", "termB"),
      ]),
    );
    await f.refresh();
    await f.refresh();
    for (const [profile, id, terminal] of [
      ["pa", a.id, "termA"],
      ["pb", b.id, "termB"],
      ["seat", sameA.id, "termA"],
      ["seat", sameB.id, "termB"],
    ] as const) {
      const resolved = f.service
        .resolveSubscriptions(profile)
        .find((row) => row.subscription.id === id);
      expect(resolved?.kind === "matched" ? resolved.agent.terminalId : resolved?.kind).toBe(
        terminal,
      );
    }
    expect(f.profiles.listSubscriptions("seat")).toHaveLength(2);
    expect(f.outcomes()).toHaveLength(0);
    f.sqlite.close();
  });

  test("P7b merges a colliding destination row and every later refresh still succeeds", async () => {
    const f = fixture();
    f.set(snapshot([worker(), worker("builder", "w2:p5", "term5")]));
    await f.refresh();
    f.subscribe();
    f.service.addSubscription({
      ...input,
      workspaceId: "w2",
      profileId: "seat",
      agentSelector: { kind: "name", value: "builder" },
    });
    f.set(snapshot([worker("builder", "w2:p8", "term1"), worker("builder", "w2:p5", "term5")]));
    for (let i = 0; i < 4; i++) await f.refresh();
    expect(f.profiles.listSubscriptions("seat")).toHaveLength(1);
    expect(f.service.resolveSubscriptions("seat")[0]?.kind).toBe("ambiguous");
    f.set(snapshot([worker("builder", "w2:p8", "term1")]));
    await f.refresh();
    expect(f.service.resolveSubscriptions("seat")[0]?.kind).toBe("matched");
    f.set(snapshot([worker("builder", "w2:p8", "term1", "done")]));
    await f.refresh();
    expect(f.outcomes().map((o) => o?.type)).toEqual(["agent.done"]);
    f.sqlite.close();
  });

  test("a duplicate move retains pending outcomes and the enabled modern subscription", async () => {
    const f = fixture();
    await f.refresh();
    const source = f.subscribe();
    const target = f.service.addSubscription({
      ...input,
      workspaceId: "w2",
      profileId: "seat",
      agentSelector: { kind: "name", value: "builder" },
    }).subscription;
    f.sqlite
      .prepare("update profile_subscriptions set enabled = 0, legacy = 1 where id = ?")
      .run(target.id);
    const agent = f.agents.findByTerminal({ herdrSessionName: "default", terminalId: "term1" });
    if (!agent) throw new Error("worker not indexed");
    const done = f.agentEvents.append({
      agentId: agent.id,
      herdrSessionName: "default",
      paneId: agent.paneId,
      workspaceId: "w1",
      terminalId: "term1",
      type: "agent.done",
      payload: { agent: "pi", name: "builder", from: "working", to: "done" },
    });
    f.delivery.projectAgentEvent(done);
    expect(f.delivery.inboxList({ profileId: "seat" })[0]?.subscriptionId).toBe(source.id);
    f.set(snapshot([worker("builder", "w2:p9", "term1")]));
    await f.refresh();
    expect(f.profiles.listSubscriptions("seat")).toEqual([
      expect.objectContaining({ id: target.id, enabled: true, legacy: false }),
    ]);
    expect(f.outcomes().map((o) => o?.eventId)).toEqual([done.id]);
    f.sqlite.close();
  });

  test("a failed batch move rolls back all temporary selector keys with the agent index", async () => {
    const f = fixture();
    await f.refresh();
    f.subscribe();
    const before = f.profiles.listSubscriptions("seat");
    f.sqlite.exec(`create trigger fail_move before update of workspace_selector_json on profile_subscriptions
      begin select raise(abort, 'injected move failure'); end`);
    f.set(
      snapshot([
        worker("builder", "w2:p9", "term1"),
        worker("reviewer", "w1:p2", "term2"),
        worker("third", "w1:p3", "term3"),
      ]),
    );
    await expect(f.refresh()).rejects.toThrow("injected move failure");
    expect(f.profiles.listSubscriptions("seat")).toEqual(before);
    expect(
      f.agents.findByTerminal({ herdrSessionName: "default", terminalId: "term1" })?.paneId,
    ).toBe("w1:p1");
    f.sqlite.exec("drop trigger fail_move");
    await f.refresh();
    expect(f.service.resolveSubscriptions("seat")[0]?.kind).toBe("matched");
    f.sqlite.close();
  });

  test("P4 automatic pruning keeps a modern never-matched subscription until presence proves absence", async () => {
    const f = fixture();
    await f.refresh();
    f.subscribe("seat", { kind: "terminalId", value: "term9" });
    const aged = {
      profileId: "seat",
      herdrSessionName: "default",
      ageMs: SUBSCRIPTION_PRUNE_AGE_MS,
      now: Date.now() + 121000,
    };
    expect(f.service.pruneSubscriptions(aged).removed).toHaveLength(0);
    expect(
      f.service.pruneSubscriptions({
        ...aged,
        presence: { paneIds: ["w1:p9"], terminalIds: ["term9"] },
      }).removed,
    ).toHaveLength(0);
    f.set(snapshot([worker(), worker("late", "w1:p9", "term9")]));
    await f.refresh();
    f.set(snapshot([worker(), worker("late", "w1:p9", "term9", "done")]));
    await f.refresh();
    expect(f.outcomes().map((o) => o?.type)).toEqual(["agent.done"]);
    f.subscribe("absent", { kind: "paneId", value: "w1:p99" });
    expect(
      f.service.pruneSubscriptions({
        ...aged,
        profileId: "absent",
        presence: { paneIds: [], terminalIds: [] },
      }).removed,
    ).toHaveLength(1);
    f.sqlite.close();
  });

  test("automatic prune refuses unknown identity and missing terminal metadata; explicit prune is unchanged", async () => {
    const f = fixture();
    await f.refresh();
    f.subscribe("seat", { kind: "terminalId", value: "future" });
    f.subscribe("name", { kind: "name", value: "future" });
    const aged = {
      herdrSessionName: "default",
      ageMs: SUBSCRIPTION_PRUNE_AGE_MS,
      now: Date.now() + 121000,
    };
    expect(
      f.service.pruneSubscriptions({
        ...aged,
        profileId: "seat",
        presence: { paneIds: [], terminalIds: null },
      }).removed,
    ).toHaveLength(0);
    expect(
      f.service.pruneSubscriptions({
        ...aged,
        profileId: "name",
        presence: { paneIds: [], terminalIds: [] },
      }).removed,
    ).toHaveLength(0);
    // Complete absence alone does not skip the ordinary age gate.
    expect(
      f.service.pruneSubscriptions({
        ...aged,
        now: Date.now(),
        profileId: "seat",
        presence: { paneIds: [], terminalIds: [] },
      }).removed,
    ).toHaveLength(0);
    expect(
      f.service.pruneSubscriptions({ profileId: "seat", ageMs: aged.ageMs, now: aged.now }).removed,
    ).toHaveLength(1);
    f.sqlite.close();
  });

  test("startup before first refresh, Herdr failure and malformed snapshots never delete", async () => {
    const f = fixture();
    f.subscribe();
    f.fail(true);
    await expect(f.refresh()).rejects.toThrow("unavailable");
    expect(f.profiles.listSubscriptions("seat")).toHaveLength(1);
    f.fail(false);
    await f.refresh();
    f.set({ snapshot: { panes: [], workspaces: [] } });
    await expect(f.refresh()).rejects.toThrow();
    expect(f.profiles.listSubscriptions("seat")).toHaveLength(1);
    expect(f.outcomes()).toHaveLength(0);
    f.sqlite.close();
  });

  test("unsubscribing one profile leaves the other's gone outcome intact", async () => {
    const f = fixture();
    await f.refresh();
    f.subscribe();
    f.subscribe("second");
    f.service.removeSubscription({
      ...input,
      workspaceId: "w1",
      profileId: "seat",
      agentSelector: { kind: "name", value: "builder" },
    });
    f.set(snapshot([]));
    await f.refresh();
    expect(f.outcomes("seat")).toHaveLength(0);
    expect(f.outcomes("second").map((o) => o?.type)).toEqual(["agent.gone"]);
    f.sqlite.close();
  });

  test("lifecycle projection and subscription removal roll back together", async () => {
    const f = fixture();
    await f.refresh();
    f.subscribe();
    f.sqlite.exec(
      "create trigger fail_gone before insert on delivery_obligations begin select raise(abort, 'injected disk failure'); end",
    );
    f.set(snapshot([]));
    await expect(f.refresh()).rejects.toThrow("injected disk failure");
    expect(f.profiles.listSubscriptions("seat")).toHaveLength(1);
    expect(f.agents.listForHerdrSession("default")).toHaveLength(3);
    expect(f.agentEvents.listAfter({ limit: 100 })).toHaveLength(0);
    f.sqlite.exec("drop trigger fail_gone");
    await f.refresh();
    expect(f.outcomes()).toHaveLength(1);
    f.sqlite.close();
  });
});

// Real JSON Lines socket producer, real watcher, migrated SQLite and the same
// delivery/prune wiring as daemon startup. No live Herdr or user daemon touched.
async function socketFixture() {
  const dir = mkdtempSync(join(tmpdir(), "s2-wire-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "herdr.sock");
  const f = fixture(socketPath);
  const sockets = new Set<Socket>();
  const subscribers = new Set<Socket>();
  const requests: Array<{ method: string; params: unknown }> = [];
  let unavailable = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      sockets.delete(socket);
      subscribers.delete(socket);
    });
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk) => {
      for (const line of decoder.push(chunk.toString())) {
        const request = line as { id: string; method: string; params: unknown };
        requests.push(request);
        if (request.method === "session.snapshot")
          socket.write(
            encodeJsonLine(
              unavailable
                ? { id: request.id, error: { code: "unavailable", message: "offline fixture" } }
                : { id: request.id, result: f.snapshot() },
            ),
          );
        else if (request.method === "events.subscribe") {
          subscribers.add(socket);
          socket.write(encodeJsonLine({ id: request.id, result: { subscribed: true } }));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const manager = new HerdrSessionWatchManager({
    agents: f.agents,
    herdrSessions: f.herdrSessions,
    index: f.getIndex(),
    activeRevisionPollMs: 20,
    fullRescanMs: 80,
    reconnectDelayMs: 5,
    sessionList: async () => [{ name: "default", running: true, sessionDir: dir, socketPath }],
    onAgentEvent: (event) => {
      f.delivery.projectAgentEvent(event);
    },
    onSessionRefreshed: (herdrSessionName, presence) => {
      for (const profile of f.service.listProfiles())
        f.service.pruneSubscriptions({
          profileId: profile.profileId,
          herdrSessionName,
          ...(presence ? { presence } : {}),
          ageMs: SUBSCRIPTION_PRUNE_AGE_MS,
        });
    },
  });
  return {
    ...f,
    manager,
    requests,
    broadcast: (event: string, data: object) => {
      for (const socket of subscribers) socket.write(encodeJsonLine({ event, data }));
    },
    disconnect: () => {
      for (const socket of subscribers) socket.destroy();
    },
    unavailable: (value: boolean) => {
      unavailable = value;
    },
    ready: () => subscribers.size > 0,
    async close() {
      await manager.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      f.sqlite.close();
    },
  };
}
async function until(predicate: () => boolean) {
  const task = TestRunner.getCurrentTest();
  if (!task) throw new Error("fixture requires an active test");
  // Vitest aborts this signal at the configured test timeout (and on cancel).
  // There is no shorter fixture deadline that defeats a larger gate timeout.
  for (;;) {
    task.context.signal.throwIfAborted();
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("watcher lifecycle over the Herdr socket", () => {
  test("fixture polling has no separate two-second deadline before the test signal", async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      const settled = vi.fn();
      const waiting = until(() => ready);
      const observed = waiting.then(settled, settled);
      await vi.advanceTimersByTimeAsync(2100);
      expect(settled).not.toHaveBeenCalled();
      ready = true;
      await vi.advanceTimersByTimeAsync(5);
      await waiting;
      await observed;
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("three workers: a real status event delivers done, then close delivers gone and keeps the others", async () => {
    const f = await socketFixture();
    try {
      await f.manager.start();
      await until(f.ready);
      for (const terminal of ["term1", "term2", "term3"])
        f.subscribe("seat", { kind: "terminalId", value: terminal });
      f.set(
        snapshot([
          worker("builder", "w1:p1", "term1", "done"),
          worker("reviewer", "w1:p2", "term2"),
          worker("third", "w1:p3", "term3"),
        ]),
      );
      f.broadcast("pane.agent_status_changed", {
        pane_id: "w1:p1",
        workspace_id: "w1",
        agent_status: "done",
        agent: "pi",
      });
      await until(() => f.outcomes().length === 1);
      expect(f.outcomes()[0]?.type).toBe("agent.done");
      f.set(snapshot([worker("reviewer", "w1:p2", "term2"), worker("third", "w1:p3", "term3")]));
      f.broadcast("pane.closed", { pane_id: "w1:p1", workspace_id: "w1" });
      await until(() => f.outcomes().length === 2);
      expect(f.outcomes().map((o) => o?.type)).toEqual(["agent.done", "agent.gone"]);
      expect(f.profiles.listSubscriptions("seat")).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  test.each([
    "pane.closed",
    "pane.exited",
    "disconnect",
  ])("reconciles %s exactly once and leases pending done before gone", async (reason) => {
    const f = await socketFixture();
    try {
      await f.manager.start();
      await until(f.ready);
      f.subscribe();
      const agent = f.agents.findByTerminal({ herdrSessionName: "default", terminalId: "term1" });
      if (!agent) throw new Error("worker not indexed");
      const done = f.agentEvents.append({
        agentId: agent.id,
        herdrSessionName: "default",
        paneId: agent.paneId,
        workspaceId: "w1",
        terminalId: "term1",
        type: "agent.done",
        payload: { agent: "pi", name: "builder", from: "working", to: "done" },
        compactHistory: emptyCompactHistory("pi-jsonl"),
      });
      f.delivery.projectAgentEvent(done);
      f.set(
        snapshot([], reason === "pane.exited" ? [{ pane_id: "w1:p1", terminal_id: "term1" }] : []),
      );
      if (reason === "disconnect") f.disconnect();
      else f.broadcast(reason, { pane_id: "w1:p1", workspace_id: "w1" });
      await until(() => f.outcomes().length === 2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(f.outcomes().map((o) => o?.type)).toEqual(["agent.done", "agent.gone"]);
      expect(f.profiles.listSubscriptions("seat")).toHaveLength(0);
      const claim = f.delivery.claim({
        profileId: "seat",
        subscriberId: "owner",
        harnessKind: "pi",
        harnessSessionRefJson: "{}",
        terminalId: "owner-term",
        paneId: "w1:p8",
        workspaceId: "w1",
        herdrSessionName: "default",
      });
      if (claim.kind !== "claimed") throw new Error("owner claim failed");
      const leased = f.delivery.inboxLease({ profileId: "seat", leaseToken: claim.leaseToken });
      expect(leased.obligations.map((row) => row.outcome?.type)).toEqual([
        "agent.done",
        "agent.gone",
      ]);
    } finally {
      await f.close();
    }
  });

  test("age prune runs after a healthy full refresh, not an unreachable one, and excludes stopped sessions", async () => {
    const f = await socketFixture();
    try {
      f.subscribe("seat", { kind: "terminalId", value: "pre-upgrade-absent" });
      f.service.addSubscription({
        profileId: "seat",
        herdrSessionName: "stopped",
        workspaceId: "w1",
        agentSelector: { kind: "terminalId", value: "not-observed" },
      });
      f.subscribe("live", { kind: "terminalId", value: "term1" });
      f.sqlite.exec("update profile_subscriptions set updated_at = 0");
      f.sqlite.exec(
        "update profile_subscriptions set legacy = 1 where agent_selector_json like '%pre-upgrade-absent%'",
      );
      f.unavailable(true);
      await f.manager.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(f.profiles.listSubscriptions("seat")).toHaveLength(2);
      f.unavailable(false);
      await until(() => f.profiles.listSubscriptions("seat").length === 1);
      expect(f.profiles.listSubscriptions("seat")[0]?.herdrSessionName).toBe("stopped");
      expect(f.profiles.listSubscriptions("live")).toHaveLength(1);
      expect(f.outcomes("live")).toHaveLength(0);
      expect(f.outcomes()).toHaveLength(0); // legacy rows without an identity prune silently
    } finally {
      await f.close();
    }
  });

  test("P4 a subscribed shell can wait past the age gate and later deliver its first done", async () => {
    const f = await socketFixture();
    try {
      f.subscribe("seat", { kind: "terminalId", value: "term9" });
      f.sqlite.exec("update profile_subscriptions set updated_at = 0");
      f.set(
        snapshot([], [{ pane_id: "w1:p9", terminal_id: "term9", workspace_id: "w1", agent: null }]),
      );
      await f.manager.start();
      await until(f.ready);
      expect(f.profiles.listSubscriptions("seat")).toHaveLength(1);
      f.set(snapshot([worker("late", "w1:p9", "term9")]));
      f.broadcast("pane.agent_detected", { pane_id: "w1:p9", workspace_id: "w1" });
      await until(() => f.service.resolveSubscriptions("seat")[0]?.kind === "matched");
      f.set(snapshot([worker("late", "w1:p9", "term9", "done")]));
      f.broadcast("pane.agent_status_changed", {
        pane_id: "w1:p9",
        workspace_id: "w1",
        agent_status: "done",
      });
      await until(() => f.outcomes().length === 1);
      expect(f.outcomes()[0]?.type).toBe("agent.done");
      f.set(snapshot([]));
      f.broadcast("pane.closed", { pane_id: "w1:p9", workspace_id: "w1" });
      await until(() => f.outcomes().length === 2);
      expect(f.outcomes().map((row) => row?.type)).toEqual(["agent.done", "agent.gone"]);
      expect(f.profiles.listSubscriptions("seat")).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  test("agent-detected refreshes an initially empty session without a new polling loop", async () => {
    const f = await socketFixture();
    try {
      f.set(snapshot([]));
      await f.manager.start();
      await until(f.ready);
      f.subscribe("seat", { kind: "terminalId", value: "term1" });
      f.set(snapshot([worker()]));
      f.broadcast("pane.agent_detected", { pane_id: "w1:p1", workspace_id: "w1" });
      await until(() => f.agents.listForHerdrSession("default").length === 1);
      expect(f.service.resolveSubscriptions("seat")[0]?.kind).toBe("matched");
      expect(f.outcomes()).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
});
