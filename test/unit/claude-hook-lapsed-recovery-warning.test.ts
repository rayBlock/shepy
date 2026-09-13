import { describe, expect, test } from "vitest";
import { lapsedRecoveryWarning, SYSTEM_MESSAGE_MAX_CHARS } from "@/cli/claude-hook.js";

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
