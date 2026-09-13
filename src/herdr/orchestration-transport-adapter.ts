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
    const outcome = lifecycleOutcome(receipt.result);
    return {
      kind: outcome.kind,
      operationId,
      target,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
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

const TRANSPORT_UNKNOWN_DETAIL_MAX = 300;

function lifecycleOutcome(value: unknown): { detail?: string; kind: LifecycleKind } {
  const record = asRecord(value);
  const matched = asRecord(record?.matched);
  // Herdr 0.8.x answers `agent wait` with the live agent at result.agent
  // (agent_status there); the remaining keys are the older wait shapes.
  const raw =
    agentStatus(record?.agent) ??
    stringValue(matched?.agent_status) ??
    stringValue(matched?.status) ??
    stringValue(record?.final_status) ??
    stringValue(record?.agent_status) ??
    stringValue(record?.status);

  if (raw === "done" || raw === "idle") return { kind: "settled" };
  if (raw === "blocked") return { kind: "blocked" };
  if (raw === "failed") return { kind: "failed" };
  // Unreadable — including herdr's own agent_status "unknown" — says nothing
  // about the worker, so it is reported, never mapped to a terminal kind.
  return { detail: unrecognizedWaitDetail(value, raw), kind: "transport_unknown" };
}

function agentStatus(value: unknown): string | undefined {
  return stringValue(asRecord(value)?.agent_status);
}

function unrecognizedWaitDetail(value: unknown, raw: string | undefined): string {
  const record = asRecord(value);
  const keys = record ? Object.keys(record).join(", ") : typeof value;
  const base = `unrecognized herdr wait response (keys: ${keys}${
    raw === undefined ? "" : `; status "${raw}"`
  })`;
  return base.length <= TRANSPORT_UNKNOWN_DETAIL_MAX
    ? base
    : `${base.slice(0, TRANSPORT_UNKNOWN_DETAIL_MAX - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
