import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { createDaemonInfo } from "@/daemon/daemon-identity.js";
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
import { DEFAULT_LEASE_GRACE_MS, ProfileOwnerStore } from "@/db/profile-owners.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import type { AgentEventRecord } from "@/observability/contracts.js";
import { ProfileDeliveryService } from "@/observability/profile-delivery-service.js";
import {
  type ProfileDiagnoseReport,
  ProfileDiagnoseService,
} from "@/observability/profile-diagnose-service.js";
import { ProfileService } from "@/observability/profile-service.js";
import { RpcTestClient } from "./rpc-test-client.js";

/**
 * RUN-20260913-04 D2 — `profile.diagnose` over the REAL RPC surface, using
 * the profile-delivery.test.ts fixtures as the model (real migrated SQLite,
 * real server). One read-only report must answer "why did this outcome not
 * reach its owner" — and the diagnose path must provably write nothing
 * (D3), which the byte-equality test pins.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

const DAEMON_INFO = createDaemonInfo({
  entryPath: fileURLToPath(import.meta.url),
  pid: 4321,
  version: "0.5.0-test",
});

const CLAIM_PANE_X = {
  harnessKind: "pi",
  harnessSessionRefJson: '{"sessionRef":"sess-ref-sentinel"}',
  herdrSessionName: "default",
  paneId: "wX:p1",
  profileId: "driffs",
  subscriberId: "sub-diagnose",
  terminalId: "tX",
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "shepy-diagnose-"));
  tempDirs.push(dir);
  const path = join(dir, "test.sqlite");
  const { sqlite } = openSqlite(path);
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const sessions = new HerdrSessionStore(sqlite);
  const agents = new AgentStore(sqlite);
  sessions.upsertRunning({ name: "default", sessionDir: "/tmp/a", socketPath: "/tmp/a.sock" });
  agents.replaceForSession({
    agents: [
      {
        agent: "hermes",
        agent_status: "working",
        focused: false,
        name: "driffs-worker",
        pane_id: "wA:p1",
        terminal_id: "tA",
        workspace_id: "wA",
      },
      {
        agent: "pi",
        agent_status: "idle",
        focused: false,
        name: "other-worker",
        pane_id: "wB:p1",
        terminal_id: "tB",
        workspace_id: "wB",
      },
    ],
    herdrSessionName: "default",
  });
  const profileStore = new OrchestratorProfileStore(sqlite);
  profileStore.createProfile({
    displayName: "Driffs",
    profileId: "driffs",
    projectRoots: ["/tmp/driffs"],
  });
  profileStore.addSubscription({
    agentSelectorJson: JSON.stringify({ kind: "name", value: "driffs-worker" }),
    herdrSessionName: "default",
    profileId: "driffs",
    workspaceSelectorJson: JSON.stringify({ herdrSession: "default", workspaceId: "wA" }),
  });
  const obligations = new DeliveryObligationStore(sqlite);
  const owners = new ProfileOwnerStore({ sqlite });
  const agentEvents = new AgentEventStore(sqlite);
  const history = createAgentHistoryService({
    cache: new AgentHistoryCacheStore(sqlite),
    homeDir: dirname(path),
  });
  const profiles = new ProfileService({ agents, history, profiles: profileStore });
  const delivery = new ProfileDeliveryService({
    agentEvents,
    agents,
    obligations,
    owners,
    profiles: profileStore,
  });
  const diagnose = new ProfileDiagnoseService({
    daemonInfo: DAEMON_INFO,
    obligations,
    owners,
    profiles,
  });
  const context = new AgentContextService({
    history,
    stores: { agentContextSnapshots: new AgentContextSnapshotStore(sqlite), agents },
  });
  const orchestrator = new AgentOrchestratorService({
    agentEvents,
    agents,
    scopes: new AgentOrchestratorScopeStore(sqlite),
  });
  const socketPath = join(dirname(path), "rpc.sock");
  const server = new ObservabilityRpcServer({
    context,
    daemonInfo: DAEMON_INFO,
    delivery,
    history,
    orchestrator,
    profileDiagnose: diagnose,
    profiles,
    socketPath,
    stores: {
      agentEvents,
      agents,
      herdrSessions: sessions,
      herdrWorkspaces: new HerdrWorkspaceStore(sqlite),
    },
  });
  return {
    agents,
    client: null as null | RpcTestClient,
    diagnose,
    delivery,
    obligations,
    owners,
    profileStore,
    server,
    sqlite,
    socketPath,
  };
}

async function rpcFixture() {
  const built = fixture();
  await built.server.start();
  built.client = await RpcTestClient.connect(built.socketPath);
  return built;
}

async function diagnose(
  built: Awaited<ReturnType<typeof rpcFixture>>,
  profileId: string,
  options: { cliBuildStamp?: string } = {},
): Promise<ProfileDiagnoseReport> {
  if (!built.client) throw new Error("fixture: client not connected");
  return (await built.client.request("profile.diagnose", {
    ...(options.cliBuildStamp !== undefined ? { cliBuildStamp: options.cliBuildStamp } : {}),
    profileId,
  })) as ProfileDiagnoseReport;
}

function eventFor(input: { eventId: number; worker: "driffs" | "other" }): AgentEventRecord {
  return {
    agentId: `agent-${input.worker}`,
    compactHistory: null,
    createdAt: new Date(),
    herdrSessionName: "default",
    id: input.eventId,
    paneId: input.worker === "driffs" ? "wA:p1" : "wB:p1",
    payload: { status: "idle" },
    terminalId: null,
    type: "agent.done",
    workspaceId: input.worker === "driffs" ? "wA" : "wB",
  };
}

function projectPending(built: Awaited<ReturnType<typeof rpcFixture>>, eventId: number): void {
  const worker = built.agents.list().find((row) => row.name === "driffs-worker");
  if (!worker) throw new Error("fixture: driffs-worker missing");
  built.delivery.projectAgentEvent({
    ...eventFor({ eventId, worker: "driffs" }),
    agentId: worker.id,
  });
}

function claimOwner(
  built: Awaited<ReturnType<typeof rpcFixture>>,
  overrides: Partial<typeof CLAIM_PANE_X> = {},
) {
  const claim = built.delivery.claim({ ...CLAIM_PANE_X, ...overrides });
  if (claim.kind !== "claimed" && claim.kind !== "reclaimed") throw new Error("claim failed");
  return claim;
}

describe("profile.diagnose RPC (RUN-20260913-04 D2)", () => {
  test("(a) healthy profile reports exactly one healthy info", async () => {
    const built = await rpcFixture();
    claimOwner(built);
    const report = await diagnose(built, "driffs");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ code: "healthy", severity: "info" });
    expect(report.profile).toEqual({
      displayName: "Driffs",
      profileId: "driffs",
      projectRoots: ["/tmp/driffs"],
    });
    expect(report.owner).toMatchObject({ canWakeIdle: true, state: "valid" });
    expect(report.queue.counts).toEqual({
      acked: 0,
      dead_letter: 0,
      delivered: 0,
      leased: 0,
      pending: 0,
    });
    expect(report.daemon).toEqual(DAEMON_INFO);
  });

  test("(b) a nonexistent profile is one profile_not_found blocker, not an RPC error", async () => {
    const built = await rpcFixture();
    const report = await diagnose(built, "ghost");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.code).toBe("profile_not_found");
    expect(report.findings[0]?.severity).toBe("blocker");
    expect(report.profile).toBeNull();
  });

  test("(c) an unmatched subscription is a blocker carrying the resolver's detail", async () => {
    const built = await rpcFixture();
    built.profileStore.createProfile({
      displayName: "Broken",
      profileId: "broken",
      projectRoots: [],
    });
    built.profileStore.addSubscription({
      agentSelectorJson: JSON.stringify({ kind: "name", value: "no-such-worker" }),
      herdrSessionName: "default",
      profileId: "broken",
      workspaceSelectorJson: JSON.stringify({ herdrSession: "default", workspaceId: "wA" }),
    });
    const report = await diagnose(built, "broken");
    const finding = report.findings.find((entry) => entry.code === "subscription_unmatched");
    expect(finding?.severity).toBe("blocker");
    expect(finding?.message).toContain("name no-such-worker");
    expect(report.subscriptions).toHaveLength(1);
    expect(report.subscriptions[0]?.resolution).toMatchObject({
      detail: expect.stringContaining("no-such-worker"),
      kind: "unmatched",
    });
    expect(report.subscriptions[0]?.selector).toEqual({ kind: "name", value: "no-such-worker" });
  });

  test("(d) no owner with a pending outcome is a no_owner blocker", async () => {
    const built = await rpcFixture();
    projectPending(built, 1);
    const report = await diagnose(built, "driffs");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ code: "no_owner", severity: "blocker" });
    expect(report.owner).toBeNull();
  });

  test("(e) a lapsed owner with pending outcomes is an owner_lapsed blocker", async () => {
    const built = await rpcFixture();
    projectPending(built, 1);
    const claim = claimOwner(built);
    // Same injection the RUN-02 lease tests use: the wire never injects now,
    // so the row itself must say the lease died.
    built.sqlite
      .prepare("update profile_owners set lease_expires_at = 1 where profile_id = ?")
      .run("driffs");
    const report = await diagnose(built, "driffs");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ code: "owner_lapsed", severity: "blocker" });
    expect(report.owner).toMatchObject({
      canWakeIdle: true,
      paneId: "wX:p1",
      state: "lapsed",
    });
    expect(claim.leaseToken).toBeTruthy();
  });

  test("(f) a Claude owner earns the cannot-wake-idle info", async () => {
    const built = await rpcFixture();
    claimOwner(built, { harnessKind: "claude" });
    const report = await diagnose(built, "driffs");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      code: "owner_cannot_wake_idle",
      severity: "info",
    });
    expect(report.owner).toMatchObject({ canWakeIdle: false, harnessKind: "claude" });
  });

  test("(g) two dead-letter rows are a warning with count 2", async () => {
    const built = await rpcFixture();
    projectPending(built, 1);
    projectPending(built, 2);
    built.sqlite
      .prepare(
        "update delivery_obligations set state = 'dead_letter', attempt_count = 5, last_error_code = 'max_attempts' where profile_id = ?",
      )
      .run("driffs");
    const report = await diagnose(built, "driffs");
    const finding = report.findings.find((entry) => entry.code === "dead_letters_present");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("2");
    expect(report.queue.counts.dead_letter).toBe(2);
    expect(report.queue.maxPendingAttempts).toBe(0);
  });

  test("(h) pending older than 10 minutes under a valid Pi owner is pending_not_draining", async () => {
    const built = await rpcFixture();
    projectPending(built, 1);
    claimOwner(built);
    built.sqlite
      .prepare("update delivery_obligations set created_at = ? where profile_id = ?")
      .run(Date.now() - 11 * 60_000, "driffs");
    const report = await diagnose(built, "driffs");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      code: "pending_not_draining",
      severity: "warning",
    });
    expect(report.queue.oldestPendingAgeMs).toBeGreaterThan(10 * 60_000);
  });

  test("(i) the report never carries the lease token, subscriber id, or session ref", async () => {
    const built = await rpcFixture();
    projectPending(built, 1);
    const claim = claimOwner(built);
    const report = await diagnose(built, "driffs");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(claim.leaseToken);
    expect(serialized).not.toContain("sub-diagnose");
    expect(serialized).not.toContain("sess-ref-sentinel");
  });

  test("an expired-but-in-grace lease reads in_grace", async () => {
    const built = await rpcFixture();
    claimOwner(built);
    built.sqlite
      .prepare("update profile_owners set lease_expires_at = ? where profile_id = ?")
      .run(Date.now() - 10_000, "driffs");
    const report = await diagnose(built, "driffs");
    expect(report.owner?.state).toBe("in_grace");
    expect(report.findings[0]?.code).toBe("healthy");
  });

  test("the lease + grace boundary is exact: lapsed at lease_expires_at + grace, in_grace 1 ms earlier", () => {
    const built = fixture();
    claimOwner(built);
    const now = 5_000_000;
    // The boundary instant itself: lease_expires_at + DEFAULT_LEASE_GRACE_MS
    // === now. Same shared predicate as claim/renew/inbox.lease, so the
    // diagnose verdict must flip exactly there, not 1 ms wide of it.
    built.sqlite
      .prepare("update profile_owners set lease_expires_at = ? where profile_id = ?")
      .run(now - DEFAULT_LEASE_GRACE_MS, "driffs");
    const atBoundary = built.diagnose.diagnose({ now, profileId: "driffs" });
    expect(atBoundary.owner?.state).toBe("lapsed");
    expect(atBoundary.findings.find((entry) => entry.code === "owner_lapsed")).toBeDefined();

    const beforeBoundary = built.diagnose.diagnose({ now: now - 1, profileId: "driffs" });
    expect(beforeBoundary.owner?.state).toBe("in_grace");
    expect(beforeBoundary.findings.find((entry) => entry.code === "owner_lapsed")).toBeUndefined();
  });

  test("a CLI build stamp unlike the daemon's is a daemon_version_skew warning", async () => {
    const built = await rpcFixture();
    claimOwner(built);
    const report = await diagnose(built, "driffs", {
      cliBuildStamp: "2000-01-01T00:00:00.000Z",
    });
    const finding = report.findings.find((entry) => entry.code === "daemon_version_skew");
    expect(finding?.severity).toBe("warning");
    expect(finding?.hint).toContain("shepy daemon restart");
  });

  test("a matching CLI build stamp earns no skew finding", async () => {
    const built = await rpcFixture();
    claimOwner(built);
    const report = await diagnose(built, "driffs", { cliBuildStamp: DAEMON_INFO.buildStamp });
    expect(report.findings.map((entry) => entry.code)).toEqual(["healthy"]);
  });
});

describe("profile.diagnose is read-only (RUN-20260913-04 D3)", () => {
  test("delivery_obligations and profile_owners are byte-identical across a diagnose", async () => {
    const built = await rpcFixture();
    projectPending(built, 1);
    projectPending(built, 2);
    const claim = claimOwner(built);
    // Give both tables non-trivial state: a stamped lease on one row, an
    // acked row, and an owner lease with real expiry stamps.
    built.delivery.inboxLease({ leaseToken: claim.leaseToken, profileId: "driffs" });
    built.sqlite
      .prepare(
        "update delivery_obligations set state = 'acked', acked_at = ? where agent_event_id = 2",
      )
      .run(Date.now());
    // One EXPIRED leased row: a diagnose that swept leases would flip it to
    // pending. (A freshly stamped lease made the forbidden write a no-op —
    // the sweep mutation survived this fixture unchanged.)
    built.sqlite
      .prepare("update delivery_obligations set lease_expires_at = ? where agent_event_id = 1")
      .run(Date.now() - 60_000);
    const snapshot = () => ({
      obligations: built.sqlite
        .prepare("select * from delivery_obligations order by agent_event_id")
        .all(),
      owners: built.sqlite.prepare("select * from profile_owners order by profile_id").all(),
    });
    const before = snapshot();
    expect(before.obligations).toHaveLength(2);
    await diagnose(built, "driffs");
    expect(snapshot()).toEqual(before);
  });
});

test("(j) a neutral Codex owner renders null host fields honestly", async () => {
  const built = await rpcFixture();
  const claim = built.delivery.claim({
    harnessKind: "codex",
    harnessSessionRefJson: JSON.stringify({
      kind: "thread",
      value: "01a11ff6-9f7f-71a1-9741-366612d6390f",
    }),
    profileId: "driffs",
    subscriberId: "codex-neutral",
  });
  if (claim.kind !== "claimed" && claim.kind !== "reclaimed")
    throw new Error("neutral claim failed");
  const report = await diagnose(built, "driffs");
  expect(report.owner).toMatchObject({ harnessKind: "codex", paneId: null, workspaceId: null });
});
