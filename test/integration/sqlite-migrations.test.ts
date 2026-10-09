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
    // The delivery_seq/kind backfill is the R1 recovery migration (0009,
    // journal when=1791562425121 — the same pin apply-migrations.ts keeps).
    // The graph may grow past it; anchor to that migration, not to "last".
    const upgrade = migrations.find((m) => m.folderMillis === 1791562425121);
    if (!upgrade) throw new Error("R1 recovery migration missing");
    for (const migration of migrations) {
      if (migration.folderMillis >= upgrade.folderMillis) break;
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
    const upgradeSql = upgrade.sql;
    if (!upgradeSql) throw new Error("demand migration missing");
    sqlite.exec("begin");
    try {
      for (const statement of upgradeSql) sqlite.exec(statement);
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
    // "Prior" is the receipt-era graph: everything BEFORE the R1 recovery
    // migration (0009_neat_namor) — never "everything but the last entry".
    // The graph grows past 0009 (e.g. 0010) and those entries stay on the
    // current side of the boundary, out of `prior` entirely.
    const r1 = journal.entries.findIndex((entry: { tag: string }) => entry.tag.startsWith("0009_"));
    if (r1 < 0) throw new Error("R1 recovery migration missing from journal");
    journal.entries = journal.entries.slice(0, r1);
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
    // The full folder: R1 recovery + dedup stamp + the neutral-owner
    // migration; the count is the journal length, never hard-coded.
    const journalCount = JSON.parse(
      readFileSync("drizzle/meta/_journal.json", "utf8"),
    ).entries.length;
    expect(sqlite.prepare("select count(*) as n from __drizzle_migrations").get()).toEqual({
      n: journalCount,
    });
    applyMigrations(sqlite, { migrationsFolder: "drizzle" });
    expect(sqlite.prepare("select count(*) as n from __drizzle_migrations").get()).toEqual({
      n: journalCount,
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

  test("the neutral-owner forward migration preserves owners/tokens, obligations, indexes and journal; safe reapply", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepy-neutral-owner-migration-"));
    tempDirs.push(dir);
    const prior = join(dir, "prior");
    mkdirSync(join(prior, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    const newest = journal.entries.at(-1) as { idx: number; tag: string };
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < newest.idx);
    writeFileSync(join(prior, "meta/_journal.json"), JSON.stringify(journal));
    const pad = String(newest.idx).padStart(4, "0");
    for (const name of readdirSync("drizzle").filter((n) => /^\d{4}_.*\.sql$/.test(n))) {
      if (name.startsWith(`${pad}_`)) continue;
      copyFileSync(join("drizzle", name), join(prior, name));
    }
    const { sqlite } = openSqlite(join(dir, "forward.sqlite"));
    applyMigrations(sqlite, { migrationsFolder: prior });
    sqlite
      .prepare(
        "insert into orchestrator_profiles(profile_id, display_name, project_roots_json, created_at, updated_at) values ('engine','Engine','[]',1,1)",
      )
      .run();
    sqlite
      .prepare(
        `insert into profile_owners (claimed_at,harness_kind,harness_session_ref_json,herdr_session_name,last_seen_at,lease_expires_at,lease_token,pane_id,profile_id,subscriber_id,terminal_id) values (1,'pi','{"kind":"path","value":"/tmp/owner.jsonl"}','s',1,999999999,'tok-preserve','p','engine','sub','term')`,
      )
      .run();
    sqlite
      .prepare(
        "insert into delivery_obligations(id, profile_id, subscription_id, agent_event_id, state, attempt_count, created_at, delivery_seq) values ('ob-keep','engine',1,1,'pending',0,1,1)",
      )
      .run();
    sqlite
      .prepare(
        `insert into profile_owners (claimed_at,harness_kind,harness_session_ref_json,last_seen_at,lease_expires_at,lease_token,profile_id,subscriber_id) values (1,'codex','{"kind":"thread","value":"01a11ff6-9f7f-71a1-9741-366612d6390f"}',1,999999999,'tok-neutral','standalone','codex-neutral')`,
      )
      .run();
    const ownerIndexes = sqlite.prepare("pragma index_list(profile_owners)").all();
    const ownerFks = sqlite.prepare("pragma foreign_key_list(profile_owners)").all();
    const obligationIndexes = sqlite.prepare("pragma index_list(delivery_obligations)").all();
    applyMigrations(sqlite, { migrationsFolder: "drizzle" });
    expect(
      sqlite
        .prepare(
          "select profile_id, lease_token, subscriber_id, herdr_session_name, pane_id, terminal_id from profile_owners where profile_id='engine'",
        )
        .get(),
    ).toEqual({
      profile_id: "engine",
      lease_token: "tok-preserve",
      subscriber_id: "sub",
      herdr_session_name: "s",
      pane_id: "p",
      terminal_id: "term",
    });
    expect(
      sqlite.prepare("select count(*) as n from delivery_obligations where id='ob-keep'").get(),
    ).toEqual({ n: 1 });
    // The neutral (host-free) shape survives the rebuild with NULLs intact.
    expect(
      sqlite
        .prepare(
          "select profile_id, lease_token, herdr_session_name, pane_id, terminal_id from profile_owners where profile_id='standalone'",
        )
        .get(),
    ).toEqual({
      profile_id: "standalone",
      lease_token: "tok-neutral",
      herdr_session_name: null,
      pane_id: null,
      terminal_id: null,
    });
    // Nothing pre-existing may be lost by the rebuild; the resulting index set
    // must then be stable across a safe reapply.
    const afterOwnerIndexes = sqlite.prepare("pragma index_list(profile_owners)").all() as Array<{
      name: string;
    }>;
    const afterObligationIndexes = sqlite
      .prepare("pragma index_list(delivery_obligations)")
      .all() as Array<{ name: string }>;
    for (const index of ownerIndexes as Array<{ name: string }>) {
      expect(afterOwnerIndexes.map((i) => i.name)).toContain(index.name);
    }
    for (const index of obligationIndexes as Array<{ name: string }>) {
      expect(afterObligationIndexes.map((i) => i.name)).toContain(index.name);
    }
    expect(sqlite.prepare("pragma foreign_key_list(profile_owners)").all()).toEqual(ownerFks);
    const forwardCount = JSON.parse(
      readFileSync("drizzle/meta/_journal.json", "utf8"),
    ).entries.length;
    expect(sqlite.prepare("select count(*) as n from __drizzle_migrations").get()).toEqual({
      n: forwardCount,
    });
    applyMigrations(sqlite, { migrationsFolder: "drizzle" });
    expect(sqlite.prepare("select count(*) as n from __drizzle_migrations").get()).toEqual({
      n: forwardCount,
    });
    expect(sqlite.prepare("pragma index_list(profile_owners)").all()).toEqual(afterOwnerIndexes);
    for (const column of ["herdr_session_name", "pane_id", "terminal_id"]) {
      expect(
        (sqlite.prepare("pragma table_info(profile_owners)").all() as Array<{ name: string; notnull: number }>).find(
          (c) => c.name === column,
        ),
      ).toMatchObject({ notnull: 0 });
    }
    sqlite.close();
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
      "source_entry_deliveries",
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
