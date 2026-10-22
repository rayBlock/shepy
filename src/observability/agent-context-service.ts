import { stat } from "node:fs/promises";
import { historySourceFromSessionRef } from "@/agent-history/discovery.js";
import type { AgentHistoryService } from "@/agent-history/service.js";
import { emptyCompactHistory } from "@/agent-history/service.js";
import type { AgentContextSnapshotStore } from "@/db/agent-context-snapshots.js";
import type { AgentStore } from "@/db/agents.js";
import type {
  AgentContextSnapshotRecord,
  AgentHistoryRef,
  AgentHistorySourceFingerprint,
  AgentIndexRecord,
  AgentListItem,
  AgentQueryScope,
  AgentScope,
  AgentWorkspaceContextSnapshot,
  CompactAgentHistory,
} from "./contracts.js";

export type RefreshAgentContextInput = {
  agent: AgentIndexRecord;
  identityChanged: boolean;
  /** Snapshot reconciliation persists the event before advancing this cache. */
  deferPersist?: boolean;
};

export type RefreshAgentContextResult = {
  changed: boolean;
  snapshot: AgentContextSnapshotRecord;
};

export class AgentContextService {
  readonly #history: AgentHistoryService;
  readonly #stores: {
    agentContextSnapshots: AgentContextSnapshotStore;
    agents: AgentStore;
  };

  constructor(options: {
    history: AgentHistoryService;
    stores: {
      agentContextSnapshots: AgentContextSnapshotStore;
      agents: AgentStore;
    };
  }) {
    this.#history = options.history;
    this.#stores = options.stores;
  }

  async refreshAgent(input: RefreshAgentContextInput): Promise<RefreshAgentContextResult> {
    const previous = this.#stores.agentContextSnapshots.get(input.agent.id);
    const directAuthoritativeRef = pathHistoryRefFromAgent(input.agent);
    const preferredRef =
      directAuthoritativeRef ??
      matchingAuthoritativeIdRef(input.agent, previous?.historyRef ?? null);
    const forceDiscovery =
      !directAuthoritativeRef && (input.identityChanged || preferredRef === null);
    const resolved = bindAuthoritativeId(
      input.agent,
      await this.#history.resolveCompactHistory(historyLookup(input.agent), {
        forceDiscovery,
        ...(preferredRef ? { preferredRef } : {}),
      }),
    );
    const next = {
      agentId: input.agent.id,
      compactHistory: resolved.compactHistory,
      historyRef: resolved.historyRef,
      paneRevision: input.agent.paneRevision,
      sourceFingerprint: resolved.sourceFingerprint,
    };
    if (previous && sameSnapshotPayload(previous, next)) {
      return { changed: false, snapshot: previous };
    }
    return {
      changed: true,
      snapshot: input.deferPersist
        ? { ...next, updatedAt: new Date() }
        : this.persistSnapshot(next),
    };
  }

  persistSnapshot(
    snapshot: Omit<AgentContextSnapshotRecord, "updatedAt">,
  ): AgentContextSnapshotRecord {
    return this.#stores.agentContextSnapshots.put(snapshot);
  }

  /** Pane revisions do not advance for every turn. Stat the bound source
   * before deciding that an unchanged pane can reuse its cached history. */
  async historySourceChanged(agentId: string): Promise<boolean> {
    const fingerprint = this.#stores.agentContextSnapshots.get(agentId)?.sourceFingerprint;
    if (!fingerprint) return false;
    const current = await stat(fingerprint.path).catch(() => null);
    return (
      !current ||
      current.size !== fingerprint.size ||
      Math.trunc(current.mtimeMs) !== fingerprint.mtimeMs
    );
  }

  getAgentSnapshot(agentId: string): AgentContextSnapshotRecord | undefined {
    return this.#stores.agentContextSnapshots.get(agentId);
  }

  listAgents(scope: AgentQueryScope): AgentListItem[] {
    const agents = this.#stores.agents.list(scope);
    const snapshots = new Map(
      this.#stores.agentContextSnapshots
        .listByAgentIds(agents.map((agent) => agent.id))
        .map((snapshot) => [snapshot.agentId, snapshot]),
    );
    return agents.map((agent) => listItem(agent, snapshots.get(agent.id)?.compactHistory));
  }

  workspaceSnapshot(
    input: AgentScope & { excludeTerminalId: string },
  ): AgentWorkspaceContextSnapshot | null {
    const agents = this.#stores.agents
      .list({ herdrSessionName: input.herdrSessionName, workspaceId: input.workspaceId })
      .filter((agent) => agent.terminalId !== input.excludeTerminalId);
    const snapshots = this.#stores.agentContextSnapshots.listByAgentIds(
      agents.map((agent) => agent.id),
    );
    if (snapshots.length === 0) return null;
    const firstSnapshot = snapshots[0];
    if (!firstSnapshot) return null;
    const byAgentId = new Map(snapshots.map((snapshot) => [snapshot.agentId, snapshot]));
    const updatedAt = snapshots.reduce(
      (latest, snapshot) => (snapshot.updatedAt > latest ? snapshot.updatedAt : latest),
      firstSnapshot.updatedAt,
    );
    return {
      agents: agents.map((agent) => listItem(agent, byAgentId.get(agent.id)?.compactHistory)),
      herdrSessionName: input.herdrSessionName,
      updatedAt: updatedAt.toISOString(),
      workspaceId: input.workspaceId,
    };
  }
}

function pathHistoryRefFromAgent(agent: AgentIndexRecord): AgentHistoryRef | null {
  if (agent.agentSession?.kind !== "path") return null;
  return {
    kind: "agent_session",
    path: agent.agentSession.value,
    source: historySourceFromSessionRef(agent.agentSession),
    value: agent.agentSession.value,
  };
}

function matchingAuthoritativeIdRef(
  agent: AgentIndexRecord,
  previous: AgentHistoryRef | null,
): AgentHistoryRef | null {
  const session = agent.agentSession;
  if (
    session?.kind !== "id" ||
    previous?.kind !== "agent_session" ||
    !previous.path ||
    previous.source !== historySourceFromSessionRef(session) ||
    previous.value !== session.value
  ) {
    return null;
  }
  return previous;
}

function bindAuthoritativeId(
  agent: AgentIndexRecord,
  resolved: Awaited<ReturnType<AgentHistoryService["resolveCompactHistory"]>>,
): Awaited<ReturnType<AgentHistoryService["resolveCompactHistory"]>> {
  const session = agent.agentSession;
  if (session?.kind !== "id" || !resolved.historyRef?.path) return resolved;
  const historyRef: AgentHistoryRef = {
    kind: "agent_session",
    path: resolved.historyRef.path,
    source: historySourceFromSessionRef(session),
    value: session.value,
  };
  return {
    ...resolved,
    compactHistory: { ...resolved.compactHistory, historyRef },
    historyRef,
  };
}

function historyLookup(agent: AgentIndexRecord) {
  return {
    agent: agent.agent,
    agentSession: agent.agentSession,
    cwd: agent.cwd,
    foregroundCwd: agent.foregroundCwd,
  };
}

function sameSnapshotPayload(
  previous: AgentContextSnapshotRecord,
  next: Omit<AgentContextSnapshotRecord, "updatedAt">,
): boolean {
  return (
    JSON.stringify(previous.compactHistory) === JSON.stringify(next.compactHistory) &&
    sameHistoryRef(previous.historyRef, next.historyRef) &&
    sameFingerprint(previous.sourceFingerprint, next.sourceFingerprint) &&
    previous.paneRevision === next.paneRevision
  );
}

function sameFingerprint(
  left: AgentHistorySourceFingerprint | null,
  right: AgentHistorySourceFingerprint | null,
): boolean {
  return (
    left?.path === right?.path && left?.mtimeMs === right?.mtimeMs && left?.size === right?.size
  );
}

function sameHistoryRef(left: AgentHistoryRef | null, right: AgentHistoryRef | null): boolean {
  return (
    left?.kind === right?.kind &&
    left?.path === right?.path &&
    left?.source === right?.source &&
    left?.value === right?.value
  );
}

function listItem(
  agent: AgentIndexRecord,
  compactHistory: CompactAgentHistory | undefined,
): AgentListItem {
  const compact = compactHistory ?? emptyCompactHistory();
  return {
    ...agent,
    history: {
      lastAssistantMessage: compact.lastAssistantMessage,
      lastUserMessage: compact.lastUserMessage,
      source: compact.source,
      updatedAt: compact.updatedAt,
    },
  };
}
