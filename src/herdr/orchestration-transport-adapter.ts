import type {
  HerdrOrchestrationTransport,
  HerdrTargetIdentity,
  LifecycleEvent,
  LifecycleKind,
  SubmitPromptResult,
} from "@/herdr/orchestration-transport.js";
import type { HerdrSocketClient } from "@/herdr/socket-client.js";

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
    const receipt = await this.#client.waitForAgent(
      {
        target: target.paneId,
        ...(options.timeoutMs === undefined ? {} : { timeout_ms: options.timeoutMs }),
        until: ["done", "blocked"],
      },
      options,
    );
    return {
      kind: lifecycleKind(receipt.result),
      operationId,
      target,
    };
  }
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
