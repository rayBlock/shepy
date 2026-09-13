import { describe, expect, test } from "vitest";
import type { AgentStore } from "@/db/agents.js";
import type { AgentIndexRecord, AgentQueryScope } from "@/observability/contracts.js";
import { resolveSelectorInWorkspaceScope } from "@/observability/profile-selector-scope.js";
import type { SelectableAgent } from "@/observability/profile-selectors.js";

/**
 * Unit gate for the shared "scope → candidates → resolve" step both the
 * inspection path (ProfileService.resolveSubscriptions) and the delivery
 * path (ProfileDeliveryService.projectAgentEvent) must resolve through:
 * the candidate set is the exact session + workspace, nothing else — the
 * no-cross-session invariant is structural, and ambiguity surfaces before
 * any caller can fall back to a first match.
 */

function record(
  overrides: Partial<AgentIndexRecord> & Pick<AgentIndexRecord, "id">,
): AgentIndexRecord {
  return {
    agent: "pi",
    agentSession: null,
    agentStatus: "idle",
    cwd: "/repo",
    firstSeenAt: new Date(0),
    focused: false,
    foregroundCwd: null,
    herdrSessionName: "default",
    lastSeenAt: new Date(0),
    name: null,
    paneId: "wA:p1",
    paneRevision: null,
    tabId: null,
    terminalId: null,
    workspaceId: "wA",
    ...overrides,
  };
}

/** Store stub honouring the scope filter the way AgentStore.list does for
 * the shape the helper passes (session + workspace, no `all`). */
function storeOf(records: AgentIndexRecord[]): Pick<AgentStore, "list"> {
  return {
    list: (scope: AgentQueryScope = {}): AgentIndexRecord[] =>
      records.filter(
        (candidate) =>
          (!scope.herdrSessionName || candidate.herdrSessionName === scope.herdrSessionName) &&
          (!scope.workspaceId || candidate.workspaceId === scope.workspaceId),
      ),
  };
}

const kindPlusCwd = { agent: "pi", cwd: "/repo", kind: "runtimeKindPlusCwd" } as const;

describe("resolveSelectorInWorkspaceScope (shared by inspection and delivery)", () => {
  test("an identical workspace id in another session is never a candidate", () => {
    const store = storeOf([
      record({ id: "ag-1", name: "worker-a" }),
      record({ herdrSessionName: "other", id: "ag-decoy", name: "worker-a", terminalId: "tZ" }),
    ]);
    // Same name, same workspace id, different session: the decoy must not
    // turn a unique match ambiguous — the scope is resolved FIRST.
    const resolution = resolveSelectorInWorkspaceScope({
      agents: store,
      selector: { kind: "name", value: "worker-a" },
      workspace: { herdrSession: "default", workspaceId: "wA" },
    });
    expect(resolution.kind).toBe("matched");
    if (resolution.kind === "matched") {
      expect(resolution.record.id).toBe("ag-1");
      expect(resolution.agent.id).toBe("ag-1");
    }
  });

  test("runtimeKindPlusCwd over two identical in-scope workers is ambiguous, with both candidates named", () => {
    const store = storeOf([
      record({ id: "ag-1", name: "worker-a", paneId: "wA:p1", terminalId: "tA1" }),
      record({ id: "ag-2", name: "worker-b", paneId: "wA:p2", terminalId: "tA2" }),
    ]);
    const resolution = resolveSelectorInWorkspaceScope({
      agents: store,
      selector: kindPlusCwd,
      workspace: { herdrSession: "default", workspaceId: "wA" },
    });
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind === "ambiguous") {
      expect(resolution.candidates.map((candidate) => candidate.id)).toEqual(["ag-1", "ag-2"]);
    }
  });

  test("out-of-scope twins do not inflate an in-scope ambiguity", () => {
    // Two identical workers in scope plus the SAME kind+cwd in another
    // session with the same workspace id: ambiguity counts the scoped
    // candidates only — and inspection vs delivery see the same set.
    const store = storeOf([
      record({ id: "ag-1", name: "worker-a", paneId: "wA:p1", terminalId: "tA1" }),
      record({ id: "ag-2", name: "worker-b", paneId: "wA:p2", terminalId: "tA2" }),
      record({ herdrSessionName: "other", id: "ag-decoy", paneId: "wA:p1", terminalId: "tZ" }),
    ]);
    const resolution = resolveSelectorInWorkspaceScope({
      agents: store,
      selector: kindPlusCwd,
      workspace: { herdrSession: "default", workspaceId: "wA" },
    });
    expect(resolution).toMatchObject({ kind: "ambiguous" });
    if (resolution.kind === "ambiguous") {
      expect(resolution.candidates).toHaveLength(2);
    }
  });

  test("a name held by two live in-scope workers is ambiguous (the index permits duplicate names)", () => {
    const store = storeOf([
      record({ id: "ag-1", name: "worker", paneId: "wA:p1", terminalId: "tA1" }),
      record({ id: "ag-2", name: "worker", paneId: "wA:p2", terminalId: "tA2" }),
    ]);
    const resolution = resolveSelectorInWorkspaceScope({
      agents: store,
      selector: { kind: "name", value: "worker" },
      workspace: { herdrSession: "default", workspaceId: "wA" },
    });
    expect(resolution.kind).toBe("ambiguous");
  });

  test("no in-scope candidate matches: unmatched, never a guess", () => {
    const store = storeOf([record({ agent: "hermes", cwd: "/elsewhere", id: "ag-1" })]);
    const resolution = resolveSelectorInWorkspaceScope({
      agents: store,
      selector: kindPlusCwd,
      workspace: { herdrSession: "default", workspaceId: "wA" },
    });
    expect(resolution.kind).toBe("unmatched");
  });

  test("a matched resolution carries the raw index record alongside the selectable projection", () => {
    const store = storeOf([record({ id: "ag-1", name: "worker-a" })]);
    const resolution = resolveSelectorInWorkspaceScope({
      agents: store,
      selector: kindPlusCwd,
      workspace: { herdrSession: "default", workspaceId: "wA" },
    });
    if (resolution.kind !== "matched") throw new Error(`expected matched, got ${resolution.kind}`);
    const selectable: SelectableAgent = resolution.agent;
    expect(selectable.id).toBe("ag-1");
    expect(resolution.record.id).toBe("ag-1");
    expect(resolution.record.agentStatus).toBe("idle");
  });
});
