import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentHistoryService } from "@/agent-history/service.js";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { ObservabilityRpcServer } from "@/daemon/observability-server.js";
import { OperationStore } from "@/db/operations.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import type { HerdrOrchestrationTransport } from "@/herdr/orchestration-transport.js";
import { HerdrWaitTimeoutError } from "@/herdr/orchestration-transport-adapter.js";
import { HerdrRequestTimeoutError } from "@/herdr/socket-client.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
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
