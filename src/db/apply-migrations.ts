import type { DatabaseSync } from "node:sqlite";
import { type MigrationConfig, readMigrationFiles } from "drizzle-orm/migrator";

type MigrationRow = {
  created_at: number;
  hash: string;
};

// This timestamp belongs to the generated 0009 R1 journal entry. The 0008
// receipt SQL was applied while its snapshot incorrectly described R1.
const r1MigrationTime = 1791562425121;

function reconcileR1Preconditions(
  sqlite: DatabaseSync,
  migrationsTable: string,
  receiptHash: string,
  receiptTime: number,
): boolean {
  const last = sqlite
    .prepare(`select created_at, hash from "${migrationsTable}" order by created_at desc limit 1`)
    .get() as MigrationRow | undefined;
  if (last?.created_at !== receiptTime || last.hash !== receiptHash) {
    throw new Error("R1 recovery requires the unmodified 0008 receipt journal entry");
  }
  const hasTable = (name: string) =>
    !!sqlite.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name);
  const columns = (name: string) =>
    sqlite.prepare(`pragma table_info("${name}")`).all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
  const owners = columns("profile_owners");
  const obligations = columns("delivery_obligations");
  const operations = columns("orchestration_operations");
  if (
    !hasTable("profile_owners") ||
    !hasTable("delivery_obligations") ||
    !hasTable("orchestration_operations") ||
    !hasTable("orchestrator_profiles") ||
    hasTable("profile_demand_events") ||
    !operations.some((c) => c.name === "receipt_agent") ||
    !obligations.some((c) => c.name === "agent_event_id") ||
    obligations.some((c) => c.name === "delivery_seq")
  ) {
    throw new Error(
      "R1 recovery requires the receipt-era legacy schema, not a missing or already migrated schema",
    );
  }
  const partial = owners.find((c) => c.name === "accepted_source_kinds_json");
  if (!partial) return false;
  if (partial.notnull !== 0 || partial.dflt_value !== null) {
    throw new Error("R1 recovery refuses an unknown accepted_source_kinds_json column shape");
  }
  // Preserve non-default subscriptions to profile demand, not just row counts.
  // The temporary table and the drop are inside the same migration transaction.
  sqlite.exec(`create temp table __r1_owner_kinds as
    select profile_id, accepted_source_kinds_json from profile_owners`);
  sqlite.exec("alter table profile_owners drop column accepted_source_kinds_json");
  return true;
}

export function applyMigrations(sqlite: DatabaseSync, config: MigrationConfig): void {
  const migrationsTable = config.migrationsTable ?? "__drizzle_migrations";
  const migrations = readMigrationFiles(config);
  const receipt = migrations.find((m) => m.folderMillis === 1791554400000);

  sqlite.exec(`
    create table if not exists "${migrationsTable}" (
      id integer primary key autoincrement not null,
      hash text not null,
      created_at integer not null
    )
  `);

  const lastMigration = sqlite
    .prepare(`select created_at, hash from "${migrationsTable}" order by created_at desc limit 1`)
    .get() as MigrationRow | undefined;

  for (const migration of migrations) {
    if (lastMigration && lastMigration.created_at >= migration.folderMillis) {
      continue;
    }

    sqlite.exec("begin");
    try {
      const partialOwnerColumn =
        migration.folderMillis === r1MigrationTime
          ? reconcileR1Preconditions(
              sqlite,
              migrationsTable,
              receipt?.hash ?? "",
              receipt?.folderMillis ?? -1,
            )
          : false;
      for (const statement of migration.sql) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) {
          sqlite.exec(trimmed);
        }
      }

      if (partialOwnerColumn) {
        sqlite.exec(`update profile_owners set accepted_source_kinds_json =
          coalesce((select accepted_source_kinds_json from __r1_owner_kinds
            where __r1_owner_kinds.profile_id = profile_owners.profile_id), '["agent"]')`);
        sqlite.exec("drop table __r1_owner_kinds");
      }
      sqlite
        .prepare(`insert into "${migrationsTable}" (hash, created_at) values (?, ?)`)
        .run(migration.hash, migration.folderMillis);
      sqlite.exec("commit");
    } catch (error) {
      sqlite.exec("rollback");
      throw error;
    }
  }
}
