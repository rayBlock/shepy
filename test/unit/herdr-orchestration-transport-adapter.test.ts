import { describe, expect, test, vi } from "vitest";
import type { HerdrTargetIdentity } from "@/herdr/orchestration-transport.js";
import {
  HerdrOrchestrationTransportAdapter,
  HerdrWaitTimeoutError,
} from "@/herdr/orchestration-transport-adapter.js";
import { HerdrRequestError, HerdrRequestTimeoutError } from "@/herdr/socket-client.js";

const target: HerdrTargetIdentity = {
  agentSession: "hermes-session-1",
  herdrSessionName: "default",
  paneId: "w1:p2",
  terminalId: "term-2",
  workspaceId: "w1",
};

/**
 * Verbatim Herdr 0.8.x `agent wait` response captured on a settled agent
 * (RUN-20260913-05): the status lives at result.agent.agent_status. The
 * socket client hands the adapter the stripped envelope result.
 */
const agentInfoWait = (agentStatus: string): unknown =>
  JSON.parse(
    `{"id":"cli:agent:wait","result":{"agent":{"agent":"pi","agent_session":{"agent":"pi","kind":"path","source":"herdr:pi","value":"…jsonl"},"agent_status":"${agentStatus}","cwd":"…","focused":false,"interactive_ready":true,"name":"builder-item5","pane_id":"w31:p13","revision":1,"state_change_seq":2329,"terminal_id":"term_65b5be8c884f8a6","workspace_id":"w31"},"type":"agent_info"}}`,
  ).result;

describe("HerdrOrchestrationTransportAdapter", () => {
  test("submits to the exact pane and returns Herdr's request id", async () => {
    const promptAgent = vi
      .fn()
      .mockResolvedValue({ requestId: "req-1", result: { type: "agent_prompted" } });
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent,
      waitForAgent: vi.fn(),
    });

    await expect(adapter.submitPrompt(target, "run the focused tests")).resolves.toEqual({
      requestId: "req-1",
    });
    expect(promptAgent).toHaveBeenCalledWith(
      { target: "w1:p2", text: "run the focused tests" },
      {},
    );
  });

  test("captures the native Codex prompt receipt identity and sequence at accept", async () => {
    const promptAgent = vi.fn().mockResolvedValue({
      requestId: "shepy-1",
      result: {
        type: "agent_prompted",
        agent: {
          agent: "codex",
          agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "native-1" },
          agent_status: "idle",
          pane_id: "w1:p2",
          terminal_id: "term-2",
          workspace_id: "w1",
          state_change_seq: 838,
          completion_seq: 836,
        },
      },
    });
    const adapter = new HerdrOrchestrationTransportAdapter({ promptAgent, waitForAgent: vi.fn() });
    expect(await adapter.submitPrompt(target, "review once")).toEqual({
      requestId: "shepy-1",
      evidence: {
        agent: "codex",
        agentSession: "native-1",
        terminalId: "term-2",
        stateChangeSeq: 838,
        completionSeq: 836,
      },
    });
    expect(promptAgent).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["represented idle completion", 1034, "native-1", "term-2", "idle"],
    ["old-turn done state", 836, "native-1", "term-2", "done"],
    ["later distinct turn done", 1100, "native-1", "term-2", "done"],
    ["replacement session", 1100, "native-2", "term-2", "idle"],
    ["replacement terminal", 1100, "native-1", "term-3", "idle"],
  ])("Codex %s never settles from pane state alone", async (_, completionSeq, native, terminal, status) => {
    const evidence = {
      agent: "codex",
      agentSession: "native-1",
      terminalId: "term-2",
      stateChangeSeq: 838,
      completionSeq: 836,
    };
    const waitForAgent = vi.fn().mockResolvedValue({
      requestId: "wait-1",
      result: {
        type: "agent_info",
        agent: {
          agent: "codex",
          agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: native },
          agent_status: status,
          completion_seq: completionSeq,
          state_change_seq: completionSeq,
          pane_id: "w1:p2",
          terminal_id: terminal,
          workspace_id: "w1",
        },
      },
    });
    const adapter = new HerdrOrchestrationTransportAdapter({ promptAgent: vi.fn(), waitForAgent });
    const event = await adapter.waitForLifecycle(
      "op-1",
      { ...target, agentSession: "native-1" },
      { evidence },
    );
    expect(event.kind).toBe("transport_unknown");
    expect(event.detail).toContain(
      native !== "native-1" || terminal !== "term-2" ? "identity" : "represented-turn proof",
    );
    expect(waitForAgent).toHaveBeenCalledWith(
      { target: "w1:p2", timeout_ms: 30_000, until: ["idle", "done", "blocked"] },
      { evidence },
    );
  });

  test("rejects unstable targets before calling Herdr", async () => {
    const promptAgent = vi.fn();
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent,
      waitForAgent: vi.fn(),
    });

    await expect(adapter.submitPrompt({ ...target, agentSession: null }, "prompt")).rejects.toThrow(
      "stable agent session identity",
    );
    expect(promptAgent).not.toHaveBeenCalled();
  });

  test("normalizes Herdr done and blocked wait results", async () => {
    const waitForAgent = vi
      .fn()
      .mockResolvedValueOnce({
        requestId: "wait-1",
        result: { type: "wait_matched", final_status: "done" },
      })
      .mockResolvedValueOnce({
        requestId: "wait-2",
        result: { type: "wait_matched", final_status: "blocked" },
      });
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent: vi.fn(),
      waitForAgent,
    });

    await expect(adapter.waitForLifecycle("op-1", target)).resolves.toMatchObject({
      kind: "settled",
      operationId: "op-1",
      target,
    });
    await expect(
      adapter.waitForLifecycle("op-2", target, { timeoutMs: 5000 }),
    ).resolves.toMatchObject({
      kind: "blocked",
      operationId: "op-2",
      target,
    });
    expect(waitForAgent).toHaveBeenNthCalledWith(
      2,
      { target: "w1:p2", timeout_ms: 5000, until: ["done", "blocked"] },
      { timeoutMs: 5000 },
    );
  });

  test("Pi receipt evidence preserves the original done/blocked wire filter and settlement", async () => {
    const waitForAgent = vi.fn().mockResolvedValue({
      requestId: "wait-pi",
      result: agentInfoWait("done"),
    });
    const adapter = new HerdrOrchestrationTransportAdapter({ promptAgent: vi.fn(), waitForAgent });
    const evidence = {
      agent: "pi",
      agentSession: "pi-session",
      terminalId: "term-2",
      stateChangeSeq: 40,
      completionSeq: 38,
    };
    expect(await adapter.waitForLifecycle("op-pi", target, { evidence })).toMatchObject({
      kind: "settled",
      operationId: "op-pi",
    });
    expect(waitForAgent.mock.calls[0]?.[0]).toEqual({
      target: "w1:p2",
      until: ["done", "blocked"],
    });
  });

  test("reads the live Herdr 0.8.x agent_info shape (status at result.agent.agent_status)", async () => {
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent: vi.fn(),
      waitForAgent: vi
        .fn()
        .mockResolvedValue({ requestId: "wait-1", result: agentInfoWait("done") }),
    });

    await expect(adapter.waitForLifecycle("op-1", target)).resolves.toMatchObject({
      kind: "settled",
      operationId: "op-1",
      target,
    });
  });

  test("reads blocked from the live agent_info shape", async () => {
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent: vi.fn(),
      waitForAgent: vi
        .fn()
        .mockResolvedValue({ requestId: "wait-2", result: agentInfoWait("blocked") }),
    });

    await expect(adapter.waitForLifecycle("op-2", target)).resolves.toMatchObject({
      kind: "blocked",
      operationId: "op-2",
      target,
    });
  });

  test("treats herdr's own agent_status unknown as unrecognized, never settled", async () => {
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent: vi.fn(),
      waitForAgent: vi
        .fn()
        .mockResolvedValue({ requestId: "wait-3", result: agentInfoWait("unknown") }),
    });

    await expect(adapter.waitForLifecycle("op-3", target)).resolves.toMatchObject({
      kind: "transport_unknown",
      operationId: "op-3",
      target,
    });
  });

  test("reports an unrecognized wait result as transport_unknown instead of throwing", async () => {
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent: vi.fn(),
      waitForAgent: vi
        .fn()
        .mockResolvedValue({ requestId: "wait-1", result: { type: "wait_matched" } }),
    });

    await expect(adapter.waitForLifecycle("op-1", target)).resolves.toEqual({
      kind: "transport_unknown",
      operationId: "op-1",
      target,
      detail: "unrecognized herdr wait response (keys: type)",
    });
  });

  test("the transport_unknown detail names top-level keys and never the payload", async () => {
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent: vi.fn(),
      waitForAgent: vi.fn().mockResolvedValue({
        requestId: "wait-1",
        result: { type: "wait_matched", payload: { secret: "x".repeat(400) } },
      }),
    });

    const event = await adapter.waitForLifecycle("op-1", target);
    const detail = event.detail ?? "";
    expect(event.kind).toBe("transport_unknown");
    expect(detail).toContain("type");
    expect(detail).toContain("payload");
    expect(detail).not.toContain("secret");
    expect(detail.length).toBeLessThanOrEqual(300);
  });

  test("truncates an overlong unrecognized detail to exactly 300 chars ending with an ellipsis", async () => {
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent: vi.fn(),
      waitForAgent: vi.fn().mockResolvedValue({
        requestId: "wait-1",
        result: { ["k".repeat(400)]: 1 },
      }),
    });

    const event = await adapter.waitForLifecycle("op-1", target);
    const detail = event.detail ?? "";
    expect(event.kind).toBe("transport_unknown");
    expect(detail.length).toBe(300);
    expect(detail.startsWith("unrecognized herdr wait response (keys: ")).toBe(true);
    expect(detail.endsWith("…")).toBe(true);
  });

  // Only herdr's own bounded-wait expiry (its `timeout` error response) may
  // become a wait timeout — the 10 s wait cut of 2026-09-04 relied on the
  // two shapes being indistinguishable.
  test("a silent Codex socket is bounded and reports unknown, not a fake completion", async () => {
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent: vi.fn(),
      waitForAgent: vi
        .fn()
        .mockRejectedValue(
          new HerdrRequestTimeoutError("Herdr request timed out after 35000ms: agent.wait"),
        ),
    });
    const event = await adapter.waitForLifecycle("op-1", target, {
      evidence: {
        agent: "codex",
        agentSession: "hermes-session-1",
        terminalId: "term-2",
        stateChangeSeq: 838,
        completionSeq: 836,
      },
    });
    expect(event).toMatchObject({ kind: "transport_unknown", operationId: "op-1" });
    expect(event.detail).toContain("bounded observation deadline");
  });

  test("maps herdr's bounded-wait expiry to HerdrWaitTimeoutError", async () => {
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent: vi.fn(),
      waitForAgent: vi
        .fn()
        .mockRejectedValue(new HerdrRequestError("timed out waiting for agent status", "timeout")),
    });

    const error = await adapter
      .waitForLifecycle("op-1", target, { timeoutMs: 5000 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HerdrWaitTimeoutError);
    if (!(error instanceof HerdrWaitTimeoutError)) throw new Error("unreachable");
    expect(error.operationId).toBe("op-1");
    expect(error.message).toContain("op-1");
  });

  test("propagates a socket-level request timeout as an error, never a wait timeout", async () => {
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent: vi.fn(),
      waitForAgent: vi
        .fn()
        .mockRejectedValue(
          new HerdrRequestTimeoutError("Herdr request timed out after 10000ms: agent.wait"),
        ),
    });

    const error = await adapter
      .waitForLifecycle("op-1", target, { timeoutMs: 5000 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HerdrRequestTimeoutError);
    expect(error).not.toBeInstanceOf(HerdrWaitTimeoutError);
    expect((error as Error).message).toBe("Herdr request timed out after 10000ms: agent.wait");
  });
});
