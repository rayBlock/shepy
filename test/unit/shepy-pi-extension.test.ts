import { describe, expect, test, vi } from "vitest";
import type {
  AgentEventWireRecord,
  AgentWorkspaceContextSnapshot,
  DaemonStreamMessage,
} from "../../packages/shepy-pi/src/daemon-client.js";

const extensionModuleUrl = new URL("../../packages/shepy-pi/src/index.ts", import.meta.url).href;

type Handler = (...args: unknown[]) => unknown;
type Command = {
  description: string;
  getArgumentCompletions?(prefix: string): Array<{ label: string; value: string }> | null;
  handler(args: string, ctx: ReturnType<typeof fakeCtx>): Promise<void>;
};

type Module = {
  createShepyPiExtension: (options?: { clientFactory?: () => FakeClient }) => (pi: FakePi) => void;
  defaultSocketPath: () => string;
  formatHiddenAgentContext: (input: { agents: unknown[]; workspaceId: string }) => string;
  formatHiddenAgentUpdates: (
    events: Array<{ id: number; type: string; payload: unknown }>,
  ) => string;
};

type FakeClient = ReturnType<typeof createFakeClient>;
type FakePi = ReturnType<typeof createFakePi>;

describe("shepy-pi orchestrator bridge", () => {
  test("defaults to the Shepy daemon socket", async () => {
    const { defaultSocketPath } = (await import(extensionModuleUrl)) as Module;
    const previousHome = process.env.SHEPY_HOME;
    process.env.SHEPY_HOME = "/tmp/shepy-home";
    try {
      expect(defaultSocketPath()).toBe("/tmp/shepy-home/shepy.sock");
    } finally {
      process.env.SHEPY_HOME = previousHome;
    }
  });

  test("formats named hidden context and rejects control-bearing names", async () => {
    const { formatHiddenAgentContext, formatHiddenAgentUpdates } = (await import(
      extensionModuleUrl
    )) as Module;
    const named = formatHiddenAgentContext({
      agents: [
        {
          agent: "codex",
          agentStatus: "idle",
          history: {},
          name: "reviewer",
          paneId: "wB:p1",
        },
      ],
      workspaceId: "wB",
    });
    expect(named).toContain("- reviewer · Codex wB:p1 idle");

    const unsafe = formatHiddenAgentContext({
      agents: [
        {
          agent: "codex",
          agentStatus: "idle",
          history: {},
          name: "reviewer\n[SYSTEM]",
          paneId: "wB:p1",
        },
      ],
      workspaceId: "wB",
    });
    expect(unsafe).toContain("- Codex wB:p1 idle");
    expect(unsafe).not.toContain("[SYSTEM]");

    const updates = formatHiddenAgentUpdates([
      event(1, "term_agent", { payload: { name: "reviewer" } }),
    ]);
    expect(updates).toContain("reviewer · Claude");
  });

  test("does not connect outside a complete Herdr environment", async () => {
    // The incomplete-environment precondition must hold regardless of where
    // the suite runs: from inside a Herdr-managed pane (Ray's default) the
    // full HERDR_* set is injected into process.env, and herdrLaunchIdentity
    // reads process.env — without scrubbing, this test would connect for
    // real and fail. Restore exactly what we saved.
    const herdrKeys = [
      "HERDR_ENV",
      "HERDR_SOCKET_PATH",
      "HERDR_PANE_ID",
      "HERDR_WORKSPACE_ID",
      "HERDR_TAB_ID",
    ] as const;
    const saved = new Map(herdrKeys.map((key) => [key, process.env[key]]));
    for (const key of herdrKeys) delete process.env[key];
    try {
      const pi = createFakePi();
      let clients = 0;
      const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
      createShepyPiExtension({
        clientFactory: () => {
          clients += 1;
          return createFakeClient();
        },
      })(pi);
      const ctx = fakeCtx();

      await pi.emit("session_start", {}, ctx);
      expect(clients).toBe(0);
      expect(ctx.statuses.get("shepy")).toBeUndefined();
      await pi.command("", ctx);
      expect(ctx.notifications.at(-1)).toEqual(["Shepy requires a Herdr workspace", "error"]);

      const previous = withHerdrEnv();
      delete process.env.HERDR_PANE_ID;
      try {
        await pi.emit("session_start", {}, ctx);
        expect(clients).toBe(0);
      } finally {
        restoreEnv(previous);
      }
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("registers presence, adopts daemon location, and reconnects", async () => {
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "agent.orchestrator.register" || method === "agent.orchestrator.get") {
        return connectionResponse({ paneId: "wC:p3", workspaceId: "wC" });
      }
      return { accepted: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv({ paneId: "wB:p1", workspaceId: "wB" });
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      expect(client.calls[0]).toEqual([
        "agent.orchestrator.register",
        {
          herdrSocketPath: "/tmp/herdr.sock",
          paneId: "wB:p1",
          sessionRef: {
            agent: "pi",
            kind: "path",
            source: "herdr:pi",
            value: "/tmp/pi-session.jsonl",
          },
          subscriberId: "pi-session",
          subscriberKind: "pi",
          workspaceId: "wB",
        },
      ]);
      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy");

      const callsBeforeTurnEvents = [...client.calls];
      await pi.emit("tool_execution_start", {
        input: "token=abc",
        toolCallId: "tool-1",
        toolName: "bash",
      });
      await pi.emit("tool_result", {
        content: "failed token=abc",
        isError: true,
        toolCallId: "tool-1",
        toolName: "bash",
        turnId: "turn-1",
      });
      await pi.emit("message_end", {
        message: {
          content: [{ text: "completed", type: "text" }],
          role: "assistant",
          stopReason: "stop",
          turnId: "turn-1",
        },
      });
      expect(client.calls).toEqual(callsBeforeTurnEvents);

      await client.connect();
      expect(
        client.calls.filter(([method]) => method === "agent.orchestrator.register").at(-1),
      ).toEqual([
        "agent.orchestrator.register",
        expect.objectContaining({ paneId: "wC:p3", workspaceId: "wC" }),
      ]);
    } finally {
      restoreEnv(previous);
    }
  });

  test("injects one owner-only cached context synchronously and pins it for a run", async () => {
    const first = contextSnapshot("first");
    const second = contextSnapshot("second");
    const client = createFakeClient();
    client.response = (method) =>
      method === "agent.orchestrator.register" ? connectionResponse({ context: first }) : {};
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      const callsBeforeRun = [...client.calls];

      await pi.emit("agent_start", {}, ctx);
      const messages = await pi.emitContext(
        [
          { content: "[SHEPY AGENT CONTEXT]\nstale", role: "user" },
          { content: "wake", customType: "shepy-wake-context", role: "custom" },
          { content: "keep", customType: "other", role: "custom" },
        ],
        ctx,
      );
      expect(messages).toEqual([
        { content: "wake", customType: "shepy-wake-context", role: "custom" },
        { content: "keep", customType: "other", role: "custom" },
        expect.objectContaining({
          content: expect.stringContaining("first"),
          customType: "shepy-agent-context",
          display: false,
          role: "custom",
          timestamp: expect.any(Number),
        }),
      ]);
      expect(client.calls).toEqual(callsBeforeRun);
      expect(pi.customMessages).toEqual([]);
      expect(pi.hiddenMessages).toEqual([]);

      client.emitStream({
        method: "agent.context.changed",
        params: { context: second, herdrSessionName: "default", workspaceId: "wB" },
      });
      await pi.emit("agent_start", {}, ctx);
      expect(await pi.emitContext([], ctx)).toEqual([
        expect.objectContaining({ content: expect.stringContaining("first") }),
      ]);

      await pi.emit("agent_settled", {}, ctx);
      await pi.emit("agent_start", {}, ctx);
      expect(await pi.emitContext([], ctx)).toEqual([
        expect.objectContaining({ content: expect.stringContaining("second") }),
      ]);

      client.emitStream({
        method: "agent.context.changed",
        params: { context: null, herdrSessionName: "default", workspaceId: "wB" },
      });
      expect(await pi.emitContext([], ctx)).toEqual([
        expect.objectContaining({ content: expect.stringContaining("second") }),
      ]);
      await pi.emit("agent_settled", {}, ctx);
      await pi.emit("agent_start", {}, ctx);
      expect(await pi.emitContext([], ctx)).toEqual([]);
    } finally {
      restoreEnv(previous);
    }
  });

  test("ignores cached context while off or outside its current owner scope", async () => {
    const client = createFakeClient();
    client.response = (method) =>
      method === "agent.orchestrator.register"
        ? connectionResponse({ context: contextSnapshot("other"), ownerTerminalId: "term_other" })
        : {};
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      await pi.emit("agent_start", {}, ctx);
      expect(await pi.emitContext([{ content: "keep", role: "user" }], ctx)).toEqual([
        { content: "keep", role: "user" },
      ]);
      client.emitStream({
        method: "agent.context.changed",
        params: {
          context: contextSnapshot("ignored"),
          herdrSessionName: "default",
          workspaceId: "wB",
        },
      });
      expect(await pi.emitContext([], ctx)).toEqual([]);
    } finally {
      restoreEnv(previous);
    }
  });

  test("clears cached context on role loss and restores only scoped owner context", async () => {
    const initial = contextSnapshot("initial");
    const restored = contextSnapshot("restored");
    let current = connectionResponse({ context: initial });
    const client = createFakeClient();
    client.response = (method, params) => {
      if (method === "agent.orchestrator.register") return current;
      if (method === "agent.orchestrator.set") {
        current = connectionResponse({
          context: (params as { enabled: boolean }).enabled ? restored : initial,
          ownerTerminalId: (params as { enabled: boolean }).enabled ? "term_pi" : null,
        });
        return current;
      }
      return current;
    };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      await pi.emit("agent_start", {}, ctx);
      client.emitStream({
        method: "agent.context.changed",
        params: {
          context: contextSnapshot("wrong"),
          herdrSessionName: "default",
          workspaceId: "wC",
        },
      });
      await pi.emit("agent_settled", {}, ctx);
      await pi.emit("agent_start", {}, ctx);
      expect(await pi.emitContext([], ctx)).toEqual([
        expect.objectContaining({ content: expect.stringContaining("initial") }),
      ]);

      await pi.command("off", ctx);
      expect(await pi.emitContext([], ctx)).toEqual([]);
      await pi.command("on", ctx);
      await pi.emit("agent_start", {}, ctx);
      expect(await pi.emitContext([], ctx)).toEqual([
        expect.objectContaining({ content: expect.stringContaining("restored") }),
      ]);

      client.disconnect();
      await pi.emit("agent_start", {}, ctx);
      expect(await pi.emitContext([], ctx)).toEqual([]);
    } finally {
      restoreEnv(previous);
    }
  });

  test("acknowledges owner updates in ID order only after a final assistant response settles", async () => {
    vi.useFakeTimers();
    const pending = [event(42, "term_agent"), event(41, "term_agent")];
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "agent.orchestrator.register") return connectionResponse({ events: pending });
      if (method === "agent.orchestrator.get") return connectionResponse();
      if (method === "agent.list") return agentListResponse();
      return { acknowledged: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const { createShepyPiExtension, formatHiddenAgentContext, formatHiddenAgentUpdates } =
      (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      client.emitStream({ method: "agent.event", params: { event: event(43, "term_agent") } });
      client.emitStream({ method: "agent.event", params: { event: event(44, "term_pi") } });
      client.emitStream({ method: "agent.event", params: { event: event(45, null) } });

      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy · 3 agent updates");
      expect(ctx.widgets.size).toBe(0);
      expect(formatHiddenAgentContext({ agents: [], workspaceId: "wB" })).toContain(
        "[SHEPY AGENT CONTEXT]",
      );
      expect(formatHiddenAgentUpdates([event(1, "term_agent")])).toContain("[SHEPY AGENT UPDATES]");

      await vi.advanceTimersByTimeAsync(500);
      await pi.emit("agent_start", {}, ctx);
      expect(await pi.emitContext([], ctx)).toEqual([]);
      expect(client.calls.some(([method]) => method === "agent.notifications.ack")).toBe(false);
      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy · 3 agent updates");

      await pi.emit("message_end", assistantMessage("stop"), ctx);
      expect(client.calls.some(([method]) => method === "agent.notifications.ack")).toBe(false);
      await pi.emit("agent_settled", {}, ctx);

      expect(client.calls.filter(([method]) => method === "agent.notifications.ack")).toEqual([
        ["agent.notifications.ack", { eventId: 41 }],
        ["agent.notifications.ack", { eventId: 42 }],
        ["agent.notifications.ack", { eventId: 43 }],
      ]);
      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy");
      expect(ctx.widgets.size).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test.each([
    undefined,
    "error",
    "aborted",
    "toolUse",
  ])("retains delivered updates when the final assistant stop reason is %s", async (stopReason) => {
    vi.useFakeTimers();
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "agent.orchestrator.register") {
        return connectionResponse({ events: [event(51, "term_agent")] });
      }
      if (method === "agent.orchestrator.get") return connectionResponse();
      if (method === "agent.list") return agentListResponse();
      return { acknowledged: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      await vi.advanceTimersByTimeAsync(500);
      await pi.emit("agent_start", {}, ctx);
      if (stopReason) await pi.emit("message_end", assistantMessage(stopReason), ctx);
      else await pi.emit("message_end", { message: { role: "user" } }, ctx);
      await pi.emit("agent_settled", {}, ctx);

      expect(client.calls.some(([method]) => method === "agent.notifications.ack")).toBe(false);
      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy · 1 agent update");
      expect(ctx.notifications.at(-1)).toEqual([
        "Shepy couldn’t acknowledge agent updates · updates remain pending",
        "warning",
      ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("retains only unacknowledged events after a partial acknowledgement failure", async () => {
    vi.useFakeTimers();
    const client = createFakeClient();
    client.response = (method, params) => {
      if (method === "agent.orchestrator.register") {
        return connectionResponse({ events: [event(61, "term_agent"), event(62, "term_agent")] });
      }
      if (method === "agent.orchestrator.get") return connectionResponse();
      if (method === "agent.list") return agentListResponse();
      if (method === "agent.notifications.ack" && (params as { eventId: number }).eventId === 62) {
        throw new Error("ack failed");
      }
      return { acknowledged: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      await vi.advanceTimersByTimeAsync(500);
      await pi.emit("agent_start", {}, ctx);
      await pi.emit("message_end", assistantMessage("stop"), ctx);
      await pi.emit("agent_settled", {}, ctx);

      expect(client.calls.filter(([method]) => method === "agent.notifications.ack")).toEqual([
        ["agent.notifications.ack", { eventId: 61 }],
        ["agent.notifications.ack", { eventId: 62 }],
      ]);
      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy · 1 agent update");
      expect(ctx.widgets.size).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("refreshes the footer after each successful acknowledgement", async () => {
    vi.useFakeTimers();
    let releaseSecondAck: (() => void) | undefined;
    const secondAck = new Promise<void>((resolve) => {
      releaseSecondAck = resolve;
    });
    const client = createFakeClient();
    client.response = (method, params) => {
      if (method === "agent.orchestrator.register") {
        return connectionResponse({ events: [event(61, "term_agent"), event(62, "term_agent")] });
      }
      if (method === "agent.orchestrator.get") return connectionResponse();
      if (method === "agent.list") return agentListResponse();
      if (method === "agent.notifications.ack" && (params as { eventId: number }).eventId === 62) {
        return secondAck;
      }
      return { acknowledged: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      ctx.setIdle(true);
      await pi.emit("agent_settled", {}, ctx);
      await vi.advanceTimersByTimeAsync(500);
      vi.runAllTicks();
      await pi.emit("agent_start", {}, ctx);
      await pi.emit("message_end", assistantMessage("stop"), ctx);
      const settling = pi.emit("agent_settled", {}, ctx);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();

      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy · 1 agent update");

      releaseSecondAck?.();
      await settling;
      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("retains all events after a full acknowledgement failure", async () => {
    vi.useFakeTimers();
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "agent.orchestrator.register") {
        return connectionResponse({ events: [event(63, "term_agent"), event(64, "term_agent")] });
      }
      if (method === "agent.orchestrator.get") return connectionResponse();
      if (method === "agent.list") return agentListResponse();
      if (method === "agent.notifications.ack") throw new Error("ack failed");
      return { acknowledged: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      await vi.advanceTimersByTimeAsync(500);
      await pi.emit("agent_start", {}, ctx);
      await pi.emit("message_end", assistantMessage("stop"), ctx);
      await pi.emit("agent_settled", {}, ctx);

      expect(client.calls.filter(([method]) => method === "agent.notifications.ack")).toEqual([
        ["agent.notifications.ack", { eventId: 63 }],
      ]);
      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy · 2 agent updates");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("invalidates a delivered batch on role loss without aborting a normal turn", async () => {
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "agent.orchestrator.register") {
        return connectionResponse({ events: [event(71, "term_agent")] });
      }
      if (method === "agent.orchestrator.get") return connectionResponse();
      if (method === "agent.list") return agentListResponse();
      return { acknowledged: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      await pi.emit("agent_start", {}, ctx);
      await pi.emit("message_end", assistantMessage("stop"), ctx);
      client.emitStream({
        method: "agent.orchestrator.changed",
        params: { change: roleChange("term_pi", "term_other", "wB:p-other") },
      });
      await pi.emit("agent_settled", {}, ctx);

      expect(ctx.aborts).toBe(0);
      expect(client.calls.some(([method]) => method === "agent.notifications.ack")).toBe(false);
    } finally {
      restoreEnv(previous);
    }
  });

  test("keeps context and updates disabled for a non-owner", async () => {
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "agent.orchestrator.register" || method === "agent.orchestrator.get") {
        return connectionResponse({
          events: [event(9, "term_agent")],
          ownerTerminalId: "term_other",
        });
      }
      if (method === "agent.list") return agentListResponse();
      return { accepted: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      client.emitStream({ method: "agent.event", params: { event: event(10, "term_agent") } });
      await pi.emit("agent_start", {}, ctx);

      expect(await pi.emitContext([], ctx)).toEqual([]);
      expect(client.calls.some(([method]) => method === "agent.list")).toBe(false);
      expect(client.calls.some(([method]) => method === "agent.notifications.ack")).toBe(false);
    } finally {
      restoreEnv(previous);
    }
  });

  test("implements direct local command parsing and status messages", async () => {
    const client = createFakeClient();
    let current = connectionResponse({ ownerTerminalId: null });
    client.response = (method, params) => {
      if (method === "agent.orchestrator.register" || method === "agent.orchestrator.get") {
        return current;
      }
      if (method === "agent.orchestrator.set") {
        const enabled = (params as { enabled: boolean }).enabled;
        if (enabled) current = connectionResponse({ changed: true });
        else if (current.state.owner?.terminalId === "term_pi") {
          current = connectionResponse({ changed: true, ownerTerminalId: null });
        } else current = { ...current, changed: false };
        return current;
      }
      return {};
    };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await pi.command("on", ctx);
      expect(ctx.notifications.at(-1)).toEqual([
        "Shepy is reconnecting · try again shortly",
        "warning",
      ]);
      await client.connect();

      expect(pi.commands.get("shepy")?.description).toBe("Watch Shepy agent updates in this Pi");
      expect(pi.commands.get("shepy")?.getArgumentCompletions?.("")).toEqual([
        { label: "on", value: "on" },
        { label: "off", value: "off" },
        { label: "status", value: "status" },
        { label: "on <profileId>", value: "on <profileId>" },
      ]);

      await pi.command("", ctx);
      expect(ctx.notifications.at(-1)).toEqual(["Shepy is off", "info"]);
      await pi.command("status", ctx);
      expect(ctx.notifications.at(-1)).toEqual(["Shepy is off", "info"]);

      await pi.command("  on  ", ctx);
      expect(client.calls).toContainEqual(["agent.orchestrator.set", { enabled: true }]);
      expect(ctx.notifications.at(-1)).toEqual([
        "Shepy is watching agent updates · default/wB · wB:p1",
        "info",
      ]);
      await pi.command("status", ctx);
      expect(ctx.notifications.at(-1)).toEqual([
        "Shepy is watching agent updates · default/wB · wB:p1",
        "info",
      ]);

      await pi.command("off", ctx);
      expect(ctx.notifications.at(-1)).toEqual(["Shepy is off", "info"]);

      current = connectionResponse({ ownerTerminalId: "term_other" });
      await pi.command("status", ctx);
      expect(ctx.notifications.at(-1)).toEqual(["Shepy is off", "info"]);
      await pi.command("off", ctx);
      expect(current.state.owner?.terminalId).toBe("term_other");
      expect(ctx.notifications.at(-1)).toEqual(["Shepy is off", "info"]);

      await pi.command("orchestrator on", ctx);
      expect(ctx.notifications.at(-1)).toEqual([USAGE, "warning"]);
      await pi.command("unknown", ctx);
      expect(ctx.notifications.at(-1)).toEqual([USAGE, "warning"]);
    } finally {
      restoreEnv(previous);
    }
  });

  test("notifies only a replaced owner and suppresses duplicate self-off stream feedback", async () => {
    const client = createFakeClient();
    let current = connectionResponse();
    client.response = async (method, params) => {
      if (method === "agent.orchestrator.register" || method === "agent.orchestrator.get") {
        return current;
      }
      if (
        method === "agent.orchestrator.set" &&
        (params as { enabled: boolean }).enabled === false
      ) {
        const change = roleChange("term_pi", null);
        current = connectionResponse({ changed: true, ownerTerminalId: null });
        client.emitStream({ method: "agent.orchestrator.changed", params: { change } });
        return current;
      }
      return current;
    };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      client.emitStream({
        method: "agent.orchestrator.changed",
        params: { change: roleChange("term_pi", "term_other", "wB:p-other") },
      });
      expect(ctx.notifications.at(-1)).toEqual(["Shepy is off · moved to wB:p-other", "info"]);
      expect(ctx.statuses.get("shepy")).toBeUndefined();

      current = connectionResponse();
      client.emitStream({
        method: "agent.orchestrator.changed",
        params: { change: roleChange("term_other", "term_pi") },
      });
      await tick();
      ctx.notifications.length = 0;
      await pi.command("off", ctx);
      expect(ctx.notifications).toEqual([["Shepy is off", "info"]]);
      expect(ctx.statuses.get("shepy")).toBeUndefined();
      expect(ctx.statuses.has("shepy-connection")).toBe(false);
      expect(ctx.statuses.has("shepy-orchestrator")).toBe(false);
    } finally {
      restoreEnv(previous);
    }
  });

  test("contains registration failures and shows reconnecting state", async () => {
    const client = createFakeClient();
    client.response = () => {
      throw new Error("registration failed");
    };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await expect(pi.emit("session_start", {}, ctx)).resolves.toBeUndefined();
      await expect(client.connect()).resolves.toBeUndefined();
      expect(ctx.statuses.get("shepy")).toBeUndefined();
      expect(ctx.statuses.has("shepy-connection")).toBe(false);
      expect(ctx.statuses.has("shepy-orchestrator")).toBe(false);
    } finally {
      restoreEnv(previous);
    }
  });

  test("shows reconnecting only for a previous owner and restores it without feedback", async () => {
    const client = createWakeClient();
    const pi = createFakePi();
    const ctx = fakeCtx();
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy");

      client.disconnect();
      expect(ctx.statuses.get("shepy")).toBe("◇ Shepy · reconnecting");
      expect(ctx.statuses.has("shepy-connection")).toBe(false);
      expect(ctx.statuses.has("shepy-orchestrator")).toBe(false);

      await client.connect();
      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy");
      expect(ctx.notifications).toEqual([]);
    } finally {
      restoreEnv(previous);
    }
  });

  test("keeps a previous owner reconnecting across repeated registration failure callbacks", async () => {
    let registrations = 0;
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "agent.orchestrator.register") {
        registrations += 1;
        if (registrations > 1) throw new Error("registration failed");
        return connectionResponse();
      }
      if (method === "agent.orchestrator.get") return connectionResponse();
      return { acknowledged: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.disconnect();
      expect(ctx.statuses.get("shepy")).toBe("◇ Shepy · reconnecting");

      await client.connect();

      expect(ctx.statuses.get("shepy")).toBe("◇ Shepy · reconnecting");
      expect(ctx.notifications).toEqual([]);
    } finally {
      restoreEnv(previous);
    }
  });

  test("keeps the footer absent when a non-owner disconnects", async () => {
    const client = createFakeClient();
    client.response = (method) =>
      method === "agent.orchestrator.register" || method === "agent.orchestrator.get"
        ? connectionResponse({ ownerTerminalId: "term_other" })
        : { acknowledged: true };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      expect(ctx.statuses.get("shepy")).toBeUndefined();

      client.disconnect();
      expect(ctx.statuses.get("shepy")).toBeUndefined();
    } finally {
      restoreEnv(previous);
    }
  });

  test.each([
    ["term_other", "Shepy is off · moved to wB:p-other"],
    [null, "Shepy is off"],
  ])("reports ownership loss discovered on reconnect to %s", async (ownerTerminalId, message) => {
    let current = connectionResponse();
    const client = createFakeClient();
    client.response = (method) =>
      method === "agent.orchestrator.register" || method === "agent.orchestrator.get"
        ? current
        : { acknowledged: true };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.disconnect();
      expect(ctx.statuses.get("shepy")).toBe("◇ Shepy · reconnecting");

      current = connectionResponse({ ownerTerminalId });
      await client.connect();

      expect(ctx.statuses.get("shepy")).toBeUndefined();
      expect(ctx.notifications.at(-1)).toEqual([message, "info"]);
    } finally {
      restoreEnv(previous);
    }
  });

  test("refreshes pending state when the owner moves to another workspace", async () => {
    const client = createFakeClient();
    client.response = (method) =>
      method === "agent.orchestrator.get"
        ? connectionResponse({
            events: [event(77, "term_agent")],
            paneId: "wC:p3",
            workspaceId: "wC",
          })
        : connectionResponse();
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      client.emitStream({
        method: "agent.orchestrator.changed",
        params: {
          change: {
            ...roleChange("term_pi", "term_pi", "wC:p3"),
            current: {
              ...roleChange("term_pi", "term_pi", "wC:p3").current,
              workspaceId: "wC",
            },
          },
        },
      });
      await tick();

      expect(client.calls).toContainEqual(["agent.orchestrator.get", {}]);
      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy · 1 agent update");
    } finally {
      restoreEnv(previous);
    }
  });

  test.each([
    ["agent.done", {}],
    ["agent.blocked", {}],
    ["agent.idle", { from: "working", to: "idle" }],
  ])("wakes once at 500 ms for %s", async (type, payload) => {
    vi.useFakeTimers();
    const client = createWakeClient();
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      expect(pi.messageRenderers.has("shepy-wake")).toBe(true);
      client.emitStream({
        method: "agent.event",
        params: {
          event: event(43, "term_agent", { payload: { name: "reviewer", ...payload }, type }),
        },
      });

      await vi.advanceTimersByTimeAsync(499);
      expect(pi.customMessages).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(pi.customMessages).toEqual([
        [
          {
            content: "Shepy received 1 agent update.",
            customType: "shepy-wake",
            details: {
              eventIds: [43],
              outcomes: [
                {
                  agent: "claude",
                  eventId: 43,
                  kind: type === "agent.blocked" ? "blocked" : "completed",
                  name: "reviewer",
                  paneId: "wB:p-agent",
                  terminalId: "term_agent",
                  text: "done",
                  truncated: false,
                },
              ],
            },
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true },
        ],
      ]);
      expect(pi.hiddenMessages).toEqual([
        [
          {
            content: expect.stringContaining("reviewer · Claude"),
            customType: "shepy-wake-context",
            details: { eventIds: [43] },
            display: false,
          },
          { deliverAs: "followUp" },
        ],
      ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("ignores non-outcomes, done-to-idle duplicates, null-terminal, and self events", async () => {
    vi.useFakeTimers();
    const client = createWakeClient();
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      for (const candidate of [
        event(44, "term_agent", { type: "agent.status.changed" }),
        event(45, "term_agent", { type: "agent.tool.failed" }),
        event(46, "term_agent", { payload: { from: "done", to: "idle" }, type: "agent.idle" }),
        event(47, null),
        event(48, "term_pi"),
      ]) {
        client.emitStream({ method: "agent.event", params: { event: candidate } });
      }
      await vi.advanceTimersByTimeAsync(1_000);

      expect(pi.customMessages).toEqual([]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("coalesces multiple outcomes into one visible wake", async () => {
    vi.useFakeTimers();
    const client = createWakeClient();
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(51, "term_agent") } });
      client.emitStream({
        method: "agent.event",
        params: { event: event(52, "term_other", { type: "agent.blocked" }) },
      });
      await vi.advanceTimersByTimeAsync(500);

      expect(pi.customMessages).toMatchObject([
        [
          {
            content: "Shepy received 2 agent updates.",
            customType: "shepy-wake",
            details: { eventIds: [51, 52], outcomes: [{ eventId: 51 }, { eventId: 52 }] },
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true },
        ],
      ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("retains pending outcomes when wake preparation fails", async () => {
    vi.useFakeTimers();
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "agent.orchestrator.register") return connectionResponse();
      if (method === "agent.orchestrator.get") throw new Error("refresh failed");
      return { acknowledged: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(53, "term_agent") } });
      await vi.advanceTimersByTimeAsync(500);

      expect(pi.customMessages).toEqual([]);
      expect(ctx.statuses.get("shepy")).toBe("◆ Shepy · 1 agent update");
      expect(ctx.notifications.at(-1)).toEqual([
        "Shepy couldn’t load agent updates · updates remain pending",
        "warning",
      ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("defers a busy wake until Pi settles idle", async () => {
    vi.useFakeTimers();
    const client = createWakeClient();
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: false });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(61, "term_agent") } });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pi.customMessages).toEqual([]);

      ctx.setIdle(true);
      await pi.emit("agent_settled", {}, ctx);
      await vi.advanceTimersByTimeAsync(500);
      expect(pi.customMessages).toHaveLength(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("schedules a later wake for events arriving during a delivered batch", async () => {
    vi.useFakeTimers();
    const client = createWakeClient();
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(71, "term_agent") } });
      await vi.advanceTimersByTimeAsync(500);
      await pi.emit("agent_start", {}, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(72, "term_other") } });
      await pi.emit("message_end", assistantMessage("stop"), ctx);
      await pi.emit("agent_settled", {}, ctx);
      await vi.advanceTimersByTimeAsync(500);

      expect(
        pi.customMessages.map(([message]) => (message.details as { eventIds: number[] }).eventIds),
      ).toEqual([[71], [72]]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("does not retry a failed batch until a newer outcome arrives", async () => {
    vi.useFakeTimers();
    const client = createWakeClient();
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(81, "term_agent") } });
      await vi.advanceTimersByTimeAsync(500);
      await pi.emit("agent_start", {}, ctx);
      await pi.emit("message_end", assistantMessage("aborted"), ctx);
      await pi.emit("agent_settled", {}, ctx);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pi.customMessages).toHaveLength(1);

      client.emitStream({ method: "agent.event", params: { event: event(82, "term_agent") } });
      await vi.advanceTimersByTimeAsync(500);
      expect(pi.customMessages).toHaveLength(2);
      expect(pi.customMessages.at(-1)?.[0]).toMatchObject({ details: { eventIds: [82] } });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("suppresses automatic retry after acknowledgement failure until a newer outcome", async () => {
    vi.useFakeTimers();
    const client = createWakeClient();
    const baseResponse = client.response;
    client.response = (method, params) => {
      if (method === "agent.notifications.ack") throw new Error("ack failed");
      return baseResponse(method, params);
    };
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(86, "term_agent") } });
      await vi.advanceTimersByTimeAsync(500);
      await pi.emit("agent_start", {}, ctx);
      await pi.emit("message_end", assistantMessage("stop"), ctx);
      await pi.emit("agent_settled", {}, ctx);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pi.customMessages).toHaveLength(1);

      client.emitStream({ method: "agent.event", params: { event: event(87, "term_agent") } });
      await vi.advanceTimersByTimeAsync(500);
      expect(pi.customMessages).toHaveLength(2);
      expect(pi.customMessages.at(-1)?.[0]).toMatchObject({ details: { eventIds: [87] } });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("does not replay a sent-but-not-started wake after reconnect", async () => {
    vi.useFakeTimers();
    const pending = event(88, "term_agent");
    const client = createFakeClient();
    let registrations = 0;
    client.response = (method) => {
      if (method === "agent.orchestrator.register") {
        registrations += 1;
        return connectionResponse({ events: registrations === 1 ? [] : [pending] });
      }
      if (method === "agent.orchestrator.get") return connectionResponse();
      if (method === "agent.list") return agentListResponse();
      return { acknowledged: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: pending } });
      await vi.advanceTimersByTimeAsync(500);
      expect(pi.customMessages).toHaveLength(1);

      client.disconnect();
      await client.connect();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pi.customMessages).toHaveLength(1);
      await pi.emit("agent_settled", {}, ctx);

      client.emitStream({ method: "agent.event", params: { event: event(89, "term_agent") } });
      await vi.advanceTimersByTimeAsync(500);
      expect(pi.customMessages).toHaveLength(2);
      expect(pi.customMessages.at(-1)?.[0]).toMatchObject({ details: { eventIds: [89] } });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("wakes replayed pending outcomes after registration", async () => {
    vi.useFakeTimers();
    const client = createWakeClient([event(91, "term_agent")]);
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      await vi.advanceTimersByTimeAsync(500);

      expect(pi.customMessages).toHaveLength(1);
      expect(pi.customMessages[0]?.[0]).toMatchObject({ details: { eventIds: [91] } });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("lets a replacement Pi wake the previous owner's unacknowledged batch", async () => {
    vi.useFakeTimers();
    const pending = event(96, "term_agent");
    const firstClient = createWakeClient();
    const firstPi = createFakePi();
    const firstCtx = fakeCtx({ idle: true });
    const secondClient = createWakeClient([pending]);
    const secondPi = createFakePi();
    const secondCtx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(firstClient, firstPi, firstCtx);
      firstClient.emitStream({ method: "agent.event", params: { event: pending } });
      await vi.advanceTimersByTimeAsync(500);
      await firstPi.emit("agent_start", {}, firstCtx);
      firstClient.emitStream({
        method: "agent.orchestrator.changed",
        params: { change: roleChange("term_pi", "term_other", "wB:p-other") },
      });
      expect(firstCtx.aborts).toBe(1);

      await startExtension(secondClient, secondPi, secondCtx);
      await vi.advanceTimersByTimeAsync(500);
      expect(secondPi.customMessages).toHaveLength(1);
      expect(secondPi.customMessages[0]?.[0]).toMatchObject({ details: { eventIds: [96] } });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("defers pending updates past a normal user run and acknowledges only its wake", async () => {
    vi.useFakeTimers();
    const client = createWakeClient();
    client.response = (method) =>
      method === "agent.orchestrator.register" || method === "agent.orchestrator.get"
        ? connectionResponse({ context: contextSnapshot("normal") })
        : { acknowledged: true };
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(101, "term_agent") } });
      await vi.advanceTimersByTimeAsync(250);
      ctx.setIdle(false);
      await pi.emit("agent_start", {}, ctx);
      const normalContext = await pi.emitContext([], ctx);
      await vi.advanceTimersByTimeAsync(250);

      expect(pi.customMessages).toEqual([]);
      expect(normalContext).toEqual([
        expect.objectContaining({ content: expect.stringContaining("[SHEPY AGENT CONTEXT]") }),
      ]);
      expect(normalContext.some((message) => JSON.stringify(message).includes("UPDATES"))).toBe(
        false,
      );
      expect(client.calls.some(([method]) => method === "agent.notifications.ack")).toBe(false);

      await pi.emit("message_end", assistantMessage("stop"), ctx);
      ctx.setIdle(true);
      await pi.emit("agent_settled", {}, ctx);
      await vi.advanceTimersByTimeAsync(500);
      expect(pi.customMessages).toHaveLength(1);

      await pi.emit("agent_start", {}, ctx);
      expect(
        await pi.emitContext([{ customType: "shepy-wake-context", role: "custom" }], ctx),
      ).toEqual([{ customType: "shepy-wake-context", role: "custom" }]);
      await pi.emit("message_end", assistantMessage("stop"), ctx);
      await pi.emit("agent_settled", {}, ctx);
      expect(client.calls).toContainEqual(["agent.notifications.ack", { eventId: 101 }]);
      expect(ctx.aborts).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("rebuilds pending wake state when timer refresh reveals a missed workspace move", async () => {
    vi.useFakeTimers();
    const target = event(104, "term_agent", {
      paneId: "wC:p-agent",
      workspaceId: "wC",
    });
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "agent.orchestrator.register") return connectionResponse();
      if (method === "agent.orchestrator.get") {
        return connectionResponse({ events: [target], paneId: "wC:p1", workspaceId: "wC" });
      }
      if (method === "agent.list") return agentListResponse();
      return { acknowledged: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(103, "term_agent") } });
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);

      expect(pi.customMessages).toHaveLength(1);
      expect(pi.customMessages[0]?.[0]).toMatchObject({ details: { eventIds: [104] } });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("resets an old batch when reconnect registration reveals a missed workspace move", async () => {
    vi.useFakeTimers();
    const target = event(106, "term_agent", {
      paneId: "wC:p-agent",
      workspaceId: "wC",
    });
    const client = createFakeClient();
    let moved = false;
    client.response = (method) => {
      if (method === "agent.orchestrator.register" || method === "agent.orchestrator.get") {
        return moved
          ? connectionResponse({ events: [target], paneId: "wC:p1", workspaceId: "wC" })
          : connectionResponse();
      }
      if (method === "agent.list") return agentListResponse();
      return { acknowledged: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(105, "term_agent") } });
      await vi.advanceTimersByTimeAsync(500);
      ctx.setIdle(false);
      moved = true;
      await client.connect();

      expect(ctx.aborts).toBe(1);
      ctx.setIdle(true);
      await pi.emit("message_end", assistantMessage("stop"), ctx);
      await pi.emit("agent_settled", {}, ctx);
      await vi.advanceTimersByTimeAsync(500);

      expect(client.calls).not.toContainEqual(["agent.notifications.ack", { eventId: 105 }]);
      expect(
        pi.customMessages.map(([message]) => (message.details as { eventIds: number[] }).eventIds),
      ).toEqual([[105], [106]]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("drops a stale timer when the same terminal moves workspaces", async () => {
    vi.useFakeTimers();
    const target = event(108, "term_agent", {
      paneId: "wC:p-agent",
      workspaceId: "wC",
    });
    const client = createFakeClient();
    let moved = false;
    client.response = (method) => {
      if (method === "agent.orchestrator.register") return connectionResponse();
      if (method === "agent.orchestrator.get") {
        return moved
          ? connectionResponse({ events: [target], paneId: "wC:p1", workspaceId: "wC" })
          : connectionResponse();
      }
      if (method === "agent.list") return agentListResponse();
      return { acknowledged: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(107, "term_agent") } });
      await vi.advanceTimersByTimeAsync(250);
      moved = true;
      client.emitStream({
        method: "agent.orchestrator.changed",
        params: { change: movedRoleChange() },
      });
      await vi.advanceTimersByTimeAsync(500);

      expect(pi.customMessages).toHaveLength(1);
      expect(pi.customMessages[0]?.[0]).toMatchObject({ details: { eventIds: [108] } });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("invalidates and aborts a delivered Shepy batch on same-terminal workspace move", async () => {
    vi.useFakeTimers();
    const target = event(110, "term_agent", {
      paneId: "wC:p-agent",
      workspaceId: "wC",
    });
    const client = createFakeClient();
    let moved = false;
    client.response = (method) => {
      if (method === "agent.orchestrator.register") return connectionResponse();
      if (method === "agent.orchestrator.get") {
        return moved
          ? connectionResponse({ events: [target], paneId: "wC:p1", workspaceId: "wC" })
          : connectionResponse();
      }
      if (method === "agent.list") return agentListResponse();
      return { acknowledged: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(109, "term_agent") } });
      await vi.advanceTimersByTimeAsync(500);
      await pi.emit("agent_start", {}, ctx);
      moved = true;
      client.emitStream({
        method: "agent.orchestrator.changed",
        params: { change: movedRoleChange() },
      });
      await vi.advanceTimersByTimeAsync(500);
      await pi.emit("message_end", assistantMessage("stop"), ctx);
      await pi.emit("agent_settled", {}, ctx);

      expect(ctx.aborts).toBe(1);
      expect(client.calls).not.toContainEqual(["agent.notifications.ack", { eventId: 109 }]);
      expect(
        pi.customMessages.map(([message]) => (message.details as { eventIds: number[] }).eventIds),
      ).toEqual([[109], [110]]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("cancels pending wake and aborts only a Shepy-triggered turn on role loss", async () => {
    vi.useFakeTimers();
    const client = createWakeClient();
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(111, "term_agent") } });
      await vi.advanceTimersByTimeAsync(250);
      client.emitStream({
        method: "agent.orchestrator.changed",
        params: { change: roleChange("term_pi", "term_other", "wB:p-other") },
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(pi.customMessages).toEqual([]);
      expect(ctx.aborts).toBe(0);

      client.emitStream({
        method: "agent.orchestrator.changed",
        params: { change: roleChange("term_other", "term_pi") },
      });
      await vi.runAllTimersAsync();
      client.emitStream({ method: "agent.event", params: { event: event(112, "term_agent") } });
      await vi.advanceTimersByTimeAsync(500);
      await pi.emit("agent_start", {}, ctx);
      client.emitStream({
        method: "agent.orchestrator.changed",
        params: { change: roleChange("term_pi", "term_other", "wB:p-other") },
      });

      expect(ctx.aborts).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("clears reconnecting UI on shutdown", async () => {
    vi.useFakeTimers();
    const client = createWakeClient();
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(113, "term_agent") } });
      await vi.advanceTimersByTimeAsync(250);
      client.disconnect();
      expect(ctx.statuses.get("shepy")).toBe("◇ Shepy · reconnecting");

      await pi.emit("session_shutdown");

      expect(ctx.statuses.get("shepy")).toBeUndefined();
      expect(ctx.notifications).toEqual([]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("cancels an owner wake timer on shutdown", async () => {
    vi.useFakeTimers();
    const client = createWakeClient();
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv();
    try {
      await startExtension(client, pi, ctx);
      client.emitStream({ method: "agent.event", params: { event: event(114, "term_agent") } });
      await vi.advanceTimersByTimeAsync(250);

      await pi.emit("session_shutdown");
      await vi.advanceTimersByTimeAsync(500);

      expect(ctx.statuses.get("shepy")).toBeUndefined();
      expect(pi.customMessages).toEqual([]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      restoreEnv(previous);
    }
  });

  test("closes on shutdown and a fresh Pi session registers with its own subscriber id", async () => {
    const first = createFakeClient();
    const second = createFakeClient();
    const clients = [first, second];
    const pi = createFakePi();
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => clients.shift() as FakeClient })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, fakeCtx({ sessionId: "pi-old" }));
      await first.connect();
      await pi.emit("session_shutdown");
      await pi.emit("session_start", {}, fakeCtx({ sessionId: "pi-new" }));
      await second.connect();

      expect(first.closed).toBe(true);
      expect(second.calls[0]).toEqual([
        "agent.orchestrator.register",
        expect.objectContaining({ subscriberId: "pi-new" }),
      ]);
    } finally {
      restoreEnv(previous);
    }
  });
});

const USAGE = "Usage: /shepy [on|off|status]";

function createWakeClient(replayedEvents: AgentEventWireRecord[] = []) {
  const client = createFakeClient();
  client.response = (method) => {
    if (method === "agent.orchestrator.register") {
      return connectionResponse({ events: replayedEvents });
    }
    if (method === "agent.orchestrator.get") return connectionResponse();
    if (method === "agent.list") return agentListResponse();
    return { acknowledged: true };
  };
  return client;
}

async function startExtension(
  client: FakeClient,
  pi: FakePi,
  ctx: ReturnType<typeof fakeCtx>,
): Promise<void> {
  const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
  createShepyPiExtension({ clientFactory: () => client })(pi);
  await pi.emit("session_start", {}, ctx);
  await client.connect();
}

function createFakeClient() {
  let connected: (() => Promise<void> | void) | undefined;
  let disconnected: ((error: Error) => void) | undefined;
  let stream: ((message: DaemonStreamMessage) => void) | undefined;
  const client = {
    calls: [] as Array<[string, unknown]>,
    closed: false,
    response: (_method: string, _params: unknown): unknown => connectionResponse(),
    close() {
      client.closed = true;
    },
    async connect() {
      try {
        await connected?.();
      } catch (error) {
        disconnected?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    disconnect(error = new Error("disconnected")) {
      disconnected?.(error);
    },
    emitStream(message: DaemonStreamMessage) {
      stream?.(message);
    },
    get onConnected() {
      return connected;
    },
    set onConnected(handler: (() => Promise<void> | void) | undefined) {
      connected = handler;
    },
    get onDisconnected() {
      return disconnected;
    },
    set onDisconnected(handler: ((error: Error) => void) | undefined) {
      disconnected = handler;
    },
    get onStreamMessage() {
      return stream;
    },
    set onStreamMessage(handler: ((message: DaemonStreamMessage) => void) | undefined) {
      stream = handler;
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
  const commands = new Map<string, Command>();
  return {
    commands,
    customMessages: [] as Array<
      [
        { content: string; customType: string; details?: unknown; display: boolean },
        { deliverAs?: string; triggerTurn?: boolean } | undefined,
      ]
    >,
    entries: [] as unknown[],
    handlers,
    hiddenMessages: [] as Array<
      [
        { content: string; customType: string; details?: unknown; display: boolean },
        { deliverAs?: string; triggerTurn?: boolean } | undefined,
      ]
    >,
    messageRenderers: new Map<string, Handler>(),
    appendEntry(customType: string, data: unknown) {
      this.entries.push([customType, data]);
    },
    async command(args: string, ctx: ReturnType<typeof fakeCtx>) {
      await commands.get("shepy")?.handler(args, ctx);
    },
    emit: async (name: string, ...args: unknown[]) => handlers.get(name)?.(...args),
    async emitContext(messages: unknown[], ctx: ReturnType<typeof fakeCtx>) {
      return (
        (
          (await handlers.get("context")?.({ messages, type: "context" }, ctx)) as
            | { messages?: unknown[] }
            | undefined
        )?.messages ?? messages
      );
    },
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand(name: string, options: Command) {
      commands.set(name, options);
    },
    registerMessageRenderer(customType: string, renderer: Handler) {
      this.messageRenderers.set(customType, renderer);
    },
    registerTool() {},
    sendMessage(message: unknown, options?: unknown) {
      const target =
        (message as { display?: boolean }).display === false
          ? this.hiddenMessages
          : this.customMessages;
      target.push([message as never, options as never]);
    },
    setSessionName() {},
  };
}

function fakeCtx(options: { idle?: boolean; sessionId?: string } = {}) {
  const runtime = { idle: options.idle ?? false };
  const ctx = {
    abort() {
      ctx.aborts += 1;
    },
    aborts: 0,
    isIdle: () => runtime.idle,
    notifications: [] as Array<[string, string | undefined]>,
    sessionManager: {
      getSessionFile: () => "/tmp/pi-session.jsonl",
      getSessionId: () => options.sessionId ?? "pi-session",
    },
    setIdle(value: boolean) {
      runtime.idle = value;
    },
    statuses: new Map<string, string | undefined>(),
    widgets: new Map<string, string[] | undefined>(),
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
      setWidget(key: string, value?: string[]) {
        if (value?.some((line) => typeof line !== "string")) {
          throw new Error("widget lines must be strings");
        }
        ctx.widgets.set(key, value);
      },
    },
  };
  return ctx;
}

function connectionResponse(
  options: {
    changed?: boolean;
    context?: AgentWorkspaceContextSnapshot | null;
    events?: AgentEventWireRecord[];
    ownerTerminalId?: string | null;
    paneId?: string;
    workspaceId?: string;
  } = {},
) {
  const paneId = options.paneId ?? "wB:p1";
  const workspaceId = options.workspaceId ?? "wB";
  const ownerTerminalId =
    options.ownerTerminalId === undefined ? "term_pi" : options.ownerTerminalId;
  return {
    ...(options.changed === undefined ? {} : { changed: options.changed }),
    ...(options.context === undefined ? {} : { context: options.context }),
    events: options.events ?? [],
    presence: {
      connectedAt: 1,
      herdrSessionName: "default",
      paneId,
      subscriberId: "pi-session",
      terminalId: "term_pi",
      workspaceId,
    },
    state: {
      ackedEventId: 0,
      herdrSessionName: "default",
      owner: ownerTerminalId
        ? {
            paneId: ownerTerminalId === "term_pi" ? paneId : "wB:p-other",
            terminalId: ownerTerminalId,
          }
        : null,
      updatedAt: "2026-07-10T00:00:00.000Z",
      workspaceId,
    },
  };
}

function event(
  id: number,
  terminalId: string | null,
  options: {
    paneId?: string;
    payload?: Record<string, unknown>;
    type?: string;
    workspaceId?: string;
  } = {},
): AgentEventWireRecord {
  return {
    compactHistory: { lastAssistantMessage: { text: "done" } },
    id,
    paneId: options.paneId ?? "wB:p-agent",
    payload: { agent: "claude", ...options.payload },
    terminalId,
    type: options.type ?? "agent.done",
    workspaceId: options.workspaceId ?? "wB",
  };
}

function assistantMessage(stopReason: string) {
  return {
    message: {
      content: [{ text: "completed", type: "text" }],
      role: "assistant",
      stopReason,
      turnId: "turn-1",
    },
  };
}

function contextSnapshot(lastAssistantText: string): AgentWorkspaceContextSnapshot {
  return {
    agents: [
      {
        agent: "claude",
        agentStatus: "idle",
        history: { lastAssistantMessage: { text: lastAssistantText } },
        paneId: "wB:p-agent",
        terminalId: "term_agent",
      },
    ],
    herdrSessionName: "default",
    updatedAt: "2026-07-16T00:00:00.000Z",
    workspaceId: "wB",
  };
}

function agentListResponse() {
  return {
    agents: [
      {
        agent: "pi",
        agentStatus: "idle",
        history: {
          lastAssistantMessage: { text: "ready" },
          lastUserMessage: { text: "work" },
        },
        paneId: "wB:p1",
      },
    ],
  };
}

function roleChange(
  previousTerminalId: string | null,
  currentTerminalId: string | null,
  currentPaneId = "wB:p1",
) {
  return {
    current: {
      ackedEventId: 0,
      herdrSessionName: "default",
      owner: currentTerminalId ? { paneId: currentPaneId, terminalId: currentTerminalId } : null,
      updatedAt: "2026-07-10T00:00:01.000Z",
      workspaceId: "wB",
    },
    previous: {
      ackedEventId: 0,
      herdrSessionName: "default",
      owner: previousTerminalId ? { paneId: "wB:p1", terminalId: previousTerminalId } : null,
      updatedAt: "2026-07-10T00:00:00.000Z",
      workspaceId: "wB",
    },
    reason: "claimed" as const,
  };
}

function movedRoleChange() {
  const change = roleChange("term_pi", "term_pi", "wC:p1");
  return {
    ...change,
    current: { ...change.current, workspaceId: "wC" },
  };
}

function withHerdrEnv(options: { paneId?: string; workspaceId?: string } = {}) {
  const previous = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
  };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = options.paneId ?? "wB:p1";
  process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
  process.env.HERDR_WORKSPACE_ID = options.workspaceId ?? "wB";
  return previous;
}

function restoreEnv(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("shepy-pi profile-owner bridge (Phase 4)", () => {
  test("/shepy on <profile> claims the profile and starts the pump", async () => {
    const { pi, ctx, client } = await profileHarness();
    client.response = (method, params) => {
      if (method === "profile.claim") {
        expect(params).toMatchObject({ harnessKind: "pi", profileId: "driffs" });
        return { result: { kind: "claimed", leaseToken: "lease-1" } };
      }
      if (method === "inbox.lease") return { obligations: [] };
      return connectionResponse();
    };
    await pi.command("on driffs", ctx);
    expect(client.calls).toContainEqual([
      "profile.claim",
      expect.objectContaining({ profileId: "driffs" }),
    ]);
    expect(ctx.notifications.at(-1)?.[1]).toBe("info");
    await pi.command("off", ctx);
    expect(client.calls).toContainEqual([
      "profile.release",
      { leaseToken: "lease-1", profileId: "driffs" },
    ]);
  });

  test("pump leases obligations, delivers ONE wake, acks after successful settle", async () => {
    const { pi, ctx, client } = await profileHarness();
    const obligations = [
      {
        agentEventId: 1,
        id: "ob-1",
        outcome: {
          agent: "hermes",
          createdAt: "2026-09-10T09:47:34.000Z",
          eventId: 1,
          excerpt: { text: "Worker finished the audit.", truncated: false },
          from: "working",
          name: "driffs-worker",
          paneId: "wS:p1",
          terminalId: "tS",
          to: "done",
          type: "agent.done",
        },
      },
      {
        agentEventId: 2,
        id: "ob-2",
        outcome: {
          agent: "pi",
          createdAt: "2026-09-10T09:52:40.000Z",
          eventId: 2,
          excerpt: { text: "", truncated: false },
          from: "working",
          name: "second-worker",
          paneId: "wS:p2",
          terminalId: "tS2",
          to: "idle",
          type: "agent.idle",
        },
      },
    ];
    client.response = (method) => {
      if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-1" } };
      if (method === "inbox.lease") return { obligations };
      return { delivered: 2 };
    };
    await pi.command("on driffs", ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(client.calls).toContainEqual([
      "inbox.lease",
      expect.objectContaining({ leaseToken: "lease-1" }),
    ]);
    expect(client.calls).toContainEqual([
      "inbox.delivered",
      expect.objectContaining({ ids: ["ob-1", "ob-2"], leaseToken: "lease-1" }),
    ]);
    // The wake is event-correlated: current profile history is never fetched
    // as outcome truth.
    expect(client.calls.map(([method]) => method)).not.toContain("profile.context");
    // ONE visible wake with triggerTurn + hidden context
    const wake = pi.customMessages.find(
      ([message]) =>
        message.customType === "shepy-wake" &&
        (message.details as { profileId?: string } | undefined)?.profileId === "driffs",
    );
    expect(wake?.[0].content).toContain("2 agent update(s)");
    const hidden = pi.hiddenMessages.find(
      ([message]) =>
        message.customType === "shepy-wake-context" &&
        (message.details as { profileId?: string } | undefined)?.profileId === "driffs",
    );
    // Exact leased events with cause — never an all-agents roster.
    expect(hidden?.[0].content).toContain("driffs-worker");
    expect(hidden?.[0].content).toContain("working→done");
    expect(hidden?.[0].content).toContain("event: 1");
    expect(hidden?.[0].content).toContain("event: 2");
    expect(hidden?.[0].content).toContain("obligation: ob-1");
    expect(hidden?.[0].content).toContain("Worker finished the audit.");
    expect(
      pi.customMessages.filter(([message]) => message.customType === "shepy-wake"),
    ).toHaveLength(1);

    // Successful assistant final, then settle → ack
    await pi.emit("message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
    client.response = (method) => {
      if (method === "inbox.ack") return { acked: 2, rejected: [] };
      if (method === "inbox.lease") return { obligations: [] };
      return connectionResponse();
    };
    await pi.emit("agent_settled", {}, ctx);
    expect(client.calls).toContainEqual([
      "inbox.ack",
      { ids: ["ob-1", "ob-2"], leaseToken: "lease-1", profileId: "driffs" },
    ]);
  });

  test("wake names the EXACT leased event even when the roster would list other workers", async () => {
    const { pi, ctx, client } = await profileHarness();
    client.response = (method) => {
      if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-1" } };
      if (method === "inbox.lease")
        return {
          obligations: [
            {
              agentEventId: 14691,
              id: "ob-1",
              outcome: {
                agent: "pi",
                createdAt: "2026-09-10T09:47:34.000Z",
                eventId: 14691,
                excerpt: { text: "FX audit complete — 5 findings.", truncated: false },
                from: "working",
                lastAssistantAt: "2026-09-10T09:47:33.000Z",
                lastAssistantRef: "0eb4f8f3",
                name: "fx-audit",
                paneId: "wP:p61",
                terminalId: "term_65b",
                to: "done",
                type: "agent.done",
              },
            },
          ],
        };
      // The OLD code fetched this roster and rendered every agent with no
      // cause — the wrong-worker attribution incident. It must never be read.
      if (method === "profile.context")
        return {
          agents: [
            { agent: "pi", compactHistory: {}, name: "fx-audit", paneId: "wP:p61" },
            { agent: "pi", compactHistory: {}, name: "mask-builder", paneId: "wP:p62" },
          ],
        };
      return { delivered: 1 };
    };
    await pi.command("on driffs", ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(client.calls.map(([method]) => method)).not.toContain("profile.context");
    const hidden = pi.hiddenMessages.find(
      ([message]) => message.customType === "shepy-wake-context",
    );
    expect(hidden?.[0].content).toContain("fx-audit");
    expect(hidden?.[0].content).toContain("wP:p61");
    expect(hidden?.[0].content).toContain("working→done");
    expect(hidden?.[0].content).toContain("event: 14691");
    expect(hidden?.[0].content).toContain("obligation: ob-1");
    // The immutable append-time assistant reference rides the wake so the
    // owner can correlate WITHOUT a fresh agent read.
    expect(hidden?.[0].content).toContain("0eb4f8f3");
    expect(hidden?.[0].content).toContain("FX audit complete — 5 findings.");
    expect(hidden?.[0].content).not.toContain("mask-builder");
    // Frozen correlation: a later lease change cannot rewrite the enqueued
    // evidence, and no drift re-read ever happens.
    const before = hidden?.[0].content;
    client.response = (method) => {
      if (method === "inbox.lease") return { obligations: [] };
      if (method === "profile.context")
        return {
          agents: [{ agent: "pi", compactHistory: {}, name: "fx-audit", paneId: "wP:p61" }],
        };
      return { delivered: 0 };
    };
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      pi.hiddenMessages.filter(([message]) => message.customType === "shepy-wake-context"),
    ).toHaveLength(1);
    expect(hidden?.[0].content).toBe(before);
  });

  test("a failed context enqueue nacks and never strands the batch; retry delivers once", async () => {
    const { pi, ctx, client } = await profileHarness();
    const obligations = [{ agentEventId: 1, id: "ob-1", outcome: null }];
    client.response = (method) => {
      if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-1" } };
      if (method === "inbox.lease") return { obligations };
      if (method === "inbox.nack") return { nacked: 1 };
      if (method === "inbox.delivered") return { delivered: 1 };
      return { acked: 1 };
    };
    const originalSend = pi.sendMessage.bind(pi);
    let failContext = true;
    pi.sendMessage = ((message: { display?: boolean }, options?: unknown) => {
      if (failContext && message.display === false) throw new Error("context enqueue failed");
      return originalSend(message, options);
    }) as typeof pi.sendMessage;
    await pi.command("on driffs", ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Nothing displayed, nothing marked delivered, durable nack.
    expect(client.calls).toContainEqual([
      "inbox.nack",
      expect.objectContaining({ errorCode: "wake_failed", ids: ["ob-1"], leaseToken: "lease-1" }),
    ]);
    expect(client.calls.map(([method]) => method)).not.toContain("inbox.delivered");
    expect(pi.customMessages).toHaveLength(0);
    // An unrelated user turn settles: it must NOT ack the never-displayed wake.
    await pi.emit("message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
    client.response = (method) => {
      if (method === "inbox.lease") return { obligations: [] };
      return { acked: 1 };
    };
    await pi.emit("agent_settled", {}, ctx);
    expect(client.calls.map(([method]) => method)).not.toContain("inbox.ack");
    // Repair the enqueue path: the next pump cycle delivers the one batch.
    failContext = false;
    client.response = (method) => {
      if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-1" } };
      if (method === "inbox.lease") return { obligations };
      if (method === "inbox.delivered") return { delivered: 1 };
      return { acked: 1 };
    };
    await pi.command("off", ctx);
    await pi.command("on driffs", ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      pi.customMessages.filter(([message]) => message.customType === "shepy-wake"),
    ).toHaveLength(1);
    expect(client.calls).toContainEqual([
      "inbox.delivered",
      expect.objectContaining({ ids: ["ob-1"] }),
    ]);
  });

  test("a failed TRIGGER enqueue nacks and a later user turn cannot ack it", async () => {
    const { pi, ctx, client } = await profileHarness();
    client.response = (method) => {
      if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-1" } };
      if (method === "inbox.lease")
        return { obligations: [{ agentEventId: 7, id: "ob-7", outcome: null }] };
      if (method === "inbox.nack") return { nacked: 1 };
      return { delivered: 1 };
    };
    const originalSend = pi.sendMessage.bind(pi);
    pi.sendMessage = ((message: { display?: boolean }, options?: unknown) => {
      if (message.display !== false) throw new Error("trigger enqueue failed");
      return originalSend(message, options);
    }) as typeof pi.sendMessage;
    await pi.command("on driffs", ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The hidden context may enqueue, but no wake turn ever triggers.
    expect(pi.customMessages).toHaveLength(0);
    expect(client.calls).toContainEqual([
      "inbox.nack",
      expect.objectContaining({ errorCode: "wake_failed", ids: ["ob-7"], leaseToken: "lease-1" }),
    ]);
    expect(client.calls.map(([method]) => method)).not.toContain("inbox.delivered");
    // Unrelated user turn finishes successfully — still no ack.
    await pi.emit("message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    expect(client.calls.map(([method]) => method)).not.toContain("inbox.ack");
  });

  test("delivered-RPC failure after a queued trigger keeps the batch ackable, no duplicate", async () => {
    const { pi, ctx, client } = await profileHarness();
    client.response = (method) => {
      if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-1" } };
      if (method === "inbox.lease")
        return { obligations: [{ agentEventId: 3, id: "ob-3", outcome: null }] };
      if (method === "inbox.delivered") throw new Error("daemon hiccup");
      if (method === "inbox.ack") return { acked: 1 };
      return { delivered: 1 };
    };
    await pi.command("on driffs", ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The wake DID display and trigger — exactly once.
    expect(
      pi.customMessages.filter(([message]) => message.customType === "shepy-wake"),
    ).toHaveLength(1);
    // delivered failed, but the displayed batch stays ackable at settle.
    await pi.emit("message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
    client.response = (method) => {
      if (method === "inbox.lease") return { obligations: [] };
      if (method === "inbox.ack") return { acked: 1 };
      throw new Error("unexpected call");
    };
    await pi.emit("agent_settled", {}, ctx);
    expect(client.calls).toContainEqual([
      "inbox.ack",
      { ids: ["ob-3"], leaseToken: "lease-1", profileId: "driffs" },
    ]);
    expect(
      pi.customMessages.filter(([message]) => message.customType === "shepy-wake"),
    ).toHaveLength(1);
  });

  test("older-daemon lease without outcome renders ids honestly and invents no pane", async () => {
    const { pi, ctx, client } = await profileHarness();
    // Older daemon: obligations carry agentEventId but no joined outcome.
    client.response = (method) => {
      if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-1" } };
      if (method === "inbox.lease")
        return { obligations: [{ agentEventId: 14698, id: "ob-14698" }] };
      return { delivered: 1 };
    };
    await pi.command("on driffs", ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const hidden = pi.hiddenMessages.find(
      ([message]) => message.customType === "shepy-wake-context",
    );
    expect(hidden?.[0].content).toContain("14698");
    expect(hidden?.[0].content).toContain("ob-14698");
    expect(hidden?.[0].content).toContain("snapshot unavailable");
    // No pane is known for a missing snapshot — none may be invented.
    expect(hidden?.[0].content).not.toMatch(/w[A-Z]:p\d+/);
  });

  test("a lease resolving after owner-off must not enqueue and must not be ackable", async () => {
    const { pi, ctx, client } = await profileHarness();
    let resolveLease: ((value: unknown) => void) | undefined;
    client.response = (method) => {
      if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-1" } };
      if (method === "inbox.lease")
        return new Promise((resolve) => {
          resolveLease = resolve;
        });
      if (method === "inbox.nack") return { nacked: 1 };
      return { delivered: 1 };
    };
    await pi.command("on driffs", ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The owner goes OFF while inbox.lease is still in flight.
    await pi.command("off", ctx);
    resolveLease?.({ obligations: [{ agentEventId: 5, id: "ob-5", outcome: null }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Stale lease: no enqueue into the now-off owner, durable cleanup.
    expect(pi.customMessages).toHaveLength(0);
    expect(pi.hiddenMessages).toHaveLength(0);
    expect(client.calls.map(([method]) => method)).not.toContain("inbox.delivered");
    expect(client.calls).toContainEqual([
      "inbox.nack",
      expect.objectContaining({ ids: ["ob-5"], leaseToken: "lease-1" }),
    ]);
    // A later user turn can never acknowledge an event it never saw.
    await pi.emit("message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    expect(client.calls.map(([method]) => method)).not.toContain("inbox.ack");
    // Re-claim delivers the batch exactly once.
    client.response = (method) => {
      if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-2" } };
      if (method === "inbox.lease")
        return { obligations: [{ agentEventId: 5, id: "ob-5", outcome: null }] };
      if (method === "inbox.delivered") return { delivered: 1 };
      return { acked: 1 };
    };
    await pi.command("on driffs", ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      pi.customMessages.filter(([message]) => message.customType === "shepy-wake"),
    ).toHaveLength(1);
  });

  test("overlapping pump ticks with the same lease token cannot double-lease", async () => {
    const { pi, ctx, client } = await profileHarness();
    let resolveLease: ((value: unknown) => void) | undefined;
    let leaseCalls = 0;
    client.response = (method) => {
      if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-1" } };
      if (method === "inbox.lease") {
        leaseCalls += 1;
        return new Promise((resolve) => {
          resolveLease = resolve;
        });
      }
      return { delivered: 1 };
    };
    await pi.command("on driffs", ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // A second pump tick begins while the first lease is in flight and the
    // mode is re-claimed with the SAME lease token.
    await pi.command("off", ctx);
    await pi.command("on driffs", ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(leaseCalls).toBe(1);
    resolveLease?.({ obligations: [{ agentEventId: 6, id: "ob-6", outcome: null }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Exactly one wake from the in-flight pump; no duplicated batch.
    expect(
      pi.customMessages.filter(([message]) => message.customType === "shepy-wake"),
    ).toHaveLength(1);
    expect(client.calls).toContainEqual([
      "inbox.delivered",
      expect.objectContaining({ ids: ["ob-6"], leaseToken: "lease-1" }),
    ]);
  });

  test("failed settle nacks — the obligations remain pending server-side", async () => {
    const { pi, ctx, client } = await profileHarness();
    client.response = (method) => {
      if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-1" } };
      if (method === "inbox.lease") return { obligations: [{ agentEventId: 7, id: "ob-7" }] };
      if (method === "profile.context") return { agents: [] };
      return { delivered: 1 };
    };
    await pi.command("on driffs", ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // assistant failed (error stop) → settle nacks
    await pi.emit("message_end", { message: { role: "assistant", stopReason: "error" } }, ctx);
    client.response = (method) => {
      if (method === "inbox.nack") return { nacked: 1 };
      if (method === "inbox.lease") return { obligations: [] };
      return connectionResponse();
    };
    await pi.emit("agent_settled", {}, ctx);
    expect(client.calls).toContainEqual([
      "inbox.nack",
      expect.objectContaining({ errorCode: "wake_failed", ids: ["ob-7"], leaseToken: "lease-1" }),
    ]);
  });

  test("a rejected claim (active lease elsewhere) never enters profile mode", async () => {
    const { pi, ctx, client } = await profileHarness();
    client.response = (method) => {
      if (method === "profile.claim")
        return { result: { kind: "rejected", reason: "lease_active" } };
      return connectionResponse();
    };
    await pi.command("on driffs", ctx);
    expect(ctx.notifications.at(-1)?.[1]).toBe("error");
    expect(client.calls.some(([method]) => method === "inbox.lease")).toBe(false);
  });

  test("session_shutdown releases the profile lease", async () => {
    const { pi, ctx, client } = await profileHarness();
    client.response = (method) => {
      if (method === "profile.claim") return { result: { kind: "claimed", leaseToken: "lease-1" } };
      if (method === "inbox.lease") return { obligations: [] };
      return connectionResponse();
    };
    await pi.command("on driffs", ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await pi.emit("session_shutdown", {}, ctx);
    expect(client.calls).toContainEqual([
      "profile.release",
      { leaseToken: "lease-1", profileId: "driffs" },
    ]);
  });

  async function profileHarness() {
    const client = createFakeClient();
    const pi = createFakePi();
    const { createShepyPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepyPiExtension({ clientFactory: () => client })(pi);
    const ctx = fakeCtx({ idle: true });
    const previous = withHerdrEnv({ paneId: "w12:p1", workspaceId: "w12" });
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
    } finally {
      restoreEnv(previous);
    }
    return { client, ctx, pi };
  }
});
