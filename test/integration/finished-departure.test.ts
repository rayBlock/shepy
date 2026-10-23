import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as timers from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { AgentContextSnapshotStore } from "@/db/agent-context-snapshots.js";
import { AgentEventStore } from "@/db/agent-events.js";
import { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import { AgentStore } from "@/db/agents.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { DeliveryObligationStore } from "@/db/delivery-obligations.js";
import { HerdrSessionStore } from "@/db/herdr-sessions.js";
import { HerdrWorkspaceStore } from "@/db/herdr-workspaces.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { ProfileOwnerStore } from "@/db/profile-owners.js";
import { AgentIndexService } from "@/observability/agent-index-service.js";
import { ProfileDeliveryService } from "@/observability/profile-delivery-service.js";
import { ProfileService } from "@/observability/profile-service.js";

vi.mock("node:timers/promises", { spy: true });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const input = {
  herdrSessionName: "default",
  sessionDir: "/fixture/herdr",
  socketPath: "/fixture/herdr.sock",
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "finished-"));
  const path = join(root, "worker.jsonl");
  const session = { agent: "pi", kind: "path", source: "herdr:pi", value: path };
  const worker = {
    agent: "pi",
    agent_session: session,
    agent_status: "working",
    cwd: root,
    name: "reviewer",
    pane_id: "w1:p2",
    terminal_id: "term-reviewer",
    workspace_id: "w1",
    revision: 1,
  };
  const time = Date.now() - 60_000;
  const message = (role: string, id: string, text: string, offset: number) =>
    `${JSON.stringify({
      type: "message",
      id,
      timestamp: new Date(time + offset).toISOString(),
      message: { role, content: [{ type: "text", text }] },
    })}\n`;
  await mkdir(join(root, "home"));
  await writeFile(
    path,
    `${JSON.stringify({ type: "session", version: 3, id: "review-session", cwd: root })}\n` +
      message("user", "user-1", "First review", 0) +
      message("assistant", "answer-1", "Earlier review finished", 1000) +
      message("user", "user-2", "Review the candidate and notify the owner", 2000),
  );
  let present = true;
  const databasePath = join(root, "state.sqlite");
  const open = () => {
    const { sqlite } = openSqlite(databasePath);
    applyMigrations(sqlite, { migrationsFolder: "drizzle" });
    const stores = {
      agentContextSnapshots: new AgentContextSnapshotStore(sqlite),
      agentEvents: new AgentEventStore(sqlite),
      agentHistoryCache: new AgentHistoryCacheStore(sqlite),
      agents: new AgentStore(sqlite),
      herdrSessions: new HerdrSessionStore(sqlite),
      herdrWorkspaces: new HerdrWorkspaceStore(sqlite),
    };
    const history = createAgentHistoryService({
      homeDir: join(root, "home"),
      cache: stores.agentHistoryCache,
    });
    const profiles = new OrchestratorProfileStore(sqlite);
    const obligations = new DeliveryObligationStore(sqlite);
    const delivery = new ProfileDeliveryService({
      ...stores,
      profiles,
      obligations,
      owners: new ProfileOwnerStore({ sqlite }),
    });
    const profileService = new ProfileService({ agents: stores.agents, history, profiles });
    const index = new AgentIndexService({
      stores,
      history,
      clientFactory: () => ({
        close() {},
        async sessionSnapshot() {
          return {
            agents: present ? [{ ...worker }] : [],
            panes: present ? [{ ...worker }] : [],
            workspaces: [{ workspace_id: "w1" }],
          };
        },
      }),
      onAgentGone: (gone) => delivery.projectGoneAgent(gone),
      onAgentsObserved: (agents) => profileService.observeAgents(agents),
    });
    return { sqlite, ...stores, profiles, obligations, delivery, profileService, index };
  };
  let daemon = open();
  cleanups.push(async () => {
    daemon.sqlite.close();
    await rm(root, { recursive: true, force: true });
  });
  const publish = (
    events: Awaited<ReturnType<AgentIndexService["handleHerdrEvent"]>>["events"],
  ) => {
    for (const event of events) daemon.delivery.projectAgentEvent(event);
  };
  return {
    get daemon() {
      return daemon;
    },
    async refresh() {
      const result = await daemon.index.refreshHerdrSession(input);
      publish(result.events);
      return result;
    },
    async status(status: string, seq: number) {
      worker.agent_status = status;
      const result = await daemon.index.handleHerdrEvent({
        ...input,
        event: {
          type: "pane.agent_status_changed",
          pane_id: worker.pane_id,
          agent_status: status,
          seq,
        },
      });
      publish(result.events);
      return result;
    },
    async final() {
      await appendFile(path, message("assistant", "answer-2", "reviewer done: verdict.md", 3000));
    },
    async nextTurn() {
      await appendFile(
        path,
        message("user", "user-3", "Check the correction", 4000) +
          message("assistant", "answer-3", "reviewer done: corrected-verdict.md", 5000),
      );
    },
    subscribe(profileId: string) {
      daemon.profileService.ensureProfile({ profileId, displayName: profileId, projectRoots: [] });
      daemon.profileService.addSubscription({
        ...input,
        workspaceId: "w1",
        profileId,
        agentSelector: { kind: "terminalId", value: worker.terminal_id },
      });
    },
    restart() {
      daemon.sqlite.close();
      daemon = open();
    },
    close() {
      present = false;
    },
    outcomes(profileId: string) {
      return daemon.obligations
        .pendingBatch({ profileId, limit: 100 })
        .map((row) => daemon.delivery.inboxGet(row.id)?.outcome);
    },
  };
}

// Hold just the delayed transcript read, as if the daemon died in that window.
async function holdRetry(start: () => Promise<unknown>) {
  let observed: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    observed = resolve;
  });
  vi.spyOn(timers, "setTimeout").mockImplementationOnce(() => {
    observed?.();
    return new Promise(() => {});
  });
  void start();
  await waiting;
}

test.each([
  false,
  true,
])("completed native turn closes as finished during history retry; restart=%s", async (restart) => {
  const f = await fixture();
  await f.refresh();
  f.subscribe("seat");
  await holdRetry(() => f.status("done", 10));
  await f.final(); // The verdict flush and owner prompt precede the pane close.
  if (restart) f.restart(); // Reopen SQLite and recreate every store; no pending map survives.
  f.close();
  await f.refresh();
  await f.refresh();
  expect(f.outcomes("seat").map((outcome) => outcome?.type)).toEqual(["agent.done"]);
  expect(
    f.daemon.agentEvents.listAfter({ limit: 100 }).find((event) => event.type === "agent.gone")
      ?.payload,
  ).toMatchObject({ from: "done", to: "gone" });
  expect(f.daemon.profiles.listSubscriptions("seat")).toHaveLength(0);
});

test.each([
  "done",
  "idle",
  "blocked",
])("a late subscription gets only the latest %s departure without duplicating existing delivery", async (status) => {
  const f = await fixture();
  await f.refresh();
  f.subscribe("seat");
  await f.final();
  await f.status("done", 10);
  await f.status("working", 11);
  await f.nextTurn();
  await f.status(status, 12);
  const done = f.outcomes("seat").at(-1);
  if (status !== "blocked") await f.status(status === "done" ? "idle" : "done", 13);
  // Deterministically put the late subscription after the durable settlement.
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10);
  f.subscribe("late-seat");
  f.restart();
  f.close();
  await f.refresh();
  await f.refresh();
  expect(f.outcomes("late-seat").map((outcome) => outcome?.type)).toEqual([`agent.${status}`]);
  expect(f.outcomes("late-seat")[0]?.eventId).toBe(done?.eventId);
  expect(f.outcomes("seat").map((outcome) => outcome?.type)).toEqual([
    "agent.done",
    `agent.${status}`,
  ]);
});

test("a resumed worker still closes unfinished after a recovered completion", async () => {
  const f = await fixture();
  await f.refresh();
  f.subscribe("seat");
  await holdRetry(() => f.status("done", 10));
  await f.final();
  f.restart();
  await f.status("working", 11);
  f.close();
  await f.refresh();
  await f.refresh();
  expect(f.outcomes("seat").map((outcome) => outcome?.type)).toEqual(["agent.done", "agent.gone"]);
  expect(f.outcomes("seat").at(-1)).toMatchObject({ from: "working", to: "gone" });
});
