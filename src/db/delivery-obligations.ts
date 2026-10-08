import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Phase 3 — delivery obligation store (vault §8.4, §9.2 state machine).
 *
 * Every transition is transactional. Explicit per-obligation rows — never a
 * max cursor — so partial batch failure, reconnects, and audit behavior stay
 * understandable. Lease expiry returns stranded `leased`/`delivered`
 * obligations to `pending` (with an attempt increment); bounded attempts
 * move permanent failures to `dead_letter`. Acknowledged rows are retained
 * for audit and may be pruned by later policy; pending rows may not.
 */

export const MAX_DELIVERY_ATTEMPTS = 5;

export type ObligationState = "pending" | "leased" | "delivered" | "acked" | "dead_letter";

export type ObligationRow = {
  acked_at: number | null;
  agent_event_id: number;
  attempt_count: number;
  created_at: number;
  delivered_at: number | null;
  delivered_harness_turn_id: string | null;
  delivered_owner_session_ref_json: string | null;
  id: string;
  last_error_code: string | null;
  last_error_summary: string | null;
  lease_expires_at: number | null;
  lease_token: string | null;
  profile_id: string;
  state: ObligationState;
  subscription_id: number;
};

export type Obligation = {
  ackedAt: number | null;
  agentEventId: number;
  attemptCount: number;
  createdAt: number;
  deliveredAt: number | null;
  deliveredHarnessTurnId: string | null;
  id: string;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  leaseExpiresAt: number | null;
  leaseToken: string | null;
  profileId: string;
  state: ObligationState;
  subscriptionId: number;
};

/** The queue half of a `profile.diagnose` report (RUN-20260913-04 D2):
 * counts, age/service extremes, stranded leases, and the newest row still
 * awaiting an ack. Deliberately secret-free: no lease tokens ride. */
export type QueueDiagnosis = {
  counts: Record<ObligationState, number>;
  lastAckedAt: number | null;
  lastDeliveredAt: number | null;
  maxPendingAttempts: number;
  newestUnacked: {
    attemptCount: number;
    id: string;
    lastErrorCode: string | null;
    lastErrorSummary: string | null;
    state: ObligationState;
  } | null;
  oldestPendingAgeMs: number | null;
  strandedLeases: number;
};

export class DeliveryObligationStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  /** Idempotent projection: one obligation per (profile, agent event). */
  project(input: {
    agentEventId: number;
    now?: number;
    profileId: string;
    subscriptionId: number;
  }): Obligation | undefined {
    this.#sqlite
      .prepare(
        `insert into delivery_obligations (id, profile_id, subscription_id, agent_event_id, state, attempt_count, created_at)
				 values (?, ?, ?, ?, 'pending', 0, ?)
				 on conflict(profile_id, agent_event_id) do nothing`,
      )
      .run(
        randomUUID(),
        input.profileId,
        input.subscriptionId,
        input.agentEventId,
        input.now ?? Date.now(),
      );
    return this.byProfileEvent(input.profileId, input.agentEventId);
  }

  byProfileEvent(profileId: string, agentEventId: number): Obligation | undefined {
    const row = this.#sqlite
      .prepare("select * from delivery_obligations where profile_id = ? and agent_event_id = ?")
      .get(profileId, agentEventId) as ObligationRow | undefined;
    return row ? toObligation(row) : undefined;
  }

  /** Single-obligation read for `inbox.get` — the deferred stub's read-back. */
  byId(id: string): Obligation | undefined {
    const row = this.#sqlite.prepare("select * from delivery_obligations where id = ?").get(id) as
      | ObligationRow
      | undefined;
    return row ? toObligation(row) : undefined;
  }

  /** Deliverable batch: pending rows plus expired leases, oldest first (§6.2.4/§9.3). */
  pendingBatch(input: { limit?: number; now?: number; profileId: string }): Obligation[] {
    const now = input.now ?? Date.now();
    const rows = this.#sqlite
      .prepare(
        `select * from delivery_obligations
				 where profile_id = ?
				   and (state = 'pending' or ((state = 'leased' or state = 'delivered') and lease_expires_at is not null and lease_expires_at < ?))
				 order by agent_event_id asc
				 limit ?`,
      )
      .all(input.profileId, now, input.limit ?? 20) as ObligationRow[];
    return rows.map(toObligation);
  }

  /** pending → leased, one lease owner, transactional. */
  leaseBatch(input: {
    expiresAt: number;
    ids: string[];
    leaseToken: string;
    now?: number;
    profileId: string;
  }): number {
    const now = input.now ?? Date.now();
    return this.#transaction(() => {
      let leased = 0;
      for (const id of input.ids) {
        const result = this.#sqlite
          .prepare(
            `update delivery_obligations
						 set state = 'leased', lease_token = ?, lease_expires_at = ?, attempt_count = attempt_count + 1
						 where id = ? and profile_id = ?
						   and (state = 'pending' or ((state = 'leased' or state = 'delivered') and lease_expires_at is not null and lease_expires_at < ?))`,
          )
          .run(input.leaseToken, input.expiresAt, id, input.profileId, now);
        leased += Number(result.changes);
      }
      return leased;
    });
  }

  /** leased → delivered: the harness accepted the wake. */
  markDelivered(input: {
    harnessTurnId?: string | null;
    ids: string[];
    leaseToken: string;
    ownerSessionRefJson: string;
  }): number {
    let delivered = 0;
    for (const id of input.ids) {
      const result = this.#sqlite
        .prepare(
          `update delivery_obligations
					 set state = 'delivered', delivered_at = ?, delivered_owner_session_ref_json = ?, delivered_harness_turn_id = ?
					 where id = ? and lease_token = ? and state = 'leased'`,
        )
        .run(
          Date.now(),
          input.ownerSessionRefJson,
          input.harnessTurnId ?? null,
          id,
          input.leaseToken,
        );
      delivered += Number(result.changes);
    }
    return delivered;
  }

  /**
   * leased/delivered → acked. Monotonic: acked never returns to pending; only
   * the lease owner may ack; ids not held by this lease are rejected (and
   * reported), never silently acked.
   */
  ack(input: { ids: string[]; leaseToken: string; profileId: string }): {
    acked: number;
    rejected: string[];
  } {
    const ackedAt = Date.now();
    return this.#transaction(() => {
      let acked = 0;
      const rejected: string[] = [];
      for (const id of input.ids) {
        const result = this.#sqlite
          .prepare(
            `update delivery_obligations
						 set state = 'acked', acked_at = ?
						 where id = ? and profile_id = ? and lease_token = ? and state in ('leased', 'delivered')`,
          )
          .run(ackedAt, id, input.profileId, input.leaseToken);
        if (Number(result.changes) > 0) acked += Number(result.changes);
        else rejected.push(id);
      }
      return { acked, rejected };
    });
  }

  /**
   * leased → pending WITHOUT burning a delivery attempt: the harness's
   * formatter could not represent these rows inside its budget, so nobody
   * ever saw them. attempt_count returns to its pre-lease value (floored at
   * zero — the lease-time increment is undone, not punished) and the deferral
   * is recorded as last_error_code, visible in inbox list but never counted
   * against MAX_DELIVERY_ATTEMPTS. Token-fenced exactly like nack, and only
   * rows still in `leased` move: a delivered row was represented and is the
   * ack path's business, not ours.
   */
  defer(input: { ids: string[]; leaseToken: string }): { deferred: number } {
    let deferred = 0;
    for (const id of input.ids) {
      const result = this.#sqlite
        .prepare(
          `update delivery_obligations
						 set state = 'pending', lease_token = null, lease_expires_at = null,
							     attempt_count = max(attempt_count - 1, 0),
							     last_error_code = 'deferred_over_budget'
						 where id = ? and lease_token = ? and state = 'leased'`,
        )
        .run(id, input.leaseToken);
      deferred += Number(result.changes);
    }
    return { deferred };
  }

  /** Failed/interrupted/disconnected → pending with the error recorded (§9.2). */
  nack(input: { errorCode: string; ids: string[]; leaseToken: string; summary?: string }): {
    nacked: number;
  } {
    let nacked = 0;
    for (const id of input.ids) {
      const result = this.#sqlite
        .prepare(
          `update delivery_obligations
					 set state = 'pending', lease_token = null, lease_expires_at = null,
					     last_error_code = ?, last_error_summary = ?
					 where id = ? and lease_token = ? and state in ('leased', 'delivered')`,
        )
        .run(input.errorCode, input.summary ?? null, id, input.leaseToken);
      nacked += Number(result.changes);
    }
    return { nacked };
  }

  /**
   * One-time startup invalidation of every live lease stamp (review F3-2).
   *
   * Per-row ack fencing (ack matches lease_token) only protects stamps made
   * by the fenced build. Rows stamped by the pre-fence, unfenced inbox.lease
   * — i.e. every production database at the moment this ships — remain
   * authoritative for a token that never belonged to any owner until their
   * 2-minute lease expires, letting it ack undelivered rows away and
   * suppress the owner's wakes. The daemon calls this ONCE at startup so no
   * pre-upgrade stamp survives the upgrade: leased and delivered rows return
   * to pending (attempt_count preserved — the cap still bounds) and are
   * re-delivered to the legitimate owner, never dropped.
   */
  invalidateAllLeases(): { invalidated: number } {
    return this.#transaction(() => {
      const invalidated = Number(
        this.#sqlite
          .prepare(
            `update delivery_obligations
						 set state = 'pending', lease_token = null, lease_expires_at = null,
						     last_error_code = coalesce(last_error_code, 'lease_invalidated_at_startup')
						 where state in ('leased', 'delivered')`,
          )
          .run().changes,
      );
      return { invalidated };
    });
  }

  /**
   * Expiry sweep: stranded leased/delivered past their lease → pending
   * (attempt already incremented at lease time); at MAX_DELIVERY_ATTEMPTS →
   * dead_letter with the expiry error recorded.
   */
  sweepExpired(input: { now?: number; profileId?: string }): {
    expired: number;
    deadLettered: number;
  } {
    const now = input.now ?? Date.now();
    return this.#transaction(() => {
      const scope = input.profileId ? "and profile_id = ?" : "";
      const params: Array<string | number> = input.profileId ? [now, input.profileId] : [now];
      const expired = Number(
        this.#sqlite
          .prepare(
            `update delivery_obligations
						 set state = 'pending', lease_token = null, lease_expires_at = null,
						     last_error_code = coalesce(last_error_code, 'lease_expired')
						 where (state = 'leased' or state = 'delivered') and lease_expires_at is not null and lease_expires_at < ?
						 ${scope}`,
          )
          .run(...params).changes,
      );
      const deadLettered = Number(
        this.#sqlite
          .prepare(
            `update delivery_obligations
						 set state = 'dead_letter', last_error_code = 'max_attempts'
						 where state = 'pending' and attempt_count >= ? ${scope}`,
          )
          .run(MAX_DELIVERY_ATTEMPTS, ...(input.profileId ? [input.profileId] : [])).changes,
      );
      return { deadLettered, expired };
    });
  }

  /**
   * Operator retry: dead_letter → pending with attempts reset, and pending →
   * pending with the error cleared (§7.1 inbox retry). The pending arm is the
   * on-demand verb for a stalled-but-healthy queue: a pending obligation is
   * already deliverable, so retry re-arms it (fresh attempt budget, no stale
   * error) and the live owner pump leases it on its next tick. It must NOT
   * touch leased/delivered/acked rows — those belong to an active lease or
   * the audit record, not to the operator.
   */
  retry(id: string): boolean {
    const result = this.#sqlite
      .prepare(
        `update delivery_obligations set state = 'pending', attempt_count = 0, last_error_code = null
				 where id = ? and state in ('pending', 'dead_letter')`,
      )
      .run(id);
    return result.changes > 0;
  }

  /**
   * Operator retire: pending | dead_letter → acked, without delivering.
   *
   * Distinct from `ack`, which requires the current owner's lease token and
   * means "the owner processed this." This means "an operator decided this no
   * longer merits delivery" — for a backlog that accumulated while a profile
   * had no owner and is now stale. It deliberately cannot touch `leased` or
   * `delivered` rows: those belong to an in-flight lease, and retiring one
   * under an active owner would race the ack path (§6.3.3).
   *
   * `olderThan` retires only obligations created strictly before that instant,
   * so an operator can drain a stale backlog without discarding fresh events
   * that arrive mid-command.
   */
  retire(input: { olderThan?: number; profileId: string }): { retired: number } {
    const params: Array<string | number> = [input.profileId];
    let ageFilter = "";
    if (input.olderThan !== undefined) {
      ageFilter = " and created_at < ?";
      params.push(input.olderThan);
    }
    const result = this.#sqlite
      .prepare(
        `update delivery_obligations set state = 'acked', acked_at = unixepoch() * 1000
				 where profile_id = ? and state in ('pending', 'dead_letter')${ageFilter}`,
      )
      .run(...params);
    return { retired: Number(result.changes) };
  }

  list(input: {
    before?: number;
    limit?: number;
    profileId: string;
    state?: ObligationState;
  }): Obligation[] {
    const params: Array<string | number> = [input.profileId];
    let filters = "";
    if (input.state) {
      filters += " and state = ?";
      params.push(input.state);
    }
    if (input.before !== undefined) {
      filters += " and agent_event_id < ?";
      params.push(input.before);
    }
    params.push(input.limit ?? 50);
    const rows = this.#sqlite
      .prepare(
        `select * from delivery_obligations where profile_id = ?${filters} order by agent_event_id desc limit ?`,
      )
      .all(...params) as ObligationRow[];
    return rows.map(toObligation);
  }

  /**
   * READ-ONLY aggregate for `profile.diagnose` (RUN-20260913-04 D2) — the
   * one store helper the diagnose path needed beyond the existing list/
   * read methods: counts, pending extremes, delivery/ack recency, stranded
   * leases, and the newest unacked row in three SELECTs. Writes nothing.
   */
  diagnoseQueue(input: { now?: number; profileId: string }): QueueDiagnosis {
    const now = input.now ?? Date.now();
    const totals = this.#sqlite
      .prepare(
        `select
           sum(case when state = 'pending' then 1 else 0 end) as pending,
           sum(case when state = 'leased' then 1 else 0 end) as leased,
           sum(case when state = 'delivered' then 1 else 0 end) as delivered,
           sum(case when state = 'acked' then 1 else 0 end) as acked,
           sum(case when state = 'dead_letter' then 1 else 0 end) as dead_letter,
           min(case when state = 'pending' then created_at end) as oldest_pending_at,
           max(case when state = 'pending' then attempt_count end) as max_pending_attempts,
           max(delivered_at) as last_delivered_at,
           max(acked_at) as last_acked_at
         from delivery_obligations where profile_id = ?`,
      )
      .get(input.profileId) as {
      acked: number | null;
      dead_letter: number | null;
      delivered: number | null;
      last_acked_at: number | null;
      last_delivered_at: number | null;
      leased: number | null;
      max_pending_attempts: number | null;
      oldest_pending_at: number | null;
      pending: number | null;
    };
    const strandedLeases = Number(
      (
        this.#sqlite
          .prepare(
            `select count(*) as n from delivery_obligations
           where profile_id = ? and state in ('leased', 'delivered')
             and lease_expires_at is not null and lease_expires_at < ?`,
          )
          .get(input.profileId, now) as { n: number }
      ).n,
    );
    const newestUnackedRow = this.#sqlite
      .prepare(
        `select * from delivery_obligations
         where profile_id = ? and state != 'acked'
         order by agent_event_id desc limit 1`,
      )
      .get(input.profileId) as ObligationRow | undefined;
    return {
      counts: {
        acked: Number(totals.acked ?? 0),
        dead_letter: Number(totals.dead_letter ?? 0),
        delivered: Number(totals.delivered ?? 0),
        leased: Number(totals.leased ?? 0),
        pending: Number(totals.pending ?? 0),
      },
      lastAckedAt: totals.last_acked_at,
      lastDeliveredAt: totals.last_delivered_at,
      maxPendingAttempts: Number(totals.max_pending_attempts ?? 0),
      newestUnacked: newestUnackedRow
        ? {
            attemptCount: newestUnackedRow.attempt_count,
            id: newestUnackedRow.id,
            lastErrorCode: newestUnackedRow.last_error_code,
            lastErrorSummary: newestUnackedRow.last_error_summary,
            state: newestUnackedRow.state,
          }
        : null,
      oldestPendingAgeMs:
        totals.oldest_pending_at === null ? null : Math.max(0, now - totals.oldest_pending_at),
      strandedLeases,
    };
  }

  #transaction<T>(body: () => T): T {
    this.#sqlite.prepare("begin").run();
    try {
      const result = body();
      this.#sqlite.prepare("commit").run();
      return result;
    } catch (error) {
      this.#sqlite.prepare("rollback").run();
      throw error;
    }
  }
}

function toObligation(row: ObligationRow): Obligation {
  return {
    ackedAt: row.acked_at,
    agentEventId: row.agent_event_id,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    deliveredHarnessTurnId: row.delivered_harness_turn_id,
    id: row.id,
    lastErrorCode: row.last_error_code,
    lastErrorSummary: row.last_error_summary,
    leaseExpiresAt: row.lease_expires_at,
    leaseToken: row.lease_token,
    profileId: row.profile_id,
    state: row.state,
    subscriptionId: row.subscription_id,
  };
}
