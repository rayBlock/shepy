import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import { AgentStore } from "@/db/agents.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { HerdrSessionStore } from "@/db/herdr-sessions.js";
import { OperationStore } from "@/db/operations.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import type { HerdrOrchestrationTransport } from "@/herdr/orchestration-transport.js";
import { OperationDispatchService } from "@/observability/operation-dispatch-service.js";
import { resolveDispatchTarget } from "@/observability/operation-target-resolver.js";
import { ProfileService } from "@/observability/profile-service.js";

/**
 * Task 4 gate — the dispatch RPC end to end against real stores: resolver →
 * durable operation → transport. Zero-match and ambiguity must leave NO
 * operation row and never touch the transport.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function fixture(transport: HerdrOrchestrationTransport) {
  const dir = mkdtempSync(join(tmpdir(), "shepy-dispatch-rpc-"));
  tempDirs.push(dir);
  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });

  const sessions = new HerdrSessionStore(sqlite);
  const agents = new AgentStore(sqlite);
  sessions.upsertRunning({ name: "default", sessionDir: "/tmp/a", socketPath: "/tmp/a.sock" });
  agents.replaceForSession({
    agents: [
      {
        agent: "hermes",
        agent_session: { agent: "hermes", kind: "id", source: "herdr:hermes", value: "s-1" },
        agent_status: "idle",
        focused: false,
        name: "driffs-worker",
        pane_id: "wA:p1",
        terminal_id: "tA",
        workspace_id: "wA",
      },
    ],
    herdrSessionName: "default",
  });

  const profiles = new OrchestratorProfileStore(sqlite);
  profiles.createProfile({ displayName: "Driffs", profileId: "driffs", projectRoots: [] });
  profiles.addSubscription({
    agentSelectorJson: JSON.stringify({ kind: "name", value: "driffs-worker" }),
    herdrSessionName: "default",
    profileId: "driffs",
    workspaceSelectorJson: JSON.stringify({ herdrSession: "default", workspaceId: "wA" }),
  });

  const history = createAgentHistoryService({ cache: new AgentHistoryCacheStore(sqlite) });
  const profileService = new ProfileService({ agents, history, profiles });
  const operationStore = new OperationStore(sqlite);
  const dispatch = new OperationDispatchService({
    operations: operationStore,
    resolve: (profileId) => resolveDispatchTarget(profileService.resolveSubscriptions(profileId)),
    transport,
  });
  return { dispatch, operationStore, sqlite };
}

function okTransport() {
  return {
    submitPrompt: async () => ({ requestId: "shepy-42" }),
    waitForLifecycle: async () => {
      throw new Error("unused");
    },
  } as unknown as HerdrOrchestrationTransport;
}

describe("operation dispatch — integration", () => {
  test("dispatch resolves, persists, submits, and the operation is queryable", async () => {
    const { dispatch, operationStore } = fixture(okTransport());
    const outcome = await dispatch.dispatch({
      profileId: "driffs",
      prompt: "run the focused tests",
    });

    expect(outcome).toEqual({
      kind: "accepted",
      operationId: expect.stringMatching(/^op_/),
      requestId: "shepy-42",
    });
    if (outcome.kind !== "accepted") throw new Error("unreachable");

    const stored = operationStore.get(outcome.operationId);
    expect(stored?.state).toBe("submitted");
    expect(stored?.transportRequestId).toBe("shepy-42");
    expect(stored?.target.paneId).toBe("wA:p1");
    expect(operationStore.listForProfile("driffs")).toHaveLength(1);
  });

  test("an unmatched profile creates no operation row", async () => {
    let submitted = false;
    const transport = {
      submitPrompt: async () => {
        submitted = true;
        return { requestId: "never" };
      },
      waitForLifecycle: async () => {
        throw new Error("unused");
      },
    } as unknown as HerdrOrchestrationTransport;
    const { dispatch, operationStore, sqlite } = fixture(transport);

    const outcome = await dispatch.dispatch({ profileId: "ghost", prompt: "p" });
    expect(outcome.kind).toBe("unmatched");
    expect(submitted).toBe(false);
    expect(operationStore.listForProfile("driffs")).toHaveLength(0);
    const rows = sqlite.prepare("select count(*) as n from orchestration_operations").get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });

  test("a transport rejection still leaves an auditable operation row", async () => {
    const transport = {
      submitPrompt: async () => {
        throw new Error("agent_not_ready");
      },
      waitForLifecycle: async () => {
        throw new Error("unused");
      },
    } as unknown as HerdrOrchestrationTransport;
    const { dispatch, operationStore } = fixture(transport);

    const outcome = await dispatch.dispatch({ profileId: "driffs", prompt: "p" });
    expect(outcome.kind).toBe("submission_rejected");
    if (outcome.kind === "submission_rejected") {
      const stored = operationStore.get(outcome.operationId);
      expect(stored?.state).toBe("submission_rejected");
      expect(stored?.errorSummary).toBe("agent_not_ready");
    }
  });
});
