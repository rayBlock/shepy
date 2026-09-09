import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { AgentIndexService } from "@/observability/agent-index-service.js";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";

const homes: string[] = [];
afterEach(async () => {
  cleanupTempDirs();
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function transcript(id: string, text: string) {
  return `${[
    { type: "session", id, cwd: "/repo" },
    {
      type: "message",
      id: "reply",
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;
}

function claudeTranscript(id: string, text: string, cwd = "/repo") {
  return `${[
    {
      cwd,
      message: { content: [{ text: `U:${text}`, type: "text" }], role: "user" },
      sessionId: id,
      type: "user",
    },
    {
      cwd,
      message: { content: [{ text, type: "text" }], role: "assistant" },
      sessionId: id,
      type: "assistant",
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;
}

async function claudeHome(name: string, id: string) {
  const homeDir = await mkdtemp(join(tmpdir(), name));
  homes.push(homeDir);
  const projectDir = join(homeDir, ".claude", "projects", "-Users-repo");
  const subagentsDir = join(projectDir, id, "subagents");
  await mkdir(subagentsDir, { recursive: true });
  const main = join(projectDir, `${id}.jsonl`);
  await writeFile(main, claudeTranscript(id, "MAIN ONLY"));
  await writeFile(join(subagentsDir, "agent-a.jsonl"), claudeTranscript(id, "SUBAGENT A"));
  await writeFile(join(subagentsDir, "agent-b.jsonl"), claudeTranscript(id, "SUBAGENT B"));
  return { homeDir, main, subagentA: join(subagentsDir, "agent-a.jsonl") };
}

const claudeSession = (id: string) => ({
  agent: "claude",
  agentSession: { agent: "claude", kind: "id" as const, source: "herdr:claude", value: id },
  cwd: "/repo",
  foregroundCwd: null,
});

test("claude parent id resolves through the real service and reader to the main transcript", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const { homeDir, main } = await claudeHome("shepy-identity-f1-", id);
  const history = createAgentHistoryService({ homeDir });
  const resolved = await history.resolveCompactHistory(claudeSession(id));
  expect(resolved.historyRef).toMatchObject({ kind: "agent_session", path: main, value: id });
  expect(resolved.compactHistory.lastAssistantMessage?.text).toBe("MAIN ONLY");
  const read = await history.read(claudeSession(id), { limit: 5, preferredRef: null });
  expect(read.historyRef?.path).toBe(main);
  expect(read.messages.some((message) => message.text === "MAIN ONLY")).toBe(true);
  expect(read.messages.some((message) => message.text?.includes("SUBAGENT"))).toBe(false);
});

test("a validated cached hint is reused without rediscovering the source root", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const { homeDir, main } = await claudeHome("shepy-identity-f2-reuse-", id);
  // Instrumentation: a second genuine main for the same id in another
  // project directory. If the implementation rediscovers the root, this
  // decoy makes the id ambiguous and the lookup must fail closed to null.
  const otherProject = join(homeDir, ".claude", "projects", "-Users-other");
  await mkdir(otherProject, { recursive: true });
  await writeFile(join(otherProject, `${id}.jsonl`), claudeTranscript(id, "DECOY", "/other"));
  const history = createAgentHistoryService({ homeDir });
  const hint = {
    kind: "agent_session" as const,
    path: main,
    source: "claude-jsonl" as const,
    value: id,
  };
  const resolved = await history.resolveCompactHistory(claudeSession(id), { preferredRef: hint });
  expect(resolved.compactHistory.lastAssistantMessage?.text).toBe("MAIN ONLY");
  // Negative control: without the hint the same root is genuinely
  // ambiguous and must stay unresolved — proving the pass above did not
  // come from a scan that happened to pick the right file.
  const withoutHint = await history.resolveCompactHistory(claudeSession(id), {
    preferredRef: null,
  });
  expect(withoutHint.historyRef).toBeNull();
});

test("poisoned hints stamped with the requested id are rejected", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const { homeDir, main, subagentA } = await claudeHome("shepy-identity-f2-poison-", id);
  const history = createAgentHistoryService({ homeDir });
  // A subagent copy carries the parent sessionId in its header — the exact
  // shape the pre-fix binder could stamp. It must never satisfy the parent.
  const subagentHint = {
    kind: "agent_session" as const,
    path: subagentA,
    source: "claude-jsonl" as const,
    value: id,
  };
  const viaSubagent = await history.resolveCompactHistory(claudeSession(id), {
    preferredRef: subagentHint,
  });
  expect(viaSubagent.historyRef?.path).toBe(main);
  expect(viaSubagent.compactHistory.lastAssistantMessage?.text).toBe("MAIN ONLY");
  // A different session's file stamped with the requested id: header
  // identity must reject it even though value/source/kind all match.
  const foreignDir = join(homeDir, ".claude", "projects", "-Users-repo");
  const foreignPath = join(foreignDir, "99999999-8888-4777-8666-555555555555.jsonl");
  await writeFile(foreignPath, claudeTranscript("99999999-8888-4777-8666-555555555555", "FOREIGN"));
  const foreignHint = {
    kind: "agent_session" as const,
    path: foreignPath,
    source: "claude-jsonl" as const,
    value: id,
  };
  const viaForeign = await history.resolveCompactHistory(claudeSession(id), {
    preferredRef: foreignHint,
  });
  expect(viaForeign.historyRef?.path).toBe(main);
  expect(viaForeign.compactHistory.lastAssistantMessage?.text).toBe("MAIN ONLY");
});

test("an authoritative lookup rebinds the nested compact reference from a warm discovery cache", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const { homeDir, main } = await claudeHome("shepy-identity-cache-ref-", id);
  const harness = openObservabilityDbHarness();
  try {
    const history = createAgentHistoryService({ homeDir, cache: harness.agentHistoryCache });
    const seeded = await history.readCompactRef({
      kind: "discovered_file",
      path: main,
      source: "claude-jsonl",
      value: main,
    });
    const expected = { kind: "agent_session", path: main, source: "claude-jsonl", value: id };
    const resolved = await history.resolveCompactHistory(claudeSession(id));
    expect(resolved.historyRef).toEqual(expected);
    // agent.get exposes compactHistory, not the outer resolved reference.
    expect(resolved.compactHistory.historyRef).toEqual(expected);
    expect(resolved.compactHistory.lastAssistantMessage?.text).toBe("MAIN ONLY");
    expect((await history.getCompactHistory(claudeSession(id))).historyRef).toEqual(expected);
    expect(seeded.compactHistory.historyRef?.kind).toBe("discovered_file");
  } finally {
    harness.sqlite.close();
  }
});

test("same-revision refresh recovers a late Pi file and repairs a persisted wrong-session hint", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "shepy-identity-"));
  homes.push(homeDir);
  const dir = join(homeDir, ".pi", "agent", "sessions", "repo");
  await mkdir(dir, { recursive: true });
  const ownerPath = join(dir, "owner.jsonl");
  const workerPath = join(dir, "worker.jsonl");
  await writeFile(ownerPath, transcript("owner", "OWNER ONLY"));
  const harness = openObservabilityDbHarness();
  const history = createAgentHistoryService({ homeDir, cache: harness.agentHistoryCache });
  const index = new AgentIndexService({
    clientFactory: () => ({
      close() {},
      async sessionSnapshot() {
        return {
          agents: [
            {
              agent: "pi",
              agent_status: "working",
              cwd: "/repo",
              revision: 1,
              pane_id: "wA:p1",
              terminal_id: "term_worker",
              workspace_id: "wA",
              agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: workerPath },
            },
          ],
          panes: [],
          workspaces: [],
        };
      },
    }),
    history,
    stores: harness,
  });
  const refresh = () =>
    index.refreshHerdrSession({
      herdrSessionName: "default",
      sessionDir: "/tmp/herdr",
      socketPath: "/tmp/herdr.sock",
    });
  const first = await refresh();
  const worker = first.agents[0];
  if (!worker) throw new Error("Expected worker");
  expect(harness.agentContextSnapshots.get(worker.id)?.historyRef).toBeNull();

  // Pi writes its session after Herdr reports the identity, without a new
  // pane revision. The initial empty lookup must not be sticky.
  await writeFile(workerPath, transcript("worker", "WORKER ONLY"));
  await refresh();
  expect(
    harness.agentContextSnapshots.get(worker.id)?.compactHistory.lastAssistantMessage?.text,
  ).toBe("WORKER ONLY");

  // Simulate a snapshot persisted by the old startup fallback. No cache/DB
  // deletion should be needed to repair it after upgrading the daemon.
  const poisoned = await history.readCompactRef({
    kind: "discovered_file",
    path: ownerPath,
    source: "pi-jsonl",
    value: ownerPath,
  });
  harness.agentContextSnapshots.put({ agentId: worker.id, paneRevision: 1, ...poisoned });
  await refresh();
  const repaired = harness.agentContextSnapshots.get(worker.id);
  expect(repaired?.historyRef?.path).toBe(workerPath);
  expect(repaired?.compactHistory.lastAssistantMessage?.text).toBe("WORKER ONLY");
  harness.sqlite.close();
});
