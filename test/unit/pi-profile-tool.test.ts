import { describe, expect, test } from "vitest";

const extensionModuleUrl = new URL("../../packages/shepy-pi/src/index.ts", import.meta.url).href;

type Resolve = (params: {
  action: string;
  profileId?: string | undefined;
}) =>
  | { ok: false; message: string }
  | { ok: true; action: "claim"; profileId: string }
  | { ok: true; action: "release" | "status" };

type ClaimResult =
  | { kind: "claimed"; profileId: string }
  | { kind: "reclaimed"; profileId: string }
  | {
      kind: "rejected";
      owner: { harnessKind: string; paneId: string } | undefined;
      profileId: string;
    }
  | { kind: "blocked"; profileId: string; reason: string };

type ReleaseResult = { kind: "released"; profileId: string } | { kind: "not_owned" };

type StatusResult = {
  connected: boolean;
  kind: "status";
  owned: boolean;
  pendingCount?: number | undefined;
  profileId?: string | undefined;
};

type Format = (result: ClaimResult | ReleaseResult | StatusResult) => string;

type Module = {
  formatShepyProfileToolText: Format;
  resolveShepyProfileToolAction: Resolve;
};

async function loadToolModule(): Promise<Module> {
  return (await import(extensionModuleUrl)) as Module;
}

describe("shepy_profile tool argument validation", () => {
  test("claim requires a non-empty profileId", async () => {
    const { resolveShepyProfileToolAction } = await loadToolModule();
    expect(resolveShepyProfileToolAction({ action: "claim" })).toMatchObject({ ok: false });
    expect(resolveShepyProfileToolAction({ action: "claim", profileId: "  " })).toMatchObject({
      ok: false,
    });
    const message = (
      resolveShepyProfileToolAction({ action: "claim" }) as { ok: false; message: string }
    ).message;
    expect(message).toContain("profileId");
  });

  test("claim resolves with the trimmed profileId", async () => {
    const { resolveShepyProfileToolAction } = await loadToolModule();
    expect(resolveShepyProfileToolAction({ action: "claim", profileId: " driffs " })).toEqual({
      action: "claim",
      ok: true,
      profileId: "driffs",
    });
  });

  test("release and status need no profileId; unknown actions are refused", async () => {
    const { resolveShepyProfileToolAction } = await loadToolModule();
    expect(resolveShepyProfileToolAction({ action: "release" })).toEqual({
      action: "release",
      ok: true,
    });
    expect(resolveShepyProfileToolAction({ action: "status" })).toEqual({
      action: "status",
      ok: true,
    });
    expect(resolveShepyProfileToolAction({ action: "steal", profileId: "driffs" })).toMatchObject({
      ok: false,
    });
  });
});

describe("shepy_profile tool result text", () => {
  test("a successful claim names the profile and never the lease token", async () => {
    const { formatShepyProfileToolText } = await loadToolModule();
    const text = formatShepyProfileToolText({ kind: "claimed", profileId: "driffs" });
    expect(text).toContain("driffs");
    expect(text).not.toMatch(/lease|token/i);
  });

  test("a re-claim is distinguishable from a fresh claim", async () => {
    const { formatShepyProfileToolText } = await loadToolModule();
    const fresh = formatShepyProfileToolText({ kind: "claimed", profileId: "driffs" });
    const again = formatShepyProfileToolText({ kind: "reclaimed", profileId: "driffs" });
    expect(again).toContain("driffs");
    expect(again).not.toEqual(fresh);
    expect(again).not.toMatch(/lease-|token/i);
  });

  test("a rejection names the owning pane and harness and forbids retrying", async () => {
    const { formatShepyProfileToolText } = await loadToolModule();
    const text = formatShepyProfileToolText({
      kind: "rejected",
      owner: { harnessKind: "pi", paneId: "wB:p7" },
      profileId: "driffs",
    });
    expect(text).toContain("driffs");
    expect(text).toContain("wB:p7");
    expect(text).toContain("pi");
    expect(text.toLowerCase()).toContain("do not retry");
  });

  test("a rejection without owner details still forbids retrying", async () => {
    const { formatShepyProfileToolText } = await loadToolModule();
    const text = formatShepyProfileToolText({
      kind: "rejected",
      owner: undefined,
      profileId: "driffs",
    });
    expect(text).toContain("driffs");
    expect(text.toLowerCase()).toContain("do not retry");
  });

  test("a blocked claim reports the reason and never invents ownership", async () => {
    const { formatShepyProfileToolText } = await loadToolModule();
    const text = formatShepyProfileToolText({
      kind: "blocked",
      profileId: "driffs",
      reason: "Shepy is reconnecting · try again shortly",
    });
    expect(text).toContain("driffs");
    expect(text).toContain("Shepy is reconnecting · try again shortly");
    expect(text).not.toMatch(/lease-|token/i);
  });

  test("release reports the profile or the absence of ownership", async () => {
    const { formatShepyProfileToolText } = await loadToolModule();
    expect(formatShepyProfileToolText({ kind: "released", profileId: "driffs" })).toContain(
      "driffs",
    );
    expect(formatShepyProfileToolText({ kind: "not_owned" })).toBeTruthy();
  });

  test("status reports profile mode, pending count, and connection from local state", async () => {
    const { formatShepyProfileToolText } = await loadToolModule();
    const owned = formatShepyProfileToolText({
      connected: true,
      kind: "status",
      owned: true,
      pendingCount: 2,
      profileId: "driffs",
    });
    expect(owned).toContain("driffs");
    expect(owned).toContain("2");
    expect(owned).not.toMatch(/lease-|token/i);

    const unowned = formatShepyProfileToolText({ connected: false, kind: "status", owned: false });
    expect(unowned).toBeTruthy();
    expect(unowned).not.toContain("driffs");
  });
});
