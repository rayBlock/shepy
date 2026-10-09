import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  daemonStatusPayload,
  formatCliError,
  helpText,
  parseCliArgs,
  runCliCommand,
  shouldRunCliMain,
  versionText,
} from "@/cli/shepy.js";

type FakeClient = {
  calls: unknown[];
  close(): void;
  request(method: string, params: unknown): Promise<unknown>;
};

function contextHealthClient(history: Record<string, unknown>): FakeClient {
  return {
    calls: [],
    close: () => undefined,
    async request(method) {
      if (method === "agent.get") {
        return {
          agent: {
            agent: "pi",
            agentStatus: "working",
            herdrSessionName: "default",
            history,
            name: "worker",
            paneId: "wB:p1",
            terminalId: "term_1",
            workspaceId: "wB",
          },
        };
      }
      return {};
    },
  };
}

const baseHistory = {
  lastAssistantMessage: null,
  lastToolResult: null,
  lastUserMessage: null,
  messageCount: 3,
  source: "pi-jsonl",
  updatedAt: "2026-09-13T10:03:00.000Z",
};

describe("shepy CLI", () => {
  test("parses agent list with current Herdr workspace", () => {
    expect(parseCliArgs(["agent", "list"], { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "wB" })).toEqual({
      command: "agent-list",
      json: false,
      workspaceId: "wB",
    });
  });

  test("parses explicit agent scopes", () => {
    expect(parseCliArgs(["agent", "list", "--all", "--json"])).toEqual({
      all: true,
      command: "agent-list",
      json: true,
    });
    expect(parseCliArgs(["agent", "list", "--workspace", "wB", "--session", "default"])).toEqual({
      command: "agent-list",
      herdrSessionName: "default",
      json: false,
      workspaceId: "wB",
    });
    expect(parseCliArgs(["agent", "list", "--session", "default"])).toEqual({
      command: "agent-list",
      herdrSessionName: "default",
      json: false,
    });
  });

  test("parses agent get and read", () => {
    expect(
      parseCliArgs(["agent", "get", "claude", "--json"], {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "wB",
      }),
    ).toEqual({ command: "agent-get", json: true, target: "claude", workspaceId: "wB" });
    expect(parseCliArgs(["agent", "get", "claude", "--session", "default", "--json"])).toEqual({
      command: "agent-get",
      herdrSessionName: "default",
      json: true,
      target: "claude",
    });
    expect(
      parseCliArgs(["agent", "read", "wB:p2", "--limit", "20", "--json"], {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "wB",
      }),
    ).toEqual({ command: "agent-read", json: true, limit: 20, target: "wB:p2", workspaceId: "wB" });
    expect(() => parseCliArgs(["agent", "read", "wB:p2", "--limit", "0"])).toThrow(
      "--limit must be between 1 and 500",
    );
  });

  test("rejects unknown commands", () => {
    expect(() => parseCliArgs(["legacy-command"])).toThrow("Unknown command");
  });

  test("parses dispatch and wait commands", () => {
    expect(parseCliArgs(["dispatch", "driffs", "run the tests"])).toEqual({
      command: "operation-dispatch",
      json: false,
      profileId: "driffs",
      prompt: "run the tests",
    });
    expect(parseCliArgs(["dispatch", "driffs", "--prompt-file", "/tmp/p.md", "--json"])).toEqual({
      command: "operation-dispatch",
      json: true,
      profileId: "driffs",
      prompt: "file:/tmp/p.md",
    });
    expect(() => parseCliArgs(["dispatch", "driffs"])).toThrow("requires a prompt");
    expect(() => parseCliArgs(["dispatch"])).toThrow("requires <profileId>");

    expect(parseCliArgs(["wait", "op_123"])).toEqual({
      command: "operation-wait",
      json: false,
      operationId: "op_123",
    });
    expect(parseCliArgs(["wait", "op_123", "--timeout", "30000", "--json"])).toEqual({
      command: "operation-wait",
      json: true,
      operationId: "op_123",
      timeoutMs: 30000,
    });
    expect(() => parseCliArgs(["wait", "op_1", "--timeout", "0"])).toThrow(
      "--timeout must be between",
    );
    expect(() => parseCliArgs(["wait"])).toThrow("requires <operationId>");
  });

  test("parses contextual help for dispatch and wait", () => {
    expect(parseCliArgs(["dispatch", "--help"])).toEqual({ command: "help", topic: "dispatch" });
    expect(parseCliArgs(["wait", "-h"])).toEqual({ command: "help", topic: "wait" });
  });

  test("operation subcommands: get and list", () => {
    expect(parseCliArgs(["operation", "get", "op_1", "--json"])).toEqual({
      command: "operation-get",
      json: true,
      operationId: "op_1",
    });
    expect(parseCliArgs(["operation", "list", "driffs"])).toEqual({
      command: "operation-list",
      json: false,
      profileId: "driffs",
    });
    expect(parseCliArgs(["operation", "--help"])).toEqual({ command: "help", topic: "operation" });
    expect(() => parseCliArgs(["operation", "frobnicate"])).toThrow("Unknown operation command");
  });

  test("parses profile owner", () => {
    expect(parseCliArgs(["profile", "owner", "battle"])).toEqual({
      command: "profile-owner",
      json: false,
      profileId: "battle",
    });
    expect(parseCliArgs(["profile", "owner", "battle", "--json"])).toEqual({
      command: "profile-owner",
      json: true,
      profileId: "battle",
    });
    expect(parseCliArgs(["profile", "owner", "--help"])).toEqual({
      command: "help",
      topic: "profile-owner",
    });
    expect(() => parseCliArgs(["profile", "owner"])).toThrow("profile owner requires <profileId>");
  });

  test("help documents the profile owner verb", () => {
    expect(helpText("profile")).toContain("owner <profileId>");
    expect(helpText("profile-owner")).toContain("shepy profile owner <profileId>");
    expect(helpText("profile-owner")).toContain("--json");
  });

  test("renders profile owner for humans and never prints lease secrets", async () => {
    const now = Date.now();
    const owner = {
      claimedAt: now - 60_000,
      harnessKind: "pi",
      harnessSessionRefJson: '{"sessionRef":"secret-ref"}',
      herdrSessionName: "default",
      lastSeenAt: now - 5_000,
      leaseExpiresAt: now + 300_000,
      leaseToken: "secret-lease-token",
      paneId: "w31:p2",
      profileId: "battle",
      subscriberId: "secret-subscriber",
      terminalId: "t31",
      workspaceId: "w31",
    };
    const output: string[] = [];
    await runCliCommand(
      { command: "profile-owner", json: false, profileId: "battle" },
      {
        connect: async () => ({ close: () => {}, request: async () => ({ owner }) }),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    const text = output.join("\n");
    expect(text).toContain("profile: battle");
    expect(text).toContain("owner: w31:p2 (pi)");
    expect(text).toContain("workspace: w31");
    expect(text).toContain("session: default");
    expect(text).toContain("terminal: t31");
    expect(text).toMatch(/lease valid for \d+m\d+s/);
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(text).not.toContain("secret-lease-token");
    expect(text).not.toContain("secret-subscriber");
    expect(text).not.toContain("secret-ref");
  });

  test("renders a lapsed owner as claimable", async () => {
    const now = Date.now();
    const owner = {
      claimedAt: now - 26 * 3_600_000,
      harnessKind: "claude",
      harnessSessionRefJson: "{}",
      herdrSessionName: "default",
      lastSeenAt: now - 20 * 3_600_000,
      leaseExpiresAt: now - 2 * 3_600_000,
      leaseToken: "secret-lease-token",
      paneId: "w31:p3",
      profileId: "battle",
      subscriberId: "secret-subscriber",
      terminalId: "t31",
      workspaceId: "w31",
    };
    const output: string[] = [];
    await runCliCommand(
      { command: "profile-owner", json: false, profileId: "battle" },
      {
        connect: async () => ({ close: () => {}, request: async () => ({ owner }) }),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    const text = output.join("\n");
    expect(text).toContain("owner: w31:p3 (claude)");
    expect(text).toMatch(/lease lapsed 2h\d+m ago/);
    expect(text).toContain("claimable");
    expect(text).not.toContain("secret-lease-token");
  });

  test("renders a neutral owner without inventing host identifiers", async () => {
    const owner = {
      claimedAt: 1,
      harnessKind: "codex",
      harnessSessionRefJson: "{}",
      herdrSessionName: null,
      lastSeenAt: 2,
      leaseExpiresAt: Date.now() + 60_000,
      leaseToken: "secret-lease-token",
      paneId: null,
      profileId: "battle",
      subscriberId: "secret-subscriber",
      terminalId: null,
      workspaceId: null,
    };
    const output: string[] = [];
    await runCliCommand(
      { command: "profile-owner", json: false, profileId: "battle" },
      {
        connect: async () => ({ close: () => {}, request: async () => ({ owner }) }),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    const text = output.join("\n");
    expect(text).toContain("(no host location)");
    expect(text).not.toContain("secret-lease-token");
  });

  test("says an unowned profile is claimable", async () => {
    const output: string[] = [];
    await runCliCommand(
      { command: "profile-owner", json: false, profileId: "battle" },
      {
        connect: async () => ({ close: () => {}, request: async () => ({ owner: null }) }),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(output.join("\n")).toContain("battle has no owner");
    expect(output.join("\n")).toContain("claimable");
  });

  test("prints json output verbatim", async () => {
    const owner = {
      claimedAt: 1,
      harnessKind: "pi",
      harnessSessionRefJson: "{}",
      herdrSessionName: "default",
      lastSeenAt: 2,
      leaseExpiresAt: 3,
      leaseToken: "secret-lease-token",
      paneId: "w31:p2",
      profileId: "battle",
      subscriberId: "secret-subscriber",
      terminalId: "t31",
      workspaceId: "w31",
    };
    const output: string[] = [];
    await runCliCommand(
      { command: "profile-owner", json: true, profileId: "battle" },
      {
        connect: async () => ({ close: () => {}, request: async () => ({ owner }) }),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(JSON.parse(output[0] ?? "")).toEqual({
      owner: expect.objectContaining({ paneId: "w31:p2" }),
    });
  });

  test("parses root help and version flags", () => {
    expect(parseCliArgs([])).toEqual({ command: "help", topic: "root" });
    expect(parseCliArgs(["--help"])).toEqual({ command: "help", topic: "root" });
    expect(parseCliArgs(["-h"])).toEqual({ command: "help", topic: "root" });
    expect(parseCliArgs(["--version"])).toEqual({ command: "version" });
    expect(parseCliArgs(["-v"])).toEqual({ command: "version" });
  });

  test.each([
    { args: ["agent", "--help"], topic: "agent" },
    { args: ["agent", "list", "--help"], topic: "agent-list" },
    { args: ["agent", "get", "-h"], topic: "agent-get" },
    { args: ["agent", "read", "--help"], topic: "agent-read" },
    { args: ["daemon", "--help"], topic: "daemon" },
    { args: ["daemon", "start", "--help"], topic: "daemon-start" },
    { args: ["daemon", "stop", "-h"], topic: "daemon-stop" },
    { args: ["daemon", "restart", "--help"], topic: "daemon-restart" },
    { args: ["daemon", "status", "--help"], topic: "daemon-status" },
    { args: ["profile", "--help"], topic: "profile" },
    { args: ["profile", "context", "--help"], topic: "profile-context" },
    { args: ["profile", "subscribe", "--help"], topic: "profile-subscribe" },
    { args: ["inbox", "--help"], topic: "inbox" },
    { args: ["inbox", "get", "--help"], topic: "inbox-get" },
    { args: ["inbox", "list", "--help"], topic: "inbox-list" },
    { args: ["inbox", "retry", "-h"], topic: "inbox-retry" },
  ])("parses contextual help for $args", ({ args, topic }) => {
    expect(parseCliArgs(args)).toEqual({ command: "help", topic });
  });

  test("help flags take precedence over trailing arguments", () => {
    expect(parseCliArgs(["--help", "unexpected"])).toEqual({ command: "help", topic: "root" });
    expect(parseCliArgs(["agent", "list", "--help", "unexpected"])).toEqual({
      command: "help",
      topic: "agent-list",
    });
    expect(parseCliArgs(["daemon", "start", "--help", "unexpected"])).toEqual({
      command: "help",
      topic: "daemon-start",
    });
  });

  test("renders root and contextual help", () => {
    expect(helpText()).toContain("Shepy observes coding agents managed by Herdr.");
    expect(helpText()).toContain("shepy agent --help");
    expect(helpText()).toContain("shepy profile --help");
    expect(helpText()).toContain("-v, --version");
    expect(helpText("agent")).toContain("list            List indexed agents");
    expect(helpText("agent-list")).toContain("--all");
    expect(helpText("agent-get")).toContain("shepy agent get <target>");
    expect(helpText("agent-read")).toContain("--limit <number>");
    expect(helpText("daemon")).toContain("start       Start the daemon");
    expect(helpText("daemon-start")).toContain("shepy daemon start");
    expect(helpText("profile")).toContain("subscribe <profileId>");
    expect(helpText("profile-subscribe")).toContain("--kind-cwd <kind>=<cwd>");
    expect(helpText("inbox")).toContain("retry <obligationId>");
    expect(helpText("inbox")).toContain("get <obligationId>");
    expect(helpText("inbox-get")).toContain("shepy inbox get <obligationId>");
    expect(helpText("inbox-list")).toContain("--state");
    expect(helpText("inbox-list")).toContain("--before <agentEventId>");
    expect(helpText("inbox-list")).toContain("--limit <number>");
  });

  test("renders the package version", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(versionText()).toBe(`shepy ${manifest.version}`);
  });

  test("parses inbox get with its obligation id and --json", () => {
    expect(parseCliArgs(["inbox", "get", "abc-123"])).toEqual({
      command: "inbox-get",
      id: "abc-123",
      json: false,
    });
    expect(parseCliArgs(["inbox", "get", "--json", "abc-123"])).toEqual({
      command: "inbox-get",
      id: "abc-123",
      json: true,
    });
  });

  test("parses inbox list --before and --limit", () => {
    expect(parseCliArgs(["inbox", "list", "driffs", "--before", "82", "--limit", "5"])).toEqual({
      before: 82,
      command: "inbox-list",
      json: false,
      limit: 5,
      profileId: "driffs",
    });
    expect(() => parseCliArgs(["inbox", "list", "driffs", "--before", "nope"])).toThrow(
      "--before must be a non-negative integer",
    );
    expect(() => parseCliArgs(["inbox", "list", "driffs", "--limit", "0"])).toThrow(
      "--limit must be between 1 and 500",
    );
  });

  test("inbox get renders the full excerpt and says when the obligation is gone", async () => {
    const calls: unknown[] = [];
    const client: FakeClient = {
      calls,
      close: () => {},
      request: async (method, params) => {
        calls.push([method, params]);
        return {
          obligation: {
            agentEventId: 82,
            attemptCount: 1,
            id: "abc-123",
            lastErrorCode: "deferred_over_budget",
            outcome: {
              excerpt: { text: "full excerpt line one\nline two", truncated: false },
            },
            state: "pending",
          },
        };
      },
    };
    const output: string[] = [];
    await runCliCommand(
      { command: "inbox-get", id: "abc-123", json: false },
      {
        connect: async () => client,
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    const text = output.join("\n");
    expect(text).toContain("id: abc-123");
    expect(text).toContain("state: pending");
    expect(text).toContain("last_error: deferred_over_budget");
    // The read-back exists because the stub omitted the excerpt: it must be
    // shown in full, both lines, never truncated.
    expect(text).toContain("full excerpt line one\nline two");
    expect(calls).toEqual([["inbox.get", { obligationId: "abc-123" }]]);

    const missing: string[] = [];
    await runCliCommand(
      { command: "inbox-get", id: "gone", json: false },
      {
        connect: async () => ({
          close: () => {},
          request: async () => ({ obligation: null }),
        }),
        output: (line) => missing.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(missing.join("\n")).toContain("Obligation not found.");
  });

  test("inbox get tolerates a partial obligation without inventing a known count", async () => {
    const output: string[] = [];
    await runCliCommand(
      { command: "inbox-get", id: "partial", json: false },
      {
        connect: async () => ({
          close: () => {},
          request: async () => ({
            obligation: {
              id: "partial",
              state: "pending",
              outcome: { excerpt: { truncated: false } },
            },
          }),
        }),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(output.join("\n")).toContain("attempts: 0 (UNKNOWN: attemptCount missing)");
    expect(output.join("\n")).toContain("(no assistant message)");
  });

  test("inbox get strips control bytes from the excerpt before the terminal sees it", async () => {
    // The human formatter writes to the operator's terminal; a hostile or
    // stale snapshot must not be able to put a raw escape there. (--json is
    // untouched: JSON.stringify escapes control characters by spec.)
    const client: FakeClient = {
      calls: [],
      close: () => {},
      request: async () => ({
        obligation: {
          agentEventId: 82,
          attemptCount: 1,
          id: "abc-123",
          lastErrorCode: null,
          outcome: {
            excerpt: { text: "before\u001b]0;pwned\u0007after", truncated: false },
          },
          state: "pending",
        },
      }),
    };
    const output: string[] = [];
    await runCliCommand(
      { command: "inbox-get", id: "abc-123", json: false },
      {
        connect: async () => client,
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    const text = output.join("\n");
    expect(text).toContain("before");
    expect(text).toContain("after");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the assertion is exactly that no C0/C1 byte survives.
    expect(text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
    // The guard strips bytes, not prose: the printable payload around them stays.
    expect(text).toContain("]0;pwned");
  });

  test("adds contextual help hints only to usage errors", () => {
    expect(formatCliError(captureError(() => parseCliArgs(["unknown"])))).toBe(
      "Unknown command: unknown\nRun `shepy --help` for usage.",
    );
    expect(formatCliError(captureError(() => parseCliArgs(["agent", "unknown"])))).toBe(
      "Unknown agent command: unknown\nRun `shepy agent --help` for usage.",
    );
    expect(formatCliError(captureError(() => parseCliArgs(["agent", "read"])))).toBe(
      "agent read requires <target>\nRun `shepy agent read --help` for usage.",
    );
    expect(formatCliError(captureError(() => parseCliArgs(["daemon", "unknown"])))).toBe(
      "Unknown daemon action: unknown\nRun `shepy daemon --help` for usage.",
    );
    expect(formatCliError(captureError(() => parseCliArgs(["profile", "unknown"])))).toBe(
      "Unknown profile command: unknown\nRun `shepy profile --help` for usage.",
    );
    expect(formatCliError(captureError(() => parseCliArgs(["inbox", "unknown"])))).toBe(
      "Unknown inbox command: unknown\nRun `shepy inbox --help` for usage.",
    );
    expect(formatCliError(captureError(() => parseCliArgs(["inbox", "get"])))).toBe(
      "inbox get requires <obligationId>\nRun `shepy inbox get --help` for usage.",
    );
    expect(formatCliError(new Error("request failed"))).toBe("request failed");
  });

  test("prints help and version without connecting to the daemon", async () => {
    const output: string[] = [];
    const deps = {
      connect: async () => {
        throw new Error("should not connect");
      },
      output: (line: string) => output.push(line),
      socketPath: "/tmp/s.sock",
    };

    await runCliCommand({ command: "help", topic: "agent" }, deps);
    await runCliCommand({ command: "version" }, deps);

    expect(output).toEqual([helpText("agent"), versionText()]);
  });

  test("runs main when the package bin symlink points at the CLI module", () => {
    expect(
      shouldRunCliMain({
        argvPath: "/tmp/prefix/bin/shepy",
        modulePath: "/tmp/prefix/lib/node_modules/shepy/dist/src/cli/shepy.js",
        realArgvPath: "/tmp/prefix/lib/node_modules/shepy/dist/src/cli/shepy.js",
      }),
    ).toBe(true);
  });

  test("dispatches agent JSON commands", async () => {
    const client = createFakeClient();
    const output: string[] = [];
    await runCliCommand(
      { command: "agent-read", json: true, limit: 10, target: "claude", workspaceId: "wB" },
      {
        connect: async () => client,
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(client.calls).toEqual([
      ["agent.read", { limit: 10, target: "claude", workspaceId: "wB" }],
      ["close"],
    ]);
    expect(JSON.parse(output[0] ?? "")).toMatchObject({
      agent: { agent: "codex", messages: [], name: "reviewer" },
    });
  });

  test("renders human agent list", async () => {
    const client = createFakeClient();
    const output: string[] = [];
    await runCliCommand(
      { command: "agent-list", json: false, workspaceId: "wB" },
      {
        connect: async () => client,
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(output[0]).toContain("status\tname\tagent\tpane\tlast user\tlast assistant\tupdated");
    expect(output[0]).toContain("idle\treviewer\tcodex\twB:p1\tfix bug\tdone");
    expect(output[0]).toContain("idle\t\tcodex\twB:p2");
  });

  test("renders the context block for a last_reported reading", async () => {
    const output: string[] = [];
    await runCliCommand(
      { command: "agent-get", json: false, target: "pi", workspaceId: "wB" },
      {
        connect: async () =>
          contextHealthClient({
            ...baseHistory,
            contextHealth: {
              branch: null,
              compactionCount: 1,
              lastCompaction: {
                durationMs: null,
                ref: "/tmp/pi.jsonl#entry=c1",
                timestamp: "2026-09-13T10:04:00.000Z",
                tokensAfter: null,
                tokensBefore: 311646,
                trigger: "unknown",
              },
              limitations: [
                "compaction_outcome_not_recorded",
                "context_window_not_recorded",
                "leaf_move_not_recorded_until_next_append",
              ],
              model: { changedAt: null, id: "gpt-6-astra", provider: "openai-codex" },
              sessionId: "pi-session-1",
              source: "pi-jsonl",
              sourceUpdatedAt: "2026-09-13T10:04:00.000Z",
              usage: {
                current: true,
                kind: "last_reported",
                percent: null,
                reason: null,
                ref: "/tmp/pi.jsonl#entry=m3",
                reportedAt: "2026-09-13T10:03:00.000Z",
                tokens: 4440,
                window: null,
              },
            },
          }),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    const text = output[0] ?? "";
    expect(text).toContain("context:");
    expect(text).toContain("  session: pi-session-1");
    expect(text).toContain("  model: gpt-6-astra (openai-codex)");
    expect(text).toContain("  usage: last_reported 4 440 tokens at 2026-09-13T10:03:00.000Z");
    expect(text).toContain(
      "  last compaction: unknown trigger, 311 646 tokens before, at 2026-09-13T10:04:00.000Z",
    );
    expect(text).toContain("  compactions: 1");
    expect(text).toContain(
      "  limitations: compaction_outcome_not_recorded, context_window_not_recorded",
    );
  });

  test("renders an unavailable reading", async () => {
    const output: string[] = [];
    await runCliCommand(
      { command: "agent-get", json: false, target: "pi", workspaceId: "wB" },
      {
        connect: async () =>
          contextHealthClient({
            ...baseHistory,
            contextHealth: {
              branch: null,
              compactionCount: 0,
              lastCompaction: null,
              limitations: ["context_window_not_recorded"],
              model: null,
              sessionId: null,
              source: "pi-jsonl",
              sourceUpdatedAt: null,
              usage: {
                current: true,
                kind: "unavailable",
                percent: null,
                reason: "no_usage_recorded",
                ref: null,
                reportedAt: null,
                tokens: null,
                window: null,
              },
            },
          }),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    const text = output[0] ?? "";
    expect(text).toContain("  usage: unavailable (no_usage_recorded)");
    expect(text).toContain("  model: unknown");
    expect(text).toContain("  last compaction: none");
  });

  test("renders a stale reading and a manual boundary", async () => {
    const output: string[] = [];
    await runCliCommand(
      { command: "agent-get", json: false, target: "claude", workspaceId: "wB" },
      {
        connect: async () =>
          contextHealthClient({
            ...baseHistory,
            contextHealth: {
              branch: "feature",
              compactionCount: 1,
              lastCompaction: {
                durationMs: 106150,
                ref: "/tmp/claude.jsonl#entry=b1",
                timestamp: "2026-09-13T11:04:00.000Z",
                tokensAfter: 18079,
                tokensBefore: 505689,
                trigger: "manual",
              },
              limitations: ["claude_lineage_by_file_order", "context_window_not_recorded"],
              model: {
                changedAt: "2026-09-13T11:02:00.000Z",
                id: "claude-fable-5-1",
                provider: null,
              },
              sessionId: "s1",
              source: "claude-jsonl",
              sourceUpdatedAt: "2026-09-13T11:04:00.000Z",
              usage: {
                current: false,
                kind: "last_reported",
                percent: null,
                reason: "branch_changed_since_reading",
                ref: "/tmp/claude.jsonl#entry=a3",
                reportedAt: "2026-09-13T11:03:00.000Z",
                tokens: 400000,
                window: null,
              },
            },
          }),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    const text = output[0] ?? "";
    expect(text).toContain(
      "  usage: last_reported 400 000 tokens at 2026-09-13T11:03:00.000Z (stale: branch_changed_since_reading)",
    );
    expect(text).toContain(
      "  last compaction: manual 505 689 → 18 079 tokens at 2026-09-13T11:04:00.000Z",
    );
    expect(text).toContain("  model: claude-fable-5-1 changed at 2026-09-13T11:02:00.000Z");
  });

  test("a hostile model id renders on one line without control bytes", async () => {
    const output: string[] = [];
    const hostile = "gpt\n\u001b[31m-evil\r\u0007";
    await runCliCommand(
      { command: "agent-get", json: false, target: "pi", workspaceId: "wB" },
      {
        connect: async () =>
          contextHealthClient({
            ...baseHistory,
            contextHealth: {
              branch: null,
              compactionCount: 0,
              lastCompaction: null,
              limitations: [],
              model: { changedAt: null, id: hostile, provider: null },
              sessionId: null,
              source: "pi-jsonl",
              sourceUpdatedAt: null,
              usage: {
                current: true,
                kind: "unavailable",
                percent: null,
                reason: "no_usage_recorded",
                ref: null,
                reportedAt: null,
                tokens: null,
                window: null,
              },
            },
          }),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    const text = output[0] ?? "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-byte assertion — the renderer must strip all of these.
    expect(text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
    const contextLines = text.split("\n").filter((line) => line.startsWith("  model:"));
    expect(contextLines).toHaveLength(1);
    expect(contextLines[0]).toContain("gpt [31m-evil");
  });

  test("a hostile usage reason renders on one line without control bytes (S3)", async () => {
    const output: string[] = [];
    const hostile = "no_usage\n\u001b[31m-recorded\r";
    await runCliCommand(
      { command: "agent-get", json: false, target: "pi", workspaceId: "wB" },
      {
        connect: async () =>
          contextHealthClient({
            ...baseHistory,
            contextHealth: {
              branch: null,
              compactionCount: 0,
              lastCompaction: null,
              limitations: [],
              model: null,
              sessionId: null,
              source: "pi-jsonl",
              sourceUpdatedAt: null,
              usage: {
                current: false,
                kind: "unavailable",
                percent: null,
                reason: hostile,
                ref: null,
                reportedAt: null,
                tokens: null,
                window: null,
              },
            },
          }),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    const text = output[0] ?? "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-byte assertion — the renderer must strip all of these.
    expect(text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
    const usageLines = text.split("\n").filter((line) => line.includes("usage: unavailable"));
    expect(usageLines).toHaveLength(1);
    expect(usageLines[0]).toContain("[31m-recorded");
  });

  test("--json passes the agent object through untouched", async () => {
    const output: string[] = [];
    const history = {
      ...baseHistory,
      contextHealth: {
        branch: null,
        compactionCount: 0,
        lastCompaction: null,
        limitations: ["context_window_not_recorded"],
        model: null,
        sessionId: null,
        source: "pi-jsonl" as const,
        sourceUpdatedAt: null,
        usage: {
          current: true,
          kind: "unavailable" as const,
          percent: null,
          reason: "no_usage_recorded",
          ref: null,
          reportedAt: null,
          tokens: null,
          window: null,
        },
      },
    };
    await runCliCommand(
      { command: "agent-get", json: true, target: "pi", workspaceId: "wB" },
      {
        connect: async () => contextHealthClient(history),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(JSON.parse(output[0] ?? "")).toEqual({
      agent: {
        agent: "pi",
        agentStatus: "working",
        herdrSessionName: "default",
        history,
        name: "worker",
        paneId: "wB:p1",
        terminalId: "term_1",
        workspaceId: "wB",
      },
    });
  });

  test("renders separate live name and agent kind in human get and read output", async () => {
    const client = createFakeClient();
    const getOutput: string[] = [];
    await runCliCommand(
      { command: "agent-get", json: false, target: "reviewer", workspaceId: "wB" },
      {
        connect: async () => client,
        output: (line) => getOutput.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(getOutput[0]).toContain("name: reviewer\nagent: codex");

    const readOutput: string[] = [];
    await runCliCommand(
      { command: "agent-read", json: false, target: "reviewer", workspaceId: "wB" },
      {
        connect: async () => client,
        output: (line) => readOutput.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(readOutput[0]).toContain("name: reviewer\nagent: codex\npane: wB:p1");

    const unnamedOutput: string[] = [];
    const unnamed = createFakeClient({ name: null });
    await runCliCommand(
      { command: "agent-get", json: false, target: "codex", workspaceId: "wB" },
      {
        connect: async () => unnamed,
        output: (line) => unnamedOutput.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(unnamedOutput[0]).toContain("name: unnamed\nagent: codex");
  });

  test("parses profile diagnose", () => {
    expect(parseCliArgs(["profile", "diagnose", "driffs"])).toEqual({
      command: "profile-diagnose",
      json: false,
      profileId: "driffs",
    });
    expect(parseCliArgs(["profile", "diagnose", "driffs", "--json"])).toEqual({
      command: "profile-diagnose",
      json: true,
      profileId: "driffs",
    });
    expect(parseCliArgs(["profile", "diagnose", "--help"])).toEqual({
      command: "help",
      topic: "profile-diagnose",
    });
    expect(() => parseCliArgs(["profile", "diagnose"])).toThrow(
      "profile diagnose requires <profileId>",
    );
  });

  test("help documents the profile diagnose verb", () => {
    expect(helpText("profile")).toContain("diagnose <profileId>");
    expect(helpText("profile-diagnose")).toContain("shepy profile diagnose <profileId>");
    expect(helpText("profile-diagnose")).toContain("--json");
  });

  test("renders profile diagnose for humans with findings first", async () => {
    const report = {
      daemon: {
        bootId: "boot-1",
        bootedAt: "2026-09-13T00:00:00.000Z",
        buildStamp: "2026-09-12T00:00:00.000Z",
        pid: 4321,
        version: "0.5.0",
      },
      findings: [
        {
          code: "no_owner",
          hint: "run /shepy on driffs in the owner pane, or claim from the Claude hook",
          message: "no owner is claimed for this profile; 1 outcome is waiting",
          severity: "blocker",
        },
        {
          code: "dead_letters_present",
          hint: "shepy inbox list driffs --state dead_letter",
          message: "2 outcomes are dead-lettered",
          severity: "warning",
        },
      ],
      owner: null,
      profile: { displayName: "Driffs", profileId: "driffs", projectRoots: ["/tmp/driffs"] },
      queue: {
        counts: { acked: 0, dead_letter: 2, delivered: 0, leased: 0, pending: 1 },
        lastAckedAt: null,
        lastDeliveredAt: null,
        maxPendingAttempts: 0,
        newestUnacked: {
          attemptCount: 0,
          id: "ob-1",
          lastErrorCode: null,
          lastErrorSummary: null,
          state: "pending",
        },
        oldestPendingAgeMs: 60_000,
        strandedLeases: 0,
      },
      subscriptions: [
        {
          enabled: true,
          id: 3,
          resolution: {
            agent: {
              agent: "hermes",
              agentSession: null,
              agentStatus: "working",
              name: "driffs-worker",
              paneId: "wA:p1",
            },
            kind: "matched",
          },
          selector: { kind: "name", value: "driffs-worker" },
        },
      ],
    };
    const output: string[] = [];
    await runCliCommand(
      { command: "profile-diagnose", json: false, profileId: "driffs" },
      {
        connect: async () => ({ close: () => {}, request: async () => report }),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    const text = output.join("\n");
    const blocker = text.indexOf("BLOCKER no_owner");
    const warning = text.indexOf("WARNING dead_letters_present");
    const daemonSection = text.indexOf("daemon:");
    expect(blocker).toBeGreaterThanOrEqual(0);
    expect(warning).toBeGreaterThan(blocker);
    expect(daemonSection).toBeGreaterThan(warning);
    expect(text).toContain("hint:");
    expect(text).toContain("owner:");
    expect(text).toContain("subscriptions:");
    expect(text).toContain("queue:");
  });

  test("profile diagnose renders each finding on one line so a hostile id cannot forge a finding", async () => {
    // A profileId can carry \n (stripControlChars keeps it): rendered raw it
    // would let an id like `driffs\nBLOCKER no_owner: fake` print its own
    // finding line, twice (message + hint). (--json is escaped by spec.)
    const report = {
      daemon: null,
      findings: [
        {
          code: "profile_not_found",
          hint: "create it with `shepy profile ensure driffs\nBLOCKER no_owner: fake`",
          message: "no such profile: driffs\nBLOCKER no_owner: fake",
          severity: "blocker",
        },
      ],
      owner: null,
      profile: null,
      queue: {
        counts: { acked: 0, dead_letter: 0, delivered: 0, leased: 0, pending: 0 },
        lastAckedAt: null,
        lastDeliveredAt: null,
        maxPendingAttempts: 0,
        newestUnacked: null,
        oldestPendingAgeMs: null,
        strandedLeases: 0,
      },
      subscriptions: [],
    };
    const output: string[] = [];
    await runCliCommand(
      { command: "profile-diagnose", json: false, profileId: "driffs" },
      {
        connect: async () => ({ close: () => {}, request: async () => report }),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    const lines = output.join("\n").split("\n");
    // Both surviving occurrences are the renderer's own lines — the finding
    // and its hint — with the injection collapsed inside each; the injected
    // text never starts a line of its own.
    const blockerLines = lines.filter((line) => line.includes("BLOCKER"));
    expect(blockerLines).toHaveLength(2);
    expect(blockerLines[0]?.startsWith("BLOCKER profile_not_found:")).toBe(true);
    expect(blockerLines[1]?.startsWith("  hint:")).toBe(true);
    for (const line of lines) {
      expect(line.startsWith("BLOCKER no_owner: fake")).toBe(false);
    }
  });

  test("profile diagnose --json prints the full report verbatim", async () => {
    const report = {
      daemon: null,
      findings: [{ code: "profile_not_found", hint: "h", message: "m", severity: "blocker" }],
      owner: null,
      profile: null,
      queue: {
        counts: { acked: 0, dead_letter: 0, delivered: 0, leased: 0, pending: 0 },
        lastAckedAt: null,
        lastDeliveredAt: null,
        maxPendingAttempts: 0,
        newestUnacked: null,
        oldestPendingAgeMs: null,
        strandedLeases: 0,
      },
      subscriptions: [],
    };
    const output: string[] = [];
    await runCliCommand(
      { command: "profile-diagnose", json: true, profileId: "ghost" },
      {
        connect: async () => ({ close: () => {}, request: async () => report }),
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(JSON.parse(output[0] ?? "{}")).toEqual(report);
  });

  test("daemon status payload renders identity fields next to the pid/socket fields", () => {
    const payload = JSON.parse(
      daemonStatusPayload(
        {
          pid: 123,
          pidPath: "/tmp/pid",
          socketPath: "/tmp/s.sock",
          socketReachable: true,
          state: "running",
        },
        {
          bootId: "boot-1",
          bootedAt: "2026-09-13T00:00:00.000Z",
          buildStamp: "2026-09-12T00:00:00.000Z",
          pid: 123,
          version: "0.5.0",
        },
        { buildStamp: "2026-09-12T00:00:00.000Z", version: "0.5.0" },
      ),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      cli: { buildStamp: "2026-09-12T00:00:00.000Z", version: "0.5.0" },
      daemon: { bootId: "boot-1", pid: 123, version: "0.5.0" },
      pid: 123,
      socketPath: "/tmp/s.sock",
      state: "running",
    });
  });

  test("daemon status payload keeps the CLI stamps even when the socket is dead", () => {
    const payload = JSON.parse(
      daemonStatusPayload(
        { pidPath: "/tmp/pid", socketPath: "/tmp/s.sock", state: "stopped" },
        null,
        { buildStamp: "2026-09-12T00:00:00.000Z", version: "0.5.0" },
      ),
    ) as Record<string, unknown>;
    expect(payload.daemon).toBeNull();
    expect(payload.state).toBe("stopped");
    expect(payload.cli).toEqual({
      buildStamp: "2026-09-12T00:00:00.000Z",
      version: "0.5.0",
    });
  });
});

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw");
}

function createFakeClient(overrides: { name?: string | null } = {}): FakeClient {
  const calls: unknown[] = [];
  const name = Object.hasOwn(overrides, "name") ? overrides.name : "reviewer";
  return {
    calls,
    close: () => calls.push(["close"]),
    async request(method, params) {
      calls.push([method, params]);
      if (method === "agent.list") {
        return {
          agents: [
            {
              agent: "codex",
              agentStatus: "idle",
              history: {
                lastAssistantMessage: { text: "done", timestamp: null, ref: "r2" },
                lastUserMessage: { text: "fix bug", timestamp: null, ref: "r1" },
                source: "codex-jsonl",
                updatedAt: "2026-07-22T00:00:00.000Z",
              },
              name,
              paneId: "wB:p1",
            },
            {
              agent: "codex",
              agentStatus: "idle",
              history: {},
              name: null,
              paneId: "wB:p2",
            },
          ],
        };
      }
      if (method === "agent.get") {
        return {
          agent: {
            agent: "codex",
            agentStatus: "idle",
            herdrSessionName: "default",
            history: {},
            name,
            paneId: "wB:p1",
            terminalId: "term_1",
            workspaceId: "wB",
          },
        };
      }
      if (method === "agent.read") {
        return { agent: { agent: "codex", messages: [], name, paneId: "wB:p1" } };
      }
      return {};
    },
  };
}
