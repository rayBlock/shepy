import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { createDaemonInfo, resolveBuildStamp } from "@/daemon/daemon-identity.js";
import type { SessionWatchHealth } from "@/daemon/herdr-session-watch-manager.js";
import { ObservabilityRpcServer } from "@/daemon/observability-server.js";
import { AgentContextSnapshotStore } from "@/db/agent-context-snapshots.js";
import { AgentEventStore } from "@/db/agent-events.js";
import { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import { AgentOrchestratorScopeStore } from "@/db/agent-orchestrator-scopes.js";
import { AgentStore } from "@/db/agents.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { HerdrSessionStore } from "@/db/herdr-sessions.js";
import { HerdrWorkspaceStore } from "@/db/herdr-workspaces.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import { RpcTestClient } from "./rpc-test-client.js";

/**
 * RUN-20260913-04 D1 — `daemon.info` over the REAL RPC surface. An operator
 * must be able to see WHICH build is answering the socket: version, build
 * stamp, boot id, boot instant, pid. Two calls on one boot share a bootId;
 * two boots never do.
 */

const tempDirs: string[] = [];
const servers: ObservabilityRpcServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

async function openServer(
  daemonInfo?: ReturnType<typeof createDaemonInfo>,
  watchHealth?: () => SessionWatchHealth,
) {
  const dir = mkdtempSync(join(tmpdir(), "shepy-daemon-info-"));
  tempDirs.push(dir);
  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const sessions = new HerdrSessionStore(sqlite);
  const agents = new AgentStore(sqlite);
  const agentEvents = new AgentEventStore(sqlite);
  const history = createAgentHistoryService({
    cache: new AgentHistoryCacheStore(sqlite),
    homeDir: dir,
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
  const socketPath = join(dir, "rpc.sock");
  const server = new ObservabilityRpcServer({
    context,
    ...(daemonInfo ? { daemonInfo } : {}),
    ...(watchHealth ? { watchHealth } : {}),
    history,
    orchestrator,
    socketPath,
    stores: {
      agentEvents,
      agents,
      herdrSessions: sessions,
      herdrWorkspaces: new HerdrWorkspaceStore(sqlite),
    },
  });
  await server.start();
  servers.push(server);
  const client = await RpcTestClient.connect(socketPath);
  return { client, server };
}

describe("daemon.info RPC (RUN-20260913-04 D1)", () => {
  test("returns all five identity fields over the real RPC", async () => {
    const { client } = await openServer();
    const before = Date.now();
    const info = (await client.request("daemon.info", {})) as Record<string, unknown>;
    expect(Object.keys(info).sort()).toEqual([
      "bootId",
      "bootedAt",
      "buildStamp",
      "pid",
      "version",
    ]);
    expect(typeof info.version).toBe("string");
    expect(typeof info.buildStamp).toBe("string");
    // The server runs in-process: the boot pid is this test process's pid.
    expect(info.pid).toBe(process.pid);
    const bootedAt = new Date(info.bootedAt as string).getTime();
    expect(Number.isNaN(bootedAt)).toBe(false);
    expect(Math.abs(bootedAt - before)).toBeLessThan(60_000);
    // A buildStamp is either "unknown" or an ISO instant.
    if (info.buildStamp !== "unknown") {
      expect(Number.isNaN(new Date(info.buildStamp as string).getTime())).toBe(false);
    }
  });

  test("bootId is stable across two calls on one boot", async () => {
    const { client } = await openServer();
    const first = (await client.request("daemon.info", {})) as { bootId: string };
    const second = (await client.request("daemon.info", {})) as { bootId: string };
    expect(second.bootId).toBe(first.bootId);
  });

  test("two daemon instances have different bootIds", async () => {
    const first = await openServer();
    const second = await openServer();
    const firstInfo = (await first.client.request("daemon.info", {})) as { bootId: string };
    const secondInfo = (await second.client.request("daemon.info", {})) as { bootId: string };
    expect(secondInfo.bootId).not.toBe(firstInfo.bootId);
  });

  test("a server constructed with an explicit daemon.info serves it verbatim", async () => {
    const stampFile = join(mkdtempSync(join(tmpdir(), "shepy-stamp-")), "entry.js");
    writeFileSync(stampFile, "export {};\n");
    const expected = createDaemonInfo({
      entryPath: stampFile,
      pid: 4321,
      version: "9.9.9-test",
    });
    const { client } = await openServer(expected);
    expect(await client.request("daemon.info", {})).toEqual(expected);
  });
});

describe("daemon.health RPC (session-watch health backstop)", () => {
  test("serves the watch manager's live health snapshot over the real RPC", async () => {
    const snapshot = {
      consecutiveTickFailures: 4,
      degradedAfterTickFailures: 3,
      lastTickError: "database is locked",
      lastTickSucceededAt: undefined,
      status: "degraded" as const,
    };
    const { client } = await openServer(undefined, () => snapshot);
    expect(await client.request("daemon.health", {})).toEqual(snapshot);
  });

  test("a server without a watch manager answers unknown, never a guessed healthy", async () => {
    const { client } = await openServer();
    expect(await client.request("daemon.health", {})).toEqual({
      consecutiveTickFailures: 0,
      degradedAfterTickFailures: 3,
      lastTickError: undefined,
      lastTickSucceededAt: undefined,
      status: "unknown",
    });
  });
});

describe("daemon identity helpers", () => {
  test("resolveBuildStamp returns the entry file's mtime as ISO", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepy-stamp-"));
    tempDirs.push(dir);
    const entry = join(dir, "entry.js");
    writeFileSync(entry, "export {};\n");
    const stamp = resolveBuildStamp(entry);
    // Same ms-truncation both sides: mtimeMs carries sub-ms precision the
    // ISO string deliberately drops.
    expect(stamp).toBe(new Date(statSync(entry).mtimeMs).toISOString());
  });

  test("resolveBuildStamp degrades to unknown for a missing file", () => {
    expect(resolveBuildStamp("/no/such/entry.js")).toBe("unknown");
  });

  test("createDaemonInfo resolves the stamp once and stamps the boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepy-stamp-"));
    tempDirs.push(dir);
    const entry = join(dir, "entry.js");
    writeFileSync(entry, "export {};\n");
    const stampAtBoot = resolveBuildStamp(entry);
    const first = createDaemonInfo({ entryPath: entry, pid: 7, version: "1.2.3" });
    expect(first).toEqual({
      bootId: expect.any(String),
      bootedAt: expect.any(String),
      buildStamp: stampAtBoot,
      pid: 7,
      version: "1.2.3",
    });
    // Mutate the file AFTER the identity was minted: the stamp was resolved
    // once at boot, so a later rebuild does not rewrite a running daemon's
    // identity.
    writeFileSync(entry, "export {};\n// rebuilt\n");
    expect(first.buildStamp).toBe(stampAtBoot);
    expect(new Date(first.bootedAt).getTime()).toBeGreaterThan(0);
    expect(first.bootId).not.toBe(createDaemonInfo({ pid: 7, version: "1.2.3" }).bootId);
  });
});
