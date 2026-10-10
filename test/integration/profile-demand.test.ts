import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
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
import { DemandEventStore } from "@/db/profile-demand-events.js";
import { ProfileOwnerStore } from "@/db/profile-owners.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import { DemandEligibilityProvider } from "@/observability/demand-eligibility.js";
import { ProfileDeliveryService } from "@/observability/profile-delivery-service.js";
import { ProfileDemandService } from "@/observability/profile-demand-service.js";
import {
  formatDemandObligationUpdates,
  isDemandSnapshot,
  wakeContextWitnessed,
} from "../../packages/shepy-pi/src/wake.js";
import { RpcTestClient } from "./rpc-test-client.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "shepy-demand-")));
  dirs.push(dir);
  const { sqlite } = openSqlite(join(dir, "db.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  new OrchestratorProfileStore(sqlite).createProfile({
    profileId: "engine-coordinator",
    displayName: "Engine",
    projectRoots: [],
  });
  const ref = (name: string, contents: string) => {
    const path = join(dir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, contents);
    return { path, sha256: createHash("sha256").update(contents).digest("hex"), selector: "root" };
  };
  const episodeId = "a".repeat(64);
  const request = {
    schema: "factory.demand.v1" as const,
    sourceId: "factory-router",
    profileId: "engine-coordinator",
    kind: "queue-claimable" as const,
    idempotencyKey: `${episodeId}/queue-claimable/1`,
    episodeId,
    actionFingerprint: "b".repeat(64),
    activationRevision: 1,
    seatId: "engine-coordinator",
    ownerGeneration: {
      herdrSession: "default",
      workspaceId: "w3J",
      paneId: "w3J:pEB",
      terminalId: "term-1",
      nativeSessionRef: "/tmp/owner.jsonl",
    },
    dutyRef: ref("duty.json", "duty"),
    grantRef: ref("grant.json", "grant"),
    snapshotRef: ref("snapshot.json", "snapshot"),
    markerRef: ref("marker.json", "marker"),
    observedAt: "2026-10-09T13:00:00.000Z",
    expiresAt: "2026-10-09T13:30:00.000Z",
    reasonCode: "owned-ready-capacity" as const,
  };
  return { dir, sqlite, request, store: new DemandEventStore(sqlite), ref };
}

test("atomic event/obligation, idempotent replay and conflicting key", () => {
  const { sqlite, request, store } = fixture();
  const first = store.publish(request);
  expect(first.disposition).toBe("created");
  expect(store.publish(request)).toEqual({ ...first, disposition: "existing" });
  expect(() => store.publish({ ...request, reasonCode: "missing-disposition" })).toThrow(
    "idempotency-conflict",
  );
  expect(
    store.lookup({
      profileId: request.profileId,
      sourceId: request.sourceId,
      idempotencyKey: request.idempotencyKey,
    }),
  ).toMatchObject({
    found: true,
    demandEventId: first.demandEventId,
    obligationId: first.obligationId,
    state: "pending",
  });
  const rows = sqlite
    .prepare(
      "select profile_demand_event_id, agent_event_id, subscription_id from delivery_obligations",
    )
    .all() as {
    profile_demand_event_id: string;
    agent_event_id: number | null;
    subscription_id: number | null;
  }[];
  expect(rows).toEqual([
    { profile_demand_event_id: first.demandEventId, agent_event_id: null, subscription_id: null },
  ]);
});

test("an obligation insert failure rolls back both the demand event and obligation", () => {
  const { sqlite, request, store } = fixture();
  sqlite.exec(`create trigger refuse_demand_obligation before insert on delivery_obligations
    when new.kind = 'demand' begin select raise(abort, 'injected-obligation-failure'); end`);
  expect(() => store.publish(request)).toThrow("injected-obligation-failure");
  expect(sqlite.prepare("select count(*) as n from profile_demand_events").get()).toEqual({ n: 0 });
  expect(sqlite.prepare("select count(*) as n from delivery_obligations").get()).toEqual({ n: 0 });
  expect(
    store.lookup({
      profileId: request.profileId,
      sourceId: request.sourceId,
      idempotencyKey: request.idempotencyKey,
    }),
  ).toEqual({ found: false });
  sqlite.exec("drop trigger refuse_demand_obligation");
  expect(store.publish(request).disposition).toBe("created");
  expect(sqlite.prepare("select count(*) as n from profile_demand_events").get()).toEqual({ n: 1 });
  expect(sqlite.prepare("select count(*) as n from delivery_obligations").get()).toEqual({ n: 1 });
});

test("strict duty gate retains off-duty but refuses STOP and occupied capacity", async () => {
  const { dir, sqlite, request, store, ref } = fixture();
  const now = Date.parse("2026-10-09T13:15:00.000Z");
  const allowlistPath = join(dir, "allowlist.json");
  const seatStatePath = join(dir, "state.json");
  const stopPath = join(dir, "STOP");
  const generation = request.ownerGeneration;
  const grantRef = request.grantRef;
  const observation = (availableSlots: number) =>
    ref(
      "capacity.json",
      JSON.stringify({
        observedAt: "2026-10-09T13:14:59.000Z",
        seatGeneration: generation,
        activeInvocationIds: availableSlots ? [] : ["busy"],
        occupiedSlots: availableSlots ? 0 : 1,
        availableSlots,
        scopeRef: grantRef,
      }),
    );
  const duty = (mode: string, availableSlots: number) => ({
    schema: "factory.duty.v1",
    seatId: request.seatId,
    profileId: request.profileId,
    ownerGeneration: generation,
    grantRef,
    mode,
    window: {
      startsAt: "2026-10-09T13:00:00.000Z",
      endsAt: "2026-10-09T14:00:00.000Z",
      timezone: "UTC",
    },
    queues: [
      {
        root: dir,
        queuePath: join(dir, "queue.json"),
        ownership: [
          {
            rowId: "15.233",
            packetId: "R1-PHASE2",
            actionClass: "execute",
            packetRef: request.snapshotRef,
            grantRef,
          },
        ],
      },
    ],
    capacity: { maxInFlight: 1, observationRef: observation(availableSlots), maxAgeSeconds: 30 },
    stopPaths: [stopPath],
    nextDecision: { reasonRef: grantRef, eventRef: null, revisitAt: "2026-10-09T13:30:00.000Z" },
    successor: { profileId: "successor", routeRef: grantRef, ownerGeneration: null },
    policy: {
      idleGraceSeconds: 60,
      cooldownSeconds: 1200,
      maxWakesPerHour: 3,
      maxReminderCount: 1,
      defaultRevisitSeconds: 1200,
    },
  });
  writeFileSync(
    seatStatePath,
    JSON.stringify({
      schema: "factory.seat-state.v1",
      seat: request.seatId,
      ts: "2026-10-09T13:14:59.000Z",
      ctxPct: 40,
      zone: "amber",
      unknown: [],
    }),
  );
  writeFileSync(
    allowlistPath,
    JSON.stringify({
      schema: "shepy.ingress-allowlist.v1",
      sources: {
        "factory-router": {
          profiles: [request.profileId],
          kinds: [request.kind, "continuation-missing"],
          duty_paths: [request.dutyRef.path],
          grant_hashes: [request.grantRef.sha256],
          evidence_roots: [dir],
          max_expiry_minutes: 60,
          seat_state_path: seatStatePath,
        },
      },
    }),
  );
  const provider = new DemandEligibilityProvider({
    allowlistPath,
    now: () => now,
    requiredStopPath: stopPath,
  });
  const owners = new ProfileOwnerStore({ sqlite, now: () => now });
  const service = new ProfileDemandService(store, owners, provider, {
    allowlistPath,
    now: () => now,
  });
  const withDuty = (mode: string, availableSlots: number) => ({
    ...request,
    dutyRef: ref("duty.json", JSON.stringify(duty(mode, availableSlots))),
  });
  const offDuty = withDuty("off-duty", 1);
  const held = service.publishDemand(offDuty);
  expect(
    store.lookup({
      profileId: request.profileId,
      sourceId: request.sourceId,
      idempotencyKey: request.idempotencyKey,
    }),
  ).toMatchObject({ obligationId: held.obligationId, withheldReason: "demand:duty-off-duty" });
  writeFileSync(stopPath, "STOP");
  expect(() => service.publishDemand(withDuty("on-duty", 1))).toThrow("stop-present-or-invalid");
  rmSync(stopPath);
  expect(() => service.publishDemand(withDuty("on-duty", 0))).toThrow("capacity-unavailable");

  const live = withDuty("on-duty", 1);
  expect(() =>
    service.publishDemand({
      ...live,
      activationRevision: 2,
      idempotencyKey: `${live.episodeId}/queue-claimable/2`,
    }),
  ).toThrow("continuation-proof-unavailable");
  expect(() =>
    service.publishDemand({
      ...live,
      kind: "continuation-missing",
      idempotencyKey: `${live.episodeId}/continuation-missing/1`,
      reasonCode: "missing-disposition",
    }),
  ).toThrow("route-proof-unavailable");
  const next = {
    ...live,
    episodeId: "c".repeat(64),
    idempotencyKey: `${"c".repeat(64)}/queue-claimable/1`,
  };
  const published = service.publishDemand(next);
  expect(published.disposition).toBe("created");
  const delivery = new ProfileDeliveryService({
    agents: new AgentStore(sqlite),
    obligations: new DeliveryObligationStore(sqlite),
    owners,
    profiles: new OrchestratorProfileStore(sqlite),
    demands: service,
    now: () => now,
  });
  const claim = owners.claim({
    profileId: request.profileId,
    subscriberId: "owner-1",
    harnessKind: "pi",
    harnessSessionRefJson: JSON.stringify({ kind: "path", value: generation.nativeSessionRef }),
    herdrSessionName: generation.herdrSession,
    workspaceId: generation.workspaceId,
    paneId: generation.paneId,
    terminalId: generation.terminalId,
  });
  if (claim.kind === "rejected") throw new Error("claim refused");
  expect(
    delivery.inboxLease({ profileId: request.profileId, leaseToken: claim.leaseToken }).obligations,
  ).toEqual([]);
  expect(() =>
    delivery.inboxLease({
      profileId: request.profileId,
      leaseToken: claim.leaseToken,
      sourceKinds: ["agent", "profile-demand"],
    }),
  ).toThrow("source capability not claimed");
  const adopted = owners.claim({
    profileId: request.profileId,
    currentLeaseToken: claim.leaseToken,
    subscriberId: "owner-1",
    harnessKind: "pi",
    acceptedSourceKinds: ["agent", "profile-demand"],
    harnessSessionRefJson: JSON.stringify({ kind: "path", value: generation.nativeSessionRef }),
    herdrSessionName: generation.herdrSession,
    workspaceId: generation.workspaceId,
    paneId: generation.paneId,
    terminalId: generation.terminalId,
  });
  if (adopted.kind === "rejected") throw new Error("adoption refused");
  writeFileSync(stopPath, "STOP");
  expect(
    delivery.inboxLease({
      profileId: request.profileId,
      leaseToken: adopted.leaseToken,
      sourceKinds: ["agent", "profile-demand"],
    }).obligations,
  ).toEqual([]);
  expect(
    store.lookup({
      profileId: request.profileId,
      sourceId: request.sourceId,
      idempotencyKey: next.idempotencyKey,
    }),
  ).toMatchObject({ state: "pending", withheldReason: "demand:stop-present-or-invalid" });
  rmSync(stopPath);
  writeFileSync(
    seatStatePath,
    JSON.stringify({
      schema: "factory.seat-state.v1",
      seat: request.seatId,
      ts: "2026-10-09T13:14:59.000Z",
      ctxPct: 80,
      zone: "never",
      unknown: [],
    }),
  );
  expect(
    delivery.inboxLease({
      profileId: request.profileId,
      leaseToken: adopted.leaseToken,
      sourceKinds: ["agent", "profile-demand"],
    }).obligations,
  ).toEqual([]);
  expect(
    store.lookup({
      profileId: request.profileId,
      sourceId: request.sourceId,
      idempotencyKey: next.idempotencyKey,
    }),
  ).toMatchObject({ state: "pending", withheldReason: "demand:seat-state-unavailable" });
  writeFileSync(
    seatStatePath,
    JSON.stringify({
      schema: "factory.seat-state.v1",
      seat: request.seatId,
      ts: "2026-10-09T13:14:59.000Z",
      ctxPct: 40,
      zone: "amber",
      unknown: [],
    }),
  );
  const leased = delivery.inboxLease({
    profileId: request.profileId,
    leaseToken: adopted.leaseToken,
    sourceKinds: ["agent", "profile-demand"],
  }).obligations;
  expect(leased).toHaveLength(1);
  expect(leased[0]).toMatchObject({
    id: published.obligationId,
    sourceKind: "profile-demand",
    demand: { episodeId: next.episodeId, activationRevision: 1 },
  });
  const another = {
    ...next,
    episodeId: "d".repeat(64),
    idempotencyKey: `${"d".repeat(64)}/queue-claimable/1`,
  };
  const waiting = service.publishDemand(another);
  expect(
    delivery.inboxLease({
      profileId: request.profileId,
      leaseToken: adopted.leaseToken,
      sourceKinds: ["agent", "profile-demand"],
    }).obligations,
  ).toEqual([]);
  expect(
    store.lookup({
      profileId: request.profileId,
      sourceId: request.sourceId,
      idempotencyKey: another.idempotencyKey,
    }),
  ).toMatchObject({
    obligationId: waiting.obligationId,
    state: "pending",
    withheldReason: "demand:single-wake-capacity",
  });
  expect(
    store.lookup({
      profileId: request.profileId,
      sourceId: request.sourceId,
      idempotencyKey: request.idempotencyKey,
    }),
  ).toMatchObject({ state: "pending", withheldReason: expect.stringContaining("demand:") });

  const agents = new AgentStore(sqlite);
  const agentEvents = new AgentEventStore(sqlite);
  const history = createAgentHistoryService({
    cache: new AgentHistoryCacheStore(sqlite),
    homeDir: dir,
  });
  const server = new ObservabilityRpcServer({
    socketPath: join(dir, "rpc.sock"),
    history,
    context: new AgentContextService({
      history,
      stores: { agents, agentContextSnapshots: new AgentContextSnapshotStore(sqlite) },
    }),
    orchestrator: new AgentOrchestratorService({
      agents,
      agentEvents,
      scopes: new AgentOrchestratorScopeStore(sqlite),
    }),
    demands: service,
    delivery,
    stores: {
      agents,
      agentEvents,
      herdrSessions: new HerdrSessionStore(sqlite),
      herdrWorkspaces: new HerdrWorkspaceStore(sqlite),
    },
  });
  await server.start();
  const client = await RpcTestClient.connect(join(dir, "rpc.sock"));
  try {
    expect(await client.request("daemon.info", {})).toMatchObject({
      capabilities: ["profile-demand-v1"],
    });
    expect(await client.request("inbox.publishDemand", next)).toMatchObject({
      disposition: "existing",
      demandEventId: published.demandEventId,
    });
    // Both the first publication and replay cross the RPC + validator + duty gate.
    const rpcEpisodeId = "e".repeat(64);
    const rpcRequest = {
      ...next,
      episodeId: rpcEpisodeId,
      idempotencyKey: `${rpcEpisodeId}/queue-claimable/1`,
    };
    const firstRpc = (await client.request("inbox.publishDemand", rpcRequest)) as {
      disposition: string;
      demandEventId: string;
      obligationId: string;
      payloadSha256: string;
    };
    const replayRpc = await client.request("inbox.publishDemand", rpcRequest);
    expect(firstRpc.disposition).toBe("created");
    expect(replayRpc).toEqual({ ...firstRpc, disposition: "existing" });
    expect(
      sqlite
        .prepare(`select count(*) as n from profile_demand_events
      where profile_id = ? and source_id = ? and idempotency_key = ?`)
        .get(request.profileId, request.sourceId, rpcRequest.idempotencyKey),
    ).toEqual({ n: 1 });
    expect(
      sqlite
        .prepare(`select count(*) as n from delivery_obligations
      where profile_demand_event_id = ? and kind = 'demand'`)
        .get(firstRpc.demandEventId),
    ).toEqual({ n: 1 });
    expect(
      await client.request("inbox.lookupDemand", {
        schema: "factory.demand.lookup.v1",
        profileId: request.profileId,
        sourceId: request.sourceId,
        idempotencyKey: next.idempotencyKey,
      }),
    ).toMatchObject({
      found: true,
      demandEventId: published.demandEventId,
      obligationId: published.obligationId,
      state: "leased",
    });
    await expect(
      client.request("inbox.lookupDemand", {
        profileId: request.profileId,
        sourceId: request.sourceId,
        idempotencyKey: next.idempotencyKey,
      }),
    ).rejects.toThrow();
  } finally {
    client.close();
    await server.stop();
  }
  delivery.inboxAck({
    ids: [published.obligationId],
    leaseToken: adopted.leaseToken,
    profileId: request.profileId,
  });
  const foreign = owners.claim({
    profileId: request.profileId,
    currentLeaseToken: adopted.leaseToken,
    subscriberId: "foreign",
    harnessKind: "pi",
    acceptedSourceKinds: ["agent", "profile-demand"],
    harnessSessionRefJson: JSON.stringify({ kind: "path", value: generation.nativeSessionRef }),
    herdrSessionName: generation.herdrSession,
    workspaceId: generation.workspaceId,
    paneId: "w3J:foreign",
    terminalId: generation.terminalId,
  });
  if (foreign.kind === "rejected") throw new Error("foreign claim refused");
  expect(
    delivery.inboxLease({
      profileId: request.profileId,
      leaseToken: foreign.leaseToken,
      sourceKinds: ["agent", "profile-demand"],
    }).obligations,
  ).toEqual([]);
  expect(
    store.lookup({
      profileId: request.profileId,
      sourceId: request.sourceId,
      idempotencyKey: another.idempotencyKey,
    }),
  ).toMatchObject({ state: "pending", withheldReason: "demand:owner-generation-mismatch" });
});

test("different activation revisions of the same episode create separate obligations", () => {
  const { request, store } = fixture();
  const first = store.publish(request);
  const second = store.publish({
    ...request,
    activationRevision: 2,
    idempotencyKey: `${request.episodeId}/queue-claimable/2`,
  });
  expect(second.obligationId).not.toBe(first.obligationId);
  expect(second.demandEventId).not.toBe(first.demandEventId);
});

test("a neutral owner fails the host-tuple demand fence", () => {
  const { dir, sqlite, request, store, ref } = fixture();
  const now = Date.parse("2026-10-09T13:15:00.000Z");
  const allowlistPath = join(dir, "allowlist.json");
  const seatStatePath = join(dir, "state.json");
  const stopPath = join(dir, "STOP");
  const generation = request.ownerGeneration;
  const grantRef = request.grantRef;
  const observation = (availableSlots: number) =>
    ref(
      "capacity.json",
      JSON.stringify({
        observedAt: "2026-10-09T13:14:59.000Z",
        seatGeneration: generation,
        activeInvocationIds: availableSlots ? [] : ["busy"],
        occupiedSlots: availableSlots ? 0 : 1,
        availableSlots,
        scopeRef: grantRef,
      }),
    );
  const duty = (mode: string, availableSlots: number) => ({
    schema: "factory.duty.v1",
    seatId: request.seatId,
    profileId: request.profileId,
    ownerGeneration: generation,
    grantRef,
    mode,
    window: {
      startsAt: "2026-10-09T13:00:00.000Z",
      endsAt: "2026-10-09T14:00:00.000Z",
      timezone: "UTC",
    },
    queues: [
      {
        root: dir,
        queuePath: join(dir, "queue.json"),
        ownership: [
          {
            rowId: "15.233",
            packetId: "R1-PHASE2",
            actionClass: "execute",
            packetRef: request.snapshotRef,
            grantRef,
          },
        ],
      },
    ],
    capacity: { maxInFlight: 1, observationRef: observation(availableSlots), maxAgeSeconds: 30 },
    stopPaths: [stopPath],
    nextDecision: { reasonRef: grantRef, eventRef: null, revisitAt: "2026-10-09T13:30:00.000Z" },
    successor: { profileId: "successor", routeRef: grantRef, ownerGeneration: null },
    policy: {
      idleGraceSeconds: 60,
      cooldownSeconds: 1200,
      maxWakesPerHour: 3,
      maxReminderCount: 1,
      defaultRevisitSeconds: 1200,
    },
  });
  writeFileSync(
    seatStatePath,
    JSON.stringify({
      schema: "factory.seat-state.v1",
      seat: request.seatId,
      ts: "2026-10-09T13:14:59.000Z",
      ctxPct: 40,
      zone: "amber",
      unknown: [],
    }),
  );
  writeFileSync(
    allowlistPath,
    JSON.stringify({
      schema: "shepy.ingress-allowlist.v1",
      sources: {
        "factory-router": {
          profiles: [request.profileId],
          kinds: [request.kind, "continuation-missing"],
          duty_paths: [request.dutyRef.path],
          grant_hashes: [request.grantRef.sha256],
          evidence_roots: [dir],
          max_expiry_minutes: 60,
          seat_state_path: seatStatePath,
        },
      },
    }),
  );
  const provider = new DemandEligibilityProvider({
    allowlistPath,
    now: () => now,
    requiredStopPath: stopPath,
  });
  const owners = new ProfileOwnerStore({ sqlite, now: () => now });
  const service = new ProfileDemandService(store, owners, provider, {
    allowlistPath,
    now: () => now,
  });
  const hosted = owners.claim({
    profileId: request.profileId,
    subscriberId: "owner-1",
    harnessKind: "pi",
    harnessSessionRefJson: JSON.stringify({ kind: "path", value: generation.nativeSessionRef }),
    herdrSessionName: generation.herdrSession,
    workspaceId: generation.workspaceId,
    paneId: generation.paneId,
    terminalId: generation.terminalId,
  });
  if (hosted.kind === "rejected") throw new Error("hosted claim refused");
  // Positive control: the same duty publish is eligible while the owner is
  // fully host-qualified.
  const hostedDuty = {
    ...request,
    dutyRef: ref("duty.json", JSON.stringify(duty("on-duty", 1))),
    idempotencyKey: `${request.episodeId}/queue-claimable/${request.activationRevision}`,
  };
  expect(service.publishDemand(hostedDuty).obligationId).toBeTruthy();
  // Replace the owner with a NEUTRAL one through the token fast path.
  const neutral = owners.claim({
    profileId: request.profileId,
    currentLeaseToken: hosted.leaseToken,
    subscriberId: "codex-neutral",
    harnessKind: "codex",
    harnessSessionRefJson: JSON.stringify({
      kind: "thread",
      value: "01a11ff6-9f7f-71a1-9741-366612d6390f",
    }),
  });
  if (neutral.kind === "rejected") throw new Error("neutral re-claim refused");
  let refusal = "";
  try {
    service.publishDemand({
      ...hostedDuty,
      episodeId: "b".repeat(64),
      dutyRef: ref("duty.json", JSON.stringify(duty("on-duty", 1))),
      idempotencyKey: `${"b".repeat(64)}/queue-claimable/${request.activationRevision}`,
    });
  } catch (error) {
    refusal = (error as Error).message;
  }
  expect(refusal).toBe("demand:owner-generation-mismatch");
});

// ---------------------------------------------------------------------------
// promise-breach adapter (factory.demand.v1 kind "promise-breach") — isolated
// source candidate: actual registered publication through inbox.publishDemand
// semantics, lease eligibility, the Pi consumer witness predicates and the
// settlement ACK, one incident, temp DB + temp allowlist only.
// ---------------------------------------------------------------------------

const BREACH_NOW = Date.parse("2026-10-10T12:00:00.000Z");
const BREACH_ADOPTION_SINCE = "2026-10-01T00:00:00.000Z";

function breachHarness() {
  const base = fixture();
  const { dir, sqlite, ref } = base;
  const generation = {
    herdrSession: "default",
    workspaceId: "w3J",
    paneId: "w3J:pEB",
    terminalId: "term-1",
    nativeSessionRef: "/tmp/owner.jsonl",
  };
  // The mutable multi-incident promise ledger upstream tools write. Nothing in
  // the demand path ever cites it — incidents cite owned snapshot files.
  const ledgerLine = `${JSON.stringify({
    promiseId: "pr-1",
    armedAt: "2026-10-09T08:00:00.000Z",
    deadline: "2026-10-10T10:00:00.000Z",
    status: "open",
  })}\n`;
  const ledgerPath = join(dir, "promises-ledger.jsonl");
  writeFileSync(ledgerPath, ledgerLine);
  // Owned per-incident immutable snapshot of the exact source record.
  const sourceRecordRef = ref("record-pr-1.json", ledgerLine);
  const dueAt = "2026-10-10T10:00:00.000Z";
  const receiptFor = (episodeId: string, overrides: Record<string, unknown> = {}) => {
    const value = {
      schema: "factory.promise-breach.receipt.v1",
      incidentId: `promise:pr-1:${episodeId.slice(0, 8)}`,
      episodeId,
      basis: "armed-promise",
      sourceRecordRef,
      promise: { recordId: "pr-1", status: "open", dueAt },
      classifier: null,
      ...overrides,
    };
    const snapshotRef = ref(`receipt-${episodeId.slice(0, 8)}.json`, JSON.stringify(value));
    return { value, snapshotRef };
  };
  const grantRef = ref("grant.json", "grant");
  const observationRef = ref(
    "capacity.json",
    JSON.stringify({
      observedAt: "2026-10-10T11:59:59.000Z",
      seatGeneration: generation,
      activeInvocationIds: [],
      occupiedSlots: 0,
      availableSlots: 1,
      scopeRef: grantRef,
    }),
  );
  const stopPath = join(dir, "STOP");
  const seatStatePath = join(dir, "seat-state.json");
  const writeSeatState = () =>
    writeFileSync(
      seatStatePath,
      JSON.stringify({
        schema: "factory.seat-state.v1",
        seat: "engine-coordinator",
        ts: "2026-10-10T11:59:59.000Z",
        ctxPct: 40,
        zone: "amber",
        unknown: [],
      }),
    );
  writeSeatState();
  const duty = (
    generationOverride: Record<string, unknown> = {},
    mode = "on-duty",
    window = { startsAt: "2026-10-10T11:00:00.000Z", endsAt: "2026-10-10T13:00:00.000Z" },
  ) => ({
    schema: "factory.duty.v1",
    seatId: "engine-coordinator",
    profileId: "engine-coordinator",
    ownerGeneration: { ...generation, ...generationOverride },
    grantRef,
    mode,
    window: { ...window, timezone: "UTC" },
    queues: [
      {
        root: dir,
        queuePath: join(dir, "queue.json"),
        ownership: [
          {
            rowId: "15.267",
            packetId: "BREACH-ADAPTER",
            actionClass: "execute",
            packetRef: sourceRecordRef,
            grantRef,
          },
        ],
      },
    ],
    capacity: { maxInFlight: 1, observationRef, maxAgeSeconds: 30 },
    stopPaths: [stopPath],
    nextDecision: { reasonRef: grantRef, eventRef: null, revisitAt: "2026-10-10T12:30:00.000Z" },
    successor: { profileId: "successor", routeRef: grantRef, ownerGeneration: null },
    policy: {
      idleGraceSeconds: 60,
      cooldownSeconds: 1200,
      maxWakesPerHour: 3,
      maxReminderCount: 1,
      defaultRevisitSeconds: 1200,
    },
  });
  const dutyRef = ref("duty.json", JSON.stringify(duty()));
  // A duty whose window is already fully in the past: a lapsed owner pin.
  const lapsedDutyRef = ref(
    "duty-lapsed.json",
    JSON.stringify(
      duty({}, "on-duty", {
        startsAt: "2026-10-10T09:00:00.000Z",
        endsAt: "2026-10-10T10:00:00.000Z",
      }),
    ),
  );
  const allowlistWithKinds = (kinds: string[]) => {
    const path = join(dir, `allowlist-${kinds.join("-").replace(/[^a-z-]/g, "")}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        schema: "shepy.ingress-allowlist.v1",
        sources: {
          "factory-promise-scan": {
            profiles: ["engine-coordinator"],
            kinds,
            duty_paths: [dutyRef.path, lapsedDutyRef.path],
            grant_hashes: [grantRef.sha256],
            evidence_roots: [dir],
            max_expiry_minutes: 60,
            seat_state_path: seatStatePath,
            promise_adoption_since: BREACH_ADOPTION_SINCE,
          },
        },
      }),
    );
    return path;
  };
  const allowlistPath = allowlistWithKinds(["promise-breach"]);
  const provider = new DemandEligibilityProvider({
    allowlistPath,
    now: () => BREACH_NOW,
    requiredStopPath: stopPath,
  });
  const owners = new ProfileOwnerStore({ sqlite, now: () => BREACH_NOW });
  const service = new ProfileDemandService(base.store, owners, provider, {
    allowlistPath,
    now: () => BREACH_NOW,
  });
  const episode = (seed: string) => seed.repeat(64);
  const breachRequest = (episodeId: string, overrides: Record<string, unknown> = {}) => {
    const { snapshotRef } = receiptFor(
      episodeId,
      (overrides.receiptOverrides as Record<string, unknown>) ?? {},
    );
    const { receiptOverrides: _ignored, ...rest } = overrides;
    void _ignored;
    return {
      schema: "factory.demand.v1",
      sourceId: "factory-promise-scan",
      profileId: "engine-coordinator",
      kind: "promise-breach",
      idempotencyKey: `${episodeId}/promise-breach/1`,
      episodeId,
      actionFingerprint: "b".repeat(64),
      activationRevision: 1,
      seatId: "engine-coordinator",
      ownerGeneration: { ...generation },
      dutyRef,
      grantRef,
      snapshotRef,
      markerRef: grantRef,
      observedAt: "2026-10-10T11:30:00.000Z",
      expiresAt: "2026-10-10T12:30:00.000Z",
      reasonCode: "expired-immutable-deadline",
      ...rest,
    };
  };
  return {
    ...base,
    generation,
    ledgerPath,
    dueAt,
    receiptFor,
    duty,
    dutyRef,
    lapsedDutyRef,
    grantRef,
    stopPath,
    writeSeatState,
    allowlistPath,
    allowlistWithKinds,
    provider,
    owners,
    service,
    episode,
    breachRequest,
  };
}

test("promise-breach: one incident publishes durably, leases to the hosted Pi owner, witnesses and settles", () => {
  const h = breachHarness();
  const { sqlite, store, owners, service, episode, breachRequest } = h;
  const episodeId = episode("f");
  // The owner is hosted (full Herdr session/workspace/pane/terminal + native
  // session ref) and has adopted the profile-demand source capability.
  const firstClaim = owners.claim({
    profileId: "engine-coordinator",
    subscriberId: "owner-pi",
    harnessKind: "pi",
    harnessSessionRefJson: JSON.stringify({ kind: "path", value: h.generation.nativeSessionRef }),
    herdrSessionName: h.generation.herdrSession,
    workspaceId: h.generation.workspaceId,
    paneId: h.generation.paneId,
    terminalId: h.generation.terminalId,
  });
  if (firstClaim.kind === "rejected") throw new Error("claim refused");
  const adopted = owners.claim({
    profileId: "engine-coordinator",
    currentLeaseToken: firstClaim.leaseToken,
    subscriberId: "owner-pi",
    harnessKind: "pi",
    acceptedSourceKinds: ["agent", "profile-demand"],
    harnessSessionRefJson: JSON.stringify({ kind: "path", value: h.generation.nativeSessionRef }),
    herdrSessionName: h.generation.herdrSession,
    workspaceId: h.generation.workspaceId,
    paneId: h.generation.paneId,
    terminalId: h.generation.terminalId,
  });
  if (adopted.kind === "rejected") throw new Error("adoption refused");

  // Publication through the EXISTING registered service path.
  const published = service.publishDemand(breachRequest(episodeId));
  expect(published.disposition).toBe("created");
  // The scanner re-observing the same incident is idempotent: same event,
  // same obligation, no duplicate row.
  const replay = service.publishDemand(breachRequest(episodeId));
  expect(replay).toEqual({ ...published, disposition: "existing" });
  expect(
    sqlite
      .prepare("select count(*) as n from profile_demand_events where idempotency_key = ?")
      .get(`${episodeId}/promise-breach/1`),
  ).toEqual({ n: 1 });
  // A changed duplicate payload under the same key is a hard refusal.
  expect(() =>
    service.publishDemand({ ...breachRequest(episodeId), expiresAt: "2026-10-10T12:20:00.000Z" }),
  ).toThrow("demand:idempotency-conflict");

  // A later, unrelated append to the mutable source ledger must not
  // invalidate the incident: the demand cites its OWNED per-incident receipt
  // snapshot, whole-file hashed, not a selector into this ledger.
  appendFileSync(h.ledgerPath, `${JSON.stringify({ promiseId: "pr-2", unrelated: true })}\n`);

  const delivery = new ProfileDeliveryService({
    agents: new AgentStore(sqlite),
    obligations: new DeliveryObligationStore(sqlite),
    owners,
    profiles: new OrchestratorProfileStore(sqlite),
    demands: service,
    now: () => BREACH_NOW,
  });
  const leased = delivery.inboxLease({
    profileId: "engine-coordinator",
    leaseToken: adopted.leaseToken,
    sourceKinds: ["agent", "profile-demand"],
  }).obligations;
  expect(leased).toHaveLength(1);
  const obligation = leased[0];
  if (!obligation || !("demand" in obligation) || !obligation.demand) {
    throw new Error("expected the breach obligation to lease with its demand snapshot");
  }
  expect(obligation).toMatchObject({
    id: published.obligationId,
    sourceKind: "profile-demand",
    demand: {
      episodeId,
      kind: "promise-breach",
      reasonCode: "expired-immutable-deadline",
      activationRevision: 1,
    },
  });
  expect(isDemandSnapshot(obligation.demand)).toBe(true);

  // The Pi owner pump builds the wake content from the LEASED snapshot; the
  // context hook then witnesses exactly this batch by obligation ids before
  // any settlement ACK.
  const content = formatDemandObligationUpdates([
    {
      obligationId: obligation.id,
      demandEventId: obligation.profileDemandEventId as string,
      demand: obligation.demand,
    },
  ]);
  expect(content).toContain("promise-breach");
  expect(content).toContain(`obligation: ${published.obligationId}`);
  const witnessed = wakeContextWitnessed(
    [
      {
        customType: "shepy-wake-context",
        details: { obligationIds: [obligation.id] },
        role: "custom",
      },
    ],
    [obligation.id],
  );
  expect(witnessed).toBe(true);
  expect(
    wakeContextWitnessed(
      [
        {
          customType: "shepy-wake-context",
          details: { obligationIds: [obligation.id] },
          role: "custom",
        },
      ],
      ["foreign-id"],
    ),
  ).toBe(false);

  // Settlement ACK: consumption witnessed + successful final, else the batch
  // stays unackable. The daemon-side ACK is the final stage of this slice.
  delivery.inboxAck({
    ids: [published.obligationId],
    leaseToken: adopted.leaseToken,
    profileId: "engine-coordinator",
  });
  expect(
    sqlite
      .prepare("select state from delivery_obligations where id = ?")
      .get(published.obligationId),
  ).toEqual({ state: "acked" });
  expect(
    store.lookup({
      profileId: "engine-coordinator",
      sourceId: "factory-promise-scan",
      idempotencyKey: `${episodeId}/promise-breach/1`,
    }),
  ).toMatchObject({ found: true, demandEventId: published.demandEventId, state: "acked" });
});

test("promise-breach: the publish refusal family stays shut", () => {
  const h = breachHarness();
  const { sqlite, store, service, episode, breachRequest, allowlistWithKinds, dutyRef } = h;
  const publishRefused = (request: Record<string, unknown>, message: string) =>
    expect(() => service.publishDemand(request)).toThrow(message);
  const keyFor = (seed: string) => `${episode(seed)}/promise-breach/1`;

  // Absent authority: an unknown source id.
  publishRefused(
    { ...breachRequest(episode("a")), sourceId: "no-such-source", idempotencyKey: keyFor("a") },
    "demand:source-not-allowed",
  );
  // Wrong kind authority: the operator allowlist does not carry promise-breach.
  const queueOnlyPath = allowlistWithKinds(["queue-claimable"]);
  const queueOnlyService = new ProfileDemandService(
    store,
    new ProfileOwnerStore({ sqlite, now: () => BREACH_NOW }),
    new DemandEligibilityProvider({
      allowlistPath: queueOnlyPath,
      now: () => BREACH_NOW,
      requiredStopPath: h.stopPath,
    }),
    { allowlistPath: queueOnlyPath, now: () => BREACH_NOW },
  );
  expect(() => queueOnlyService.publishDemand(breachRequest(episode("b")))).toThrow(
    "demand:source-not-allowed",
  );
  // Wrong profile: not in the source's profile set.
  publishRefused(
    { ...breachRequest(episode("c")), profileId: "other-profile", idempotencyKey: keyFor("c") },
    "demand:source-not-allowed",
  );
  // Wrong grant: hash not pinned by the operator.
  publishRefused(
    {
      ...breachRequest(episode("d")),
      grantRef: { ...h.grantRef, sha256: "9".repeat(64) },
      idempotencyKey: keyFor("d"),
    },
    "demand:grant-not-allowed",
  );
  // Forged owner: the request's owner generation does not match the pinned duty.
  publishRefused(
    {
      ...breachRequest(episode("e")),
      ownerGeneration: { ...h.generation, paneId: "w3J:evil" },
      idempotencyKey: keyFor("e"),
    },
    "demand:duty-generation-mismatch",
  );
  // Partial owner: a hosted generation missing a field is not a wake target.
  const partial = { ...breachRequest(episode("2")), idempotencyKey: keyFor("2") };
  const partialGeneration = (partial as { ownerGeneration?: Record<string, unknown> })
    .ownerGeneration;
  if (!partialGeneration) throw new Error("expected a hosted owner generation");
  delete partialGeneration.terminalId;
  publishRefused(partial, "demand:invalid-schema");
  // Lapsed owner: the pinned duty window is already fully closed.
  const lapsedRequest = {
    ...breachRequest(episode("3")),
    dutyRef: h.lapsedDutyRef,
    idempotencyKey: keyFor("3"),
  };
  publishRefused(lapsedRequest, "demand:duty-window-closed");
  void dutyRef;
  // Bad ref: the cited receipt does not hash to the pinned value.
  publishRefused(
    {
      ...breachRequest(episode("4")),
      snapshotRef: { ...h.receiptFor(episode("4")).snapshotRef, sha256: "8".repeat(64) },
      idempotencyKey: keyFor("4"),
    },
    "demand:ref-sha-mismatch",
  );
  // Expired window: the demand expired before now.
  publishRefused(
    {
      ...breachRequest(episode("5")),
      observedAt: "2026-10-10T10:00:00.000Z",
      expiresAt: "2026-10-10T11:30:00.000Z",
      idempotencyKey: keyFor("5"),
    },
    "demand:expired-or-invalid-window",
  );
  // A revision escalation of the same incident is not a caller authority.
  publishRefused(
    {
      ...breachRequest(episode("6")),
      activationRevision: 2,
      idempotencyKey: `${episode("6")}/promise-breach/2`,
    },
    "demand:continuation-proof-unavailable",
  );
  // None of the refusals persisted anything.
  expect(sqlite.prepare("select count(*) as n from profile_demand_events").get()).toEqual({ n: 0 });
  expect(sqlite.prepare("select count(*) as n from delivery_obligations").get()).toEqual({ n: 0 });
});

test("promise-breach: capability, durability, ambiguity resolution and post-publication identity changes", () => {
  const h = breachHarness();
  const { sqlite, store, owners, service, episode, breachRequest } = h;
  const delivery = () =>
    new ProfileDeliveryService({
      agents: new AgentStore(sqlite),
      obligations: new DeliveryObligationStore(sqlite),
      owners,
      profiles: new OrchestratorProfileStore(sqlite),
      demands: service,
      now: () => BREACH_NOW,
    });
  // The owner claimed WITHOUT the profile-demand capability: publication is
  // durable but withheld, and the demand rows are not leasable.
  const bare = owners.claim({
    profileId: "engine-coordinator",
    subscriberId: "owner-pi",
    harnessKind: "pi",
    harnessSessionRefJson: JSON.stringify({ kind: "path", value: h.generation.nativeSessionRef }),
    herdrSessionName: h.generation.herdrSession,
    workspaceId: h.generation.workspaceId,
    paneId: h.generation.paneId,
    terminalId: h.generation.terminalId,
  });
  if (bare.kind === "rejected") throw new Error("claim refused");
  const capEpisode = episode("a");
  const withheld = service.publishDemand(breachRequest(capEpisode));
  expect(withheld.disposition).toBe("created");
  expect(
    store.lookup({
      profileId: "engine-coordinator",
      sourceId: "factory-promise-scan",
      idempotencyKey: `${capEpisode}/promise-breach/1`,
    }),
  ).toMatchObject({
    found: true,
    state: "pending",
    withheldReason: "demand:owner-capability-unknown",
  });
  expect(() =>
    delivery().inboxLease({
      profileId: "engine-coordinator",
      leaseToken: bare.leaseToken,
      sourceKinds: ["agent", "profile-demand"],
    }),
  ).toThrow("source capability not claimed");

  // Durability failure: an injected obligation-insert failure rolls back the
  // whole publication — no event, no obligation, no half state.
  sqlite.exec(`create trigger refuse_breach_obligation before insert on delivery_obligations
    when new.kind = 'demand' begin select raise(abort, 'injected-breach-obligation-failure'); end`);
  expect(() => service.publishDemand(breachRequest(episode("b")))).toThrow(
    "injected-breach-obligation-failure",
  );
  expect(sqlite.prepare("select count(*) as n from profile_demand_events").get()).toEqual({ n: 1 });
  expect(sqlite.prepare("select count(*) as n from delivery_obligations").get()).toEqual({ n: 1 });
  // Ambiguous publication resolves through lookup: the aborted attempt left
  // nothing; a retry lands exactly one durable row for its own key.
  sqlite.exec("drop trigger refuse_breach_obligation");
  const resolved = service.publishDemand(breachRequest(episode("b")));
  expect(resolved.disposition).toBe("created");
  expect(
    sqlite
      .prepare("select count(*) as n from profile_demand_events where idempotency_key = ?")
      .get(`${episode("b")}/promise-breach/1`),
  ).toEqual({ n: 1 });

  // Adopt the capability and lease the withheld incident (the withhold mark
  // clears when lease eligibility passes).
  const adopted = owners.claim({
    profileId: "engine-coordinator",
    currentLeaseToken: bare.leaseToken,
    subscriberId: "owner-pi",
    harnessKind: "pi",
    acceptedSourceKinds: ["agent", "profile-demand"],
    harnessSessionRefJson: JSON.stringify({ kind: "path", value: h.generation.nativeSessionRef }),
    herdrSessionName: h.generation.herdrSession,
    workspaceId: h.generation.workspaceId,
    paneId: h.generation.paneId,
    terminalId: h.generation.terminalId,
  });
  if (adopted.kind === "rejected") throw new Error("adoption refused");
  const firstBatch = delivery().inboxLease({
    profileId: "engine-coordinator",
    leaseToken: adopted.leaseToken,
    sourceKinds: ["agent", "profile-demand"],
  }).obligations;
  expect(firstBatch).toHaveLength(1);
  // Settle the leased incidents so later lease attempts are not masked by
  // the single-wake capacity rule.
  delivery().inboxAck({
    ids: [withheld.obligationId],
    leaseToken: adopted.leaseToken,
    profileId: "engine-coordinator",
  });
  const secondBatch = delivery().inboxLease({
    profileId: "engine-coordinator",
    leaseToken: adopted.leaseToken,
    sourceKinds: ["agent", "profile-demand"],
  }).obligations;
  const secondLeased = secondBatch[0];
  if (!secondLeased) throw new Error("expected the second demand to lease");
  delivery().inboxAck({
    ids: [secondLeased.id],
    leaseToken: adopted.leaseToken,
    profileId: "engine-coordinator",
  });

  // Post-publication identity change of the EVIDENCE: mutating the cited
  // receipt breaks the whole-file hash at lease re-validation, so the batch
  // is withheld — the stored demand never silently re-binds. The preserved
  // refusal reason for re-validation failure is the existing invalid-event.
  const mutationEpisode = episode("c");
  service.publishDemand(breachRequest(mutationEpisode));
  const mutated = h.receiptFor(mutationEpisode);
  writeFileSync(mutated.snapshotRef.path, JSON.stringify({ ...mutated.value, tampered: true }));
  expect(
    delivery().inboxLease({
      profileId: "engine-coordinator",
      leaseToken: adopted.leaseToken,
      sourceKinds: ["agent", "profile-demand"],
    }).obligations,
  ).toEqual([]);
  expect(
    store.lookup({
      profileId: "engine-coordinator",
      sourceId: "factory-promise-scan",
      idempotencyKey: `${mutationEpisode}/promise-breach/1`,
    }),
  ).toMatchObject({ state: "pending", withheldReason: "demand:invalid-event" });

  // Post-publication identity change of the OWNER: a pane change after
  // publication fails lease eligibility — the wake targets the observed
  // generation, never a moved identity.
  const movedEpisode = episode("d");
  service.publishDemand(breachRequest(movedEpisode));
  const moved = owners.claim({
    profileId: "engine-coordinator",
    currentLeaseToken: adopted.leaseToken,
    subscriberId: "owner-pi",
    harnessKind: "pi",
    acceptedSourceKinds: ["agent", "profile-demand"],
    harnessSessionRefJson: JSON.stringify({ kind: "path", value: h.generation.nativeSessionRef }),
    herdrSessionName: h.generation.herdrSession,
    workspaceId: h.generation.workspaceId,
    paneId: "w3J:moved",
    terminalId: h.generation.terminalId,
  });
  if (moved.kind === "rejected") throw new Error("move refused");
  expect(
    delivery().inboxLease({
      profileId: "engine-coordinator",
      leaseToken: moved.leaseToken,
      sourceKinds: ["agent", "profile-demand"],
    }).obligations,
  ).toEqual([]);
  expect(
    store.lookup({
      profileId: "engine-coordinator",
      sourceId: "factory-promise-scan",
      idempotencyKey: `${movedEpisode}/promise-breach/1`,
    }),
  ).toMatchObject({ state: "pending", withheldReason: "demand:owner-generation-mismatch" });
});
