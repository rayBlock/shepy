import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import type { AgentHistoryService } from "@/agent-history/service.js";
import {
  createDaemonInfo,
  type DaemonInfo,
  resolvePackageVersion,
} from "@/daemon/daemon-identity.js";
import {
  DEGRADED_AFTER_TICK_FAILURES,
  type SessionWatchHealth,
} from "@/daemon/herdr-session-watch-manager.js";
import type { AgentEventStore } from "@/db/agent-events.js";
import type { AgentStore } from "@/db/agents.js";
import type { HerdrSessionStore } from "@/db/herdr-sessions.js";
import type { HerdrWorkspaceStore } from "@/db/herdr-workspaces.js";
import type { OperationStore } from "@/db/operations.js";
import { toPublicProfileOwner } from "@/db/profile-owners.js";
import type { HerdrOrchestrationTransport } from "@/herdr/orchestration-transport.js";
import { HerdrWaitTimeoutError } from "@/herdr/orchestration-transport-adapter.js";
import { ownerTerminalGone } from "@/herdr/owner-terminal.js";
import {
  type HerdrPaneIdentity,
  resolveHerdrPaneIdentity,
} from "@/herdr/pane-identity-resolver.js";
import type { AgentContextService } from "@/observability/agent-context-service.js";
import type { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import type {
  AgentEventRecord,
  AgentIndexRecord,
  AgentOrchestratorChanged,
  AgentOrchestratorState,
  AgentOrchestratorWireState,
  AgentQueryScope,
  AgentScope,
  AgentWorkspaceContextSnapshot,
  PiPresenceRegistration,
} from "@/observability/contracts.js";
import type { OperationDispatchService } from "@/observability/operation-dispatch-service.js";
import type { OperationWaitService } from "@/observability/operation-wait-service.js";
import { projectOutcomeContext } from "@/observability/outcome-context.js";
import type { ProfileDeliveryService } from "@/observability/profile-delivery-service.js";
import type { ProfileDiagnoseService } from "@/observability/profile-diagnose-service.js";
import { resolveSelectorInWorkspaceScope } from "@/observability/profile-selector-scope.js";
import type { AgentSelector } from "@/observability/profile-selectors.js";
import type { ProfileService } from "@/observability/profile-service.js";
import { RpcRefusedError } from "@/observability/rpc-refused-error.js";
import {
  agentEventsInputSchema,
  agentGetInputSchema,
  agentListInputSchema,
  agentOrchestratorAckInputSchema,
  agentOrchestratorGetInputSchema,
  agentOrchestratorRegisterInputSchema,
  agentOrchestratorSetInputSchema,
  agentReadInputSchema,
  inboxAckInputSchema,
  inboxDeferInputSchema,
  inboxDeliveredInputSchema,
  inboxGetInputSchema,
  inboxLeaseInputSchema,
  inboxListInputSchema,
  inboxRetireInputSchema,
  inboxRetryInputSchema,
  operationDispatchInputSchema,
  operationGetInputSchema,
  operationWaitInputSchema,
  profileClaimInputSchema,
  profileDiagnoseInputSchema,
  profileEnsureInputSchema,
  profilePruneInputSchema,
  profileReleaseInputSchema,
  profileShowInputSchema,
  profileSubscribeInputSchema,
} from "@/observability/schemas.js";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";

export const DISCONNECT_GRACE_MS = 5_000;
export const STARTUP_RECONNECT_GRACE_MS = 10_000;

type RpcRequest = { id?: number | string; method?: string; params?: unknown };

type AgentStores = {
  agentEvents: AgentEventStore;
  agents: AgentStore;
  herdrSessions: HerdrSessionStore;
  herdrWorkspaces: HerdrWorkspaceStore;
};

export type PiPresence = AgentScope & {
  connectedAt: number;
  paneId: string;
  subscriberId: string;
  terminalId: string;
};

type AgentOrchestratorConnectionStateResult = {
  context: AgentWorkspaceContextSnapshot | null;
  events: AgentEventRecord[];
  presence: PiPresence;
  state: AgentOrchestratorWireState | null;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type GraceTimer = {
  handle: TimerHandle;
};

/** The `daemon.health` answer: the watch manager's live snapshot, or
 * `status: "unknown"` when this server was built without one (embedded
 * test fixtures) — never a guessed "healthy". */
export type DaemonHealthReport =
  | SessionWatchHealth
  | {
      consecutiveTickFailures: 0;
      degradedAfterTickFailures: number;
      lastTickError: undefined;
      lastTickSucceededAt: undefined;
      status: "unknown";
    };

export class ObservabilityRpcServer {
  readonly #clearTimeout: (handle: TimerHandle) => void;
  readonly #context: AgentContextService;
  readonly #connectionOrderBySocket = new Map<Socket, number>();
  readonly #daemonInfo: DaemonInfo;
  readonly #disconnectGraceMs: number;
  readonly #disconnectTimers = new Map<string, GraceTimer>();
  readonly #history: AgentHistoryService;
  readonly #now: () => number;
  readonly #orchestrator: AgentOrchestratorService;
  readonly #piPresenceBySocket = new Map<Socket, PiPresence>();
  readonly #profiles: ProfileService | undefined;
  readonly #profileDiagnose: ProfileDiagnoseService | undefined;
  readonly #delivery: ProfileDeliveryService | undefined;
  readonly #operationDispatch: OperationDispatchService | undefined;
  readonly #operationStore: OperationStore | undefined;
  readonly #operationWait: OperationWaitService | undefined;
  readonly #orchestrationTransport: HerdrOrchestrationTransport | undefined;
  readonly #registerPiSessionRef: (input: {
    herdrSessionName: string;
    sessionRef: PiPresenceRegistration["sessionRef"];
    terminalId: string;
  }) => Promise<{ contextChangedScopes: AgentScope[] }>;
  readonly #resolvePaneIdentity: (input: {
    paneId: string;
    socketPath: string;
  }) => Promise<HerdrPaneIdentity>;
  readonly #server: Server;
  readonly #setTimeout: (callback: () => void, delay: number) => TimerHandle;
  readonly #socketPath: string;
  readonly #sockets = new Set<Socket>();
  readonly #startupReconnectGraceMs: number;
  readonly #startupTimers = new Map<string, GraceTimer>();
  readonly #stores: AgentStores;
  readonly #watchHealth: (() => SessionWatchHealth | undefined) | undefined;
  #connectionSequence = 0;
  #stopping = false;

  constructor(options: {
    clearTimeout?: (handle: TimerHandle) => void;
    context: AgentContextService;
    daemonInfo?: DaemonInfo;
    disconnectGraceMs?: number;
    history: AgentHistoryService;
    now?: () => number;
    orchestrator: AgentOrchestratorService;
    delivery?: ProfileDeliveryService;
    profileDiagnose?: ProfileDiagnoseService;
    profiles?: ProfileService;
    operationDispatch?: OperationDispatchService;
    operationStore?: OperationStore;
    operationWait?: OperationWaitService;
    orchestrationTransport?: HerdrOrchestrationTransport;
    registerPiSessionRef?: (input: {
      herdrSessionName: string;
      sessionRef: PiPresenceRegistration["sessionRef"];
      terminalId: string;
    }) => Promise<{ contextChangedScopes: AgentScope[] }>;
    resolvePaneIdentity?: (input: {
      paneId: string;
      socketPath: string;
    }) => Promise<HerdrPaneIdentity>;
    setTimeout?: (callback: () => void, delay: number) => TimerHandle;
    socketPath: string;
    startupReconnectGraceMs?: number;
    stores: AgentStores;
    watchHealth?: () => SessionWatchHealth | undefined;
  }) {
    this.#clearTimeout = options.clearTimeout ?? clearTimeout;
    this.#context = options.context;
    // RUN-20260913-04 D1: the served identity. An explicit one (the real
    // daemon, resolved once at boot) wins; the default mints one from this
    // module so every server instance — including test fixtures — answers
    // daemon.info with a stable, per-boot identity instead of an error.
    this.#daemonInfo =
      options.daemonInfo ??
      createDaemonInfo({
        entryPath: fileURLToPath(import.meta.url),
        pid: process.pid,
        version: resolvePackageVersion(dirname(fileURLToPath(import.meta.url))),
      });
    this.#disconnectGraceMs = options.disconnectGraceMs ?? DISCONNECT_GRACE_MS;
    this.#history = options.history;
    this.#now = options.now ?? Date.now;
    this.#orchestrator = options.orchestrator;
    this.#delivery = options.delivery;
    this.#profileDiagnose = options.profileDiagnose;
    this.#profiles = options.profiles;
    this.#operationDispatch = options.operationDispatch;
    this.#operationStore = options.operationStore;
    this.#operationWait = options.operationWait;
    this.#orchestrationTransport = options.orchestrationTransport;
    this.#registerPiSessionRef =
      options.registerPiSessionRef ?? (async () => ({ contextChangedScopes: [] }));
    this.#resolvePaneIdentity = options.resolvePaneIdentity ?? resolveHerdrPaneIdentity;
    this.#setTimeout = options.setTimeout ?? setTimeout;
    this.#socketPath = options.socketPath;
    this.#startupReconnectGraceMs = options.startupReconnectGraceMs ?? STARTUP_RECONNECT_GRACE_MS;
    this.#stores = options.stores;
    this.#watchHealth = options.watchHealth;
    this.#server = createServer((socket) => this.#handleConnection(socket));
  }

  async start(): Promise<void> {
    this.#stopping = false;
    if (existsSync(this.#socketPath)) unlinkSync(this.#socketPath);
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#socketPath, () => {
        this.#server.off("error", reject);
        try {
          chmodSync(this.#socketPath, 0o600);
          resolve();
        } catch (error) {
          this.#server.close();
          reject(error);
        }
      });
    });
    this.#armStartupGrace();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#clearGraceTimers(this.#disconnectTimers);
    this.#clearGraceTimers(this.#startupTimers);
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#piPresenceBySocket.clear();
    this.#connectionOrderBySocket.clear();
    await new Promise<void>((resolve, reject) => {
      if (!this.#server.listening) {
        resolve();
        return;
      }
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
    if (existsSync(this.#socketPath)) unlinkSync(this.#socketPath);
  }

  publishAgentContext(scope: AgentScope): void {
    const owner = this.#orchestrator.status(scope)?.owner;
    if (!owner) return;
    // Explicit all-or-none host guard: a host-free owner never reaches the
    // terminal socket key/lookup.
    if (!owner.terminalId) return;
    const socket = this.#newestSocketForTerminal({ ...scope, terminalId: owner.terminalId });
    if (!socket) return;
    const context = this.#context.workspaceSnapshot({
      ...scope,
      excludeTerminalId: owner.terminalId,
    });
    this.#write(socket, {
      method: "agent.context.changed",
      params: { context, herdrSessionName: scope.herdrSessionName, workspaceId: scope.workspaceId },
    });
  }

  publishAgentEvent(event: AgentEventRecord): void {
    if (!event.workspaceId || !event.terminalId) return;
    const scope = { herdrSessionName: event.herdrSessionName, workspaceId: event.workspaceId };
    const owner = this.#orchestrator.status(scope)?.owner;
    if (!owner || event.terminalId === owner.terminalId) return;
    // Explicit all-or-none host guard before the terminal socket lookup.
    if (!owner.terminalId) return;
    const socket = this.#newestSocketForTerminal({ ...scope, terminalId: owner.terminalId });
    if (socket)
      this.#write(socket, { method: "agent.event", params: { event: withOutcomeContext(event) } });
  }

  reconcileAgentLocations(input: { agents: AgentIndexRecord[]; herdrSessionName: string }): void {
    const byTerminal = new Map(
      input.agents.flatMap((agent) =>
        agent.terminalId ? ([[agent.terminalId, agent]] as const) : [],
      ),
    );
    const owners = this.#orchestrator
      .persistedOwners()
      .filter((state) => state.herdrSessionName === input.herdrSessionName);

    for (const [socket, presence] of this.#piPresenceBySocket) {
      if (presence.herdrSessionName !== input.herdrSessionName) continue;
      const agent = byTerminal.get(presence.terminalId);
      if (!agent) continue;
      this.#piPresenceBySocket.set(socket, {
        ...presence,
        paneId: agent.paneId,
        workspaceId: agent.workspaceId,
      });
    }

    for (const ownerState of owners) {
      const owner = ownerState.owner;
      if (!owner) continue;
      // Explicit all-or-none host guard: reconciliation never consults a
      // terminal for a host-free owner.
      if (!owner.terminalId || !owner.paneId || !ownerState.workspaceId) continue;
      const current = this.#orchestrator.status(ownerState);
      if (current?.owner?.terminalId !== owner.terminalId) continue;
      const agent = byTerminal.get(owner.terminalId);
      if (!agent) continue;
      if (agent.workspaceId === ownerState.workspaceId) {
        if (agent.paneId === owner.paneId) continue;
        const change = this.#orchestrator.claim({
          ...ownerState,
          paneId: agent.paneId,
          terminalId: owner.terminalId,
        });
        this.#publishOrchestratorChange(toWireChange({ ...change, reason: "moved" }));
        continue;
      }
      const changes = this.#orchestrator.move({
        from: ownerState,
        paneId: agent.paneId,
        terminalId: owner.terminalId,
        to: {
          herdrSessionName: input.herdrSessionName,
          workspaceId: agent.workspaceId,
        },
      });
      for (const change of changes) {
        this.#publishOrchestratorChange(toWireChange(change));
      }
    }
  }

  #handleConnection(socket: Socket): void {
    this.#sockets.add(socket);
    this.#connectionSequence += 1;
    this.#connectionOrderBySocket.set(socket, this.#connectionSequence);
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk.toString("utf8"))) {
        void this.#handleRequest(socket, message as RpcRequest);
      }
    });
    socket.on("close", () => this.#handleSocketClose(socket));
    socket.on("error", () => undefined);
  }

  async #handleRequest(socket: Socket, request: RpcRequest): Promise<void> {
    try {
      if (!request.method) throw new Error("Missing method");
      const result = await this.#dispatch(socket, request.method, request.params ?? {});
      this.#write(socket, { id: request.id, result });
    } catch (error) {
      // A stable machine-readable code ONLY for deliberate refusal classes
      // (RpcRefusedError — e.g. InboxRefusedError's not_owner /
      // owner_lapsed): callers branch on the code instead of parsing
      // prose. Anything else stays prose-only — a Node system error's code
      // (EACCES, ENOENT) is an implementation detail, not a Shepy contract,
      // and hooks classify on the wire code. Message text remains the
      // prose contract existing clients match on.
      this.#write(socket, {
        error: {
          ...(error instanceof RpcRefusedError ? { code: error.code } : {}),
          message: error instanceof Error ? error.message : String(error),
        },
        id: request.id,
      });
    }
  }

  async #dispatch(socket: Socket, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "daemon.info": {
        // No params by design: the identity is the daemon's own answer to
        // "which build is answering this socket".
        return this.#daemonInfo;
      }
      case "daemon.health": {
        // No params by design: LIVE scheduler health, read at request time —
        // the observable backstop for permanently failing session ticks
        // (they used to only log). Served next to daemon.info in
        // `shepy daemon status`. No provider (or no manager yet) answers
        // unknown — never a guessed healthy.
        return (
          this.#watchHealth?.() ?? {
            consecutiveTickFailures: 0,
            degradedAfterTickFailures: DEGRADED_AFTER_TICK_FAILURES,
            lastTickError: undefined,
            lastTickSucceededAt: undefined,
            status: "unknown" as const,
          }
        );
      }
      case "agent.list": {
        assertSchema(agentListInputSchema, params);
        const scope = this.#resolveScope(params as AgentQueryScope);
        return { agents: this.#context.listAgents(scope) };
      }
      case "agent.get": {
        assertSchema(agentGetInputSchema, params);
        const input = params as AgentQueryScope & { target: string };
        const scope = this.#resolveScope(input);
        const agent = this.#stores.agents.resolveTarget(scope, input.target);
        const preferredRef = this.#context.getAgentSnapshot(agent.id)?.historyRef;
        const history = await this.#history.resolveCompactHistory(historyInput(agent), {
          preferredRef: preferredRef ?? null,
        });
        return { agent: { ...agent, history: history.compactHistory } };
      }
      case "agent.read": {
        assertSchema(agentReadInputSchema, params);
        const input = params as AgentQueryScope & { limit?: number; target: string };
        const scope = this.#resolveScope(input);
        const agent = this.#stores.agents.resolveTarget(scope, input.target);
        const preferredRef = this.#context.getAgentSnapshot(agent.id)?.historyRef;
        const read = await this.#history.read(historyInput(agent), {
          limit: input.limit ?? 20,
          preferredRef: preferredRef ?? null,
        });
        return { agent: { ...agent, historyRef: read.historyRef, messages: read.messages } };
      }
      case "profile.list": {
        const profiles = this.#requireProfiles().listProfiles();
        return { profiles };
      }
      case "profile.ensure": {
        assertSchema(profileEnsureInputSchema, params);
        const input = params as {
          claudeIdleWake?: boolean;
          displayName: string;
          profileId: string;
          projectRoots: string[];
        };
        const profile = this.#requireProfiles().ensureProfile(input);
        return { profile };
      }
      case "profile.show": {
        assertSchema(profileShowInputSchema, params);
        const input = params as { profileId: string };
        const profiles = this.#requireProfiles();
        const profile = profiles.getProfile(input.profileId);
        if (!profile) throw new Error(`No such profile: ${input.profileId}`);
        return {
          profile,
          resolutions: profiles.resolveSubscriptions(input.profileId),
          subscriptions: profiles.listSubscriptions(input.profileId),
        };
      }
      case "profile.subscribe": {
        assertSchema(profileSubscribeInputSchema, params);
        const input = params as {
          agentSelector: Parameters<ProfileService["addSubscription"]>[0]["agentSelector"];
          herdrSessionName: string;
          profileId: string;
          workspaceId: string;
        };
        const profiles = this.#requireProfiles();
        if (!profiles.getProfile(input.profileId))
          throw new Error(`No such profile: ${input.profileId}`);
        const agentSelector = await this.#resolveSubscriptionSelector(input, true);
        const { subscription } = profiles.addSubscription({
          ...input,
          agentSelector,
          ...(input.agentSelector.kind !== "terminalId" && agentSelector.kind === "terminalId"
            ? { previousAgentSelector: input.agentSelector }
            : {}),
        });
        const resolution = profiles
          .resolveSubscriptions(input.profileId)
          .find((row) => row.subscription.id === subscription.id);
        return { subscription, resolution };
      }
      case "profile.unsubscribe": {
        assertSchema(profileSubscribeInputSchema, params);
        const input = params as {
          agentSelector: Parameters<ProfileService["addSubscription"]>[0]["agentSelector"];
          herdrSessionName: string;
          profileId: string;
          workspaceId: string;
        };
        const profiles = this.#requireProfiles();
        // Legacy pane/name rows can be removed even after their pane has closed.
        const legacy = profiles.removeSubscription(input);
        if (legacy.removed) return legacy;
        const agentSelector = await this.#resolveSubscriptionSelector(input, false);
        const { removed } = profiles.removeSubscription({ ...input, agentSelector });
        return { removed };
      }
      case "profile.prune": {
        assertSchema(profilePruneInputSchema, params);
        const input = params as { ageMs: number; profileId: string };
        return this.#requireProfiles().pruneSubscriptions(input);
      }
      case "operation.dispatch": {
        assertSchema(operationDispatchInputSchema, params);
        const input = params as { profileId: string; prompt: string };
        const dispatch = this.#requireOperationDispatch();
        const outcome = await dispatch.dispatch({
          profileId: input.profileId,
          prompt: input.prompt,
        });
        return { outcome };
      }
      case "operation.get": {
        assertSchema(operationGetInputSchema, params);
        const input = params as { operationId: string; profileId?: string };
        const store = this.#requireOperationStore();
        const operation = store.get(
          input.operationId,
          input.profileId ? { profileId: input.profileId } : undefined,
        );
        if (!operation) throw new Error(`No such operation: ${input.operationId}`);
        return { operation };
      }
      case "operation.list": {
        assertSchema(profileShowInputSchema, params);
        const input = params as { profileId: string };
        return { operations: this.#requireOperationStore().listForProfile(input.profileId) };
      }
      case "operation.wait": {
        assertSchema(operationWaitInputSchema, params);
        const input = params as { operationId: string; profileId?: string; timeoutMs?: number };
        const wait = this.#requireOperationWait();
        const transport = this.#requireOrchestrationTransport();
        const store = this.#requireOperationStore();
        const operation = store.get(
          input.operationId,
          input.profileId ? { profileId: input.profileId } : undefined,
        );
        if (!operation) throw new Error(`No such operation: ${input.operationId}`);

        if (isTerminalOperationState(operation.state)) {
          return { outcome: { kind: operation.state, operationId: operation.id } };
        }
        if (operation.state !== "submitted") {
          return { outcome: { kind: "not_submitted" } };
        }

        try {
          const evidence = store.promptEvidence(operation.id);
          const event = await transport.waitForLifecycle(operation.id, operation.target, {
            ...(evidence ? { evidence } : {}),
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          });
          const outcome = wait.applyLifecycle(operation.id, event);
          return { outcome };
        } catch (error) {
          // Only herdr's own bounded-wait expiry is a clean wait_timeout. A
          // socket-level "Herdr request timed out" is a transport failure —
          // surfacing it as wait_timeout silently cut every wait longer than
          // the 10 s client deadline (2026-09-04). Anything else rethrows and
          // surfaces as an RPC error.
          if (error instanceof HerdrWaitTimeoutError) {
            return {
              outcome: wait.applyTimeout({
                operationId: operation.id,
                timeoutMs: input.timeoutMs ?? 0,
              }),
            };
          }
          throw error;
        }
      }
      case "profile.diagnose": {
        assertSchema(profileDiagnoseInputSchema, params);
        const input = params as { cliBuildStamp?: string; profileId: string };
        return this.#requireDiagnose().diagnose({
          ...(input.cliBuildStamp !== undefined ? { cliBuildStamp: input.cliBuildStamp } : {}),
          profileId: input.profileId,
        });
      }
      case "profile.claim": {
        assertSchema(profileClaimInputSchema, params);
        const input = params as {
          claudeMessagingSocket?: { path: string; token: string };
          currentLeaseToken?: string;
          harnessKind: string;
          harnessSessionRefJson: string;
          herdrSessionName?: string;
          paneId?: string;
          profileId: string;
          subscriberId: string;
          terminalId?: string;
          workspaceId?: string;
        };
        const result = await this.#requireDelivery().claimWithOwnerCheck(input, async (owner) => {
          if (!owner.herdrSessionName || !owner.terminalId || !owner.paneId) return false;
          const session = this.#stores.herdrSessions.findRunningByName(owner.herdrSessionName);
          if (!session) return false;
          return ownerTerminalGone({
            paneId: owner.paneId,
            socketPath: session.socketPath,
            terminalId: owner.terminalId,
            ...(owner.harnessKind === "claude" &&
            input.harnessKind === "claude" &&
            input.paneId === owner.paneId &&
            input.terminalId === owner.terminalId
              ? {
                  claudeReplacement: {
                    previousSessionRefJson: owner.harnessSessionRefJson,
                    subscriberId: input.subscriberId,
                  },
                }
              : {}),
          });
        });
        // Even the claimant gets only presence, never the stored socket capability.
        return {
          result:
            result.kind === "claimed" || result.kind === "reclaimed"
              ? { ...result, owner: toPublicProfileOwner(result.owner) }
              : result,
        };
      }
      case "profile.owner": {
        assertSchema(profileShowInputSchema, params);
        const input = params as { profileId: string };
        return { owner: this.#requireDelivery().owner(input.profileId) ?? null };
      }
      case "profile.release": {
        assertSchema(profileReleaseInputSchema, params);
        const input = params as { leaseToken: string; profileId: string };
        return { released: this.#requireDelivery().release(input) };
      }
      case "profile.renew": {
        // Same wire shape as release: the lease token plus the profile it
        // belongs to. Only the current holder can renew (store-enforced).
        assertSchema(profileReleaseInputSchema, params);
        const input = params as { leaseToken: string; profileId: string };
        return { renewed: this.#requireDelivery().renew(input) };
      }
      case "inbox.list": {
        assertSchema(inboxListInputSchema, params);
        const input = params as {
          before?: number;
          limit?: number;
          profileId: string;
          state?: string;
        };
        const obligations = this.#requireDelivery().inboxList({
          ...(input.before !== undefined ? { before: input.before } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          profileId: input.profileId,
          ...(input.state
            ? { state: input.state as "pending" | "leased" | "delivered" | "acked" | "dead_letter" }
            : {}),
        });
        return { obligations };
      }
      case "inbox.lease": {
        assertSchema(inboxLeaseInputSchema, params);
        const input = params as {
          leaseToken: string;
          maxBatch?: number;
          profileId: string;
        };
        return this.#requireDelivery().inboxLease({
          ...(input.maxBatch !== undefined ? { maxBatch: input.maxBatch } : {}),
          leaseToken: input.leaseToken,
          profileId: input.profileId,
        });
      }
      case "inbox.delivered": {
        assertSchema(inboxDeliveredInputSchema, params);
        const input = params as {
          harnessTurnId?: string;
          ids: string[];
          leaseToken: string;
          ownerSessionRefJson: string;
        };
        return this.#requireDelivery().inboxDelivered(input);
      }
      case "inbox.ack": {
        assertSchema(inboxAckInputSchema, params);
        const input = params as { ids: string[]; leaseToken: string; profileId: string };
        return this.#requireDelivery().inboxAck(input);
      }
      case "inbox.nack": {
        assertSchema(inboxAckInputSchema, params);
        const input = params as {
          errorCode?: string;
          ids: string[];
          leaseToken: string;
          profileId: string;
        };
        return this.#requireDelivery().inboxNack({
          errorCode: input.errorCode ?? "harness_failed",
          ids: input.ids,
          leaseToken: input.leaseToken,
        });
      }
      case "inbox.defer": {
        // Same wire shape as inbox.nack minus the error code: the deferral
        // reason is daemon-side constant (deferred_over_budget), the caller
        // only proves its lease and names the rows.
        assertSchema(inboxDeferInputSchema, params);
        const input = params as { ids: string[]; leaseToken: string };
        return this.#requireDelivery().inboxDefer(input);
      }
      case "inbox.get": {
        assertSchema(inboxGetInputSchema, params);
        const input = params as { obligationId: string };
        return { obligation: this.#requireDelivery().inboxGet(input.obligationId) };
      }
      case "inbox.retry": {
        assertSchema(inboxRetryInputSchema, params);
        const input = params as { id: string };
        return { retried: this.#requireDelivery().retry(input.id) };
      }
      case "inbox.retire": {
        assertSchema(inboxRetireInputSchema, params);
        const input = params as { olderThan?: number; profileId: string };
        return this.#requireDelivery().retire({
          ...(input.olderThan !== undefined ? { olderThan: input.olderThan } : {}),
          profileId: input.profileId,
        });
      }
      case "profile.context": {
        assertSchema(profileShowInputSchema, params);
        const input = params as { profileId: string };
        const context = await this.#requireProfiles().profileContext(input.profileId);
        if (!context) throw new Error(`No such profile: ${input.profileId}`);
        return context;
      }
      case "agent.events": {
        assertSchema(agentEventsInputSchema, params);
        const input = params as AgentQueryScope & { afterEventId?: number; limit?: number };
        return { events: this.#stores.agentEvents.listAfter(input).map(withOutcomeContext) };
      }
      case "agent.orchestrator.register": {
        assertSchema(agentOrchestratorRegisterInputSchema, params);
        const previous = this.#piPresenceBySocket.get(socket);
        const presence = await this.#resolvePiPresence(params as PiPresenceRegistration);
        this.#piPresenceBySocket.set(socket, presence);
        this.#cancelGraceForTerminal(presence);
        if (previous && terminalPresenceKey(previous) !== terminalPresenceKey(presence)) {
          this.#scheduleDisconnect(previous);
        }
        const sessionRef = (params as PiPresenceRegistration).sessionRef;
        // The report is a fresh observation even before an inventory row
        // exists. Do not bind an older effective session from the cached row.
        this.#profiles?.observeAgents([
          {
            agent: sessionRef.agent,
            agentSession: sessionRef,
            herdrSessionName: presence.herdrSessionName,
            terminalId: presence.terminalId,
            workspaceId: presence.workspaceId,
          },
        ]);
        const registration = await this.#registerPiSessionRef({
          herdrSessionName: presence.herdrSessionName,
          sessionRef,
          terminalId: presence.terminalId,
        });
        for (const scope of registration.contextChangedScopes) this.publishAgentContext(scope);
        return this.#connectionState(presence);
      }
      case "agent.orchestrator.get": {
        assertSchema(agentOrchestratorGetInputSchema, params);
        return this.#connectionState(this.#requirePiPresence(socket));
      }
      case "agent.orchestrator.set": {
        assertSchema(agentOrchestratorSetInputSchema, params);
        const presence = this.#requirePiPresence(socket);
        const enabled = (params as { enabled: boolean }).enabled;
        let changed = false;
        if (enabled) {
          const change = this.#orchestrator.claim(presence);
          changed = !sameOwner(change.current.owner, change.previous.owner);
          if (changed) this.#publishOrchestratorChange(toWireChange(change));
        } else {
          const change = this.#orchestrator.release({
            ...presence,
            reason: "released",
          });
          changed = change !== undefined;
          if (change) this.#publishOrchestratorChange(toWireChange(change));
        }
        return { ...this.#connectionState(presence), changed };
      }
      case "agent.notifications.ack": {
        assertSchema(agentOrchestratorAckInputSchema, params);
        const presence = this.#requirePiPresence(socket);
        const state = this.#orchestrator.ack({
          ...presence,
          eventId: (params as { eventId: number }).eventId,
        });
        return { acknowledged: true, state: toWireState(state) };
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  async #resolveSubscriptionSelector(
    input: {
      agentSelector: AgentSelector;
      herdrSessionName: string;
      workspaceId: string;
    },
    subscribe: boolean,
  ): Promise<AgentSelector> {
    const selector = input.agentSelector;
    if (subscribe && selector.kind === "terminalId" && Object.hasOwn(selector, "agentSession")) {
      throw new Error("Subscription session guards must come from an observation, not the caller");
    }
    if (selector.kind === "paneId") {
      const session = this.#stores.herdrSessions.findRunningByName(input.herdrSessionName);
      if (!session) throw new Error(`No running Herdr session: ${input.herdrSessionName}`);
      const pane = await this.#resolvePaneIdentity({
        socketPath: session.socketPath,
        paneId: selector.value,
      });
      if (pane.invalidAgentSession)
        throw new Error("Herdr pane response has an invalid native session");
      if (pane.paneId !== selector.value) throw new Error("Herdr returned a different pane");
      if (pane.workspaceId !== input.workspaceId)
        throw new Error("Subscription workspace does not match Herdr pane");
      if (subscribe && pane.agentSession)
        this.#profiles?.observeAgents([
          {
            agent: pane.agentSession.agent,
            agentSession: pane.agentSession,
            herdrSessionName: input.herdrSessionName,
            terminalId: pane.terminalId,
            workspaceId: pane.workspaceId,
          },
        ]);
      return {
        kind: "terminalId",
        value: pane.terminalId,
        agentSession: pane.agentSession ?? null,
      };
    }
    if (selector.kind !== "name" && selector.kind !== "terminalId") return selector;
    const resolution = resolveSelectorInWorkspaceScope({
      agents: this.#stores.agents,
      selector,
      workspace: { herdrSession: input.herdrSessionName, workspaceId: input.workspaceId },
    });
    if (selector.kind === "name") {
      // Preserve deferred/legacy name callers when no unique terminal is known.
      if (resolution.kind !== "matched" || !resolution.record.terminalId) return selector;
      return {
        kind: "terminalId",
        value: resolution.record.terminalId,
        agentSession: resolution.record.agentSession,
      };
    }
    if (!subscribe) return selector;
    return {
      kind: "terminalId",
      value: selector.value,
      agentSession: resolution.kind === "matched" ? resolution.record.agentSession : null,
    };
  }

  async #resolvePiPresence(input: PiPresenceRegistration): Promise<PiPresence> {
    const session = this.#stores.herdrSessions.findRunningBySocketPath(input.herdrSocketPath);
    if (!session) throw new Error("Herdr socket is not registered as a running session");
    const indexed = this.#stores.agents.findByPane({
      herdrSessionName: session.name,
      paneId: input.paneId,
    });
    if (indexed?.workspaceId === input.workspaceId && indexed.terminalId) {
      return {
        connectedAt: this.#now(),
        herdrSessionName: session.name,
        paneId: indexed.paneId,
        subscriberId: input.subscriberId,
        terminalId: indexed.terminalId,
        workspaceId: indexed.workspaceId,
      };
    }

    let live: HerdrPaneIdentity;
    try {
      live = await this.#resolvePaneIdentity({
        paneId: input.paneId,
        socketPath: session.socketPath,
      });
    } catch {
      if (!indexed) throw new Error("Herdr pane is not indexed yet");
      if (indexed.workspaceId !== input.workspaceId) {
        throw new Error("Pi presence workspace does not match indexed Herdr pane");
      }
      throw new Error("Herdr pane has no terminal identity");
    }
    if (live.agentSession)
      this.#profiles?.observeAgents([
        {
          agent: live.agentSession.agent,
          agentSession: live.agentSession,
          herdrSessionName: session.name,
          terminalId: live.terminalId,
          workspaceId: live.workspaceId,
        },
      ]);
    return {
      connectedAt: this.#now(),
      herdrSessionName: session.name,
      paneId: live.paneId,
      subscriberId: input.subscriberId,
      terminalId: live.terminalId,
      workspaceId: live.workspaceId,
    };
  }

  #connectionState(presence: PiPresence): AgentOrchestratorConnectionStateResult {
    const state = this.#orchestrator.status(presence);
    const context =
      state?.owner?.terminalId === presence.terminalId
        ? this.#context.workspaceSnapshot({ ...presence, excludeTerminalId: presence.terminalId })
        : null;
    return {
      context,
      events: this.#orchestrator.pending({ ...presence, limit: 100 }),
      presence,
      state: state ? toWireState(state) : null,
    };
  }

  #requirePiPresence(socket: Socket): PiPresence {
    const presence = this.#piPresenceBySocket.get(socket);
    if (!presence) throw new Error("Pi presence is not registered for this connection");
    return presence;
  }

  #publishOrchestratorChange(change: AgentOrchestratorChanged): void {
    for (const [socket, presence] of this.#piPresenceBySocket) {
      if (sameScope(presence, change.previous) || sameScope(presence, change.current)) {
        this.#write(socket, { method: "agent.orchestrator.changed", params: { change } });
      }
    }
  }

  #newestSocketForTerminal(input: AgentScope & { terminalId: string }): Socket | undefined {
    let newest: { order: number; socket: Socket } | undefined;
    for (const [socket, presence] of this.#piPresenceBySocket) {
      if (
        sameScope(presence, input) &&
        presence.terminalId === input.terminalId &&
        !socket.destroyed
      ) {
        const order = this.#connectionOrderBySocket.get(socket) ?? 0;
        if (!newest || order > newest.order) newest = { order, socket };
      }
    }
    return newest?.socket;
  }

  #handleSocketClose(socket: Socket): void {
    if (!this.#sockets.delete(socket)) return;
    this.#connectionOrderBySocket.delete(socket);
    const presence = this.#piPresenceBySocket.get(socket);
    this.#piPresenceBySocket.delete(socket);
    if (!this.#stopping && presence) this.#scheduleDisconnect(presence);
  }

  #scheduleDisconnect(presence: PiPresence): void {
    const key = terminalPresenceKey(presence);
    if (this.#hasTerminalPresence(presence) || this.#disconnectTimers.has(key)) return;
    const handle = this.#setTimeout(() => {
      this.#disconnectTimers.delete(key);
      if (this.#stopping || this.#hasTerminalPresence(presence)) return;
      this.#releaseCurrentOwnersForTerminal({
        ...presence,
        reason: "disconnected",
      });
    }, this.#disconnectGraceMs);
    this.#disconnectTimers.set(key, { handle });
  }

  #armStartupGrace(): void {
    for (const state of this.#orchestrator.persistedOwners()) {
      const owner = state.owner;
      // Explicit all-or-none host guard: only a fully host-qualified owner
      // state may reach terminal keys, presence checks or host releases.
      if (!owner?.terminalId || !owner.paneId || !state.workspaceId) continue;
      const key = terminalPresenceKey({ ...state, terminalId: owner.terminalId });
      const handle = this.#setTimeout(() => {
        this.#startupTimers.delete(key);
        if (
          this.#stopping ||
          this.#hasTerminalPresence({ ...state, terminalId: owner.terminalId })
        ) {
          return;
        }
        this.#releaseCurrentOwnersForTerminal({
          herdrSessionName: state.herdrSessionName,
          reason: "startup_timeout",
          terminalId: owner.terminalId,
        });
      }, this.#startupReconnectGraceMs);
      this.#startupTimers.set(key, { handle });
    }
  }

  #releaseCurrentOwnersForTerminal(input: {
    herdrSessionName: string;
    reason: "disconnected" | "startup_timeout";
    terminalId: string;
  }): void {
    const owners = this.#orchestrator
      .persistedOwners()
      .filter(
        (state) =>
          state.owner !== null &&
          state.owner.paneId !== null &&
          state.owner.terminalId !== null &&
          state.herdrSessionName === input.herdrSessionName &&
          state.owner.terminalId === input.terminalId,
      );
    for (const owner of owners) {
      const change = this.#orchestrator.release({
        ...owner,
        reason: input.reason,
        terminalId: input.terminalId,
      });
      if (change) this.#publishOrchestratorChange(toWireChange(change));
    }
  }

  #cancelGraceForTerminal(presence: AgentScope & { terminalId: string }): void {
    const key = terminalPresenceKey(presence);
    this.#cancelTimer(this.#disconnectTimers, key);
    this.#cancelTimer(this.#startupTimers, key);
  }

  #hasTerminalPresence(input: AgentScope & { terminalId: string }): boolean {
    for (const presence of this.#piPresenceBySocket.values()) {
      if (
        presence.herdrSessionName === input.herdrSessionName &&
        presence.terminalId === input.terminalId
      ) {
        return true;
      }
    }
    return false;
  }

  #cancelTimer(registry: Map<string, GraceTimer>, key: string): void {
    const timer = registry.get(key);
    if (!timer) return;
    this.#clearTimeout(timer.handle);
    registry.delete(key);
  }

  #clearGraceTimers(registry: Map<string, GraceTimer>): void {
    for (const timer of registry.values()) this.#clearTimeout(timer.handle);
    registry.clear();
  }

  #write(socket: Socket, message: unknown): void {
    if (!socket.destroyed) socket.write(encodeJsonLine(message));
  }

  #requireProfiles(): ProfileService {
    if (!this.#profiles) throw new Error("Profile service not configured on this daemon");
    return this.#profiles;
  }

  #requireOperationDispatch(): OperationDispatchService {
    if (!this.#operationDispatch) {
      throw new Error("Operation dispatch not configured on this daemon");
    }
    return this.#operationDispatch;
  }

  #requireOperationStore(): OperationStore {
    if (!this.#operationStore) throw new Error("Operation store not configured on this daemon");
    return this.#operationStore;
  }

  #requireOperationWait(): OperationWaitService {
    if (!this.#operationWait) throw new Error("Operation wait not configured on this daemon");
    return this.#operationWait;
  }

  #requireOrchestrationTransport(): HerdrOrchestrationTransport {
    if (!this.#orchestrationTransport) {
      throw new Error("Orchestration transport not configured on this daemon");
    }
    return this.#orchestrationTransport;
  }

  #requireDelivery(): ProfileDeliveryService {
    if (!this.#delivery) throw new Error("Delivery service not configured on this daemon");
    return this.#delivery;
  }

  #requireDiagnose(): ProfileDiagnoseService {
    if (!this.#profileDiagnose) throw new Error("Diagnose service not configured on this daemon");
    return this.#profileDiagnose;
  }

  #resolveScope(input: AgentQueryScope): AgentQueryScope {
    if (input.all)
      return {
        all: true,
        ...(input.herdrSessionName ? { herdrSessionName: input.herdrSessionName } : {}),
      };
    if (input.workspaceId && !input.herdrSessionName) {
      const sessions = new Set(
        this.#stores.agents
          .list({ workspaceId: input.workspaceId })
          .map((agent) => agent.herdrSessionName),
      );
      if (sessions.size > 1) {
        throw new Error(
          `workspace ${input.workspaceId} exists in multiple Herdr sessions; pass --session <name>: ${[...sessions].join(", ")}`,
        );
      }
    }
    if (input.workspaceId || input.herdrSessionName) {
      return {
        ...(input.herdrSessionName ? { herdrSessionName: input.herdrSessionName } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      };
    }
    throw new Error(
      "agent scope requires current Herdr workspace, --workspace, --session, or --all",
    );
  }
}

/**
 * Row 15.309: every event that leaves the daemon carries its own context
 * reading, projected from the event's stored append-time history. Computed on
 * read, so stored rows and their identity/dedupe are unchanged.
 */
function withOutcomeContext(event: AgentEventRecord) {
  return { ...event, outcomeContext: projectOutcomeContext(event) };
}

function historyInput(agent: AgentIndexRecord) {
  return {
    agent: agent.agent,
    agentSession: agent.agentSession,
    cwd: agent.cwd,
    foregroundCwd: agent.foregroundCwd,
  };
}

function isTerminalOperationState(state: string): boolean {
  return (
    state === "settled" ||
    state === "blocked" ||
    state === "failed" ||
    state === "target_lost" ||
    state === "submission_unknown" ||
    state === "submission_rejected"
  );
}

function assertSchema(schema: Parameters<typeof Value.Check>[0], value: unknown): void {
  if (!Value.Check(schema, value)) throw new Error("Invalid RPC params");
}

function toWireState(state: AgentOrchestratorState): AgentOrchestratorWireState {
  return { ...state, updatedAt: state.updatedAt.toISOString() };
}

function toWireChange(change: {
  current: AgentOrchestratorState;
  previous: AgentOrchestratorState;
  reason: AgentOrchestratorChanged["reason"];
}): AgentOrchestratorChanged {
  return {
    current: toWireState(change.current),
    previous: toWireState(change.previous),
    reason: change.reason,
  };
}

function sameScope(left: AgentScope, right: AgentScope): boolean {
  return left.herdrSessionName === right.herdrSessionName && left.workspaceId === right.workspaceId;
}

function sameOwner(
  left: AgentOrchestratorState["owner"],
  right: AgentOrchestratorState["owner"],
): boolean {
  return left?.terminalId === right?.terminalId && left?.paneId === right?.paneId;
}

function terminalPresenceKey(input: { herdrSessionName: string; terminalId: string }): string {
  return `${input.herdrSessionName}\0${input.terminalId}`;
}
