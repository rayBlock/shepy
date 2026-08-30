import type { AgentHistoryService } from "@/agent-history/service.js";
import type { AgentStore } from "@/db/agents.js";
import type {
  OrchestratorProfileStore,
  ProfileRecord,
  ProfileSubscriptionRecord,
} from "@/db/orchestrator-profiles.js";
import type { AgentIndexRecord } from "./contracts.js";
import {
  type AgentSelector,
  describeSelector,
  parseAgentSelector,
  parseWorkspaceSelector,
  resolveAgentSelector,
  selectableFromRow,
} from "./profile-selectors.js";

/**
 * Phase 2 — profile service (vault §16 Phase 2, query-only).
 *
 * Compiles a profile's subscribed agents against the live index with the
 * §6.1 isolation invariants enforced structurally:
 *   - candidates are pre-filtered to the subscription's exact Herdr session
 *     AND workspace before agent resolution, so a workspace id can never
 *     silently expand to another session;
 *   - ambiguous or unmatched selectors are reported per subscription, never
 *     guessed;
 *   - nothing here wakes an owner or acks an event — delivery is Phase 3.
 */

export type SubscriptionResolution =
  | { kind: "matched"; agent: AgentIndexRecord; subscription: ProfileSubscriptionRecord }
  | { kind: "unmatched"; detail: string; subscription: ProfileSubscriptionRecord }
  | {
      kind: "ambiguous";
      candidates: Array<{ id: string; name: string | null; paneId: string }>;
      detail: string;
      subscription: ProfileSubscriptionRecord;
    }
  | { kind: "invalid"; detail: string; subscription: ProfileSubscriptionRecord };

export type ProfileContext = {
  agents: Array<AgentIndexRecord & { compactHistory: unknown }>;
  profile: ProfileRecord;
  resolutions: SubscriptionResolution[];
};

export class ProfileService {
  readonly #agents: AgentStore;
  readonly #history: AgentHistoryService;
  readonly #profiles: OrchestratorProfileStore;

  constructor(options: {
    agents: AgentStore;
    history: AgentHistoryService;
    profiles: OrchestratorProfileStore;
  }) {
    this.#agents = options.agents;
    this.#history = options.history;
    this.#profiles = options.profiles;
  }

  ensureProfile(input: {
    displayName: string;
    profileId: string;
    projectRoots: string[];
  }): ProfileRecord {
    return this.#profiles.createProfile(input);
  }

  listProfiles(): ProfileRecord[] {
    return this.#profiles.listProfiles();
  }

  getProfile(profileId: string): ProfileRecord | undefined {
    return this.#profiles.getProfile(profileId);
  }

  deleteProfile(profileId: string): boolean {
    return this.#profiles.deleteProfile(profileId);
  }

  addSubscription(input: {
    agentSelector: AgentSelector;
    herdrSessionName: string;
    profileId: string;
    workspaceId: string;
  }): { subscription: ProfileSubscriptionRecord } {
    const workspaceSelector = parseWorkspaceSelector(
      JSON.stringify({ herdrSession: input.herdrSessionName, workspaceId: input.workspaceId }),
    );
    if ("error" in workspaceSelector) {
      throw new Error(`Invalid workspace selector: ${workspaceSelector.detail}`);
    }
    const subscription = this.#profiles.addSubscription({
      agentSelectorJson: JSON.stringify(input.agentSelector),
      herdrSessionName: input.herdrSessionName,
      profileId: input.profileId,
      workspaceSelectorJson: JSON.stringify(workspaceSelector),
    });
    return { subscription };
  }

  removeSubscription(input: {
    agentSelector: AgentSelector;
    herdrSessionName: string;
    profileId: string;
    workspaceId: string;
  }): { removed: boolean } {
    const workspaceSelector = {
      herdrSession: input.herdrSessionName,
      workspaceId: input.workspaceId,
    };
    const removed = this.#profiles.removeSubscription({
      agentSelectorJson: JSON.stringify(input.agentSelector),
      herdrSessionName: input.herdrSessionName,
      profileId: input.profileId,
      workspaceSelectorJson: JSON.stringify(workspaceSelector),
    });
    return { removed };
  }

  listSubscriptions(profileId: string): ProfileSubscriptionRecord[] {
    return this.#profiles.listSubscriptions(profileId);
  }

  /** Resolve every enabled subscription against the live index. */
  resolveSubscriptions(profileId: string): SubscriptionResolution[] {
    const subscriptions = this.#profiles
      .listSubscriptions(profileId)
      .filter((subscription) => subscription.enabled);
    const resolutions: SubscriptionResolution[] = [];
    for (const subscription of subscriptions) {
      const workspace = parseWorkspaceSelector(subscription.workspaceSelectorJson);
      if ("error" in workspace) {
        resolutions.push({ detail: workspace.detail, kind: "invalid", subscription });
        continue;
      }
      const selector = parseAgentSelector(subscription.agentSelectorJson);
      if ("error" in selector) {
        resolutions.push({ detail: selector.detail, kind: "invalid", subscription });
        continue;
      }
      // Structural scope: exact session + exact workspace BEFORE agent
      // resolution. An identical workspace id in another session is
      // never a candidate (§6.1.2).
      const candidates = this.#agents
        .list({ herdrSessionName: workspace.herdrSession, workspaceId: workspace.workspaceId })
        .map((record) => selectableFromRow(recordToRow(record)));
      const resolution = resolveAgentSelector(selector, candidates);
      if (resolution.kind === "matched") {
        const record = this.#agents
          .list({ herdrSessionName: workspace.herdrSession, workspaceId: workspace.workspaceId })
          .find((candidate) => candidate.id === resolution.agent.id);
        if (record) {
          resolutions.push({ agent: record, kind: "matched", subscription });
          continue;
        }
      }
      if (resolution.kind === "ambiguous") {
        resolutions.push({
          candidates: resolution.candidates,
          detail: resolution.detail,
          kind: "ambiguous",
          subscription,
        });
      } else if (resolution.kind === "unmatched") {
        resolutions.push({ detail: resolution.detail, kind: "unmatched", subscription });
      }
    }
    return resolutions;
  }

  /** Query-only context: matched agents + bounded compact history. No wake. */
  async profileContext(profileId: string): Promise<ProfileContext | undefined> {
    const profile = this.#profiles.getProfile(profileId);
    if (!profile) return undefined;
    const resolutions = this.resolveSubscriptions(profileId);
    const agents: Array<AgentIndexRecord & { compactHistory: unknown }> = [];
    for (const resolution of resolutions) {
      if (resolution.kind !== "matched") continue;
      const compact = await this.#history.resolveCompactHistory(
        {
          agent: resolution.agent.agent,
          agentSession: resolution.agent.agentSession,
          cwd: resolution.agent.cwd,
          foregroundCwd: resolution.agent.foregroundCwd,
        },
        { preferredRef: null },
      );
      agents.push({ ...resolution.agent, compactHistory: compact.compactHistory });
    }
    return { agents, profile, resolutions };
  }
}

function recordToRow(record: AgentIndexRecord) {
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

export { describeSelector };
