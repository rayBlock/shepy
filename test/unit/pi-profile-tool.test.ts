import { describe, expect, test, vi } from "vitest";

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

// ── execute() boundary harness ─────────────────────────────────────────
// The pure helpers above are token-free by construction; the boundary that
// actually talks to the model is the registered tool's execute(). These
// fakes drive it the way Pi does: capture the ToolDefinition passed to
// pi.registerTool, then invoke execute directly.

type FakeClient = {
  calls: Array<[string, unknown]>;
  response: (method: string, params: unknown) => unknown;
  onConnected: (() => Promise<void> | void) | undefined;
  close(): void;
  connect(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
};

type ToolDefinitionShape = {
  name: string;
  execute: (
    toolCallId: string,
    params: { action: string; profileId?: string | undefined },
    signal: unknown,
    onUpdate: unknown,
    ctx: ToolCtx,
  ) => Promise<ToolResult>;
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, never>;
};

type ToolCtx = {
  isIdle: () => boolean;
  notifications: Array<[string, string | undefined]>;
  sessionManager: { getSessionFile: () => string; getSessionId: () => string };
  setIdle: (value: boolean) => void;
  ui: {
    notify: (message: string, level?: string) => void;
    setStatus: (key: string, value?: string) => void;
  };
};

function createFakeClient() {
  const client = {
    calls: [] as Array<[string, unknown]>,
    onConnected: undefined as (() => Promise<void> | void) | undefined,
    response: (_method: string, _params: unknown): unknown => connectionResponse(),
    close() {},
    async connect() {
      await client.onConnected?.();
    },
    async request(method: string, params: unknown) {
      client.calls.push([method, params]);
      return client.response(method, params);
    },
  };
  return client;
}

function connectionResponse() {
  return {
    events: [],
    presence: {
      connectedAt: 1,
      herdrSessionName: "default",
      paneId: "wA:p1",
      subscriberId: "pi-session",
      terminalId: "term_pi",
      workspaceId: "wA",
    },
    state: {
      ackedEventId: 0,
      herdrSessionName: "default",
      owner: { paneId: "wA:p1", terminalId: "term_pi" },
      updatedAt: "2026-07-10T00:00:00.000Z",
      workspaceId: "wA",
    },
  };
}

function withHerdrEnv() {
  const previous = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
    SHEPY_PROFILE: process.env.SHEPY_PROFILE,
  };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "wA:p1";
  process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
  process.env.HERDR_WORKSPACE_ID = "wA";
  delete process.env.SHEPY_PROFILE;
  return previous;
}

function restoreEnv(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function startToolSession(client: FakeClient) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const registered: ToolDefinitionShape[] = [];
  const ctx: ToolCtx = {
    isIdle: () => true,
    notifications: [],
    sessionManager: {
      getSessionFile: () => "/tmp/pi-session.jsonl",
      getSessionId: () => "pi-session",
    },
    setIdle: () => {},
    ui: {
      notify: (message, level) => ctx.notifications.push([message, level]),
      setStatus: () => {},
    },
  };
  const pi = {
    on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    registerCommand() {},
    registerMessageRenderer() {},
    registerTool(tool: unknown) {
      registered.push(tool as ToolDefinitionShape);
    },
    sendMessage() {},
    setSessionName() {},
  };
  const extension = (await import(extensionModuleUrl)) as unknown as {
    createShepyPiExtension: (options?: {
      clientFactory?: () => FakeClient;
    }) => (pi: unknown) => void;
  };
  const previous = withHerdrEnv();
  try {
    extension.createShepyPiExtension({ clientFactory: () => client })(pi);
    await (handlers.get("session_start") as (event: unknown, ctx: ToolCtx) => Promise<void>)(
      {},
      ctx,
    );
    await client.connect();
  } finally {
    restoreEnv(previous);
  }
  const tool = registered.find((candidate) => candidate.name === "shepy_profile");
  if (!tool) throw new Error("shepy_profile tool was not registered");
  const execute = (params: {
    action: string;
    profileId?: string | undefined;
  }): Promise<ToolResult> => tool.execute("tool-call-1", params, undefined, undefined, ctx);
  return { client, ctx, execute };
}

function resultText(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
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

describe("shepy_profile tool execute() boundary", () => {
  test("the model-facing result of a successful claim never carries the lease token", async () => {
    vi.useFakeTimers();
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "profile.claim") {
        return { result: { kind: "claimed", leaseToken: "lease-secret-1" } };
      }
      if (method === "profile.renew") return { renewed: true };
      if (method === "inbox.lease") return { obligations: [] };
      return connectionResponse();
    };
    try {
      const { execute } = await startToolSession(client);
      const result = await execute({ action: "claim", profileId: "driffs" });
      expect(resultText(result)).toContain("driffs");
      // The token is a capability held by the extension: nowhere in the
      // model-facing payload — text or details — may it appear.
      expect(JSON.stringify(result)).not.toContain("lease-secret-1");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("a rejected claim comes back as a normal result naming the owner, never a throw", async () => {
    vi.useFakeTimers();
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "profile.claim") {
        return {
          result: {
            kind: "rejected",
            owner: { harnessKind: "pi", paneId: "wB:p9" },
            reason: "lease_active",
          },
        };
      }
      if (method === "profile.renew") return { renewed: true };
      if (method === "inbox.lease") return { obligations: [] };
      return connectionResponse();
    };
    try {
      const { execute } = await startToolSession(client);
      const result = await execute({ action: "claim", profileId: "driffs" });
      const text = resultText(result);
      expect(text).toContain("driffs");
      expect(text).toContain("wB:p9");
      expect(text.toLowerCase()).toContain("do not retry");
      expect(client.calls.some(([method]) => method === "profile.claim")).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
