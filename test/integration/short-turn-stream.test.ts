import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { HerdrSessionWatchManager } from "@/daemon/herdr-session-watch-manager.js";
import { DeliveryObligationStore } from "@/db/delivery-obligations.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { ProfileOwnerStore } from "@/db/profile-owners.js";
import { AgentIndexService } from "@/observability/agent-index-service.js";
import { ProfileDeliveryService } from "@/observability/profile-delivery-service.js";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";
import {
  cleanupTempDirs,
  openObservabilityDbHarness,
  tempDirs,
} from "./observability-db-harness.js";

test("short turns remain observable during topology refresh, subscription handover and full rescan", async () => {
  const f = await fixture();
  const manager = new HerdrSessionWatchManager({
    agents: f.db.agents,
    herdrSessions: f.db.herdrSessions,
    index: f.index(),
    onAgentEvent: (event) => f.delivery.projectAgentEvent(event),
    reconnectDelayMs: 1,
    sessionList: async () => [{ ...f.input, name: "trial", running: true }],
  });
  try {
    await manager.start();
    await until(
      () =>
        f.streams.size === 2 && f.subscribedPaneCount() === 1 && f.db.agents.list({}).length === 1,
    );
    // Passing control: ordinary turns before any topology change.
    for (let i = 1; i <= 20; i++) {
      await f.turn(i);
      await until(() => f.outcomes().length === i);
    }
    for (let i = 21; i <= 36; i++) {
      f.extraPane = !f.extraPane;
      f.holdSnapshot = true;
      f.emit({ type: "pane.created", pane_id: `wT:extra${i}`, workspace_id: "wT" });
      await until(() => f.heldSnapshots.length > 0);
      // The entire turn lies inside the refresh, not across its edge.
      await f.turn(i);
      f.releaseSnapshots();
      await until(() => f.outcomes().length === i);
      await until(
        () =>
          f.streams.size === (f.extraPane ? 3 : 2) &&
          f.subscribedPaneCount() === (f.extraPane ? 2 : 1),
      );
    }
    f.extraPane = true;
    f.holdSubscription = true;
    f.emit({ type: "pane.created", pane_id: "wT:handover", workspace_id: "wT" });
    await until(() => f.heldSubscriptions.length > 0);
    await f.turn(37);
    f.releaseSubscriptions();
    await until(() => f.outcomes().length === 37);
    f.holdSnapshot = true;
    await manager.rescanNow();
    await until(() => f.heldSnapshots.length > 0);
    await f.turn(38);
    f.releaseSnapshots();
    await until(() => f.outcomes().length === 38);
    // A reconcile-only patch could recover done but cannot invent the lost working events.
    await until(
      () =>
        f
          .events()
          .filter(
            (e) =>
              e.type === "agent.status.changed" && (e.payload as { to: string }).to === "working",
          ).length === 38,
    );
    expect(
      f
        .events()
        .filter(
          (e) =>
            e.type === "agent.status.changed" && (e.payload as { to: string }).to === "working",
        ),
    ).toHaveLength(38);
    f.holdSubscription = true;
    for (const socket of f.streams.keys()) socket.destroy();
    await until(() => f.heldSubscriptions.length > 0);
    await f.turn(39);
    f.releaseSubscriptions();
    await until(() => f.outcomes().length === 39);
    await manager.stop();
    expect(f.outcomes().map((e) => e.compactHistory?.lastAssistantMessage?.text)).toEqual(
      Array.from({ length: 39 }, (_, i) => `answer ${i + 1}`),
    );
    expect(f.maxStreams).toBe(3);
  } finally {
    f.releaseSnapshots();
    f.releaseSubscriptions();
    await manager.stop();
    await f.close();
  }
});

test("refresh recovers a changed final at revision 1 once, including after an index restart", async () => {
  const f = await fixture();
  let index = f.index();
  const refresh = async () => {
    const result = await index.refreshHerdrSession(f.input);
    for (const event of result.events) f.delivery.projectAgentEvent(event);
    return result;
  };
  try {
    await refresh();
    expect(f.outcomes()).toHaveLength(0); // Startup settled is not a new turn.
    await f.turn(1);
    const recovered = await refresh();
    expect(recovered.events).toEqual([
      expect.objectContaining({
        type: "agent.done",
        payload: expect.objectContaining({ from: "done", to: "done" }),
      }),
    ]);
    await refresh();
    index = f.index();
    await refresh();
    expect(f.outcomes()).toHaveLength(1);
    await f.turn(2);
    await refresh();
    // Same final through seen/unseen transitions and replay never double-delivers.
    f.worker.agent_status = "idle";
    await refresh();
    for (const event of f.events()) f.delivery.projectAgentEvent(event);
    expect(f.outcomes().map((e) => e.compactHistory?.lastAssistantMessage?.text)).toEqual([
      "answer 1",
      "answer 2",
    ]);
    const agent = f.db.agents.list({})[0];
    if (!agent) throw new Error("missing indexed worker");
    const snapshot = f.db.agentContextSnapshots.get(agent.id);
    if (!snapshot) throw new Error("missing context snapshot");
    expect(snapshot.paneRevision).toBe(1);
    // An unchanged transcript must not be reparsed merely because revision stays 1.
    const before = snapshot.updatedAt.getTime();
    await refresh();
    expect(f.db.agentContextSnapshots.get(snapshot.agentId)?.updatedAt.getTime()).toBe(before);
    await f.turn(3);
    const append = vi.spyOn(f.db.agentEvents, "append").mockImplementationOnce(() => {
      throw new Error("injected append failure");
    });
    await expect(refresh()).rejects.toThrow("injected append failure");
    append.mockRestore();
    index = f.index();
    await refresh();
    expect(f.outcomes().map((e) => e.compactHistory?.lastAssistantMessage?.text)).toEqual([
      "answer 1",
      "answer 2",
      "answer 3",
    ]);
    await f.turn(4);
    const covered = await index.refreshHerdrSession({
      ...f.input,
      continuousPaneIds: [f.worker.pane_id],
    });
    expect(covered.events).toEqual([]);
    // A simultaneous snapshot must not consume the cursor before a stream
    // event arrives. If that stream disconnects, catch-up still owns it.
    index = f.index();
    await refresh();
    expect(f.outcomes().at(-1)?.compactHistory?.lastAssistantMessage?.text).toBe("answer 4");
    expect(f.outcomes()).toHaveLength(4);
  } finally {
    await f.close();
  }
});

async function fixture() {
  const db = openObservabilityDbHarness();
  const dir = tempDirs[tempDirs.length - 1];
  if (!dir) throw new Error("missing fixture directory");
  const project = join(dir, ".claude", "projects", "-trial");
  await mkdir(project, { recursive: true });
  const transcript = join(project, "11111111-2222-4333-8444-555555555555.jsonl");
  const worker = {
    agent: "claude",
    agent_status: "done",
    cwd: "/trial",
    name: "trial-worker",
    agent_session: {
      agent: "claude",
      kind: "id",
      source: "herdr:claude",
      value: "11111111-2222-4333-8444-555555555555",
    },
    pane_id: "wT:p1",
    revision: 1,
    terminal_id: "trial-terminal",
    workspace_id: "wT",
  };
  const line = (turn: number, role: "user" | "assistant") =>
    `${JSON.stringify({
      type: role,
      uuid: `${role}-${turn}`,
      sessionId: worker.agent_session.value,
      cwd: worker.cwd,
      timestamp: new Date(Date.now() - 1000 + (role === "assistant" ? 1 : 0)).toISOString(),
      message: {
        role,
        content: [{ type: "text", text: role === "assistant" ? `answer ${turn}` : `task ${turn}` }],
      },
    })}\n`;
  await writeFile(transcript, line(0, "user") + line(0, "assistant"));
  const profiles = new OrchestratorProfileStore(db.sqlite);
  profiles.createProfile({ profileId: "trial", displayName: "Trial", projectRoots: [] });
  profiles.addSubscription({
    profileId: "trial",
    herdrSessionName: "trial",
    workspaceSelectorJson: JSON.stringify({ herdrSession: "trial", workspaceId: "wT" }),
    agentSelectorJson: JSON.stringify({ kind: "terminalId", value: worker.terminal_id }),
  });
  const obligations = new DeliveryObligationStore(db.sqlite);
  const delivery = new ProfileDeliveryService({
    agents: db.agents,
    agentEvents: db.agentEvents,
    profiles,
    obligations,
    owners: new ProfileOwnerStore({ sqlite: db.sqlite }),
  });
  const streams = new Map<Socket, string[]>();
  const lifecycleStreams = new Set<Socket>();
  const sockets = new Set<Socket>();
  const heldSnapshots: Array<() => void> = [];
  const heldSubscriptions: Array<() => void> = [];
  const socketPath = join(dir, "herdr.sock");
  const input = { herdrSessionName: "trial", sessionDir: dir, socketPath };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      streams.delete(socket);
      lifecycleStreams.delete(socket);
    });
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk) => {
      for (const raw of decoder.push(chunk.toString())) {
        const request = raw as {
          id: string;
          method: string;
          params: { subscriptions: Array<{ type: string; pane_id?: string }> };
        };
        if (request.method === "events.subscribe") {
          if (request.params.subscriptions.some((s) => s.type === "pane.created"))
            lifecycleStreams.add(socket);
          streams.set(
            socket,
            request.params.subscriptions.flatMap((s) => (s.pane_id ? [s.pane_id] : [])),
          );
          f.maxStreams = Math.max(f.maxStreams, streams.size);
          const reply = () =>
            socket.write(encodeJsonLine({ id: request.id, result: { subscribed: true } }));
          if (f.holdSubscription) heldSubscriptions.push(reply);
          else reply();
        } else if (request.method === "session.snapshot") {
          const agents = [
            { ...worker },
            ...(f.extraPane
              ? [
                  {
                    ...worker,
                    agent_session: null,
                    agent: "other",
                    pane_id: "wT:p2",
                    terminal_id: "extra",
                    name: "extra",
                  },
                ]
              : []),
          ];
          const reply = () =>
            socket.write(
              encodeJsonLine({
                id: request.id,
                result: {
                  snapshot: { agents, panes: agents, workspaces: [{ workspace_id: "wT" }] },
                },
              }),
            );
          if (f.holdSnapshot) heldSnapshots.push(reply);
          else reply();
        } else throw new Error(`unexpected request: ${request.method}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const f = {
    db,
    input,
    worker,
    delivery,
    streams,
    heldSnapshots,
    heldSubscriptions,
    holdSubscription: false,
    releaseSubscriptions() {
      f.holdSubscription = false;
      for (const reply of heldSubscriptions.splice(0)) reply();
    },
    holdSnapshot: false,
    extraPane: false,
    maxStreams: 0,
    subscribedPaneCount: () => [...streams.values()].flat().length,
    releaseSnapshots() {
      f.holdSnapshot = false;
      for (const reply of heldSnapshots.splice(0)) reply();
    },
    index: () =>
      new AgentIndexService({
        stores: db,
        history: createAgentHistoryService({ homeDir: dir, cache: db.agentHistoryCache }),
      }),
    emit(event: { type: string; pane_id?: string; workspace_id?: string; agent_status?: string }) {
      for (const [socket, panes] of streams) {
        if (
          event.type === "pane.agent_status_changed"
            ? panes.includes(event.pane_id ?? "")
            : lifecycleStreams.has(socket)
        )
          socket.write(encodeJsonLine({ event: event.type, data: event }));
      }
    },
    async turn(n: number) {
      worker.agent_status = "working";
      await appendFile(transcript, line(n, "user"));
      f.emit({
        type: "pane.agent_status_changed",
        pane_id: worker.pane_id,
        agent_status: "working",
      });
      await appendFile(transcript, line(n, "assistant"));
      worker.agent_status = "done";
      f.emit({ type: "pane.agent_status_changed", pane_id: worker.pane_id, agent_status: "done" });
    },
    events: () => db.agentEvents.listAfter({ herdrSessionName: "trial", limit: 1000 }),
    outcomes: () => {
      const rows = db.sqlite
        .prepare("select agent_event_id as id from delivery_obligations order by delivery_seq")
        .all() as { id: number }[];
      return rows.map((row) => db.agentEvents.get(row.id));
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.sqlite.close();
      cleanupTempDirs();
    },
  };
  return f;
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("fixture condition was not met");
    await sleep(5);
  }
}
