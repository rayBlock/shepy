import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
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
