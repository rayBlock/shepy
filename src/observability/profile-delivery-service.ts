import { stripVTControlCharacters } from "node:util";
import type { AgentEventStore } from "@/db/agent-events.js";
import type { AgentStore } from "@/db/agents.js";
import type { DeliveryObligationStore, Obligation } from "@/db/delivery-obligations.js";
import type { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import type { ProfileOwnerStore } from "@/db/profile-owners.js";
import {
  type ClaimResult,
  isLeaseAlive,
  type PublicProfileOwner,
  toPublicProfileOwner,
} from "@/db/profile-owners.js";
import type { AgentEventRecord, AgentEventType } from "./contracts.js";
import type { ProfileDemandService } from "./profile-demand-service.js";
import { resolveSelectorInWorkspaceScope } from "./profile-selector-scope.js";
import { parseAgentSelector, parseWorkspaceSelector } from "./profile-selectors.js";
import { RpcRefusedError } from "./rpc-refused-error.js";

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
 * Bounded untrusted excerpt cap for leased outcomes — mirrors the
 * orchestrator wake path (wake.ts AGENT_UPDATE_EXCERPT_CHARS).
 */
export const INBOX_OUTCOME_EXCERPT_CHARS = 2_000;

/**
 * A classified inbox.lease refusal. The RPC envelope serialises `code`, so
 * callers can branch on the refusal kind without parsing prose:
 *  - `not_owner` — the presented token is not the active owner's (arbitrary
 *    string, or superseded by a re-claim). Nothing to recover; a new claim
 *    (or the expiry rule) decides who owns the profile.
 *  - `owner_lapsed` — the token MATCHES the row but the lease died past
 *    grace. The holder can recover: re-claim presenting the same token as
 *    proof of possession, then lease again with the fresh token (the hook's
 *    Stop does exactly that, once).
 */
export class InboxRefusedError extends RpcRefusedError {
  override readonly code: "not_owner" | "owner_lapsed";

  constructor(code: "not_owner" | "owner_lapsed", message: string) {
    super(code, message);
    this.name = "InboxRefusedError";
    this.code = code;
  }
}

/**
 * The immutable event snapshot a leased obligation refers to. Built ONLY
 * from the stored agent event (payload + append-time compact history), never
 * from a live history re-read — the excerpt is what the agent said at event
 * time, so a worker resuming afterwards can never rewrite the cause of a
 * wake. Only the last assistant message rides; tool bodies never do.
 */
export type InboxOutcomeSnapshot = {
  agent: string | null;
  createdAt: string;
  eventId: number;
  excerpt: { text: string; truncated: boolean } | null;
  from: string | null;
  /** Immutable append-time identity of the assistant final the event carried. */
  lastAssistantAt: string | null;
  lastAssistantRef: string | null;
  name: string | null;
  paneId: string | null;
  terminalId: string | null;
  to: string | null;
  type: string;
};

function outcomeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Same token rule the claude-hook uses for pane ids. The truncation hint
// interpolates the paneId into excerpt text that wakes and terminals render,
// so a hostile pane id (terminal-escape syntax, spoofed tokens) degrades to
// "unknown" instead of riding the served snapshot.
const PANE_ID_TOKEN = /^[a-z0-9][a-z0-9:_.-]{0,63}$/i;

function normalizeOutcomeExcerpt(value: unknown, paneId: string | null) {
  const raw = outcomeString(value);
  if (raw === null) return null;
  const normalized = stripVTControlCharacters(raw)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional C0/C1 stripping — untrusted agent excerpts must never carry control bytes into a wake.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) return { text: "", truncated: false };
  if (normalized.length <= INBOX_OUTCOME_EXCERPT_CHARS) {
    return { text: normalized, truncated: false };
  }
  const safePaneId = paneId !== null && PANE_ID_TOKEN.test(paneId) ? paneId : "unknown";
  const hint = ` … [truncated; run shepy agent read ${safePaneId}]`;
  const prefixLength = Math.max(0, INBOX_OUTCOME_EXCERPT_CHARS - hint.length);
  return {
    text: `${normalized.slice(0, prefixLength).trimEnd()}${hint}`,
    truncated: true,
  };
}

export function projectInboxOutcome(event: AgentEventRecord): InboxOutcomeSnapshot {
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : {};
  const lastAssistant = event.compactHistory?.lastAssistantMessage ?? null;
  return {
    agent: outcomeString(payload.agent),
    createdAt: event.createdAt.toISOString(),
    eventId: event.id,
    excerpt: normalizeOutcomeExcerpt(lastAssistant?.text, event.paneId),
    from: outcomeString(payload.from),
    lastAssistantAt: typeof lastAssistant?.timestamp === "string" ? lastAssistant.timestamp : null,
    lastAssistantRef: outcomeString(lastAssistant?.ref),
    name: outcomeString(payload.name),
    paneId: event.paneId,
    terminalId: event.terminalId,
    to: outcomeString(payload.to),
    type: event.type,
  };
}

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
  readonly #demands: ProfileDemandService | undefined;
  readonly #agentEvents: AgentEventStore | undefined;
  readonly #now: () => number;
  readonly #obligations: DeliveryObligationStore;
  readonly #owners: ProfileOwnerStore;
  readonly #profiles: OrchestratorProfileStore;

  constructor(options: {
    agentEvents?: AgentEventStore;
    demands?: ProfileDemandService;
    agents: AgentStore;
    /** The clock the lease-admission fence reads when a call does not pass
     * `now` explicitly. Must be the same clock the owners store was built
     * with — claim, renew and lease must judge liveness at one instant. */
    now?: () => number;
    obligations: DeliveryObligationStore;
    owners: ProfileOwnerStore;
    profiles: OrchestratorProfileStore;
  }) {
    this.#agents = options.agents;
    this.#demands = options.demands;
    this.#agentEvents = options.agentEvents;
    this.#now = options.now ?? Date.now;
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
    // whether the completed tab has been seen. A within-settled transition is
    // suppressed ONLY with evidence it is the SAME outcome already recorded:
    // the append-time assistant reference must exactly match the agent's
    // prior settled event's reference. Herdr pane revisions do NOT prove
    // this (live workers stay at revision 1 across many completed turns).
    // Missing or changed evidence DELIVERS — a reconnect that missed the
    // intermediate working phase must never hide a genuine new completion,
    // and no evidence ever silently drops an event.
    const from =
      typeof event.payload === "object" && event.payload !== null && "from" in event.payload
        ? event.payload.from
        : null;
    if (
      (event.type === "agent.done" || event.type === "agent.idle") &&
      (from === "done" || from === "idle") &&
      this.#sameSettledOutcomeAsPrior(event)
    )
      return;
    // Short-circuit only: an event whose agent is absent from the live
    // index can never be projected below (no scoped candidate can name it).
    // The real gate is the scoped resolution + identity check per
    // subscription.
    const agentIndexed = this.#agents
      .list({ herdrSessionName: event.herdrSessionName })
      .some((row) => row.id === event.agentId);
    if (!agentIndexed) return;
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
        // Same scoped resolution the inspection path uses (§6.1.2/§7): the
        // candidate set is the subscription's exact session + workspace —
        // NEVER a single-element array built from this event's agent, which
        // could not be ambiguous and delivered inspection-ambiguous
        // selectors as a first match. Fail closed: only a unique match
        // naming THIS event's agent projects; ambiguous, unmatched, invalid
        // selector, and a unique match of a different in-scope agent do not.
        const resolution = resolveSelectorInWorkspaceScope({
          agents: this.#agents,
          selector,
          workspace,
        });
        if (resolution.kind !== "matched") continue;
        if (resolution.agent.id !== event.agentId) continue;
        this.#obligations.project({
          agentEventId: event.id,
          profileId: profile.profileId,
          subscriptionId: subscription.id,
        });
      }
    }
  }

  // ── Owner surface ─────────────────────────────────────────────────────

  claim(input: Parameters<ProfileOwnerStore["claim"]>[0]): ClaimResult {
    // A profile that does not exist can never receive anything, so a claim
    // on it must not mint a ghost owner no delivery can ever reach. The
    // check lives HERE, not in ProfileOwnerStore — the store is a plain
    // owners table with no knowledge of profiles; this service holds both
    // sides and answers the existence question before touching owners.
    if (!this.#profiles.getProfile(input.profileId)) {
      return { kind: "rejected", reason: "profile_not_found" };
    }
    return this.#owners.claim(input);
  }

  renew(input: { leaseToken: string; profileId: string }) {
    return this.#owners.renew(input);
  }

  release(input: { leaseToken: string; profileId: string }) {
    return this.#owners.release(input);
  }

  /** The active owner's public identity — never its lease token, which is
   * a capability only the holder may hold. Served over profile.owner. */
  owner(profileId: string): PublicProfileOwner | undefined {
    const owner = this.#owners.get(profileId);
    return owner ? toPublicProfileOwner(owner) : undefined;
  }

  // ── Inbox surface (the Phase 4 bridge consumes exactly this) ──────────

  /**
   * Expire stranded leases, then lease the oldest pending batch.
   *
   * Leasing is a mutation — it stamps rows, increments attempts and removes
   * the batch from every other harness's reach — so it is fenced to the
   * token that currently owns the profile. A stale token (superseded by a
   * re-claim) or an arbitrary string is refused outright (`not_owner`);
   * before this fence any presented token could pull a profile's pending
   * batch under itself, double-delivering it beside the legitimate owner's
   * pump. The fence is also the ONE liveness rule claim and renew use: a
   * token that still matches the row but whose lease died past grace is
   * refused `owner_lapsed` — claim would hand the profile to the next
   * claimant at this instant, so leasing must fail closed too, and the
   * lapsed holder's recovery is a proof-of-possession re-claim, not a
   * resurrection. Ack/delivered/nack need no such fence: they can only
   * touch rows already stamped with the presented token, so their authority
   * is the stamp, not live ownership (inboxAck documents the
   * superseded-token decision).
   */
  inboxLease(input: {
    leaseToken: string;
    maxBatch?: number;
    now?: number;
    profileId: string;
    sourceKinds?: ("agent" | "profile-demand")[];
  }) {
    const owner = this.#owners.get(input.profileId);
    if (!owner || owner.leaseToken !== input.leaseToken) {
      throw new InboxRefusedError(
        "not_owner",
        `inbox.lease refused: the presented lease token is not the active owner of profile ${input.profileId}`,
      );
    }
    if (!isLeaseAlive(owner, input.now ?? this.#now())) {
      throw new InboxRefusedError(
        "owner_lapsed",
        `inbox.lease refused: the lease of profile ${input.profileId} lapsed past lease + grace — re-claim the profile before leasing`,
      );
    }
    const sweep = this.#obligations.sweepExpired({
      ...(input.now !== undefined ? { now: input.now } : {}),
      profileId: input.profileId,
    });
    const kinds = input.sourceKinds ?? ["agent"];
    if (kinds.some((kind) => !owner.acceptedSourceKinds.includes(kind)))
      throw new InboxRefusedError(
        "not_owner",
        "inbox.lease refused: source capability not claimed",
      );
    const agentBatch = kinds.includes("agent")
      ? this.#obligations.pendingBatch({
          limit: input.maxBatch ?? 20,
          ...(input.now !== undefined ? { now: input.now } : {}),
          profileId: input.profileId,
        })
      : [];
    const demandBatch: Obligation[] = [];
    if (kinds.includes("profile-demand") && this.#demands) {
      const active = this.#demands.events.hasActiveDemand(input.profileId);
      for (const row of this.#obligations.pendingBatch({
        limit: input.maxBatch ?? 20,
        sourceKinds: ["profile-demand"],
        ...(input.now !== undefined ? { now: input.now } : {}),
        profileId: input.profileId,
      })) {
        if (active || demandBatch.length > 0) {
          this.#demands.events.withhold(row.id, "demand:single-wake-capacity");
        } else if (
          row.profileDemandEventId !== null &&
          this.#demands.evaluateLease({
            demandEventId: row.profileDemandEventId,
            obligationId: row.id,
            profileId: input.profileId,
          }).eligible
        )
          demandBatch.push(row);
      }
    }
    const batch = [...agentBatch, ...demandBatch]
      .sort((a, b) => a.deliverySeq - b.deliverySeq)
      .slice(0, input.maxBatch ?? 20);
    if (batch.length === 0) return { expired: sweep.expired + sweep.deadLettered, obligations: [] };
    this.#obligations.leaseBatch({
      expiresAt: (input.now ?? Date.now()) + 2 * 60_000,
      ids: batch.map((obligation) => obligation.id),
      leaseToken: input.leaseToken,
      ...(input.now !== undefined ? { now: input.now } : {}),
      profileId: input.profileId,
    });
    const leased = batch
      .flatMap((selected) => {
        const stamped = this.#obligations.byId(selected.id);
        return stamped?.state === "leased" && stamped.leaseToken === input.leaseToken
          ? [stamped]
          : [];
      })
      .sort((a, b) => a.deliverySeq - b.deliverySeq);
    // Lease fencing is untouched: enrichment is a read-only join onto the
    // already-leased rows. A missing historical event stays honest — the
    // obligation still leases, with a null snapshot and no invented source.
    const obligations = leased.map((obligation) =>
      obligation.profileDemandEventId !== null
        ? {
            ...obligation,
            sourceKind: "profile-demand" as const,
            outcome: null,
            demand: this.#demands?.snapshot(obligation.profileDemandEventId) ?? null,
          }
        : {
            ...this.#agentWire(obligation),
            outcome: this.#outcomeSnapshotFor(obligation.agentEventId),
          },
    );
    return { expired: sweep.expired + sweep.deadLettered, obligations };
  }

  /**
   * True only when BOTH the event and the agent's prior settled event carry
   * the same non-empty append-time assistant reference — the live incident
   * shape (working->done delivered, done->idle same final suppressed).
   * Any missing evidence (no store, no prior, null refs) returns false, so
   * the caller delivers. The comparison reads persisted events: a daemon
   * restart re-derives it from the same rows, no in-memory dedup.
   */
  #sameSettledOutcomeAsPrior(event: AgentEventRecord): boolean {
    if (!this.#agentEvents || !event.agentId) return false;
    const prior = this.#agentEvents.findPriorSettledEvent(event.agentId, event.id);
    const currentRef = event.compactHistory?.lastAssistantMessage?.ref ?? null;
    const priorRef = prior?.compactHistory?.lastAssistantMessage?.ref ?? null;
    return currentRef !== null && currentRef === priorRef;
  }

  #outcomeSnapshotFor(agentEventId: number | null): InboxOutcomeSnapshot | null {
    if (!this.#agentEvents || agentEventId === null) return null;
    try {
      return projectInboxOutcome(this.#agentEvents.get(agentEventId));
    } catch {
      return null;
    }
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

  /** Over-budget return — see DeliveryObligationStore.defer. */
  inboxDefer(input: { ids: string[]; leaseToken: string }) {
    return this.#obligations.defer(input);
  }

  /**
   * Read surface — and the token boundary for every obligation row that
   * leaves the daemon. inbox.list presents no credential at all, so no row
   * it serves may carry one: a lease token authenticates release/renew/
   * lease on its own, and this path is reachable by every daemon client.
   * deliveredHarnessTurnId is redacted for the same reason: the Pi owner
   * used to fill it with its subscriberId (F3-1's shorter takeover chain),
   * and it is the owner's own delivery correlation — no reader needs it.
   * The only read that may still carry a token is inboxLease, which serves
   * exclusively rows stamped with the token the caller itself presented.
   */
  inboxList(input: {
    before?: number;
    limit?: number;
    profileId: string;
    state?: Obligation["state"];
  }) {
    return this.#obligations.list(input).map((obligation) =>
      obligation.kind === "demand"
        ? {
            ...obligation,
            sourceKind: "profile-demand" as const,
            demand: obligation.profileDemandEventId
              ? (this.#demands?.snapshot(obligation.profileDemandEventId) ?? null)
              : null,
            deliveredHarnessTurnId: null as null,
            leaseToken: null as null,
          }
        : {
            ...this.#agentWire(obligation),
            deliveredHarnessTurnId: null as null,
            leaseToken: null as null,
          },
    );
  }

  /**
   * Single-obligation read for `shepy inbox get` — the read-back a deferred
   * outcome's stub points at. Same token boundary as inboxList: this path
   * presents no credential, so no row it serves may carry one (see the
   * comment there), and the event snapshot rides exactly as it does on the
   * lease — the immutable append-time excerpt, never a live re-read.
   */
  inboxGet(obligationId: string) {
    const obligation = this.#obligations.byId(obligationId);
    if (!obligation) return null;
    return {
      ...(obligation.kind === "demand" ? obligation : this.#agentWire(obligation)),
      deliveredHarnessTurnId: null as null,
      leaseToken: null as null,
      ...(obligation.profileDemandEventId !== null
        ? {
            sourceKind: "profile-demand" as const,
            demand: this.#demands?.snapshot(obligation.profileDemandEventId) ?? null,
            outcome: null,
          }
        : { outcome: this.#outcomeSnapshotFor(obligation.agentEventId) }),
    };
  }

  #agentWire(obligation: Obligation) {
    const {
      kind: _kind,
      profileDemandEventId: _demandId,
      deliverySeq: _seq,
      ...legacy
    } = obligation;
    if (obligation.kind !== "agent" || obligation.agentEventId === null)
      throw new Error("inbox:invalid-agent-obligation");
    return { ...legacy, agentEventId: obligation.agentEventId };
  }

  /** Operator retire — see DeliveryObligationStore.retire. */
  retire(input: { olderThan?: number; profileId: string }) {
    return this.#obligations.retire(input);
  }

  retry(obligationId: string) {
    return this.#obligations.retry(obligationId);
  }
}
