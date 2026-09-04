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

  test("rejects an unrecognized wait result instead of inventing success", async () => {
    const adapter = new HerdrOrchestrationTransportAdapter({
      promptAgent: vi.fn(),
      waitForAgent: vi
        .fn()
        .mockResolvedValue({ requestId: "wait-1", result: { type: "wait_matched" } }),
    });

    await expect(adapter.waitForLifecycle("op-1", target)).rejects.toThrow(
      "recognized lifecycle status",
    );
  });

  // Only herdr's own bounded-wait expiry (its `timeout` error response) may
  // become a wait timeout — the 10 s wait cut of 2026-09-04 relied on the
  // two shapes being indistinguishable.
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
