import { describe, expect, test, vi } from "vitest";
import type { OperationRecord, OperationStore } from "@/db/operations.js";
import type { HerdrOrchestrationTransport } from "@/herdr/orchestration-transport.js";
import { OperationDispatchService } from "@/observability/operation-dispatch-service.js";
import type { DispatchTargetResolution } from "@/observability/operation-target-resolver.js";

/**
 * Task 4 gate — the dispatch service orchestrates resolve → persist → submit
 * in the safe order:
 *   1. resolve the profile to exactly one target (fail closed, no transport call)
 *   2. create the durable operation BEFORE any bytes go to Herdr
 *   3. submit through the transport adapter
 *   4. classify the outcome: accepted / rejected / submission_unknown
 * An uncertain submission is recorded and surfaced — never retried silently.
 */

const okResolution: DispatchTargetResolution = {
  kind: "ok",
  target: {
    agentSession: "s-1",
    herdrSessionName: "default",
    paneId: "wA:p1",
    terminalId: "tA",
    workspaceId: "wA",
  },
};

function fakeStore() {
  const operations: OperationRecord[] = [];
  const store = {
    create: vi.fn((input: { prompt: string; profileId: string }) => {
      const record = {
        createdAt: new Date(),
        errorSummary: null,
        herdrSessionName: "default",
        id: `op_${operations.length + 1}`,
        lifecycle: null,
        profileId: input.profileId,
        promptExcerpt: input.prompt.slice(0, 50),
        promptSha256: "hash",
        settledAt: null,
        state: "pending_submission",
        target: okResolution.kind === "ok" ? okResolution.target : undefined,
        transportRequestId: null,
        updatedAt: new Date(),
        workspaceId: "wA",
      } as unknown as OperationRecord;
      operations.push(record);
      return record;
    }),
    markSubmissionRejected: vi.fn((input: { operationId: string; reason: string }) => {
      const record = operations.find((row) => row.id === input.operationId);
      if (record) {
        record.state = "submission_rejected";
        record.errorSummary = input.reason;
      }
      return record as OperationRecord;
    }),
    markSubmissionUnknown: vi.fn((input: { operationId: string; reason: string }) => {
      const record = operations.find((row) => row.id === input.operationId);
      if (record) {
        record.state = "submission_unknown";
        record.errorSummary = input.reason;
      }
      return record as OperationRecord;
    }),
    recordSubmission: vi.fn((input: { operationId: string; requestId: string }) => {
      const record = operations.find((row) => row.id === input.operationId);
      if (record) {
        record.state = "submitted";
        record.transportRequestId = input.requestId;
      }
      return record as OperationRecord;
    }),
  };
  return { operations, store: store as unknown as OperationStore };
}

function fakeTransport(overrides: { submitPrompt?: () => Promise<{ requestId: string }> } = {}) {
  const noop = async () => ({ requestId: "shepy-1" });
  return {
    submitPrompt: overrides.submitPrompt ?? vi.fn(noop),
    waitForLifecycle: vi.fn(async () => {
      throw new Error("not used in dispatch");
    }),
  } as unknown as HerdrOrchestrationTransport;
}

describe("OperationDispatchService", () => {
  test("happy path: resolve → persist → submit → accepted receipt", async () => {
    const { store } = fakeStore();
    const transport = fakeTransport();
    const service = new OperationDispatchService({
      operations: store,
      resolve: () => okResolution,
      transport,
    });

    const result = await service.dispatch({ profileId: "driffs", prompt: "run tests" });

    expect(result).toEqual({
      kind: "accepted",
      operationId: "op_1",
      requestId: "shepy-1",
    });
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.recordSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "op_1", requestId: "shepy-1" }),
    );
    expect(transport.submitPrompt).toHaveBeenCalledWith(
      okResolution.kind === "ok" ? okResolution.target : undefined,
      "run tests",
      expect.anything(),
    );
  });

  test("the durable operation row exists BEFORE the transport call", async () => {
    const { store } = fakeStore();
    const order: string[] = [];
    (store.create as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push("create");
      return fakeStore().operations[0] ?? ({} as OperationRecord);
    });
    const transport = fakeTransport({
      submitPrompt: async () => {
        order.push("submit");
        return { requestId: "shepy-9" };
      },
    });
    const service = new OperationDispatchService({
      operations: store,
      resolve: () => okResolution,
      transport,
    });

    await service.dispatch({ profileId: "driffs", prompt: "p" });
    expect(order).toEqual(["create", "submit"]);
  });

  test.each([
    ["unmatched", { detail: "no agent" }],
    ["ambiguous", { candidates: [], detail: "two matches" }],
    ["unstable_target", { detail: "no session" }],
    ["target_lost", { detail: "not running" }],
    ["invalid", { detail: "bad selector" }],
  ] as const)("resolution failure (%s) creates no operation and never calls transport", async (kind, rest) => {
    const { store } = fakeStore();
    const transport = fakeTransport();
    const service = new OperationDispatchService({
      operations: store,
      resolve: () => ({ kind, ...rest }) as DispatchTargetResolution,
      transport,
    });

    const result = await service.dispatch({ profileId: "driffs", prompt: "p" });
    expect(result.kind).toBe(kind);
    expect(store.create).not.toHaveBeenCalled();
    expect(transport.submitPrompt).not.toHaveBeenCalled();
  });

  test("a transport timeout after send is submission_unknown, never retried", async () => {
    const { store } = fakeStore();
    const transport = fakeTransport({
      submitPrompt: vi.fn(async () => {
        throw new Error("Herdr request timed out after 10000ms: agent.prompt");
      }),
    });
    const service = new OperationDispatchService({
      operations: store,
      resolve: () => okResolution,
      transport,
    });

    const result = await service.dispatch({ profileId: "driffs", prompt: "p" });
    expect(result.kind).toBe("submission_unknown");
    expect(transport.submitPrompt).toHaveBeenCalledTimes(1);
    expect(store.markSubmissionUnknown).toHaveBeenCalledTimes(1);
  });

  test("an explicit transport rejection is submission_rejected", async () => {
    const { store } = fakeStore();
    const transport = fakeTransport({
      submitPrompt: async () => {
        throw new Error("agent_not_ready");
      },
    });
    const service = new OperationDispatchService({
      operations: store,
      resolve: () => okResolution,
      transport,
    });

    const result = await service.dispatch({ profileId: "driffs", prompt: "p" });
    expect(result.kind).toBe("submission_rejected");
    expect(store.markSubmissionRejected).toHaveBeenCalledTimes(1);
  });

  test("a rejected/aborted submission BEFORE send is not marked unknown", async () => {
    const { store } = fakeStore();
    const transport = fakeTransport({
      submitPrompt: async () => {
        throw new Error("Herdr request aborted before send: agent.prompt");
      },
    });
    const service = new OperationDispatchService({
      operations: store,
      resolve: () => okResolution,
      transport,
    });

    const result = await service.dispatch({ profileId: "driffs", prompt: "p" });
    // aborted-before-send cannot have delivered bytes — classify as rejected
    expect(result.kind).toBe("submission_rejected");
    expect(store.markSubmissionUnknown).not.toHaveBeenCalled();
  });
});
