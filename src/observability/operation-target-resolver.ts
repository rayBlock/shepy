import type { OperationTarget } from "@/db/operations.js";
import type { SubscriptionResolution } from "./profile-service.js";

/**
 * Task 3 — fail-closed dispatch target resolution (orchestration plan).
 *
 * Takes a profile's subscription resolutions (from ProfileService) and
 * reduces them to EXACTLY ONE dispatchable target. Every other shape is a
 * named failure. There is no first-match, no focused-pane, and no
 * any-agent fallback — dispatching a prompt to the wrong pane is the
 * failure this module exists to make impossible.
 */
export type DispatchTargetResolution =
  | { kind: "ok"; target: OperationTarget }
  | { kind: "unmatched"; detail: string }
  | {
      kind: "ambiguous";
      candidates: Array<{ id: string; name: string | null; paneId: string }>;
      detail: string;
    }
  | { kind: "unstable_target"; detail: string }
  | { kind: "target_lost"; detail: string }
  | { kind: "invalid"; detail: string };

export function resolveDispatchTarget(
  resolutions: SubscriptionResolution[],
): DispatchTargetResolution {
  if (resolutions.length === 0) {
    return {
      kind: "unmatched",
      detail: "no enabled subscription resolved to an agent for this profile",
    };
  }

  const matched = resolutions.filter(
    (resolution): resolution is Extract<SubscriptionResolution, { kind: "matched" }> =>
      resolution.kind === "matched",
  );

  // Surface structural problems before multiplicity: a broken selector or an
  // ambiguous subscription must report itself, not be masked by other rows.
  for (const resolution of resolutions) {
    if (resolution.kind === "invalid") {
      return { detail: resolution.detail, kind: "invalid" };
    }
  }
  for (const resolution of resolutions) {
    if (resolution.kind === "ambiguous") {
      return { candidates: resolution.candidates, detail: resolution.detail, kind: "ambiguous" };
    }
  }
  for (const resolution of resolutions) {
    if (resolution.kind === "unmatched") {
      return { detail: resolution.detail, kind: "unmatched" };
    }
  }

  if (matched.length === 0) {
    return {
      kind: "unmatched",
      detail: "no enabled subscription resolved to an agent for this profile",
    };
  }

  if (matched.length > 1) {
    const candidates = matched.map((resolution) => ({
      id: resolution.agent.id,
      name: resolution.agent.name,
      paneId: resolution.agent.paneId,
    }));
    return {
      candidates,
      detail: `profile has ${matched.length} matched subscriptions; a dispatch requires exactly one target`,
      kind: "ambiguous",
    };
  }

  const [firstMatched] = matched;
  if (!firstMatched) {
    return {
      kind: "unmatched",
      detail: "no enabled subscription resolved to an agent for this profile",
    };
  }

  const agent = firstMatched.agent;

  // The transport contract requires a stable agent session identity for
  // lifecycle correlation — without it a completion event can never be
  // attributed to this dispatch.
  if (!agent.agentSession || agent.agentSession.value.length === 0) {
    return {
      detail: `matched agent ${agent.paneId} has no stable agent session identity; cannot correlate a dispatch`,
      kind: "unstable_target",
    };
  }

  // A resolved row that is not a live agent state cannot receive a prompt.
  if (agent.agentStatus === "unknown") {
    return {
      detail: `matched agent ${agent.paneId} is not in a recognized running state`,
      kind: "target_lost",
    };
  }

  return {
    kind: "ok",
    target: {
      agentSession: agent.agentSession.value,
      herdrSessionName: agent.herdrSessionName,
      paneId: agent.paneId,
      terminalId: agent.terminalId,
      workspaceId: agent.workspaceId,
    },
  };
}
