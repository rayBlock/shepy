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
import { resolveDispatchTarget } from "@/observability/operation-target-resolver.js";
import { ProfileService } from "@/observability/profile-service.js";

/**
 * Task 3 integration — the resolver against the REAL ProfileService +
 * AgentStore scope path: exact Herdr session AND workspace before agent
 * resolution. The cross-session decoy must be invisible even when it
 * carries the same workspace id and the same agent name.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "shepy-resolver-"));
  tempDirs.push(dir);
  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const sessions = new HerdrSessionStore(sqlite);
  const agents = new AgentStore(sqlite);
  sessions.upsertRunning({ name: "default", sessionDir: "/tmp/a", socketPath: "/tmp/a.sock" });
  sessions.upsertRunning({ name: "other", sessionDir: "/tmp/b", socketPath: "/tmp/b.sock" });
  agents.replaceForSession({
    agents: [
      {
        agent: "hermes",
        agent_session: { agent: "hermes", kind: "id", source: "herdr:hermes", value: "s-1" },
        agent_status: "idle",
        focused: false,
        name: "driffs-worker",
        pane_id: "wA:p1",
        terminal_id: "tA",
        workspace_id: "wA",
      },
    ],
    herdrSessionName: "default",
  });
  agents.replaceForSession({
    agents: [
      {
        agent: "pi",
        agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: "/pi/s.jsonl" },
        agent_status: "idle",
        focused: false,
        name: "driffs-worker",
        pane_id: "wA:p1",
        terminal_id: "tD",
        workspace_id: "wA",
      },
    ],
    herdrSessionName: "other",
  });

  const profiles = new OrchestratorProfileStore(sqlite);
  const history = {
    resolveCompactHistory: async () => ({ compactHistory: null }),
  } as unknown as AgentHistoryService;
  const service = new ProfileService({ agents, history, profiles });
  return { agents, service, sqlite };
}

describe("profile dispatch target resolution — integration", () => {
  test("resolves exactly one target across a cross-session decoy", () => {
    const { service } = fixture();
    service.ensureProfile({ displayName: "Driffs", profileId: "driffs", projectRoots: [] });
    service.addSubscription({
      agentSelector: { kind: "name", value: "driffs-worker" },
      herdrSessionName: "default",
      profileId: "driffs",
      workspaceId: "wA",
    });

    const resolutions = service.resolveSubscriptions("driffs");
    const result = resolveDispatchTarget(resolutions);

    // The decoy lives in session "other" and must never be a candidate:
    // exactly one matched resolution from session "default".
    expect(result).toEqual({
      kind: "ok",
      target: {
        agentSession: "s-1",
        herdrSessionName: "default",
        paneId: "wA:p1",
        terminalId: "tA",
        workspaceId: "wA",
      },
    });
  });

  test("two same-name agents in one workspace are ambiguous, not first-match", () => {
    const { agents, service } = fixture();
    service.ensureProfile({ displayName: "Driffs", profileId: "driffs", projectRoots: [] });
    service.addSubscription({
      agentSelector: { kind: "name", value: "driffs-worker" },
      herdrSessionName: "default",
      profileId: "driffs",
      workspaceId: "wA",
    });

    // Add a second same-name agent in the SAME session+workspace.
    agents.replaceForSession({
      agents: [
        {
          agent: "hermes",
          agent_session: { agent: "hermes", kind: "id", source: "herdr:hermes", value: "s-1" },
          agent_status: "idle",
          focused: false,
          name: "driffs-worker",
          pane_id: "wA:p1",
          terminal_id: "tA",
          workspace_id: "wA",
        },
        {
          agent: "hermes",
          agent_session: { agent: "hermes", kind: "id", source: "herdr:hermes", value: "s-9" },
          agent_status: "idle",
          focused: false,
          name: "driffs-worker",
          pane_id: "wA:p2",
          terminal_id: "tB",
          workspace_id: "wA",
        },
      ],
      herdrSessionName: "default",
    });

    const result = resolveDispatchTarget(service.resolveSubscriptions("driffs"));
    expect(result.kind).toBe("ambiguous");
  });

  test("a profile with no subscriptions fails closed", () => {
    const { service } = fixture();
    service.ensureProfile({ displayName: "Empty", profileId: "empty", projectRoots: [] });
    const result = resolveDispatchTarget(service.resolveSubscriptions("empty"));
    expect(result.kind).toBe("unmatched");
  });
});
