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
