import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  test("recovers a nullable partial owner column and rejects a legacy schema mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepy-r1-recovery-"));
    tempDirs.push(dir);
    const prior = join(dir, "prior");
    mkdirSync(join(prior, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    journal.entries = journal.entries.slice(0, -1);
    writeFileSync(join(prior, "meta/_journal.json"), JSON.stringify(journal));
    for (const name of readdirSync("drizzle").filter((n) => /^000[0-8]_.*\.sql$/.test(n))) {
      if (name === "0008_left_omega_red.sql") continue;
      copyFileSync(join("drizzle", name), join(prior, name));
    }
    const { sqlite } = openSqlite(join(dir, "partial.sqlite"));
    applyMigrations(sqlite, { migrationsFolder: prior });
    sqlite.exec("alter table profile_owners add accepted_source_kinds_json text");
    sqlite.exec(
      `insert into orchestrator_profiles(profile_id, display_name, project_roots_json, created_at, updated_at) values ('engine', 'Engine', '[]', 1, 1)`,
    );
    sqlite.exec(`insert into profile_owners
      (claimed_at,harness_kind,harness_session_ref_json,herdr_session_name,last_seen_at,
       lease_expires_at,lease_token,pane_id,profile_id,subscriber_id,terminal_id,accepted_source_kinds_json)
      values (1,'pi','{}','s',1,1,'t','p','engine','sub','term','["agent","profile-demand"]')`);
    sqlite.exec(
      `insert into orchestrator_profiles(profile_id, display_name, project_roots_json, created_at, updated_at) values ('r1-null-fixture', 'Empty', '[]', 1, 1)`,
    );
    sqlite.exec(`insert into profile_owners
      (claimed_at,harness_kind,harness_session_ref_json,herdr_session_name,last_seen_at,
       lease_expires_at,lease_token,pane_id,profile_id,subscriber_id,terminal_id)
      select claimed_at,harness_kind,harness_session_ref_json,herdr_session_name,last_seen_at,
       lease_expires_at,lease_token,pane_id,'r1-null-fixture',subscriber_id,terminal_id
      from profile_owners where profile_id='engine'`);
    applyMigrations(sqlite, { migrationsFolder: "drizzle" });
    expect(
      sqlite
        .prepare(
          "select accepted_source_kinds_json as kinds from profile_owners where profile_id='engine'",
        )
        .get(),
    ).toEqual({ kinds: '["agent","profile-demand"]' });
    expect(
      sqlite
        .prepare(
          "select accepted_source_kinds_json as kinds from profile_owners where profile_id='r1-null-fixture'",
        )
        .get(),
    ).toEqual({ kinds: '["agent"]' });
    expect(
      sqlite
        .prepare("pragma table_info(profile_owners)")
        .all()
        .find((c) => (c as { name: string }).name === "accepted_source_kinds_json"),
    ).toMatchObject({ notnull: 1, dflt_value: "'[\"agent\"]'" });
    expect(sqlite.prepare("select count(*) as n from profile_demand_events").get()).toEqual({
      n: 0,
    });
    expect(sqlite.prepare("select count(*) as n from __drizzle_migrations").get()).toEqual({
      n: 10,
    });
    applyMigrations(sqlite, { migrationsFolder: "drizzle" });
    expect(sqlite.prepare("select count(*) as n from __drizzle_migrations").get()).toEqual({
      n: 10,
    });
    sqlite.close();

    const { sqlite: invalid } = openSqlite(join(dir, "invalid.sqlite"));
    applyMigrations(invalid, { migrationsFolder: prior });
    invalid.exec("alter table orchestration_operations drop column receipt_agent");
    expect(() => applyMigrations(invalid, { migrationsFolder: "drizzle" })).toThrow(
      /receipt-era legacy schema/,
    );
    expect(invalid.prepare("select count(*) as n from __drizzle_migrations").get()).toEqual({
      n: 9,
    });
    invalid.close();
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
