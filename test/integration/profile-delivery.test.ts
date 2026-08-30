import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AgentEventStore } from "@/db/agent-events.js";
import { AgentStore } from "@/db/agents.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { DeliveryObligationStore, MAX_DELIVERY_ATTEMPTS } from "@/db/delivery-obligations.js";
import { HerdrSessionStore } from "@/db/herdr-sessions.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { ProfileOwnerStore } from "@/db/profile-owners.js";
import type { AgentEventRecord } from "@/observability/contracts.js";
import { ProfileDeliveryService } from "@/observability/profile-delivery-service.js";

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
  const delivery = new ProfileDeliveryService({ agents, obligations, owners, profiles });
  const agentEvents = new AgentEventStore(sqlite);
  return { agentEvents, agents, delivery, obligations, owners, profiles, sqlite };
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
    type: "agent.status.changed",
    workspaceId: input.worker === "driffs" ? "wA" : "wB",
  };
}

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
    // to pending at the attempt cap, then dead-letters.
    delivery.inboxLease({ leaseToken: "sweep-trigger", now: clock, profileId: "driffs" });
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
