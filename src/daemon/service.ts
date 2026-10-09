import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { resolveRuntime } from "@/config/runtime.js";
import { createDaemonInfo, resolvePackageVersion } from "@/daemon/daemon-identity.js";
import { AgentContextSnapshotStore } from "@/db/agent-context-snapshots.js";
import { AgentEventStore } from "@/db/agent-events.js";
import { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import { AgentOrchestratorScopeStore } from "@/db/agent-orchestrator-scopes.js";
import { AgentStore } from "@/db/agents.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { DeliveryObligationStore } from "@/db/delivery-obligations.js";
import { HerdrSessionStore } from "@/db/herdr-sessions.js";
import { HerdrWorkspaceStore } from "@/db/herdr-workspaces.js";
import { OperationStore } from "@/db/operations.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { DemandEventStore } from "@/db/profile-demand-events.js";
import { ProfileOwnerStore } from "@/db/profile-owners.js";
import { SessionAwareOrchestrationTransport } from "@/herdr/session-aware-transport.js";
import { createHerdrSessionListRunner } from "@/herdr/session-list.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import { AgentIndexService } from "@/observability/agent-index-service.js";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import { DemandEligibilityProvider } from "@/observability/demand-eligibility.js";
import { OperationDispatchService } from "@/observability/operation-dispatch-service.js";
import { resolveDispatchTarget } from "@/observability/operation-target-resolver.js";
import { OperationWaitService } from "@/observability/operation-wait-service.js";
import { ProfileDeliveryService } from "@/observability/profile-delivery-service.js";
import { ProfileDemandService } from "@/observability/profile-demand-service.js";
import { ProfileDiagnoseService } from "@/observability/profile-diagnose-service.js";
import { ProfileService } from "@/observability/profile-service.js";
import { HerdrSessionWatchManager } from "./herdr-session-watch-manager.js";
import { ObservabilityRpcServer } from "./observability-server.js";

export async function runObservabilityDaemonService(
  input: { environment?: NodeJS.ProcessEnv | undefined } = {},
): Promise<void> {
  const runtime = resolveRuntime({ environment: input.environment });
  applyEnvironment(runtime.environment);
  mkdirSync(dirname(runtime.paths.dbPath), { recursive: true });
  mkdirSync(dirname(runtime.paths.socketPath), { recursive: true });

  // RUN-20260913-04 D1: resolved ONCE at boot and held — the identity the
  // daemon serves over daemon.info for the rest of its life. process.argv[1]
  // is the dist entry (shepy-daemon.js) whose mtime IS the build stamp; the
  // module URL is the fallback when argv is not a file.
  const daemonInfo = createDaemonInfo({
    entryPath: process.argv[1] ? resolve(process.argv[1]) : fileURLToPath(import.meta.url),
    pid: process.pid,
    version: resolvePackageVersion(dirname(fileURLToPath(import.meta.url))),
  });

  const { sqlite } = openSqlite(runtime.paths.dbPath);
  applyMigrations(sqlite, {
    migrationsFolder: resolveMigrationsFolder(dirname(fileURLToPath(import.meta.url))),
  });

  const herdrSessions = new HerdrSessionStore(sqlite);
  const herdrWorkspaces = new HerdrWorkspaceStore(sqlite);
  const agents = new AgentStore(sqlite);
  const agentEvents = new AgentEventStore(sqlite);
  const agentHistoryCache = new AgentHistoryCacheStore(sqlite);
  const agentContextSnapshots = new AgentContextSnapshotStore(sqlite);
  const agentOrchestratorScopes = new AgentOrchestratorScopeStore(sqlite);
  const orchestratorProfiles = new OrchestratorProfileStore(sqlite);
  const history = createAgentHistoryService({ cache: agentHistoryCache });
  const profileService = new ProfileService({
    agents,
    history,
    profiles: orchestratorProfiles,
  });
  const operationStore = new OperationStore(sqlite);
  const orchestrationTransport = new SessionAwareOrchestrationTransport({
    sessions: herdrSessions,
  });
  const operationDispatch = new OperationDispatchService({
    operations: operationStore,
    resolve: (profileId) => resolveDispatchTarget(profileService.resolveSubscriptions(profileId)),
    transport: orchestrationTransport,
  });
  const operationWait = new OperationWaitService({ operations: operationStore });
  const obligations = new DeliveryObligationStore(sqlite);
  const profileOwners = new ProfileOwnerStore({ sqlite });
  const demandService = new ProfileDemandService(
    new DemandEventStore(sqlite),
    profileOwners,
    new DemandEligibilityProvider(),
  );
  // Upgrade fence (review F3-2): any lease stamp made by the pre-fence,
  // unfenced inbox.lease dies here, once, before the RPC surface exists —
  // rows return to pending and are re-delivered, never dropped.
  obligations.invalidateAllLeases();
  const deliveryService = new ProfileDeliveryService({
    agentEvents,
    agents,
    demands: demandService,
    obligations,
    owners: profileOwners,
    profiles: orchestratorProfiles,
  });
  const diagnoseService = new ProfileDiagnoseService({
    daemonInfo,
    obligations,
    owners: profileOwners,
    profiles: profileService,
  });
  const context = new AgentContextService({
    history,
    stores: { agentContextSnapshots, agents },
  });
  const daemonServices = { context, history };
  const orchestrator = new AgentOrchestratorService({
    agentEvents,
    agents,
    scopes: agentOrchestratorScopes,
  });
  const index = new AgentIndexService({
    context: daemonServices.context,
    stores: { agentEvents, agentHistoryCache, agents, herdrSessions, herdrWorkspaces },
  });

  let watchManager: HerdrSessionWatchManager | undefined;
  const server = new ObservabilityRpcServer({
    context: daemonServices.context,
    daemonInfo,
    delivery: deliveryService,
    demands: demandService,
    profileDiagnose: diagnoseService,
    profiles: profileService,
    operationDispatch,
    operationStore,
    operationWait,
    orchestrationTransport,
    history: daemonServices.history,
    orchestrator,
    registerPiSessionRef: (registration) => index.registerPiSessionRef(registration),
    socketPath: runtime.paths.socketPath,
    stores: { agentEvents, agents, herdrSessions, herdrWorkspaces },
    // Read at request time, not boot: daemon.health must answer the
    // scheduler's CURRENT state. The late assignment is safe — the socket
    // only listens after watchManager exists (server.start comes last).
    watchHealth: () => watchManager?.health(),
  });
  watchManager = new HerdrSessionWatchManager({
    agents,
    herdrSessions,
    index,
    onAgentContextChanged: (scope) => server.publishAgentContext(scope),
    onAgentEvent: (event) => {
      server.publishAgentEvent(event);
      deliveryService.projectAgentEvent(event);
    },
    onAgentIndexRefreshed: (refreshed) => server.reconcileAgentLocations(refreshed),
    sessionList: createHerdrSessionListRunner({ env: runtime.environment }),
  });

  await server.start();
  await watchManager.start();
  console.log(`Shepy daemon listening on ${runtime.paths.socketPath}`);

  const stop = async () => {
    await watchManager.stop();
    await server.stop();
    sqlite.close();
    exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

export function resolveMigrationsFolder(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    const migrationsFolder = resolve(current, "drizzle");
    if (existsSync(resolve(migrationsFolder, "meta", "_journal.json"))) {
      return migrationsFolder;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Cannot find Shepy migrations above ${startDir}`);
    }
    current = parent;
  }
}

function applyEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}
