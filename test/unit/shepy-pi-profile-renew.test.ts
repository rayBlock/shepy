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

/** A client whose `profile.renew` responses are HELD until the test resolves
 * them, so a pump tick can be parked mid-renew while a re-claim lands. Every
 * synchronous fake answers renew in the same tick it was sent, which makes
 * the daemon's FIFO out-of-order interleaving (stale renew answered AFTER a
 * newer claim) impossible to express — this one can. */
function interleavedRenewClient() {
  const client = createFakeClient();
  let claimCount = 0;
  const pending: Array<{ resolve: (value: unknown) => void; token: string }> = [];
  client.response = (method, params) => {
    if (method === "profile.claim") {
      claimCount += 1;
      return {
        result: {
          kind: claimCount === 1 ? "claimed" : "reclaimed",
          leaseToken: `lease-${claimCount}`,
        },
      };
    }
    if (method === "profile.renew") {
      const token = (params as { leaseToken: string }).leaseToken;
      return new Promise((resolve) => {
        pending.push({ resolve, token });
      });
    }
    if (method === "inbox.lease") return { obligations: [] };
    return connectionResponse();
  };
  return {
    client,
    pendingRenews: () => pending.map((entry) => entry.token),
    resolveRenew(token: string, value: unknown) {
      const index = pending.findIndex((entry) => entry.token === token);
      if (index < 0) throw new Error(`no pending renew for ${token}`);
      const entry = pending[index];
      if (!entry) throw new Error(`no pending renew for ${token}`);
      pending.splice(index, 1);
      entry.resolve(value);
    },
  };
}

/** The OVERLAP RACE client: renews AND recovery claims are held until
 * the test resolves them. Two ticks can then BOTH pass the pre-recovery
 * current-token check before either recovery completes — the exact
 * interleaving the hostile found, impossible with synchronous fakes. */
function overlapRaceClient() {
  const client = createFakeClient();
  let claimCount = 0;
  const pendingRenews: Array<{ resolve: (value: unknown) => void; token: string }> = [];
  const pendingClaims: Array<{ n: number; resolve: (value: unknown) => void }> = [];
  client.response = (method, params) => {
    if (method === "profile.claim") {
      claimCount += 1;
      // The initial /shepy on claim answers synchronously with lease-1;
      // every LATER claim is a lapse recovery, held for the test to land.
      if (claimCount === 1) return { result: { kind: "claimed", leaseToken: "lease-1" } };
      return new Promise((resolve) => {
        pendingClaims.push({ n: claimCount, resolve });
      });
    }
    if (method === "profile.renew") {
      const token = (params as { leaseToken: string }).leaseToken;
      return new Promise((resolve) => {
        pendingRenews.push({ resolve, token });
      });
    }
    if (method === "inbox.lease") return { obligations: [] };
    return connectionResponse();
  };
  return {
    client,
    pendingRenews: () => pendingRenews.map((entry) => entry.token),
    resolveRenew(token: string, value: unknown) {
      const index = pendingRenews.findIndex((entry) => entry.token === token);
      if (index < 0) throw new Error(`no pending renew for ${token}`);
      const entry = pendingRenews[index];
      if (!entry) throw new Error(`no pending renew for ${token}`);
      pendingRenews.splice(index, 1);
      entry.resolve(value);
    },
    resolveClaim(nth: number, value: unknown) {
      const index = pendingClaims.findIndex((entry) => entry.n === nth);
      if (index < 0) throw new Error(`no pending claim #${nth}`);
      const entry = pendingClaims[index];
      if (!entry) throw new Error(`no pending claim #${nth}`);
      pendingClaims.splice(index, 1);
      entry.resolve(value);
    },
  };
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

  test("renewed:false with the token still current recovers via proof-of-possession re-claim", async () => {
    vi.useFakeTimers();
    const client = createFakeClient();
    let claims = 0;
    client.response = (method, params) => {
      if (method === "profile.claim") {
        claims += 1;
        return {
          result: {
            kind: claims === 1 ? "claimed" : "reclaimed",
            leaseToken: `lease-${claims}`,
          },
        };
      }
      if (method === "profile.renew") {
        // The lapsed lease-1 cannot renew; the recovered lease-2 can.
        return { renewed: (params as { leaseToken: string }).leaseToken === "lease-2" };
      }
      if (method === "inbox.lease") return { obligations: [] };
      return connectionResponse();
    };
    const { ctx, pi } = await renewHarness(client);
    try {
      await pi.command("on driffs", ctx); // claim → lease-1; the pump's renew is refused
      await vi.advanceTimersByTimeAsync(20);
      // The lapse was recovered, not mourned: exactly one recovery notify,
      // never an ownership-lost notify.
      const recovered = ctx.notifications.filter(([message]) =>
        message.includes("lease recovered"),
      );
      expect(recovered).toHaveLength(1);
      expect(
        ctx.notifications.filter(([message]) => message.includes("ownership lost")),
      ).toHaveLength(0);
      // The recovery claim presented proof of possession of the lapsed token.
      const claimCalls = client.calls.filter(([method]) => method === "profile.claim");
      expect(claimCalls.at(-1)?.[1]).toMatchObject({
        currentLeaseToken: "lease-1",
        profileId: "driffs",
      });
      client.calls.length = 0;
      // The pump survives under the fresh token: the next tick renews
      // lease-2 successfully and leases the inbox.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.calls.map(([method]) => method)).toEqual(["profile.renew", "inbox.lease"]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("a recovery re-claim rejected by a rival owner stops the pump for good", async () => {
    vi.useFakeTimers();
    const client = createFakeClient();
    let claims = 0;
    client.response = (method) => {
      if (method === "profile.claim") {
        claims += 1;
        if (claims === 1) return { result: { kind: "claimed", leaseToken: "lease-1" } };
        // A rival claimed while our lease lapsed: the proof of possession
        // no longer matches — recovery is impossible and must not retry.
        return { result: { kind: "rejected", reason: "lease_active" } };
      }
      if (method === "profile.renew") return { renewed: false };
      if (method === "inbox.lease") return { obligations: [] };
      return connectionResponse();
    };
    const { ctx, pi } = await renewHarness(client);
    try {
      await pi.command("on driffs", ctx);
      await vi.advanceTimersByTimeAsync(20);
      const losses = ctx.notifications.filter(([message]) => message.includes("ownership lost"));
      expect(losses).toHaveLength(1);
      expect(losses[0]).toEqual(["Shepy · profile driffs ownership lost", "warning"]);
      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy");
      client.calls.length = 0;
      // Two more ticks: the timer is stopped — no renew retry, no re-claim loop.
      await vi.advanceTimersByTimeAsync(21_000);
      expect(client.calls).toEqual([]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("a recovery re-claim transport failure is fail-closed: no stop, retried next tick", async () => {
    vi.useFakeTimers();
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "profile.claim") {
        if (!client.calls.some(([called]) => called === "profile.renew")) {
          return { result: { kind: "claimed", leaseToken: "lease-1" } };
        }
        // The recovery claim hits transport trouble.
        throw new Error("socket hiccup");
      }
      if (method === "profile.renew") return { renewed: false };
      if (method === "inbox.lease") return { obligations: [] };
      return connectionResponse();
    };
    const { ctx, pi } = await renewHarness(client);
    try {
      await pi.command("on driffs", ctx);
      await vi.advanceTimersByTimeAsync(20);
      // Neither lost nor recovered: the lapse stands, the pump survives.
      expect(
        ctx.notifications.filter(([message]) => message.includes("ownership lost")),
      ).toHaveLength(0);
      expect(
        ctx.notifications.filter(([message]) => message.includes("lease recovered")),
      ).toHaveLength(0);
      client.calls.length = 0;
      // Every later tick retries the heartbeat and the recovery once —
      // never a hot loop inside one tick, never a permanent stop.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.calls.map(([method]) => method)).toEqual([
        "profile.renew",
        "profile.claim",
        "inbox.lease",
      ]);
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

  test("a stale renewed:false answered after a same-profile re-claim never clobbers the new ownership", async () => {
    vi.useFakeTimers();
    const { client, resolveRenew } = interleavedRenewClient();
    const { ctx, pi } = await renewHarness(client);
    try {
      // Tick 1 captures mode(lease-1) and parks inside its renew call.
      await pi.command("on driffs", ctx);
      expect(client.calls).toContainEqual([
        "profile.renew",
        { leaseToken: "lease-1", profileId: "driffs" },
      ]);
      // While tick 1 is still in flight, a same-profile re-claim — exactly
      // what the env claim does on every reconnect — installs lease-2 as the
      // live mode and restarts the pump (tick 2 parks inside its own renew).
      await pi.command("on driffs", ctx);
      expect(client.calls).toContainEqual([
        "profile.renew",
        { leaseToken: "lease-2", profileId: "driffs" },
      ]);
      // FIFO daemon: the stale renew(oldToken) was enqueued before the claim
      // but answered after it — guaranteed renewed:false — and its response
      // is read AFTER lease-2 is already the live mode.
      resolveRenew("lease-1", { renewed: false });
      await vi.advanceTimersByTimeAsync(1);
      // The clobber would kill the NEW pump timer, clear lease-2's live mode,
      // and notify an ownership loss that never happened.
      expect(
        ctx.notifications.filter(([message]) => message.includes("ownership lost")),
      ).toHaveLength(0);
      // Tick 2's own renew (the live lease) succeeds and the pump keeps
      // ticking for lease-2 — the new ownership is alive and renewed.
      resolveRenew("lease-2", { renewed: true });
      await vi.advanceTimersByTimeAsync(1);
      client.calls.length = 0;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.calls[0]).toEqual([
        "profile.renew",
        { leaseToken: "lease-2", profileId: "driffs" },
      ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("two overlapping renewed:false continuations recover exactly once", async () => {
    vi.useFakeTimers();
    const { client, pendingRenews, resolveRenew } = interleavedRenewClient();
    const { ctx, pi } = await renewHarness(client);
    try {
      await pi.command("on driffs", ctx); // tick 1 parks inside renew(lease-1)
      await vi.advanceTimersByTimeAsync(10_000); // tick 2 starts while tick 1 awaits
      expect(pendingRenews()).toEqual(["lease-1", "lease-1"]);
      // Both ticks race the same renewal; the daemon answers both false.
      resolveRenew("lease-1", { renewed: false });
      await vi.advanceTimersByTimeAsync(1);
      resolveRenew("lease-1", { renewed: false });
      await vi.advanceTimersByTimeAsync(1);
      // The first continuation recovered the lapse with a fresh token;
      // the second (now stale) continuation must be a silent no-op.
      const recovered = ctx.notifications.filter(([message]) =>
        message.includes("lease recovered"),
      );
      expect(recovered).toHaveLength(1);
      expect(
        ctx.notifications.filter(([message]) => message.includes("ownership lost")),
      ).toHaveLength(0);
      client.calls.length = 0;
      // The pump runs on under the recovered token: the next tick's
      // heartbeat rides lease-2, and resolving it true unblocks the lease.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pendingRenews()).toEqual(["lease-2"]);
      resolveRenew("lease-2", { renewed: true });
      await vi.advanceTimersByTimeAsync(1);
      expect(client.calls.map(([method]) => method)).toContain("inbox.lease");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("a busy owner with a user run active still renews on the claim pump and every tick", async () => {
    vi.useFakeTimers();
    const client = renewingClient(() => ({ renewed: true }));
    const { ctx, pi } = await renewHarness(client);
    try {
      ctx.setIdle(false); // a user run is active — the busiest an owner can be
      await pi.command("on driffs", ctx);
      await vi.advanceTimersByTimeAsync(20);
      // The heartbeat sits BEFORE the busy gate: the tick renewed, then
      // returned without leasing (a busy owner must not lease a wake it
      // cannot witness).
      expect(client.calls.map(([method]) => method)).toEqual(["profile.claim", "profile.renew"]);
      client.calls.length = 0;
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.calls.map(([method]) => method)).toEqual(["profile.renew", "profile.renew"]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("an owner with a wake batch in flight still renews on every tick", async () => {
    vi.useFakeTimers();
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-1" } };
      if (method === "profile.renew") return { renewed: true };
      if (method === "inbox.lease") {
        return { obligations: [{ agentEventId: 7, id: "ob-1", outcome: null }] };
      }
      if (method === "inbox.delivered") return { delivered: 1 };
      return connectionResponse();
    };
    const { ctx, pi } = await renewHarness(client);
    try {
      await pi.command("on driffs", ctx);
      await vi.advanceTimersByTimeAsync(20);
      // The first tick leased a batch: the wake follow-ups were queued and
      // marked delivered, and the batch stays unacked (no settle runs here).
      expect(client.calls.map(([method]) => method)).toEqual([
        "profile.claim",
        "profile.renew",
        "inbox.lease",
        "inbox.delivered",
      ]);
      client.calls.length = 0;
      // While that batch is in flight, every tick must STILL renew first —
      // the batch gate may then skip the lease, but never the heartbeat.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.calls.map(([method]) => method)).toEqual(["profile.renew", "profile.renew"]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("an overlapping recovery rejected after a fresh token was installed must not tear down the recovered pump", async () => {
    vi.useFakeTimers();
    const { client, pendingRenews, resolveRenew, resolveClaim } = overlapRaceClient();
    const { ctx, pi } = await renewHarness(client);
    try {
      await pi.command("on driffs", ctx); // claim → lease-1; tick 1 parks in renew(lease-1)
      await vi.advanceTimersByTimeAsync(10_000); // tick 2 parks in renew(lease-1) too
      expect(pendingRenews()).toEqual(["lease-1", "lease-1"]);
      // Both renewals answer false; both continuations pass the
      // pre-recovery current-token check (nothing has replaced lease-1
      // yet) and both park inside their OWN recovery re-claim.
      resolveRenew("lease-1", { renewed: false });
      await vi.advanceTimersByTimeAsync(1);
      resolveRenew("lease-1", { renewed: false });
      await vi.advanceTimersByTimeAsync(1);
      // The first recovery reclaims with a fresh token; the second is
      // rejected by the daemon — the rival token (lease-2) is active.
      resolveClaim(2, { result: { kind: "reclaimed", leaseToken: "lease-2" } });
      await vi.advanceTimersByTimeAsync(1);
      resolveClaim(3, { result: { kind: "rejected", reason: "lease_active" } });
      await vi.advanceTimersByTimeAsync(1);
      // Exactly one recovery notify; the REJECTED overlapping recovery
      // must be a silent no-op — its mode was stale the moment lease-2
      // landed, so it owns nothing to mourn.
      const recovered = ctx.notifications.filter(([message]) =>
        message.includes("lease recovered"),
      );
      expect(recovered).toHaveLength(1);
      expect(
        ctx.notifications.filter(([message]) => message.includes("ownership lost")),
      ).toHaveLength(0);
      // The pump runs on under the RECOVERED token: the next tick's
      // heartbeat rides lease-2 (a teardown here would have stopped the
      // timer and cleared the live mode).
      client.calls.length = 0;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.calls[0]).toEqual([
        "profile.renew",
        { leaseToken: "lease-2", profileId: "driffs" },
      ]);
      resolveRenew("lease-2", { renewed: true });
      await vi.advanceTimersByTimeAsync(1);
      expect(client.calls.map(([method]) => method)).toContain("inbox.lease");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("a redelivered obligation set gets a fresh turn id per delivery", async () => {
    vi.useFakeTimers();
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-1" } };
      if (method === "profile.renew") return { renewed: true };
      if (method === "inbox.lease") {
        return { obligations: [{ agentEventId: 7, id: "ob-1", outcome: null }] };
      }
      if (method === "inbox.delivered") return { delivered: 1 };
      return connectionResponse();
    };
    const { ctx, pi } = await renewHarness(client);
    const turnIds = () =>
      client.calls
        .filter(([method]) => method === "inbox.delivered")
        .map(([, params]) => (params as { harnessTurnId?: string }).harnessTurnId);
    try {
      await pi.command("on driffs", ctx);
      await vi.advanceTimersByTimeAsync(20);
      const first = turnIds();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatch(/^[0-9a-f]{24}$/);
      // The settling run failed its assistant final: the batch is nacked
      // (wake_failed), cleared, and the settle path re-pumps immediately —
      // ob-1 goes back to the inbox and is delivered AGAIN in one flush.
      await pi.emit("agent_settled", {}, ctx);
      await vi.advanceTimersByTimeAsync(1);
      const second = turnIds();
      expect(second).toHaveLength(2);
      // Same obligation set, DIFFERENT delivery turn: the daemon's
      // persisted correlation must not alias the two delivery attempts.
      expect(second[1]).not.toBe(second[0]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
