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

  /** Operator retry: dead_letter → pending, attempts reset (§7.1 inbox retry). */
  retry(id: string): boolean {
    const result = this.#sqlite
      .prepare(
        `update delivery_obligations set state = 'pending', attempt_count = 0, last_error_code = null
				 where id = ? and state = 'dead_letter'`,
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

  list(input: { limit?: number; profileId: string; state?: ObligationState }): Obligation[] {
    const params: Array<string | number> = [input.profileId];
    let stateFilter = "";
    if (input.state) {
      stateFilter = " and state = ?";
      params.push(input.state);
    }
    params.push(input.limit ?? 50);
    const rows = this.#sqlite
      .prepare(
        `select * from delivery_obligations where profile_id = ?${stateFilter} order by agent_event_id desc limit ?`,
      )
      .all(...params) as ObligationRow[];
    return rows.map(toObligation);
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
