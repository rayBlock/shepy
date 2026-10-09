import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("SQLite migrations", () => {
  test("backfills delivery_seq and agent source while preserving existing obligations", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepy-db-upgrade-"));
    tempDirs.push(dir);
    const { sqlite } = openSqlite(join(dir, "old.sqlite"));
    const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
    for (const migration of migrations.slice(0, -1)) {
      for (const statement of migration.sql) sqlite.exec(statement);
    }
    sqlite
      .prepare(
        "insert into orchestrator_profiles(profile_id, display_name, project_roots_json, created_at, updated_at) values ('engine', 'Engine', '[]', 1, 1)",
      )
      .run();
    sqlite
      .prepare(
        "insert into delivery_obligations(id, profile_id, subscription_id, agent_event_id, state, attempt_count, created_at) values ('ob-2', 'engine', 1, 2, 'pending', 0, 2), ('ob-1', 'engine', 1, 1, 'acked', 1, 1)",
      )
      .run();
    const upgrade = migrations.at(-1);
    if (!upgrade) throw new Error("demand migration missing");
    sqlite.exec("begin");
    try {
      for (const statement of upgrade.sql) sqlite.exec(statement);
      sqlite.exec("commit");
    } catch (error) {
      sqlite.exec("rollback");
      throw error;
    }
    expect(
      sqlite
        .prepare(
          "select id, kind, agent_event_id, profile_demand_event_id, delivery_seq from delivery_obligations order by delivery_seq",
        )
        .all(),
    ).toEqual([
      {
        id: "ob-1",
        kind: "agent",
        agent_event_id: 1,
        profile_demand_event_id: null,
        delivery_seq: 1,
      },
      {
        id: "ob-2",
        kind: "agent",
        agent_event_id: 2,
        profile_demand_event_id: null,
        delivery_seq: 2,
      },
    ]);
  });

  test("create the agent index schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepy-db-"));
    tempDirs.push(dir);
    const { sqlite } = openSqlite(join(dir, "test.sqlite"));
    applyMigrations(sqlite, { migrationsFolder: "drizzle" });
    const tables = sqlite
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => (row as { name: string }).name)
      .filter((name) => name !== "__drizzle_migrations" && name !== "sqlite_sequence");
    expect(tables).toEqual([
      "agent_context_snapshots",
      "agent_events",
      "agent_history_cache",
      "agent_orchestrator_scopes",
      "agents",
      "delivery_obligations",
      "herdr_sessions",
      "herdr_workspaces",
      "orchestration_operations",
      "orchestrator_profiles",
      "profile_demand_events",
      "profile_owners",
      "profile_subscriptions",
    ]);
    expect(tables).not.toContain("observed_workspaces");
    const scopeColumns = sqlite
      .prepare("pragma table_info(agent_orchestrator_scopes)")
      .all()
      .map((row) => row as { name: string });
    expect(scopeColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "acked_event_id",
        "herdr_session_name",
        "owner_pane_id",
        "owner_terminal_id",
        "workspace_id",
      ]),
    );
    const eventColumns = sqlite
      .prepare("pragma table_info(agent_events)")
      .all()
      .map((row) => row as { name: string; notnull: number });
    expect(eventColumns.find((column) => column.name === "terminal_id")?.notnull).toBe(0);
    const agentColumns = sqlite
      .prepare("pragma table_info(agents)")
      .all()
      .map((row) => row as { dflt_value: string | null; name: string; notnull: number });
    expect(agentColumns.find((column) => column.name === "pane_revision")).toMatchObject({
      dflt_value: null,
      notnull: 0,
    });
    expect(agentColumns.find((column) => column.name === "agent_session_hint_json")).toMatchObject({
      dflt_value: null,
      notnull: 0,
    });
    expect(agentColumns.find((column) => column.name === "name")).toMatchObject({
      dflt_value: null,
      notnull: 0,
    });
    const contextColumns = sqlite
      .prepare("pragma table_info(agent_context_snapshots)")
      .all()
      .map((row) => row as { name: string; notnull: number; pk: number });
    expect(contextColumns.map((column) => column.name)).toEqual([
      "agent_id",
      "compact_history_json",
      "history_ref_json",
      "pane_revision",
      "source_path",
      "source_mtime_ms",
      "source_size",
      "updated_at",
    ]);
    expect(contextColumns.find((column) => column.name === "agent_id")?.pk).toBe(1);
    expect(contextColumns.find((column) => column.name === "history_ref_json")?.notnull).toBe(0);
    const foreignKeys = sqlite
      .prepare("pragma foreign_key_list(agent_context_snapshots)")
      .all()
      .map((row) => row as { on_delete: string; table: string });
    expect(foreignKeys).toEqual(
      expect.arrayContaining([expect.objectContaining({ on_delete: "CASCADE", table: "agents" })]),
    );
    sqlite.close();
  });
});
