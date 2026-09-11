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

function withHerdrEnv() {
  const previous = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
  };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "wA:p1";
  process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
  process.env.HERDR_WORKSPACE_ID = "wA";
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

async function renewHarness(client: FakeClient) {
  const pi = createFakePi();
  const ctx = fakeCtx({ idle: true });
  const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
  createShepyPiExtension({ clientFactory: () => client })(pi);
  const previous = withHerdrEnv();
  try {
    await pi.emit("session_start", {}, ctx);
    await client.connect();
  } finally {
    restoreEnv(previous);
  }
  client.calls.length = 0; // observe only the profile pump's own traffic
  return { ctx, pi };
}

function renewingClient(renew: (method: string, params: unknown) => unknown) {
  const client = createFakeClient();
  client.response = (method, params) => {
    if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-1" } };
    if (method === "profile.renew") return renew(method, params);
    if (method === "inbox.lease") return { obligations: [] };
    return connectionResponse();
  };
  return client;
}

describe("shepy-pi profile pump heartbeat", () => {
  test("the pump renews the lease before leasing, on the claim pump and every tick", async () => {
    vi.useFakeTimers();
    const client = renewingClient(() => ({ renewed: true }));
    const { ctx, pi } = await renewHarness(client);
    try {
      await pi.command("on driffs", ctx);
      await vi.advanceTimersByTimeAsync(20);
      const methods = client.calls.map(([method]) => method);
      expect(methods).toContain("profile.renew");
      expect(methods.indexOf("profile.renew")).toBeLessThan(methods.indexOf("inbox.lease"));
      client.calls.length = 0;
      await vi.advanceTimersByTimeAsync(10_000); // one pump tick
      expect(client.calls.map(([method]) => method)).toEqual(["profile.renew", "inbox.lease"]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("renewed:false ends ownership once: timer stops, mode clears, no re-claim", async () => {
    vi.useFakeTimers();
    const client = renewingClient(() => ({ renewed: false }));
    const { ctx, pi } = await renewHarness(client);
    try {
      await pi.command("on driffs", ctx);
      await vi.advanceTimersByTimeAsync(20);
      const losses = ctx.notifications.filter(([message]) => message.includes("ownership lost"));
      expect(losses).toHaveLength(1);
      expect(losses[0]).toEqual(["Shepy · profile driffs ownership lost", "warning"]);
      // Profile mode cleared: the footer falls back to plain orchestrator state.
      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy");
      client.calls.length = 0;
      // Two more ticks: the timer is stopped — no renew retry, no auto re-claim.
      await vi.advanceTimersByTimeAsync(21_000);
      expect(client.calls).toEqual([]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("a renew transport failure is transient: the tick still leases", async () => {
    vi.useFakeTimers();
    const client = renewingClient(() => {
      throw new Error("socket hiccup");
    });
    const { ctx, pi } = await renewHarness(client);
    try {
      await pi.command("on driffs", ctx);
      await vi.advanceTimersByTimeAsync(20);
      // claim, then the immediate pump: renew fails transiently, lease proceeds.
      expect(client.calls.map(([method]) => method)).toEqual([
        "profile.claim",
        "profile.renew",
        "inbox.lease",
      ]);
      expect(
        ctx.notifications.filter(([message]) => message.includes("ownership lost")),
      ).toHaveLength(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
