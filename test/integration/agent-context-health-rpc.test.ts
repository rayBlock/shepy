import { appendFileSync, existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { ObservabilityRpcClient } from "@/daemon/client.js";
import { ObservabilityRpcServer } from "@/daemon/observability-server.js";
import { DeliveryObligationStore } from "@/db/delivery-obligations.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { ProfileOwnerStore } from "@/db/profile-owners.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import { ProfileDeliveryService } from "@/observability/profile-delivery-service.js";
import {
  cleanupTempDirs,
  openObservabilityDbHarness,
  tempDirs,
} from "./observability-db-harness.js";

const servers: ObservabilityRpcServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  cleanupTempDirs();
});

// Synthetic Pi session: no real transcript text, values mirror the shapes
// ops verified on real files.
function piLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function assistantLine(
  id: string,
  parentId: string,
  timestamp: string,
  usage: {
    cacheRead: number;
    cacheWrite: number;
    input: number;
    totalTokens: number;
  },
): string {
  return piLine({
    id,
    message: {
      content: [{ text: `synthetic reply ${id}`, type: "text" }],
      model: "gpt-6-astra",
      provider: "openai-codex",
      role: "assistant",
      usage: {
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        input: usage.input,
        output: 7,
        totalTokens: usage.totalTokens,
      },
    },
    parentId,
    timestamp,
    type: "message",
  });
}

const INITIAL_PI = [
  piLine({
    cwd: "/repo",
    id: "pi-session-1",
    timestamp: "2026-09-13T10:00:00.000Z",
    type: "session",
    version: 3,
  }),
  piLine({
    id: "mc1",
    modelId: "gpt-6-astra",
    parentId: null,
    provider: "openai-codex",
    timestamp: "2026-09-13T10:00:01.000Z",
    type: "model_change",
  }),
  assistantLine("m1", "mc1", "2026-09-13T10:01:00.000Z", {
    cacheRead: 100,
    cacheWrite: 10,
    input: 1000,
    totalTokens: 1160,
  }),
  assistantLine("m2", "m1", "2026-09-13T10:02:00.000Z", {
    cacheRead: 200,
    cacheWrite: 20,
    input: 2000,
    totalTokens: 2280,
  }),
  assistantLine("m3", "m2", "2026-09-13T10:03:00.000Z", {
    cacheRead: 400,
    cacheWrite: 40,
    input: 4000,
    totalTokens: 4510,
  }),
].join("");

describe("agent context health over RPC", () => {
  test("agent.get serves contextHealth, agent.list does not, and a compaction-only append flips it without a wake", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shepy-ctx-health-rpc-"));
    tempDirs.push(dir);
    const socketPath = join(dir, "rpc.sock");
    if (existsSync(socketPath)) unlinkSync(socketPath);
    const piPath = join(dir, "pi-session.jsonl");
    writeFileSync(piPath, INITIAL_PI);

    const harness = openObservabilityDbHarness();
    harness.herdrSessions.upsertRunning({
      name: "default",
      sessionDir: "/tmp/herdr",
      socketPath: "/tmp/herdr.sock",
    });
    const [agent] = harness.agents.replaceForSession({
      agents: [
        {
          agent: "pi",
          agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: piPath },
          agent_status: "working",
          pane_id: "wB:p1",
          terminal_id: "term_1",
          workspace_id: "wB",
        },
      ],
      herdrSessionName: "default",
    });
    if (!agent) throw new Error("Expected seeded agent");

    // A profile subscribed to exactly this agent + workspace.
    const profiles = new OrchestratorProfileStore(harness.sqlite);
    profiles.createProfile({ displayName: "Ctx", profileId: "ctx-owner", projectRoots: [] });
    profiles.addSubscription({
      agentSelectorJson: JSON.stringify({ kind: "name", value: "pi" }),
      herdrSessionName: "default",
      profileId: "ctx-owner",
      workspaceSelectorJson: JSON.stringify({ herdrSession: "default", workspaceId: "wB" }),
    });
    const obligations = new DeliveryObligationStore(harness.sqlite);
    const owners = new ProfileOwnerStore({ sqlite: harness.sqlite });
    const delivery = new ProfileDeliveryService({
      agentEvents: harness.agentEvents,
      agents: harness.agents,
      obligations,
      owners,
      profiles,
    });

    const history = createAgentHistoryService({
      cache: harness.agentHistoryCache,
      homeDir: dir,
    });
    const context = new AgentContextService({
      history,
      stores: { agentContextSnapshots: harness.agentContextSnapshots, agents: harness.agents },
    });
    const server = new ObservabilityRpcServer({
      context,
      delivery,
      history,
      orchestrator: new AgentOrchestratorService({
        agentEvents: harness.agentEvents,
        agents: harness.agents,
        scopes: harness.agentOrchestratorScopes,
      }),
      socketPath,
      stores: {
        agentEvents: harness.agentEvents,
        agents: harness.agents,
        herdrSessions: harness.herdrSessions,
        herdrWorkspaces: harness.herdrWorkspaces,
      },
    });
    servers.push(server);
    await server.start();
    const client = new ObservabilityRpcClient({ socketPath });

    const obligationsBefore = obligations.list({ limit: 50, profileId: "ctx-owner" });
    expect(obligationsBefore).toEqual([]);

    // Initial refresh: the projection carries the R1(a) numbers.
    const first = await context.refreshAgent({ agent, identityChanged: false });
    expect(first.changed).toBe(true);
    expect(first.snapshot.compactHistory.contextHealth).toMatchObject({
      compactionCount: 0,
      sessionId: "pi-session-1",
      usage: {
        current: true,
        kind: "last_reported",
        reportedAt: "2026-09-13T10:03:00.000Z",
        tokens: 4440,
      },
    });

    const get = (await client.request("agent.get", { target: "pi", workspaceId: "wB" })) as {
      agent: { history: { contextHealth: { usage: { tokens: number | null } } | null } };
    };
    expect(get.agent.history.contextHealth?.usage.tokens).toBe(4440);

    const list = (await client.request("agent.list", { workspaceId: "wB" })) as {
      agents: Array<{ history: Record<string, unknown> }>;
    };
    expect(list.agents).toHaveLength(1);
    expect(Object.keys(list.agents[0]?.history ?? {})).not.toContain("contextHealth");

    // Append a compaction-only line: no new assistant message, no status
    // change, no event — but the snapshot's compactHistory now differs.
    appendFileSync(
      piPath,
      piLine({
        firstKeptEntryId: "m2",
        fromHook: false,
        id: "c1",
        parentId: "m3",
        timestamp: "2026-09-13T10:04:00.000Z",
        tokensBefore: 311646,
        type: "compaction",
        usage: { input: 4242 },
      }),
    );
    const second = await context.refreshAgent({ agent, identityChanged: false });
    expect(second.changed).toBe(true);
    expect(second.snapshot.compactHistory.contextHealth).toMatchObject({
      compactionCount: 1,
      usage: { kind: "unavailable", reason: "post_compaction_no_turn", tokens: null },
    });
    expect(second.snapshot.compactHistory.contextHealth?.lastCompaction).toMatchObject({
      tokensAfter: null,
      tokensBefore: 311646,
      trigger: "unknown",
    });

    const getAfter = (await client.request("agent.get", { target: "pi", workspaceId: "wB" })) as {
      agent: { history: { contextHealth: { usage: { reason: string | null } } | null } };
    };
    expect(getAfter.agent.history.contextHealth?.usage.reason).toBe("post_compaction_no_turn");

    // D7: the snapshot changed, but NO delivery obligation was minted for
    // the subscribed profile — a compaction line alone never wakes an owner.
    const obligationsAfter = obligations.list({ limit: 50, profileId: "ctx-owner" });
    expect(obligationsAfter).toEqual([]);

    client.close();
  });
});
