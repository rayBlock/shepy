import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

type Event = { type: string; pane_id?: string; workspace_id?: string; agent_status?: string };

export async function shortTurnFixture() {
  const db = openObservabilityDbHarness();
  const dir = tempDirs.at(-1);
  if (!dir) throw new Error("missing fixture directory");
  const project = join(dir, ".claude", "projects", "-trial");
  await mkdir(project, { recursive: true });
  const session = "11111111-2222-4333-8444-555555555555";
  const transcript = join(project, `${session}.jsonl`);
  const worker = {
    agent: "claude",
    agent_status: "done",
    cwd: "/trial",
    name: "trial-worker",
    agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: session },
    pane_id: "wT:p1",
    revision: 1,
    terminal_id: "trial-terminal",
    workspace_id: "wT",
  };
  const workers = new Map([[worker.pane_id, worker]]);
  const shells = new Set<string>();
  const line = (n: number, role: "user" | "assistant") =>
    `${JSON.stringify({
      type: role,
      uuid: `${role}-${n}`,
      sessionId: session,
      cwd: worker.cwd,
      timestamp: new Date(Date.now() - 1000 + (role === "assistant" ? 1 : 0)).toISOString(),
      message: {
        role,
        content: [{ type: "text", text: `${role === "assistant" ? "answer" : "task"} ${n}` }],
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
  const delivery = new ProfileDeliveryService({
    agents: db.agents,
    agentEvents: db.agentEvents,
    profiles,
    obligations: new DeliveryObligationStore(db.sqlite),
    owners: new ProfileOwnerStore({ sqlite: db.sqlite }),
  });
  const streams = new Map<Socket, { panes: string[]; lifecycle: boolean }>();
  const sockets = new Set<Socket>();
  const heldSubscriptions: Array<() => void> = [];
  const heldSnapshots: Array<() => void> = [];
  const subscribeLog: Array<{ panes: string[]; accepted: boolean; snapshots: number }> = [];
  const input = { herdrSessionName: "trial", sessionDir: dir, socketPath: join(dir, "herdr.sock") };
  const index = new AgentIndexService({
    stores: db,
    history: createAgentHistoryService({ homeDir: dir, cache: db.agentHistoryCache }),
  });
  const manager = new HerdrSessionWatchManager({
    agents: db.agents,
    herdrSessions: db.herdrSessions,
    index,
    onAgentEvent: (event) => delivery.projectAgentEvent(event),
    onSessionRefreshed: () => {
      f.completedRefreshes++;
    },
    reconnectDelayMs: 10,
    activeRevisionPollMs: 60_000,
    sessionList: async () => [{ ...input, name: "trial", running: true }],
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      streams.delete(socket);
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
          const panes = request.params.subscriptions.flatMap((s) => (s.pane_id ? [s.pane_id] : []));
          const reply = () => {
            if (f.closeOnSubscribe && panes.includes(f.closeOnSubscribe))
              workers.delete(f.closeOnSubscribe);
            const accepted = panes.every((id) => workers.has(id) || shells.has(id));
            subscribeLog.push({ panes, accepted, snapshots: f.snapshotRequests });
            if (!accepted) {
              socket.write(
                encodeJsonLine({
                  id: request.id,
                  error: { code: "pane_not_found", message: "unknown pane" },
                }),
              );
              return;
            }
            // Real Herdr admits events only AFTER the subscription ACK.
            socket.write(encodeJsonLine({ id: request.id, result: { subscribed: true } }));
            streams.set(socket, {
              panes,
              lifecycle: request.params.subscriptions.some((s) => s.type === "pane.created"),
            });
            f.afterAck?.();
          };
          if (f.holdSubscriptions) heldSubscriptions.push(reply);
          else reply();
        } else if (request.method === "session.snapshot") {
          f.snapshotRequests++;
          const agents = [...workers.values()].map((w) => ({ ...w }));
          const snapshot = {
            agents,
            panes: [...agents, ...[...shells].map((pane_id) => ({ pane_id, workspace_id: "wT" }))],
            workspaces: [{ workspace_id: "wT" }],
          };
          const reply = () =>
            socket.write(encodeJsonLine({ id: request.id, result: { snapshot } }));
          if (f.holdSnapshots) heldSnapshots.push(reply);
          else reply();
        } else throw new Error(`unexpected request: ${request.method}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(input.socketPath, resolve));
  const f = {
    db,
    worker,
    workers,
    shells,
    manager,
    index,
    input,
    subscribeLog,
    heldSubscriptions,
    heldSnapshots,
    holdSubscriptions: false,
    holdSnapshots: false,
    completedRefreshes: 0,
    snapshotRequests: 0,
    closeOnSubscribe: undefined as string | undefined,
    afterAck: undefined as (() => void) | undefined,
    subscribed: (paneId: string) => [...streams.values()].some((s) => s.panes.includes(paneId)),
    emit(event: Event) {
      for (const [socket, subscription] of streams) {
        if (
          event.type === "pane.agent_status_changed"
            ? subscription.panes.includes(event.pane_id ?? "")
            : subscription.lifecycle
        )
          socket.write(encodeJsonLine({ event: event.type, data: event }));
      }
    },
    status(status: string) {
      worker.agent_status = status;
      f.emit({ type: "pane.agent_status_changed", pane_id: worker.pane_id, agent_status: status });
    },
    async final(n: number) {
      await appendFile(transcript, line(n, "user") + line(n, "assistant"));
    },
    async turn(n: number) {
      await appendFile(transcript, line(n, "user"));
      f.status("working");
      await appendFile(transcript, line(n, "assistant"));
      f.status("done");
    },
    async refresh() {
      const result = await index.refreshHerdrSession(input);
      for (const event of result.events) delivery.projectAgentEvent(event);
      return result;
    },
    releaseSubscriptions() {
      f.holdSubscriptions = false;
      for (const reply of heldSubscriptions.splice(0)) reply();
    },
    releaseSnapshots() {
      f.holdSnapshots = false;
      for (const reply of heldSnapshots.splice(0)) reply();
    },
    async start() {
      await manager.start();
      await until(
        () =>
          f.subscribed(worker.pane_id) &&
          db.agents.list({}).some((a) => a.paneId === worker.pane_id),
      );
      await f.refresh();
    },
    async rescan() {
      const before = f.completedRefreshes;
      await manager.rescanNow();
      await until(() => f.completedRefreshes > before);
    },
    events: () => db.agentEvents.listAfter({ herdrSessionName: "trial", limit: 1000 }),
    outcomes: () =>
      (
        db.sqlite
          .prepare("select agent_event_id as id from delivery_obligations order by delivery_seq")
          .all() as { id: number }[]
      ).map((row) => db.agentEvents.get(row.id)),
    async close() {
      f.releaseSnapshots();
      f.releaseSubscriptions();
      await manager.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.sqlite.close();
      cleanupTempDirs();
    },
  };
  return f;
}

export async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("fixture condition was not met");
    await sleep(5);
  }
}
