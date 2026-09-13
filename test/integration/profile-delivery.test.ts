import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { runCliCommand } from "@/cli/shepy.js";
import { ObservabilityRpcServer } from "@/daemon/observability-server.js";
import { AgentContextSnapshotStore } from "@/db/agent-context-snapshots.js";
import { AgentEventStore } from "@/db/agent-events.js";
import { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import { AgentOrchestratorScopeStore } from "@/db/agent-orchestrator-scopes.js";
import { AgentStore } from "@/db/agents.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { DeliveryObligationStore, MAX_DELIVERY_ATTEMPTS } from "@/db/delivery-obligations.js";
import { HerdrSessionStore } from "@/db/herdr-sessions.js";
import { HerdrWorkspaceStore } from "@/db/herdr-workspaces.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { ProfileOwnerStore } from "@/db/profile-owners.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import type { AgentEventRecord, AgentIndexRecord } from "@/observability/contracts.js";
import { ProfileDeliveryService } from "@/observability/profile-delivery-service.js";
import type { AgentSelector } from "@/observability/profile-selectors.js";
import { ProfileService } from "@/observability/profile-service.js";
import { RpcTestClient } from "./rpc-test-client.js";

/**
 * Phase 3 gate (vault §16): "offline owner reconnect receives every
 * unacknowledged matching outcome once per active delivery lease; nothing is
 * silently skipped."
 *
 * Covers §6.2 durability: at-least-once-until-acked, restart survival,
 * monotonic ack, lease expiry recovery, dead-letter bounds, and owner lease
 * replacement — all against a REAL migrated SQLite file (restart = reopen).
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

const _eventSeq = 0;

function fixture(overrides: { now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shepy-delivery-"));
  tempDirs.push(dir);
  const path = join(dir, "test.sqlite");
  const built = build(path, overrides);
  return { ...built, path };
}

function build(path: string, overrides: { now?: () => number } = {}) {
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
  const profiles = new OrchestratorProfileStore(sqlite);
  profiles.createProfile({ displayName: "Driffs", profileId: "driffs", projectRoots: [] });
  profiles.createProfile({ displayName: "Other", profileId: "other", projectRoots: [] });
  profiles.addSubscription({
    agentSelectorJson: JSON.stringify({ kind: "name", value: "driffs-worker" }),
    herdrSessionName: "default",
    profileId: "driffs",
    workspaceSelectorJson: JSON.stringify({ herdrSession: "default", workspaceId: "wA" }),
  });
  profiles.addSubscription({
    agentSelectorJson: JSON.stringify({ kind: "name", value: "other-worker" }),
    herdrSessionName: "default",
    profileId: "other",
    workspaceSelectorJson: JSON.stringify({ herdrSession: "default", workspaceId: "wB" }),
  });
  const obligations = new DeliveryObligationStore(sqlite);
  const owners = new ProfileOwnerStore({
    ...(overrides.now ? { now: overrides.now } : {}),
    sqlite,
  });
  const agentEvents = new AgentEventStore(sqlite);
  const delivery = new ProfileDeliveryService({
    agentEvents,
    agents,
    obligations,
    owners,
    profiles,
  });
  return { agentEvents, agents, delivery, obligations, owners, profiles, sessions, sqlite };
}

/** The profile.* RPC surface against the REAL daemon server, wired to the
 * REAL delivery service over the fixture's stores. Used to pin the owner
 * lease lifecycle where the pump actually drives it: over the wire. */
async function rpcFixture(overrides: { now?: () => number } = {}) {
  const built = fixture(overrides);
  const history = createAgentHistoryService({
    cache: new AgentHistoryCacheStore(built.sqlite),
    homeDir: dirname(built.path),
  });
  const context = new AgentContextService({
    history,
    stores: {
      agentContextSnapshots: new AgentContextSnapshotStore(built.sqlite),
      agents: built.agents,
    },
  });
  const orchestrator = new AgentOrchestratorService({
    agentEvents: built.agentEvents,
    agents: built.agents,
    scopes: new AgentOrchestratorScopeStore(built.sqlite),
  });
  const socketPath = join(dirname(built.path), "rpc.sock");
  const server = new ObservabilityRpcServer({
    context,
    delivery: built.delivery,
    history,
    orchestrator,
    socketPath,
    stores: {
      agentEvents: built.agentEvents,
      agents: built.agents,
      herdrSessions: built.sessions,
      herdrWorkspaces: new HerdrWorkspaceStore(built.sqlite),
    },
  });
  await server.start();
  const client = await RpcTestClient.connect(socketPath);
  return { built, client, server };
}

const CLAIM_PANE_X = {
  harnessKind: "pi",
  harnessSessionRefJson: "{}",
  herdrSessionName: "default",
  paneId: "wX:p1",
  profileId: "driffs",
  subscriberId: "sub-1",
  terminalId: "tX",
} as const;

const CLAIM_PANE_Y = {
  harnessKind: "pi",
  harnessSessionRefJson: "{}",
  herdrSessionName: "default",
  paneId: "wY:p1",
  profileId: "driffs",
  subscriberId: "sub-2",
  terminalId: "tY",
} as const;

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
    // A notifiable outcome. `agent.status.changed` is filtered at projection
    // (see NOTIFIABLE_EVENT_TYPES) and would produce no obligation here.
    type: "agent.done",
    workspaceId: input.worker === "driffs" ? "wA" : "wB",
  };
}

describe("obligation projection filter (vault §9.1)", () => {
  test("agent.status.changed never becomes an obligation; semantic events do", () => {
    const { agents, delivery } = fixture();
    const worker = agents.list().find((row) => row.name === "driffs-worker");
    if (!worker) throw new Error("fixture: driffs-worker missing");

    // The generic twin that fires on EVERY transition, including to `working`.
    delivery.projectAgentEvent({
      ...eventFor({ eventId: 1, worker: "driffs" }),
      agentId: worker.id,
      payload: { from: "idle", to: "working" },
      type: "agent.status.changed",
    });
    expect(delivery.inboxList({ profileId: "driffs" })).toHaveLength(0);

    // Every semantic type still projects.
    const semantic = ["agent.done", "agent.idle", "agent.blocked", "agent.tool.failed"] as const;
    semantic.forEach((type, index) => {
      delivery.projectAgentEvent({
        ...eventFor({ eventId: 100 + index, worker: "driffs" }),
        agentId: worker.id,
        type,
      });
    });
    expect(delivery.inboxList({ profileId: "driffs" })).toHaveLength(semantic.length);
  });

  test("marking a completed tab seen never creates another outcome; a new turn still does", () => {
    const built = fixture();
    const worker = built.agents.list().find((row) => row.name === "driffs-worker");
    if (!worker) throw new Error("fixture: driffs-worker missing");
    const { agentEvents, delivery } = built;
    const project = (id: number, from: string, to: "done" | "idle" | "blocked", ref: string) => {
      // The suppression is evidence-based: within-settled transitions only
      // vanish when the append-time assistant reference matches the prior
      // settled outcome. Events are appended first (production order), then
      // projected.
      const stored = agentEvents.append({
        agentId: worker.id,
        compactHistory:
          to === "blocked"
            ? null
            : ({
                historyRef: null,
                lastAssistantMessage: { ref, role: "assistant", text: "final", timestamp: null },
                lastToolResult: null,
                lastUserMessage: null,
                messageCount: 1,
                source: "pi-jsonl",
                updatedAt: null,
              } as never),
        herdrSessionName: "default",
        idempotencyKey: `seen-${id}`,
        paneId: "wA:p1",
        payload: { from, to },
        type: `agent.${to}`,
        workspaceId: "wA",
      });
      delivery.projectAgentEvent(stored);
      return stored;
    };
    const first = project(1, "working", "done", "ref-incident");
    // Actual incident: Herdr marked the tab seen five minutes after its
    // completion was delivered. Same completed turn (same assistant ref),
    // different UI status — suppressed by evidence, not by status alone.
    project(2, "done", "idle", "ref-incident");
    project(3, "idle", "done", "ref-incident");
    expect(delivery.inboxList({ profileId: "driffs" }).map((row) => row.agentEventId)).toEqual([
      first.id,
    ]);
    // Do not remove idle outcomes wholesale: a visible tab completes to idle.
    const fourth = project(4, "working", "idle", "ref-turn-2");
    project(5, "working", "blocked", "ref-blocked");
    expect(delivery.inboxList({ profileId: "driffs" }).map((row) => row.agentEventId)).toEqual(
      expect.arrayContaining([first.id, fourth.id]),
    );
    expect(delivery.inboxList({ profileId: "driffs" })).toHaveLength(3);
  });

  test("a done transition wakes the owner once, not twice", () => {
    const { agents, delivery } = fixture();
    const worker = agents.list().find((row) => row.name === "driffs-worker");
    if (!worker) throw new Error("fixture: driffs-worker missing");

    // Mirrors agent-index-service #appendStatusEvents: one transition appends
    // the generic event AND its semantic twin. Only one may reach the owner.
    delivery.projectAgentEvent({
      ...eventFor({ eventId: 1, worker: "driffs" }),
      agentId: worker.id,
      payload: { from: "working", to: "done" },
      type: "agent.status.changed",
    });
    delivery.projectAgentEvent({
      ...eventFor({ eventId: 2, worker: "driffs" }),
      agentId: worker.id,
      payload: { from: "working", to: "done" },
      type: "agent.done",
    });

    const pending = delivery.inboxList({ profileId: "driffs" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.agentEventId).toBe(2);
  });
});

describe("inbox.lease event-correlated outcomes", () => {
  function appendOutcomeEvent(input: {
    compactHistory?: Record<string, unknown> | null;
    idempotency: string;
  }) {
    const built = fixture();
    const worker = built.agents.list().find((row) => row.name === "driffs-worker");
    if (!worker) throw new Error("fixture: driffs-worker missing");
    const stored = built.agentEvents.append({
      agentId: worker.id,
      compactHistory: (input.compactHistory ?? null) as never,
      herdrSessionName: "default",
      idempotencyKey: input.idempotency,
      paneId: "wA:p1",
      payload: { agent: "hermes", from: "working", name: "driffs-worker", to: "done" },
      type: "agent.done",
      workspaceId: "wA",
    });
    built.delivery.projectAgentEvent(stored);
    // Leasing is owner-fenced, so these fixtures claim an owner and lease
    // under the claimed token.
    const owner = built.delivery.claim({
      harnessKind: "pi",
      harnessSessionRefJson: "{}",
      herdrSessionName: "default",
      paneId: "wX:p1",
      profileId: "driffs",
      subscriberId: "sub-1",
      terminalId: "tX",
    });
    if (owner.kind !== "claimed") throw new Error("fixture: owner claim rejected");
    return { delivery: built.delivery, ownerToken: owner.leaseToken, sqlite: built.sqlite, stored };
  }

  test("each leased obligation carries the immutable event snapshot, not live history", () => {
    const { delivery, ownerToken, stored } = appendOutcomeEvent({
      compactHistory: {
        historyRef: null,
        lastAssistantMessage: {
          ref: "r1",
          role: "assistant",
          text: "FX\u0007 audit\n complete — 5 findings",
          timestamp: null,
        },
        lastToolResult: {
          compact: null,
          ref: "r2",
          text: "TOOL BODY MUST NOT LEAK",
          timestamp: null,
          toolName: "bash",
        },
        lastUserMessage: null,
        messageCount: 3,
        source: "hermes-sqlite",
        updatedAt: null,
      },
      idempotency: "outcome-live",
    });
    const lease = delivery.inboxLease({ leaseToken: ownerToken, profileId: "driffs" });
    expect(lease.obligations).toHaveLength(1);
    const outcome = (lease.obligations[0] as { outcome?: unknown }).outcome as
      | Record<string, unknown>
      | undefined;
    expect(outcome).toMatchObject({
      agent: "hermes",
      eventId: stored.id,
      from: "working",
      name: "driffs-worker",
      paneId: "wA:p1",
      to: "done",
      type: "agent.done",
    });
    const excerpt = outcome?.excerpt as { text: string; truncated: boolean } | undefined;
    expect(excerpt).toEqual({ text: "FX audit complete — 5 findings", truncated: false });
    expect(excerpt?.text).not.toContain("TOOL BODY");
  });

  test("long excerpts are bounded with a read-back hint; tool bodies never ride", () => {
    const long = "x".repeat(5_000);
    const { delivery, ownerToken } = appendOutcomeEvent({
      compactHistory: {
        historyRef: null,
        lastAssistantMessage: { ref: "r1", role: "assistant", text: long, timestamp: null },
        lastToolResult: null,
        lastUserMessage: null,
        messageCount: 1,
        source: "hermes-sqlite",
        updatedAt: null,
      },
      idempotency: "outcome-long",
    });
    const lease = delivery.inboxLease({ leaseToken: ownerToken, profileId: "driffs" });
    const outcome = (
      lease.obligations[0] as { outcome?: { excerpt?: { text: string; truncated: boolean } } }
    ).outcome;
    expect(outcome?.excerpt?.truncated).toBe(true);
    expect(outcome?.excerpt?.text.length).toBeLessThanOrEqual(2_000);
    expect(outcome?.excerpt?.text).toContain("shepy agent read");
  });

  test("a missing historical event leases with an honest null outcome", () => {
    const { delivery, ownerToken, sqlite, stored } = appendOutcomeEvent({
      idempotency: "outcome-missing",
    });
    expect(delivery.inboxList({ profileId: "driffs" })).toHaveLength(1);
    sqlite.exec("delete from agent_events");
    const lease = delivery.inboxLease({ leaseToken: ownerToken, profileId: "driffs" });
    expect(lease.obligations).toHaveLength(1);
    expect((lease.obligations[0] as { outcome?: unknown }).outcome).toBeNull();
    expect((lease.obligations[0] as { agentEventId?: number }).agentEventId).toBe(stored.id);
  });

  test("enrichment preserves lease fencing — the owner's stamp beats a rival token", () => {
    const { delivery, ownerToken } = appendOutcomeEvent({ idempotency: "outcome-fencing" });
    const first = delivery.inboxLease({ leaseToken: ownerToken, profileId: "driffs" });
    expect(first.obligations).toHaveLength(1);
    // A rival token is refused outright — it can neither steal the leased
    // rows nor lease anything else while the owner holds the profile.
    expect(() => delivery.inboxLease({ leaseToken: "lease-2", profileId: "driffs" })).toThrow(
      /not the active owner/,
    );
    const leased = delivery.inboxList({ profileId: "driffs", state: "leased" });
    expect(leased).toHaveLength(1);
    expect(leased[0]?.leaseToken).toBeNull(); // read surface redacts (G1)
    expect(leased[0]?.state).toBe("leased");
  });
});

describe("evidence-based settled-outcome suppression (same-ref rule)", () => {
  function projectWithHistory(input: {
    delivery: ProfileDeliveryService;
    agentEvents: AgentEventStore;
    agentId: string;
    from: string;
    ref: string | null;
    to: "done" | "idle";
  }) {
    const stored = input.agentEvents.append({
      agentId: input.agentId,
      compactHistory:
        input.ref === null
          ? null
          : ({
              historyRef: null,
              lastAssistantMessage: {
                ref: input.ref,
                role: "assistant",
                text: "final response",
                timestamp: null,
              },
              lastToolResult: null,
              lastUserMessage: null,
              messageCount: 1,
              source: "pi-jsonl",
              updatedAt: null,
            } as never),
      herdrSessionName: "default",
      idempotencyKey: `settled-${input.from}-${input.to}-${input.ref ?? "null"}-${Math.random()}`,
      paneId: "wA:p1",
      payload: { agent: "pi", from: input.from, name: "driffs-worker", to: input.to },
      type: `agent.${input.to}`,
      workspaceId: "wA",
    });
    input.delivery.projectAgentEvent(stored);
    return stored;
  }

  function workerOf(built: ReturnType<typeof build>) {
    const worker = built.agents.list().find((row) => row.name === "driffs-worker");
    if (!worker) throw new Error("fixture: driffs-worker missing");
    return worker;
  }

  test("live incident shape: same assistant ref on the seen-transition produces ONE obligation", () => {
    const built = fixture();
    const worker = workerOf(built);
    // event 14691: working -> done (delivered)
    const project = (from: string, ref: string, to: "done" | "idle") =>
      projectWithHistory({
        agentEvents: built.agentEvents,
        agentId: worker.id,
        delivery: built.delivery,
        from,
        ref,
        to,
      });
    const first = project("working", "0eb4f8f3", "done");
    // event 14698: done -> idle (same immutable assistant final)
    project("done", "0eb4f8f3", "idle");
    expect(
      built.delivery.inboxList({ profileId: "driffs" }).map((row) => row.agentEventId),
    ).toEqual([first.id]);
  });

  test("a NEW completion across reconnect (different assistant ref) DELIVERS", () => {
    const built = fixture();
    const worker = workerOf(built);
    const project = (from: string, ref: string, to: "done" | "idle") =>
      projectWithHistory({
        agentEvents: built.agentEvents,
        agentId: worker.id,
        delivery: built.delivery,
        from,
        ref,
        to,
      });
    const first = project("working", "ref-old", "idle");
    // Observation gap: agent worked and completed while unobserved, then the
    // snapshot diff sees idle -> done with a NEW assistant final.
    const second = project("idle", "ref-new", "done");
    expect(
      built.delivery.inboxList({ profileId: "driffs" }).map((row) => row.agentEventId),
    ).toEqual([second.id, first.id]);
  });

  test("missing assistant-ref evidence is conservative: the transition DELIVERS", () => {
    const built = fixture();
    const worker = workerOf(built);
    const project = (from: string, ref: string | null, to: "done" | "idle") =>
      projectWithHistory({
        agentEvents: built.agentEvents,
        agentId: worker.id,
        delivery: built.delivery,
        from,
        ref,
        to,
      });
    const first = project("working", null, "done");
    const second = project("done", null, "idle");
    expect(
      built.delivery.inboxList({ profileId: "driffs" }).map((row) => row.agentEventId),
    ).toEqual([second.id, first.id]);
  });

  test("the same-ref comparison survives a daemon restart (reopened DB, not memory)", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepy-settled-restart-"));
    tempDirs.push(dir);
    const path = join(dir, "test.sqlite");
    const first = build(path);
    const workerOne = workerOf(first);
    const settled = projectWithHistory({
      delivery: first.delivery,
      agentEvents: first.agentEvents,
      agentId: workerOne.id,
      from: "working",
      ref: "ref-stable",
      to: "done",
    });
    projectWithHistory({
      delivery: first.delivery,
      agentEvents: first.agentEvents,
      agentId: workerOne.id,
      from: "done",
      ref: "ref-stable",
      to: "idle",
    });
    expect(first.delivery.inboxList({ profileId: "driffs" })).toHaveLength(1);
    // Daemon restart: every store reopens from the same SQLite file.
    const reopened = build(path);
    const workerTwo = workerOf(reopened);
    expect(workerTwo.id).toBe(workerOne.id);
    projectWithHistory({
      delivery: reopened.delivery,
      agentEvents: reopened.agentEvents,
      agentId: workerTwo.id,
      from: "idle",
      ref: "ref-stable",
      to: "done",
    });
    const changed = projectWithHistory({
      delivery: reopened.delivery,
      agentEvents: reopened.agentEvents,
      agentId: workerTwo.id,
      from: "done",
      ref: "ref-after-restart",
      to: "idle",
    });
    expect(
      reopened.delivery.inboxList({ profileId: "driffs" }).map((row) => row.agentEventId),
    ).toEqual([changed.id, settled.id]);
  });

  test("genuine working transitions and blockers still project", () => {
    const built = fixture();
    const worker = workerOf(built);
    const project = (from: string, ref: string, to: "done" | "idle") =>
      projectWithHistory({
        agentEvents: built.agentEvents,
        agentId: worker.id,
        delivery: built.delivery,
        from,
        ref,
        to,
      });
    const idle = project("working", "ref-a", "idle");
    const blocked = project("working", "ref-b", "done");
    built.delivery.projectAgentEvent({
      ...eventFor({ eventId: 900, worker: "driffs" }),
      agentId: worker.id,
      payload: { from: "working", to: "blocked" },
      type: "agent.blocked",
    });
    expect(
      built.delivery.inboxList({ profileId: "driffs" }).map((row) => row.agentEventId),
    ).toEqual([900, blocked.id, idle.id]);
  });
});

describe("operator retire (stale backlog cleanup)", () => {
  test("retires pending obligations without delivering them", () => {
    const { agents, delivery } = fixture();
    const worker = agents.list().find((row) => row.name === "driffs-worker");
    if (!worker) throw new Error("fixture: driffs-worker missing");
    for (let index = 0; index < 3; index += 1) {
      delivery.projectAgentEvent({
        ...eventFor({ eventId: index + 1, worker: "driffs" }),
        agentId: worker.id,
      });
    }
    expect(delivery.inboxList({ profileId: "driffs", state: "pending" })).toHaveLength(3);

    expect(delivery.retire({ profileId: "driffs" })).toEqual({ retired: 3 });

    expect(delivery.inboxList({ profileId: "driffs", state: "pending" })).toHaveLength(0);
    expect(delivery.inboxList({ profileId: "driffs", state: "acked" })).toHaveLength(3);
  });

  test("never retires an obligation held by an active lease", () => {
    const { agents, delivery } = fixture();
    const worker = agents.list().find((row) => row.name === "driffs-worker");
    if (!worker) throw new Error("fixture: driffs-worker missing");
    for (let index = 0; index < 2; index += 1) {
      delivery.projectAgentEvent({
        ...eventFor({ eventId: index + 1, worker: "driffs" }),
        agentId: worker.id,
      });
    }
    const owner = delivery.claim({
      harnessKind: "pi",
      harnessSessionRefJson: "{}",
      herdrSessionName: "default",
      paneId: "wA:p1",
      profileId: "driffs",
      subscriberId: "sub-1",
      terminalId: "term-1",
    });
    if (owner.kind !== "claimed") throw new Error("fixture: claim rejected");
    const leased = delivery.inboxLease({ leaseToken: owner.leaseToken, profileId: "driffs" });
    expect(leased.obligations.length).toBeGreaterThan(0);

    // An operator retire must not race the owner's in-flight batch.
    expect(delivery.retire({ profileId: "driffs" })).toEqual({ retired: 0 });
    expect(delivery.inboxList({ profileId: "driffs", state: "leased" })).toHaveLength(
      leased.obligations.length,
    );
  });

  test("olderThan retires only the stale backlog, sparing fresh events", () => {
    const { delivery, obligations, profiles } = fixture();
    const [subscription] = profiles.listSubscriptions("driffs");
    if (!subscription) throw new Error("fixture: driffs subscription missing");

    // Drive the store directly so both rows get deterministic created_at.
    const stale = 10_000_000;
    obligations.project({
      agentEventId: 1,
      now: stale,
      profileId: "driffs",
      subscriptionId: subscription.id,
    });
    obligations.project({
      agentEventId: 2,
      now: stale + 60_000,
      profileId: "driffs",
      subscriptionId: subscription.id,
    });

    expect(delivery.retire({ olderThan: stale + 1, profileId: "driffs" })).toEqual({ retired: 1 });
    const remaining = delivery.inboxList({ profileId: "driffs", state: "pending" });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.agentEventId).toBe(2);
  });
});

describe("Phase 3 gate — durable delivery obligations", () => {
  test("projection is scoped: only the matching profile gets an obligation", () => {
    const { delivery } = fixture();
    // Fixture agent ids are generated UUIDs; resolve via the store list.
    // Simulate the real flow: project with the REAL agent ids.
    const { agents, delivery: service } = fixture();
    const driffsAgent = agents.list().find((row) => row.name === "driffs-worker");
    if (!driffsAgent) throw new Error("fixture: driffs-worker missing");
    const otherAgent = agents.list().find((row) => row.name === "other-worker");
    if (!otherAgent) throw new Error("fixture: other-worker missing");
    const driffsEvent = { ...eventFor({ eventId: 1, worker: "driffs" }), agentId: driffsAgent.id };
    const otherEvent = { ...eventFor({ eventId: 2, worker: "other" }), agentId: otherAgent.id };
    service.projectAgentEvent(driffsEvent);
    service.projectAgentEvent(otherEvent);
    expect(delivery).toBeDefined(); // fixture var kept for clarity
    expect(service.inboxList({ profileId: "driffs" })).toHaveLength(1);
    expect(service.inboxList({ profileId: "other" })).toHaveLength(1);
    expect(service.inboxList({ profileId: "driffs" })[0]?.agentEventId).toBe(1);
    expect(service.inboxList({ profileId: "other" })[0]?.agentEventId).toBe(2);
  });

  test("happy path: lease → delivered → ack retires exactly the batch", () => {
    const { agents, delivery } = fixture();
    const worker = agents.list().find((row) => row.name === "driffs-worker");
    if (!worker) throw new Error("fixture: driffs-worker missing");
    delivery.projectAgentEvent({
      ...eventFor({ eventId: 10, worker: "driffs" }),
      agentId: worker.id,
    });
    delivery.projectAgentEvent({
      ...eventFor({ eventId: 11, worker: "driffs" }),
      agentId: worker.id,
    });
    const claim = delivery.claim({
      harnessKind: "pi",
      harnessSessionRefJson: "{}",
      herdrSessionName: "default",
      paneId: "wX:p1",
      profileId: "driffs",
      subscriberId: "sub-1",
      terminalId: "tX",
    });
    expect(claim.kind).toBe("claimed");
    if (claim.kind === "claimed") {
      const batch = delivery.inboxLease({ leaseToken: claim.leaseToken, profileId: "driffs" });
      expect(batch.obligations).toHaveLength(2);
      expect(batch.obligations.map((obligation) => obligation.agentEventId)).toEqual([10, 11]);
      delivery.inboxDelivered({
        ids: batch.obligations.map((obligation) => obligation.id),
        leaseToken: claim.leaseToken,
        ownerSessionRefJson: "{}",
      });
      const ack = delivery.inboxAck({
        ids: batch.obligations.map((obligation) => obligation.id),
        leaseToken: claim.leaseToken,
        profileId: "driffs",
      });
      expect(ack.acked).toBe(2);
      expect(delivery.inboxList({ profileId: "driffs", state: "acked" })).toHaveLength(2);
      // Nothing pending remains; a new lease gets nothing.
      expect(
        delivery.inboxLease({ leaseToken: claim.leaseToken, profileId: "driffs" }).obligations,
      ).toHaveLength(0);
    }
  });

  test("ack by a foreign lease token is rejected, never silently acked", () => {
    const { agents, delivery } = fixture();
    const worker = agents.list().find((row) => row.name === "driffs-worker");
    if (!worker) throw new Error("fixture: driffs-worker missing");
    delivery.projectAgentEvent({
      ...eventFor({ eventId: 20, worker: "driffs" }),
      agentId: worker.id,
    });
    const claim = delivery.claim({
      harnessKind: "pi",
      harnessSessionRefJson: "{}",
      herdrSessionName: "default",
      paneId: "wX:p1",
      profileId: "driffs",
      subscriberId: "sub-1",
      terminalId: "tX",
    });
    if (claim.kind !== "claimed") throw new Error("claim failed");
    const batch = delivery.inboxLease({ leaseToken: claim.leaseToken, profileId: "driffs" });
    const attacker = delivery.inboxAck({
      ids: batch.obligations.map((o) => o.id),
      leaseToken: "forged",
      profileId: "driffs",
    });
    expect(attacker.acked).toBe(0);
    expect(attacker.rejected).toHaveLength(batch.obligations.length);
    expect(delivery.inboxList({ profileId: "driffs", state: "leased" })).toHaveLength(
      batch.obligations.length,
    );
  });

  test("unacked obligations survive restart and redeliver exactly once per lease", () => {
    const first = fixture();
    const worker = first.agents.list().find((row) => row.name === "driffs-worker");
    if (!worker) throw new Error("fixture: driffs-worker missing");
    first.delivery.projectAgentEvent({
      ...eventFor({ eventId: 30, worker: "driffs" }),
      agentId: worker.id,
    });
    first.delivery.projectAgentEvent({
      ...eventFor({ eventId: 31, worker: "driffs" }),
      agentId: worker.id,
    });
    // Owner leases 30 but crashes before ack.
    const claim1 = first.delivery.claim({
      harnessKind: "pi",
      harnessSessionRefJson: "{}",
      herdrSessionName: "default",
      paneId: "wX:p1",
      profileId: "driffs",
      subscriberId: "sub-1",
      terminalId: "tX",
    });
    if (claim1.kind !== "claimed") throw new Error("claim failed");
    first.delivery.inboxLease({ leaseToken: claim1.leaseToken, profileId: "driffs" });
    first.sqlite.close?.();

    // "Restart": same SQLite file, fresh stores. The crashed owner's lease
    // has expired (clock far past lease + reconnect grace), so a NEW
    // terminal may claim.
    const clock2 = Date.now() + 10 * 60_000;
    const second = build(first.path, { now: () => clock2 });
    const claim2 = second.delivery.claim({
      harnessKind: "pi",
      harnessSessionRefJson: "{}",
      herdrSessionName: "default",
      paneId: "wX:p2",
      profileId: "driffs",
      subscriberId: "sub-2",
      terminalId: "tX2",
    });
    if (claim2.kind !== "claimed" && claim2.kind !== "reclaimed")
      throw new Error(`reclaim failed: ${claim2.kind}`);
    const batch = second.delivery.inboxLease({
      leaseToken: claim2.leaseToken,
      now: clock2,
      profileId: "driffs",
    });
    // Every unacknowledged outcome, exactly once, oldest first.
    expect(batch.obligations.map((o) => o.agentEventId)).toEqual([30, 31]);
    const again = second.delivery.inboxLease({
      leaseToken: claim2.leaseToken,
      now: clock2,
      profileId: "driffs",
    });
    expect(again.obligations).toHaveLength(0); // already leased by this lease
  });

  test("lease expiry returns stranded obligations; bounded attempts dead-letter", () => {
    let clock = 1_000_000;
    const { agents, delivery } = fixture({ now: () => clock });
    const worker = agents.list().find((row) => row.name === "driffs-worker");
    if (!worker) throw new Error("fixture: driffs-worker missing");
    delivery.projectAgentEvent({
      ...eventFor({ eventId: 40, worker: "driffs" }),
      agentId: worker.id,
    });
    // Burn attempts: lease and let it expire MAX times.
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      const claim = delivery.claim({
        harnessKind: "pi",
        harnessSessionRefJson: "{}",
        herdrSessionName: "default",
        paneId: "wX:p1",
        profileId: "driffs",
        subscriberId: `sub-${attempt}`,
        terminalId: "tX",
      });
      if (claim.kind !== "claimed" && claim.kind !== "reclaimed") throw new Error("claim failed");
      const batch = delivery.inboxLease({
        leaseToken: claim.leaseToken,
        now: clock,
        profileId: "driffs",
      });
      expect(batch.obligations.length).toBe(1);
      clock += 10 * 60_000; // lease expires
    }
    // One more lease call triggers the sweep: the final lease expires back
    // to pending at the attempt cap, then dead-letters. Leasing is
    // owner-fenced, so the sweep trigger is a legitimate owner: a fresh
    // claimant takes over the long-lapsed lease and leases under its token.
    const sweeper = delivery.claim({
      harnessKind: "pi",
      harnessSessionRefJson: "{}",
      herdrSessionName: "default",
      paneId: "wX:p2",
      profileId: "driffs",
      subscriberId: "sweeper",
      terminalId: "tX",
    });
    if (sweeper.kind !== "claimed" && sweeper.kind !== "reclaimed") throw new Error("claim failed");
    delivery.inboxLease({ leaseToken: sweeper.leaseToken, now: clock, profileId: "driffs" });
    const dead = delivery.inboxList({ profileId: "driffs", state: "dead_letter" });
    expect(dead).toHaveLength(1);
    const deadRow = dead[0];
    if (!deadRow) throw new Error("dead_letter row missing");
    expect(deadRow.lastErrorCode).toBe("max_attempts");
    // Operator retry revives it.
    expect(delivery.retry(deadRow.id)).toBe(true);
    expect(delivery.inboxList({ profileId: "driffs", state: "pending" })).toHaveLength(1);
  });

  test("owner replacement: active lease rejects a different subscriber, expired allows it", () => {
    let clock = 1_000_000;
    const { delivery } = fixture({ now: () => clock });
    const first = delivery.claim({
      harnessKind: "pi",
      harnessSessionRefJson: "{}",
      herdrSessionName: "default",
      paneId: "wX:p1",
      profileId: "driffs",
      subscriberId: "sub-1",
      terminalId: "tX",
    });
    expect(first.kind).toBe("claimed");
    const contested = delivery.claim({
      harnessKind: "pi",
      harnessSessionRefJson: "{}",
      herdrSessionName: "default",
      paneId: "wY:p1",
      profileId: "driffs",
      subscriberId: "sub-2",
      terminalId: "tY",
    });
    expect(contested.kind).toBe("rejected");
    clock += 10 * 60_000; // past lease + grace
    const takeover = delivery.claim({
      harnessKind: "pi",
      harnessSessionRefJson: "{}",
      herdrSessionName: "default",
      paneId: "wY:p1",
      profileId: "driffs",
      subscriberId: "sub-2",
      terminalId: "tY",
    });
    expect(takeover.kind).toBe("reclaimed");
    // The old lease token no longer acks.
    if (first.kind === "claimed") {
      expect(delivery.renew({ leaseToken: first.leaseToken, profileId: "driffs" })).toBe(false);
    }
  });

  test("nack returns the batch to pending with the error recorded", () => {
    const { agents, delivery } = fixture();
    const worker = agents.list().find((row) => row.name === "driffs-worker");
    if (!worker) throw new Error("fixture: driffs-worker missing");
    delivery.projectAgentEvent({
      ...eventFor({ eventId: 50, worker: "driffs" }),
      agentId: worker.id,
    });
    const claim = delivery.claim({
      harnessKind: "pi",
      harnessSessionRefJson: "{}",
      herdrSessionName: "default",
      paneId: "wX:p1",
      profileId: "driffs",
      subscriberId: "sub-1",
      terminalId: "tX",
    });
    if (claim.kind !== "claimed") throw new Error("claim failed");
    const batch = delivery.inboxLease({ leaseToken: claim.leaseToken, profileId: "driffs" });
    const nack = delivery.inboxNack({
      errorCode: "harness_interrupted",
      ids: batch.obligations.map((o) => o.id),
      leaseToken: claim.leaseToken,
    });
    expect(nack.nacked).toBe(1);
    const pending = delivery.inboxList({ profileId: "driffs", state: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.lastErrorCode).toBe("harness_interrupted");
  });
});

describe("inbox mutates only for the token that currently owns the profile", () => {
  test("the A2-1-adjacent attack: inbox.lease with an arbitrary token is refused", async () => {
    const { built, client, server } = await rpcFixture();
    try {
      const claim = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      expect(claim.result.kind).toBe("claimed");
      const worker = built.agents.list().find((row) => row.name === "driffs-worker");
      if (!worker) throw new Error("fixture: driffs-worker missing");
      for (const eventId of [71, 72]) {
        built.delivery.projectAgentEvent({
          ...eventFor({ eventId, worker: "driffs" }),
          agentId: worker.id,
        });
      }

      // Pre-fix, ANY string leased the pending batch under itself: the rows
      // became un-ackable by the real owner, and a rival harness could pull
      // the same batch the legitimate owner was about to pump.
      await expect(
        client.request("inbox.lease", { leaseToken: "attacker-string", profileId: "driffs" }),
      ).rejects.toThrow(/not the active owner/);
      // Nothing moved: the rows are still pending for the real owner.
      const pending = (await client.request("inbox.list", {
        profileId: "driffs",
        state: "pending",
      })) as { obligations: unknown[] };
      expect(pending.obligations).toHaveLength(2);
      const ownerLease = (await client.request("inbox.lease", {
        leaseToken: claim.result.leaseToken,
        profileId: "driffs",
      })) as { obligations: unknown[] };
      expect(ownerLease.obligations).toHaveLength(2);

      // And with no owner at all there is nothing to present.
      await expect(
        client.request("inbox.lease", { leaseToken: claim.result.leaseToken, profileId: "other" }),
      ).rejects.toThrow(/not the active owner/);
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });

  test("a token superseded by a re-claim can no longer lease", async () => {
    let clock = 1_000_000;
    const { built, client, server } = await rpcFixture({ now: () => clock });
    try {
      const first = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      clock += 60_000;
      const second = (await client.request("profile.claim", {
        ...CLAIM_PANE_X,
        currentLeaseToken: first.result.leaseToken,
      })) as {
        result: { kind: string; leaseToken: string };
      };
      expect(second.result.kind).toBe("reclaimed");
      const worker = built.agents.list().find((row) => row.name === "driffs-worker");
      if (!worker) throw new Error("fixture: driffs-worker missing");
      built.delivery.projectAgentEvent({
        ...eventFor({ eventId: 73, worker: "driffs" }),
        agentId: worker.id,
      });
      await expect(
        client.request("inbox.lease", { leaseToken: first.result.leaseToken, profileId: "driffs" }),
      ).rejects.toThrow(/not the active owner/);
      const lease = (await client.request("inbox.lease", {
        leaseToken: second.result.leaseToken,
        profileId: "driffs",
      })) as { obligations: unknown[] };
      expect(lease.obligations).toHaveLength(1);
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });

  test("a superseded token still acks exactly the rows its own lease stamped", async () => {
    // The Claude Code hook acks on the turn AFTER delivering, with the token
    // persisted at delivery time. A same-subscriber re-claim between those
    // two moments mints a new token; refusing the persisted one would
    // redeliver a batch the user already saw. Ack authority therefore
    // derives from holding the lease that stamped the rows — not from
    // currently owning the profile. A token that stamped nothing is refused
    // per-row either way, so this accepts no new capability.
    let clock = 1_000_000;
    const { built, client, server } = await rpcFixture({ now: () => clock });
    try {
      const first = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      const staleToken = first.result.leaseToken;
      const worker = built.agents.list().find((row) => row.name === "driffs-worker");
      if (!worker) throw new Error("fixture: driffs-worker missing");
      for (const eventId of [74, 75]) {
        built.delivery.projectAgentEvent({
          ...eventFor({ eventId, worker: "driffs" }),
          agentId: worker.id,
        });
      }
      const lease = (await client.request("inbox.lease", {
        leaseToken: staleToken,
        profileId: "driffs",
      })) as { obligations: Array<{ id: string }> };
      expect(lease.obligations).toHaveLength(2);
      const stampedIds = lease.obligations.map((row) => row.id);

      // The re-claim between delivery and ack rotates the token. The
      // holder presents the token it still holds — the fast path.
      clock += 60_000;
      const second = (await client.request("profile.claim", {
        ...CLAIM_PANE_X,
        currentLeaseToken: staleToken,
      })) as {
        result: { kind: string; leaseToken: string };
      };
      expect(second.result.kind).toBe("reclaimed");

      // The superseded token retires exactly its own stamped rows...
      await expect(
        client.request("inbox.ack", {
          ids: stampedIds,
          leaseToken: staleToken,
          profileId: "driffs",
        }),
      ).resolves.toEqual({ acked: 2, rejected: [] });

      // ...and it cannot touch rows stamped by the NEW owner's lease. The
      // new owner leases a fresh outcome; the stale token's ack of it is
      // rejected per-row and the row stays leased.
      built.delivery.projectAgentEvent({
        ...eventFor({ eventId: 76, worker: "driffs" }),
        agentId: worker.id,
      });
      const newLease = (await client.request("inbox.lease", {
        leaseToken: second.result.leaseToken,
        profileId: "driffs",
      })) as { obligations: Array<{ id: string }> };
      expect(newLease.obligations).toHaveLength(1);
      const newRowId = newLease.obligations[0]?.id;
      if (!newRowId) throw new Error("fixture: new lease returned no rows");
      await expect(
        client.request("inbox.ack", {
          ids: [newRowId],
          leaseToken: staleToken,
          profileId: "driffs",
        }),
      ).resolves.toEqual({ acked: 0, rejected: [newRowId] });
      const stillLeased = (await client.request("inbox.list", {
        profileId: "driffs",
        state: "leased",
      })) as { obligations: Array<{ id: string }> };
      expect(stillLeased.obligations.map((row) => row.id)).toEqual([newRowId]);
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });
});

describe("lease tokens never reach a caller that did not present them", () => {
  test("the A2-1 attack: inbox.list must not disclose the owner's live lease token", async () => {
    const { built, client, server } = await rpcFixture();
    try {
      const claim = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      expect(claim.result.kind).toBe("claimed");
      const ownerToken = claim.result.leaseToken;

      // The owner's normal working state: one row leased, one row delivered
      // and awaiting ack, one row still pending.
      const worker = built.agents.list().find((row) => row.name === "driffs-worker");
      if (!worker) throw new Error("fixture: driffs-worker missing");
      for (const eventId of [61, 62, 63]) {
        built.delivery.projectAgentEvent({
          ...eventFor({ eventId, worker: "driffs" }),
          agentId: worker.id,
        });
      }
      const lease = (await client.request("inbox.lease", {
        leaseToken: ownerToken,
        profileId: "driffs",
      })) as { obligations: Array<{ id: string }> };
      expect(lease.obligations.length).toBe(3);
      const deliveredId = lease.obligations[0]?.id;
      if (!deliveredId) throw new Error("fixture: lease returned no rows");
      await client.request("inbox.delivered", {
        ids: [deliveredId],
        leaseToken: ownerToken,
        ownerSessionRefJson: "{}",
      });

      // The read surface requires no token at all — so it must carry none.
      // The reviewer's chain was: list → read the token → profile.release →
      // owner evicted. Every state, and the unfiltered default, is probed.
      const states = [undefined, "pending", "leased", "delivered", "acked", "dead_letter"] as const;
      for (const state of states) {
        const list = (await client.request(
          "inbox.list",
          state === undefined ? { profileId: "driffs" } : { profileId: "driffs", state },
        )) as {
          obligations: Array<{ id: string; leaseToken: string | null; state: string }>;
        };
        expect(JSON.stringify(list)).not.toContain(ownerToken);
        for (const row of list.obligations) {
          expect(row.leaseToken ?? null).toBeNull();
        }
      }

      // The whole payoff of the leak was evicting the owner with a token
      // read out of a listing. Nothing else serves one to a tokenless caller.
      const owner = (await client.request("profile.owner", { profileId: "driffs" })) as {
        owner: unknown;
      };
      expect(JSON.stringify(owner)).not.toContain(ownerToken);
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });

  test("inbox.lease still returns the caller's own rows under the caller's own token", async () => {
    const { built, client, server } = await rpcFixture();
    try {
      const claim = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      const ownerToken = claim.result.leaseToken;
      const worker = built.agents.list().find((row) => row.name === "driffs-worker");
      if (!worker) throw new Error("fixture: driffs-worker missing");
      built.delivery.projectAgentEvent({
        ...eventFor({ eventId: 64, worker: "driffs" }),
        agentId: worker.id,
      });
      const lease = (await client.request("inbox.lease", {
        leaseToken: ownerToken,
        profileId: "driffs",
      })) as { obligations: Array<{ id: string; leaseToken: string | null }> };
      expect(lease.obligations).toHaveLength(1);
      // The holder may see the token it itself presented and the rows it
      // itself leased — this is the one read that legitimately carries it.
      expect(lease.obligations[0]?.leaseToken).toBe(ownerToken);
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });
});

describe("profile.renew RPC (owner lease heartbeat)", () => {
  const LEASE_MS = 5 * 60_000;
  const GRACE_MS = 30_000;

  test("profile.renew keeps a pumping owner unstealable past lease + grace", async () => {
    let clock = 1_000_000;
    const { built, client, server } = await rpcFixture({ now: () => clock });
    try {
      const claim = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      expect(claim.result.kind).toBe("claimed");
      // The pump heartbeat: still inside the original lease, the owner
      // renews — the lease now runs from the renewal, not the claim.
      clock += 5 * 60_000;
      await expect(
        client.request("profile.renew", {
          leaseToken: claim.result.leaseToken,
          profileId: "driffs",
        }),
      ).resolves.toEqual({ renewed: true });
      // t0 + 5m31s — the moment an UNrenewed lease would have lapsed and
      // handed the profile to the next claimant. A pumping owner keeps it.
      clock += 31_000;
      // A healthy owner must NOT lose the profile just because time passed.
      const contested = (await client.request("profile.claim", CLAIM_PANE_Y)) as {
        result: { kind: string; owner?: { paneId: string; harnessKind: string }; reason?: string };
      };
      expect(contested.result).toMatchObject({
        kind: "rejected",
        owner: { paneId: "wX:p1", harnessKind: "pi" },
        reason: "lease_active",
      });
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });

  test("a renew from a token that no longer owns returns renewed:false", async () => {
    let clock = 1_000_000;
    const { built, client, server } = await rpcFixture({ now: () => clock });
    try {
      const claim = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      expect(claim.result.kind).toBe("claimed");
      clock += LEASE_MS + GRACE_MS + 1_000;
      const stolen = (await client.request("profile.claim", CLAIM_PANE_Y)) as {
        result: { kind: string; leaseToken: string };
      };
      expect(stolen.result.kind).toBe("reclaimed"); // row existed → takeover
      // The displaced owner's token is dead; its heartbeat must not revive it.
      await expect(
        client.request("profile.renew", {
          leaseToken: claim.result.leaseToken,
          profileId: "driffs",
        }),
      ).resolves.toEqual({ renewed: false });
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });

  test("renew never resurrects a lease that lapsed uncontested past lease + grace", async () => {
    let clock = 1_000_000;
    const { built, client, server } = await rpcFixture({ now: () => clock });
    try {
      const claim = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      expect(claim.result.kind).toBe("claimed");
      // The lease lapses with nobody contesting: no rival claim ever lands.
      clock += LEASE_MS + GRACE_MS + 1_000;
      // The owner returns from the outage and heartbeats. The claim path
      // treats this exact instant as claimable, so the heartbeat must fail
      // closed too — renewing the row would otherwise hand the returner a
      // lease that a claimant could have taken a millisecond earlier.
      await expect(
        client.request("profile.renew", {
          leaseToken: claim.result.leaseToken,
          profileId: "driffs",
        }),
      ).resolves.toEqual({ renewed: false });
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });

  test("renew and claim agree just inside the expiry boundary", async () => {
    let clock = 1_000_000;
    const { built, client, server } = await rpcFixture({ now: () => clock });
    try {
      const claim = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      expect(claim.result.kind).toBe("claimed");
      clock += LEASE_MS + GRACE_MS - 1_000;
      // One second before the boundary both paths still call the lease live:
      // a rival claim is rejected…
      await expect(client.request("profile.claim", CLAIM_PANE_Y)).resolves.toMatchObject({
        result: { kind: "rejected", reason: "lease_active" },
      });
      // …and the holder's heartbeat still renews (this also extends the
      // lease, so the steal assertion below must not depend on it).
      await expect(
        client.request("profile.renew", {
          leaseToken: claim.result.leaseToken,
          profileId: "driffs",
        }),
      ).resolves.toEqual({ renewed: true });
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });

  test("without renewal the lease lapses: a working owner is stealable after 5m30s", async () => {
    // Documents the pre-renewal window the pump used to run in: nothing ever
    // renewed, so every owner — actively pumping or not — forfeited the
    // profile LEASE_MS + GRACE_MS after its claim. The renew RPC + heartbeat
    // exist to close exactly this window; this test pins the underlying
    // lease semantics that make the heartbeat necessary.
    let clock = 1_000_000;
    const { built, client, server } = await rpcFixture({ now: () => clock });
    try {
      const claim = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      expect(claim.result.kind).toBe("claimed");
      clock += LEASE_MS + GRACE_MS + 1_000; // no heartbeat exists in this test
      const steal = (await client.request("profile.claim", CLAIM_PANE_Y)) as {
        result: { kind: string; leaseToken: string };
      };
      expect(steal.result.kind).toBe("reclaimed");
      // The displaced owner's capability is gone with the row.
      await expect(
        client.request("profile.release", {
          leaseToken: claim.result.leaseToken,
          profileId: "driffs",
        }),
      ).resolves.toEqual({ released: false });
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });

  test("a rejected claim and profile.owner never carry the live owner's lease token", async () => {
    const clock = 1_000_000;
    const { built, client, server } = await rpcFixture({ now: () => clock });
    try {
      const claim = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      expect(claim.result.kind).toBe("claimed");
      const ownerToken = claim.result.leaseToken;
      // A rejected claimant is told WHO owns the profile, never the
      // capability: release() authenticates on the token alone, so leaking
      // it to any subscriber would let a rejected claimant evict the owner.
      const rejected = (await client.request("profile.claim", CLAIM_PANE_Y)) as {
        result: unknown;
      };
      expect(JSON.stringify(rejected)).not.toContain(ownerToken);
      expect(rejected.result).toMatchObject({
        kind: "rejected",
        reason: "lease_active",
        owner: {
          paneId: "wX:p1",
          harnessKind: "pi",
          terminalId: "tX",
        },
      });
      // The owner query is reachable by every daemon client — same rule.
      const owner = (await client.request("profile.owner", { profileId: "driffs" })) as {
        owner: unknown;
      };
      expect(JSON.stringify(owner)).not.toContain(ownerToken);
      expect(owner.owner).toMatchObject({ paneId: "wX:p1", harnessKind: "pi" });
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });

  test("the A2-2 attack: the leaked subscriberId must not mint a token one step removed", async () => {
    let clock = 1_000_000;
    const { built, client, server } = await rpcFixture({ now: () => clock });
    try {
      const claim = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      expect(claim.result.kind).toBe("claimed");

      // The public owner row is the disclosure round 2 stopped at; the F3-1
      // review then showed BOTH halves of the old identity credential are
      // reconstructible from public RPC (agent.list serves the session ref;
      // the subscriber is parseable from it). Identity therefore proves
      // nothing: a claim without the daemon-minted token is a rival claim,
      // whatever halves it re-presents.
      const spoof = (await client.request("profile.claim", {
        ...CLAIM_PANE_Y,
        subscriberId: CLAIM_PANE_X.subscriberId,
        harnessSessionRefJson: '{"steal":true}',
      })) as { result: { kind: string; leaseToken?: string } };
      expect(spoof.result).toMatchObject({ kind: "rejected", reason: "lease_active" });
      expect(spoof.result.leaseToken).toBeUndefined();
      // ...and the owner was not evicted: its own heartbeat still works.
      await expect(
        client.request("profile.renew", {
          leaseToken: claim.result.leaseToken,
          profileId: "driffs",
        }),
      ).resolves.toEqual({ renewed: true });

      // The legitimate reconnect path (the holder presenting the token it
      // still holds) must keep working mid-lease.
      clock += 60_000;
      const reconnect = (await client.request("profile.claim", {
        ...CLAIM_PANE_X,
        currentLeaseToken: claim.result.leaseToken,
      })) as {
        result: { kind: string; leaseToken: string };
      };
      expect(reconnect.result.kind).toBe("reclaimed");
      expect(reconnect.result.leaseToken).toBeTruthy();
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });

  test("profile.owner and a rejected claim never disclose the owner's subscriberId", async () => {
    const clock = 1_000_000;
    const { built, client, server } = await rpcFixture({ now: () => clock });
    try {
      const claim = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      expect(claim.result.kind).toBe("claimed");
      const rejected = (await client.request("profile.claim", CLAIM_PANE_Y)) as {
        result: { kind: string; owner?: Record<string, unknown> };
      };
      expect(rejected.result).toMatchObject({
        kind: "rejected",
        reason: "lease_active",
        owner: { paneId: "wX:p1", harnessKind: "pi", terminalId: "tX" },
      });
      // The subscriberId and the harness session ref together are the
      // re-claim credential (A2-2); neither is display data the extension
      // reads, and neither is public surface.
      expect(JSON.stringify(rejected)).not.toContain(CLAIM_PANE_X.subscriberId);
      expect(rejected.result.owner).not.toHaveProperty("subscriberId");
      expect(rejected.result.owner).not.toHaveProperty("harnessSessionRefJson");
      const owner = (await client.request("profile.owner", { profileId: "driffs" })) as {
        owner: Record<string, unknown> | null;
      };
      expect(JSON.stringify(owner)).not.toContain(CLAIM_PANE_X.subscriberId);
      expect(JSON.stringify(owner)).not.toContain("harnessSessionRefJson");
      expect(owner.owner).toMatchObject({ paneId: "wX:p1", harnessKind: "pi" });
      expect(owner.owner).not.toHaveProperty("subscriberId");
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });

  test("the holder's own claim and re-claim still return a lease token", async () => {
    let clock = 1_000_000;
    const { built, client, server } = await rpcFixture({ now: () => clock });
    try {
      const claim = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      expect(claim.result.kind).toBe("claimed");
      expect(claim.result.leaseToken).toBeTruthy();
      // The re-claim (the reconnect path) rotates the token and hands the
      // NEW one back: it is the claimer's own credential. The daemon-minted
      // token is the re-claim proof now — identity halves alone no longer
      // take the fast path.
      clock += 60_000;
      const reclaimed = (await client.request("profile.claim", {
        ...CLAIM_PANE_X,
        currentLeaseToken: claim.result.leaseToken,
      })) as {
        result: { kind: string; leaseToken: string };
      };
      expect(reclaimed.result.kind).toBe("reclaimed");
      expect(reclaimed.result.leaseToken).toBeTruthy();
      expect(reclaimed.result.leaseToken).not.toBe(claim.result.leaseToken);
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });

  test("a claim presenting a stale lease token is refused while the lease is alive", async () => {
    // Possession of the CURRENT token is the proof; possession of a
    // superseded one is evidence of exactly nothing.
    let clock = 1_000_000;
    const { built, client, server } = await rpcFixture({ now: () => clock });
    try {
      const first = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      clock += 60_000;
      const second = (await client.request("profile.claim", {
        ...CLAIM_PANE_X,
        currentLeaseToken: first.result.leaseToken,
      })) as {
        result: { kind: string; leaseToken: string };
      };
      expect(second.result.kind).toBe("reclaimed");
      clock += 60_000;
      const stale = (await client.request("profile.claim", {
        ...CLAIM_PANE_X,
        currentLeaseToken: first.result.leaseToken,
      })) as { result: { kind: string; leaseToken?: string } };
      expect(stale.result).toMatchObject({ kind: "rejected", reason: "lease_active" });
      expect(stale.result.leaseToken).toBeUndefined();
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });
});

describe("the F3-1 takeover chain (round-3 review)", () => {
  // A Pi owner's real re-claim credential: the session ref it registers on
  // its agent row (agent.orchestrator.register in production), and the
  // subscriber id embedded in the session file name (a uuidv7 — no
  // underscores, so parsing is unambiguous).
  const OWNER_SESSION_PATH =
    "/home/user/.pi/agent/sessions/2026-09-11T17-36-21-123Z_7c9e667f-2c33-4d0f-9a31-9e44c2f1b7a3.jsonl";
  const PI_SESSION_REF = {
    agent: "pi",
    kind: "path",
    source: "herdr:pi",
    value: OWNER_SESSION_PATH,
  } as const;
  const OWNER_SUBSCRIBER_ID = "7c9e667f-2c33-4d0f-9a31-9e44c2f1b7a3";

  test("the full attack: both halves reconstructed from public RPC must not mint a token", async () => {
    const { built, client, server } = await rpcFixture();
    try {
      // The owner is a real Pi: its agent row carries its session ref, and
      // it claims with the matching halves.
      built.agents.setSessionRefByTerminal({
        agentSession: PI_SESSION_REF,
        herdrSessionName: "default",
        terminalId: "tB",
      });
      const claim = (await client.request("profile.claim", {
        harnessKind: "pi",
        harnessSessionRefJson: JSON.stringify(PI_SESSION_REF),
        herdrSessionName: "default",
        paneId: "wB:p1",
        profileId: "driffs",
        subscriberId: OWNER_SUBSCRIBER_ID,
        terminalId: "tB",
      })) as { result: { kind: string; leaseToken: string } };
      expect(claim.result.kind).toBe("claimed");
      const ownerToken = claim.result.leaseToken;

      // ── The attacker, holding no credential: two unauthenticated reads. ──
      // Step 1: profile.owner names the owner's pane — the credential-free
      // pointer that aims the attacker at the right agent row.
      const owner = (await client.request("profile.owner", { profileId: "driffs" })) as {
        owner: { paneId: string } | null;
      };
      expect(owner.owner?.paneId).toBe("wB:p1");
      // Step 2: agent.list serves that row's session ref verbatim — half #2.
      const list = (await client.request("agent.list", { all: true })) as {
        agents: Array<{
          agentSession: {
            agent: string;
            kind: string;
            source: string;
            value: string;
          } | null;
          paneId: string;
        }>;
      };
      const row = list.agents.find((agent) => agent.paneId === owner.owner?.paneId);
      if (!row?.agentSession) throw new Error("attack setup: owner row carried no session ref");
      const reconstructedRef = JSON.stringify(row.agentSession);
      expect(reconstructedRef).toBe(JSON.stringify(PI_SESSION_REF));
      // Step 3: the Pi session file name embeds the session id — half #1.
      const derived = /([0-9a-f-]{36})\.jsonl$/.exec(row.agentSession.value)?.[1];
      expect(derived).toBe(OWNER_SUBSCRIBER_ID);

      // Step 4: re-present both halves with the attacker's own pane. Under
      // identity equality this minted a fresh valid token over the live
      // lease. Identity is public by design; only the daemon-minted token
      // the owner holds may take the fast path.
      const takeover = (await client.request("profile.claim", {
        harnessKind: "pi",
        harnessSessionRefJson: reconstructedRef,
        herdrSessionName: "default",
        paneId: "wE:p9",
        profileId: "driffs",
        subscriberId: derived,
        terminalId: "tE",
      })) as { result: { kind: string; leaseToken?: string } };
      expect(takeover.result).toMatchObject({ kind: "rejected", reason: "lease_active" });
      expect(takeover.result.leaseToken).toBeUndefined();

      // The payoff that made the chain worth reproducing: the attacker
      // released the profile with its minted token and evicted the owner.
      // The real owner's capability must survive untouched.
      await expect(
        client.request("profile.renew", { leaseToken: ownerToken, profileId: "driffs" }),
      ).resolves.toEqual({ renewed: true });
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });

  test("the inbox.list variant: the delivered turn id must not complete the credential", async () => {
    // The shorter chain: inbox.list served deliveredHarnessTurnId, which the
    // Pi extension filled with state.subscriberId — half #1 with no path
    // parsing. Combined with the agent.list half #2 it minted a token. The
    // turn id is the owner's own bookkeeping correlation, not reader data.
    const { built, client, server } = await rpcFixture();
    try {
      const claim = (await client.request("profile.claim", {
        harnessKind: "pi",
        harnessSessionRefJson: JSON.stringify(PI_SESSION_REF),
        herdrSessionName: "default",
        paneId: "wB:p1",
        profileId: "driffs",
        subscriberId: OWNER_SUBSCRIBER_ID,
        terminalId: "tB",
      })) as { result: { kind: string; leaseToken: string } };
      const ownerToken = claim.result.leaseToken;
      const worker = built.agents.list().find((row) => row.name === "driffs-worker");
      if (!worker) throw new Error("fixture: driffs-worker missing");
      built.delivery.projectAgentEvent({
        ...eventFor({ eventId: 81, worker: "driffs" }),
        agentId: worker.id,
      });
      const lease = (await client.request("inbox.lease", {
        leaseToken: ownerToken,
        profileId: "driffs",
      })) as { obligations: Array<{ id: string }> };
      const leasedId = lease.obligations[0]?.id;
      if (!leasedId) throw new Error("fixture: lease returned no rows");
      await client.request("inbox.delivered", {
        harnessTurnId: OWNER_SUBSCRIBER_ID,
        ids: [leasedId],
        leaseToken: ownerToken,
        ownerSessionRefJson: JSON.stringify(PI_SESSION_REF),
      });

      const list = (await client.request("inbox.list", { profileId: "driffs" })) as {
        obligations: Array<{ deliveredHarnessTurnId: string | null }>;
      };
      // No row the tokenless read serves may carry the owner's correlation.
      for (const obligation of list.obligations) {
        expect(obligation.deliveredHarnessTurnId ?? null).toBeNull();
      }
      expect(JSON.stringify(list)).not.toContain(OWNER_SUBSCRIBER_ID);

      // Even the old unredacted wire value would no longer complete the
      // credential: half #1 plus the public half #2 must not mint a token.
      const takeover = (await client.request("profile.claim", {
        harnessKind: "pi",
        harnessSessionRefJson: JSON.stringify(PI_SESSION_REF),
        herdrSessionName: "default",
        paneId: "wE:p9",
        profileId: "driffs",
        subscriberId: OWNER_SUBSCRIBER_ID,
        terminalId: "tE",
      })) as { result: { kind: string; leaseToken?: string } };
      expect(takeover.result).toMatchObject({ kind: "rejected", reason: "lease_active" });
      expect(takeover.result.leaseToken).toBeUndefined();
    } finally {
      client.close();
      await server.stop();
      built.sqlite.close();
    }
  });
});

describe("startup lease-stamp invalidation (F3-2)", () => {
  test("pre-upgrade lease stamps die at daemon startup; rows return to pending, never dropped", () => {
    const { agents, delivery, obligations } = fixture();
    const worker = agents.list().find((row) => row.name === "driffs-worker");
    if (!worker) throw new Error("fixture: driffs-worker missing");
    for (const eventId of [91, 92]) {
      delivery.projectAgentEvent({
        ...eventFor({ eventId, worker: "driffs" }),
        agentId: worker.id,
      });
    }
    const batch = delivery.inboxList({ profileId: "driffs", state: "pending" });
    const ids = batch.map((row) => row.id);
    expect(ids).toHaveLength(2);

    // Simulate the pre-G3 database this build upgrades: the old unfenced
    // inbox.lease let ANY token stamp rows. One row got "delivered" under
    // that token; nothing was acked.
    const legacyToken = "attacker-token-from-old-build";
    const leased = obligations.leaseBatch({
      expiresAt: Date.now() + 2 * 60_000,
      ids,
      leaseToken: legacyToken,
      profileId: "driffs",
    });
    expect(leased).toBe(2);
    expect(
      obligations.markDelivered({
        ids: [ids[0] as string],
        leaseToken: legacyToken,
        ownerSessionRefJson: "{}",
      }),
    ).toBe(1);

    // The one-time startup invalidation clears every stamp: no pre-upgrade
    // token survives the upgrade, so it can no longer ack rows away and
    // suppress the user's wakes.
    expect(obligations.invalidateAllLeases()).toEqual({ invalidated: 2 });
    const rows = delivery.inboxList({ profileId: "driffs" });
    expect(rows.map((row) => row.state)).toEqual(["pending", "pending"]);
    for (const row of rows) {
      expect(row.leaseToken ?? null).toBeNull();
      expect(row.leaseExpiresAt ?? null).toBeNull();
      // Attempts are preserved, not reset: the bounded-attempts cap still
      // bounds. The rows are re-deliverable, never silently dropped.
      expect(row.attemptCount).toBe(1);
    }

    // The legacy token is dead: it acks nothing.
    expect(delivery.inboxAck({ ids, leaseToken: legacyToken, profileId: "driffs" })).toEqual({
      acked: 0,
      rejected: ids,
    });

    // And the rows are back in circulation for the legitimate owner.
    const claim = delivery.claim({
      harnessKind: "pi",
      harnessSessionRefJson: "{}",
      herdrSessionName: "default",
      paneId: "wX:p1",
      profileId: "driffs",
      subscriberId: "sub-1",
      terminalId: "tX",
    });
    if (claim.kind !== "claimed") throw new Error("claim failed");
    const redelivered = delivery.inboxLease({ leaseToken: claim.leaseToken, profileId: "driffs" });
    expect(redelivered.obligations.map((row) => row.agentEventId)).toEqual([91, 92]);
  });

  test("invalidation is a no-op on a database with no live stamps", () => {
    const { obligations } = fixture();
    expect(obligations.invalidateAllLeases()).toEqual({ invalidated: 0 });
  });
});

describe("shepy profile owner CLI verb (operator surface)", () => {
  test("prints the owning pane, workspace, and local lease expiry, never the token", async () => {
    const { built, client, server } = await rpcFixture();
    try {
      const claim = (await client.request("profile.claim", CLAIM_PANE_X)) as {
        result: { kind: string; leaseToken: string };
      };
      expect(claim.result.kind).toBe("claimed");
      const leaseToken = claim.result.leaseToken;
      expect(leaseToken).toBeTruthy();

      const socketPath = join(dirname(built.path), "rpc.sock");
      // runCliCommand closes its client in a finally — every call gets its
      // own connection; the fixture client stays free for RPC assertions.
      const runOwnerCli = async (json: boolean): Promise<string[]> => {
        const lines: string[] = [];
        await runCliCommand(
          { command: "profile-owner", json, profileId: "driffs" },
          {
            connect: () => RpcTestClient.connect(socketPath),
            output: (line) => lines.push(line),
            socketPath,
          },
        );
        return lines;
      };

      const text = (await runOwnerCli(false)).join("\n");
      expect(text).toContain("profile: driffs");
      expect(text).toContain("owner: wX:p1 (pi)");
      expect(text).toContain("session: default");
      expect(text).toMatch(/lease valid for \d+m\d+s/);
      expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
      // The stripping is the security fix; the CLI must not reintroduce it.
      expect(text).not.toContain(leaseToken);
      expect(text).not.toContain("sub-1");
      expect(text).not.toContain("harnessSessionRefJson");

      const jsonText = (await runOwnerCli(true)).join("\n");
      expect(JSON.parse(jsonText)).toEqual({
        owner: expect.objectContaining({ paneId: "wX:p1", profileId: "driffs" }),
      });
      expect(jsonText).not.toContain(leaseToken);
      expect(jsonText).not.toContain("sub-1");
    } finally {
      client.close();
      await server.stop();
    }
  });

  test("an unowned profile says so clearly and exits 0", async () => {
    const { built, client, server } = await rpcFixture();
    try {
      const socketPath = join(dirname(built.path), "rpc.sock");
      const runOwnerCli = async (json: boolean): Promise<string[]> => {
        const lines: string[] = [];
        await runCliCommand(
          { command: "profile-owner", json, profileId: "other" },
          {
            connect: () => RpcTestClient.connect(socketPath),
            output: (line) => lines.push(line),
            socketPath,
          },
        );
        return lines;
      };

      const text = (await runOwnerCli(false)).join("\n");
      expect(text).toContain("other has no owner");
      expect(text).toContain("claimable");

      expect(JSON.parse((await runOwnerCli(true)).join("\n"))).toEqual({ owner: null });
    } finally {
      client.close();
      await server.stop();
    }
  });
});

describe("selector ambiguity is fail-closed on BOTH paths (§7, §6.1.3)", () => {
  const WORKER_CWD = "/Users/ray/dev/driffs";

  /**
   * Real RPC server + real ProfileService + real ProfileDeliveryService over
   * one real migrated SQLite file. Two pi workers share the exact session
   * ("default") and workspace ("wA") — identical agent kind and cwd, distinct
   * panes — plus a cross-session decoy in session "other" holding the SAME
   * workspace id and the SAME name/kind/cwd as the first worker (the §6.1.2
   * expansion trap).
   */
  async function ambiguityRpcFixture(input: {
    agentSelector: AgentSelector;
    workerNames?: [string, string];
  }) {
    const dir = mkdtempSync(join(tmpdir(), "shepy-ambiguity-"));
    tempDirs.push(dir);
    const path = join(dir, "test.sqlite");
    const { sqlite } = openSqlite(path);
    applyMigrations(sqlite, { migrationsFolder: "drizzle" });
    const sessions = new HerdrSessionStore(sqlite);
    const agents = new AgentStore(sqlite);
    sessions.upsertRunning({ name: "default", sessionDir: "/tmp/a", socketPath: "/tmp/a.sock" });
    sessions.upsertRunning({ name: "other", sessionDir: "/tmp/b", socketPath: "/tmp/b.sock" });
    const workerNames = input.workerNames ?? ["worker-a", "worker-b"];
    agents.replaceForSession({
      agents: [
        {
          agent: "pi",
          agent_status: "idle",
          cwd: WORKER_CWD,
          focused: false,
          name: workerNames[0],
          pane_id: "wA:p1",
          terminal_id: "tA1",
          workspace_id: "wA",
        },
        {
          agent: "pi",
          agent_status: "idle",
          cwd: WORKER_CWD,
          focused: false,
          name: workerNames[1],
          pane_id: "wA:p2",
          terminal_id: "tA2",
          workspace_id: "wA",
        },
      ],
      herdrSessionName: "default",
    });
    agents.replaceForSession({
      agents: [
        {
          agent: "pi",
          agent_status: "idle",
          cwd: WORKER_CWD,
          focused: false,
          name: workerNames[0],
          pane_id: "wA:p1",
          terminal_id: "tZ",
          workspace_id: "wA",
        },
      ],
      herdrSessionName: "other",
    });
    const profiles = new OrchestratorProfileStore(sqlite);
    profiles.createProfile({ displayName: "Driffs", profileId: "driffs", projectRoots: [] });
    profiles.addSubscription({
      agentSelectorJson: JSON.stringify(input.agentSelector),
      herdrSessionName: "default",
      profileId: "driffs",
      workspaceSelectorJson: JSON.stringify({ herdrSession: "default", workspaceId: "wA" }),
    });
    const agentEvents = new AgentEventStore(sqlite);
    const delivery = new ProfileDeliveryService({
      agentEvents,
      agents,
      obligations: new DeliveryObligationStore(sqlite),
      owners: new ProfileOwnerStore({ sqlite }),
      profiles,
    });
    const history = createAgentHistoryService({
      cache: new AgentHistoryCacheStore(sqlite),
      homeDir: dir,
    });
    const profileService = new ProfileService({ agents, history, profiles });
    const context = new AgentContextService({
      history,
      stores: {
        agentContextSnapshots: new AgentContextSnapshotStore(sqlite),
        agents,
      },
    });
    const orchestrator = new AgentOrchestratorService({
      agentEvents,
      agents,
      scopes: new AgentOrchestratorScopeStore(sqlite),
    });
    const socketPath = join(dir, "rpc.sock");
    const server = new ObservabilityRpcServer({
      context,
      delivery,
      history,
      orchestrator,
      profiles: profileService,
      socketPath,
      stores: {
        agentEvents,
        agents,
        herdrSessions: sessions,
        herdrWorkspaces: new HerdrWorkspaceStore(sqlite),
      },
    });
    await server.start();
    const client = await RpcTestClient.connect(socketPath);
    return { agentEvents, agents, client, delivery, profileService, server, sqlite };
  }

  function appendDoneEvent(input: {
    agentEvents: AgentEventStore;
    key: string;
    row: AgentIndexRecord;
  }): AgentEventRecord {
    return input.agentEvents.append({
      agentId: input.row.id,
      compactHistory: null,
      herdrSessionName: input.row.herdrSessionName,
      idempotencyKey: input.key,
      paneId: input.row.paneId,
      payload: { agent: input.row.agent, from: "working", name: input.row.name, to: "done" },
      type: "agent.done",
      workspaceId: input.row.workspaceId,
    });
  }

  function workersOf(built: Awaited<ReturnType<typeof ambiguityRpcFixture>>) {
    const rows = built.agents.list({ herdrSessionName: "default" });
    const first = rows.find((row) => row.paneId === "wA:p1");
    const second = rows.find((row) => row.paneId === "wA:p2");
    if (!first || !second) throw new Error("fixture: scoped workers missing");
    return { first, second };
  }

  async function inboxSize(built: Awaited<ReturnType<typeof ambiguityRpcFixture>>) {
    const list = (await built.client.request("inbox.list", { profileId: "driffs" })) as {
      obligations: unknown[];
    };
    return list.obligations.length;
  }

  async function resolutionKinds(built: Awaited<ReturnType<typeof ambiguityRpcFixture>>) {
    const show = (await built.client.request("profile.show", { profileId: "driffs" })) as {
      resolutions: Array<{ kind: string }>;
    };
    return show.resolutions.map((resolution) => resolution.kind);
  }

  test("the reviewer's case: two identical workers + runtimeKindPlusCwd — inspection says ambiguous, delivery projects NOTHING", async () => {
    const built = await ambiguityRpcFixture({
      agentSelector: { kind: "runtimeKindPlusCwd", agent: "pi", cwd: WORKER_CWD },
    });
    try {
      // Inspection path (already §7-correct): the selector is ambiguous.
      await expect(resolutionKinds(built)).resolves.toEqual(["ambiguous"]);

      // Delivery path (the defect): whichever worker finishes, the selector
      // is ambiguous in this scope, so NOTHING may project.
      const { first, second } = workersOf(built);
      built.delivery.projectAgentEvent(
        appendDoneEvent({ agentEvents: built.agentEvents, key: "done-first", row: first }),
      );
      built.delivery.projectAgentEvent(
        appendDoneEvent({ agentEvents: built.agentEvents, key: "done-second", row: second }),
      );
      await expect(inboxSize(built)).resolves.toBe(0);
    } finally {
      built.client.close();
      await built.server.stop();
      built.sqlite.close();
    }
  });

  test("two live workers sharing one name: inspection says ambiguous, delivery projects NOTHING", async () => {
    // Executable evidence that the index admits duplicate live names: the
    // agents table constrains (session, pane) and (session, terminal) but
    // nothing constrains name — so a name selector can be genuinely
    // ambiguous and must fail closed on both paths.
    const built = await ambiguityRpcFixture({
      agentSelector: { kind: "name", value: "worker" },
      workerNames: ["worker", "worker"],
    });
    try {
      await expect(resolutionKinds(built)).resolves.toEqual(["ambiguous"]);
      const { first, second } = workersOf(built);
      built.delivery.projectAgentEvent(
        appendDoneEvent({ agentEvents: built.agentEvents, key: "done-first", row: first }),
      );
      built.delivery.projectAgentEvent(
        appendDoneEvent({ agentEvents: built.agentEvents, key: "done-second", row: second }),
      );
      await expect(inboxSize(built)).resolves.toBe(0);
    } finally {
      built.client.close();
      await built.server.stop();
      built.sqlite.close();
    }
  });

  test("a unique match naming worker-a never projects worker-b's event", async () => {
    const built = await ambiguityRpcFixture({
      agentSelector: { kind: "name", value: "worker-a" },
    });
    try {
      // The selector resolves uniquely — to worker-a.
      await expect(resolutionKinds(built)).resolves.toEqual(["matched"]);
      // worker-b completing must not ride worker-a's subscription, even
      // though worker-b alone would satisfy nothing else about the scope.
      const { second } = workersOf(built);
      built.delivery.projectAgentEvent(
        appendDoneEvent({ agentEvents: built.agentEvents, key: "done-b", row: second }),
      );
      await expect(inboxSize(built)).resolves.toBe(0);
    } finally {
      built.client.close();
      await built.server.stop();
      built.sqlite.close();
    }
  });

  test("happy path survives: one unique in-scope match from the emitting agent projects exactly one obligation", async () => {
    const built = await ambiguityRpcFixture({
      agentSelector: { kind: "name", value: "worker-a" },
    });
    try {
      await expect(resolutionKinds(built)).resolves.toEqual(["matched"]);
      const { first } = workersOf(built);
      const stored = appendDoneEvent({
        agentEvents: built.agentEvents,
        key: "done-a",
        row: first,
      });
      built.delivery.projectAgentEvent(stored);
      const pending = (await built.client.request("inbox.list", {
        profileId: "driffs",
        state: "pending",
      })) as { obligations: Array<{ agentEventId: number }> };
      expect(pending.obligations).toHaveLength(1);
      expect(pending.obligations[0]?.agentEventId).toBe(stored.id);
    } finally {
      built.client.close();
      await built.server.stop();
      built.sqlite.close();
    }
  });

  test("cross-session same-workspace-id stays excluded on the delivery path", async () => {
    // The decoy in session "other" shares worker-a's name, kind, cwd AND
    // workspace id "wA" — only the Herdr session differs. Its completion
    // must never satisfy the session-"default" subscription; the same-named
    // worker in the subscribed session still projects.
    const built = await ambiguityRpcFixture({
      agentSelector: { kind: "name", value: "worker-a" },
    });
    try {
      const decoy = built.agents
        .list({ herdrSessionName: "other" })
        .find((row) => row.herdrSessionName === "other");
      if (!decoy) throw new Error("fixture: cross-session decoy missing");
      built.delivery.projectAgentEvent(
        appendDoneEvent({ agentEvents: built.agentEvents, key: "done-decoy", row: decoy }),
      );
      await expect(inboxSize(built)).resolves.toBe(0);

      const { first } = workersOf(built);
      const stored = appendDoneEvent({
        agentEvents: built.agentEvents,
        key: "done-default",
        row: first,
      });
      built.delivery.projectAgentEvent(stored);
      const pending = (await built.client.request("inbox.list", {
        profileId: "driffs",
        state: "pending",
      })) as { obligations: unknown[] };
      expect(pending.obligations).toHaveLength(1);
    } finally {
      built.client.close();
      await built.server.stop();
      built.sqlite.close();
    }
  });
});
