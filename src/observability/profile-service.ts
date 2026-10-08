import type { AgentHistoryService } from "@/agent-history/service.js";
import type { AgentStore } from "@/db/agents.js";
import type {
  OrchestratorProfileStore,
  ProfileRecord,
  ProfileSubscriptionRecord,
} from "@/db/orchestrator-profiles.js";
import type { AgentIndexRecord } from "./contracts.js";
import { resolveSelectorInWorkspaceScope } from "./profile-selector-scope.js";
import {
  type AgentSelector,
  describeSelector,
  parseAgentSelector,
  parseWorkspaceSelector,
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

  /**
   * Close-on-collect for subscriptions (the graveyard law): remove the
   * ones whose agent selector provably matches NO live agent in their
   * scoped workspace, older than `ageMs`. Liveness is judged by the SAME
   * scope → candidates → resolve step as inspection and delivery (one
   * helper, no drift), so a subscription this verb calls dead is a
   * subscription that can never project another obligation.
   *
   * Age proxy: `subscription.updatedAt` — the row's last change. There is
   * no first-unmatched-at stamp (the live agent index is transient by
   * design and stamping one would put write traffic on the delivery read
   * path), so "unmatched for longer than the age" reads as "unmatched
   * now, untouched for longer than the age". Named consequence: an agent
   * that died recently under an old untouched subscription prunes on the
   * first prune past the age — the removed list is the receipt that makes
   * that visible, and re-subscribing restores the binding.
   *
   * Refusals (never guesses): an AMBIGUOUS selector (multiple live agents
   * matched) is alive-ish and is never removed; an INVALID selector or
   * workspace selector cannot be proved dead — its intent is unreadable —
   * so it is reported and left; an unmatched subscription younger than the
   * age gate is reported as too young. Disabled subscriptions sit outside
   * resolveSubscriptions entirely and are not this verb's business.
   */
  pruneSubscriptions(input: { ageMs: number; now?: number; profileId: string }): {
    kept: number;
    refused: Array<{ detail: string; id: number; label: string }>;
    removed: Array<{ id: number; label: string; updatedAt: number }>;
  } {
    if (!this.#profiles.getProfile(input.profileId)) {
      throw new Error(`No such profile: ${input.profileId}`);
    }
    const now = input.now ?? Date.now();
    const removed: Array<{ id: number; label: string; updatedAt: number }> = [];
    const refused: Array<{ detail: string; id: number; label: string }> = [];
    let kept = 0;
    for (const resolution of this.resolveSubscriptions(input.profileId)) {
      const subscription = resolution.subscription;
      const label = subscriptionLabel(subscription);
      if (resolution.kind === "matched") {
        kept += 1;
        continue;
      }
      if (resolution.kind === "unmatched") {
        if (now - subscription.updatedAt < input.ageMs) {
          refused.push({
            detail: `unmatched but younger than the age gate: ${resolution.detail}`,
            id: subscription.id,
            label,
          });
          continue;
        }
        const gone = this.#profiles.removeSubscription({
          agentSelectorJson: subscription.agentSelectorJson,
          herdrSessionName: subscription.herdrSessionName,
          profileId: input.profileId,
          workspaceSelectorJson: subscription.workspaceSelectorJson,
        });
        if (gone) removed.push({ id: subscription.id, label, updatedAt: subscription.updatedAt });
        continue;
      }
      if (resolution.kind === "ambiguous") {
        refused.push({ detail: `ambiguous: ${resolution.detail}`, id: subscription.id, label });
        continue;
      }
      refused.push({ detail: `invalid: ${resolution.detail}`, id: subscription.id, label });
    }
    return { kept, refused, removed };
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
      // Shared scope → candidates → resolve step (§6.1.2): exact session +
      // exact workspace BEFORE agent resolution, identical to the delivery
      // path — the two cannot drift because they resolve through one helper.
      const resolution = resolveSelectorInWorkspaceScope({
        agents: this.#agents,
        selector,
        workspace,
      });
      if (resolution.kind === "matched") {
        resolutions.push({ agent: resolution.record, kind: "matched", subscription });
        continue;
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

/** One human-readable line per subscription — the prune receipt's row
 * identity. Falls back to the raw JSON when a part is unreadable, so the
 * receipt can never hide what was removed behind a parse failure. */
function subscriptionLabel(subscription: ProfileSubscriptionRecord): string {
  let selector = subscription.agentSelectorJson;
  try {
    const parsed = JSON.parse(subscription.agentSelectorJson) as {
      kind?: string;
      value?: unknown;
    };
    if (parsed && typeof parsed.kind === "string") {
      selector =
        parsed.value === undefined ? parsed.kind : `${parsed.kind}:${String(parsed.value)}`;
    }
  } catch {
    // raw JSON is the honest fallback
  }
  let workspace = subscription.workspaceSelectorJson;
  try {
    const parsed = JSON.parse(subscription.workspaceSelectorJson) as {
      herdrSession?: string;
      workspaceId?: string;
    };
    if (
      parsed &&
      typeof parsed.herdrSession === "string" &&
      typeof parsed.workspaceId === "string"
    ) {
      workspace = `${parsed.herdrSession}/${parsed.workspaceId}`;
    }
  } catch {
    // raw JSON is the honest fallback
  }
  return `${selector} @ ${workspace}`;
}

export { describeSelector };
