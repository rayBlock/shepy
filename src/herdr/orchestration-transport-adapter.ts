import type {
  HerdrOrchestrationTransport,
  HerdrTargetIdentity,
  LifecycleEvent,
  LifecycleKind,
  SubmitPromptResult,
} from "@/herdr/orchestration-transport.js";
import { HerdrRequestError, type HerdrSocketClient } from "@/herdr/socket-client.js";

/**
 * herdr itself expired the bounded wait (its `agent.wait` error response with
 * code "timeout"). Only this shape maps to a clean `wait_timeout` outcome —
 * a client-side socket timeout ("Herdr request timed out …") is a transport
 * failure and must surface as an error instead (the 10 s wait cut of
 * 2026-09-04 masqueraded as exactly this timeout).
 */
export class HerdrWaitTimeoutError extends Error {
  readonly operationId: string;

  constructor(operationId: string, cause: unknown) {
    super(`herdr wait timed out for operation ${operationId}`);
    this.name = "HerdrWaitTimeoutError";
    this.operationId = operationId;
    this.cause = cause;
  }
}

export class HerdrOrchestrationTransportAdapter implements HerdrOrchestrationTransport {
  readonly #client: Pick<HerdrSocketClient, "promptAgent" | "waitForAgent">;

  constructor(client: Pick<HerdrSocketClient, "promptAgent" | "waitForAgent">) {
    this.#client = client;
  }

  async submitPrompt(
    target: HerdrTargetIdentity,
    prompt: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SubmitPromptResult> {
    validateTarget(target);
    const receipt = await this.#client.promptAgent(
      { target: target.paneId, text: prompt },
      options,
    );
    return { requestId: receipt.requestId };
  }

  async waitForLifecycle(
    operationId: string,
    target: HerdrTargetIdentity,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<LifecycleEvent> {
    validateTarget(target);
    let receipt: { requestId: string; result: unknown };
    try {
      receipt = await this.#client.waitForAgent(
        {
          target: target.paneId,
          ...(options.timeoutMs === undefined ? {} : { timeout_ms: options.timeoutMs }),
          until: ["done", "blocked"],
        },
        options,
      );
    } catch (error) {
      if (isHerdrWaitTimeoutSignal(error)) {
        throw new HerdrWaitTimeoutError(operationId, error);
      }
      throw error;
    }
    return {
      kind: lifecycleKind(receipt.result),
      operationId,
      target,
    };
  }
}

function isHerdrWaitTimeoutSignal(error: unknown): boolean {
  return error instanceof HerdrRequestError && error.code === "timeout";
}

function validateTarget(target: HerdrTargetIdentity): void {
  if (
    target.agentSession === null ||
    target.agentSession.length === 0 ||
    target.herdrSessionName.length === 0 ||
    target.workspaceId.length === 0 ||
    target.paneId.length === 0
  ) {
    throw new Error("Herdr orchestration target requires a stable agent session identity");
  }
}

function lifecycleKind(value: unknown): LifecycleKind {
  const record = asRecord(value);
  const matched = asRecord(record?.matched);
  const raw =
    stringValue(matched?.agent_status) ??
    stringValue(matched?.status) ??
    stringValue(record?.final_status) ??
    stringValue(record?.agent_status) ??
    stringValue(record?.status);

  if (raw === "done" || raw === "idle") return "settled";
  if (raw === "blocked") return "blocked";
  if (raw === "failed") return "failed";
  throw new Error("Herdr wait response did not contain a recognized lifecycle status");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
