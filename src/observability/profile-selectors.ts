/**
 * Phase 2 — typed profile selectors (vault §7 selection model, §6.1 isolation).
 *
 * Selectors are stored as JSON but parsed into a strict discriminated union;
 * ad-hoc glob strings are rejected. Resolution is scoped to one workspace in
 * one Herdr session FIRST (a workspace selector never silently expands to
 * another session with the same workspace id), then the agent selector is
 * applied inside that scope.
 *
 * Selection priority (§7):
 *   1. exact terminal id — emergency pinning only
 *   2. exact pane id — useful but move-sensitive
 *   3. exact stable live name — preferred
 *   4. exact runtime session id — diagnostic/session pinning
 *   5. runtime kind plus cwd — only when uniquely resolved
 * Ambiguous selectors fail closed: a resolution that matches more than one
 * agent is an error, never a guess (§7/§6.1.3).
 */

export type WorkspaceSelector = {
  herdrSession: string;
  workspaceId: string;
};

export type AgentSelector =
  | { kind: "terminalId"; value: string }
  | { kind: "paneId"; value: string }
  | { kind: "name"; value: string }
  | { kind: "agentSession"; value: string }
  | { kind: "runtimeKindPlusCwd"; agent: string; cwd: string };

export type SelectableAgent = {
  agent: string | null;
  agentSessionId: string | null;
  cwd: string | null;
  herdrSessionName: string;
  id: string;
  name: string | null;
  paneId: string;
  terminalId: string | null;
  workspaceId: string;
};

export type SelectorParseError = {
  error: "invalid_workspace_selector" | "invalid_agent_selector";
  detail: string;
};

export type AgentResolution =
  | { kind: "matched"; agent: SelectableAgent }
  | { kind: "unmatched"; detail: string }
  | {
      kind: "ambiguous";
      candidates: Array<{ id: string; paneId: string; name: string | null }>;
      detail: string;
    };

const AGENT_SELECTOR_KINDS = new Set([
  "terminalId",
  "paneId",
  "name",
  "agentSession",
  "runtimeKindPlusCwd",
]);

export function parseWorkspaceSelector(json: string): WorkspaceSelector | SelectorParseError {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { error: "invalid_workspace_selector", detail: "not valid JSON" };
  }
  if (typeof value !== "object" || value === null) {
    return { error: "invalid_workspace_selector", detail: "expected an object" };
  }
  const record = value as Record<string, unknown>;
  const herdrSession = record.herdrSession;
  const workspaceId = record.workspaceId;
  if (typeof herdrSession !== "string" || herdrSession.length === 0) {
    return {
      error: "invalid_workspace_selector",
      detail: "herdrSession must be a non-empty string",
    };
  }
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return {
      error: "invalid_workspace_selector",
      detail: "workspaceId must be a non-empty string",
    };
  }
  return { herdrSession, workspaceId };
}

export function parseAgentSelector(json: string): AgentSelector | SelectorParseError {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { error: "invalid_agent_selector", detail: "not valid JSON" };
  }
  if (typeof value !== "object" || value === null) {
    return { error: "invalid_agent_selector", detail: "expected an object" };
  }
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "terminalId":
    case "paneId":
    case "name":
    case "agentSession":
      if (typeof record.value !== "string" || record.value.length === 0) {
        return {
          error: "invalid_agent_selector",
          detail: `${record.kind}: value must be a non-empty string`,
        };
      }
      return { kind: record.kind, value: record.value } as AgentSelector;
    case "runtimeKindPlusCwd":
      if (typeof record.agent !== "string" || record.agent.length === 0) {
        return {
          error: "invalid_agent_selector",
          detail: "runtimeKindPlusCwd: agent must be a non-empty string",
        };
      }
      if (typeof record.cwd !== "string" || record.cwd.length === 0) {
        return {
          error: "invalid_agent_selector",
          detail: "runtimeKindPlusCwd: cwd must be a non-empty string",
        };
      }
      return { kind: "runtimeKindPlusCwd", agent: record.agent, cwd: record.cwd };
    default:
      return {
        error: "invalid_agent_selector",
        detail: `unknown selector kind ${JSON.stringify(record.kind)} (expected one of ${[...AGENT_SELECTOR_KINDS].join(", ")})`,
      };
  }
}

/**
 * Resolve one agent selector against the live index, scoped to the workspace.
 * The scope filter is applied by the caller (pass only agents already
 * filtered to the subscription's Herdr session + workspace) so the
 * no-cross-session invariant is structural, not convention.
 */
export function resolveAgentSelector(
  selector: AgentSelector,
  candidates: SelectableAgent[],
): AgentResolution {
  const matches = candidates.filter((candidate) => {
    switch (selector.kind) {
      case "terminalId":
        return candidate.terminalId === selector.value;
      case "paneId":
        return candidate.paneId === selector.value;
      case "name":
        return candidate.name === selector.value;
      case "agentSession":
        return candidate.agentSessionId === selector.value;
      case "runtimeKindPlusCwd":
        return candidate.agent === selector.agent && candidate.cwd === selector.cwd;
      default:
        return false;
    }
  });

  if (matches.length === 0) {
    return {
      kind: "unmatched",
      detail: `no agent in scope matches ${describeSelector(selector)}`,
    };
  }
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      candidates: matches.map((agent) => ({
        id: agent.id,
        name: agent.name,
        paneId: agent.paneId,
      })),
      detail: `${matches.length} agents in scope match ${describeSelector(selector)} — fail closed; pin by name, paneId, or terminalId`,
    };
  }
  const [agent] = matches;
  if (!agent)
    return { kind: "unmatched", detail: "matched agent vanished between filter and read" };
  return { kind: "matched", agent };
}

export function describeSelector(selector: AgentSelector): string {
  switch (selector.kind) {
    case "terminalId":
      return `terminalId ${selector.value}`;
    case "paneId":
      return `paneId ${selector.value}`;
    case "name":
      return `name ${selector.value}`;
    case "agentSession":
      return `agentSession ${selector.value}`;
    case "runtimeKindPlusCwd":
      return `${selector.agent} in ${selector.cwd}`;
  }
}

/** Candidate helper: extract the selector-facing projection from an index row. */
export function selectableFromRow(row: {
  agent: string | null;
  agentSessionJson: string | null;
  cwd: string | null;
  herdrSessionName: string;
  id: string;
  name: string | null;
  paneId: string;
  terminalId: string | null;
  workspaceId: string;
}): SelectableAgent {
  let agentSessionId: string | null = null;
  if (row.agentSessionJson) {
    try {
      const parsed = JSON.parse(row.agentSessionJson) as { value?: unknown };
      if (typeof parsed.value === "string") agentSessionId = parsed.value;
    } catch {
      agentSessionId = null;
    }
  }
  return {
    agent: row.agent,
    agentSessionId,
    cwd: row.cwd,
    herdrSessionName: row.herdrSessionName,
    id: row.id,
    name: row.name,
    paneId: row.paneId,
    terminalId: row.terminalId,
    workspaceId: row.workspaceId,
  };
}
