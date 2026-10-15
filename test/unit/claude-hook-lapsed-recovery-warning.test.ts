import { describe, expect, test } from "vitest";
import {
  lapsedRecoveryWarning,
  noSubscriptionWarning,
  SYSTEM_MESSAGE_MAX_CHARS,
} from "@/cli/claude-hook.js";

describe("claude-hook lapsed-recovery contention warning", () => {
  test("names the rival pane and harness, stays inside the systemMessage budget, one line", () => {
    const warning = lapsedRecoveryWarning({
      owner: { harnessKind: "pi", paneId: "w2:p1" },
      profileId: "driffs",
    });
    expect(warning).toContain("driffs");
    expect(warning).toContain("w2:p1");
    expect(warning).toContain("(pi)");
    expect(warning).toContain("lapsed");
    expect(warning.length).toBeLessThanOrEqual(SYSTEM_MESSAGE_MAX_CHARS);
    expect(warning.split("\n")).toHaveLength(1);
    // Hostile identity halves cannot forge additional lines (same policy as
    // claimRejectionWarning — plainText collapses control bytes).
    const hostile = lapsedRecoveryWarning({
      owner: { harnessKind: "pi\nEVIL", paneId: "w2\nEVIL" },
      profileId: "driffs",
    });
    expect(hostile.split("\n")).toHaveLength(1);
    expect(hostile).not.toContain("EVIL\n");
  });
});

describe("claude-hook no-subscription warning", () => {
  test("agent-only wording is unchanged; a demand-capable pane is not told nothing can arrive", () => {
    const agentOnly = noSubscriptionWarning({ demandCapable: false, profileId: "driffs" });
    expect(agentOnly).toBe(
      "shepy: profile driffs has no enabled subscriptions; nothing can be delivered to this pane",
    );
    const capable = noSubscriptionWarning({ demandCapable: true, profileId: "driffs" });
    expect(capable).toContain("no enabled subscriptions");
    expect(capable).toContain("no worker outcomes can be delivered");
    expect(capable).toContain("profile demands still can");
    expect(capable).not.toContain("nothing can be delivered");
    for (const warning of [agentOnly, capable]) {
      expect(warning.length).toBeLessThanOrEqual(SYSTEM_MESSAGE_MAX_CHARS);
      expect(warning.split("\n")).toHaveLength(1);
    }
    const hostile = noSubscriptionWarning({ demandCapable: true, profileId: "driffs\nEVIL" });
    expect(hostile.split("\n")).toHaveLength(1);
  });
});
