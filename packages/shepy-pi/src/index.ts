import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { agentIdentityLabel } from "./agent-display.js";
import { extensionBuild } from "./build-info.js";
import { readPulseLine } from "./pulse.js";
import {
  type AgentContextListItem,
  type AgentEventWireRecord,
  type AgentOrchestratorChanged,
  type AgentOrchestratorWireState,
  type AgentWorkspaceContextSnapshot,
  type DaemonStreamMessage,
  ReconnectingDaemonClient,
} from "./daemon-client.js";
import {
  type AgentUpdateMessageDetails,
  formatShepyFooterStatus,
  renderAgentUpdateMessage,
  type ShepyFooterState,
} from "./agent-update-ui.js";
import {
  formatAgentOutcomeUpdates,
  projectAgentOutcomes,
  WAKE_SETTLE_MS,
	formatProfileObligationUpdates,
	type ProfileObligationOutcome,
} from "./wake.js";

type PiAgentMessage = {
  content?: unknown;
  customType?: string;
  role?: string;
  [key: string]: unknown;
};

type AgentSessionRef = {
  agent: string;
  kind: "path";
  source: string;
  value: string;
};

type PiPresence = {
  connectedAt: number;
  herdrSessionName: string;
  paneId: string;
  subscriberId: string;
  terminalId: string;
  workspaceId: string;
};

type ConnectionStateResponse = {
  changed?: boolean;
  context?: AgentWorkspaceContextSnapshot | null;
  events?: AgentEventWireRecord[];
  presence: PiPresence;
  state: AgentOrchestratorWireState | null;
};

export type ShepyDaemonClient = {
  close(): void;
  onConnected: (() => Promise<void> | void) | undefined;
  onDisconnected: ((error: Error) => void) | undefined;
  onStreamMessage: ((message: DaemonStreamMessage) => void) | undefined;
  request(method: string, params: unknown): Promise<unknown>;
};

type CurrentScope = {
  herdrSessionName: string;
  paneId: string;
  terminalId: string;
  workspaceId: string;
};

type LaunchIdentity = {
  herdrSocketPath: string;
  paneId: string;
  workspaceId: string;
};

type DeliveredBatch = {
  assistantFinalSucceeded: boolean;
  events: AgentEventWireRecord[];
  invalidated: boolean;
  ownerTerminalId: string;
  shepyTriggered: boolean;
};

/** Phase 4 — profile-owner delivery batch (§10.3): one visible wake per lease.
 * `triggerQueued` is set ONLY after the wake message actually enqueued: a
 * batch whose trigger never queued must never be acked by an unrelated
 * user turn (message_end fires for those too). */
type ProfileBatch = {
  assistantFinalSucceeded: boolean;
  invalidated: boolean;
  obligationIds: string[];
  profileId: string;
  shepyTriggered: boolean;
  triggerQueued: boolean;
  /** Set by the context hook when a run's LLM context actually contained
   * the wake message — the consumption witness that gates acknowledgement. */
  wakeConsumed: boolean;
};

type ShepyState = {
  client: ShepyDaemonClient | undefined;
  connected: boolean;
  currentScope: CurrentScope | undefined;
  deliveredBatch: DeliveredBatch | undefined;
  failedWakeThroughEventId: number;
  isOrchestrator: boolean;
  launchIdentity: LaunchIdentity | undefined;
  latestContext: AgentWorkspaceContextSnapshot | undefined;
  pendingEvents: AgentEventWireRecord[];
  pinnedContext: AgentWorkspaceContextSnapshot | undefined;
  profileBatch: ProfileBatch | undefined;
  profileMode: { leaseToken: string; pendingCount: number; profileId: string } | undefined;
  /** Pump tick currently awaiting an RPC, keyed by its mode's lease token —
   * prevents a second tick from double-leasing while one lease is in flight. */
  profilePumpInFlight: { leaseToken: string; profileId: string } | undefined;
  profileTimer: ReturnType<typeof setInterval> | undefined;
  reconnectingFromOn: boolean;
  registrationInFlight: Promise<void> | undefined;
  runActive: boolean;
  roleMutationInFlight: boolean;
  sessionRef: AgentSessionRef | undefined;
  subscriberId: string | undefined;
  wakeDeferredUntilSettled: boolean;
  wakeRequested: boolean;
  wakeRequestedThroughEventId: number;
  wakeTimer: ReturnType<typeof setTimeout> | undefined;
};

type PiContext = {
  abort?: () => void;
  isIdle?: () => boolean;
  sessionManager: { getSessionFile(): string; getSessionId(): string };
  ui: {
    notify?: (message: string, level?: "error" | "info" | "warning") => void;
    setStatus?: (key: string, value?: string) => void;
    theme: {
      bg(color: string, text: string): string;
      bold(text: string): string;
      fg(color: string, text: string): string;
    };
  };
};

type CommandOptions = {
  description: string;
  getArgumentCompletions?(prefix: string): Array<{ label: string; value: string }> | null;
  handler(args: string, ctx: PiContext): Promise<void>;
};

/** Transcript-facing results for the shepy_profile tool. The claim's lease
 * token is a capability and must NEVER ride in these — tool content lands in
 * the model's transcript. */
export type ShepyProfileClaimResult =
  | { kind: "claimed"; profileId: string }
  | { kind: "reclaimed"; profileId: string }
  | {
      kind: "rejected";
      owner: { harnessKind: string; paneId: string } | undefined;
      profileId: string;
      /** The daemon's rejection reason when it sent one — "lease_active"
       * (a live owner holds it) or "profile_not_found" (no such profile;
       * permanent misconfiguration, not a lease to wait out). */
      reason?: string;
    }
  | { kind: "blocked"; profileId: string; reason: string };

export type ShepyProfileReleaseResult =
  | { kind: "released"; profileId: string }
  | { kind: "not_owned" };

export type ShepyProfileStatusResult = {
  connected: boolean;
  kind: "status";
  owned: boolean;
  pendingCount?: number | undefined;
  profileId?: string | undefined;
};

/** The context the profile-owner path actually touches. Both the command
 * handler's PiContext and a tool execute()'s ExtensionContext satisfy it, so
 * /shepy on and shepy_profile share the claim logic without casts. */
type ProfileActionContext = {
  isIdle?: () => boolean;
  ui: {
    notify?: (message: string, level?: "error" | "info" | "warning") => void;
    setStatus?: (key: string, value?: string) => void;
  };
};

type PiApi = {
  appendEntry?: (customType: string, data: unknown) => void;
  on: (eventName: string, handler: (...args: any[]) => unknown) => void;
  registerCommand?: (name: string, options: CommandOptions) => void;
  registerMessageRenderer?: (
    customType: string,
    renderer: typeof renderAgentUpdateMessage,
  ) => void;
  registerTool?: (tool: ToolDefinition) => void;
  sendMessage?: (
    message: { content: string; customType: string; details?: unknown; display: boolean },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ) => void;
  setSessionName?: (name: string) => void;
};

type ExtensionOptions = {
  clientFactory?: () => ShepyDaemonClient;
};

const DEFAULT_HOME_NAME = ".shepy";
const COMMAND_USAGE = "Usage: /shepy [on|off|status]";
const HERDR_REQUIRED_MESSAGE = "Shepy requires a Herdr workspace";
const RECONNECTING_MESSAGE = "Shepy is reconnecting · try again shortly";

function defaultShepyHome() {
  return process.env.SHEPY_HOME || `${process.env.HOME || ""}/${DEFAULT_HOME_NAME}`;
}

export function defaultSocketPath() {
  return `${defaultShepyHome().replace(/\/$/, "")}/shepy.sock`;
}

export function createShepyPiExtension(options: ExtensionOptions = {}) {
  return function shepyPiExtension(pi: PiApi): void {
    pi.registerMessageRenderer?.("shepy-wake", renderAgentUpdateMessage);

    const state: ShepyState = {
      client: undefined,
      connected: false,
      currentScope: undefined,
      deliveredBatch: undefined,
      failedWakeThroughEventId: 0,
      isOrchestrator: false,
      launchIdentity: undefined,
      latestContext: undefined,
      pendingEvents: [],
      pinnedContext: undefined,
      profileBatch: undefined,
      profileMode: undefined,
      profilePumpInFlight: undefined,
      profileTimer: undefined,
      reconnectingFromOn: false,
      registrationInFlight: undefined,
      roleMutationInFlight: false,
      runActive: false,
      sessionRef: undefined,
      subscriberId: undefined,
      wakeDeferredUntilSettled: false,
      wakeRequested: false,
      wakeRequestedThroughEventId: 0,
      wakeTimer: undefined,
    };
    let activeContext: PiContext | undefined;
    let wakeGeneration = 0;

    const setShepyUi = (ctx: ProfileActionContext | undefined) => {
      if (!ctx) return;
      const footerState: ShepyFooterState = state.reconnectingFromOn
        ? { kind: "reconnecting" }
        : state.profileMode
          ? {
              kind: "profile",
              pendingCount: state.profileMode.pendingCount,
              profileId: state.profileMode.profileId,
            }
          : state.isOrchestrator
          ? {
              kind: "on",
              updateCount: projectAgentOutcomes(state.pendingEvents).outcomes.length,
            }
          : { kind: "off" };
      ctx.ui.setStatus?.("shepy", formatShepyFooterStatus(footerState));
    };

    const cancelWakeTimer = () => {
      wakeGeneration += 1;
      if (state.wakeTimer) clearTimeout(state.wakeTimer);
      state.wakeTimer = undefined;
      state.wakeDeferredUntilSettled = false;
    };

    const cancelWake = () => {
      cancelWakeTimer();
      state.wakeRequested = false;
      state.wakeRequestedThroughEventId = 0;
    };

    const wakeLabel = (count: number) => {
      if (count > 0) return `Shepy received ${count} agent update${count === 1 ? "" : "s"}.`;
      const pulse = readPulseLine();
      return pulse ? `Shepy: no updates · factory pulse: ${pulse}` : "Shepy: no updates.";
    };

    const clearAgentContext = () => {
      state.latestContext = undefined;
      state.pinnedContext = undefined;
      state.runActive = false;
    };

    const applyOwnerContext = (response: ConnectionStateResponse) => {
      state.latestContext = isLocalOwner(response) ? response.context ?? undefined : undefined;
    };

    const scheduleWake = (ctx: PiContext | undefined) => {
      if (!ctx || !state.isOrchestrator || !state.currentScope || !pi.sendMessage) return;
      const outcomes = projectAgentOutcomes(state.pendingEvents).outcomes;
      const wakeable = outcomes.filter(
        (outcome) => outcome.eventId > state.failedWakeThroughEventId,
      );
      if (wakeable.length === 0 || state.wakeTimer || state.wakeRequested) return;
      // Blocked is an authoritative Herdr state transition: do not hold it
      // behind the routine turn-end coalescing window. Keep the same owner,
      // idle, delivery and acknowledgement fences as every other wake.
      const immediate = wakeable.some((outcome) => outcome.kind === "blocked");
      if (state.deliveredBatch || ctx.isIdle?.() === false) {
        state.wakeDeferredUntilSettled = true;
        return;
      }
      const generation = wakeGeneration;
      const ownerHerdrSessionName = state.currentScope.herdrSessionName;
      const ownerTerminalId = state.currentScope.terminalId;
      const ownerWorkspaceId = state.currentScope.workspaceId;
      state.wakeTimer = setTimeout(() => {
        const startWake = async () => {
          if (
            generation !== wakeGeneration ||
            !state.isOrchestrator ||
            state.currentScope?.herdrSessionName !== ownerHerdrSessionName ||
            state.currentScope?.terminalId !== ownerTerminalId ||
            state.currentScope?.workspaceId !== ownerWorkspaceId
          ) {
            state.wakeTimer = undefined;
            return;
          }
          if (ctx.isIdle?.() === false) {
            state.wakeTimer = undefined;
            state.wakeDeferredUntilSettled = true;
            return;
          }

          const requestedThroughEventId = wakeable.at(-1)?.eventId ?? 0;
          try {
            const response = (await state.client?.request(
              "agent.orchestrator.get",
              {},
            )) as ConnectionStateResponse | undefined;
            if (!response) {
              state.wakeTimer = undefined;
              return;
            }
            applyConnectionStateResponse(response, ctx);
          } catch {
            state.wakeTimer = undefined;
            state.failedWakeThroughEventId = Math.max(
              state.failedWakeThroughEventId,
              requestedThroughEventId,
            );
            ctx.ui.notify?.(
              "Shepy couldn’t load agent updates · updates remain pending",
              "warning",
            );
            return;
          }

          if (
            generation !== wakeGeneration ||
            !state.isOrchestrator ||
            state.currentScope?.herdrSessionName !== ownerHerdrSessionName ||
            state.currentScope?.terminalId !== ownerTerminalId ||
            state.currentScope?.workspaceId !== ownerWorkspaceId
          ) {
            state.wakeTimer = undefined;
            return;
          }
          if (ctx.isIdle?.() === false) {
            state.wakeTimer = undefined;
            state.wakeDeferredUntilSettled = true;
            return;
          }

          const current = projectAgentOutcomes(state.pendingEvents).outcomes.filter(
            (outcome) => outcome.eventId > state.failedWakeThroughEventId,
          );
          if (current.length === 0) {
            state.wakeTimer = undefined;
            return;
          }
          const batchEvents = [...state.pendingEvents].sort((left, right) => left.id - right.id);
          const batchOutcomes = projectAgentOutcomes(batchEvents).outcomes;
          state.deliveredBatch = {
            assistantFinalSucceeded: false,
            events: batchEvents,
            invalidated: false,
            ownerTerminalId,
            shepyTriggered: true,
          };
          state.wakeTimer = undefined;
          state.wakeRequested = true;
          state.wakeRequestedThroughEventId = current.at(-1)?.eventId ?? 0;
          pi.sendMessage?.(
            {
              content: formatAgentOutcomeUpdates(batchOutcomes),
              customType: "shepy-wake-context",
              details: { eventIds: batchEvents.map((event) => event.id) },
              display: false,
            },
            { deliverAs: "followUp" },
          );
          pi.sendMessage?.(
            {
              content: wakeLabel(current.length),
              customType: "shepy-wake",
              details: {
                build: extensionBuild,
                eventIds: current.map((outcome) => outcome.eventId),
                outcomes: current,
                ...(() => { const p = readPulseLine(); return p ? { pulse: p } : {}; })(),
              } satisfies AgentUpdateMessageDetails,
              display: true,
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
          state.wakeRequested = false;
          state.wakeRequestedThroughEventId = 0;
        };
        void startWake();
      }, immediate ? 0 : WAKE_SETTLE_MS);
    };

    const loseRole = (ctx: PiContext | undefined) => {
      if (state.deliveredBatch) {
        state.deliveredBatch.invalidated = true;
        const lastEventId = state.deliveredBatch.events.at(-1)?.id;
        if (lastEventId !== undefined) {
          state.failedWakeThroughEventId = Math.max(
            state.failedWakeThroughEventId,
            lastEventId,
          );
        }
        if (state.deliveredBatch.shepyTriggered) ctx?.abort?.();
      }
      if (state.wakeRequestedThroughEventId > 0) {
        state.failedWakeThroughEventId = Math.max(
          state.failedWakeThroughEventId,
          state.wakeRequestedThroughEventId,
        );
      }
      cancelWake();
      clearAgentContext();
      state.isOrchestrator = false;
      state.pendingEvents = [];
      state.reconnectingFromOn = false;
      setShepyUi(ctx);
    };

    const markDisconnected = (ctx: PiContext | undefined) => {
      const reconnectingFromOn = state.reconnectingFromOn || state.isOrchestrator;
      loseRole(ctx);
      state.reconnectingFromOn = reconnectingFromOn;
      setShepyUi(ctx);
    };

    const resetForScopeChange = (ctx: PiContext | undefined) => {
      clearAgentContext();
      if (state.deliveredBatch?.shepyTriggered) ctx?.abort?.();
      if (state.deliveredBatch) state.deliveredBatch.invalidated = true;
      state.deliveredBatch = undefined;
      cancelWake();
      state.failedWakeThroughEventId = 0;
      state.pendingEvents = [];
      setShepyUi(ctx);
    };

    // ── Phase 4: profile-owner mode (vault §10.3) ─────────────────────────
    // One claimed profile per Pi; the inbox pump leases the oldest pending
    // obligations, delivers ONE visible wake per lease, and acks only after a
    // successful final + settle. Failures nack; obligations stay durable.
    const stopProfileTimer = () => {
      if (state.profileTimer) clearInterval(state.profileTimer);
      state.profileTimer = undefined;
    };

    const releaseProfile = async (
      ctx: ProfileActionContext | undefined,
    ): Promise<ShepyProfileReleaseResult> => {
      const mode = state.profileMode;
      stopProfileTimer();
      state.profileMode = undefined;
      if (state.profileBatch) state.profileBatch.invalidated = true;
      state.profileBatch = undefined;
      if (mode && state.client && state.connected) {
        try {
          await state.client.request("profile.release", { leaseToken: mode.leaseToken, profileId: mode.profileId });
        } catch {
          // lease expiry reclaims it server-side; nothing to preserve locally
        }
      }
      setShepyUi(ctx);
      if (!mode) return { kind: "not_owned" };
      return { kind: "released", profileId: mode.profileId };
    };

    /**
     * Lapse recovery for the pump heartbeat. `renew` fails closed once a
     * lease lapses past grace (same predicate as claim), and the daemon's
     * documented recovery for the returning holder is the
     * proof-of-possession re-claim: `profile.claim` presenting the CURRENT
     * lease token takes the fast path even past expiry, while a token
     * superseded by a rival still rejects `lease_active`. Automating that
     * re-claim adds no capability a rival could use — the token already is
     * the capability — so the F3-1 fence stays intact. Outcomes:
     * - claimed/reclaimed with a fresh token → install it, keep pumping
     *   (delivery resumes; obligations were never lost, only unleased);
     * - rejected (rival owns the profile now) → undefined, pump stops;
     * - transport error → return the stale mode: fail-closed downstream,
     *   next tick retries renew → recovery.
     * Revalidates against the live mode before installing, so a concurrent
     * explicit claim (/shepy on, env re-claim) is never clobbered.
     */
    const recoverLapsedLease = async (
      mode: { leaseToken: string; pendingCount: number; profileId: string },
      ctx: ProfileActionContext | undefined,
    ): Promise<{ leaseToken: string; pendingCount: number; profileId: string } | undefined> => {
      const client = state.client;
      const launchIdentity = state.launchIdentity;
      if (!client || !launchIdentity || !state.subscriberId || !state.sessionRef) return undefined;
      try {
        const claim = (await client.request("profile.claim", {
          currentLeaseToken: mode.leaseToken,
          harnessKind: "pi",
          harnessSessionRefJson: JSON.stringify(state.sessionRef),
          herdrSessionName: state.currentScope?.herdrSessionName ?? "default",
          paneId: launchIdentity.paneId,
          profileId: mode.profileId,
          subscriberId: state.subscriberId,
          terminalId: launchIdentity.paneId,
          workspaceId: launchIdentity.workspaceId,
        })) as { result?: { kind?: string; leaseToken?: string } };
        const result = claim.result ?? {};
        if (
          (result.kind === "claimed" || result.kind === "reclaimed") &&
          result.leaseToken &&
          state.profileMode?.profileId === mode.profileId &&
          state.profileMode.leaseToken === mode.leaseToken
        ) {
          state.profileMode = {
            leaseToken: result.leaseToken,
            pendingCount: mode.pendingCount,
            profileId: mode.profileId,
          };
          ctx?.ui.notify?.(
            `Shepy · profile ${mode.profileId} lease recovered after a lapse — delivery resumes`,
            "info",
          );
          setShepyUi(ctx);
          return state.profileMode;
        }
        return undefined;
      } catch {
        return mode;
      }
    };

    const startProfilePump = (ctx: ProfileActionContext | undefined) => {
      stopProfileTimer();
      state.profileTimer = setInterval(() => void pumpProfile(activeContext ?? ctx), 10_000);
      void pumpProfile(ctx);
    };

    const pumpProfile = async (ctx: ProfileActionContext | undefined) => {
      let mode = state.profileMode;
      if (!mode || !state.client || !state.connected) return;
      // Heartbeat FIRST, before every work gate: a busy owner (wake in
      // flight, user run active) must keep renewing, or any run longer than
      // the lease would let another subscriber claim a perfectly alive
      // owner's profile. `renewed:false` splits into two cases: a token that
      // no longer matches the owner row means ownership genuinely moved on
      // (stop, below); a token that still matches is a LAPSE — the lease
      // died past grace (daemon outage, suspended pane) — and the daemon's
      // documented recovery is the proof-of-possession re-claim, which the
      // lapse-recovery helper below automates once per tick. Pre-fix, every
      // lapse permanently killed the pump while projection kept minting
      // pending-0 obligations — the 2026-10-08 delivery stall. The cleanup
      // revalidates first: this tick's captured mode may already be STALE —
      // a same-profile re-claim (env re-claim on reconnect, /shepy on, the
      // tool) can install a new lease while our renew is in flight, and the
      // FIFO daemon then answers the stale renew renewed:false AFTER the
      // newer claim — and two overlapping stale ticks must not clean up (or
      // notify) twice.
      try {
        const renew = (await state.client.request("profile.renew", {
          leaseToken: mode.leaseToken,
          profileId: mode.profileId,
        })) as { renewed?: boolean };
        if (renew.renewed === false) {
          const stillCurrent =
            state.profileMode?.profileId === mode.profileId &&
            state.profileMode.leaseToken === mode.leaseToken;
          if (!stillCurrent) return;
          const recovered = await recoverLapsedLease(mode, ctx);
          if (!recovered) {
            stopProfileTimer();
            state.profileMode = undefined;
            if (state.profileBatch) state.profileBatch.invalidated = true;
            ctx?.ui.notify?.(`Shepy · profile ${mode.profileId} ownership lost`, "warning");
            setShepyUi(ctx);
            return;
          }
          if (recovered.leaseToken !== mode.leaseToken) {
            mode = recovered;
          } else {
            // The re-claim transport failed this tick: keep the lapsed mode
            // and fall through — the daemon refuses lapsed leases (fail
            // closed), and the next tick retries renew → recovery.
          }
        }
      } catch {
        // transient daemon error: the timer retries; the lease stays as-is
      }
      if (state.profileBatch || state.deliveredBatch) return;
      if (state.runActive || ctx?.isIdle?.() === false) return;
      // Serialize ticks per (profile, lease): while one lease RPC is in
      // flight, a later tick for the SAME mode must skip — otherwise two
      // awaited leases double-lease and one batch strands until expiry.
      // A tick for a DIFFERENT mode proceeds; the older pump self-exits via
      // the stillOwner revalidation below.
      if (
        state.profilePumpInFlight?.leaseToken === mode.leaseToken &&
        state.profilePumpInFlight.profileId === mode.profileId
      ) {
        return;
      }
      state.profilePumpInFlight = { leaseToken: mode.leaseToken, profileId: mode.profileId };
      try {
        await pumpProfileOwned(mode, ctx);
      } finally {
        if (
          state.profilePumpInFlight?.leaseToken === mode.leaseToken &&
          state.profilePumpInFlight.profileId === mode.profileId
        ) {
          state.profilePumpInFlight = undefined;
        }
      }
    };

    /**
     * Boundary behaviour (Pi extension API, docs/extensions.md):
     * - `sendMessage({deliverAs:"followUp"})` ENQUEUES; enqueue alone proves
     *   nothing about delivery. Acknowledgement therefore requires the
     *   CONSUMPTION WITNESS: the `context` hook fires before each LLM call
     *   with the full message list, and a run whose context contains the
     *   wake message (matched by obligation ids) proves the content reached
     *   a model call. A queued follow-up that is aborted before consumption
     *   (Escape restores it to the editor) never witnesses, never acks —
     *   it is nacked and redelivered. No completion is silently lost.
     * - Residual boundary, stated precisely: the witness proves inclusion in
     *   the LLM input of a run that ended with a successful final — not that
     *   the model acted on the content. The extension API exposes no
     *   stronger per-message delivery signal.
     * - Ownership and busyness can change across ANY await (off,
     *   replacement, scope movement, a user run starting). stillOwner plus a
     *   post-lease run recheck re-derive from live state at each resume; a
     *   stale or busy resolution is nacked durably (wake_failed / owner_busy),
     *   never enqueued, never ackable.
     */
    const pumpProfileOwned = async (
      mode: { leaseToken: string; pendingCount: number; profileId: string },
      ctx: ProfileActionContext | undefined,
    ) => {
      const client = state.client;
      if (!client) return;
      const stillOwner = () =>
        state.connected &&
        state.profileMode?.profileId === mode.profileId &&
        state.profileMode.leaseToken === mode.leaseToken &&
        !state.profileBatch &&
        !state.deliveredBatch;
      const nackStaleLease = async (ids: string[], errorCode: string) => {
        try {
          await client.request("inbox.nack", {
            errorCode,
            ids,
            leaseToken: mode.leaseToken,
          });
        } catch {
          // lease expiry recovers server-side
        }
      };
      try {
        const lease = (await client.request("inbox.lease", {
          leaseToken: mode.leaseToken,
          maxBatch: 20,
          profileId: mode.profileId,
        })) as {
          obligations?: Array<{
            agentEventId: number;
            id: string;
            outcome?: ProfileObligationOutcome | null;
          }>;
        };
        const obligations = lease.obligations ?? [];
        if (obligations.length === 0) {
          if (stillOwner()) {
            state.profileMode = { ...mode, pendingCount: 0 };
            setShepyUi(ctx);
          }
          return;
        }
        const ids = obligations.map((obligation) => obligation.id);
        // The await above is the hazard window: ownership may have moved
        // (off, replacement, scope change) or a normal user run may have
        // started while the lease was in flight. A lease returned to a
        // former owner must never enqueue, and a busy owner defers — the
        // wake must not ride behind an unrelated run it cannot witness.
        // Both paths nack durably so a later idle pump redelivers.
        if (!stillOwner()) {
          await nackStaleLease(ids, "wake_failed");
          return;
        }
        if (state.runActive || ctx?.isIdle?.() === false) {
          await nackStaleLease(ids, "owner_busy");
          return;
        }
        state.profileMode = { ...mode, pendingCount: obligations.length };
        setShepyUi(ctx);
        // Correlation BEFORE delivery: everything the owner sees is built
        // from the LEASED events' immutable snapshots joined onto the lease.
        // Current profile history (profile.context) is never read as outcome
        // truth — it can attribute the wake to the wrong worker or drift
        // after the event fired.
        const content = formatProfileObligationUpdates(
          obligations.map((obligation) => ({
            agentEventId: obligation.agentEventId,
            obligationId: obligation.id,
            outcome: obligation.outcome ?? null,
          })),
        );
        const nackBatch = async () => {
          try {
            await client.request("inbox.nack", {
              errorCode: "wake_failed",
              ids,
              leaseToken: mode.leaseToken,
            });
          } catch {
            // lease expiry recovers server-side
          }
          ctx?.ui.notify?.(
            "Shepy couldn’t display profile updates · they remain pending",
            "warning",
          );
        };
        if (!pi.sendMessage) {
          await nackBatch();
          return;
        }
        try {
          pi.sendMessage(
            {
              content,
              customType: "shepy-wake-context",
              details: { obligationIds: ids, profileId: mode.profileId },
              display: false,
            },
            { deliverAs: "followUp" },
          );
          pi.sendMessage(
            {
              content: `Shepy · profile ${mode.profileId}: ${obligations.length} agent update(s) delivered — review the shepy context above and continue.`,
              customType: "shepy-wake",
              details: {
                build: extensionBuild,
                obligationIds: ids,
                profileId: mode.profileId,
                ...(() => { const p = readPulseLine(); return p ? { pulse: p } : {}; })(),
              },
              display: true,
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        } catch {
          // The wake was never displayed and its trigger never queued: the
          // obligations are NOT delivered and must NOT be ackable by an
          // unrelated user turn. Durable nack + no local batch, so the next
          // pump cycle redelivers instead of stranding here forever.
          await nackBatch();
          return;
        }
        state.profileBatch = {
          assistantFinalSucceeded: false,
          invalidated: false,
          obligationIds: ids,
          profileId: mode.profileId,
          shepyTriggered: true,
          triggerQueued: true,
          wakeConsumed: false,
        };
        // Correlation id for the daemon's own bookkeeping. NEVER the
        // subscriber id: deliveredHarnessTurnId rides on inbox.list rows
        // (unauthenticated), and the subscriber id is a re-claim credential
        // half — the F3-1 shorter chain read it straight off the listing.
        // A digest of the batch's obligation ids identifies this delivery
        // turn without identifying the subscriber.
        const harnessTurnId = createHash("sha256")
          .update([...ids].sort().join("\n"))
          .digest("hex")
          .slice(0, 24);
        try {
          await client.request("inbox.delivered", {
            harnessTurnId,
            ids,
            leaseToken: mode.leaseToken,
            ownerSessionRefJson: JSON.stringify(state.sessionRef ?? {}),
          });
        } catch {
          // The wake already displayed and triggered. markDelivered is
          // bookkeeping, not a precondition: the batch stays ackable from the
          // leased state at settle, and this failure must not strand the
          // pump (the old code got permanently stuck here).
          ctx?.ui.notify?.(
            "Shepy couldn’t mark updates delivered · acknowledgement continues at settle",
            "warning",
          );
        }
      } catch {
        // transient daemon error: the timer retries; obligations stay pending
      }
    };

    const addPendingEvents = (events: AgentEventWireRecord[], ctx: PiContext | undefined) => {
      const byId = new Map(state.pendingEvents.map((event) => [event.id, event]));
      for (const event of events) byId.set(event.id, event);
      state.pendingEvents = [...byId.values()].sort((left, right) => left.id - right.id);
      setShepyUi(ctx);
    };

    const applyConnectionStateResponse = (
      response: ConnectionStateResponse,
      ctx: PiContext | undefined,
      options: { notifyReconnectLoss?: boolean } = {},
    ) => {
      const reconnectingOwner = options.notifyReconnectLoss && state.reconnectingFromOn;
      const scopeChanged =
        state.currentScope !== undefined &&
        (state.currentScope.herdrSessionName !== response.presence.herdrSessionName ||
          state.currentScope.workspaceId !== response.presence.workspaceId);
      if (scopeChanged) resetForScopeChange(ctx);
      state.currentScope = {
        herdrSessionName: response.presence.herdrSessionName,
        paneId: response.presence.paneId,
        terminalId: response.presence.terminalId,
        workspaceId: response.presence.workspaceId,
      };
      const isOwner = isLocalOwner(response);
      if (!isOwner) {
        loseRole(ctx);
        if (reconnectingOwner) {
          ctx?.ui.notify?.(
            response.state?.owner
              ? `Shepy is off · moved to ${response.state.owner.paneId}`
              : "Shepy is off",
            "info",
          );
        }
        return;
      }
      state.isOrchestrator = true;
      state.reconnectingFromOn = false;
      applyOwnerContext(response);
      setShepyUi(ctx);
      addPendingEvents(response.events ?? [], ctx);
      scheduleWake(ctx);
    };

    const handleAgentEvent = (event: AgentEventWireRecord, ctx: PiContext | undefined) => {
      if (!state.isOrchestrator || !state.currentScope || !event.terminalId) return;
      if (event.terminalId === state.currentScope.terminalId) return;
      addPendingEvents([event], ctx);
      pi.appendEntry?.("shepy.agent_event", event);
      // A routine outcome may have started a 500 ms lease window. A blocked
      // transition arriving inside it promotes that same pending batch now.
      if (event.type === "agent.blocked" && state.wakeTimer) cancelWakeTimer();
      scheduleWake(ctx);
    };

    const refreshAfterRoleGain = async (ctx: PiContext | undefined) => {
      if (!state.client || !state.connected) return;
      try {
        const response = (await state.client.request(
          "agent.orchestrator.get",
          {},
        )) as ConnectionStateResponse;
        applyConnectionStateResponse(response, ctx);
      } catch {
        // Reconnect handling owns transport failures.
      }
    };

    const handleRoleChange = (change: AgentOrchestratorChanged, ctx: PiContext | undefined) => {
      const terminalId = state.currentScope?.terminalId;
      if (!terminalId) return;
      const wasOwner = change.previous.owner?.terminalId === terminalId;
      const isOwner = change.current.owner?.terminalId === terminalId;
      if (isOwner && change.current.owner) {
        const scopeChanged =
          state.currentScope?.herdrSessionName !== change.current.herdrSessionName ||
          state.currentScope?.workspaceId !== change.current.workspaceId;
        if (scopeChanged) resetForScopeChange(ctx);
        state.currentScope = {
          herdrSessionName: change.current.herdrSessionName,
          paneId: change.current.owner.paneId,
          terminalId,
          workspaceId: change.current.workspaceId,
        };
        const gainedRole = !state.isOrchestrator;
        state.isOrchestrator = true;
        state.reconnectingFromOn = false;
        setShepyUi(ctx);
        if (gainedRole || scopeChanged) void refreshAfterRoleGain(ctx);
        return;
      }
      if (!wasOwner) return;
      state.currentScope = {
        herdrSessionName: change.current.herdrSessionName,
        paneId: state.currentScope?.paneId ?? change.previous.owner?.paneId ?? "unknown",
        terminalId,
        workspaceId: change.current.workspaceId,
      };
      loseRole(ctx);
      if (!state.roleMutationInFlight) {
        ctx?.ui.notify?.(
          change.current.owner
            ? `Shepy is off · moved to ${change.current.owner.paneId}`
            : "Shepy is off",
          "info",
        );
      }
    };

    const handleStreamMessage = (message: DaemonStreamMessage) => {
      if (message.method === "agent.event") {
        handleAgentEvent(message.params.event, activeContext);
        return;
      }
      if (message.method === "agent.context.changed") {
        if (
          state.isOrchestrator &&
          state.currentScope?.herdrSessionName === message.params.herdrSessionName &&
          state.currentScope.workspaceId === message.params.workspaceId
        ) {
          state.latestContext = message.params.context ?? undefined;
        }
        return;
      }
      handleRoleChange(message.params.change, activeContext);
    };

    const registerPresence = (ctx: PiContext): Promise<void> => {
      if (state.registrationInFlight) return state.registrationInFlight;
      const client = state.client;
      const launchIdentity = state.launchIdentity;
      const subscriberId = state.subscriberId;
      const sessionRef = state.sessionRef;
      if (!client || !launchIdentity || !subscriberId) return Promise.resolve();
      if (!sessionRef?.value) {
        return Promise.reject(new Error("Pi session file is unavailable for Shepy presence"));
      }
      const registration = client
        .request("agent.orchestrator.register", {
          herdrSocketPath: launchIdentity.herdrSocketPath,
          paneId: state.currentScope?.paneId ?? launchIdentity.paneId,
          sessionRef,
          subscriberId,
          subscriberKind: "pi",
          workspaceId: state.currentScope?.workspaceId ?? launchIdentity.workspaceId,
        })
        .then((response) => {
          state.connected = true;
          applyConnectionStateResponse(response as ConnectionStateResponse, ctx, {
            notifyReconnectLoss: true,
          });
        })
        .catch((error) => {
          state.connected = false;
          markDisconnected(ctx);
          throw error;
        })
        .finally(() => {
          state.registrationInFlight = undefined;
        });
      state.registrationInFlight = registration;
      return registration;
    };

    const handleProfileOn = async (
      profileId: string,
      ctx: ProfileActionContext,
    ): Promise<ShepyProfileClaimResult> => {
      if (!state.launchIdentity || !state.sessionRef || !state.subscriberId) {
        ctx.ui.notify?.(HERDR_REQUIRED_MESSAGE, "error");
        return { kind: "blocked", profileId, reason: HERDR_REQUIRED_MESSAGE };
      }
      if (!state.client || !state.connected) {
        ctx.ui.notify?.(RECONNECTING_MESSAGE, "warning");
        return { kind: "blocked", profileId, reason: RECONNECTING_MESSAGE };
      }
      try {
        state.roleMutationInFlight = true;
        // Proof of possession: a re-claim of the profile this pane already
        // owns presents the daemon-minted token it is still holding. Only
        // the exact current token takes the fast path — identity halves are
        // public by design and authenticate nothing — so a pane whose token
        // was lost (fresh process, evicted row) simply waits out the lease
        // like any rival instead of impersonating the owner.
        const currentLeaseToken =
          state.profileMode?.profileId === profileId ? state.profileMode.leaseToken : undefined;
        const claim = (await state.client.request("profile.claim", {
          ...(currentLeaseToken !== undefined ? { currentLeaseToken } : {}),
          harnessKind: "pi",
          harnessSessionRefJson: JSON.stringify(state.sessionRef),
          herdrSessionName: state.currentScope?.herdrSessionName ?? "default",
          paneId: state.launchIdentity.paneId,
          profileId,
          subscriberId: state.subscriberId,
          terminalId: state.launchIdentity.paneId,
          workspaceId: state.launchIdentity.workspaceId,
        })) as {
          result?: {
            kind?: string;
            leaseToken?: string;
            owner?: { harnessKind?: string; paneId?: string };
            reason?: string;
          };
        };
        const result = claim.result ?? {};
        if (result.kind !== "claimed" && result.kind !== "reclaimed") {
          const owner =
            result.owner?.paneId && result.owner.harnessKind
              ? { harnessKind: result.owner.harnessKind, paneId: result.owner.paneId }
              : undefined;
          if (result.reason === "profile_not_found") {
            // No such profile: there is no owner and no lease to wait out,
            // so the lease_active wording would point the operator at a
            // expiry that will never come. Name the actual problem.
            const reason = `Shepy profile claim rejected (profile_not_found) — no profile ${profileId} exists on this daemon; check the profile id`;
            ctx.ui.notify?.(reason, "error");
            return { kind: "rejected", owner: undefined, profileId, reason: "profile_not_found" };
          }
          ctx.ui.notify?.(
            `Shepy profile claim rejected (${result.reason ?? result.kind ?? "unknown"}) — the active owner's lease must expire first`,
            "error",
          );
          return {
            kind: "rejected",
            owner,
            profileId,
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
          };
        }
        if (!result.leaseToken) {
          const reason = "Shepy profile claim returned no lease token";
          ctx.ui.notify?.(reason, "error");
          return { kind: "blocked", profileId, reason };
        }
        if (state.profileMode && state.profileMode.profileId !== profileId) {
          await releaseProfile(ctx);
        }
        state.profileMode = { leaseToken: result.leaseToken, pendingCount: 0, profileId };
        ctx.ui.notify?.(`Shepy · profile ${profileId} claimed`, "info");
        startProfilePump(ctx);
        return { kind: result.kind, profileId };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify?.(reason, "error");
        return { kind: "blocked", profileId, reason };
      } finally {
        state.roleMutationInFlight = false;
      }
    };

    pi.registerCommand?.("shepy", {
      description: "Watch Shepy agent updates in this Pi",
      getArgumentCompletions(prefix: string) {
        const items = ["on", "off", "status", "on <profileId>"]
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ label: value, value }));
        return items.length > 0 ? items : null;
      },
      handler: async (args: string, ctx: PiContext) => {
        const value = args.trim();
        const [firstToken, profileArg] = value.split(/\s+/, 2);
        const action = value === "" ? "status" : firstToken;
        if (action !== "on" && action !== "off" && action !== "status") {
          ctx.ui.notify?.(COMMAND_USAGE, "warning");
          return;
        }
        if (action === "on" && profileArg) {
          await handleProfileOn(profileArg, ctx);
          return;
        }
        if (action === "off" && state.profileMode) {
          void releaseProfile(ctx);
          ctx.ui.notify?.("Shepy profile released", "info");
          return;
        }
        if (!state.launchIdentity) {
          ctx.ui.notify?.(HERDR_REQUIRED_MESSAGE, "error");
          return;
        }
        if (!state.client || !state.connected || !state.currentScope) {
          ctx.ui.notify?.(RECONNECTING_MESSAGE, "warning");
          return;
        }
        try {
          if (action === "status") {
            const response = (await state.client.request(
              "agent.orchestrator.get",
              {},
            )) as ConnectionStateResponse;
            applyConnectionStateResponse(response, ctx);
            notifyLocalStatus(response, ctx);
            return;
          }
          state.roleMutationInFlight = true;
          const response = (await state.client.request("agent.orchestrator.set", {
            enabled: action === "on",
          })) as ConnectionStateResponse;
          applyConnectionStateResponse(response, ctx);
          notifyLocalStatus(response, ctx);
        } catch (error) {
          ctx.ui.notify?.(error instanceof Error ? error.message : String(error), "error");
        } finally {
          state.roleMutationInFlight = false;
        }
      },
    });

    // The model's claim surface: /shepy on <profile> without the keyboard.
    // Shares handleProfileOn/releaseProfile with the command path — the claim
    // RPC exists in exactly one place. The tool result NEVER carries the
    // lease token: tool content lands in the model's transcript, and the
    // token is a capability.
    const shepyProfileParameters = Type.Object({
      action: Type.Union([Type.Literal("claim"), Type.Literal("release"), Type.Literal("status")]),
      profileId: Type.Optional(Type.String({ description: "Required when action is claim" })),
    });

    const shepyProfileTool: ToolDefinition<typeof shepyProfileParameters> = {
      description:
        "Claim, release, or report Shepy profile ownership for this agent. Claiming never takes a profile away from a live owner.",
      label: "Shepy profile",
      name: "shepy_profile",
      parameters: shepyProfileParameters,
      promptGuidelines: [
        "Call shepy_profile with action 'claim' and the profileId named in your instructions when you are told which Shepy profile you own.",
        "A shepy_profile claim rejection names the current owner and is final — do not retry shepy_profile in a loop.",
        "Call shepy_profile with action 'release' when you no longer need the Shepy profile, or action 'status' to check current ownership.",
      ],
      promptSnippet: "shepy_profile — claim or release Shepy profile ownership for this agent",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const text = (value: string) => ({
          content: [{ type: "text" as const, text: value }],
          details: {},
        });
        const action = resolveShepyProfileToolAction(params);
        if (!action.ok) return text(action.message);
        if (action.action === "claim") {
          return text(formatShepyProfileToolText(await handleProfileOn(action.profileId, ctx)));
        }
        if (action.action === "release") {
          return text(formatShepyProfileToolText(await releaseProfile(ctx)));
        }
        return text(
          formatShepyProfileToolText({
            connected: state.connected,
            kind: "status",
            owned: state.profileMode !== undefined,
            ...(state.profileMode
              ? {
                  pendingCount: state.profileMode.pendingCount,
                  profileId: state.profileMode.profileId,
                }
              : {}),
          }),
        );
      },
    };
    pi.registerTool?.(shepyProfileTool);

    const claimFromEnvironment = async (ctx: PiContext) => {
      const profileId = stringValue(process.env.SHEPY_PROFILE)?.trim() ?? "";
      if (!profileId) return;
      // Dispatched panes own their profile without anyone typing. The claim
      // path notifies exactly like /shepy on <profile>; a rejection leaves
      // the pane unowned and is never retried on a timer — the only later
      // attempt is the next presence registration (reconnect) or an
      // explicit /shepy on / shepy_profile claim. handleProfileOn swallows
      // transport errors into its result, so this never rejects the socket.
      await handleProfileOn(profileId, ctx);
    };

    pi.on("session_start", (_event: unknown, ctx: PiContext) => {
      activeContext = ctx;
      state.subscriberId = ctx.sessionManager.getSessionId();
      state.sessionRef = {
        agent: "pi",
        kind: "path",
        source: "herdr:pi",
        value: ctx.sessionManager.getSessionFile(),
      };
      state.launchIdentity = herdrLaunchIdentity(process.env);
      if (!state.launchIdentity) {
        state.connected = false;
        loseRole(ctx);
        return;
      }
      state.client?.close();
      const client = options.clientFactory?.() ?? new ReconnectingDaemonClient({ socketPath: defaultSocketPath() });
      state.client = client;
      client.onConnected = () => registerPresence(ctx).then(() => claimFromEnvironment(ctx));
      client.onDisconnected = () => {
        state.connected = false;
        markDisconnected(activeContext);
      };
      client.onStreamMessage = handleStreamMessage;
    });

    pi.on("session_shutdown", () => {
      state.connected = false;
      loseRole(activeContext);
      const mode = state.profileMode;
      stopProfileTimer();
      state.profileMode = undefined;
      state.profileBatch = undefined;
      if (mode && state.client) {
        try {
          void state.client
            .request("profile.release", { leaseToken: mode.leaseToken, profileId: mode.profileId })
            .catch(() => {
              // close() below rejects pending RPCs. Shutdown must stay non-blocking;
              // lease expiry reclaims ownership if this best-effort release fails.
            });
        } catch {
          // lease expiry reclaims server-side
        }
      }
      state.deliveredBatch = undefined;
      state.client?.close();
      state.client = undefined;
      activeContext = undefined;
    });

    pi.on("message_end", (event: Record<string, unknown>) => {
      const message = record(event.message);
      if (message.role !== "assistant") return;
      const stopReason = stringValue(message.stopReason);
      if (state.deliveredBatch) {
        state.deliveredBatch.assistantFinalSucceeded =
          stopReason === "stop" || stopReason === "length";
      }
      if (state.profileBatch) {
        state.profileBatch.assistantFinalSucceeded =
          stopReason === "stop" || stopReason === "length";
      }
    });

    pi.on("agent_start", () => {
      if (state.runActive) return;
      state.runActive = true;
      state.pinnedContext =
        state.isOrchestrator && !state.deliveredBatch?.shepyTriggered
          ? state.latestContext
          : undefined;
    });

    pi.on("context", (event: { messages: PiAgentMessage[] }) => {
      // Consumption witness (fires before EVERY LLM call): if this run's
      // context contains our profile wake message — matched by obligation
      // ids — the batch's content provably reached a model call. Only such
      // a witnessed batch may be acknowledged at settle.
      const batch = state.profileBatch;
      if (batch && !batch.wakeConsumed) {
        const witnessed = event.messages.some((message) => {
          if (message.customType !== "shepy-wake-context" || message.role !== "custom") {
            return false;
          }
          const details = message.details as { obligationIds?: unknown } | undefined;
          if (!Array.isArray(details?.obligationIds)) return false;
          const ids = details.obligationIds as unknown[];
          return (
            ids.length === batch.obligationIds.length &&
            batch.obligationIds.every((id) => ids.includes(id))
          );
        });
        if (witnessed) batch.wakeConsumed = true;
      }
      const messages = event.messages.filter((message) => !isNormalShepyContext(message));
      const snapshot = state.pinnedContext;
      if (!snapshot || snapshot.agents.length === 0) return { messages };
      return {
        messages: [
          ...messages,
          {
            content: formatHiddenAgentContext({
              agents: snapshot.agents,
              workspaceId: snapshot.workspaceId,
            }),
            customType: "shepy-agent-context",
            display: false,
            role: "custom",
            timestamp: Date.now(),
          },
        ],
      };
    });

    pi.on("agent_settled", async (_event: unknown, ctx: PiContext) => {
      state.runActive = false;
      state.pinnedContext = undefined;
      const profileBatch = state.profileBatch;
      if (profileBatch) {
        state.profileBatch = undefined;
        const mode = state.profileMode;
        if (
          mode &&
          !profileBatch.invalidated &&
          profileBatch.assistantFinalSucceeded &&
          profileBatch.triggerQueued &&
          profileBatch.wakeConsumed &&
          state.client &&
          state.connected
        ) {
          try {
            const ack = (await state.client.request("inbox.ack", {
              ids: profileBatch.obligationIds,
              leaseToken: mode.leaseToken,
              profileId: profileBatch.profileId,
            })) as { acked?: number };
            const ackedCount = ack?.acked ?? 0;
            if (ackedCount > 0) {
              ctx.ui.notify?.(`Shepy · ${ackedCount} update${ackedCount === 1 ? "" : "s"} acknowledged`, "info");
            }
          } catch {
            try {
              await state.client.request("inbox.nack", {
                errorCode: "ack_failed",
                ids: profileBatch.obligationIds,
                leaseToken: mode.leaseToken,
              });
            } catch {
              // obligations stay leased; lease expiry recovers them server-side
            }
            ctx.ui.notify?.("Shepy couldn't acknowledge profile updates · they remain pending", "warning");
          }
        } else if (mode && state.client && state.connected) {
          try {
            await state.client.request("inbox.nack", {
              errorCode: profileBatch.invalidated ? "wake_invalidated" : "wake_failed",
              ids: profileBatch.obligationIds,
              leaseToken: mode.leaseToken,
            });
          } catch {
            // lease expiry recovers
          }
          ctx.ui.notify?.("Shepy profile wake failed · updates remain pending", "warning");
        }
        if (mode) void pumpProfile(ctx);
        return;
      }
      const batch = state.deliveredBatch;
      if (!batch) {
        state.wakeDeferredUntilSettled = false;
        scheduleWake(ctx);
        return;
      }
      state.deliveredBatch = undefined;
      const stillOwner =
        state.isOrchestrator && state.currentScope?.terminalId === batch.ownerTerminalId;
      const failBatch = () => {
        const lastEventId = batch.events.at(-1)?.id;
        if (lastEventId !== undefined) {
          state.failedWakeThroughEventId = Math.max(
            state.failedWakeThroughEventId,
            lastEventId,
          );
        }
        ctx.ui.notify?.(
          "Shepy couldn’t acknowledge agent updates · updates remain pending",
          "warning",
        );
      };
      const finishBatch = () => {
        state.wakeDeferredUntilSettled = false;
        setShepyUi(ctx);
        scheduleWake(ctx);
      };

      if (
        !batch.assistantFinalSucceeded ||
        batch.invalidated ||
        !stillOwner ||
        !state.client ||
        !state.connected
      ) {
        failBatch();
        finishBatch();
        return;
      }

      for (const event of batch.events) {
        try {
          await state.client.request("agent.notifications.ack", { eventId: event.id });
          state.pendingEvents = state.pendingEvents.filter((pending) => pending.id !== event.id);
          setShepyUi(ctx);
        } catch {
          failBatch();
          break;
        }
      }
      finishBatch();
    });

  };
}

export default createShepyPiExtension();

// ── shepy_profile tool: pure validation + transcript-facing mapping ────
// execute() is a thin shell over these; they touch no extension state, so
// the tool's argument contract and result text are unit-testable as-is.

export function resolveShepyProfileToolAction(params: {
  action: string;
  profileId?: string | undefined;
}):
  | { ok: false; message: string }
  | { ok: true; action: "claim"; profileId: string }
  | { ok: true; action: "release" | "status" } {
  if (params.action === "claim") {
    const profileId = params.profileId?.trim() ?? "";
    if (!profileId) {
      return {
        message: "shepy_profile claim requires profileId — the profile your instructions name as yours",
        ok: false,
      };
    }
    return { action: "claim", ok: true, profileId };
  }
  if (params.action === "release" || params.action === "status") {
    return { action: params.action, ok: true };
  }
  return { message: `shepy_profile: unknown action ${params.action}`, ok: false };
}

export function formatShepyProfileToolText(
  result: ShepyProfileClaimResult | ShepyProfileReleaseResult | ShepyProfileStatusResult,
): string {
  switch (result.kind) {
    case "claimed":
      return `Shepy profile ${result.profileId} claimed — this pane now owns it and receives its worker outcomes.`;
    case "reclaimed":
      return `Shepy profile ${result.profileId} reclaimed — this pane already owned it; ownership refreshed.`;
    case "rejected": {
      if (result.reason === "profile_not_found") {
        return `Shepy profile ${result.profileId} was not claimed — no such profile exists on this daemon. Check the profile id (your instructions name it) and try the corrected id once; do not retry the same id in a loop.`;
      }
      const owner = result.owner
        ? `It is held by pane ${result.owner.paneId} (${result.owner.harnessKind}). `
        : "";
      return `Shepy profile ${result.profileId} was not claimed — an active owner holds it. ${owner}Ownership is never taken from a live owner. Do not retry; tell the user if you expected to own it.`;
    }
    case "blocked":
      return `Shepy profile ${result.profileId} was not claimed: ${result.reason}.`;
    case "released":
      return `Shepy profile ${result.profileId} released — this pane no longer owns it.`;
    case "not_owned":
      return "This pane owns no Shepy profile.";
    case "status": {
      const connection = result.connected ? "daemon connected" : "daemon disconnected";
      if (!result.owned) return `Shepy profile: none · ${connection}`;
      const pending = result.pendingCount ? ` · ${result.pendingCount} pending` : "";
      return `Shepy profile: ${result.profileId}${pending} · ${connection}`;
    }
  }
}

export function formatHiddenAgentContext(input: {
  agents: AgentContextListItem[];
  workspaceId: string;
}): string {
  return [
    "[SHEPY AGENT CONTEXT]",
    `Current Herdr workspace: ${input.workspaceId}`,
    ...input.agents.map((agent) => {
      const history = agent.history ?? {};
      const identity = agentIdentityLabel({
        agent: agent.agent ?? "unknown",
        name: agent.name,
      });
      return [
        `- ${identity} ${agent.paneId ?? "unknown"} ${agent.agentStatus ?? "unknown"}`,
        `  last user: ${oneLine(history.lastUserMessage?.text ?? "")}`,
        `  last assistant: ${oneLine(history.lastAssistantMessage?.text ?? "")}`,
      ].join("\n");
    }),
    "Use shepy agent get/read if details are needed.",
  ].join("\n");
}

export function formatHiddenAgentUpdates(events: AgentEventWireRecord[]): string {
  return [
    "[SHEPY AGENT UPDATES]",
    ...events.map((event) => {
      const payload = record(event.payload);
      const history = event.compactHistory ?? {};
      const identity = agentIdentityLabel({
        agent: stringValue(payload.agent) ?? "unknown",
        name: stringValue(payload.name),
      });
      return [
        `- ${event.type} ${identity} ${event.paneId ?? "unknown"}`,
        `  last assistant: ${oneLine(history.lastAssistantMessage?.text ?? "")}`,
        `  event: ${event.id}`,
      ].join("\n");
    }),
  ].join("\n");
}

function isNormalShepyContext(message: PiAgentMessage): boolean {
  return (
    message.customType === "shepy-agent-context" ||
    contentIncludesMarker(message.content, "[SHEPY AGENT CONTEXT]")
  );
}

function contentIncludesMarker(content: unknown, marker: string): boolean {
  if (typeof content === "string") return content.includes(marker);
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const value = record(block);
    return (
      contentIncludesMarker(value.text, marker) || contentIncludesMarker(value.content, marker)
    );
  });
}

function isLocalOwner(response: ConnectionStateResponse): boolean {
  return (
    response.state?.owner?.terminalId === response.presence.terminalId &&
    response.state.herdrSessionName === response.presence.herdrSessionName &&
    response.state.workspaceId === response.presence.workspaceId
  );
}

function localStatusMessage(response: ConnectionStateResponse): string {
  if (!isLocalOwner(response) || !response.state?.owner) return "Shepy is off";
  const scope = `${response.presence.herdrSessionName}/${response.presence.workspaceId}`;
  return `Shepy is watching agent updates · ${scope} · ${response.state.owner.paneId}`;
}

function notifyLocalStatus(response: ConnectionStateResponse, ctx: PiContext): void {
  ctx.ui.notify?.(localStatusMessage(response), "info");
}

function herdrLaunchIdentity(environment: NodeJS.ProcessEnv): LaunchIdentity | undefined {
  if (environment.HERDR_ENV !== "1") return undefined;
  const herdrSocketPath = stringValue(environment.HERDR_SOCKET_PATH);
  const paneId = stringValue(environment.HERDR_PANE_ID);
  const workspaceId = stringValue(environment.HERDR_WORKSPACE_ID);
  if (!herdrSocketPath || !paneId || !workspaceId) return undefined;
  return { herdrSocketPath, paneId, workspaceId };
}


function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 240);
}
