import type { AgentStore } from "@/db/agents.js";
import type { AgentIndexRecord } from "./contracts.js";
import {
  type AgentResolution,
  type AgentSelector,
  resolveAgentSelector,
  type SelectableAgent,
  selectableFromRow,
  type WorkspaceSelector,
} from "./profile-selectors.js";

/**
 * The one "scope → candidates → resolve" step behind BOTH selection paths
 * (vault §7, §6.1.2/§6.1.3).
 *
 * The candidate set is ALWAYS the live index filtered to the subscription's
 * exact Herdr session AND workspace before the agent selector is applied —
 * an identical workspace id in another session is never a candidate.
 *
 * Both ProfileService.resolveSubscriptions (inspection) and
 * ProfileDeliveryService.projectAgentEvent (delivery) resolve through this
 * helper so they cannot drift. The delivery path once resolved against a
 * single-element array built from the event's own agent: a one-element
 * candidate set can never be ambiguous, so an inspection-ambiguous selector
 * silently delivered as a first match, from whichever agent emitted.
 */
export type ScopedAgentResolution =
  | ({ kind: "matched"; record: AgentIndexRecord } & Extract<AgentResolution, { kind: "matched" }>)
  | Extract<AgentResolution, { kind: "unmatched" }>
  | Extract<AgentResolution, { kind: "ambiguous" }>;

export function resolveSelectorInWorkspaceScope(input: {
  agents: Pick<AgentStore, "list">;
  selector: AgentSelector;
  workspace: WorkspaceSelector;
}): ScopedAgentResolution {
  // Structural scope: exact session + exact workspace BEFORE agent
  // resolution (§6.1.2).
  const records = input.agents.list({
    herdrSessionName: input.workspace.herdrSession,
    workspaceId: input.workspace.workspaceId,
  });
  const resolution = resolveAgentSelector(
    input.selector,
    records.map((record) => selectableFromRow(recordToSelectableRow(record))),
  );
  if (resolution.kind !== "matched") return resolution;
  const record = records.find((row) => row.id === resolution.agent.id);
  if (!record) {
    return { kind: "unmatched", detail: "matched agent vanished between filter and read" };
  }
  return { ...resolution, record };
}

/** Candidate helper: the selector-facing projection of one index record. */
function recordToSelectableRow(record: AgentIndexRecord) {
  return {
    agent: record.agent,
    agentSessionJson: record.agentSession ? JSON.stringify(record.agentSession) : null,
    cwd: record.cwd,
    herdrSessionName: record.herdrSessionName,
    id: record.id,
    name: record.name,
    paneId: record.paneId,
    terminalId: record.terminalId,
    workspaceId: record.workspaceId,
  };
}
