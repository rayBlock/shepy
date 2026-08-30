export type HerdrTargetIdentity = {
  agentSession: string | null;
  herdrSessionName: string;
  paneId: string;
  terminalId: string | null;
  workspaceId: string;
};

export type LifecycleKind = "blocked" | "failed" | "settled" | "target_lost" | "transport_unknown";

export type LifecycleEvent = {
  kind: LifecycleKind;
  operationId: string;
  target: HerdrTargetIdentity;
};

export type SubmitPromptResult = {
  requestId: string;
};

export type HerdrOrchestrationTransport = {
  submitPrompt(
    target: HerdrTargetIdentity,
    prompt: string,
    options?: { signal?: AbortSignal },
  ): Promise<SubmitPromptResult>;
  waitForLifecycle(
    operationId: string,
    target: HerdrTargetIdentity,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<LifecycleEvent>;
};

export function isCorrelatedLifecycleEvent(
  event: LifecycleEvent,
  operationId: string,
  target: HerdrTargetIdentity,
): boolean {
  return (
    event.operationId === operationId &&
    sameTarget(event.target, target) &&
    event.target.agentSession !== null
  );
}

function sameTarget(left: HerdrTargetIdentity, right: HerdrTargetIdentity): boolean {
  return (
    left.agentSession === right.agentSession &&
    left.herdrSessionName === right.herdrSessionName &&
    left.paneId === right.paneId &&
    left.terminalId === right.terminalId &&
    left.workspaceId === right.workspaceId
  );
}
