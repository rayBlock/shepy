import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Phase 3 — profile owner store (vault §8.2). One active logical owner per
 * profile. A brief reconnect grace preserves the current owner; an explicit
 * claim by a new terminal replaces it and invalidates the old lease token.
 */

const DEFAULT_LEASE_MS = 5 * 60_000;
export const DEFAULT_LEASE_GRACE_MS = 30_000;

/**
 * The ONE lease-liveness rule (vault §8.2): a lease is alive strictly until
 * `lease_expires_at + grace`. Every path that decides "may this lease still
 * act" — claim's expiry rule, renew's fail-closed heartbeat, and the inbox
 * lease fence — must derive its answer from this predicate, at the same
 * instants, or one path could revive (or admit) a lease another path was
 * right to treat as dead. `graceMs` stays a parameter because claim already
 * exposed it; the other callers take the default.
 */
export function isLeaseAlive(
  owner: { leaseExpiresAt: number },
  now: number,
  graceMs: number = DEFAULT_LEASE_GRACE_MS,
): boolean {
  return owner.leaseExpiresAt + graceMs > now;
}

export type OwnerRow = {
  accepted_source_kinds_json: string;
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
  acceptedSourceKinds: ("agent" | "profile-demand")[];
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

/** A ProfileOwner with every capability stripped — the shape that may leave
 * the daemon. The lease token authenticates release/renew/lease on its own,
 * so anyone it is handed to could act as (or evict) the owner; only the
 * holder it was minted for may ever see it. The subscriberId and the
 * harness session ref are stripped too — NOT because they authenticate
 * anything any more (they do not: the re-claim proof is the daemon-minted
 * lease token, which no public surface serves), but because they are the
 * owner's private session identity and no reader needs them. Callers
 * display paneId/harnessKind/workspaceId; nothing else leaves the store. */
export type PublicProfileOwner = Omit<
  ProfileOwner,
  "harnessSessionRefJson" | "leaseToken" | "subscriberId"
>;

export function toPublicProfileOwner(owner: ProfileOwner): PublicProfileOwner {
  const {
    harnessSessionRefJson: _harnessSessionRefJson,
    leaseToken: _leaseToken,
    subscriberId: _subscriberId,
    ...publicOwner
  } = owner;
  return publicOwner;
}

export type ClaimResult =
  | { kind: "claimed"; leaseToken: string; owner: ProfileOwner }
  | { kind: "reclaimed"; leaseToken: string; owner: ProfileOwner }
  | { kind: "rejected"; reason: "lease_active"; owner: PublicProfileOwner }
  | { kind: "rejected"; reason: "profile_not_found" };

export class ProfileOwnerStore {
  readonly #sqlite: DatabaseSync;
  readonly #now: () => number;

  constructor(options: { now?: () => number; sqlite: DatabaseSync }) {
    this.#sqlite = options.sqlite;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Claim ownership. Rules (§8.2, as of the F3-1 fix):
   *  - a claim presenting the CURRENT lease token takes the fast path:
   *    proof of possession — the daemon minted that token and only gave it
   *    to the holder, so no amount of public metadata helps a rival;
   *  - any claim without the current token waits out the lease: rejected
   *    while `lease_expires_at + grace` is in the future, allowed once it
   *    has lapsed. Identity equality (subscriberId, session ref) proves
   *    NOTHING on its own — both halves are public or reconstructible from
   *    public RPC (the F3-1 takeover chain), so they authenticate nobody.
   *  - any successful claim invalidates the previous lease token.
   */
  claim(input: {
    /** The lease token the claimant currently holds, if any. MUST equal the
     * live owner's token to take the fast path; omitted or stale means the
     * expiry rule applies. This is the re-claim proof of possession. */
    currentLeaseToken?: string;
    acceptedSourceKinds?: ("agent" | "profile-demand")[];
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
      // Proof of possession, not proof of identity: the subscriber id and
      // the harness session ref are deliberately excluded from this check
      // because both are public by design (agent rows serve session refs;
      // the reviewer reconstructed the whole credential from two
      // unauthenticated reads). Only the token the daemon minted for the
      // current holder authenticates a same-lease re-claim. Identity is
      // not even an additional requirement: a holder that legitimately
      // lost its identity halves (e.g. a hook whose persisted token
      // outlives its session id) must still take the fast path.
      const holdsLease =
        input.currentLeaseToken !== undefined && input.currentLeaseToken === existing.leaseToken;
      const leaseAlive = isLeaseAlive(existing, now, graceMs);
      if (!holdsLease && leaseAlive) {
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
					herdr_session_name, workspace_id, pane_id, terminal_id, lease_token, lease_expires_at, last_seen_at, claimed_at, accepted_source_kinds_json)
				 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 on conflict(profile_id) do update set subscriber_id = excluded.subscriber_id,
					harness_kind = excluded.harness_kind, harness_session_ref_json = excluded.harness_session_ref_json,
					herdr_session_name = excluded.herdr_session_name, workspace_id = excluded.workspace_id,
					pane_id = excluded.pane_id, terminal_id = excluded.terminal_id,
					lease_token = excluded.lease_token, lease_expires_at = excluded.lease_expires_at,
					last_seen_at = excluded.last_seen_at, claimed_at = excluded.claimed_at,
                    accepted_source_kinds_json = excluded.accepted_source_kinds_json`,
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
        JSON.stringify(input.acceptedSourceKinds ?? ["agent"]),
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
    // expired lease no sweeper ever removes. Same predicate as claim: the
    // two paths must agree at every instant.
    if (!isLeaseAlive(owner, this.#now())) return false;
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
  const kinds: unknown = JSON.parse(row.accepted_source_kinds_json);
  if (
    !Array.isArray(kinds) ||
    !kinds.every((kind) => kind === "agent" || kind === "profile-demand")
  )
    throw new Error("owner:invalid-source-capability");
  return {
    acceptedSourceKinds: kinds,
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
