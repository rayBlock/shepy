import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
