import type { AgentStore } from "@/db/agents.js";
import type { DeliveryObligationStore, Obligation } from "@/db/delivery-obligations.js";
import type { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import type { ProfileOwnerStore } from "@/db/profile-owners.js";
import type { AgentEventRecord } from "./contracts.js";
import {
  parseAgentSelector,
  parseWorkspaceSelector,
  resolveAgentSelector,
  selectableFromRow,
} from "./profile-selectors.js";

/**
 * Phase 3 — profile delivery service (vault §9.2, §6.2).
 *
 * Projection: every observed agent event becomes at most one obligation per
 * matching subscription (idempotent on (profile, agent_event)). Delivery:
 * the owner leases a batch, the harness wake renders it, ack retires it —
 * at least once until acknowledged, exactly once per active lease, ordering
 * preserved by agent_event_id. Unacknowledged outcomes survive daemon
 * restart by construction: they live in SQLite, not memory (§6.2.2).
 */
export class ProfileDeliveryService {
  readonly #agents: AgentStore;
  readonly #obligations: DeliveryObligationStore;
  readonly #owners: ProfileOwnerStore;
  readonly #profiles: OrchestratorProfileStore;

  constructor(options: {
    agents: AgentStore;
    obligations: DeliveryObligationStore;
    owners: ProfileOwnerStore;
    profiles: OrchestratorProfileStore;
  }) {
    this.#agents = options.agents;
    this.#obligations = options.obligations;
    this.#owners = options.owners;
    this.#profiles = options.profiles;
  }

  /** Project one agent event into obligations for every matching subscription. */
  projectAgentEvent(event: AgentEventRecord): void {
    if (!event.agentId) return;
    const agentRows = this.#agents
      .list({ herdrSessionName: event.herdrSessionName })
      .filter((row) => row.id === event.agentId);
    const [agentRow] = agentRows;
    if (!agentRow) return;
    const agent = selectableFromRow({
      agent: agentRow.agent,
      agentSessionJson: agentRow.agentSession ? JSON.stringify(agentRow.agentSession) : null,
      cwd: agentRow.cwd,
      herdrSessionName: agentRow.herdrSessionName,
      id: agentRow.id,
      name: agentRow.name,
      paneId: agentRow.paneId,
      terminalId: agentRow.terminalId,
      workspaceId: agentRow.workspaceId,
    });
    for (const profile of this.#profiles.listProfiles()) {
      for (const subscription of this.#profiles.listSubscriptions(profile.profileId)) {
        if (!subscription.enabled) continue;
        const workspace = parseWorkspaceSelector(subscription.workspaceSelectorJson);
        if ("error" in workspace) continue;
        // Structural scope first (§6.1.2): exact session + workspace.
        if (workspace.herdrSession !== event.herdrSessionName) continue;
        if (workspace.workspaceId !== event.workspaceId) continue;
        const selector = parseAgentSelector(subscription.agentSelectorJson);
        if ("error" in selector) continue;
        const resolution = resolveAgentSelector(selector, [agent]);
        if (resolution.kind !== "matched") continue;
        this.#obligations.project({
          agentEventId: event.id,
          profileId: profile.profileId,
          subscriptionId: subscription.id,
        });
      }
    }
  }

  // ── Owner surface ─────────────────────────────────────────────────────

  claim(input: Parameters<ProfileOwnerStore["claim"]>[0]) {
    return this.#owners.claim(input);
  }

  renew(input: { leaseToken: string; profileId: string }) {
    return this.#owners.renew(input);
  }

  release(input: { leaseToken: string; profileId: string }) {
    return this.#owners.release(input);
  }

  owner(profileId: string) {
    return this.#owners.get(profileId);
  }

  // ── Inbox surface (the Phase 4 bridge consumes exactly this) ──────────

  /** Expire stranded leases, then lease the oldest pending batch. */
  inboxLease(input: { leaseToken: string; maxBatch?: number; now?: number; profileId: string }): {
    expired: number;
    obligations: Obligation[];
  } {
    const sweep = this.#obligations.sweepExpired({
      ...(input.now !== undefined ? { now: input.now } : {}),
      profileId: input.profileId,
    });
    const batch = this.#obligations.pendingBatch({
      limit: input.maxBatch ?? 20,
      ...(input.now !== undefined ? { now: input.now } : {}),
      profileId: input.profileId,
    });
    if (batch.length === 0) return { expired: sweep.expired + sweep.deadLettered, obligations: [] };
    this.#obligations.leaseBatch({
      expiresAt: (input.now ?? Date.now()) + 2 * 60_000,
      ids: batch.map((obligation) => obligation.id),
      leaseToken: input.leaseToken,
      ...(input.now !== undefined ? { now: input.now } : {}),
      profileId: input.profileId,
    });
    const leased = this.#obligations
      .list({ limit: input.maxBatch ?? 20, profileId: input.profileId, state: "leased" })
      .filter((obligation) => obligation.leaseToken === input.leaseToken)
      .sort((a, b) => a.agentEventId - b.agentEventId);
    return { expired: sweep.expired + sweep.deadLettered, obligations: leased };
  }

  inboxDelivered(input: {
    harnessTurnId?: string | null;
    ids: string[];
    leaseToken: string;
    ownerSessionRefJson: string;
  }) {
    return { delivered: this.#obligations.markDelivered(input) };
  }

  inboxAck(input: { ids: string[]; leaseToken: string; profileId: string }) {
    return this.#obligations.ack(input);
  }

  inboxNack(input: { errorCode: string; ids: string[]; leaseToken: string; summary?: string }) {
    return this.#obligations.nack(input);
  }

  inboxList(input: { limit?: number; profileId: string; state?: Obligation["state"] }) {
    return this.#obligations.list(input);
  }

  retry(obligationId: string) {
    return this.#obligations.retry(obligationId);
  }
}
