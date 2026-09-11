import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Phase 3 — profile owner store (vault §8.2). One active logical owner per
 * profile. A brief reconnect grace preserves the current owner; an explicit
 * claim by a new terminal replaces it and invalidates the old lease token.
 */

/**
 * Lease defaults shared by claim and renew (vault §8.2). Renew MUST derive
 * its expiry judgement from the same grace claim uses — the two paths decide
 * "is this lease alive" at the same instants, or a heartbeat could revive a
 * lease a claimant was entitled to take.
 */
const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_LEASE_GRACE_MS = 30_000;

export type OwnerRow = {
  claimed_at: number;
  harness_kind: string;
  harness_session_ref_json: string;
  herdr_session_name: string;
  last_seen_at: number;
  lease_expires_at: number;
  lease_token: string;
  pane_id: string;
  profile_id: string;
  subscriber_id: string;
  terminal_id: string;
  workspace_id: string | null;
};

export type ProfileOwner = {
  claimedAt: number;
  harnessKind: string;
  harnessSessionRefJson: string;
  herdrSessionName: string;
  lastSeenAt: number;
  leaseExpiresAt: number;
  leaseToken: string;
  paneId: string;
  profileId: string;
  subscriberId: string;
  terminalId: string;
  workspaceId: string | null;
};

/** A ProfileOwner with the lease token stripped — the shape that may leave
 * the daemon. The token authenticates release/renew/lease on its own, so
 * anyone it is handed to could act as (or evict) the owner; only the holder
 * it was minted for may ever see it. */
export type PublicProfileOwner = Omit<ProfileOwner, "leaseToken">;

export function toPublicProfileOwner(owner: ProfileOwner): PublicProfileOwner {
  const { leaseToken: _leaseToken, ...publicOwner } = owner;
  return publicOwner;
}

export type ClaimResult =
  | { kind: "claimed"; leaseToken: string; owner: ProfileOwner }
  | { kind: "reclaimed"; leaseToken: string; owner: ProfileOwner }
  | { kind: "rejected"; reason: "lease_active"; owner: PublicProfileOwner };

export class ProfileOwnerStore {
  readonly #sqlite: DatabaseSync;
  readonly #now: () => number;

  constructor(options: { now?: () => number; sqlite: DatabaseSync }) {
    this.#sqlite = options.sqlite;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Claim ownership. Rules (§8.2):
   *  - same subscriber re-claiming (reconnect) → new lease token, grace preserved;
   *  - a different subscriber may claim only after the current lease expired
   *    (the reconnect grace) — otherwise rejected with the active owner;
   *  - any successful claim invalidates the previous lease token.
   */
  claim(input: {
    graceMs?: number;
    harnessKind: string;
    harnessSessionRefJson: string;
    herdrSessionName: string;
    leaseMs?: number;
    paneId: string;
    profileId: string;
    subscriberId: string;
    terminalId: string;
    workspaceId?: string | null;
  }): ClaimResult {
    const now = this.#now();
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    const graceMs = input.graceMs ?? DEFAULT_LEASE_GRACE_MS;
    const existing = this.get(input.profileId);
    if (existing) {
      const sameSubscriber = existing.subscriberId === input.subscriberId;
      const leaseAlive = existing.leaseExpiresAt + graceMs > now;
      if (!sameSubscriber && leaseAlive) {
        // The active owner's identity is public; its token is not. A
        // rejected claimant must never receive the capability that
        // release() authenticates on.
        return { kind: "rejected", owner: toPublicProfileOwner(existing), reason: "lease_active" };
      }
    }
    const leaseToken = randomUUID();
    this.#sqlite
      .prepare(
        `insert into profile_owners (profile_id, subscriber_id, harness_kind, harness_session_ref_json,
					herdr_session_name, workspace_id, pane_id, terminal_id, lease_token, lease_expires_at, last_seen_at, claimed_at)
				 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 on conflict(profile_id) do update set subscriber_id = excluded.subscriber_id,
					harness_kind = excluded.harness_kind, harness_session_ref_json = excluded.harness_session_ref_json,
					herdr_session_name = excluded.herdr_session_name, workspace_id = excluded.workspace_id,
					pane_id = excluded.pane_id, terminal_id = excluded.terminal_id,
					lease_token = excluded.lease_token, lease_expires_at = excluded.lease_expires_at,
					last_seen_at = excluded.last_seen_at, claimed_at = excluded.claimed_at`,
      )
      .run(
        input.profileId,
        input.subscriberId,
        input.harnessKind,
        input.harnessSessionRefJson,
        input.herdrSessionName,
        input.workspaceId ?? null,
        input.paneId,
        input.terminalId,
        leaseToken,
        now + leaseMs,
        now,
        now,
      );
    const owner = this.get(input.profileId);
    if (!owner) throw new Error(`owner upsert failed to persist ${input.profileId}`);
    return {
      kind: existing ? "reclaimed" : "claimed",
      leaseToken,
      owner,
    };
  }

  get(profileId: string): ProfileOwner | undefined {
    const row = this.#sqlite
      .prepare("select * from profile_owners where profile_id = ?")
      .get(profileId) as OwnerRow | undefined;
    return row ? toOwner(row) : undefined;
  }

  /** Renewal heartbeat: only the current lease holder extends its lease. */
  renew(input: { leaseToken: string; profileId: string; leaseMs?: number }): boolean {
    const owner = this.get(input.profileId);
    if (!owner || owner.leaseToken !== input.leaseToken) return false;
    // A lease that already lapsed past lease + grace is dead even when
    // nobody contested the lapse: claim would hand the profile to the next
    // claimant at exactly this instant, so a returning owner's heartbeat
    // must fail closed — token equality alone would silently resurrect an
    // expired lease no sweeper ever removes.
    if (owner.leaseExpiresAt + DEFAULT_LEASE_GRACE_MS <= this.#now()) return false;
    const expiresAt = this.#now() + (input.leaseMs ?? DEFAULT_LEASE_MS);
    this.#sqlite
      .prepare(
        "update profile_owners set lease_expires_at = ?, last_seen_at = ? where profile_id = ?",
      )
      .run(expiresAt, this.#now(), input.profileId);
    return true;
  }

  release(input: { leaseToken: string; profileId: string }): boolean {
    const result = this.#sqlite
      .prepare("delete from profile_owners where profile_id = ? and lease_token = ?")
      .run(input.profileId, input.leaseToken);
    return result.changes > 0;
  }
}

function toOwner(row: OwnerRow): ProfileOwner {
  return {
    claimedAt: row.claimed_at,
    harnessKind: row.harness_kind,
    harnessSessionRefJson: row.harness_session_ref_json,
    herdrSessionName: row.herdr_session_name,
    lastSeenAt: row.last_seen_at,
    leaseExpiresAt: row.lease_expires_at,
    leaseToken: row.lease_token,
    paneId: row.pane_id,
    profileId: row.profile_id,
    subscriberId: row.subscriber_id,
    terminalId: row.terminal_id,
    workspaceId: row.workspace_id,
  };
}
