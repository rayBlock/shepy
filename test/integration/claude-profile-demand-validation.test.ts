import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createAgentHistoryService, emptyCompactHistory } from "@/agent-history/service.js";
import { CONTEXT_MAX_CHARS, CONTEXT_MAX_LINES } from "@/cli/claude-hook.js";
import { ownerRecordPath } from "@/cli/owner-file.js";
import { ObservabilityRpcServer } from "@/daemon/observability-server.js";
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
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { canonicalJson, DemandEventStore } from "@/db/profile-demand-events.js";
import { ProfileOwnerStore } from "@/db/profile-owners.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import { DemandEligibilityProvider } from "@/observability/demand-eligibility.js";
import { ProfileDeliveryService } from "@/observability/profile-delivery-service.js";
import type { DemandRequest } from "@/observability/profile-demand-ingress.js";
import { ProfileDemandService } from "@/observability/profile-demand-service.js";
import { ProfileService } from "@/observability/profile-service.js";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";
import { RpcTestClient } from "./rpc-test-client.js";

/**
 * NEW Source-only fixture. Every control is AUTHORED NOTRUN at author freeze.
 * A later engine admission must supply a new absolute owned runtime root,
 * private parent environment and approved physically owned dependencies.
 * CLI_MODE=source executes actual src/cli/shepy.ts main through tsx; it is
 * not a built-CLI result. CLI_MODE=built executes the subject's dist main,
 * requiring an independently recorded built-file hash. Neither mode imports
 * an installed CLI or starts a daemon process. The in-process RPC server and
 * SQLite, migrations and child CLI all belong to this same source subject.
 * Source/build provenance acceptance and repository checks remain separate.
 * This Git-less export is NOT automatically a build checkout: the subject's
 * stamp-pi-build helper reads Git and rewrites generated SOURCE outside dist.
 * Package prepack can build again and touch caches. A dist entry hash alone
 * does not bind all imports; construction/build/cache admission remains external.
 */
const subject = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const profileId = "fixture-demand-owner";
const sessionId = "synthetic-claude-demand-session";
const sourceId = "fixture-router";
const kinds = ["agent", "profile-demand"];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const pins: Record<string, string> = {
  "src/cli/claude-hook.ts": "08aeb882d0a5bccbfcadde6b783b8547e3a2216f52d756420f9b03ee07f138a8",
  "src/cli/shepy.ts": "28c467f975e86df6a8a018975f0d171e57726ff0c836c2aa230da22b0fa7d7e7",
  "test/integration/claude-hook.test.ts":
    "19b5b5a2e99e5cfe5aad88c907d3f4cc822bc54fba0f4ce195b43a9cc63e91fa",
  "test/unit/cli.test.ts": "02ed2f3ffdecf05ec76c97bd664a5125e42ed27623be92839e8024d47bce800b",
  "test/unit/claude-hook-lapsed-recovery-warning.test.ts":
    "84fbbf1660216d758d15984ce17c88dccc9d3e8496a307b8dcded4588c45e156",
  "README.md": "e0977c84eebf7da6203f96b15e1a4c103d10683a5fe65575444d5587a077455d",
  "src/observability/profile-demand-ingress.ts":
    "62c8bf43a39253fb34b37b91d4a09c1d495b074be034fea6fb576d156a4a0454",
};

function contained(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function regularPrivatePath(path: string): string {
  if (!isAbsolute(path)) throw new Error("fixture requires absolute paths");
  let part = resolve(path);
  while (part !== dirname(part)) {
    if (lstatSync(part).isSymbolicLink()) throw new Error(`fixture refuses alias: ${part}`);
    part = dirname(part);
  }
  return realpathSync(path);
}

/** Pure path guard: no filesystem reads/writes, constructors or environment mutation. */
function assertDisjointRuntimeRoot(root: string, frozenSubject: string): void {
  const runtime = resolve(root);
  const frozen = resolve(frozenSubject);
  if (
    runtime === "/" ||
    runtime === frozen ||
    contained(frozen, runtime) ||
    contained(runtime, frozen)
  ) {
    throw new Error("runtime root must be separate from the frozen source subject");
  }
}

/** Fail closed BEFORE constructors, database initialization or server listen. */
function admittedRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const rootValue = environment.SHEPY_DEMAND_FIXTURE_ROOT;
  if (!rootValue || environment.SHEPY_DEMAND_FIXTURE_ADMISSION !== "isolated-fixture") {
    throw new Error("NOTRUN: explicit isolated fixture runtime admission/environment is required");
  }
  const root = regularPrivatePath(rootValue);
  assertDisjointRuntimeRoot(root, subject);
  for (const key of [
    "HOME",
    "SHEPY_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "TMPDIR",
    "HERDR_SOCKET_PATH",
  ]) {
    const path = environment[key];
    if (!path || !isAbsolute(path) || !contained(resolve(path), root)) {
      throw new Error(`fixture refuses parent fallback: ${key}`);
    }
  }
  if (environment.NODE_OPTIONS || environment.NODE_PATH || environment.HERDR_BIN_PATH) {
    throw new Error("fixture refuses inherited executable/loader discovery overrides");
  }
  for (const [path, sha256] of Object.entries(pins)) {
    const file = regularPrivatePath(join(subject, path));
    if (!contained(file, subject) || digest(readFileSync(file)) !== sha256) {
      throw new Error(`fixture source pairing mismatch: ${path}`);
    }
  }
  if (!["source", "built"].includes(environment.SHEPY_DEMAND_FIXTURE_CLI_MODE ?? "")) {
    throw new Error("fixture requires an explicit source or built CLI mode");
  }
  return root;
}

type Wire = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};
type OwnerFile = {
  leaseToken: string;
  delivered: { ids: string[]; phase: "leased" | "delivered"; promptId: string | null } | null;
  failedDelivery?: { attempts: number; ids: string[] };
};
type ChildResult = { code: number | null; stdout: string; stderr: string };
type LeaseCorruption = "none" | "unknown-source" | "malformed-envelope";
type LeaseCorruptionWitness = {
  fault: Exclude<LeaseCorruption, "none">;
  requestId: number | undefined;
  wire: {
    id: unknown;
    profileId: unknown;
    profileDemandEventId: unknown;
    sourceKind: unknown;
    kind: unknown;
    agentEventId: unknown;
    state: unknown;
    leaseToken: unknown;
  };
  stored: ReturnType<DeliveryObligationStore["byId"]>;
  event: { id: string; profileId: string; episodeId: string } | null;
};
const finalizers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const finish of finalizers.splice(0).reverse()) await finish();
  // Captures, private databases, owner records and partials are retained.
  // No rm, shared output cleanup, worktree or dependency mutation occurs.
});

async function fixture() {
  const root = admittedRoot();
  const dir = realpathSync(mkdtempSync(join(root, "demand-")));
  const home = join(dir, "home");
  const shepyHome = join(dir, "shepy");
  for (const path of [
    home,
    shepyHome,
    join(dir, "tmp"),
    join(dir, "bin"),
    join(dir, "xdg-config"),
    join(dir, "xdg-data"),
    join(dir, "xdg-cache"),
  ]) {
    mkdirSync(path);
  }
  const backendSocket = join(dir, "backend.sock");
  const socketPath = join(shepyHome, "shepy.sock");
  const { sqlite } = openSqlite(join(dir, "fixture.sqlite"));
  finalizers.push(async () => {
    sqlite.close();
  });
  applyMigrations(sqlite, { migrationsFolder: join(subject, "drizzle") });
  let now = Date.now();
  const clock = () => now;
  const stamp = (ms: number) => new Date(ms).toISOString();
  const generation = {
    herdrSession: "fixture-herdr",
    workspaceId: "fixture-workspace",
    paneId: "fixture:p1",
    terminalId: "fixture:p1", // Claude hook uses paneId as terminalId.
    nativeSessionRef: sessionId, // Hook's harness session reference is kind id, not a file path.
  };
  const ref = (name: string, value: unknown) => {
    const path = join(dir, name);
    const contents = JSON.stringify(value);
    writeFileSync(path, contents, { mode: 0o600 });
    return { path, sha256: digest(contents), selector: "root" };
  };
  const grantRef = ref("grant.json", { synthetic: true, scope: "fixture-only" });
  const snapshotRef = ref("snapshot.json", { synthetic: true, privatePayload: "DO-NOT-RENDER" });
  const markerRef = ref("marker.json", { synthetic: true });
  const stopPath = join(dir, "STOP");
  const seatStatePath = join(dir, "seat-state.json");
  const allowlistPath = join(dir, "allowlist.json");
  const dutyPath = join(dir, "duty.json");
  const writeState = () =>
    writeFileSync(
      seatStatePath,
      JSON.stringify({
        schema: "factory.seat-state.v1",
        seat: profileId,
        ts: stamp(now),
        ctxPct: 10,
        zone: "green",
        unknown: [],
      }),
    );
  const duty = (mode: "on-duty" | "off-duty" | "waiting" | "deferred" = "on-duty") => {
    const observationRef = ref("capacity.json", {
      observedAt: stamp(now),
      seatGeneration: generation,
      activeInvocationIds: [],
      occupiedSlots: 0,
      availableSlots: 1,
      scopeRef: grantRef,
    });
    return ref("duty.json", {
      schema: "factory.duty.v1",
      seatId: profileId,
      profileId,
      ownerGeneration: generation,
      grantRef,
      mode,
      window: { startsAt: stamp(now - 60_000), endsAt: stamp(now + 60 * 60_000), timezone: "UTC" },
      queues: [
        {
          root: dir,
          queuePath: join(dir, "queue.json"),
          ownership: [
            {
              rowId: "fixture-1",
              packetId: "fixture",
              actionClass: "execute",
              packetRef: snapshotRef,
              grantRef,
            },
          ],
        },
      ],
      capacity: { maxInFlight: 1, observationRef, maxAgeSeconds: 30 },
      stopPaths: [stopPath],
      nextDecision: { reasonRef: grantRef, eventRef: null, revisitAt: stamp(now + 30 * 60_000) },
      successor: { profileId: "fixture-successor", routeRef: grantRef, ownerGeneration: null },
      policy: {
        idleGraceSeconds: 60,
        cooldownSeconds: 1200,
        maxWakesPerHour: 3,
        maxReminderCount: 1,
        defaultRevisitSeconds: 1200,
      },
    });
  };
  writeState();
  writeFileSync(
    allowlistPath,
    JSON.stringify({
      schema: "shepy.ingress-allowlist.v1",
      sources: {
        [sourceId]: {
          profiles: [profileId],
          kinds: ["queue-claimable"],
          duty_paths: [dutyPath],
          grant_hashes: [grantRef.sha256],
          evidence_roots: [dir],
          max_expiry_minutes: 60,
          seat_state_path: seatStatePath,
        },
      },
    }),
  );
  const stores = {
    agents: new AgentStore(sqlite),
    agentEvents: new AgentEventStore(sqlite),
    herdrSessions: new HerdrSessionStore(sqlite),
    herdrWorkspaces: new HerdrWorkspaceStore(sqlite),
  };
  stores.herdrSessions.upsertRunning({
    name: generation.herdrSession,
    sessionDir: join(dir, "no-herdr-session"),
    socketPath: join(dir, "forbidden-herdr.sock"),
  });
  stores.agents.replaceForSession({
    herdrSessionName: generation.herdrSession,
    agents: [
      {
        agent: "claude",
        agent_status: "idle",
        focused: false,
        pane_id: generation.paneId,
        terminal_id: generation.terminalId,
        workspace_id: generation.workspaceId,
      },
      {
        agent: "hermes",
        agent_status: "working",
        focused: false,
        name: "fixture-builder",
        pane_id: "fixture:p2",
        terminal_id: "fixture:t2",
        workspace_id: generation.workspaceId,
      },
    ],
  });
  const profiles = new OrchestratorProfileStore(sqlite);
  profiles.createProfile({ profileId, displayName: "Synthetic fixture", projectRoots: [] });
  profiles.addSubscription({
    profileId,
    herdrSessionName: generation.herdrSession,
    agentSelectorJson: JSON.stringify({ kind: "name", value: "fixture-builder" }),
    workspaceSelectorJson: JSON.stringify({
      herdrSession: generation.herdrSession,
      workspaceId: generation.workspaceId,
    }),
  });
  const owners = new ProfileOwnerStore({ sqlite, now: clock });
  const events = new DemandEventStore(sqlite);
  const obligations = new DeliveryObligationStore(sqlite);
  const eligibility = new DemandEligibilityProvider({
    allowlistPath,
    requiredStopPath: stopPath,
    now: clock,
  });
  const demands = new ProfileDemandService(events, owners, eligibility, {
    allowlistPath,
    now: clock,
  });
  const delivery = new ProfileDeliveryService({
    ...stores,
    profiles,
    owners,
    obligations,
    demands,
    now: clock,
  });
  const history = createAgentHistoryService({
    cache: new AgentHistoryCacheStore(sqlite),
    homeDir: home,
    discover: async () => null,
    readers: [],
  });
  const server = new ObservabilityRpcServer({
    stores,
    demands,
    delivery,
    history,
    socketPath: backendSocket,
    now: clock,
    context: new AgentContextService({
      history,
      stores: {
        agents: stores.agents,
        agentContextSnapshots: new AgentContextSnapshotStore(sqlite),
      },
    }),
    orchestrator: new AgentOrchestratorService({
      agents: stores.agents,
      agentEvents: stores.agentEvents,
      scopes: new AgentOrchestratorScopeStore(sqlite),
    }),
    profiles: new ProfileService({ agents: stores.agents, history, profiles }),
    resolvePaneIdentity: async () => {
      throw new Error("fixture forbids real Herdr discovery");
    },
  });
  finalizers.push(async () => {
    await server.stop();
  });
  await server.start();

  const requests: Wire[] = [];
  const responses: Wire[] = [];
  const sockets = new Set<Socket>();
  const faults = {
    probe: "capable" as "capable" | "unsupported" | "refused",
    delivered: false,
    explicitAgent: false,
    lease: "none" as LeaseCorruption,
  };
  const leaseCorruptions: LeaseCorruptionWitness[] = [];
  let phaseOne: OwnerFile | null = null;
  const ownerPath = ownerRecordPath(shepyHome, sessionId, profileId);
  const owner = (): OwnerFile => JSON.parse(readFileSync(ownerPath, "utf8")) as OwnerFile;
  // An exclusively owned JSON-lines capture relay. Disclosed protocol faults:
  // capability contrast, delivery refusal BEFORE commit, a known explicit
  // agent discriminator, and unknown-source/malformed-envelope corruption
  // AFTER a genuinely published demand has crossed the REAL lease/store boundary.
  // Only that last wire response is changed; publication, eligibility, source
  // family and token-stamped persistent state are never replaced or recast.
  const proxy = createServer((downstream) => {
    const upstream = createConnection(backendSocket);
    sockets.add(downstream);
    sockets.add(upstream);
    const requestDecoder = new JsonLineDecoder();
    const responseDecoder = new JsonLineDecoder();
    const methods = new Map<number, string>();
    downstream.on("data", (chunk) => {
      for (const value of requestDecoder.push(chunk.toString("utf8"))) {
        const message = value as Wire;
        requests.push(message);
        if (message.id !== undefined && message.method) methods.set(message.id, message.method);
        if (message.method === "daemon.info" && faults.probe === "refused") {
          downstream.write(
            encodeJsonLine({
              id: message.id,
              error: { message: "fixture capability probe refused" },
            }),
          );
        } else if (message.method === "inbox.delivered" && faults.delivered) {
          phaseOne = owner();
          downstream.write(
            encodeJsonLine({
              id: message.id,
              error: { message: "fixture delivery refused before commit" },
            }),
          );
        } else upstream.write(encodeJsonLine(value));
      }
    });
    upstream.on("data", (chunk) => {
      for (const value of responseDecoder.push(chunk.toString("utf8"))) {
        const message = value as Wire;
        const method = message.id === undefined ? undefined : methods.get(message.id);
        if (method === "daemon.info" && faults.probe === "unsupported") {
          message.result = { ...(message.result as Record<string, unknown>), capabilities: [] };
        }
        if (method === "inbox.lease" && faults.explicitAgent) {
          const result = message.result as
            | { obligations?: Array<Record<string, unknown>> }
            | undefined;
          for (const row of result?.obligations ?? []) {
            if (typeof row.agentEventId === "number") row.sourceKind = "agent";
          }
        }
        if (method === "inbox.lease" && faults.lease !== "none") {
          const result = message.result as
            | { obligations?: Array<Record<string, unknown>> }
            | undefined;
          const row = result?.obligations?.find((item) => item.sourceKind === "profile-demand");
          if (row && typeof row.id === "string" && typeof row.profileDemandEventId === "string") {
            const event = events.get(row.profileDemandEventId);
            // Capture actual original wire identity and current private store
            // stamp BEFORE corrupting the response. No synthetic leased row.
            leaseCorruptions.push({
              fault: faults.lease,
              requestId: message.id,
              wire: {
                id: row.id,
                profileId: row.profileId,
                profileDemandEventId: row.profileDemandEventId,
                sourceKind: row.sourceKind,
                kind: row.kind,
                agentEventId: row.agentEventId,
                state: row.state,
                leaseToken: row.leaseToken,
              },
              stored: obligations.byId(row.id),
              event: event
                ? { id: event.id, profileId: event.profile_id, episodeId: event.episode_id }
                : null,
            });
            if (faults.lease === "unknown-source") row.sourceKind = "fixture-unknown-source";
            else message.result = { ...result, obligations: { malformedFixtureEnvelope: true } };
          }
        }
        responses.push(message);
        downstream.write(encodeJsonLine(message));
      }
    });
    downstream.on("close", () => {
      sockets.delete(downstream);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      downstream.destroy();
    });
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
  });
  finalizers.push(async () => {
    for (const socket of sockets) socket.destroy();
    if (proxy.listening)
      await new Promise<void>((done, reject) =>
        proxy.close((error) => (error ? reject(error) : done())),
      );
  });
  await new Promise<void>((done, reject) => {
    proxy.once("error", reject);
    proxy.listen(socketPath, done);
  });
  const rpc = await RpcTestClient.connect(backendSocket);
  finalizers.push(async () => {
    rpc.close();
  });
  let sequence = 0;
  const request = (
    seed = "a",
    mode: "on-duty" | "off-duty" | "waiting" | "deferred" = "on-duty",
    millis = 0,
  ): DemandRequest => {
    const episodeId = seed.repeat(64);
    const start = Math.floor(now / 1000) * 1000 + millis;
    return {
      schema: "factory.demand.v1",
      sourceId,
      profileId,
      kind: "queue-claimable",
      episodeId,
      actionFingerprint: "f".repeat(64),
      activationRevision: 1,
      idempotencyKey: `${episodeId}/queue-claimable/1`,
      seatId: profileId,
      ownerGeneration: generation,
      dutyRef: duty(mode),
      grantRef,
      snapshotRef,
      markerRef,
      observedAt: stamp(start),
      expiresAt: stamp(start + 30 * 60_000),
      reasonCode: "owned-ready-capacity",
    };
  };
  const agent = (text = "synthetic worker done") => {
    const worker = stores.agents.list().find((row) => row.name === "fixture-builder");
    if (!worker) throw new Error("fixture builder absent");
    const key = `fixture-agent-${sequence++}`;
    const event = stores.agentEvents.append({
      agentId: worker.id,
      herdrSessionName: generation.herdrSession,
      paneId: "fixture:p2",
      terminalId: "fixture:t2",
      workspaceId: generation.workspaceId,
      type: "agent.done",
      idempotencyKey: key,
      payload: { agent: "hermes", name: "fixture-builder", from: "working", to: "done" },
      compactHistory: {
        ...emptyCompactHistory("hermes-sqlite"),
        messageCount: 2,
        lastAssistantMessage: { ref: `ref-${key}`, text, timestamp: null },
      },
    });
    delivery.projectAgentEvent(event);
    const obligation = obligations.byProfileEvent(profileId, event.id);
    if (!obligation) throw new Error("real agent projection failed");
    return { event, obligation };
  };
  const child = async (
    event = "UserPromptSubmit",
    optIn = true,
    active = false,
  ): Promise<ChildResult> => {
    const invocation = sequence++;
    const mode = process.env.SHEPY_DEMAND_FIXTURE_CLI_MODE;
    const cli = join(subject, mode === "built" ? "dist/src/cli/shepy.js" : "src/cli/shepy.ts");
    regularPrivatePath(cli);
    if (
      mode === "built" &&
      (!process.env.SHEPY_DEMAND_FIXTURE_BUILT_CLI_SHA256 ||
        digest(readFileSync(cli)) !== process.env.SHEPY_DEMAND_FIXTURE_BUILT_CLI_SHA256)
    ) {
      throw new Error("built CLI requires separately frozen build pairing/hash");
    }
    for (const file of ["runtime.json", "config.yaml", ".env"]) {
      if (existsSync(join(shepyHome, file)))
        throw new Error(`fixture refuses runtime redirect: ${file}`);
    }
    const args = [
      ...(mode === "source" ? ["--import", "tsx"] : []),
      cli,
      "claude-hook",
      "--profile",
      profileId,
      ...(optIn ? ["--profile-demand"] : []),
    ];
    // No spread of process.env: especially no production socket, NODE_OPTIONS,
    // settings, credentials, native session, PATH or Herdr executable.
    const environment: NodeJS.ProcessEnv = {
      HOME: home,
      SHEPY_HOME: shepyHome,
      TMPDIR: join(dir, "tmp"),
      XDG_CONFIG_HOME: join(dir, "xdg-config"),
      XDG_DATA_HOME: join(dir, "xdg-data"),
      XDG_CACHE_HOME: join(dir, "xdg-cache"),
      HERDR_SOCKET_PATH: join(dir, "forbidden-herdr.sock"),
      HERDR_PANE_ID: generation.paneId,
      HERDR_WORKSPACE_ID: generation.workspaceId,
      PATH: join(dir, "bin"),
      LANG: "C",
      TZ: "UTC",
    };
    const payload = {
      hook_event_name: event,
      session_id: sessionId,
      prompt_id: `fixture-prompt-${invocation}`,
      cwd: dir,
      transcript_path: join(dir, "nonexistent-transcript.jsonl"),
      stop_hook_active: active,
      last_assistant_message: "synthetic final",
    };
    writeFileSync(join(dir, `child-${invocation}-input.json`), JSON.stringify(payload));
    writeFileSync(
      join(dir, `child-${invocation}-pairing.json`),
      JSON.stringify({
        mode,
        subject,
        cli,
        cliSha256: digest(readFileSync(cli)),
        node: process.execPath,
        nodeVersion: process.version,
        args,
        environment,
      }),
    );
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    return await new Promise<ChildResult>((done, reject) => {
      const proc = spawn(process.execPath, args, {
        cwd: subject,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let exceeded = false;
      let terminating: ReturnType<typeof setTimeout> | undefined;
      // A direct-child timer is not a descendant-release carrier. Test abort
      // or finalizer failure still requires separately admitted lifecycle proof.
      const timer = setTimeout(() => {
        exceeded = true;
        proc.kill("SIGTERM");
        terminating = setTimeout(() => {
          proc.kill("SIGKILL");
        }, 1000);
      }, 15_000);
      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.once("error", (error) => {
        clearTimeout(timer);
        if (terminating) clearTimeout(terminating);
        reject(error);
      });
      proc.once("close", (code, signal) => {
        clearTimeout(timer);
        if (terminating) clearTimeout(terminating);
        writeFileSync(join(dir, `child-${invocation}-stdout.txt`), stdout);
        writeFileSync(join(dir, `child-${invocation}-stderr.txt`), stderr);
        writeFileSync(
          join(dir, `child-${invocation}-result.json`),
          JSON.stringify({
            pid: proc.pid,
            parentPid: process.pid,
            startedAt,
            elapsedMs: Date.now() - startMs,
            code,
            signal,
            exceeded,
          }),
        );
        if (exceeded || signal)
          reject(new Error(`incomplete child ${proc.pid}: ${signal ?? "deadline"}`));
        else done({ code, stdout, stderr });
      });
      proc.stdin.on("error", () => undefined);
      proc.stdin.end(JSON.stringify(payload));
    });
  };
  return {
    dir,
    sqlite,
    generation,
    profiles,
    events,
    obligations,
    owners,
    demands,
    delivery,
    rpc,
    requests,
    responses,
    faults,
    leaseCorruptions,
    request,
    ref,
    agent,
    child,
    owner,
    phaseOne: () => phaseOne,
    stopPath,
    setClock: (value: number) => {
      now = value;
    },
    clock,
    writeState,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function context(result: ChildResult): string {
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout
    ? ((JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput?.additionalContext ?? "")
    : "";
}
function calls(h: Fixture, method: string): Array<Record<string, unknown>> {
  return h.requests.filter((row) => row.method === method).map((row) => row.params ?? {});
}
function noLeaks(h: Fixture, result: ChildResult) {
  expect(result.stdout).not.toContain(h.owner().leaseToken);
  expect(result.stdout).not.toContain("DO-NOT-RENDER");
}
function published(h: Fixture, request: DemandRequest) {
  return h.demands.publishDemand(request);
}
function pendingNotSeen(h: Fixture, id: string) {
  expect(h.obligations.byId(id)?.state).toBe("pending");
  expect(h.owner().delivered?.ids ?? []).not.toContain(id);
  for (const method of ["inbox.delivered", "inbox.ack"]) {
    for (const input of calls(h, method)) expect(input.ids).not.toContain(id);
  }
}

describe("runtime-root disjointness pure contrasts (AUTHORED NOTRUN)", () => {
  test.each([
    ["equal", subject],
    ["ancestor", dirname(subject)],
    ["descendant", join(subject, "test")],
  ] as const)("rejects %s without constructing or writing anything in frozen Source", (_relation, root) => {
    // Existing paths only. The pure guard cannot write; admittedRoot also
    // refuses at this guard before parent checks or any fixture constructor.
    // No mkdir, fixture(), environment mutation, DB, server or child is used.
    expect(() => assertDisjointRuntimeRoot(root, subject)).toThrow("runtime root must be separate");
    expect(() =>
      admittedRoot({
        SHEPY_DEMAND_FIXTURE_ROOT: root,
        SHEPY_DEMAND_FIXTURE_ADMISSION: "isolated-fixture",
      }),
    ).toThrow("runtime root must be separate");
  });
  test("the pure guard accepts a lexically disjoint sibling without creating it", () => {
    expect(() =>
      assertDisjointRuntimeRoot(join(dirname(subject), "uncreated-runtime-sibling"), subject),
    ).not.toThrow();
  });
});

describe.sequential("real demand publication, CLI main and custody (AUTHORED NOTRUN)", () => {
  test("default opt-out consumes a real legacy agent but neither advertises nor consumes demand", async () => {
    const h = await fixture();
    const demand = published(h, h.request());
    h.agent();
    const result = await h.child("UserPromptSubmit", false);
    expect(context(result)).toContain(
      "fixture-builder done (hermes, fixture:p2): synthetic worker done",
    );
    expect(context(result)).not.toContain(demand.obligationId);
    expect(calls(h, "daemon.info")).toEqual([]);
    expect(calls(h, "profile.claim")[0]).not.toHaveProperty("acceptedSourceKinds");
    expect(calls(h, "inbox.lease")[0]).not.toHaveProperty("sourceKinds");
    expect(h.owners.get(profileId)?.acceptedSourceKinds).toEqual(["agent"]);
    pendingNotSeen(h, demand.obligationId);
    noLeaks(h, result);
  });

  test.each([
    0, 123,
  ])("canonical live milliseconds %i publish, bind, lease, render and next-invocation ACK", async (millis) => {
    const h = await fixture();
    const request = h.request("a", "on-duty", millis);
    // Real service publication through isolated RPC, not DemandEventStore.publish alone.
    const first = (await h.rpc.request("inbox.publishDemand", request)) as ReturnType<
      ProfileDemandService["publishDemand"]
    >;
    expect(first.disposition).toBe("created");
    expect(await h.rpc.request("inbox.publishDemand", request)).toEqual({
      ...first,
      disposition: "existing",
    });
    expect(h.events.get(first.demandEventId)).toMatchObject({
      profile_id: profileId,
      source_id: sourceId,
      episode_id: request.episodeId,
      activation_revision: 1,
      idempotency_key: request.idempotencyKey,
      payload_json: canonicalJson(request),
      payload_sha256: digest(canonicalJson(request)),
    });
    expect(h.obligations.byId(first.obligationId)).toMatchObject({
      kind: "demand",
      profileId,
      profileDemandEventId: first.demandEventId,
      agentEventId: null,
      state: "pending",
    });
    const result = await h.child();
    expect(context(result)).toContain(first.obligationId);
    expect(context(result)).toContain(first.demandEventId);
    expect(context(result)).toContain(request.episodeId);
    expect(context(result)).toContain("revision 1");
    expect(h.owner().delivered).toMatchObject({ ids: [first.obligationId], phase: "delivered" });
    expect(h.obligations.byId(first.obligationId)?.state).toBe("delivered");
    expect(calls(h, "profile.claim")[0]?.acceptedSourceKinds).toEqual(kinds);
    expect(calls(h, "inbox.lease")[0]?.sourceKinds).toEqual(kinds);
    expect(calls(h, "inbox.delivered")[0]?.ids).toEqual([first.obligationId]);
    expect(calls(h, "inbox.ack")).toEqual([]);
    noLeaks(h, result);
    const next = await h.child();
    expect(context(next)).toBe("");
    expect(calls(h, "inbox.ack").map((row) => row.ids)).toEqual([[first.obligationId]]);
    expect(h.obligations.byId(first.obligationId)?.state).toBe("acked");
  });

  test.each([
    false,
    true,
  ])("mixed real families preserve IDs and known explicit agent discriminator %s", async (explicit) => {
    const h = await fixture();
    h.faults.explicitAgent = explicit;
    const worker = h.agent();
    const demand = published(h, h.request());
    const result = await h.child();
    const ids = h.owner().delivered?.ids ?? [];
    expect(new Set(ids)).toEqual(new Set([worker.obligation.id, demand.obligationId]));
    expect(context(result)).toContain("[SHEPY PROFILE OUTCOMES]");
    expect(context(result)).toContain("[SHEPY DUTY DEMANDS]");
    expect(h.obligations.byId(worker.obligation.id)).toMatchObject({
      kind: "agent",
      agentEventId: worker.event.id,
      profileDemandEventId: null,
    });
    expect(h.obligations.byId(demand.obligationId)).toMatchObject({
      kind: "demand",
      agentEventId: null,
      profileDemandEventId: demand.demandEventId,
    });
    await h.child("Stop", true, true);
    expect(calls(h, "inbox.ack").map((row) => row.ids)).toEqual([ids]);
    for (const id of ids) expect(h.obligations.byId(id)?.state).toBe("acked");
    noLeaks(h, result);
  });

  test.each([
    "unsupported",
    "refused",
  ] as const)("%s probe falls back to agent-only without demand ACK", async (probe) => {
    const h = await fixture();
    const demand = published(h, h.request());
    const worker = h.agent();
    h.faults.probe = probe;
    expect(context(await h.child())).toContain(
      "fixture-builder done (hermes, fixture:p2): synthetic worker done",
    );
    expect(calls(h, "daemon.info")).toHaveLength(1);
    expect(calls(h, "profile.claim")[0]).not.toHaveProperty("acceptedSourceKinds");
    expect(calls(h, "inbox.lease")[0]).not.toHaveProperty("sourceKinds");
    const stop = await h.child("Stop");
    expect(context(stop)).toBe("");
    expect(calls(h, "inbox.lease").every((input) => input.sourceKinds === undefined)).toBe(true);
    pendingNotSeen(h, demand.obligationId);
    expect(calls(h, "inbox.ack").map((row) => row.ids)).toEqual([[worker.obligation.id]]);
  });

  test.each([
    "none",
    "unknown-source",
    "malformed-envelope",
  ] as const)("genuine demand after REAL lease: %s wire sibling never ACKs unseen data", async (fault) => {
    const h = await fixture();
    const request = h.request();
    const demand = published(h, request);
    expect(h.events.get(demand.demandEventId)).toMatchObject({
      id: demand.demandEventId,
      profile_id: profileId,
      episode_id: request.episodeId,
    });
    expect(h.obligations.byId(demand.obligationId)).toMatchObject({
      profileId,
      kind: "demand",
      profileDemandEventId: demand.demandEventId,
      agentEventId: null,
      state: "pending",
    });
    h.faults.lease = fault;
    const result = await h.child();
    if (fault === "none") {
      // Positive sibling crosses the exact same actual publication/service,
      // eligibility/store, RPC and child-main path, with no wire corruption.
      expect(h.leaseCorruptions).toEqual([]);
      expect(context(result)).toContain(demand.obligationId);
      expect(context(result)).toContain(demand.demandEventId);
      expect(h.owner().delivered).toMatchObject({ phase: "delivered", ids: [demand.obligationId] });
      expect(h.obligations.byId(demand.obligationId)?.state).toBe("delivered");
      expect(calls(h, "inbox.delivered").map((input) => input.ids)).toEqual([
        [demand.obligationId],
      ]);
      await h.child();
      expect(calls(h, "inbox.ack").map((input) => input.ids)).toEqual([[demand.obligationId]]);
      expect(h.obligations.byId(demand.obligationId)?.state).toBe("acked");
      return;
    }

    // R3: the relay witness was captured BEFORE corruption from the real
    // demand-family response and its actual token-stamped private store row.
    expect(h.leaseCorruptions).toHaveLength(1);
    const witness = h.leaseCorruptions[0];
    if (!witness) throw new Error("expected actual post-lease corruption witness");
    expect(witness.fault).toBe(fault);
    expect(witness.wire).toMatchObject({
      id: demand.obligationId,
      profileId,
      profileDemandEventId: demand.demandEventId,
      sourceKind: "profile-demand",
      kind: "demand",
      agentEventId: null,
      state: "leased",
    });
    expect(witness.wire.leaseToken).toBe(h.owner().leaseToken);
    expect(witness.stored).toMatchObject({
      id: demand.obligationId,
      profileId,
      kind: "demand",
      profileDemandEventId: demand.demandEventId,
      agentEventId: null,
      state: "leased",
      leaseToken: witness.wire.leaseToken,
    });
    expect(witness.event).toEqual({
      id: demand.demandEventId,
      profileId,
      episodeId: request.episodeId,
    });
    const leaseRequest = h.requests.find(
      (message) => message.id === witness.requestId && message.method === "inbox.lease",
    );
    expect(leaseRequest?.params).toMatchObject({
      profileId,
      leaseToken: witness.wire.leaseToken,
      sourceKinds: kinds,
    });
    const corruptResponse = h.responses.find((message) => message.id === witness.requestId);
    if (fault === "unknown-source") {
      expect(
        (corruptResponse?.result as { obligations: Array<Record<string, unknown>> }).obligations[0],
      ).toMatchObject({ id: demand.obligationId, sourceKind: "fixture-unknown-source" });
    } else {
      expect((corruptResponse?.result as { obligations: unknown }).obligations).toEqual({
        malformedFixtureEnvelope: true,
      });
    }
    expect(context(result)).toBe("");
    expect(result.stdout).not.toContain(demand.obligationId);
    expect(h.owner().delivered).toBeNull();
    expect(h.owner().failedDelivery).toMatchObject({ attempts: 1, ids: [] });
    expect(h.obligations.byId(demand.obligationId)).toMatchObject({
      state: "leased",
      leaseToken: witness.wire.leaseToken,
    });
    for (const method of ["inbox.delivered", "inbox.nack", "inbox.defer", "inbox.ack"])
      expect(calls(h, method)).toEqual([]);
    noLeaks(h, result);

    // Remove ONLY the wire fault, not the real active lease or its token.
    // The unseen batch is still leased, so a later prompt must not ACK it
    // from fabricated custody; an ack-only Stop must not ACK it either.
    h.faults.lease = "none";
    expect(context(await h.child())).toBe("");
    expect(context(await h.child("Stop", true, true))).toBe("");
    expect(h.owner().delivered).toBeNull();
    expect(h.obligations.byId(demand.obligationId)).toMatchObject({
      profileId,
      kind: "demand",
      profileDemandEventId: demand.demandEventId,
      state: "leased",
      leaseToken: witness.wire.leaseToken,
    });
    expect(calls(h, "inbox.delivered")).toEqual([]);
    expect(calls(h, "inbox.ack")).toEqual([]);
    expect(h.leaseCorruptions).toHaveLength(1);
  });

  test.each([
    "off-duty",
    "waiting",
    "deferred",
  ] as const)("%s duty persists a genuine withheld event", async (mode) => {
    const h = await fixture();
    const request = h.request("a", mode);
    const demand = published(h, request);
    expect(h.events.lookup(request)).toMatchObject({
      found: true,
      state: "pending",
      withheldReason: `demand:duty-${mode}`,
    });
    expect(context(await h.child())).toBe("");
    pendingNotSeen(h, demand.obligationId);
  });

  test("unclaimed and agent-only owners retain their genuine withholding reasons", async () => {
    const h = await fixture();
    const request = h.request();
    const demand = published(h, request);
    expect(h.events.lookup(request)).toMatchObject({
      state: "pending",
      withheldReason: "demand:owner-unclaimed",
    });
    await h.child("UserPromptSubmit", false);
    const next = h.request("b");
    published(h, next);
    expect(h.events.lookup(next)).toMatchObject({
      state: "pending",
      withheldReason: "demand:owner-capability-unknown",
    });
    pendingNotSeen(h, demand.obligationId);
  });

  test.each([
    "hash",
    "profile",
    "snapshot",
    "expired",
    "stale-capacity",
  ] as const)("private %s corruption/contrast is withheld without representation or ACK", async (fault) => {
    const h = await fixture();
    const request = h.request();
    const demand = published(h, request);
    let reason = "demand:invalid-event";
    if (fault === "hash") {
      // Intentional corruption ONLY of the private fixture event hash.
      h.sqlite
        .prepare("update profile_demand_events set payload_sha256 = ? where id = ?")
        .run("0".repeat(64), demand.demandEventId);
      reason = "demand:episode-mismatch";
    } else if (fault === "profile") {
      // R1: create a REAL valid synthetic referenced profile before the
      // intentional private event corruption. Foreign keys stay enabled.
      const foreignProfileId = "fixture-foreign-profile";
      h.profiles.createProfile({
        profileId: foreignProfileId,
        displayName: "Synthetic foreign fixture",
        projectRoots: [],
      });
      expect(h.profiles.getProfile(foreignProfileId)?.profileId).toBe(foreignProfileId);
      const originalObligation = h.obligations.byId(demand.obligationId);
      expect(originalObligation).toMatchObject({
        profileId,
        kind: "demand",
        profileDemandEventId: demand.demandEventId,
        agentEventId: null,
        state: "pending",
      });
      const installed = h.sqlite
        .prepare("update profile_demand_events set profile_id = ? where id = ?")
        .run(foreignProfileId, demand.demandEventId);
      expect(Number(installed.changes)).toBe(1);
      expect(h.events.get(demand.demandEventId)).toMatchObject({
        id: demand.demandEventId,
        profile_id: foreignProfileId,
        episode_id: request.episodeId,
      });
      expect(h.obligations.byId(demand.obligationId)).toEqual(originalObligation);
      reason = "demand:event-missing";
    } else if (fault === "snapshot") {
      writeFileSync(request.snapshotRef.path, JSON.stringify({ syntheticTamper: true }));
    } else if (fault === "expired") {
      h.setClock(Date.parse(request.expiresAt) + 1);
    } else {
      h.setClock(h.clock() + 31_000);
      reason = "demand:capacity-unavailable";
    }
    expect(context(await h.child())).toBe("");
    expect(h.obligations.byId(demand.obligationId)?.lastErrorCode).toBe(reason);
    if (fault === "profile") {
      expect(h.events.get(demand.demandEventId)?.profile_id).toBe("fixture-foreign-profile");
      expect(h.obligations.byId(demand.obligationId)).toMatchObject({
        profileId,
        kind: "demand",
        profileDemandEventId: demand.demandEventId,
        agentEventId: null,
        state: "pending",
        lastErrorCode: "demand:event-missing",
      });
    }
    pendingNotSeen(h, demand.obligationId);
  });

  test.each([
    "seconds-only",
    "impossible-date",
    "expired",
    "outside-root",
    "hash",
  ] as const)("publication rejects %s before persistence", async (fault) => {
    const h = await fixture();
    let request = h.request();
    if (fault === "seconds-only")
      request = { ...request, expiresAt: request.expiresAt.replace(/\.\d{3}Z$/, "Z") };
    if (fault === "impossible-date")
      request = { ...request, expiresAt: "2026-02-30T12:00:00.000Z" };
    if (fault === "expired")
      request = {
        ...request,
        observedAt: new Date(h.clock() - 120_000).toISOString(),
        expiresAt: new Date(h.clock() - 1).toISOString(),
      };
    if (fault === "outside-root")
      request = {
        ...request,
        snapshotRef: { ...request.snapshotRef, path: "/fixture-forbidden-outside-root.json" },
      };
    if (fault === "hash")
      request = { ...request, snapshotRef: { ...request.snapshotRef, sha256: "0".repeat(64) } };
    await expect(h.rpc.request("inbox.publishDemand", request)).rejects.toThrow();
    expect(h.sqlite.prepare("select count(*) as n from profile_demand_events").get()).toEqual({
      n: 0,
    });
    expect(h.sqlite.prepare("select count(*) as n from delivery_obligations").get()).toEqual({
      n: 0,
    });
    expect(context(await h.child())).toBe("");
    expect(h.owner().delivered).toBeNull();
    expect(calls(h, "inbox.delivered")).toEqual([]);
    expect(calls(h, "inbox.ack")).toEqual([]);
  });

  test.each([
    "path",
    "selector",
  ] as const)("real U+061C %s survives ingress but is nacked by the render boundary", async (field) => {
    const h = await fixture();
    // Immutable base ingress checks bytes and evidence roots, not bidi text.
    // This asserts the actual split contract instead of claiming publication rejects it.
    const unsafe = h.ref("snapshot-\u061c.json", { synthetic: true });
    const request = {
      ...h.request(),
      snapshotRef:
        field === "path" ? unsafe : { ...h.request().snapshotRef, selector: "root\u061c" },
    };
    const demand = published(h, request);
    expect(context(await h.child())).toBe("");
    pendingNotSeen(h, demand.obligationId);
    expect(calls(h, "inbox.nack")[0]).toMatchObject({
      ids: [demand.obligationId],
      errorCode: "demand_snapshot_missing",
    });
    expect(h.obligations.byId(demand.obligationId)?.lastErrorCode).toBe("demand_snapshot_missing");
  });

  test("a missing post-eligibility snapshot is token-fenced nacked, never delivered", async () => {
    const h = await fixture();
    const demand = published(h, h.request());
    // One explicit private fixture seam fault: snapshot enrichment is absent
    // AFTER real store eligibility, while the real lease/nack stores remain intact.
    vi.spyOn(h.demands, "snapshot").mockReturnValueOnce(null);
    expect(context(await h.child())).toBe("");
    pendingNotSeen(h, demand.obligationId);
    expect(calls(h, "inbox.nack")[0]?.ids).toEqual([demand.obligationId]);
    expect(
      h.delivery.inboxNack({
        ids: [demand.obligationId],
        leaseToken: "synthetic-wrong-token",
        errorCode: "forbidden",
      }),
    ).toBeDefined();
    expect(h.obligations.byId(demand.obligationId)?.lastErrorCode).toBe("demand_snapshot_missing");
  });

  test("a real demand in the budget tail is deferred and never ACKed unseen", async () => {
    const h = await fixture();
    for (let i = 0; i < 19; i += 1) h.agent("y".repeat(2000));
    const demand = published(h, h.request());
    const before = new Map(
      h.obligations.list({ profileId, state: "pending" }).map((row) => [row.id, row.attemptCount]),
    );
    expect(before.size).toBe(20);
    const result = await h.child();
    const represented = h.owner().delivered?.ids ?? [];
    const deferred = [...before.keys()].filter((id) => !represented.includes(id));
    expect(represented.length).toBeGreaterThan(0);
    expect(deferred).toContain(demand.obligationId);
    expect(context(result).length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(context(result).split("\n").length).toBeLessThanOrEqual(CONTEXT_MAX_LINES);
    expect(new Set(calls(h, "inbox.defer")[0]?.ids as string[])).toEqual(new Set(deferred));
    for (const id of deferred) {
      expect(context(result)).not.toContain(id);
      expect(h.obligations.byId(id)).toMatchObject({
        state: "pending",
        attemptCount: before.get(id),
        lastErrorCode: "deferred_over_budget",
      });
    }
    h.delivery.inboxDefer({ ids: represented, leaseToken: "synthetic-wrong-token" });
    for (const id of represented) expect(h.obligations.byId(id)?.state).toBe("delivered");
    await h.child("Stop", true, true);
    expect(calls(h, "inbox.ack").map((row) => row.ids)).toEqual([represented]);
    pendingNotSeen(h, demand.obligationId);
  });

  test("real leased demand rejects wrong-token defer, nack and ACK before valid deferral and nack", async () => {
    const h = await fixture();
    await h.child(); // Actual CLI claims demand capability before publication.
    const demand = published(h, h.request());
    const token = h.owner().leaseToken;
    const input = {
      profileId,
      leaseToken: token,
      sourceKinds: ["agent", "profile-demand"] as ("agent" | "profile-demand")[],
    };
    const lease = h.delivery.inboxLease(input);
    expect(lease.obligations.map((row) => row.id)).toEqual([demand.obligationId]);
    const before = h.obligations.byId(demand.obligationId)?.attemptCount;
    expect(
      h.delivery.inboxDefer({ ids: [demand.obligationId], leaseToken: "synthetic-wrong-token" }),
    ).toEqual({ deferred: 0 });
    expect(
      h.delivery.inboxNack({
        ids: [demand.obligationId],
        leaseToken: "synthetic-wrong-token",
        errorCode: "forbidden",
      }),
    ).toEqual({ nacked: 0 });
    expect(
      h.delivery.inboxAck({
        ids: [demand.obligationId],
        leaseToken: "synthetic-wrong-token",
        profileId,
      }),
    ).toEqual({ acked: 0, rejected: [demand.obligationId] });
    expect(h.obligations.byId(demand.obligationId)).toMatchObject({
      state: "leased",
      leaseToken: token,
      attemptCount: before,
    });
    expect(h.delivery.inboxDefer({ ids: [demand.obligationId], leaseToken: token })).toEqual({
      deferred: 1,
    });
    expect(h.obligations.byId(demand.obligationId)).toMatchObject({
      state: "pending",
      leaseToken: null,
      attemptCount: (before ?? 0) - 1,
    });
    expect(h.delivery.inboxLease(input).obligations.map((row) => row.id)).toEqual([
      demand.obligationId,
    ]);
    expect(
      h.delivery.inboxNack({
        ids: [demand.obligationId],
        leaseToken: token,
        errorCode: "fixture-interrupted",
      }),
    ).toEqual({ nacked: 1 });
    pendingNotSeen(h, demand.obligationId);
  });

  test("failed handoff observes phase-one custody, does not emit or later ACK, and retries under a fresh fence", async () => {
    const h = await fixture();
    const demand = published(h, h.request());
    h.faults.delivered = true;
    const failed = await h.child();
    expect(context(failed)).toBe("");
    expect(h.phaseOne()?.delivered).toMatchObject({ phase: "leased", ids: [demand.obligationId] });
    expect(h.owner().delivered).toBeNull();
    expect(h.obligations.byId(demand.obligationId)?.state).toBe("leased");
    const failedToken = h.phaseOne()?.leaseToken;
    h.faults.delivered = false;
    // Intentional private clock/lease expiration injection, not live state mutation.
    h.sqlite
      .prepare("update delivery_obligations set lease_expires_at = 0 where id = ?")
      .run(demand.obligationId);
    const retried = await h.child();
    expect(context(retried)).toContain(demand.obligationId);
    expect(h.owner().leaseToken).not.toBe(failedToken);
    expect(calls(h, "inbox.ack")).toEqual([]);
    h.delivery.inboxAck({
      ids: [demand.obligationId],
      leaseToken: failedToken ?? "missing",
      profileId,
    });
    expect(h.obligations.byId(demand.obligationId)?.state).toBe("delivered");
    await h.child("Stop", true, true);
    expect(calls(h, "inbox.ack").map((row) => row.ids)).toEqual([[demand.obligationId]]);
    expect(h.obligations.byId(demand.obligationId)?.state).toBe("acked");
  });

  test("active Stop settles the represented demand and never probes, leases or injects again", async () => {
    const h = await fixture();
    const first = published(h, h.request());
    await h.child();
    const next = published(h, h.request("b"));
    const probes = calls(h, "daemon.info").length;
    const leases = calls(h, "inbox.lease").length;
    expect(context(await h.child("Stop", true, true))).toBe("");
    expect(calls(h, "daemon.info")).toHaveLength(probes);
    expect(calls(h, "inbox.lease")).toHaveLength(leases);
    expect(h.obligations.byId(first.obligationId)?.state).toBe("acked");
    pendingNotSeen(h, next.obligationId);
  });

  test.each([
    "capable",
    "unsupported",
    "refused",
  ] as const)("lapsed Stop recovers once with %s capability and settles prior demand first", async (probe) => {
    const h = await fixture();
    const first = published(h, h.request());
    await h.child();
    const next = published(h, h.request("b"));
    const oldToken = h.owner().leaseToken;
    h.sqlite
      .prepare(
        "update profile_owners set lease_expires_at = 0, last_seen_at = 0 where profile_id = ?",
      )
      .run(profileId);
    h.faults.probe = probe;
    const result = await h.child("Stop");
    expect(calls(h, "inbox.ack").map((row) => row.ids)).toEqual([[first.obligationId]]);
    expect(h.obligations.byId(first.obligationId)?.state).toBe("acked");
    expect(calls(h, "profile.claim")).toHaveLength(2); // Initial prompt, exactly one recovery.
    expect(h.owner().leaseToken).not.toBe(oldToken);
    const recovery = calls(h, "profile.claim")[1];
    const stopLeases = calls(h, "inbox.lease").slice(1);
    expect(stopLeases).toHaveLength(2); // Lapsed refusal, then one recovery lease.
    if (probe === "capable") {
      expect(recovery?.acceptedSourceKinds).toEqual(kinds);
      expect(
        stopLeases.every((input) => JSON.stringify(input.sourceKinds) === JSON.stringify(kinds)),
      ).toBe(true);
      expect(context(result)).toContain(next.obligationId);
      await h.child("Stop", true, true);
      expect(h.obligations.byId(next.obligationId)?.state).toBe("acked");
    } else {
      expect(recovery).not.toHaveProperty("acceptedSourceKinds");
      expect(stopLeases.every((input) => input.sourceKinds === undefined)).toBe(true);
      expect(context(result)).toBe("");
      pendingNotSeen(h, next.obligationId);
    }
    noLeaks(h, result);
  });

  test("private STOP and moved owner refuse leasing without touching live withheld obligations", async () => {
    const h = await fixture();
    await h.child();
    const request = h.request();
    const demand = published(h, request);
    writeFileSync(h.stopPath, "synthetic STOP");
    expect(context(await h.child())).toBe("");
    expect(h.obligations.byId(demand.obligationId)?.lastErrorCode).toBe(
      "demand:stop-present-or-invalid",
    );
    expect(() => published(h, h.request("b"))).toThrow("stop-present-or-invalid");
    pendingNotSeen(h, demand.obligationId);
    // Separate fixture for the owner-generation contrast: never remove STOP.
    const moved = await fixture();
    await moved.child();
    const movedRequest = moved.request();
    const movedDemand = published(moved, movedRequest);
    moved.sqlite
      .prepare("update profile_owners set pane_id = ? where profile_id = ?")
      .run("fixture:moved", profileId);
    const owner = moved.owners.get(profileId);
    if (!owner) throw new Error("fixture owner absent");
    expect(
      moved.delivery.inboxLease({
        profileId,
        leaseToken: owner.leaseToken,
        sourceKinds: ["agent", "profile-demand"],
      }).obligations,
    ).toEqual([]);
    expect(moved.obligations.byId(movedDemand.obligationId)?.lastErrorCode).toBe(
      "demand:owner-generation-mismatch",
    );
    pendingNotSeen(moved, movedDemand.obligationId);
  });
});
