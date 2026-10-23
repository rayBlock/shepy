import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as timers from "node:timers/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { HerdrSessionWatchManager } from "@/daemon/herdr-session-watch-manager.js";
import { DeliveryObligationStore } from "@/db/delivery-obligations.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { ProfileOwnerStore } from "@/db/profile-owners.js";
import { AgentIndexService } from "@/observability/agent-index-service.js";
import type { AgentEventRecord, AgentSessionRef } from "@/observability/contracts.js";
import {
  ProfileDeliveryService,
  projectInboxOutcome,
} from "@/observability/profile-delivery-service.js";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";

vi.mock("node:timers/promises", { spy: true });

const homes: string[] = [];
const databases: ReturnType<typeof openObservabilityDbHarness>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.sqlite.close();
  cleanupTempDirs();
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const input = {
  herdrSessionName: "default",
  sessionDir: "/tmp/herdr",
  socketPath: "/tmp/herdr.sock",
};
const baseTime = Date.now() - 60_000;
const userTime = new Date(baseTime).toISOString();
const answerTime = new Date(baseTime + 1000).toISOString();
const nextUserTime = new Date(baseTime + 2000).toISOString();
const nextAnswerTime = new Date(baseTime + 3000).toISOString();

type Worker = {
  agent: string;
  agent_session: AgentSessionRef | null;
  agent_status: string;
  cwd: string;
  name: string;
  pane_id: string;
  revision: number;
  terminal_id: string;
  workspace_id: string;
};
function worker(name: string, agent = "pi"): Worker {
  return {
    agent,
    agent_session: null,
    agent_status: "working",
    cwd: `/work/${name}`,
    name,
    pane_id: `wA:${name}`,
    revision: 1,
    terminal_id: `term_${name}`,
    workspace_id: "wA",
  };
}
function line(w: Worker, role: "assistant" | "user", text: string, timestamp: string, id: string) {
  const message = { role, content: [{ type: "text", text }] };
  return `${JSON.stringify(
    w.agent === "pi"
      ? { type: "message", id, timestamp, message }
      : { type: role, uuid: id, timestamp, cwd: w.cwd, sessionId: w.name, message },
  )}\n`;
}
async function source(home: string, w: Worker, text?: string, projectCwd = w.cwd) {
  const folder =
    w.agent === "pi"
      ? join(
          home,
          ".pi",
          "agent",
          "sessions",
          `--${projectCwd.replace(/^\//, "").replaceAll("/", "-")}--`,
        )
      : join(home, ".claude", "projects", projectCwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const path = join(folder, `${w.name}.jsonl`);
  await mkdir(folder, { recursive: true });
  await writeFile(
    path,
    (w.agent === "pi"
      ? `${JSON.stringify({ type: "session", version: 3, id: w.name, cwd: w.cwd })}\n`
      : "") +
      line(w, "user", `task ${w.name}`, userTime, "user") +
      (text ? line(w, "assistant", text, answerTime, "final") : ""),
  );
  w.agent_session = { agent: w.agent, kind: "id", source: `herdr:${w.agent}`, value: w.name };
  return path;
}
async function fixture(workers: Worker[]) {
  const home = await mkdtemp(join(tmpdir(), "s1-home-"));
  homes.push(home);
  const db = openObservabilityDbHarness();
  databases.push(db);
  const history = createAgentHistoryService({ homeDir: home, cache: db.agentHistoryCache });
  const profiles = new OrchestratorProfileStore(db.sqlite);
  profiles.createProfile({ profileId: "seat", displayName: "Seat", projectRoots: [] });
  for (const w of workers)
    profiles.addSubscription({
      profileId: "seat",
      herdrSessionName: "default",
      workspaceSelectorJson: JSON.stringify({ herdrSession: "default", workspaceId: "wA" }),
      agentSelectorJson: JSON.stringify({ kind: "terminalId", value: w.terminal_id }),
    });
  const obligations = new DeliveryObligationStore(db.sqlite);
  const delivery = new ProfileDeliveryService({
    agentEvents: db.agentEvents,
    agents: db.agents,
    profiles,
    obligations,
    owners: new ProfileOwnerStore({ sqlite: db.sqlite }),
  });
  let snapshots = 0;
  let failSnapshot = false;
  const makeIndex = () =>
    new AgentIndexService({
      stores: db,
      history,
      clientFactory: () => ({
        close() {},
        async sessionSnapshot() {
          snapshots++;
          if (failSnapshot) throw new Error("Herdr unavailable");
          return { agents: workers.map((w) => ({ ...w })), panes: [], workspaces: [] };
        },
      }),
    });
  let index = makeIndex();
  const publish = (events: AgentEventRecord[]) => {
    for (const event of events) delivery.projectAgentEvent(event);
    return events;
  };
  return {
    home,
    db,
    history,
    obligations,
    delivery,
    get index() {
      return index;
    },
    snapshots: () => snapshots,
    failSnapshot() {
      failSnapshot = true;
    },
    restart() {
      index = makeIndex();
    },
    async refresh() {
      return publish((await index.refreshHerdrSession(input)).events);
    },
    async status(w: Worker, status: string, seq?: number) {
      w.agent_status = status;
      return publish(
        (
          await index.handleHerdrEvent({
            ...input,
            event: {
              type: "pane.agent_status_changed",
              pane_id: w.pane_id,
              agent_status: status,
              seq,
            },
          })
        ).events,
      );
    },
    outcomes() {
      return db.agentEvents
        .listAfter({ herdrSessionName: "default", workspaceId: "wA" })
        .filter((e) => obligations.byProfileEvent("seat", e.id))
        .map((event) => {
          const outcome = projectInboxOutcome(event);
          return { ...outcome, assistantText: outcome.excerpt?.text ?? null };
        });
    },
  };
}

test("no identity refuses newer foreign and same-cwd files, including persisted fallback hints", async () => {
  const a = worker("a");
  const f = await fixture([a]);
  const b = worker("b");
  const foreign = await source(f.home, b, "FOREIGN");
  await f.refresh();
  const agent = f.db.agents.list()[0];
  if (!agent) throw new Error("missing indexed worker");
  const poison = await f.history.readCompactRef({
    kind: "discovered_file",
    path: foreign,
    value: foreign,
    source: "pi-jsonl",
  });
  f.db.agentContextSnapshots.put({ ...poison, agentId: agent.id, paneRevision: 1 });
  await f.status(a, "idle");
  expect(f.outcomes().every((notice) => notice.assistantText !== "FOREIGN")).toBe(true);
  expect(f.db.agentContextSnapshots.get(agent.id)?.historyRef).toBeNull();
  const sameCwd = worker("neighbor");
  sameCwd.cwd = a.cwd;
  await source(f.home, sameCwd, "NEIGHBOR");
  expect(
    (
      await f.history.getCompactHistory({
        agent: "pi",
        agentSession: null,
        cwd: a.cwd,
        foregroundCwd: null,
      })
    ).lastAssistantMessage,
  ).toBeNull();
  const own = await source(f.home, a, "A ONLY");
  await f.status(a, "working");
  await appendFile(own, line(a, "assistant", "A FINAL", answerTime, "new-final"));
  await f.status(a, "idle");
  expect(f.outcomes().at(-1)?.assistantText).toBe("A FINAL");
});

test("refreshes Herdr identity before reading: two Pi workers and Claude keep their own final text", async () => {
  const workers = [worker("pi-a"), worker("pi-b"), worker("claude", "claude")];
  const f = await fixture(workers);
  await f.refresh(); // Indexed before Herdr knows their native session IDs.
  for (const w of workers) await source(f.home, w, `${w.name} done: report`);
  await Promise.all(workers.map((w) => f.status(w, "done")));
  expect(
    f
      .outcomes()
      .map((o) => o.assistantText)
      .sort(),
  ).toEqual(workers.map((w) => `${w.name} done: report`).sort());
  for (const w of workers)
    expect(
      f.db.agents.findByTerminal({ herdrSessionName: "default", terminalId: w.terminal_id })
        ?.agentSession,
    ).toEqual(w.agent_session);
});

test.each([
  "idle",
  "done",
])("startup unknown to %s without text never notifies; no retry at startup", async (status) => {
  const w = worker("fresh");
  w.agent_status = status;
  const f = await fixture([w]);
  const wait = vi.mocked(timers.setTimeout).mockClear();
  await f.status(w, status);
  expect(f.outcomes()).toEqual([]);
  expect(wait).not.toHaveBeenCalled();
});

test("startup blocked emits once across restart and ticks; leaving and reentering emits again", async () => {
  const w = worker("approval", "claude");
  w.agent_status = "blocked";
  const f = await fixture([w]);
  await f.refresh();
  f.restart();
  for (let i = 0; i < 3; i++) await f.refresh();
  await f.status(w, "blocked");
  expect(f.outcomes()).toHaveLength(1);
  expect(f.outcomes()[0]?.type).toBe("agent.blocked");
  await f.status(w, "working");
  await f.status(w, "blocked");
  expect(f.outcomes()).toHaveLength(2);
});

test("recovered unknown blocked and unknown idle use the same path with opposite notification policy", async () => {
  const blocked = worker("blocked");
  blocked.agent_status = "blocked";
  const idle = worker("idle");
  idle.agent_status = "idle";
  const f = await fixture([blocked, idle]);
  await f.status(blocked, "blocked");
  await f.status(idle, "idle");
  expect(f.outcomes()).toHaveLength(1);
  expect(f.outcomes()[0]?.type).toBe("agent.blocked");
});

test("duplicate Claude IDs choose the cwd project directory, not header cwd or cached old folder", async () => {
  const w = worker("resumed", "claude");
  const f = await fixture([w]);
  const wrong = await source(f.home, w, "OLD FOLDER", "/work/elsewhere");
  const right = await source(f.home, w, "RIGHT FOLDER");
  const lookup = { agent: w.agent, agentSession: w.agent_session, cwd: w.cwd, foregroundCwd: null };
  const hint = {
    kind: "agent_session" as const,
    path: wrong,
    value: w.name,
    source: "claude-jsonl" as const,
  };
  expect(
    (await f.history.resolveCompactHistory(lookup, { preferredRef: hint })).historyRef?.path,
  ).toBe(right);
  expect(
    (await f.history.read(lookup, { preferredRef: hint, limit: 5 })).messages.at(-1)?.text,
  ).toBe("RIGHT FOLDER");
  expect(
    (await f.history.resolveCompactHistory({ ...lookup, cwd: "/neither" })).historyRef,
  ).toBeNull();
  expect(
    (await f.history.resolveCompactHistory({ ...lookup, cwd: null }, { preferredRef: hint }))
      .historyRef,
  ).toBeNull();
  expect(
    (await f.history.read({ ...lookup, cwd: null }, { preferredRef: hint, limit: 5 })).messages,
  ).toEqual([]);
  await rm(dirname(wrong), { recursive: true });
  expect(
    (await f.history.resolveCompactHistory(lookup)).compactHistory.lastAssistantMessage?.text,
  ).toBe("RIGHT FOLDER");
});

test.each([
  "missing",
  "previous-turn",
  "unreadable",
])("one real delayed re-read repairs %s text without blocking another pane", async (mode) => {
  const a = worker("slow");
  const b = worker("fast", "claude");
  const f = await fixture([a, b]);
  const path = await source(f.home, a, mode === "previous-turn" ? "PREVIOUS" : undefined);
  const fast = await source(f.home, b);
  if (mode === "previous-turn")
    await appendFile(path, line(a, "user", "new task", nextUserTime, "new-user"));
  await f.refresh();
  if (mode === "unreadable") {
    await rename(path, `${path}.saved`);
    await mkdir(path);
  }
  const { setTimeout: realSleep } = await vi.importActual<typeof timers>("node:timers/promises");
  const retryStarted = Promise.withResolvers<void>();
  const releaseRetry = Promise.withResolvers<void>();
  // Keep the real settle wait, but hold its continuation until both the producer
  // and the other pane have finished. Scheduler latency is not a product bound.
  // Moving the wait inside the session queue deadlocks the fast pane and fails.
  const settleWait = vi
    .mocked(timers.setTimeout)
    .mockClear()
    .mockImplementation((delay) => {
      retryStarted.resolve();
      return realSleep(delay).then(() => releaseRetry.promise);
    });
  const pending = f.status(a, "idle");
  await retryStarted.promise;
  // The producer flushes independently of the second pane's work.
  const writer = realSleep(300).then(async () => {
    if (mode === "unreadable") {
      await appendFile(
        `${path}.saved`,
        line(a, "assistant", "SLOW FINAL", nextAnswerTime, "new-final"),
      );
      // Rename the unreadable entry aside, rather than recursively deleting
      // it on the producer's 300 ms flush path.
      await rename(path, `${path}.unreadable`);
      await rename(`${path}.saved`, path);
    } else {
      await appendFile(path, line(a, "assistant", "SLOW FINAL", nextAnswerTime, "new-final"));
    }
  });
  try {
    await appendFile(fast, line(b, "assistant", "FAST FINAL", answerTime, "final"));
    await f.status(b, "done");
    await writer;
    expect(f.outcomes().map((o) => o.assistantText)).toEqual(["FAST FINAL"]);
    expect(settleWait).toHaveBeenCalledTimes(1);
  } finally {
    releaseRetry.resolve();
    await pending;
    await writer;
  }
  expect(f.outcomes().map((o) => o.assistantText)).toEqual(["FAST FINAL", "SLOW FINAL"]);
});

test("old text still missing after retry stays empty, not the previous turn; fresh text never waits", async () => {
  const w = worker("old");
  const f = await fixture([w]);
  const path = await source(f.home, w, "PREVIOUS");
  await appendFile(path, line(w, "user", "next task", nextUserTime, "new-user"));
  await f.refresh();
  const started = performance.now();
  await f.status(w, "idle");
  expect(performance.now() - started).toBeGreaterThanOrEqual(450);
  expect(f.outcomes()[0]?.assistantText).toBeNull();
  await f.status(w, "working");
  await appendFile(
    path,
    line(w, "assistant", "FRESH", new Date(Date.now() + 1000).toISOString(), "fresh"),
  );
  const wait = vi.mocked(timers.setTimeout).mockClear();
  await f.status(w, "idle");
  expect(wait).not.toHaveBeenCalled();
  expect(f.outcomes().at(-1)?.assistantText).toBe("FRESH");
});

test("watch stream publishes another pane while a missing final is pending and drains on stop", async () => {
  const slow = worker("watch-slow");
  const fast = worker("watch-fast", "claude");
  const f = await fixture([slow, fast]);
  await source(f.home, slow);
  await source(f.home, fast, "WATCH FAST");
  await f.refresh();
  let fastPublished!: () => void;
  const published = new Promise<void>((resolve) => {
    fastPublished = resolve;
  });
  const manager = new HerdrSessionWatchManager({
    agents: f.db.agents,
    herdrSessions: f.db.herdrSessions,
    index: f.index,
    sessionList: async () => [
      {
        name: "default",
        running: true,
        sessionDir: input.sessionDir,
        socketPath: input.socketPath,
      },
    ],
    clientFactory: () => ({
      close() {},
      async *subscribeEvents(_params, options) {
        options?.onSubscribed?.();
        slow.agent_status = "idle";
        yield { type: "pane.agent_status_changed", pane_id: slow.pane_id, agent_status: "idle" };
        fast.agent_status = "done";
        yield { type: "pane.agent_status_changed", pane_id: fast.pane_id, agent_status: "done" };
        if (!options?.signal?.aborted)
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
      },
    }),
    onAgentEvent(event) {
      f.delivery.projectAgentEvent(event);
      if (event.terminalId === fast.terminal_id) fastPublished();
    },
  });
  try {
    await manager.start();
    await published;
    expect(f.outcomes().map((o) => o.assistantText)).toEqual(["WATCH FAST"]);
  } finally {
    await manager.stop();
  }
  expect(f.outcomes().map((o) => o.assistantText)).toEqual(["WATCH FAST", null]);
});

test("previous settled text is re-read even if the next user record has not flushed", async () => {
  const w = worker("previous");
  const f = await fixture([w]);
  const path = await source(f.home, w, "FIRST FINAL");
  await f.refresh();
  await f.status(w, "idle");
  await f.status(w, "working");
  const started = performance.now();
  const pending = f.status(w, "done");
  const writer = sleep(300).then(() =>
    appendFile(
      path,
      line(w, "assistant", "SECOND FINAL", new Date().toISOString(), "second-final"),
    ),
  );
  await Promise.all([pending, writer]);
  expect(performance.now() - started).toBeGreaterThanOrEqual(450);
  expect(f.outcomes().map((o) => o.assistantText)).toEqual(["FIRST FINAL", "SECOND FINAL"]);
});

test.each([
  "event",
  "snapshot",
])("a new turn during the retry cannot be attached to the prior completion via %s", async (route) => {
  const w = worker("reentered");
  const f = await fixture([w]);
  const path = await source(f.home, w);
  await f.refresh();
  const pending = f.status(w, "idle");
  await sleep(60);
  if (route === "event") await f.status(w, "working");
  else {
    w.agent_status = "working";
    await f.refresh();
  }
  const transitions = () =>
    f.db.agentEvents
      .listAfter({ herdrSessionName: "default", workspaceId: "wA" })
      .filter((event) => event.type === "agent.status.changed")
      .map((event) => event.payload);
  const atSupersession = transitions();
  await appendFile(path, line(w, "assistant", "NEXT TURN", new Date().toISOString(), "next-final"));
  await f.status(w, "done");
  await pending;
  const outcomes = f.outcomes();
  expect(outcomes.find((o) => o.to === "idle")?.assistantText).toBeNull();
  expect(outcomes.find((o) => o.to === "done")?.assistantText).toBe("NEXT TURN");
  expect(atSupersession).toEqual([
    expect.objectContaining({ from: "working", to: "idle" }),
    expect.objectContaining({ from: "idle", to: "working" }),
  ]);
  expect(transitions()).toEqual([
    ...atSupersession,
    expect.objectContaining({ from: "working", to: "done" }),
  ]);
  expect(outcomes.map((o) => o.to)).toEqual(["idle", "done"]);
  expect(f.db.agents.list()[0]?.agentStatus).toBe("done");
});

test.each([
  "event",
  "snapshot",
])("status and event roll back together after append failure on %s, then restart recovers", async (route) => {
  for (const withText of [true, false]) {
    const w = worker(`append-failure-${route}-${withText}`);
    const f = await fixture([w]);
    const path = await source(f.home, w);
    await f.refresh();
    if (withText)
      await appendFile(
        path,
        line(w, "assistant", "RECOVERED FINAL", new Date().toISOString(), "final"),
      );
    const append = vi.spyOn(f.db.agentEvents, "append").mockImplementationOnce(() => {
      throw new Error("injected append failure");
    });
    w.agent_status = "idle";
    await expect(route === "event" ? f.status(w, "idle") : f.refresh()).rejects.toThrow(
      "injected append failure",
    );
    append.mockRestore();
    const persistedAfterFailure = f.db.agents.list()[0]?.agentStatus;
    f.restart();
    for (let i = 0; i < 3; i++) await f.refresh();
    expect(persistedAfterFailure).toBe("working");
    expect(f.outcomes()).toHaveLength(1);
    expect(f.outcomes()[0]?.assistantText).toBe(withText ? "RECOVERED FINAL" : null);
    expect(f.db.agents.list()[0]?.agentStatus).toBe("idle");
  }
});

test("a failure on the semantic twin rolls back the generic event and status too", async () => {
  const w = worker("semantic-failure");
  const f = await fixture([w]);
  const path = await source(f.home, w);
  await f.refresh();
  await appendFile(path, line(w, "assistant", "FINAL", new Date().toISOString(), "final"));
  const realAppend = f.db.agentEvents.append.bind(f.db.agentEvents);
  const append = vi
    .spyOn(f.db.agentEvents, "append")
    .mockImplementationOnce(realAppend)
    .mockImplementationOnce(() => {
      throw new Error("semantic append failed");
    });
  await expect(f.status(w, "done")).rejects.toThrow("semantic append failed");
  append.mockRestore();
  expect(f.db.agents.list()[0]?.agentStatus).toBe("working");
  expect(f.db.agentEvents.listAfter({ herdrSessionName: "default", workspaceId: "wA" })).toEqual(
    [],
  );
  f.restart();
  await f.refresh();
  expect(f.outcomes().map((o) => o.assistantText)).toEqual(["FINAL"]);
});

test("a pending retry leaves the persisted row working and ignores duplicate settled observations", async () => {
  const w = worker("pending-duplicates");
  const f = await fixture([w]);
  await source(f.home, w);
  await f.refresh();
  const pending = f.status(w, "idle");
  await sleep(60);
  const duringRetry = f.db.agents.list()[0]?.agentStatus;
  const duplicate = await f.status(w, "done");
  await f.refresh();
  const beforeFlush = f.db.agentEvents.listAfter({
    herdrSessionName: "default",
    workspaceId: "wA",
  });
  await pending;
  expect(duringRetry).toBe("working");
  expect(duplicate).toEqual([]);
  // The non-notifiable observation is durable before the delayed final;
  // duplicates still add neither another observation nor an outcome.
  expect(beforeFlush).toHaveLength(1);
  expect(beforeFlush[0]).toMatchObject({
    type: "agent.status.changed",
    payload: { from: "working", to: "idle" },
  });
  expect(f.outcomes()).toHaveLength(1);
  expect(f.outcomes()[0]?.to).toBe("idle");
  expect(f.db.agents.list()[0]?.agentStatus).toBe("idle");
});

test("an initial blocked append failure leaves a recoverable unknown row", async () => {
  const w = worker("initial-blocked-failure");
  w.agent_status = "blocked";
  const f = await fixture([w]);
  const append = vi.spyOn(f.db.agentEvents, "append").mockImplementationOnce(() => {
    throw new Error("initial blocked append failed");
  });
  await expect(f.refresh()).rejects.toThrow("initial blocked append failed");
  append.mockRestore();
  expect(f.db.agents.list()[0]?.agentStatus).toBe("unknown");
  f.restart();
  for (let i = 0; i < 3; i++) await f.refresh();
  expect(f.outcomes()).toHaveLength(1);
  expect(f.outcomes()[0]?.type).toBe("agent.blocked");
});

test("P4 persisted working row observes blocked once after restart and three ticks", async () => {
  const w = worker("persisted-blocked", "claude");
  const f = await fixture([w]);
  await source(f.home, w);
  await f.refresh();
  w.agent_status = "blocked";
  f.restart();
  for (let i = 0; i < 4; i++) await f.refresh();
  await f.status(w, "blocked");
  expect(f.outcomes()).toHaveLength(1);
  expect(f.outcomes()[0]).toMatchObject({ from: "working", to: "blocked", type: "agent.blocked" });
});

test("P5 a flushed next-user record cannot deliver the previous settled text", async () => {
  const w = worker("previous-user");
  const f = await fixture([w]);
  const path = await source(f.home, w, "FIRST");
  await f.refresh();
  await f.status(w, "idle");
  await f.status(w, "working");
  await appendFile(path, line(w, "user", "second task", new Date().toISOString(), "next-user"));
  await f.status(w, "idle");
  expect(f.outcomes().map((o) => o.assistantText)).toEqual(["FIRST", null]);
});

test("P6 a snapshot batch publishes its fresh pane before the other pane's retry", async () => {
  const slow = worker("snapshot-slow");
  const fast = worker("snapshot-fast");
  const f = await fixture([slow, fast]);
  await source(f.home, slow);
  const path = await source(f.home, fast);
  let ready!: () => void;
  const startedWatching = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let fastPublished!: () => void;
  const fresh = new Promise<void>((resolve) => {
    fastPublished = resolve;
  });
  let slowPublished!: () => void;
  const retried = new Promise<void>((resolve) => {
    slowPublished = resolve;
  });
  let slowDelivered = false;
  const contextStatuses: string[][] = [];
  const manager = new HerdrSessionWatchManager({
    agents: f.db.agents,
    herdrSessions: f.db.herdrSessions,
    index: f.index,
    sessionList: async () => [
      {
        name: "default",
        running: true,
        sessionDir: input.sessionDir,
        socketPath: input.socketPath,
      },
    ],
    clientFactory: () => ({
      close() {},
      async *subscribeEvents(_params, options) {
        options?.onSubscribed?.();
        if (!options?.signal?.aborted)
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
      },
    }),
    onAgentIndexRefreshed() {
      ready();
    },
    onAgentContextChanged() {
      contextStatuses.push(f.db.agents.list().map((agent) => agent.agentStatus));
    },
    onAgentEvent(event) {
      f.delivery.projectAgentEvent(event);
      if (event.terminalId === slow.terminal_id) {
        slowDelivered = true;
        slowPublished();
      }
      if (event.terminalId === fast.terminal_id) fastPublished();
    },
  });
  let slowAtFresh = true;
  try {
    await manager.start();
    await startedWatching;
    slow.agent_status = "idle";
    fast.agent_status = "idle";
    await appendFile(
      path,
      line(fast, "assistant", "FAST SNAPSHOT", new Date().toISOString(), "final"),
    );
    await manager.rescanNow();
    await fresh;
    slowAtFresh = slowDelivered;
    await retried;
  } finally {
    await manager.stop();
  }
  expect(slowAtFresh).toBe(false);
  expect(f.outcomes().map((o) => o.assistantText)).toEqual(["FAST SNAPSHOT", null]);
  expect(contextStatuses).toContainEqual(["idle", "working"]);
  expect(contextStatuses.at(-1)).toEqual(["idle", "idle"]);
});

test("a failed identity refresh refuses history instead of trusting the old session", async () => {
  const w = worker("identity-failure");
  const f = await fixture([w]);
  await source(f.home, w, "OLD IDENTITY");
  await f.refresh();
  f.failSnapshot();
  await expect(f.status(w, "done")).rejects.toThrow("Herdr unavailable");
  expect(f.outcomes()).toEqual([]);
});

test("snapshot completions with fresh text do not take the retry delay", async () => {
  const workers = Array.from({ length: 5 }, (_, i) => worker(`snapshot-${i}`));
  const f = await fixture(workers);
  const paths = await Promise.all(workers.map((w) => source(f.home, w)));
  await f.refresh();
  await Promise.all(
    workers.map((w, i) => {
      w.agent_status = "done";
      return appendFile(
        paths[i] ?? "",
        line(w, "assistant", `${w.name} FINAL`, new Date().toISOString(), "final"),
      );
    }),
  );
  const wait = vi.mocked(timers.setTimeout).mockClear();
  await f.refresh();
  expect(wait).not.toHaveBeenCalled();
  expect(
    f
      .outcomes()
      .map((o) => o.assistantText)
      .sort(),
  ).toEqual(workers.map((w) => `${w.name} FINAL`).sort());
});

test("five missing finals in a snapshot share one wait rather than five serial sleeps", async () => {
  const workers = Array.from({ length: 5 }, (_, i) => worker(`delayed-snapshot-${i}`));
  const f = await fixture(workers);
  const paths = await Promise.all(workers.map((w) => source(f.home, w)));
  await f.refresh();
  for (const w of workers) w.agent_status = "idle";
  const { setTimeout: realSleep } = await vi.importActual<typeof timers>("node:timers/promises");
  const allWaiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let waits = 0;
  vi.mocked(timers.setTimeout).mockImplementation((delay) => {
    if (++waits === workers.length) allWaiting.resolve();
    return realSleep(delay).then(() => release.promise);
  });
  const pending = f.refresh();
  // Every pane must enter its wait before any wait is released. Serial waits
  // cannot reach this barrier; elapsed time under machine load is irrelevant.
  await allWaiting.promise;
  try {
    await realSleep(300);
    await Promise.all(
      workers.map((w, i) =>
        appendFile(
          paths[i] ?? "",
          line(w, "assistant", `${w.name} FINAL`, new Date().toISOString(), "final"),
        ),
      ),
    );
    expect(waits).toBe(workers.length);
    expect(f.outcomes()).toEqual([]);
  } finally {
    release.resolve();
    await pending;
  }
  expect(f.outcomes()).toHaveLength(5);
  expect(f.outcomes().every((o) => o.assistantText?.endsWith("FINAL"))).toBe(true);
});

test("five-agent startup adds no per-agent sleep; missing transcript does not borrow", async () => {
  const workers = Array.from({ length: 5 }, (_, i) => worker(`startup-${i}`));
  for (const w of workers) w.agent_status = "idle";
  const f = await fixture(workers);
  const wait = vi.mocked(timers.setTimeout).mockClear();
  await f.refresh();
  expect(wait).not.toHaveBeenCalled();
  const missing = workers[0];
  if (!missing) throw new Error("missing worker");
  missing.agent_session = {
    agent: "pi",
    kind: "path",
    source: "herdr:pi",
    value: join(f.home, "absent.jsonl"),
  };
  await f.status(missing, "working");
  await f.status(missing, "done");
  expect(f.outcomes()).toHaveLength(1);
  expect(f.outcomes()[0]?.assistantText).toBeNull();
});
