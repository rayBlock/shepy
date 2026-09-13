import type { DaemonInfo } from "@/daemon/daemon-identity.js";
import type { DeliveryObligationStore, QueueDiagnosis } from "@/db/delivery-obligations.js";
import {
  DEFAULT_LEASE_GRACE_MS,
  isLeaseAlive,
  type ProfileOwnerStore,
} from "@/db/profile-owners.js";
import type { ProfileService, SubscriptionResolution } from "./profile-service.js";

/**
 * RUN-20260913-04 D2 — `profile.diagnose`. One read-only report answering
 * "why did this outcome not reach its owner", so an operator no longer has
 * to join `profile show`, `profile owner`, `inbox list`, and daemon-state
 * guesswork by hand.
 *
 * Read-only means read-only: nothing here mutates a row, mints a token, or
 * sweeps a lease. It reuses `ProfileService.resolveSubscriptions` (never a
 * private re-implementation) and the ONE lease-liveness predicate
 * (`isLeaseAlive` + `DEFAULT_LEASE_GRACE_MS`) so its verdicts cannot drift
 * from claim/renew/lease. No lease token, subscriber id, or harness session
 * ref ever enters the report — the same public-identity rule as
 * `toPublicProfileOwner`.
 */

export type DiagnoseSeverity = "blocker" | "warning" | "info";

export type DiagnoseFinding = {
  code: string;
  hint: string;
  message: string;
  severity: DiagnoseSeverity;
};

export type DiagnosedSubscriptionResolution =
  | {
      agent: {
        agent: string | null;
        agentSession: string | null;
        agentStatus: string;
        name: string | null;
        paneId: string;
      };
      herdrSessionName: string;
      kind: "matched";
      workspaceId: string;
    }
  | { detail: string; kind: "unmatched" }
  | {
      candidates: Array<{ id: string; name: string | null; paneId: string }>;
      detail: string;
      kind: "ambiguous";
    }
  | { detail: string; kind: "invalid" };

export type DiagnosedSubscription = {
  enabled: boolean;
  id: number;
  /** null = disabled: resolveSubscriptions deliberately skips these. */
  resolution: DiagnosedSubscriptionResolution | null;
  selector: unknown;
};

export type DiagnosedOwner = {
  canWakeIdle: boolean | null;
  claimedAt: number;
  harnessKind: string;
  lastSeenAt: number;
  leaseExpiresAt: number;
  paneId: string;
  state: "valid" | "in_grace" | "lapsed";
  workspaceId: string | null;
};

export type ProfileDiagnoseReport = {
  daemon: DaemonInfo;
  findings: DiagnoseFinding[];
  owner: DiagnosedOwner | null;
  profile: {
    displayName: string;
    profileId: string;
    projectRoots: string[];
  } | null;
  queue: QueueDiagnosis;
  subscriptions: DiagnosedSubscription[];
};

/** The "silent owner" threshold: a wakeable owner that still leaves the
 * oldest pending outcome older than this is not draining its queue. */
export const PENDING_NOT_DRAINING_MS = 10 * 60_000;

function finding(
  severity: DiagnoseSeverity,
  code: string,
  message: string,
  hint: string,
): DiagnoseFinding {
  return { code, hint, message, severity };
}

function canWakeIdle(harnessKind: string): boolean | null {
  if (harnessKind === "pi") return true;
  if (harnessKind === "claude") return false;
  return null;
}

function describeResolution(resolution: SubscriptionResolution): DiagnosedSubscriptionResolution {
  if (resolution.kind === "matched") {
    return {
      agent: {
        agent: resolution.agent.agent,
        agentSession: resolution.agent.agentSession
          ? `${resolution.agent.agentSession.source}:${resolution.agent.agentSession.value}`
          : null,
        agentStatus: resolution.agent.agentStatus,
        name: resolution.agent.name,
        paneId: resolution.agent.paneId,
      },
      herdrSessionName: resolution.agent.herdrSessionName,
      kind: "matched",
      workspaceId: resolution.agent.workspaceId,
    };
  }
  if (resolution.kind === "ambiguous") {
    return { candidates: resolution.candidates, detail: resolution.detail, kind: "ambiguous" };
  }
  return { detail: resolution.detail, kind: resolution.kind };
}

export class ProfileDiagnoseService {
  readonly #daemonInfo: DaemonInfo;
  readonly #obligations: DeliveryObligationStore;
  readonly #owners: ProfileOwnerStore;
  readonly #profiles: ProfileService;

  constructor(options: {
    daemonInfo: DaemonInfo;
    obligations: DeliveryObligationStore;
    owners: ProfileOwnerStore;
    profiles: ProfileService;
  }) {
    this.#daemonInfo = options.daemonInfo;
    this.#obligations = options.obligations;
    this.#owners = options.owners;
    this.#profiles = options.profiles;
  }

  diagnose(input: {
    cliBuildStamp?: string;
    now?: number;
    profileId: string;
  }): ProfileDiagnoseReport {
    const now = input.now ?? Date.now();
    const profile = this.#profiles.getProfile(input.profileId) ?? null;
    const subscriptions = profile ? this.#profiles.listSubscriptions(input.profileId) : [];
    // The SAME resolution the inspection and dispatch paths see — never a
    // parallel implementation (design D2).
    const resolutions = profile ? this.#profiles.resolveSubscriptions(input.profileId) : [];
    const resolutionBySubscriptionId = new Map(
      resolutions.map((resolution) => [resolution.subscription.id, resolution]),
    );

    const findings: DiagnoseFinding[] = [];
    if (!profile) {
      findings.push(
        finding(
          "blocker",
          "profile_not_found",
          `no such profile: ${input.profileId}`,
          `create it with \`shepy profile ensure ${input.profileId} --roots <path>\``,
        ),
      );
    }

    if (input.cliBuildStamp !== undefined && this.#daemonInfo.buildStamp !== input.cliBuildStamp) {
      findings.push(
        finding(
          "warning",
          "daemon_version_skew",
          `the running daemon was built at ${this.#daemonInfo.buildStamp} but this CLI was built at ${input.cliBuildStamp} — the daemon may predate this build`,
          "`shepy daemon restart` to run the built code",
        ),
      );
    }

    // A nonexistent profile gets ONE blocker and no noise: every other
    // finding (no owner, subscriptions, queue pressure) presumes a profile
    // that could ever receive anything. The queue block still reads (all
    // zeros); the daemon section still answers for itself.
    if (!profile) {
      return {
        daemon: this.#daemonInfo,
        findings,
        owner: null,
        profile: null,
        queue: this.#obligations.diagnoseQueue({ now, profileId: input.profileId }),
        subscriptions: [],
      };
    }

    const enabledSubscriptions = subscriptions.filter((subscription) => subscription.enabled);
    if (enabledSubscriptions.length === 0) {
      findings.push(
        finding(
          "blocker",
          "no_enabled_subscription",
          "no enabled subscription: nothing can ever be delivered to this profile",
          `\`shepy profile subscribe ${input.profileId} --workspace <id> --name <name>\` to bind one`,
        ),
      );
    }

    for (const subscription of subscriptions) {
      const resolution = resolutionBySubscriptionId.get(subscription.id);
      if (!resolution) continue;
      if (resolution.kind === "matched") continue;
      const code =
        resolution.kind === "unmatched"
          ? "subscription_unmatched"
          : resolution.kind === "ambiguous"
            ? "subscription_ambiguous"
            : "subscription_invalid";
      findings.push(
        finding(
          "blocker",
          code,
          `subscription #${subscription.id} never matches: ${resolution.detail}`,
          `\`shepy profile show ${input.profileId}\` to inspect, \`shepy profile subscribe ${input.profileId} …\` to rebind`,
        ),
      );
    }

    const queue = this.#obligations.diagnoseQueue({ now, profileId: input.profileId });
    const pendingCount = queue.counts.pending;
    const owner = this.#owners.get(input.profileId) ?? null;
    let ownerState: DiagnosedOwner["state"] | null = null;
    if (owner) {
      // The ONE lease-liveness rule, at one instant — the same predicate
      // claim, renew, and inbox.lease judge by.
      ownerState =
        owner.leaseExpiresAt > now
          ? "valid"
          : isLeaseAlive(owner, now, DEFAULT_LEASE_GRACE_MS)
            ? "in_grace"
            : "lapsed";
    }
    const ownerReport: DiagnosedOwner | null = owner
      ? {
          canWakeIdle: canWakeIdle(owner.harnessKind),
          claimedAt: owner.claimedAt,
          harnessKind: owner.harnessKind,
          lastSeenAt: owner.lastSeenAt,
          leaseExpiresAt: owner.leaseExpiresAt,
          paneId: owner.paneId,
          state: ownerState ?? "lapsed",
          workspaceId: owner.workspaceId,
        }
      : null;

    if (!owner) {
      findings.push(
        finding(
          pendingCount > 0 ? "blocker" : "warning",
          "no_owner",
          pendingCount > 0
            ? `no owner is claimed for this profile; ${pendingCount} pending outcome(s) are waiting`
            : "no owner is claimed for this profile",
          `\`/shepy on ${input.profileId}\` in the owner pane, or claim from the Claude hook`,
        ),
      );
    } else {
      if (ownerState === "lapsed") {
        findings.push(
          finding(
            pendingCount > 0 ? "blocker" : "warning",
            "owner_lapsed",
            `the owner lease lapsed (expired ${new Date(owner.leaseExpiresAt).toISOString()}); the profile is claimable`,
            `re-claim: \`/shepy on ${input.profileId}\` or the Claude hook's proof-of-possession re-claim`,
          ),
        );
      }
      if (owner.harnessKind === "claude") {
        findings.push(
          finding(
            "info",
            "owner_cannot_wake_idle",
            "Claude owner: delivery happens on the owner's next prompt or stop, not while idle",
            "send the owner a prompt to drain the queue",
          ),
        );
      }
    }

    if (queue.counts.dead_letter > 0) {
      findings.push(
        finding(
          "warning",
          "dead_letters_present",
          `${queue.counts.dead_letter} outcome(s) are dead-lettered after exhausting delivery attempts`,
          `\`shepy inbox list ${input.profileId} --state dead_letter\`, then \`shepy inbox retry <id>\` to revive one`,
        ),
      );
    }

    if (queue.strandedLeases > 0) {
      findings.push(
        finding(
          "warning",
          "stranded_leases",
          `${queue.strandedLeases} leased/delivered row(s) are past their lease expiry`,
          "they return to pending on the next lease; if this persists, restart the daemon",
        ),
      );
    }

    if (
      queue.oldestPendingAgeMs !== null &&
      queue.oldestPendingAgeMs > PENDING_NOT_DRAINING_MS &&
      ownerReport?.state === "valid" &&
      ownerReport.canWakeIdle === true
    ) {
      findings.push(
        finding(
          "warning",
          "pending_not_draining",
          `oldest pending outcome is ${Math.round(queue.oldestPendingAgeMs / 60_000)} minute(s) old while a wakeable owner holds the profile — the silent-owner case`,
          `check the owner pane with \`shepy agent get ${ownerReport.paneId}\``,
        ),
      );
    }

    if (findings.length === 0) {
      findings.push(
        finding(
          "info",
          "healthy",
          "profile looks healthy: enabled subscription matched, owner live, queue draining",
          "no action needed",
        ),
      );
    }

    return {
      daemon: this.#daemonInfo,
      findings,
      owner: ownerReport,
      profile: profile
        ? {
            displayName: profile.displayName,
            profileId: profile.profileId,
            projectRoots: profile.projectRoots,
          }
        : null,
      queue,
      subscriptions: subscriptions.map((subscription) => ({
        enabled: subscription.enabled,
        id: subscription.id,
        resolution: subscription.enabled
          ? describeResolution(
              resolutionBySubscriptionId.get(subscription.id) ?? {
                detail: "no resolution produced",
                kind: "invalid",
                subscription,
              },
            )
          : null,
        selector: parseSelectorJson(subscription.agentSelectorJson),
      })),
    };
  }
}

function parseSelectorJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}
