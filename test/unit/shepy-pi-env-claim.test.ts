import { describe, expect, test, vi } from "vitest";

const extensionModuleUrl = new URL("../../packages/shepy-pi/src/index.ts", import.meta.url).href;

type Handler = (...args: unknown[]) => unknown;

type FakeClient = ReturnType<typeof createFakeClient>;
type FakePi = ReturnType<typeof createFakePi>;
type FakeCtx = ReturnType<typeof fakeCtx>;

type Module = {
  createShepyPiExtension: (options?: { clientFactory?: () => FakeClient }) => (pi: FakePi) => void;
};

function createFakeClient() {
  const client = {
    calls: [] as Array<[string, unknown]>,
    closed: false,
    onConnected: undefined as (() => Promise<void> | void) | undefined,
    onDisconnected: undefined as ((error: Error) => void) | undefined,
    onStreamMessage: undefined as ((message: unknown) => void) | undefined,
    response: (_method: string, _params: unknown): unknown => connectionResponse(),
    close() {
      client.closed = true;
    },
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

function createFakePi() {
  const handlers = new Map<string, Handler>();
  let shepyCommand: { handler(args: string, ctx: FakeCtx): Promise<void> } | undefined;
  return {
    handlers,
    customMessages: [] as Array<unknown>,
    hiddenMessages: [] as Array<unknown>,
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand(name: string, options: { handler(args: string, ctx: FakeCtx): Promise<void> }) {
      if (name === "shepy") shepyCommand = options;
    },
    registerMessageRenderer() {},
    registerTool() {},
    sendMessage(message: unknown) {
      const target =
        (message as { display?: boolean }).display === false
          ? this.hiddenMessages
          : this.customMessages;
      target.push(message);
    },
    setSessionName() {},
    async command(args: string, ctx: FakeCtx) {
      await shepyCommand?.handler(args, ctx);
    },
    emit: async (name: string, ...args: unknown[]) => handlers.get(name)?.(...args),
  };
}

function fakeCtx(options: { idle?: boolean } = {}) {
  const runtime = { idle: options.idle ?? false };
  const ctx = {
    aborts: 0,
    isIdle: () => runtime.idle,
    notifications: [] as Array<[string, string | undefined]>,
    sessionManager: {
      getSessionFile: () => "/tmp/pi-session.jsonl",
      getSessionId: () => "pi-session",
    },
    setIdle(value: boolean) {
      runtime.idle = value;
    },
    statuses: new Map<string, string | undefined>(),
    ui: {
      theme: {
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        fg: (_color: string, text: string) => text,
      },
      notify(message: string, level?: string) {
        ctx.notifications.push([message, level]);
      },
      setStatus(key: string, value?: string) {
        ctx.statuses.set(key, value);
      },
    },
  };
  return ctx;
}

/** Full Herdr identity plus the dispatch-provided SHEPY_PROFILE. */
function withHerdrEnv(profile: string | undefined) {
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
  if (profile === undefined) delete process.env.SHEPY_PROFILE;
  else process.env.SHEPY_PROFILE = profile;
  return previous;
}

function restoreEnv(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

function envClaimClient(
  claimResponse: unknown = { result: { kind: "claimed", leaseToken: "lease-1" } },
) {
  const client = createFakeClient();
  client.response = (method) => {
    if (method === "profile.claim") return claimResponse;
    if (method === "profile.renew") return { renewed: true };
    if (method === "inbox.lease") return { obligations: [] };
    return connectionResponse();
  };
  return client;
}

async function startSession(client: FakeClient, profile: string | undefined) {
  const pi = createFakePi();
  const ctx = fakeCtx({ idle: true });
  const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
  createShepyPiExtension({ clientFactory: () => client })(pi);
  const previous = withHerdrEnv(profile);
  try {
    await pi.emit("session_start", {}, ctx);
    await client.connect();
    await vi.advanceTimersByTimeAsync(20);
  } finally {
    restoreEnv(previous);
  }
  return { ctx, pi };
}

describe("shepy-pi env claim (SHEPY_PROFILE)", () => {
  test("a dispatched pane owns its profile before its first token", async () => {
    vi.useFakeTimers();
    const client = envClaimClient();
    try {
      const { ctx } = await startSession(client, "driffs");
      expect(client.calls).toContainEqual([
        "profile.claim",
        expect.objectContaining({
          paneId: "wA:p1",
          profileId: "driffs",
          subscriberId: "pi-session",
          workspaceId: "wA",
        }),
      ]);
      // Notified exactly like the /shepy on <profile> command path.
      expect(ctx.notifications).toContainEqual(["Shepy · profile driffs claimed", "info"]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("a rejected env claim notifies, leaves the pane unowned, and never retries", async () => {
    vi.useFakeTimers();
    const client = envClaimClient({
      result: {
        kind: "rejected",
        owner: { harnessKind: "pi", paneId: "wB:p9" },
        reason: "lease_active",
      },
    });
    try {
      const { ctx } = await startSession(client, "driffs");
      const claims = client.calls.filter(([method]) => method === "profile.claim");
      expect(claims).toHaveLength(1);
      expect(
        ctx.notifications.filter(([message]) => message.includes("claim rejected")),
      ).toHaveLength(1);
      // No pump, no timer: a much later tick must produce no further traffic.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.calls.filter(([method]) => method === "profile.claim")).toHaveLength(1);
      expect(client.calls.some(([method]) => method === "inbox.lease")).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("unset or empty SHEPY_PROFILE keeps today's behaviour", async () => {
    vi.useFakeTimers();
    const client = envClaimClient();
    try {
      await startSession(client, undefined);
      expect(client.calls.some(([method]) => method === "profile.claim")).toBe(false);
      await startSession(client, "   ");
      expect(client.calls.some(([method]) => method === "profile.claim")).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
