import type { OperationStore } from "@/db/operations.js";
import type { HerdrOrchestrationTransport } from "@/herdr/orchestration-transport.js";
import type { DispatchTargetResolution } from "./operation-target-resolver.js";

/**
 * Task 4 — the dispatch pipeline (orchestration plan).
 *
 * Strict order of operations:
 *   1. resolve the profile to exactly one target — fail closed, no transport
 *      call, no operation row for any non-ok resolution;
 *   2. persist the durable operation BEFORE any bytes go to Herdr, so an
 *      uncertain submission is always auditable;
 *   3. submit once through the transport;
 *   4. classify the outcome — accepted, explicitly rejected, or
 *      submission_unknown. Unknown submissions are NEVER silently retried.
 */
export type DispatchOutcome =
  | { kind: "accepted"; operationId: string; requestId: string }
  | (
      | Extract<
          DispatchTargetResolution,
          { kind: "unmatched" | "ambiguous" | "unstable_target" | "target_lost" | "invalid" }
        >
      | { kind: "submission_rejected"; operationId: string; reason: string }
      | { kind: "submission_unknown"; operationId: string; reason: string }
    );

export class OperationDispatchService {
  readonly #operations: OperationStore;
  readonly #resolve: (profileId: string) => DispatchTargetResolution;
  readonly #transport: HerdrOrchestrationTransport;

  constructor(options: {
    operations: OperationStore;
    resolve: (profileId: string) => DispatchTargetResolution;
    transport: HerdrOrchestrationTransport;
  }) {
    this.#operations = options.operations;
    this.#resolve = options.resolve;
    this.#transport = options.transport;
  }

  async dispatch(input: { profileId: string; prompt: string }): Promise<DispatchOutcome> {
    const resolution = this.#resolve(input.profileId);
    if (resolution.kind !== "ok") {
      return resolution;
    }

    const operation = this.#operations.create({
      herdrSessionName: resolution.target.herdrSessionName,
      profileId: input.profileId,
      prompt: input.prompt,
      target: resolution.target,
      workspaceId: resolution.target.workspaceId,
    });

    try {
      const receipt = await this.#transport.submitPrompt(resolution.target, input.prompt, {});
      const submitted = this.#operations.recordSubmission({
        operationId: operation.id,
        requestId: receipt.requestId,
        submittedAt: new Date(),
        ...(receipt.evidence ? { evidence: receipt.evidence } : {}),
      });
      return { kind: "accepted", operationId: submitted.id, requestId: receipt.requestId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (isUncertainSubmission(reason)) {
        this.#operations.markSubmissionUnknown({ operationId: operation.id, reason });
        return { kind: "submission_unknown", operationId: operation.id, reason };
      }
      this.#operations.markSubmissionRejected({ operationId: operation.id, reason });
      return { kind: "submission_rejected", operationId: operation.id, reason };
    }
  }
}

/**
 * Only a deadline expiry AFTER the request was written can leave the peer
 * having acted on bytes we cannot confirm. Abort-before-send and explicit
 * peer rejections are certain — they are classified as rejected, not unknown.
 */
function isUncertainSubmission(reason: string): boolean {
  return reason.includes("timed out") && !reason.includes("aborted before send");
}
