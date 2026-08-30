import { describe, expect, test } from "vitest";
import {
  type HerdrOrchestrationTransport,
  type HerdrTargetIdentity,
  isCorrelatedLifecycleEvent,
  type LifecycleEvent,
} from "@/herdr/orchestration-transport.js";

const target: HerdrTargetIdentity = {
  agentSession: "hermes-session-1",
  herdrSessionName: "default",
  paneId: "w1:p2",
  terminalId: "term-2",
  workspaceId: "w1",
};

const event = (overrides: Partial<LifecycleEvent> = {}): LifecycleEvent => ({
  kind: "settled",
  operationId: "op-1",
  target,
  ...overrides,
});

describe("Herdr orchestration transport contract", () => {
  test("requires the exact target identity for lifecycle correlation", () => {
    expect(isCorrelatedLifecycleEvent(event(), "op-1", target)).toBe(true);
    expect(
      isCorrelatedLifecycleEvent(event({ target: { ...target, paneId: "w1:p3" } }), "op-1", target),
    ).toBe(false);
    expect(isCorrelatedLifecycleEvent(event(), "op-2", target)).toBe(false);
  });

  test("rejects events from another Herdr session even with the same pane id", () => {
    expect(
      isCorrelatedLifecycleEvent(
        event({ target: { ...target, herdrSessionName: "other-session" } }),
        "op-1",
        target,
      ),
    ).toBe(false);
  });

  test("does not correlate a target missing its stable session identity", () => {
    expect(
      isCorrelatedLifecycleEvent(
        event({ target: { ...target, agentSession: null } }),
        "op-1",
        target,
      ),
    ).toBe(false);
  });

  test("keeps transport capabilities explicit rather than exposing arbitrary socket calls", () => {
    const transport: HerdrOrchestrationTransport = {
      submitPrompt: async () => ({ requestId: "req-1" }),
      waitForLifecycle: async () => event(),
    };

    expect(Object.keys(transport).sort()).toEqual(["submitPrompt", "waitForLifecycle"]);
  });
});
