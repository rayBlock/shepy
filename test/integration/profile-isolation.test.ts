import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentHistoryService } from "@/agent-history/service.js";
import { AgentStore } from "@/db/agents.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { HerdrSessionStore } from "@/db/herdr-sessions.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { ProfileService } from "@/observability/profile-service.js";

/**
 * Phase 2 gate (vault §16): "A Driffs profile in one workspace can query
 * only its exact worker in another workspace. An unrelated worker event is
 * structurally absent."
 *
 * Proves the §6.1 isolation invariants against a REAL migrated SQLite DB:
 * two profiles, one shared Herdr session, an unrelated third workspace, and
 * a decoy same-workspace-id in a SECOND Herdr session with an identically
 * named agent — the cross-session expansion trap.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "shepy-profiles-"));
  tempDirs.push(dir);
  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const sessions = new HerdrSessionStore(sqlite);
  const agents = new AgentStore(sqlite);
  sessions.upsertRunning({ name: "default", sessionDir: "/tmp/a", socketPath: "/tmp/a.sock" });
  sessions.upsertRunning({ name: "other", sessionDir: "/tmp/b", socketPath: "/tmp/b.sock" });

  const history = {
    resolveCompactHistory: async (input: { agent: string | null }) => ({
      compactHistory: { lastUser: `history-of-${input.agent ?? "unknown"}` },
      historyRef: null,
    }),
  } as unknown as AgentHistoryService;

  const service = new ProfileService({
    agents,
    history,
    profiles: new OrchestratorProfileStore(sqlite),
  });

  // Two worker workspaces in the shared session + one unrelated workspace.
  seedAgents(agents, [
    {
      agent: "hermes",
      name: "driffs-worker",
      paneId: "wA:p1",
      terminalId: "tA",
      workspaceId: "wA",
    },
    { agent: "hermes", name: "stick-worker", paneId: "wB:p1", terminalId: "tB", workspaceId: "wB" },
    { agent: "pi", name: null, paneId: "wU:p1", terminalId: "tU", workspaceId: "wU" },
  ]);
  // The cross-session decoy: SAME workspace id, SAME agent name, DIFFERENT
  // Herdr session.
  seedAgents(agents, [
    {
      agent: "hermes",
      herdrSession: "other",
      name: "driffs-worker",
      paneId: "wA:p1",
      terminalId: "tA2",
      workspaceId: "wA",
    },
  ]);

  return { agents, service, sqlite };
}

function seedAgents(
  store: AgentStore,
  rows: Array<{
    agent: string;
    herdrSession?: string;
    name: string | null;
    paneId: string;
    terminalId: string | null;
    workspaceId: string;
  }>,
) {
  const bySession = new Map<string, typeof rows>();
  for (const row of rows) {
    const session = row.herdrSession ?? "default";
    const bucket = bySession.get(session) ?? [];
    bucket.push(row);
    bySession.set(session, bucket);
  }
  for (const [session, bucket] of bySession) {
    store.replaceForSession({
      agents: bucket.map((row) => ({
        agent: row.agent,
        agent_status: "idle",
        cwd: `/Users/ray/dev/${row.workspaceId.toLowerCase()}`,
        focused: false,
        name: row.name,
        pane_id: row.paneId,
        terminal_id: row.terminalId,
        workspace_id: row.workspaceId,
      })),
      herdrSessionName: session,
    });
  }
}

describe("Phase 2 gate — strict two-profile isolation", () => {
  test("each profile resolves ONLY its exact subscribed worker", async () => {
    const { service } = fixture();
    service.ensureProfile({
      displayName: "Driffs",
      profileId: "driffs",
      projectRoots: ["/Users/ray/dev/driffs"],
    });
    service.ensureProfile({
      displayName: "Stickman",
      profileId: "stickman",
      projectRoots: ["/Users/ray/dev/stickman-arena"],
    });
    service.addSubscription({
      agentSelector: { kind: "name", value: "driffs-worker" },
      herdrSessionName: "default",
      profileId: "driffs",
      workspaceId: "wA",
    });
    service.addSubscription({
      agentSelector: { kind: "name", value: "stick-worker" },
      herdrSessionName: "default",
      profileId: "stickman",
      workspaceId: "wB",
    });

    const driffs = await service.profileContext("driffs");
    const stickman = await service.profileContext("stickman");
    expect(driffs?.agents.map((agent) => agent.name)).toEqual(["driffs-worker"]);
    expect(stickman?.agents.map((agent) => agent.name)).toEqual(["stick-worker"]);
    // Bounded history comes from the matched agent only.
    expect(driffs?.agents[0]?.compactHistory).toMatchObject({ lastUser: "history-of-hermes" });
  });

  test("an unrelated worker is structurally absent from every profile surface", async () => {
    const { service } = fixture();
    service.ensureProfile({ displayName: "Driffs", profileId: "driffs", projectRoots: [] });
    service.addSubscription({
      agentSelector: { kind: "name", value: "driffs-worker" },
      herdrSessionName: "default",
      profileId: "driffs",
      workspaceId: "wA",
    });
    const context = await service.profileContext("driffs");
    const serialized = JSON.stringify(context);
    // The unrelated wU agent never enters context, resolutions, or history.
    expect(serialized).not.toContain("wU");
    // And no resolution references any agent outside wA.
    for (const resolution of context?.resolutions ?? []) {
      if (resolution.kind === "matched") expect(resolution.agent.workspaceId).toBe("wA");
    }
  });

  test("same workspace id in another Herdr session is never a candidate", async () => {
    const { service } = fixture();
    service.ensureProfile({ displayName: "Driffs", profileId: "driffs", projectRoots: [] });
    service.addSubscription({
      agentSelector: { kind: "name", value: "driffs-worker" },
      herdrSessionName: "default",
      profileId: "driffs",
      workspaceId: "wA",
    });
    const context = await service.profileContext("driffs");
    // Exactly one match — the "other"-session decoy with the same name and
    // workspace id must be invisible, otherwise this would be ambiguous.
    expect(context?.resolutions.filter((resolution) => resolution.kind === "matched")).toHaveLength(
      1,
    );
  });

  test("ambiguous selectors fail closed instead of guessing", async () => {
    const { service, agents } = fixture();
    // Re-seed the whole default session with TWO driffs-workers in the same
    // scope (replaceForSession is a full-session replace, so both rows must
    // ride one call).
    seedAgents(agents, [
      {
        agent: "hermes",
        name: "driffs-worker",
        paneId: "wA:p1",
        terminalId: "tA",
        workspaceId: "wA",
      },
      {
        agent: "hermes",
        name: "driffs-worker",
        paneId: "wA:p2",
        terminalId: "tA3",
        workspaceId: "wA",
      },
    ]);
    service.ensureProfile({ displayName: "Driffs", profileId: "driffs", projectRoots: [] });
    service.addSubscription({
      agentSelector: { kind: "name", value: "driffs-worker" },
      herdrSessionName: "default",
      profileId: "driffs",
      workspaceId: "wA",
    });
    const context = await service.profileContext("driffs");
    const resolutions = context?.resolutions ?? [];
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.kind).toBe("ambiguous");
    expect(context?.agents).toHaveLength(0);
  });

  test("unmatched selector reports, never matches cross-workspace", async () => {
    const { service } = fixture();
    service.ensureProfile({ displayName: "Driffs", profileId: "driffs", projectRoots: [] });
    service.addSubscription({
      agentSelector: { kind: "name", value: "stick-worker" },
      herdrSessionName: "default",
      profileId: "driffs",
      workspaceId: "wA",
    });
    const context = await service.profileContext("driffs");
    expect(context?.resolutions[0]?.kind).toBe("unmatched");
    expect(context?.agents).toHaveLength(0);
  });

  test("subscribe/unsubscribe identity round-trip", () => {
    const { service } = fixture();
    service.ensureProfile({ displayName: "Driffs", profileId: "driffs", projectRoots: [] });
    const selector = { kind: "name" as const, value: "driffs-worker" };
    service.addSubscription({
      agentSelector: selector,
      herdrSessionName: "default",
      profileId: "driffs",
      workspaceId: "wA",
    });
    expect(service.listSubscriptions("driffs")).toHaveLength(1);
    const { removed } = service.removeSubscription({
      agentSelector: selector,
      herdrSessionName: "default",
      profileId: "driffs",
      workspaceId: "wA",
    });
    expect(removed).toBe(true);
    expect(service.listSubscriptions("driffs")).toHaveLength(0);
  });
});
