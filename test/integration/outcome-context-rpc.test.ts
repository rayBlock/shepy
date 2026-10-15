import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { projectPiContextHealth } from "@/agent-history/context-health.js";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { formatHookContext, type LeasedObligation } from "@/cli/claude-hook.js";
import { ObservabilityRpcServer } from "@/daemon/observability-server.js";
import { AgentContextSnapshotStore } from "@/db/agent-context-snapshots.js";
import { AgentEventStore } from "@/db/agent-events.js";
import { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import { AgentOrchestratorScopeStore } from "@/db/agent-orchestrator-scopes.js";
import { AgentStore } from "@/db/agents.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { DeliveryObligationStore } from "@/db/delivery-obligations.js";
import { HerdrSessionStore } from "@/db/herdr-sessions.js";
import { HerdrWorkspaceStore } from "@/db/herdr-workspaces.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { ProfileOwnerStore } from "@/db/profile-owners.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import type { CompactAgentHistory } from "@/observability/contracts.js";
import { ProfileDeliveryService } from "@/observability/profile-delivery-service.js";
import { formatProfileObligationUpdates } from "../../packages/shepy-pi/src/wake.js";
import { RpcTestClient } from "./rpc-test-client.js";

// Row 15.309 correction F1/F4, adapted from the independent reviewer's
// store-to-lease journey (review-S1-01): a real SQLite event, profile claim
// and inbox.lease over the JSON Lines RPC socket, then both real renderers.
// All data is synthetic; live pane identity resolution is refused.

const AT = "2026-10-15T09:00:00.000Z";
const PATH = "/fixture/private-worker/session.jsonl";

function piHistory(): CompactAgentHistory {
  const health = projectPiContextHealth(PATH, [
    { line: 1, value: { type: "session", id: "native-uuid-not-a-path", version: 3 } },
    {
      line: 2,
      value: {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-10-15T08:58:00.000Z",
        message: {
          role: "assistant",
          model: "review-model",
          usage: { input: 50, cacheRead: 100, cacheWrite: 0, output: 999999 },
        },
      },
    },
    {
      line: 3,
      value: {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-10-15T08:59:00.000Z",
        message: {
          role: "assistant",
          model: "review-model",
          usage: { input: 100, cacheRead: 200, cacheWrite: 0, output: 999999 },
        },
      },
    },
  ]);
  return {
    contextHealth: health,
    historyRef: { kind: "agent_session", path: PATH, source: "pi-jsonl", value: PATH },
    lastAssistantMessage: { ref: `${PATH}#entry=m2`, text: "synthetic completion", timestamp: AT },
    lastToolResult: null,
    lastUserMessage: null,
    messageCount: 2,
    source: "pi-jsonl",
    updatedAt: AT,
  };
}

const LINE =
  "context: 300 prompt tokens (window unknown) · reported 2026-10-15T08:59:00.000Z (60s before event) · as of event 2026-10-15T09:00:00.000Z · model review-model · pi-jsonl";

async function leaseOverRpc(workerKind: string, reportedAt?: string) {
  const dir = mkdtempSync(join(tmpdir(), "shepy-309-rpc-"));
  const { sqlite } = openSqlite(join(dir, "db.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const sessions = new HerdrSessionStore(sqlite);
  sessions.upsertRunning({
    name: "fixture",
    sessionDir: dir,
    socketPath: join(dir, "not-a-live-herdr.sock"),
  });
  const agents = new AgentStore(sqlite);
  agents.replaceForSession({
    herdrSessionName: "fixture",
    agents: [
      {
        agent: workerKind,
        name: "review-worker",
        pane_id: "wV:p1",
        terminal_id: "fixture-worker-terminal",
        workspace_id: "wV",
        agent_status: "done",
        focused: false,
      },
    ],
  });
  const profiles = new OrchestratorProfileStore(sqlite);
  profiles.createProfile({ profileId: "review", displayName: "review", projectRoots: [] });
  profiles.addSubscription({
    profileId: "review",
    herdrSessionName: "fixture",
    agentSelectorJson: JSON.stringify({ kind: "name", value: "review-worker" }),
    workspaceSelectorJson: JSON.stringify({ herdrSession: "fixture", workspaceId: "wV" }),
  });
  const owners = new ProfileOwnerStore({ sqlite, now: () => Date.parse(AT) });
  const obligations = new DeliveryObligationStore(sqlite);
  const events = new AgentEventStore(sqlite);
  const delivery = new ProfileDeliveryService({
    agents,
    profiles,
    owners,
    obligations,
    agentEvents: events,
    now: () => Date.parse(AT),
  });
  const agentId = agents.list()[0]?.id;
  if (!agentId) throw new Error("fixture: worker missing");
  const stored = events.append({
    agentId,
    herdrSessionName: "fixture",
    paneId: "wV:p1",
    terminalId: "fixture-worker-terminal",
    workspaceId: "wV",
    type: "agent.done",
    payload: { agent: workerKind, from: "working", to: "done", name: "review-worker" },
    compactHistory: (() => {
      const history = piHistory();
      if (reportedAt !== undefined && history.contextHealth) {
        history.contextHealth = {
          ...history.contextHealth,
          usage: { ...history.contextHealth.usage, reportedAt },
        };
      }
      return history;
    })(),
  });
  // Deterministic event clock on the real row (no timer mocking).
  sqlite
    .prepare("update agent_events set created_at = ? where id = ?")
    .run(Date.parse(AT), stored.id);
  const event = events.get(stored.id);
  if (!event) throw new Error("fixture: event missing");
  delivery.projectAgentEvent(event);
  const reader = createAgentHistoryService({
    cache: new AgentHistoryCacheStore(sqlite),
    homeDir: dir,
  });
  const context = new AgentContextService({
    history: reader,
    stores: { agents, agentContextSnapshots: new AgentContextSnapshotStore(sqlite) },
  });
  const orchestrator = new AgentOrchestratorService({
    agentEvents: events,
    agents,
    scopes: new AgentOrchestratorScopeStore(sqlite),
  });
  const server = new ObservabilityRpcServer({
    context,
    delivery,
    history: reader,
    now: () => Date.parse(AT),
    orchestrator,
    resolvePaneIdentity: async () => {
      throw new Error("forbidden live identity resolution");
    },
    socketPath: join(dir, "rpc.sock"),
    stores: {
      agentEvents: events,
      agents,
      herdrSessions: sessions,
      herdrWorkspaces: new HerdrWorkspaceStore(sqlite),
    },
  });
  await server.start();
  const client = await RpcTestClient.connect(join(dir, "rpc.sock"));
  try {
    const claim = (await client.request("profile.claim", {
      harnessKind: "pi",
      harnessSessionRefJson: "{}",
      profileId: "review",
      subscriberId: "synthetic-review-owner",
    })) as { result: { kind: string; leaseToken: string } };
    expect(claim.result.kind).toBe("claimed");
    const lease = (await client.request("inbox.lease", {
      leaseToken: claim.result.leaseToken,
      profileId: "review",
    })) as ReturnType<ProfileDeliveryService["inboxLease"]>;
    expect(lease.obligations).toHaveLength(1);
    const wire = (await client.request("agent.events", { workspaceId: "wV" })) as {
      events: { id: number; outcomeContext?: unknown }[];
    };
    const leased = lease.obligations[0];
    // The lease union also covers demand obligations; this one is an agent event.
    if (!leased || "sourceKind" in leased || typeof leased.agentEventId !== "number") {
      throw new Error("fixture: expected one agent-event obligation");
    }
    const obligation = { ...leased, agentEventId: leased.agentEventId } as LeasedObligation;
    return {
      leasedOutcome: leased.outcome,
      obligation,
      wire: wire.events.find((candidate) => candidate.id === stored.id)?.outcomeContext,
    };
  } finally {
    client.close();
    await server.stop();
    sqlite.close();
  }
}

describe("row 15.309 correction: real store -> inbox.lease / agent.events RPC -> renderers", () => {
  test("healthy Pi worker: exact per-call line in both renderers; served DTOs carry no path", async () => {
    const { leasedOutcome, obligation, wire } = await leaseOverRpc("pi");
    expect(formatHookContext("review", [obligation]).context).toContain(LINE);
    expect(
      formatProfileObligationUpdates([
        {
          agentEventId: obligation.agentEventId,
          obligationId: obligation.id,
          outcome: leasedOutcome,
        },
      ]),
    ).toContain(LINE);
    for (const served of [obligation.outcome?.context, wire]) {
      expect(served).toMatchObject({ state: "current", tokens: 300, windowStatus: "unknown" });
      expect(served).not.toHaveProperty("ref");
      expect(JSON.stringify(served)).not.toContain(PATH);
    }
  });

  test("reviewer case: a Claude worker event carrying Pi health is refused on the lease and the event wire", async () => {
    const { obligation, wire } = await leaseOverRpc("claude");
    for (const served of [obligation.outcome?.context, wire]) {
      expect(served).toMatchObject({
        state: "unavailable",
        reason: "source_mismatch",
        tokens: null,
      });
      expect(JSON.stringify(served)).not.toContain(PATH);
    }
    expect(formatHookContext("review", [obligation]).context).toContain(
      "context: unavailable — source_mismatch",
    );
  });

  test("calendar: an impossible reading date reaches the lease and event wire as unknown, never printed", async () => {
    const { leasedOutcome, obligation, wire } = await leaseOverRpc(
      "pi",
      "2026-02-30T08:20:00.000Z",
    );
    for (const served of [obligation.outcome?.context, wire]) {
      expect(served).toMatchObject({
        state: "stale",
        reason: "reading_time_unknown",
        reportedAt: null,
        ageSeconds: null,
      });
      expect(JSON.stringify(served)).not.toContain("2026-02-30");
    }
    const hook = formatHookContext("review", [obligation]).context;
    const pi = formatProfileObligationUpdates([
      {
        agentEventId: obligation.agentEventId,
        obligationId: obligation.id,
        outcome: leasedOutcome,
      },
    ]);
    for (const text of [hook, pi]) {
      expect(text).toContain("context: stale — reading_time_unknown; last 300 prompt tokens");
      expect(text).toContain("reported time unknown");
      expect(text).not.toContain("2026-02-30");
    }
  });
});
