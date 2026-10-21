import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { formatHookContext, type LeasedObligation } from "@/cli/claude-hook.js";
import { DeliveryObligationStore } from "@/db/delivery-obligations.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { ProfileOwnerStore } from "@/db/profile-owners.js";
import { AgentIndexService } from "@/observability/agent-index-service.js";
import type { AgentEventRecord } from "@/observability/contracts.js";
import {
  ProfileDeliveryService,
  projectInboxOutcome,
} from "@/observability/profile-delivery-service.js";
import { formatProfileObligationUpdates } from "../../packages/shepy-pi/src/wake.js";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";

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

type Worker = {
  agent: string;
  agent_session: null | { agent: string; kind: "id"; source: string; value: string };
  agent_status: string;
  cwd: string;
  name: string;
  pane_id: string;
  revision: number;
  terminal_id: string;
  workspace_id: string;
};
function worker(name: string, agent = "cursor"): Worker {
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

type ReadCall = { lines: number; target: string; timeoutMs: number };
type Reply = { paneId?: string | null; text: string } | Error | "hang";

async function fixture(workers: Worker[]) {
  const home = await mkdtemp(join(tmpdir(), "s5-home-"));
  homes.push(home);
  const db = openObservabilityDbHarness();
  databases.push(db);
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
  const reads: ReadCall[] = [];
  // Per pane: the screen Herdr would return. A function sees the call count.
  const screens = new Map<string, Reply | ((count: number) => Reply)>();
  const index = new AgentIndexService({
    stores: db,
    history: createAgentHistoryService({ homeDir: home, cache: db.agentHistoryCache }),
    clientFactory: () => ({
      close() {},
      async sessionSnapshot() {
        return { agents: workers.map((w) => ({ ...w })), panes: [], workspaces: [] };
      },
      async readAgentScreen(call: ReadCall) {
        reads.push(call);
        const configured = screens.get(call.target);
        const reply =
          typeof configured === "function"
            ? configured(reads.filter((r) => r.target === call.target).length)
            : (configured ?? { paneId: call.target, text: "" });
        if (reply === "hang") return new Promise<never>(() => {});
        if (reply instanceof Error) throw reply;
        return {
          paneId: reply.paneId === undefined ? call.target : reply.paneId,
          text: reply.text,
        };
      },
    }),
  });
  const publish = (events: AgentEventRecord[]) => {
    for (const event of events) delivery.projectAgentEvent(event);
    return events;
  };
  return {
    db,
    home,
    obligations,
    reads,
    screens,
    refresh: async () => publish((await index.refreshHerdrSession(input)).events),
    async status(w: Worker, status: string) {
      w.agent_status = status;
      return publish(
        (
          await index.handleHerdrEvent({
            ...input,
            event: { type: "pane.agent_status_changed", pane_id: w.pane_id, agent_status: status },
          })
        ).events,
      );
    },
    notices() {
      return db.agentEvents
        .listAfter({ herdrSessionName: "default", workspaceId: "wA" })
        .filter((e) => obligations.byProfileEvent("seat", e.id))
        .map((event) => ({ event, outcome: projectInboxOutcome(event) }));
    },
  };
}

const reply = (text: string) => ({ text });

test("a reader-less kind finishes: the notice carries its screen text, marked as screen text", async () => {
  const w = worker("alpha");
  const f = await fixture([w]);
  f.screens.set(
    w.pane_id,
    reply("────────\nI renamed the helper and ran the checks.\n❯ \n────────"),
  );
  await f.refresh();
  await f.status(w, "done");
  const [notice] = f.notices();
  expect(notice?.outcome).toMatchObject({
    excerpt: { text: "I renamed the helper and ran the checks.", truncated: false },
    textSource: "screen",
    type: "agent.done",
  });
  // The screen is not assistant text: it stays off the assistant fields.
  expect(notice?.event.compactHistory?.lastAssistantMessage).toBeNull();
  expect(f.reads).toEqual([{ lines: 60, target: w.pane_id, timeoutMs: 1_500 }]);
  // The snapshot and the agent list never carry it.
  const agent = f.db.agents.list()[0];
  expect(JSON.stringify(f.db.agentContextSnapshots.get(agent?.id ?? ""))).not.toContain("renamed");
});

test("a harness with a reader never reads the screen, with or without a transcript", async () => {
  const withText = worker("pi-a", "pi");
  const noTranscript = worker("claude-b", "claude");
  const f = await fixture([withText, noTranscript]);
  for (const w of [withText, noTranscript])
    f.screens.set(w.pane_id, reply("SCREEN SHOULD NOT SHOW"));
  const folder = join(f.home, ".pi", "agent", "sessions", "--work-pi-a--");
  await mkdir(folder, { recursive: true });
  const path = join(folder, "pi-a.jsonl");
  const stamp = (offset: number) => new Date(Date.now() + offset).toISOString();
  await writeFile(
    path,
    `${JSON.stringify({ type: "session", version: 3, id: "pi-a", cwd: withText.cwd })}\n` +
      `${JSON.stringify({ type: "message", id: "u", timestamp: stamp(-2000), message: { role: "user", content: [{ type: "text", text: "task" }] } })}\n` +
      `${JSON.stringify({ type: "message", id: "a", timestamp: stamp(2000), message: { role: "assistant", content: [{ type: "text", text: "pi final answer" }] } })}\n`,
  );
  withText.agent_session = { agent: "pi", kind: "id", source: "herdr:pi", value: "pi-a" };
  await f.refresh();
  await f.status(withText, "done");
  await f.status(noTranscript, "done");
  expect(f.reads).toEqual([]);
  const sources = f.notices().map((n) => [n.outcome.name, n.outcome.textSource]);
  expect(sources).toContainEqual(["pi-a", "history"]);
  for (const n of f.notices()) {
    expect(n.outcome.excerpt?.text ?? "").not.toContain("SCREEN");
    expect(n.event.compactHistory?.screenTail ?? null).toBeNull();
  }
});

test("two reader-less panes finishing together each carry only their own screen", async () => {
  const [a, b] = [worker("one"), worker("two")] as [Worker, Worker];
  const f = await fixture([a, b]);
  f.screens.set(a.pane_id, reply("answer from ONE"));
  f.screens.set(b.pane_id, reply("answer from TWO"));
  await f.refresh();
  await Promise.all([f.status(a, "done"), f.status(b, "done")]);
  const byName = Object.fromEntries(
    f.notices().map((n) => [n.outcome.name, n.outcome.excerpt?.text]),
  );
  expect(byName).toEqual({ one: "answer from ONE", two: "answer from TWO" });
});

test("a reply that names another pane is dropped, not shown", async () => {
  const w = worker("alpha");
  const f = await fixture([w]);
  f.screens.set(w.pane_id, { paneId: "wA:other", text: "text of /Users/other/secret sk-abcdef" });
  await f.refresh();
  await f.status(w, "done");
  const [notice] = f.notices();
  expect(notice?.outcome.textSource).toBe("screen-unavailable");
  expect(JSON.stringify(notice?.event)).not.toContain("secret");
});

test("a done then idle change on the same turn is one notice, even if the screen changes", async () => {
  const w = worker("alpha");
  const f = await fixture([w]);
  let clock = 0;
  f.screens.set(w.pane_id, () => reply(`answer\nclock 12:0${clock++}`));
  await f.refresh();
  await f.status(w, "done");
  await f.status(w, "idle");
  expect(f.notices()).toHaveLength(1);
  expect(f.reads).toHaveLength(1);
  // A genuinely new turn notifies again, with its own text.
  f.screens.set(w.pane_id, reply("second answer"));
  await f.status(w, "working");
  await f.status(w, "done");
  const texts = f.notices().map((n) => n.outcome.excerpt?.text);
  expect(texts).toHaveLength(2);
  expect(texts[1]).toBe("second answer");
});

test.each([
  ["a failed read", new Error("agent_not_found")],
  ["an empty screen", reply("──────\n❯\n")],
])("%s: the notice is still sent, marked screen unavailable", async (_label, outcome) => {
  const w = worker("alpha");
  const f = await fixture([w]);
  f.screens.set(w.pane_id, outcome);
  await f.refresh();
  await f.status(w, "done");
  const [notice] = f.notices();
  expect(notice?.outcome).toMatchObject({ excerpt: null, textSource: "screen-unavailable" });
});

test("a read that never answers is cut at the deadline and the notice still goes", async () => {
  const w = worker("alpha");
  const f = await fixture([w]);
  f.screens.set(w.pane_id, "hang");
  await f.refresh();
  const started = performance.now();
  await f.status(w, "done");
  const elapsed = performance.now() - started;
  // Nominal 0.5 s settle wait + 1.75 s deadline. A read with no deadline never
  // returns, so any finite bound under the 5 s test timeout discriminates.
  expect(elapsed).toBeLessThan(4_500);
  expect(f.notices()[0]?.outcome.textSource).toBe("screen-unavailable");
});

test("a slow read for one pane does not hold back another pane's event", async () => {
  const slow = worker("slow");
  const quick = worker("quick", "claude");
  const f = await fixture([slow, quick]);
  f.screens.set(slow.pane_id, "hang");
  await f.refresh();
  const slowDone = f.status(slow, "done");
  const started = performance.now();
  await f.status(quick, "blocked");
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(f.notices().map((n) => n.outcome.name)).toEqual(["quick"]);
  await slowDone;
  expect(f.notices().map((n) => n.outcome.name)).toEqual(["quick", "slow"]);
});

test("a 5 MB screen with ANSI is bounded in the notice and names no shepy agent read", async () => {
  const w = worker("alpha");
  const f = await fixture([w]);
  const huge = `${"\u001b[31mnoise line\u001b[0m\n".repeat(300_000)}the very last words\n`;
  expect(huge.length).toBeGreaterThan(5_000_000);
  f.screens.set(w.pane_id, reply(huge));
  await f.refresh();
  await f.status(w, "done");
  const [notice] = f.notices();
  const text = notice?.outcome.excerpt?.text ?? "";
  expect(text.length).toBeLessThanOrEqual(1_500);
  expect(text.endsWith("the very last words")).toBe(true);
  expect(text).not.toContain("\u001b");
  expect(JSON.stringify(notice?.outcome)).not.toContain("shepy agent read");
  const lease = notice ? [notice.outcome] : [];
  expect(lease).toHaveLength(1);
});

test("both renderers say screen text, never 'assistant', and do not point at shepy agent read", async () => {
  const w = worker("alpha");
  const f = await fixture([w]);
  f.screens.set(w.pane_id, reply(`${"long screen words ".repeat(40)}final words`));
  await f.refresh();
  await f.status(w, "done");
  const outcome = f.notices()[0]?.outcome;
  if (!outcome) throw new Error("missing notice");
  const hook = formatHookContext("seat", [
    { agentEventId: outcome.eventId, id: "00000000-0000-4000-8000-000000000001", outcome },
  ] satisfies LeasedObligation[]).context;
  const hookLine = hook.split("\n").find((line) => line.includes("alpha done")) ?? "";
  expect(hookLine).toContain("cursor, wA:alpha): screen text: …");
  expect(hookLine).toContain("final words [screen text truncated]");
  expect(hookLine).not.toContain("shepy agent read");
  const pi = formatProfileObligationUpdates([
    { agentEventId: outcome.eventId, obligationId: "ob-1", outcome },
  ]);
  expect(pi).toContain("last screen text (not an assistant answer): ");
  expect(pi).not.toContain("last assistant:");
  const unavailable = { ...outcome, excerpt: null, textSource: "screen-unavailable" as const };
  expect(
    formatProfileObligationUpdates([
      { agentEventId: 1, obligationId: "ob-2", outcome: unavailable },
    ]),
  ).toContain("(screen text unavailable)");
});

test("a completion first seen by a snapshot refresh carries the screen tail too", async () => {
  const w = worker("alpha");
  const f = await fixture([w]);
  f.screens.set(w.pane_id, reply("found by the poll"));
  await f.refresh();
  w.agent_status = "idle";
  await f.refresh();
  expect(f.notices().map((n) => [n.outcome.textSource, n.outcome.excerpt?.text])).toEqual([
    ["screen", "found by the poll"],
  ]);
  expect(f.reads).toHaveLength(1);
});
