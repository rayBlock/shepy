import { describe, expect, test } from "vitest";
import type { ProfileSubscriptionRecord } from "@/db/orchestrator-profiles.js";
import type { AgentIndexRecord } from "@/observability/contracts.js";
import { resolveDispatchTarget } from "@/observability/operation-target-resolver.js";
import type { SubscriptionResolution } from "@/observability/profile-service.js";

/**
 * Task 3 gate — fail-closed profile target resolution for dispatch.
 *
 * A dispatch must resolve the profile to EXACTLY ONE dispatchable target:
 *   - zero matches        → named diagnostic, no target, no dispatch
 *   - multiple matches    → ambiguity diagnostic, no first-match fallback
 *   - stale target        → explicit target_lost-style rejection
 *   - missing agentSession → rejected (the transport contract requires a
 *                            stable session identity for correlation)
 * There is never a focused-pane or "any agent" fallback.
 */

const subscription = {
  agentSelectorJson: '{"kind":"name","value":"driffs-worker"}',
  createdAt: new Date(0),
  enabled: true,
  herdrSessionName: "default",
  id: 1,
  profileId: "driffs",
  updatedAt: new Date(0),
  workspaceSelectorJson: '{"herdrSession":"default","workspaceId":"wA"}',
} as unknown as ProfileSubscriptionRecord;

function agent(overrides: Partial<AgentIndexRecord> = {}): AgentIndexRecord {
  return {
    agent: "hermes",
    agentSession: { agent: "hermes", kind: "id", source: "herdr:hermes", value: "session-1" },
    agentStatus: "idle",
    cwd: "/Users/ray/dev/driffs",
    firstSeenAt: new Date(0),
    focused: false,
    foregroundCwd: "/Users/ray/dev/driffs",
    herdrSessionName: "default",
    id: "ag_1",
    lastSeenAt: new Date(0),
    name: "driffs-worker",
    paneId: "wA:p1",
    paneRevision: 1,
    tabId: "wA:t1",
    terminalId: "tA",
    workspaceId: "wA",
    ...overrides,
  };
}

function matched(overrides: Partial<AgentIndexRecord> = {}): SubscriptionResolution {
  return { agent: agent(overrides), kind: "matched", subscription };
}

describe("resolveDispatchTarget", () => {
  test("exactly one matched subscription with a stable session resolves", () => {
    const result = resolveDispatchTarget([matched()]);
    expect(result).toEqual({
      kind: "ok",
      target: {
        agentSession: "session-1",
        herdrSessionName: "default",
        paneId: "wA:p1",
        terminalId: "tA",
        workspaceId: "wA",
      },
    });
  });

  test("zero resolutions fail closed with a named diagnostic", () => {
    const result = resolveDispatchTarget([]);
    expect(result.kind).toBe("unmatched");
    if (result.kind === "unmatched") {
      expect(result.detail).toContain("no enabled subscription");
    }
  });

  test("an unmatched subscription reports why and never guesses", () => {
    const result = resolveDispatchTarget([
      { detail: "agent name 'driffs-worker' not found", kind: "unmatched", subscription },
    ]);
    expect(result.kind).toBe("unmatched");
    if (result.kind === "unmatched") {
      expect(result.detail).toContain("driffs-worker");
    }
  });

  test("an ambiguous subscription fails closed with candidates", () => {
    const result = resolveDispatchTarget([
      {
        candidates: [
          { id: "ag_1", name: "driffs-worker", paneId: "wA:p1" },
          { id: "ag_2", name: "driffs-worker", paneId: "wA:p2" },
        ],
        detail: "two agents share name 'driffs-worker'",
        kind: "ambiguous",
        subscription,
      },
    ]);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
    }
  });

  test("multiple matched subscriptions are themselves ambiguous — no first match", () => {
    const result = resolveDispatchTarget([
      matched(),
      matched({ id: "ag_2", paneId: "wA:p2", terminalId: "tB" }),
    ]);
    expect(result.kind).toBe("ambiguous");
  });

  test("a matched agent without a stable session identity is rejected", () => {
    const result = resolveDispatchTarget([matched({ agentSession: null })]);
    expect(result.kind).toBe("unstable_target");
  });

  test("a matched agent that is not running is reported as lost", () => {
    const result = resolveDispatchTarget([matched({ agentStatus: "unknown" })]);
    expect(result.kind).toBe("target_lost");
  });

  test("invalid subscription selectors fail closed", () => {
    const result = resolveDispatchTarget([
      { detail: "selector json invalid", kind: "invalid", subscription },
    ]);
    expect(result.kind).toBe("invalid");
  });
});
