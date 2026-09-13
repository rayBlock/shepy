import { describe, expect, test, vi } from "vitest";
import type { OperationRecord, OperationStore, OperationTarget } from "@/db/operations.js";
import type { LifecycleEvent } from "@/herdr/orchestration-transport.js";
import { OperationWaitService } from "@/observability/operation-wait-service.js";

/**
 * Task 5 gate — correlated waiting.
 *
 * The wait service consumes Herdr lifecycle results for a durable operation
 * and applies ONLY results whose target identity matches the operation's
 * stored target exactly (session, workspace, pane, terminal, agent session).
 *
 * Invariants:
 *   - a wait timeout terminates the CLIENT wait only; the operation stays
 *     unresolved and nothing is settled;
 *   - a result for another operation/target/scope never settles this one;
 *   - the first correlated terminal result wins; later results are ignored
 *     by the store's terminal immutability;
 *   - waiting on a non-submitted operation fails closed.
 */

const target: OperationTarget = {
  agentSession: "s-1",
  herdrSessionName: "default",
  paneId: "wA:p1",
  terminalId: "tA",
  workspaceId: "wA",
};

function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    createdAt: new Date(),
    errorSummary: null,
    herdrSessionName: "default",
    id: "op_1",
    lifecycle: null,
    profileId: "driffs",
    promptExcerpt: "run tests",
    promptSha256: "hash",
    settledAt: null,
    state: "submitted",
    target,
    transportRequestId: "shepy-1",
    updatedAt: new Date(),
    workspaceId: "wA",
    ...overrides,
  };
}

function fakeStore(record: OperationRecord) {
  // The record is mutable so wait-service flows (recordWaitError, then a
  // later settle) can be observed through get() like the real store.
  const current: OperationRecord = { ...record };
  return {
    get: vi.fn((id: string, scope?: { profileId?: string }) => {
      if (scope?.profileId && current.profileId !== scope.profileId) return undefined;
      return id === current.id ? { ...current } : undefined;
    }),
    recordWaitError: vi.fn((input: { errorSummary: string; operationId: string }) => {
      current.errorSummary = input.errorSummary;
      current.updatedAt = new Date();
      return { ...current };
    }),
    settle: vi.fn(
      (input: {
        lifecycle: "settled" | "blocked" | "failed" | "target_lost";
        operationId: string;
      }) => {
        current.lifecycle = input.lifecycle;
        current.state = input.lifecycle;
        current.settledAt = new Date();
        return { ...current };
      },
    ),
  } as unknown as OperationStore;
}

function lifecycleEvent(overrides: Partial<LifecycleEvent> = {}): LifecycleEvent {
  return { kind: "settled", operationId: "op_1", target, ...overrides };
}

describe("OperationWaitService", () => {
  test("a correlated settled result settles the operation", async () => {
    const record = operation();
    const store = fakeStore(record);
    const service = new OperationWaitService({ operations: store });

    const result = await service.applyLifecycle("op_1", lifecycleEvent());

    expect(result).toEqual({ kind: "settled", operationId: "op_1" });
    expect(store.settle).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "settled", operationId: "op_1" }),
    );
  });

  test("a result for another pane never settles this operation", async () => {
    const store = fakeStore(operation());
    const service = new OperationWaitService({ operations: store });

    const result = await service.applyLifecycle(
      "op_1",
      lifecycleEvent({ target: { ...target, paneId: "wA:p2" } }),
    );

    expect(result.kind).toBe("uncorrelated");
    expect(store.settle).not.toHaveBeenCalled();
  });

  test("a result for another Herdr session never settles this operation", async () => {
    const store = fakeStore(operation());
    const service = new OperationWaitService({ operations: store });

    const result = await service.applyLifecycle(
      "op_1",
      lifecycleEvent({ target: { ...target, herdrSessionName: "other" } }),
    );

    expect(result.kind).toBe("uncorrelated");
    expect(store.settle).not.toHaveBeenCalled();
  });

  test("a result for another agent session never settles this operation", async () => {
    const store = fakeStore(operation());
    const service = new OperationWaitService({ operations: store });

    const result = await service.applyLifecycle(
      "op_1",
      lifecycleEvent({ target: { ...target, agentSession: "s-other" } }),
    );

    expect(result.kind).toBe("uncorrelated");
    expect(store.settle).not.toHaveBeenCalled();
  });

  test("a blocked result is applied as blocked — blocked is not success", async () => {
    const store = fakeStore(operation());
    const service = new OperationWaitService({ operations: store });

    const result = await service.applyLifecycle("op_1", lifecycleEvent({ kind: "blocked" }));

    expect(result).toEqual({ kind: "blocked", operationId: "op_1" });
  });

  test("a result for an already-terminal operation is reported, not applied twice", async () => {
    const store = fakeStore(operation({ lifecycle: "settled", state: "settled" }));
    const service = new OperationWaitService({ operations: store });

    const result = await service.applyLifecycle("op_1", lifecycleEvent({ kind: "blocked" }));

    expect(result.kind).toBe("already_terminal");
    expect(store.settle).not.toHaveBeenCalled();
  });

  test("a wait timeout resolves the client wait but never settles the operation", async () => {
    const store = fakeStore(operation());
    const service = new OperationWaitService({ operations: store });

    const result = await service.applyTimeout({ operationId: "op_1", timeoutMs: 5000 });

    expect(result).toEqual({
      kind: "wait_timeout",
      operationId: "op_1",
      timeoutMs: 5000,
    });
    expect(store.settle).not.toHaveBeenCalled();
    const stored = store.get("op_1");
    expect(stored?.state).toBe("submitted");
  });

  test("waiting on a pending_submission operation fails closed", async () => {
    const store = fakeStore(operation({ state: "pending_submission", transportRequestId: null }));
    const service = new OperationWaitService({ operations: store });

    const result = await service.applyLifecycle("op_1", lifecycleEvent());
    expect(result.kind).toBe("not_submitted");
  });

  test("an unknown operation id is not_found", async () => {
    const store = fakeStore(operation());
    const service = new OperationWaitService({ operations: store });

    const result = await service.applyLifecycle("op_missing", lifecycleEvent());
    expect(result.kind).toBe("not_found");
  });

  test("a transport_unknown result records the error but never settles the operation", async () => {
    const detail = 'unrecognized herdr wait response (keys: agent, type; status "unknown")';
    const store = fakeStore(operation());
    const service = new OperationWaitService({ operations: store });

    const result = await service.applyLifecycle(
      "op_1",
      lifecycleEvent({ kind: "transport_unknown", detail }),
    );

    expect(result).toEqual({ kind: "transport_unknown", operationId: "op_1", detail });
    expect(store.settle).not.toHaveBeenCalled();
    expect(store.recordWaitError).toHaveBeenCalledWith({
      operationId: "op_1",
      errorSummary: detail,
    });
    const stored = store.get("op_1");
    expect(stored?.state).toBe("submitted");
    expect(stored?.lifecycle).toBeNull();
    expect(stored?.settledAt).toBeNull();
    expect(stored?.errorSummary).toBe(detail);
  });

  test("the operation is re-waitable after a transport_unknown result", async () => {
    const store = fakeStore(operation());
    const service = new OperationWaitService({ operations: store });

    await service.applyLifecycle(
      "op_1",
      lifecycleEvent({ kind: "transport_unknown", detail: "unrecognized herdr wait response" }),
    );
    const result = await service.applyLifecycle("op_1", lifecycleEvent());

    expect(result).toEqual({ kind: "settled", operationId: "op_1" });
    expect(store.settle).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "settled", operationId: "op_1" }),
    );
  });
});
