import type { OperationStore, OperationTarget } from "@/db/operations.js";
import type { LifecycleEvent } from "@/herdr/orchestration-transport.js";

/**
 * Task 5 — correlated wait outcomes (orchestration plan).
 *
 * Applies a Herdr lifecycle result to a durable operation ONLY when the
 * result's target identity matches the operation's stored target exactly.
 * A wait timeout terminates the client's wait request; it never settles,
 * acknowledges, or otherwise mutates the operation.
 */
export type WaitOutcome =
  | { kind: "settled"; operationId: string }
  | { kind: "blocked"; operationId: string }
  | { kind: "failed"; operationId: string }
  | { kind: "target_lost"; operationId: string }
  | { kind: "uncorrelated"; detail: string }
  | { kind: "already_terminal"; state: string }
  | { kind: "not_submitted" }
  | { kind: "not_found" }
  | { kind: "wait_timeout"; operationId: string; timeoutMs: number };

export class OperationWaitService {
  readonly #operations: OperationStore;

  constructor(options: { operations: OperationStore }) {
    this.#operations = options.operations;
  }

  applyLifecycle(operationId: string, event: LifecycleEvent): WaitOutcome {
    const operation = this.#operations.get(operationId);
    if (!operation) return { kind: "not_found" };
    if (operation.state === "pending_submission" || operation.state === "submission_rejected") {
      return { kind: "not_submitted" };
    }
    if (isTerminal(operation.state)) {
      return { kind: "already_terminal", state: operation.state };
    }

    if (!sameTarget(event.target, operation.target) || event.operationId !== operationId) {
      return {
        kind: "uncorrelated",
        detail: `lifecycle result for ${event.target.paneId} (${event.target.herdrSessionName}) does not match operation ${operationId} target ${operation.target.paneId} (${operation.target.herdrSessionName})`,
      };
    }

    const lifecycle = event.kind === "transport_unknown" ? ("failed" as const) : event.kind;
    this.#operations.settle({ lifecycle, operationId, settledAt: new Date() });
    return { kind: lifecycle, operationId };
  }

  /**
   * A client wait expired. This is a property of the WAIT, not the operation:
   * the durable row keeps its pre-timeout state and a later correlated
   * result can still settle it.
   */
  applyTimeout(input: { operationId: string; timeoutMs: number }): WaitOutcome {
    const operation = this.#operations.get(input.operationId);
    if (!operation) return { kind: "not_found" };
    return { kind: "wait_timeout", operationId: input.operationId, timeoutMs: input.timeoutMs };
  }
}

function sameTarget(left: OperationTarget, right: OperationTarget): boolean {
  return (
    left.agentSession === right.agentSession &&
    left.herdrSessionName === right.herdrSessionName &&
    left.paneId === right.paneId &&
    left.terminalId === right.terminalId &&
    left.workspaceId === right.workspaceId
  );
}

function isTerminal(state: string): boolean {
  return (
    state === "settled" ||
    state === "blocked" ||
    state === "failed" ||
    state === "target_lost" ||
    state === "submission_unknown"
  );
}
