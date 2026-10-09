import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { ObservabilityRpcServer } from "@/daemon/observability-server.js";
import { OperationStore } from "@/db/operations.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import type { HerdrOrchestrationTransport } from "@/herdr/orchestration-transport.js";
import {
  HerdrOrchestrationTransportAdapter,
  HerdrWaitTimeoutError,
} from "@/herdr/orchestration-transport-adapter.js";
import { HerdrRequestError, HerdrRequestTimeoutError } from "@/herdr/socket-client.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import { OperationDispatchService } from "@/observability/operation-dispatch-service.js";
import { OperationWaitService } from "@/observability/operation-wait-service.js";
import {
  cleanupTempDirs,
  openObservabilityDbHarness,
  tempDirs,
} from "./observability-db-harness.js";
import { RpcTestClient } from "./rpc-test-client.js";

/**
 * The 10 s wait cut of 2026-09-04: `operation.wait` matched ANY error whose
 * message contained "timed out" and reported a clean wait_timeout — including
 * the socket client's own "Herdr request timed out after 10000ms" deadline.
 * These tests pin the classification at the RPC boundary: herdr's bounded-wait
 * expiry maps to wait_timeout; a socket-level deadline is an RPC error.
 */

const servers: ObservabilityRpcServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  cleanupTempDirs();
  vi.unstubAllEnvs();
});

function fixture(waitForLifecycle: HerdrOrchestrationTransport["waitForLifecycle"]) {
  const dir = mkdtempSync(join(tmpdir(), "shepy-wait-rpc-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "rpc.sock");
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const harness = openObservabilityDbHarness();
  new OrchestratorProfileStore(harness.sqlite).createProfile({
    displayName: "Driffs",
    profileId: "driffs",
    projectRoots: [],
  });
  const history = createAgentHistoryService({ cache: harness.agentHistoryCache, homeDir: dir });
  const operations = new OperationStore(harness.sqlite);
  const server = new ObservabilityRpcServer({
    context: new AgentContextService({
      history,
      stores: { agentContextSnapshots: harness.agentContextSnapshots, agents: harness.agents },
    }),
    history,
    operationStore: operations,
    operationWait: new OperationWaitService({ operations }),
    orchestrationTransport: { waitForLifecycle } as unknown as HerdrOrchestrationTransport,
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

  const operation = operations.create({
    herdrSessionName: "default",
    profileId: "driffs",
    prompt: "run tests",
    target: {
      agentSession: "s-1",
      herdrSessionName: "default",
      paneId: "wA:p1",
      terminalId: "tA",
      workspaceId: "wA",
    },
    workspaceId: "wA",
  });
  operations.recordSubmission({
    operationId: operation.id,
    requestId: "shepy-1",
    submittedAt: new Date(),
  });

  return { dir, harness, operation, operations, server, socketPath };
}

async function connected(socketPath: string): Promise<RpcTestClient> {
  return RpcTestClient.connect(socketPath);
}

/**
 * Verbatim Herdr 0.8.x `agent wait` response captured on a settled agent
 * (RUN-20260913-05): the status lives at result.agent.agent_status. The
 * socket client hands the adapter the stripped envelope result.
 */
const agentInfoWait = (agentStatus: string): unknown =>
  JSON.parse(
    `{"id":"cli:agent:wait","result":{"agent":{"agent":"pi","agent_session":{"agent":"pi","kind":"path","source":"herdr:pi","value":"…jsonl"},"agent_status":"${agentStatus}","cwd":"…","focused":false,"interactive_ready":true,"name":"builder-item5","pane_id":"w31:p13","revision":1,"state_change_seq":2329,"terminal_id":"term_65b5be8c884f8a6","workspace_id":"w31"},"type":"agent_info"}}`,
  ).result;

describe("operation.wait — Herdr 0.8.x wait shapes at the RPC boundary", () => {
  test("the captured agent_info shape settles the operation", async () => {
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent: vi.fn(),
      waitForAgent: vi
        .fn()
        .mockResolvedValue({ requestId: "wait-1", result: agentInfoWait("done") }),
    });
    const { operation, operations, server, socketPath } = fixture(
      adapter.waitForLifecycle.bind(adapter),
    );
    await server.start();
    const client = await connected(socketPath);
    try {
      await expect(
        client.request("operation.wait", { operationId: operation.id, timeoutMs: 1000 }),
      ).resolves.toEqual({ outcome: { kind: "settled", operationId: operation.id } });
      const stored = operations.get(operation.id);
      expect(stored?.state).toBe("settled");
      expect(stored?.lifecycle).toBe("settled");
    } finally {
      client.close();
    }
  });

  test("an unreadable wait shape returns transport_unknown and keeps the operation submitted", async () => {
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent: vi.fn(),
      waitForAgent: vi
        .fn()
        .mockResolvedValue({ requestId: "wait-1", result: { type: "wait_matched" } }),
    });
    const { operation, operations, server, socketPath } = fixture(
      adapter.waitForLifecycle.bind(adapter),
    );
    await server.start();
    const client = await connected(socketPath);
    try {
      const result = (await client.request("operation.wait", {
        operationId: operation.id,
        timeoutMs: 1000,
      })) as { outcome: { kind: string; detail?: string } };
      expect(result.outcome.kind).toBe("transport_unknown");
      expect(result.outcome.detail).toContain("keys: type");
      const stored = operations.get(operation.id);
      expect(stored?.state).toBe("submitted");
      expect(stored?.lifecycle).toBeNull();
      expect(stored?.settledAt).toBeNull();
      expect(stored?.errorSummary).toBe(result.outcome.detail);
    } finally {
      client.close();
    }
  });
});

describe("operation.wait — native Codex attempt safety", () => {
  test.each([
    ["old-turn", 836],
    ["late-later-turn", 1100],
  ])("one dispatch, observed working, report returned: %s cannot settle on same identity", async (_case, completionSeq) => {
    const native = "01a12097-477f-7512-afa3-507b2dbd76db";
    const terminal = "term_65d66cec9374d41";
    const agent = (status: string, seq: number) => ({
      agent: "codex",
      agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: native },
      agent_status: status,
      completion_seq: seq,
      state_change_seq: seq,
      pane_id: "w3P:p6",
      terminal_id: terminal,
      workspace_id: "w3P",
    });
    const promptAgent = vi.fn().mockResolvedValue({
      requestId: "shepy-1",
      result: {
        type: "agent_prompted",
        agent: agent("idle", 837),
      },
    });
    const waitForAgent = vi.fn().mockResolvedValue({
      requestId: "wait-1",
      result: {
        type: "agent_info",
        agent: agent("idle", completionSeq),
      },
    });
    const adapter = new HerdrOrchestrationTransportAdapter({ promptAgent, waitForAgent });
    const { dir, harness, operations, server, socketPath } = fixture(
      adapter.waitForLifecycle.bind(adapter),
    );
    // A separate isolated operation is dispatched exactly once; the fixture's
    // unrelated initial operation is not the one under test.
    vi.stubEnv("SHEPY_HOME", dir);
    const dispatch = new OperationDispatchService({
      operations,
      resolve: () => ({
        kind: "ok",
        target: {
          agentSession: native,
          herdrSessionName: "default",
          paneId: "w3P:p6",
          terminalId: terminal,
          workspaceId: "w3P",
        },
      }),
      transport: adapter,
    });
    const submitted = await dispatch.dispatch({
      profileId: "driffs",
      prompt: "review revision3 once",
    });
    expect(submitted.kind).toBe("accepted");
    if (submitted.kind !== "accepted") throw new Error("dispatch not accepted");
    expect(promptAgent).toHaveBeenCalledTimes(1);
    expect(new OperationStore(harness.sqlite).promptEvidence(submitted.operationId)).toMatchObject({
      agent: "codex",
      agentSession: native,
      terminalId: terminal,
      stateChangeSeq: 837,
    });
    // Simulated Herdr working observation and exact report/sentinel receipt.
    const working = agent("working", 839);
    expect(working.agent_status).toBe("working");
    writeFileSync(
      join(dir, "revision3-report.json"),
      JSON.stringify({ sentinel: "revision3-returned" }),
    );
    expect(JSON.parse(readFileSync(join(dir, "revision3-report.json"), "utf8"))).toEqual({
      sentinel: "revision3-returned",
    });
    await server.start();
    const client = await connected(socketPath);
    try {
      const result = (await client.request("operation.wait", {
        operationId: submitted.operationId,
        timeoutMs: 1000,
      })) as { outcome: { kind: string; detail: string } };
      expect(result.outcome.kind).toBe("transport_unknown");
      expect(result.outcome.detail).toContain("represented-turn proof");
      expect(operations.get(submitted.operationId)).toMatchObject({
        state: "submitted",
        lifecycle: null,
        settledAt: null,
      });
      expect(waitForAgent).toHaveBeenCalledTimes(1);
      expect(waitForAgent.mock.calls[0]?.[0]).toMatchObject({
        target: "w3P:p6",
        until: ["idle", "done", "blocked"],
      });
    } finally {
      client.close();
    }
  });
});

describe("operation.wait — Codex silent-peer bound", () => {
  test("bare Codex wait returns honest unknown on Herdr bounded timeout, operation remains submitted", async () => {
    const waitForAgent = vi
      .fn()
      .mockRejectedValue(new HerdrRequestError("timed out waiting for agent status", "timeout"));
    const adapter = new HerdrOrchestrationTransportAdapter({ promptAgent: vi.fn(), waitForAgent });
    const { operation, operations, server, socketPath } = fixture(
      adapter.waitForLifecycle.bind(adapter),
    );
    // A dispatch receipt is private and persisted at acceptance; this fixture
    // pins its exact Herdr Codex shape without sending another prompt.
    const codex = operations.create({
      herdrSessionName: "default",
      profileId: "driffs",
      prompt: "one review",
      target: {
        agentSession: "native-1",
        herdrSessionName: "default",
        paneId: "w3P:p6",
        terminalId: "term-1",
        workspaceId: "w3P",
      },
      workspaceId: "w3P",
    });
    operations.recordSubmission({
      operationId: codex.id,
      requestId: "shepy-1",
      submittedAt: new Date(),
      evidence: {
        agent: "codex",
        agentSession: "native-1",
        terminalId: "term-1",
        stateChangeSeq: 838,
        completionSeq: 836,
      },
    });
    await server.start();
    const client = await connected(socketPath);
    try {
      const result = (await client.request("operation.wait", { operationId: codex.id })) as {
        outcome: { kind: string; detail: string };
      };
      expect(result.outcome.kind).toBe("transport_unknown");
      expect(result.outcome.detail).toContain("bounded observation deadline");
      expect(waitForAgent).toHaveBeenCalledWith(
        { target: "w3P:p6", timeout_ms: 30_000, until: ["idle", "done", "blocked"] },
        expect.objectContaining({ evidence: expect.objectContaining({ agent: "codex" }) }),
      );
      expect(operations.get(codex.id)).toMatchObject({
        state: "submitted",
        lifecycle: null,
        settledAt: null,
      });
      expect(operations.get(operation.id)?.state).toBe("submitted");
    } finally {
      client.close();
    }
  });
});

describe("operation.wait — timeout classification at the RPC boundary", () => {
  test("herdr's bounded-wait expiry reports a clean wait_timeout", async () => {
    const { operation, server, socketPath } = fixture(async (operationId) => {
      throw new HerdrWaitTimeoutError(operationId, new Error("timed out waiting for agent status"));
    });
    await server.start();
    const client = await connected(socketPath);
    try {
      await expect(
        client.request("operation.wait", { operationId: operation.id, timeoutMs: 1000 }),
      ).resolves.toEqual({
        outcome: { kind: "wait_timeout", operationId: operation.id, timeoutMs: 1000 },
      });
    } finally {
      client.close();
    }
  });

  test("a socket-level request timeout is an RPC error, never a wait_timeout", async () => {
    const { operation, operations, server, socketPath } = fixture(async () => {
      throw new HerdrRequestTimeoutError("Herdr request timed out after 10000ms: agent.wait");
    });
    await server.start();
    const client = await connected(socketPath);
    try {
      await expect(
        client.request("operation.wait", { operationId: operation.id, timeoutMs: 1000 }),
      ).rejects.toThrow("Herdr request timed out after 10000ms: agent.wait");
      // The failure is not a bounded-wait expiry: the operation stays live.
      expect(operations.get(operation.id)?.state).toBe("submitted");
    } finally {
      client.close();
    }
  });
});
