#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { CLAUDE_HOOK_STDIN_MAX_CHARS, runClaudeHook } from "@/cli/claude-hook.js";
import { resolveRuntime, runtimePathsFromRecordOrDefault } from "@/config/runtime.js";
import { ObservabilityRpcClient } from "@/daemon/client.js";
import type { DaemonInfo } from "@/daemon/daemon-identity.js";
import { resolveBuildStamp } from "@/daemon/daemon-identity.js";
import {
  type DaemonStatus,
  getDaemonStatus,
  startDaemonProcess,
  stopDaemonProcess,
} from "@/daemon/process-manager.js";
import { DEFAULT_LEASE_GRACE_MS, type PublicProfileOwner } from "@/db/profile-owners.js";
import type {
  AgentGetResult,
  AgentListItem,
  AgentReadResult,
  CompactAgentHistory,
} from "@/observability/contracts.js";
import type { ProfileDiagnoseReport } from "@/observability/profile-diagnose-service.js";

const CURRENT_HERDR_WORKSPACE_ERROR =
  "agent command requires HERDR_ENV=1 with HERDR_WORKSPACE_ID, --workspace <id>, --session <name>, or --all.";

/**
 * The verbs each command group parses — the single source of truth for
 * "what does this group accept". The parsers consult these tables for
 * membership (parseAgentCommand/profile/inbox via their help-topic
 * resolvers, parseOperationCommand and parseDaemonCommand via direct
 * membership checks, parseCliArgs via TOP_LEVEL_COMMANDS), and the group
 * help pages list them. test/unit/cli-census.test.ts holds the two in
 * lockstep: a verb that parses must be listed, a listed verb must parse,
 * and every parsed verb must have a detail help page.
 */
export const COMMAND_GROUP_VERBS = {
  agent: ["get", "list", "read"],
  daemon: ["restart", "start", "status", "stop"],
  inbox: ["get", "list", "lookup-demand", "publish-demand", "retire", "retry"],
  operation: ["get", "list"],
  profile: [
    "context",
    "diagnose",
    "ensure",
    "list",
    "owner",
    "prune",
    "show",
    "subscribe",
    "unsubscribe",
  ],
} as const;

export type CommandGroup = keyof typeof COMMAND_GROUP_VERBS;

export type DaemonAction = (typeof COMMAND_GROUP_VERBS.daemon)[number];

export const TOP_LEVEL_COMMANDS = [
  "agent",
  "claude-hook",
  "daemon",
  "dispatch",
  "inbox",
  "operation",
  "profile",
  "wait",
] as const;

export type TopLevelCommand = (typeof TOP_LEVEL_COMMANDS)[number];

type HelpTopic =
  | "agent"
  | "agent-get"
  | "agent-list"
  | "agent-read"
  | "claude-hook"
  | `daemon-${DaemonAction}`
  | "daemon"
  | "dispatch"
  | "inbox"
  | "inbox-get"
  | "inbox-list"
  | "inbox-lookup-demand"
  | "inbox-publish-demand"
  | "inbox-retire"
  | "inbox-retry"
  | "operation"
  | "operation-get"
  | "operation-list"
  | "profile"
  | "profile-context"
  | "profile-diagnose"
  | "profile-ensure"
  | "profile-list"
  | "profile-owner"
  | "profile-prune"
  | "profile-show"
  | "profile-subscribe"
  | "root"
  | "wait";

class CliUsageError extends Error {
  constructor(
    message: string,
    readonly helpTopic: HelpTopic,
  ) {
    super(message);
    this.name = "CliUsageError";
  }
}

type AgentScope = {
  all?: boolean;
  herdrSessionName?: string;
  workspaceId?: string;
};

export type CliCommand =
  | { action: DaemonAction; command: "daemon" }
  | ({ command: "agent-list"; json: boolean } & AgentScope)
  | ({ command: "agent-get"; json: boolean; target: string } & AgentScope)
  | ({ command: "agent-read"; json: boolean; limit?: number; target: string } & AgentScope)
  | { command: "profile-context"; json: boolean; profileId: string }
  | { command: "profile-diagnose"; json: boolean; profileId: string }
  | {
      command: "profile-ensure";
      displayName: string;
      json: boolean;
      profileId: string;
      projectRoots: string[];
    }
  | { command: "profile-list"; json: boolean }
  | { command: "profile-owner"; json: boolean; profileId: string }
  | { ageMs: number; command: "profile-prune"; json: boolean; profileId: string }
  | {
      command: "profile-show";
      json: boolean;
      profileId: string;
    }
  | {
      command: "profile-subscribe";
      agentSelector: string;
      herdrSessionName: string;
      json: boolean;
      profileId: string;
      subscribe: boolean;
      workspaceId: string;
    }
  | { command: "inbox-get"; id: string; json: boolean }
  | { command: "inbox-publish-demand"; file: string; json: boolean }
  | {
      command: "inbox-lookup-demand";
      profileId: string;
      sourceId: string;
      key: string;
      json: boolean;
    }
  | {
      command: "inbox-list";
      before?: number;
      json: boolean;
      limit?: number;
      profileId: string;
      state?: string;
    }
  | { command: "inbox-retire"; json: boolean; olderThanDays?: number; profileId: string }
  | { command: "inbox-retry"; id: string; json: boolean }
  | { command: "operation-dispatch"; json: boolean; profileId: string; prompt: string }
  | { command: "operation-wait"; json: boolean; operationId: string; timeoutMs?: number }
  | { command: "operation-get"; json: boolean; operationId: string }
  | { command: "operation-list"; json: boolean; profileId: string }
  | { command: "claude-hook"; profileId: string }
  | { command: "help"; topic: HelpTopic }
  | { command: "version" };

type RpcClientLike = Pick<ObservabilityRpcClient, "close" | "request">;

type RunCliDeps = {
  connect(socketPath: string): Promise<RpcClientLike>;
  output(line: string): void;
  socketPath: string;
};

export function parseCliArgs(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): CliCommand {
  const [command, ...rest] = args;
  if (!command) return { command: "help", topic: "root" };
  if (isHelpFlag(command)) return { command: "help", topic: "root" };
  if (command === "--version" || command === "-v") {
    rejectExtra(rest, "root");
    return { command: "version" };
  }

  if (isTopLevelCommand(command)) {
    switch (command) {
      case "agent":
        return parseAgentCommand(rest, environment);
      case "claude-hook":
        return parseClaudeHookCommand(rest);
      case "daemon":
        return parseDaemonCommand(rest);
      case "dispatch":
        return parseDispatchCommand(rest);
      case "inbox":
        return parseInboxCommand(rest);
      case "operation":
        return parseOperationCommand(rest);
      case "profile":
        return parseProfileCommand(rest);
      case "wait":
        return parseWaitCommand(rest);
    }
  }

  throw new CliUsageError(`Unknown command: ${command}`, "root");
}

function parseClaudeHookCommand(args: string[]): CliCommand {
  if (args.some(isHelpFlag)) return { command: "help", topic: "claude-hook" };
  const profileId = takeOption(args, "--profile", "claude-hook");
  if (!profileId) {
    throw new CliUsageError("claude-hook requires --profile <profileId>", "claude-hook");
  }
  rejectExtra(args, "claude-hook");
  return { command: "claude-hook", profileId };
}

function parseDispatchCommand(args: string[]): CliCommand {
  if (args.some(isHelpFlag)) return { command: "help", topic: "dispatch" };
  const promptFile = takeOption(args, "--prompt-file", "dispatch");
  const json = takeFlag(args, "--json");
  const [profileId, ...promptParts] = args;
  if (!profileId) throw new CliUsageError("dispatch requires <profileId>", "dispatch");
  rejectExtra([], "dispatch");
  let prompt: string;
  if (promptFile) {
    prompt = `file:${promptFile}`;
  } else {
    prompt = promptParts.join(" ");
    if (prompt.trim().length === 0) {
      throw new CliUsageError(
        "dispatch requires a prompt (positional text or --prompt-file <path>)",
        "dispatch",
      );
    }
  }
  return { command: "operation-dispatch", json, profileId, prompt };
}

function parseWaitCommand(args: string[]): CliCommand {
  if (args.some(isHelpFlag)) return { command: "help", topic: "wait" };
  const timeoutValue = takeOption(args, "--timeout", "wait");
  const json = takeFlag(args, "--json");
  const [operationId, ...extra] = args;
  if (!operationId) throw new CliUsageError("wait requires <operationId>", "wait");
  rejectExtra(extra, "wait");
  const timeoutMs = timeoutValue ? Number(timeoutValue) : undefined;
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000)
  ) {
    throw new CliUsageError("--timeout must be between 1 and 3600000 milliseconds", "wait");
  }
  return {
    command: "operation-wait",
    json,
    operationId,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function parseOperationCommand(args: string[]): CliCommand {
  const [subcommand, ...rest] = args;
  if (!subcommand || isHelpFlag(subcommand)) return { command: "help", topic: "operation" };
  if (!isCommandGroupVerb("operation", subcommand)) {
    throw new CliUsageError(`Unknown operation command: ${subcommand}`, "operation");
  }
  if (subcommand === "get") {
    if (rest.some(isHelpFlag)) return { command: "help", topic: "operation-get" };
    const json = takeFlag(rest, "--json");
    const [operationId, ...extra] = rest;
    if (!operationId)
      throw new CliUsageError("operation get requires <operationId>", "operation-get");
    rejectExtra(extra, "operation-get");
    return { command: "operation-get", json, operationId };
  }
  if (subcommand === "list") {
    if (rest.some(isHelpFlag)) return { command: "help", topic: "operation-list" };
    const json = takeFlag(rest, "--json");
    const [profileId, ...extra] = rest;
    if (!profileId)
      throw new CliUsageError("operation list requires <profileId>", "operation-list");
    rejectExtra(extra, "operation-list");
    return { command: "operation-list", json, profileId };
  }
  throw new CliUsageError(`Unknown operation command: ${subcommand}`, "operation");
}

function parseDaemonCommand(args: string[]): CliCommand {
  const [action = "status", ...extra] = args;
  if (isHelpFlag(action)) return { command: "help", topic: "daemon" };
  if (!isDaemonAction(action)) {
    throw new CliUsageError(`Unknown daemon action: ${action}`, "daemon");
  }
  if (extra.some(isHelpFlag)) return { command: "help", topic: `daemon-${action}` };
  rejectExtra(extra, `daemon-${action}`);
  return { action, command: "daemon" };
}

function parseAgentCommand(args: string[], environment: NodeJS.ProcessEnv): CliCommand {
  const [subcommand, ...rest] = args;
  if (!subcommand || isHelpFlag(subcommand)) return { command: "help", topic: "agent" };
  const helpTopic = agentHelpTopic(subcommand);
  if (!helpTopic) {
    throw new CliUsageError(`Unknown agent command: ${subcommand}`, "agent");
  }
  if (rest.some(isHelpFlag)) return { command: "help", topic: helpTopic };

  const json = takeFlag(rest, "--json");
  const herdrSessionName = takeOption(rest, "--session", helpTopic);
  const workspaceId = takeOption(rest, "--workspace", helpTopic);
  const explicitScope: AgentScope = {
    ...(herdrSessionName ? { herdrSessionName } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };

  if (subcommand === "list") {
    const all = takeFlag(rest, "--all");
    rejectExtra(rest, helpTopic);
    return {
      command: "agent-list",
      ...(all ? { all: true } : scopedOrCurrent(explicitScope, environment, helpTopic)),
      json,
    };
  }

  if (subcommand === "get") {
    const [target, ...extra] = rest;
    if (!target) throw new CliUsageError("agent get requires <target>", helpTopic);
    rejectExtra(extra, helpTopic);
    return {
      command: "agent-get",
      ...scopedOrCurrent(explicitScope, environment, helpTopic),
      json,
      target,
    };
  }

  if (subcommand === "read") {
    const limitValue = takeOption(rest, "--limit", helpTopic);
    const [target, ...extra] = rest;
    if (!target) throw new CliUsageError("agent read requires <target>", helpTopic);
    rejectExtra(extra, helpTopic);
    const limit = limitValue ? Number(limitValue) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
      throw new CliUsageError("--limit must be between 1 and 500", helpTopic);
    }
    return {
      command: "agent-read",
      ...scopedOrCurrent(explicitScope, environment, helpTopic),
      json,
      ...(limit !== undefined ? { limit } : {}),
      target,
    };
  }

  throw new CliUsageError(`Unknown agent command: ${subcommand}`, "agent");
}

function scopedOrCurrent(
  scope: AgentScope,
  environment: NodeJS.ProcessEnv,
  helpTopic: HelpTopic,
): AgentScope {
  if (scope.herdrSessionName || scope.workspaceId || scope.all) return scope;
  if (environment.HERDR_ENV === "1" && environment.HERDR_WORKSPACE_ID) {
    return { workspaceId: environment.HERDR_WORKSPACE_ID };
  }
  throw new CliUsageError(CURRENT_HERDR_WORKSPACE_ERROR, helpTopic);
}

function parseProfileCommand(args: string[]): CliCommand {
  const [subcommand, ...rest] = args;
  if (!subcommand || isHelpFlag(subcommand)) return { command: "help", topic: "profile" };
  const helpTopic = profileHelpTopic(subcommand);
  if (!helpTopic) {
    throw new CliUsageError(`Unknown profile command: ${subcommand}`, "profile");
  }
  if (rest.some(isHelpFlag)) return { command: "help", topic: helpTopic };
  const json = takeFlag(rest, "--json");
  if (subcommand === "list") {
    rejectExtra(rest, helpTopic);
    return { command: "profile-list", json };
  }
  if (subcommand === "ensure") {
    const displayName = takeOption(rest, "--display-name", helpTopic);
    const roots = takeOption(rest, "--roots", helpTopic);
    const [profileId, ...ensureExtra] = rest;
    if (!profileId) throw new CliUsageError("profile ensure requires <profileId>", helpTopic);
    rejectExtra(ensureExtra, helpTopic);
    return {
      command: "profile-ensure",
      displayName: displayName ?? profileId,
      json,
      profileId,
      projectRoots: roots
        ? roots
            .split(",")
            .map((root) => root.trim())
            .filter(Boolean)
        : [],
    };
  }
  if (subcommand === "subscribe" || subcommand === "unsubscribe") {
    const herdrSessionName = takeOption(rest, "--session", helpTopic) ?? "default";
    const workspaceId = takeOption(rest, "--workspace", helpTopic);
    const byName = takeOption(rest, "--name", helpTopic);
    const byPane = takeOption(rest, "--pane", helpTopic);
    const byTerminal = takeOption(rest, "--terminal", helpTopic);
    const bySessionId = takeOption(rest, "--agent-session", helpTopic);
    const kindPlusCwd = takeOption(rest, "--kind-cwd", helpTopic);
    const [profileId, ...subscribeExtra] = rest;
    const selectorCount = [byName, byPane, byTerminal, bySessionId, kindPlusCwd].filter(
      Boolean,
    ).length;
    if (!profileId) {
      throw new CliUsageError(`profile ${subcommand} requires <profileId>`, helpTopic);
    }
    if (!workspaceId) {
      throw new CliUsageError("profile subscribe requires --workspace <id>", helpTopic);
    }
    if (selectorCount !== 1) {
      throw new CliUsageError(
        "profile subscribe requires exactly one selector: --name, --pane, --terminal, --agent-session, or --kind-cwd <kind>=<cwd>",
        helpTopic,
      );
    }
    let agentSelector: string;
    if (byName) agentSelector = JSON.stringify({ kind: "name", value: byName });
    else if (byPane) agentSelector = JSON.stringify({ kind: "paneId", value: byPane });
    else if (byTerminal) agentSelector = JSON.stringify({ kind: "terminalId", value: byTerminal });
    else if (bySessionId)
      agentSelector = JSON.stringify({ kind: "agentSession", value: bySessionId });
    else {
      const [kind, cwd] = (kindPlusCwd ?? "").split("=");
      if (!kind || !cwd) {
        throw new CliUsageError("--kind-cwd must be <kind>=<cwd>", helpTopic);
      }
      agentSelector = JSON.stringify({ agent: kind, cwd, kind: "runtimeKindPlusCwd" });
    }
    rejectExtra(subscribeExtra, helpTopic);
    return {
      agentSelector,
      command: "profile-subscribe",
      herdrSessionName,
      json,
      profileId,
      subscribe: subcommand === "subscribe",
      workspaceId,
    };
  }
  const [profileId, ...extra] = rest;
  if (!profileId) {
    throw new CliUsageError(`profile ${subcommand} requires <profileId>`, helpTopic);
  }
  if (subcommand === "show") {
    rejectExtra(extra, helpTopic);
    return { command: "profile-show", json, profileId };
  }
  if (subcommand === "context") {
    rejectExtra(extra, helpTopic);
    return { command: "profile-context", json, profileId };
  }
  if (subcommand === "owner") {
    rejectExtra(extra, helpTopic);
    return { command: "profile-owner", json, profileId };
  }
  if (subcommand === "prune") {
    const age = takeOption(rest, "--age", helpTopic) ?? "24h";
    const ageMs = parseAgeDuration(age, helpTopic);
    // Re-destructure AFTER takeOption: the shared `extra` above was
    // snapshotted before --age was consumed from `rest`.
    const [pruneProfileId, ...pruneExtra] = rest;
    if (!pruneProfileId) {
      throw new CliUsageError("profile prune requires <profileId>", helpTopic);
    }
    rejectExtra(pruneExtra, helpTopic);
    return { ageMs, command: "profile-prune", json, profileId: pruneProfileId };
  }
  if (subcommand === "diagnose") {
    rejectExtra(extra, helpTopic);
    return { command: "profile-diagnose", json, profileId };
  }
  throw new CliUsageError(`Unknown profile command: ${subcommand}`, "profile");
}

function parseInboxCommand(args: string[]): CliCommand {
  const [subcommand, ...rest] = args;
  if (!subcommand || isHelpFlag(subcommand)) return { command: "help", topic: "inbox" };
  const helpTopic = inboxHelpTopic(subcommand);
  if (!helpTopic) {
    throw new CliUsageError(`Unknown inbox command: ${subcommand}`, "inbox");
  }
  if (rest.some(isHelpFlag)) return { command: "help", topic: helpTopic };
  const json = takeFlag(rest, "--json");
  if (subcommand === "publish-demand") {
    const file = takeOption(rest, "--file", helpTopic);
    if (!file || !isAbsolute(file))
      throw new CliUsageError("publish-demand requires --file <absolute-path>", helpTopic);
    rejectExtra(rest, helpTopic);
    return { command: "inbox-publish-demand", file, json };
  }
  if (subcommand === "lookup-demand") {
    const sourceId = takeOption(rest, "--source", helpTopic);
    const key = takeOption(rest, "--key", helpTopic);
    const [profileId, ...extra] = rest;
    if (!profileId || !sourceId || !key)
      throw new CliUsageError(
        "lookup-demand requires <profileId> --source <id> --key <key>",
        helpTopic,
      );
    rejectExtra(extra, helpTopic);
    return { command: "inbox-lookup-demand", profileId, sourceId, key, json };
  }
  if (subcommand === "get") {
    const [id, ...extra] = rest;
    if (!id) throw new CliUsageError("inbox get requires <obligationId>", helpTopic);
    rejectExtra(extra, helpTopic);
    return { command: "inbox-get", id, json };
  }
  if (subcommand === "retry") {
    const [id, ...extra] = rest;
    if (!id) throw new CliUsageError("inbox retry requires <obligationId>", helpTopic);
    rejectExtra(extra, helpTopic);
    return { command: "inbox-retry", id, json };
  }
  if (subcommand === "retire") {
    const olderThan = takeOption(rest, "--older-than-days", helpTopic);
    const [profileId, ...extra] = rest;
    if (!profileId) throw new CliUsageError("inbox retire requires <profileId>", helpTopic);
    rejectExtra(extra, helpTopic);
    let olderThanDays: number | undefined;
    if (olderThan !== undefined) {
      olderThanDays = Number(olderThan);
      if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
        throw new CliUsageError("--older-than-days must be a non-negative number", helpTopic);
      }
    }
    return {
      command: "inbox-retire",
      json,
      profileId,
      ...(olderThanDays !== undefined ? { olderThanDays } : {}),
    };
  }
  if (subcommand === "list") {
    const state = takeOption(rest, "--state", helpTopic);
    const beforeValue = takeOption(rest, "--before", helpTopic);
    const limitValue = takeOption(rest, "--limit", helpTopic);
    const [profileId, ...extra] = rest;
    if (!profileId) throw new CliUsageError("inbox list requires <profileId>", helpTopic);
    rejectExtra(extra, helpTopic);
    let before: number | undefined;
    if (beforeValue !== undefined) {
      before = Number(beforeValue);
      if (!Number.isInteger(before) || before < 0) {
        throw new CliUsageError("--before must be a non-negative integer", helpTopic);
      }
    }
    let limit: number | undefined;
    if (limitValue !== undefined) {
      limit = Number(limitValue);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new CliUsageError("--limit must be between 1 and 500", helpTopic);
      }
    }
    return {
      ...(before !== undefined ? { before } : {}),
      command: "inbox-list",
      json,
      ...(limit !== undefined ? { limit } : {}),
      profileId,
      ...(state ? { state } : {}),
    };
  }
  throw new Error(`Unknown inbox command: ${subcommand}`);
}

export function helpText(topic: HelpTopic = "root"): string {
  switch (topic) {
    case "root":
      return `Shepy observes coding agents managed by Herdr.

Usage:
  shepy [options] <command>

Commands:
  agent     Inspect indexed coding agents
  daemon    Manage the Shepy daemon
  profile   Manage orchestration profiles
  inbox     Inspect delivery obligations
  dispatch  Send a prompt to a profile's agent
  wait      Wait for an operation's completion
  operation Inspect orchestration operations
  claude-hook Handle a Claude Code hook event from stdin

Options:
  -h, --help       Show help
  -v, --version    Show version

Run \`shepy agent --help\`, \`shepy profile --help\`, or \`shepy daemon --help\` for command-specific help.
`;
    case "agent":
      return `Inspect indexed coding agents.

Usage:
  shepy agent <command>

Commands:
  list            List indexed agents
  get <target>    Show one agent
  read <target>   Read one agent's recent messages

Options:
  -h, --help      Show help

Run \`shepy agent <command> --help\` for command-specific help.
`;
    case "agent-list":
      return `List indexed agents.

Usage:
  shepy agent list [options]

Options:
  --all                 Select all running Herdr workspaces
  --workspace <id>      Select a Herdr workspace
  --session <name>      Select a Herdr session
  --json                Print JSON
  -h, --help            Show help
`;
    case "agent-get":
      return `Show one indexed agent.

Usage:
  shepy agent get <target> [options]

Options:
  --workspace <id>      Select a Herdr workspace
  --session <name>      Select a Herdr session
  --json                Print JSON
  -h, --help            Show help
`;
    case "agent-read":
      return `Read one agent's recent messages.

Usage:
  shepy agent read <target> [options]

Options:
  --limit <number>      Return 1 to 500 messages
  --workspace <id>      Select a Herdr workspace
  --session <name>      Select a Herdr session
  --json                Print JSON
  -h, --help            Show help
`;
    case "daemon":
      return `Manage the Shepy daemon.

Usage:
  shepy daemon [command]

Commands:
  start       Start the daemon
  stop        Stop the daemon
  restart     Restart the daemon
  status      Show daemon status (default)

Options:
  -h, --help  Show help

Run \`shepy daemon <command> --help\` for command-specific help.
`;
    case "daemon-start":
      return daemonActionHelp("start", "Start the Shepy daemon.");
    case "daemon-stop":
      return daemonActionHelp("stop", "Stop the Shepy daemon.");
    case "daemon-restart":
      return daemonActionHelp("restart", "Restart the Shepy daemon.");
    case "daemon-status":
      return daemonActionHelp("status", "Show Shepy daemon status.");
    case "profile":
      return `Manage orchestration profiles.

Usage:
  shepy profile <command>

Commands:
  list                     List profiles
  ensure <profileId>       Create or update a profile
  show <profileId>         Show one profile with subscriptions
  context <profileId>      Show cached agent context for a profile
  diagnose <profileId>     Explain why outcomes are not reaching the owner
  owner <profileId>        Show the profile's current owner
  subscribe <profileId>    Bind a profile to one Herdr agent
  unsubscribe <profileId>  Remove a profile subscription
  prune <profileId>        Remove dead subscriptions (selectors matching no live agent)

Options:
  -h, --help               Show help

Run \`shepy profile <command> --help\` for command-specific help.
`;
    case "profile-list":
      return `List profiles.

Usage:
  shepy profile list [options]

Options:
  --json         Print JSON
  -h, --help     Show help
`;
    case "profile-ensure":
      return `Create or update a profile.

Usage:
  shepy profile ensure <profileId> [options]

Options:
  --display-name <name>    Human-readable profile name
  --roots <path,path>      Comma-separated project roots
  --json                   Print JSON
  -h, --help               Show help
`;
    case "profile-show":
      return `Show one profile with its subscriptions.

Usage:
  shepy profile show <profileId> [options]

Options:
  --json         Print JSON
  -h, --help     Show help
`;
    case "profile-context":
      return `Show cached agent context for a profile.

Usage:
  shepy profile context <profileId> [options]

Options:
  --json         Print JSON
  -h, --help     Show help
`;
    case "profile-diagnose":
      return `Explain why outcomes are not reaching a profile's owner.

One read-only report: findings first (blockers, then warnings, then info),
then compact sections for the daemon identity, the owner lease, the
subscriptions, and the delivery queue. Never prints a lease token.

Usage:
  shepy profile diagnose <profileId> [options]

Options:
  --json         Print the full report as JSON
  -h, --help     Show help
`;
    case "profile-owner":
      return `Show the profile's current owner.

Usage:
  shepy profile owner <profileId> [options]

The lease token is never part of this output. A lapsed lease reads as
claimable — a claim decides ownership, not the presence of a stale row.

Options:
  --json         Print JSON
  -h, --help     Show help
`;
    case "profile-prune":
      return `Remove dead subscriptions: selectors matching NO live agent in their
scoped workspace, untouched for longer than the age. Close-on-collect for
lanes whose agents are provably gone — the removed list is the receipt.
Ambiguous selectors (multiple live agents matched) are refused, never guessed.

Usage:
  shepy profile prune <profileId> [--age 24h]

Options:
  --age <duration>  Unmatched-and-untouched gate: <n><s|m|h|d> (default 24h)
  --json            Print JSON
  -h, --help        Show help
`;
    case "profile-subscribe":
      return `Bind a profile to exactly one Herdr agent.

Usage:
  shepy profile subscribe <profileId> --workspace <id> [options]

Exactly one selector is required:
  --name <name>                  Herdr live agent name
  --pane <paneId>                Herdr pane id
  --terminal <terminalId>        Herdr terminal id
  --agent-session <sessionId>    Stable agent session id
  --kind-cwd <kind>=<cwd>        Runtime kind plus working directory

Options:
  --session <name>      Select a Herdr session (default: default)
  -h, --help            Show help
`;
    case "inbox":
      return `Inspect delivery obligations.

Usage:
  shepy inbox <command>

Commands:
  get <obligationId>        Show one obligation with its full excerpt
  list <profileId>          List obligations for a profile
  retire <profileId>        Retire a stale pending backlog
  retry <obligationId>      Retry a dead-lettered or stalled pending obligation
  publish-demand --file <absolute-request.json>   Publish a validated demand
  lookup-demand <profileId> --source <id> --key <key> --json   Read back publication

Options:
  -h, --help                Show help

Run \`shepy inbox <command> --help\` for command-specific help.
`;
    case "inbox-publish-demand":
      return `Publish a pinned factory.demand.v1 request to the daemon.\n\nUsage:\n  shepy inbox publish-demand --file <absolute-request.json> [--json]\n`;
    case "inbox-lookup-demand":
      return `Read back a published demand.\n\nUsage:\n  shepy inbox lookup-demand <profileId> --source <id> --key <key> --json\n`;
    case "inbox-get":
      return `Show one delivery obligation with its full excerpt.

The read-back for a deferred outcome's stub: the hook's injected summary
omits over-budget excerpts and points here. Never prints a lease token.

Usage:
  shepy inbox get <obligationId>

Options:
  --json         Print JSON
  -h, --help     Show help
`;
    case "inbox-list":
      return `List delivery obligations for a profile.

Usage:
  shepy inbox list <profileId> [options]

Options:
  --state <state>             Filter by pending|leased|delivered|acked|dead_letter
  --before <agentEventId>     Only rows strictly older than this agent event
  --limit <number>            Return 1 to 500 rows (default 50)
  --json                      Print JSON
  -h, --help                  Show help
`;
    case "inbox-retire":
      return `Retire pending obligations without delivering them.

Retires a stale backlog that accumulated while a profile had no owner, so
claiming it does not replay days-old notifications. Obligations already
leased or delivered to an active owner are never touched.

Usage:
  shepy inbox retire <profileId> [--older-than-days <n>]

Options:
  --older-than-days <n>  Only retire obligations created more than n days ago
  --json                 Print JSON
  -h, --help             Show help
`;
    case "inbox-retry":
      return `Retry a delivery obligation on demand: dead-lettered rows come back
with a fresh attempt budget; already-pending rows are re-armed (error cleared,
attempts reset) and the live owner pump leases them on its next tick.

Usage:
  shepy inbox retry <obligationId>

Options:
  -h, --help  Show help
`;
    case "dispatch":
      return `Dispatch a prompt to a profile's bound agent.

Usage:
  shepy dispatch <profileId> <prompt...> [options]
  shepy dispatch <profileId> --prompt-file <path> [options]

The profile must resolve to exactly one running agent with a stable
session identity; ambiguous or unmatched profiles fail closed and no
prompt is sent.

Options:
  --prompt-file <path>    Read the prompt from a file
  --json                  Print JSON
  -h, --help              Show help
`;
    case "wait":
      return `Wait for an operation's correlated completion.

Usage:
  shepy wait <operationId> [options]

Outcomes: settled, blocked, failed, target_lost, wait_timeout, or transport_unknown
(the wait response could not be read; the operation stays submitted and can be
waited on again). Also: uncorrelated, already_terminal, not_submitted, not_found.
A timeout ends this wait only — the operation stays live and a later
correlated result can still settle it.

Options:
  --timeout <ms>    Bound the wait (1 to 3600000 ms)
  --json            Print JSON
  -h, --help        Show help
`;
    case "operation":
      return `Inspect orchestration operations.

Usage:
  shepy operation <command>

Commands:
  get <operationId>      Show one operation
  list <profileId>       List a profile's operations, newest first

Options:
  -h, --help             Show help
`;
    case "operation-get":
      return `Show one durable operation.

Usage:
  shepy operation get <operationId> [options]

Options:
  --json         Print JSON
  -h, --help     Show help
`;
    case "operation-list":
      return `List a profile's operations, newest first.

Usage:
  shepy operation list <profileId> [options]

Options:
  --json         Print JSON
  -h, --help     Show help
`;
    case "claude-hook":
      return `Handle one Claude Code hook event from stdin.

Reads the hook event JSON Claude Code pipes to stdin, claims the profile for
this pane (re-claiming as the same subscriber always succeeds), and writes
hook JSON to stdout. UserPromptSubmit delivers pending worker outcomes as
injected context; Stop keeps the turn open while fresh obligations are
pending. Exits 0 on every expected condition so Shepy never degrades the
coding session, and never prints the lease token.

Usage:
  shepy claude-hook --profile <profileId>

Options:
  --profile <id>    Profile this pane owns (required)
  -h, --help        Show help
`;
  }
}

export function versionText(): string {
  return `shepy ${readPackageVersion()}`;
}

/** The CLI's own build identity, computed the same way the daemon computes
 * its own: the ISO mtime of the CLI entry file. Printed next to the
 * daemon's answer in `daemon status` so version skew is visible at a
 * glance (RUN-20260913-04 D1). */
function cliIdentity(): { buildStamp: string; version: string } {
  return {
    buildStamp: resolveBuildStamp(fileURLToPath(import.meta.url)),
    version: readPackageVersion(),
  };
}

/** The full `shepy daemon status` payload: the pid/socket probe result,
 * plus the daemon's own daemon.info when the socket answered, plus the
 * CLI's own stamps. `daemon: null` means the socket did not answer (or an
 * older daemon that predates daemon.info) — the CLI stamps still print. */
export function daemonStatusPayload(
  status: DaemonStatus,
  daemon: DaemonInfo | null,
  cli: { buildStamp: string; version: string },
): string {
  return JSON.stringify({ ...status, daemon, cli });
}

/** One bounded daemon.info read for the status command. A refusal (unknown
 * method from a pre-D1 daemon, or a socket that died between the probe and
 * this call) degrades to null — status never fails on identity. */
async function fetchDaemonInfo(socketPath: string): Promise<DaemonInfo | null> {
  const client = new ObservabilityRpcClient({ socketPath });
  try {
    return (await client.request("daemon.info", {})) as DaemonInfo;
  } catch {
    return null;
  } finally {
    client.close();
  }
}

export async function runCliCommand(command: CliCommand, deps: RunCliDeps): Promise<void> {
  if (command.command === "help") {
    deps.output(helpText(command.topic));
    return;
  }
  if (command.command === "version") {
    deps.output(versionText());
    return;
  }
  if (command.command === "operation-dispatch") {
    const client = await deps.connect(deps.socketPath);
    try {
      const prompt = await resolvePromptText(command.prompt);
      const result = await client.request("operation.dispatch", {
        profileId: command.profileId,
        prompt,
      });
      printResult(command, result, deps.output);
    } finally {
      client.close();
    }
    return;
  }
  if (command.command === "operation-wait") {
    const client = await deps.connect(deps.socketPath);
    try {
      const result = await client.request("operation.wait", {
        operationId: command.operationId,
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      });
      printResult(command, result, deps.output);
    } finally {
      client.close();
    }
    return;
  }
  if (command.command === "claude-hook") throw new Error("claude-hook command is handled by main");
  if (command.command === "daemon") throw new Error("daemon command is handled by main");
  const client = await deps.connect(deps.socketPath);
  try {
    const result = await dispatchRpcCommand(command, client);
    printResult(command, result, deps.output);
  } finally {
    client.close();
  }
}

async function dispatchRpcCommand(
  command: Exclude<
    CliCommand,
    {
      command:
        | "daemon"
        | "help"
        | "version"
        | "claude-hook"
        | "operation-dispatch"
        | "operation-wait";
    }
  >,
  client: RpcClientLike,
) {
  if (command.command === "agent-list") {
    return client.request("agent.list", scopeParams(command));
  }
  if (command.command === "agent-get") {
    return client.request("agent.get", { ...scopeParams(command), target: command.target });
  }
  if (command.command === "profile-list") {
    return client.request("profile.list", {});
  }
  if (command.command === "profile-ensure") {
    return client.request("profile.ensure", {
      displayName: command.displayName,
      profileId: command.profileId,
      projectRoots: command.projectRoots,
    });
  }
  if (command.command === "profile-show") {
    return client.request("profile.show", { profileId: command.profileId });
  }
  if (command.command === "profile-context") {
    return client.request("profile.context", { profileId: command.profileId });
  }
  if (command.command === "profile-diagnose") {
    // The CLI volunteers its own build stamp so the daemon can report
    // daemon_version_skew inside the findings (RUN-20260913-04 D2).
    return client.request("profile.diagnose", {
      cliBuildStamp: cliIdentity().buildStamp,
      profileId: command.profileId,
    });
  }
  if (command.command === "profile-owner") {
    return client.request("profile.owner", { profileId: command.profileId });
  }
  if (command.command === "profile-prune") {
    return client.request("profile.prune", { ageMs: command.ageMs, profileId: command.profileId });
  }
  if (command.command === "inbox-publish-demand") {
    const bytes = readFileSync(command.file);
    if (bytes.byteLength > 16 * 1024) throw new Error("demand:oversized");
    return client.request("inbox.publishDemand", JSON.parse(bytes.toString("utf8")));
  }
  if (command.command === "inbox-lookup-demand") {
    return client.request("inbox.lookupDemand", {
      schema: "factory.demand.lookup.v1",
      profileId: command.profileId,
      sourceId: command.sourceId,
      idempotencyKey: command.key,
    });
  }
  if (command.command === "inbox-get") {
    return client.request("inbox.get", { obligationId: command.id });
  }
  if (command.command === "inbox-list") {
    return client.request("inbox.list", {
      ...(command.before !== undefined ? { before: command.before } : {}),
      ...(command.limit !== undefined ? { limit: command.limit } : {}),
      profileId: command.profileId,
      ...(command.state ? { state: command.state } : {}),
    });
  }
  if (command.command === "inbox-retry") {
    return client.request("inbox.retry", { id: command.id });
  }
  if (command.command === "inbox-retire") {
    return client.request("inbox.retire", {
      profileId: command.profileId,
      ...(command.olderThanDays !== undefined
        ? { olderThan: Date.now() - command.olderThanDays * 86_400_000 }
        : {}),
    });
  }
  if (command.command === "profile-subscribe") {
    const params = {
      agentSelector: JSON.parse(command.agentSelector),
      herdrSessionName: command.herdrSessionName,
      profileId: command.profileId,
      workspaceId: command.workspaceId,
    };
    return client.request(command.subscribe ? "profile.subscribe" : "profile.unsubscribe", params);
  }
  if (command.command === "operation-get") {
    return client.request("operation.get", { operationId: command.operationId });
  }
  if (command.command === "operation-list") {
    return client.request("operation.list", { profileId: command.profileId });
  }
  return client.request("agent.read", {
    ...scopeParams(command),
    ...(command.limit !== undefined ? { limit: command.limit } : {}),
    target: command.target,
  });
}

async function resolvePromptText(prompt: string): Promise<string> {
  if (!prompt.startsWith("file:")) return prompt;
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(prompt.slice(5), "utf8");
  if (content.trim().length === 0) throw new Error("prompt file is empty");
  return content;
}

function scopeParams(scope: AgentScope): AgentScope {
  return {
    ...(scope.all ? { all: true } : {}),
    ...(scope.herdrSessionName ? { herdrSessionName: scope.herdrSessionName } : {}),
    ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
  };
}

function printResult(command: CliCommand, result: unknown, output: (line: string) => void): void {
  if ("json" in command && command.json) {
    output(JSON.stringify(result));
    return;
  }
  output(formatHumanResult(command, result));
}

function formatHumanResult(command: CliCommand, result: unknown): string {
  if (command.command === "agent-list")
    return formatAgentList(result as { agents?: AgentListItem[] });
  if (command.command === "agent-get") return formatAgentGet(result as { agent?: AgentGetResult });
  if (command.command === "agent-read")
    return formatAgentRead(result as { agent?: AgentReadResult });
  if (command.command === "profile-list")
    return formatProfileList(
      result as { profiles?: Array<{ displayName: string; profileId: string }> },
    );
  if (command.command === "profile-show" || command.command === "profile-context")
    return JSON.stringify(result, null, 2);
  if (command.command === "profile-owner")
    return formatProfileOwner(command, result as { owner?: PublicProfileOwner | null });
  if (command.command === "profile-diagnose")
    return formatProfileDiagnose(result as ProfileDiagnoseReport);
  if (command.command === "profile-prune") return formatProfilePrune(result as PruneResult);
  if (command.command === "inbox-get") return formatInboxGet(result as { obligation?: unknown });
  if (command.command === "inbox-list")
    return formatInboxList(
      result as {
        obligations?: Array<{
          agentEventId: number;
          attemptCount: number;
          id: string;
          lastErrorCode: string | null;
          state: string;
        }>;
      },
    );
  if (
    command.command === "profile-ensure" ||
    command.command === "profile-subscribe" ||
    command.command === "inbox-retry" ||
    command.command === "inbox-retire"
  )
    return JSON.stringify(result);
  return JSON.stringify(result);
}

function formatAgentList(result: { agents?: AgentListItem[] }): string {
  const agents = result.agents ?? [];
  if (agents.length === 0) return "No Shepy agents indexed.";
  const lines = [
    ["status", "name", "agent", "pane", "last user", "last assistant", "updated"].join("\t"),
  ];
  for (const agent of agents) {
    lines.push(
      [
        agent.agentStatus,
        agent.name ?? "",
        agent.agent ?? "unknown",
        agent.paneId,
        oneLine(agent.history.lastUserMessage?.text ?? ""),
        oneLine(agent.history.lastAssistantMessage?.text ?? ""),
        agent.history.updatedAt ?? "",
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

function formatAgentGet(result: { agent?: AgentGetResult }): string {
  const agent = result.agent;
  if (!agent) return "Agent not found.";
  const lines = [
    `name: ${agent.name ?? "unnamed"}`,
    `agent: ${agent.agent ?? "unknown"}`,
    `status: ${agent.agentStatus}`,
    `pane: ${agent.paneId}`,
    `terminal: ${agent.terminalId ?? "unknown"}`,
    `workspace: ${agent.workspaceId}`,
    `Herdr session: ${agent.herdrSessionName}`,
    `cwd: ${agent.cwd ?? agent.foregroundCwd ?? "unknown"}`,
    `agent_session: ${agent.agentSession ? `${agent.agentSession.source}:${agent.agentSession.value}` : "none"}`,
    `last user: ${oneLine(agent.history.lastUserMessage?.text ?? "")}`,
    `last assistant: ${oneLine(agent.history.lastAssistantMessage?.text ?? "")}`,
    `last tool: ${agent.history.lastToolResult ? `${agent.history.lastToolResult.toolName} ${oneLine(agent.history.lastToolResult.text)}` : ""}`,
  ];
  if (agent.history.contextHealth) lines.push(...formatContextHealth(agent.history.contextHealth));
  return lines.join("\n");
}

function formatContextHealth(health: NonNullable<CompactAgentHistory["contextHealth"]>): string[] {
  const clean = (value: string) => oneLine(stripControlChars(value));
  const lines = ["context:"];
  lines.push(`  session: ${health.sessionId ? clean(health.sessionId) : "unknown"}`);
  if (health.model) {
    const provider = health.model.provider ? ` (${clean(health.model.provider)})` : "";
    const changed = health.model.changedAt ? ` changed at ${clean(health.model.changedAt)}` : "";
    lines.push(`  model: ${clean(health.model.id ?? "unknown")}${provider}${changed}`);
  } else {
    lines.push("  model: unknown");
  }
  const usage = health.usage;
  if (usage.kind === "last_reported" && usage.tokens !== null) {
    const at = usage.reportedAt ? ` at ${clean(usage.reportedAt)}` : "";
    const stale = usage.current ? "" : ` (stale: ${clean(usage.reason ?? "stale")})`;
    lines.push(`  usage: last_reported ${groupDigits(usage.tokens)} tokens${at}${stale}`);
  } else {
    lines.push(`  usage: unavailable (${clean(usage.reason ?? "unknown")})`);
  }
  const boundary = health.lastCompaction;
  if (boundary) {
    const at = boundary.timestamp ? ` at ${clean(boundary.timestamp)}` : "";
    if (boundary.tokensBefore !== null && boundary.tokensAfter !== null) {
      lines.push(
        `  last compaction: ${boundary.trigger} ${groupDigits(boundary.tokensBefore)} → ${groupDigits(boundary.tokensAfter)} tokens${at}`,
      );
    } else if (boundary.tokensBefore !== null) {
      const before = boundary.timestamp ? `, at ${clean(boundary.timestamp)}` : "";
      lines.push(
        `  last compaction: ${boundary.trigger} trigger, ${groupDigits(boundary.tokensBefore)} tokens before${before}`,
      );
    } else {
      lines.push(`  last compaction: ${boundary.trigger} trigger${at}`);
    }
  } else {
    lines.push("  last compaction: none");
  }
  lines.push(`  compactions: ${health.compactionCount}`);
  lines.push(
    `  limitations: ${health.limitations.length > 0 ? health.limitations.join(", ") : "none"}`,
  );
  return lines;
}

function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function formatAgentRead(result: { agent?: AgentReadResult }): string {
  const agent = result.agent;
  if (!agent) return "Agent not found.";
  const lines = [
    `name: ${agent.name ?? "unnamed"}`,
    `agent: ${agent.agent ?? "unknown"}`,
    `pane: ${agent.paneId}`,
    "",
  ];
  for (const message of agent.messages) {
    lines.push(
      [
        message.timestamp ?? "",
        message.role,
        message.toolName ?? "",
        message.compact
          ? `[${message.compact.compaction.mode}] ${oneLine(message.text)}`
          : oneLine(message.text),
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 160);
}

async function main(): Promise<void> {
  const command = parseCliArgs(argv.slice(2));
  if (command.command === "help") {
    console.log(helpText(command.topic));
    return;
  }
  if (command.command === "version") {
    console.log(versionText());
    return;
  }
  if (command.command === "claude-hook") {
    // The hook runs inside the user's turn latency path: an unresolvable
    // Shepy runtime (broken config, missing home) must degrade to a silent
    // no-op, never a failed turn.
    let runtime: ReturnType<typeof resolveRuntimeForCommand>;
    try {
      runtime = resolveRuntimeForCommand();
    } catch (error: unknown) {
      console.error(formatCliError(error));
      exit(0);
      return;
    }
    exit(
      await runClaudeHook({
        environment: process.env,
        homeDir: runtime.homeDir,
        profileId: command.profileId,
        readStdin: readStdinPayload,
        socketPath: runtime.paths.socketPath,
        writeStdout: (text) => process.stdout.write(text),
      }),
    );
    return;
  }
  const runtime = resolveRuntimeForCommand();
  if (command.command === "daemon") {
    await runDaemonCommand(command, runtime);
    return;
  }
  await runCliCommand(command, {
    connect: (socketPath) => Promise.resolve(new ObservabilityRpcClient({ socketPath })),
    output: (line) => console.log(line),
    socketPath: runtime.paths.socketPath,
  });
}

async function runDaemonCommand(
  command: Extract<CliCommand, { command: "daemon" }>,
  runtime: ReturnType<typeof resolveRuntimeForCommand>,
): Promise<void> {
  if (command.action === "status") {
    const status = await getDaemonStatus({
      pidPath: runtime.paths.pidPath,
      socketPath: runtime.paths.socketPath,
    });
    const daemon =
      "socketReachable" in status && status.socketReachable
        ? await fetchDaemonInfo(runtime.paths.socketPath)
        : null;
    console.log(daemonStatusPayload(status, daemon, cliIdentity()));
    return;
  }
  if (command.action === "stop") {
    console.log(
      JSON.stringify(
        await stopDaemonProcess({
          pidPath: runtime.paths.pidPath,
          socketPath: runtime.paths.socketPath,
          timeoutMs: 10_000,
        }),
      ),
    );
    return;
  }
  if (command.action === "restart") {
    await stopDaemonProcess({
      pidPath: runtime.paths.pidPath,
      socketPath: runtime.paths.socketPath,
      timeoutMs: 10_000,
    });
  }
  const result = await startDaemonProcess({
    entrypointPath: resolve(dirname(fileURLToPath(import.meta.url)), "shepy-daemon.js"),
    env: runtime.environment,
    logPath: runtime.paths.logPath,
    nodePath: process.execPath,
    pidPath: runtime.paths.pidPath,
    runtimeRecord: {
      dbPath: runtime.paths.dbPath,
      homeDir: runtime.homeDir,
      logPath: runtime.paths.logPath,
      pidPath: runtime.paths.pidPath,
      socketPath: runtime.paths.socketPath,
    },
    runtimeRecordPath: runtime.paths.runtimeRecordPath,
    socketPath: runtime.paths.socketPath,
  });
  console.log(JSON.stringify({ ...result, socketPath: runtime.paths.socketPath }));
}

function resolveRuntimeForCommand() {
  return runtimePathsFromRecordOrDefault({ environment: process.env })
    ? {
        environment: process.env,
        homeDir: resolveRuntime({ environment: process.env }).homeDir,
        paths: runtimePathsFromRecordOrDefault({ environment: process.env }),
      }
    : resolveRuntime({ environment: process.env });
}

function readStdinPayload(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let text = "";
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      settle();
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > CLAUDE_HOOK_STDIN_MAX_CHARS) {
        process.stdin.destroy();
        finish(() => resolve(text));
      }
    });
    process.stdin.on("end", () => finish(() => resolve(text)));
    process.stdin.on("error", (error: Error) => finish(() => reject(error)));
  });
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args: string[], name: string, helpTopic: HelpTopic): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new CliUsageError(`${name} requires a value`, helpTopic);
  args.splice(index, 2);
  return value;
}

function rejectExtra(args: string[], helpTopic: HelpTopic): void {
  if (args.length > 0) throw new CliUsageError(`Invalid argument: ${args[0]}`, helpTopic);
}

/** `--age` durations: `<n><s|m|h|d>` (e.g. 30m, 24h, 7d). No unit, no parse —
 * a bare number is hours-by-silence, and silence is how graves get dug. */
function parseAgeDuration(value: string, helpTopic: HelpTopic): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match?.[1] || !match[2]) {
    throw new CliUsageError(
      "--age must be <number><s|m|h|d>, e.g. 30m, 24h, 7d (default 24h)",
      helpTopic,
    );
  }
  const amount = Number(match[1]);
  const unitMs = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }[
    match[2] as "d" | "h" | "m" | "s"
  ];
  return amount * unitMs;
}

function isDaemonAction(value: string): value is DaemonAction {
  return isCommandGroupVerb("daemon", value);
}

function isTopLevelCommand(value: string): value is TopLevelCommand {
  return TOP_LEVEL_COMMANDS.some((command) => command === value);
}

function isCommandGroupVerb(group: CommandGroup, verb: string): boolean {
  return (COMMAND_GROUP_VERBS[group] as readonly string[]).includes(verb);
}

export function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("ENOENT") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Shepy daemon socket closed") ||
    message.includes("Observability RPC socket closed")
  ) {
    return `${message}\nRun \`shepy daemon start\` before using Shepy commands.`;
  }
  if (error instanceof CliUsageError) {
    return `${message}\nRun \`${helpInvocation(error.helpTopic)}\` for usage.`;
  }
  return message;
}

function agentHelpTopic(subcommand: string): HelpTopic | undefined {
  return isCommandGroupVerb("agent", subcommand) ? (`agent-${subcommand}` as HelpTopic) : undefined;
}

function profileHelpTopic(subcommand: string): HelpTopic | undefined {
  if (!isCommandGroupVerb("profile", subcommand)) return undefined;
  return subcommand === "unsubscribe"
    ? "profile-subscribe"
    : (`profile-${subcommand}` as HelpTopic);
}

function inboxHelpTopic(subcommand: string): HelpTopic | undefined {
  return isCommandGroupVerb("inbox", subcommand) ? (`inbox-${subcommand}` as HelpTopic) : undefined;
}

function daemonActionHelp(action: DaemonAction, description: string): string {
  return `${description}

Usage:
  shepy daemon ${action}

Options:
  -h, --help  Show help
`;
}

function helpInvocation(topic: HelpTopic): string {
  if (topic === "root") return "shepy --help";
  // Hyphenated top-level commands are real command names, not nested topics:
  // no dash-to-space substitution.
  if (topic === "claude-hook") return "shepy claude-hook --help";
  return `shepy ${topic.replaceAll("-", " ")} --help`;
}

function isHelpFlag(value: string): boolean {
  return value === "--help" || value === "-h";
}

function readPackageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifestPath = join(directory, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
      if (typeof manifest.version === "string") return manifest.version;
    } catch {
      // keep walking up
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return "unknown";
}

export function shouldRunCliMain(input: {
  argvPath: string | undefined;
  modulePath: string;
  realArgvPath?: string | undefined;
}): boolean {
  const modulePath = resolve(input.modulePath);
  return [input.argvPath, input.realArgvPath]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => resolve(value))
    .includes(modulePath);
}

function realpathOrUndefined(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (
  shouldRunCliMain({
    argvPath: process.argv[1],
    modulePath,
    realArgvPath: realpathOrUndefined(process.argv[1]),
  })
) {
  main().catch((error: unknown) => {
    console.error(formatCliError(error));
    exit(1);
  });
}

type PruneResult = {
  kept: number;
  refused?: Array<{ detail: string; id: number; label: string }>;
  removed?: Array<{ id: number; label: string; updatedAt: number }>;
};

/** The prune receipt: the removed list is the record of what died, the
 * refusals are the record of what was never guessed at. */
function formatProfilePrune(result: PruneResult): string {
  const removed = result.removed ?? [];
  const refused = result.refused ?? [];
  const lines: string[] = [];
  if (removed.length === 0) {
    lines.push("No dead subscriptions removed.");
  } else {
    lines.push(`Removed ${removed.length} dead subscription(s):`);
    for (const row of removed) {
      lines.push(
        `  - ${row.label} (id ${row.id}, last touched ${formatLocalTimestamp(row.updatedAt)})`,
      );
    }
  }
  lines.push(`${result.kept} live subscription(s) kept.`);
  if (refused.length > 0) {
    lines.push(`${refused.length} refused (never guessed):`);
    for (const row of refused) {
      lines.push(`  ! ${row.label} (id ${row.id}): ${row.detail}`);
    }
  }
  return lines.join("\n");
}

function formatProfileOwner(
  command: Extract<CliCommand, { command: "profile-owner" }>,
  result: { owner?: PublicProfileOwner | null },
): string {
  const owner = result.owner;
  if (!owner) return `Profile ${command.profileId} has no owner. It is claimable now.`;
  const expiredAgoMs = Date.now() - owner.leaseExpiresAt;
  const expiry = formatLocalTimestamp(owner.leaseExpiresAt);
  // "Lapsed" mirrors claim(): the profile is claimable the moment
  // lease_expires_at + reconnect grace is past, not at the raw expiry.
  const lease =
    expiredAgoMs < 0
      ? `lease valid for ${formatDuration(-expiredAgoMs)} (expires ${expiry})`
      : expiredAgoMs < DEFAULT_LEASE_GRACE_MS
        ? `lease in reconnect grace — claimable in ${formatDuration(DEFAULT_LEASE_GRACE_MS - expiredAgoMs)} (expired ${expiry})`
        : `lease lapsed ${formatDuration(expiredAgoMs)} ago (expired ${expiry}) — claimable`;
  return [
    `profile: ${owner.profileId}`,
    `owner: ${owner.paneId ?? "(no host location)"} (${owner.harnessKind})`,
    `workspace: ${owner.workspaceId ?? "unknown"}`,
    `session: ${owner.herdrSessionName ?? "none"}`,
    `terminal: ${owner.terminalId ?? "none"}`,
    lease,
  ].join("\n");
}

function formatLocalTimestamp(epochMs: number): string {
  const at = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600) % 24;
  const days = Math.floor(totalSeconds / 86_400);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function formatProfileList(result: {
  profiles?: Array<{ displayName: string; profileId: string }>;
}): string {
  const profiles = result.profiles ?? [];
  if (profiles.length === 0) return "No Shepy profiles.";
  return profiles.map((profile) => `${profile.profileId}\t${profile.displayName}`).join("\n");
}

// Findings first (the operator reads the verdict, then the evidence), then
// compact evidence sections: daemon, owner, subscriptions, queue. Every hint
// is a runnable next step; no lease token ever enters this output.
function formatProfileDiagnose(report: ProfileDiagnoseReport): string {
  const lines: string[] = [];
  // oneLine after stripControlChars: each finding renders as ONE line, so a
  // hostile profileId inside a message cannot forge a finding line of its own.
  for (const item of report.findings) {
    const message = oneLine(stripControlChars(item.message));
    const hint = oneLine(stripControlChars(item.hint));
    lines.push(`${item.severity.toUpperCase()} ${item.code}: ${message}`);
    lines.push(`  hint: ${hint}`);
  }
  lines.push("");
  lines.push("daemon:");
  const daemon = report.daemon;
  lines.push(
    daemon
      ? `  version ${daemon.version} (build ${daemon.buildStamp}, boot ${daemon.bootId}, pid ${daemon.pid}, booted ${daemon.bootedAt})`
      : "  (daemon did not report an identity)",
  );
  lines.push("owner:");
  const owner = report.owner;
  if (!owner) {
    lines.push("  none — the profile is claimable");
  } else {
    lines.push(`  ${owner.paneId ?? "(no host location)"} (${owner.harnessKind})`);
    lines.push(`  lease ${owner.state}, expires ${formatLocalTimestamp(owner.leaseExpiresAt)}`);
    if (owner.workspaceId) lines.push(`  workspace: ${owner.workspaceId}`);
  }
  lines.push("subscriptions:");
  if (report.subscriptions.length === 0) {
    lines.push("  none");
  }
  for (const subscription of report.subscriptions) {
    const selector = oneLine(JSON.stringify(subscription.selector));
    lines.push(
      `  #${subscription.id} ${subscription.enabled ? "enabled" : "disabled"} ${selector}`,
    );
    const resolution = subscription.resolution;
    if (!resolution) continue;
    if (resolution.kind === "matched") {
      lines.push(
        `    matched → ${resolution.agent.name ?? "unnamed"} (${resolution.agent.agent ?? "unknown"}, ${resolution.agent.agentStatus}) at ${resolution.agent.paneId}`,
      );
    } else if (resolution.kind === "ambiguous") {
      lines.push(`    ambiguous: ${resolution.detail}`);
    } else {
      lines.push(`    ${resolution.kind}: ${resolution.detail}`);
    }
  }
  lines.push("queue:");
  const counts = report.queue.counts;
  lines.push(
    `  pending ${counts.pending}, leased ${counts.leased}, delivered ${counts.delivered}, acked ${counts.acked}, dead_letter ${counts.dead_letter}`,
  );
  lines.push(
    `  oldest pending: ${report.queue.oldestPendingAgeMs === null ? "n/a" : `${formatDuration(report.queue.oldestPendingAgeMs)} ago`} | max pending attempts: ${report.queue.maxPendingAttempts} | stranded leases: ${report.queue.strandedLeases}`,
  );
  lines.push(
    `  last delivered: ${report.queue.lastDeliveredAt === null ? "never" : formatLocalTimestamp(report.queue.lastDeliveredAt)} | last acked: ${report.queue.lastAckedAt === null ? "never" : formatLocalTimestamp(report.queue.lastAckedAt)}`,
  );
  const unacked = report.queue.newestUnacked;
  lines.push(
    unacked
      ? `  newest unacked: ${unacked.id} (${unacked.state}, attempts ${unacked.attemptCount}${unacked.lastErrorCode ? `, last error ${unacked.lastErrorCode}` : ""})`
      : "  newest unacked: none",
  );
  return lines.join("\n");
}

// Terminal safety for the human read-back: the daemon strips C0/C1 at
// projection, but this formatter writes to the operator's terminal — the same
// character class normalizeOutcomeExcerpt strips, applied at render. (--json
// needs no guard: JSON.stringify escapes control characters by spec.)
function stripControlChars(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional C0/C1 stripping — untrusted text must never carry control bytes to a terminal.
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function formatInboxGet(result: { obligation?: unknown }): string {
  const obligation = result.obligation as
    | {
        agentEventId?: number;
        attemptCount?: number;
        id: string;
        lastErrorCode?: string | null;
        outcome?: { excerpt?: { text?: string; truncated?: boolean } | null } | null;
        state: string;
      }
    | null
    | undefined;
  if (!obligation) return "Obligation not found.";
  const excerpt = obligation.outcome?.excerpt ?? null;
  return [
    `id: ${obligation.id}`,
    `state: ${obligation.state}`,
    `event: ${obligation.agentEventId ?? "UNKNOWN"}`,
    `attempts: ${inboxAttemptCount(obligation.attemptCount)}`,
    `last_error: ${obligation.lastErrorCode ? stripControlChars(obligation.lastErrorCode) : "-"}`,
    "excerpt:",
    // The whole point of the read-back: the FULL excerpt, never truncated —
    // the hook's stub deferred it precisely because the summary could not
    // carry it.
    typeof excerpt?.text === "string" && excerpt.text.length > 0
      ? stripControlChars(excerpt.text)
      : "(no assistant message)",
  ].join("\n");
}

function inboxAttemptCount(value: number | undefined): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : "0 (UNKNOWN: attemptCount missing)";
}

function formatInboxList(result: {
  obligations?: Array<{
    agentEventId?: number;
    attemptCount?: number;
    id: string;
    lastErrorCode: string | null;
    state: string;
  }>;
}): string {
  const obligations = result.obligations ?? [];
  if (obligations.length === 0) return "Inbox empty.";
  const header = ["state", "event", "attempts", "last_error", "id"].join("\t");
  const rows = obligations.map((obligation) =>
    [
      obligation.state,
      obligation.agentEventId === undefined ? "UNKNOWN" : String(obligation.agentEventId),
      inboxAttemptCount(obligation.attemptCount),
      obligation.lastErrorCode ?? "-",
      obligation.id,
    ].join("\t"),
  );
  return [header, ...rows].join("\n");
}
