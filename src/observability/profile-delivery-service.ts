import type { AgentStore } from "@/db/agents.js";
import type { DeliveryObligationStore, Obligation } from "@/db/delivery-obligations.js";
import type { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import type { ProfileOwnerStore } from "@/db/profile-owners.js";
import type { AgentEventRecord, AgentEventType } from "./contracts.js";
import {
  parseAgentSelector,
  parseWorkspaceSelector,
  resolveAgentSelector,
  selectableFromRow,
} from "./profile-selectors.js";

/**
 * Event types that merit waking an owner (vault §9.1: an outcome is a
 * projection of events that *merits owner attention*).
 *
 * `agent.status.changed` is deliberately absent. Every status transition
 * appends that generic event, and transitions to blocked/done/idle append a
 * semantic twin alongside it — so projecting both wakes the owner twice for
 * one transition. The only transitions that produce a generic event *alone*
 * are those to `working` and `unknown`, and "an agent started working" is the
 * orchestrator's own dispatch taking effect, not news.
 *
 * Measured on the live backlog before this filter: of 224 pending
 * obligations, 97 were `agent.status.changed` — 96 of them transitions to
 * `working`. The remaining 127 were semantic and are unaffected.
 *
 * Known gap: a transition to `unknown` (agent lost) currently emits only the
 * generic event, so it no longer produces an obligation. Losing an agent is
 * arguably news; the right fix is a dedicated semantic event rather than
 * re-admitting the generic one, which would restore the double-wake.
 */
export const NOTIFIABLE_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set([
  "agent.blocked",
  "agent.done",
  "agent.idle",
  "agent.tool.failed",
]);

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
    // Filter at projection, not emission: the event log stays a complete
    // audit record, but only notifiable outcomes become owner obligations.
    if (!NOTIFIABLE_EVENT_TYPES.has(event.type)) return;
    // Herdr's done/idle are the same settled state, differing only in
    // whether the completed tab has been seen. Marking it seen is not a
    // second completion. Keep the audit event, but never wake for this UI
    // transition. working -> idle/done and blocked outcomes still project.
    const from =
      typeof event.payload === "object" && event.payload !== null && "from" in event.payload
        ? event.payload.from
        : null;
    if (
      (event.type === "agent.done" || event.type === "agent.idle") &&
      (from === "done" || from === "idle")
    )
      return;
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

  /** Operator retire — see DeliveryObligationStore.retire. */
  retire(input: { olderThan?: number; profileId: string }) {
    return this.#obligations.retire(input);
  }

  retry(obligationId: string) {
    return this.#obligations.retry(obligationId);
  }
}
