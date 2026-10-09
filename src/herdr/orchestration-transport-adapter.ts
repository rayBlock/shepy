import type {
  HerdrOrchestrationTransport,
  HerdrTargetIdentity,
  LifecycleEvent,
  LifecycleKind,
  PromptEvidence,
  SubmitPromptResult,
} from "@/herdr/orchestration-transport.js";
import {
  HerdrRequestError,
  HerdrRequestTimeoutError,
  type HerdrSocketClient,
} from "@/herdr/socket-client.js";

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
    const agent = asRecord(asRecord(receipt.result)?.agent);
    const session = asRecord(agent?.agent_session);
    return {
      requestId: receipt.requestId,
      ...(typeof agent?.agent === "string"
        ? {
            evidence: {
              agent: agent.agent,
              agentSession: stringValue(session?.value) ?? null,
              terminalId: stringValue(agent.terminal_id) ?? null,
              stateChangeSeq: sequence(agent.state_change_seq),
              completionSeq: sequence(agent.completion_seq),
            },
          }
        : {}),
    };
  }

  async waitForLifecycle(
    operationId: string,
    target: HerdrTargetIdentity,
    options: { evidence?: PromptEvidence; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<LifecycleEvent> {
    validateTarget(target);
    let receipt: { requestId: string; result: unknown };
    // A Codex turn has no Herdr turn token. Even a silent peer must not leave
    // an unbounded operation.wait when the result could never prove settlement.
    const codexUnbounded = options.evidence?.agent === "codex" && options.timeoutMs === undefined;
    const timeoutMs = codexUnbounded ? 30_000 : options.timeoutMs;
    try {
      receipt = await this.#client.waitForAgent(
        {
          target: target.paneId,
          ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
          // Pi's wire contract is unchanged. Codex can finish idle when its
          // tab was seen; only a dispatch carrying native receipt evidence
          // enables this broader observation (not automatic settlement).
          until:
            options.evidence?.agent === "codex" ? ["idle", "done", "blocked"] : ["done", "blocked"],
        },
        options,
      );
    } catch (error) {
      if (
        isHerdrWaitTimeoutSignal(error) ||
        (codexUnbounded && error instanceof HerdrRequestTimeoutError)
      ) {
        if (codexUnbounded)
          return {
            kind: "transport_unknown",
            operationId,
            target,
            detail:
              "codex wait reached its bounded observation deadline; represented turn unproven",
          };
        throw new HerdrWaitTimeoutError(operationId, error);
      }
      throw error;
    }
    const outcome = lifecycleOutcome(receipt.result);
    if (
      (options.evidence?.agent === "codex" ||
        asRecord(asRecord(receipt.result)?.agent)?.agent === "codex") &&
      outcome.kind !== "transport_unknown"
    ) {
      const live = asRecord(asRecord(receipt.result)?.agent);
      const session = asRecord(live?.agent_session);
      const expected = options.evidence;
      // Herdr wait reports a pane's *current* state, not the prompted turn.
      // Even a newer completion sequence may belong to another queued prompt.
      // Identity mismatch or absence cannot be turned into requested identity.
      const sameIdentity =
        live?.agent === "codex" &&
        expected !== undefined &&
        stringValue(session?.value) === expected.agentSession &&
        expected.agentSession === target.agentSession &&
        stringValue(live?.terminal_id) === expected.terminalId &&
        expected.terminalId === target.terminalId &&
        stringValue(live?.pane_id) === target.paneId &&
        stringValue(live?.workspace_id) === target.workspaceId;
      return {
        kind: "transport_unknown",
        operationId,
        target,
        detail: sameIdentity
          ? "codex wait observed the target, but Herdr supplies no represented-turn proof"
          : "codex wait identity unavailable or differs from dispatch receipt",
      };
    }
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

function sequence(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
