import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const agentStatusValues = ["blocked", "done", "idle", "unknown", "working"] as const;

export const herdrSessions = sqliteTable("herdr_sessions", {
  lastScannedAt: integer("last_scanned_at", { mode: "timestamp_ms" }),
  name: text("name").primaryKey(),
  running: integer("running", { mode: "boolean" }).notNull(),
  sessionDir: text("session_dir").notNull(),
  socketPath: text("socket_path").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const herdrWorkspaces = sqliteTable(
  "herdr_workspaces",
  {
    agentStatus: text("agent_status", { enum: agentStatusValues }).notNull(),
    focused: integer("focused", { mode: "boolean" }).notNull(),
    herdrSessionName: text("herdr_session_name")
      .notNull()
      .references(() => herdrSessions.name, { onDelete: "cascade" }),
    label: text("label"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    uniqueIndex("herdr_workspaces_session_workspace_idx").on(
      table.herdrSessionName,
      table.workspaceId,
    ),
  ],
);

export const agents = sqliteTable(
  "agents",
  {
    agent: text("agent"),
    agentSessionJson: text("agent_session_json"),
    agentSessionHintJson: text("agent_session_hint_json"),
    agentStatus: text("agent_status", { enum: agentStatusValues }).notNull(),
    cwd: text("cwd"),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    focused: integer("focused", { mode: "boolean" }).notNull(),
    foregroundCwd: text("foreground_cwd"),
    herdrSessionName: text("herdr_session_name")
      .notNull()
      .references(() => herdrSessions.name, { onDelete: "cascade" }),
    id: text("id").primaryKey(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    name: text("name"),
    paneId: text("pane_id").notNull(),
    paneRevision: integer("pane_revision"),
    tabId: text("tab_id"),
    terminalId: text("terminal_id"),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    uniqueIndex("agents_session_pane_idx").on(table.herdrSessionName, table.paneId),
    uniqueIndex("agents_session_terminal_idx").on(table.herdrSessionName, table.terminalId),
  ],
);

export const agentContextSnapshots = sqliteTable("agent_context_snapshots", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  compactHistoryJson: text("compact_history_json").notNull(),
  historyRefJson: text("history_ref_json"),
  paneRevision: integer("pane_revision"),
  sourcePath: text("source_path"),
  sourceMtimeMs: integer("source_mtime_ms"),
  sourceSize: integer("source_size"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const agentEvents = sqliteTable(
  "agent_events",
  {
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    compactHistoryJson: text("compact_history_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    herdrSessionName: text("herdr_session_name")
      .notNull()
      .references(() => herdrSessions.name, { onDelete: "cascade" }),
    id: integer("id").primaryKey({ autoIncrement: true }),
    idempotencyKey: text("idempotency_key"),
    paneId: text("pane_id"),
    payloadJson: text("payload_json").notNull(),
    terminalId: text("terminal_id"),
    type: text("type").notNull(),
    workspaceId: text("workspace_id"),
  },
  (table) => [
    uniqueIndex("agent_events_session_idempotency_idx").on(
      table.herdrSessionName,
      table.idempotencyKey,
    ),
  ],
);

export const agentOrchestratorScopes = sqliteTable(
  "agent_orchestrator_scopes",
  {
    ackedEventId: integer("acked_event_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    herdrSessionName: text("herdr_session_name")
      .notNull()
      .references(() => herdrSessions.name, { onDelete: "cascade" }),
    ownerPaneId: text("owner_pane_id"),
    ownerTerminalId: text("owner_terminal_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.herdrSessionName, table.workspaceId] })],
);

/**
 * Phase 2 — profiles and subscriptions (vault §8.1/§8.3).
 *
 * A profile is a project-scoped orchestration identity (e.g. "driffs") that
 * subscribes to explicitly selected agents in specific Herdr sessions.
 * Isolation invariant (§6.1): a profile sees ONLY its subscribed agents; a
 * workspace selector never silently expands across Herdr sessions; runtime
 * kind alone is never a sufficient agent selector when more than one
 * candidate exists (fail closed).
 */
export const orchestratorProfiles = sqliteTable("orchestrator_profiles", {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  displayName: text("display_name").notNull(),
  profileId: text("profile_id").primaryKey(),
  projectRootsJson: text("project_roots_json").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const profileSubscriptions = sqliteTable(
  "profile_subscriptions",
  {
    agentSelectorJson: text("agent_selector_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    herdrSessionName: text("herdr_session_name").notNull(),
    id: integer("id").primaryKey({ autoIncrement: true }),
    profileId: text("profile_id")
      .notNull()
      .references(() => orchestratorProfiles.profileId, { onDelete: "cascade" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    workspaceSelectorJson: text("workspace_selector_json").notNull(),
  },
  (table) => [
    uniqueIndex("profile_subscriptions_identity_idx").on(
      table.profileId,
      table.herdrSessionName,
      table.workspaceSelectorJson,
      table.agentSelectorJson,
    ),
  ],
);

/**
 * Phase 3 — profile owners (vault §8.2). One active logical owner per
 * profile; a brief reconnect grace preserves the current owner, explicit
 * claim by a new terminal replaces it and invalidates the old lease token.
 */
export const profileOwners = sqliteTable("profile_owners", {
  acceptedSourceKindsJson: text("accepted_source_kinds_json").notNull().default('["agent"]'),
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" }).notNull(),
  harnessKind: text("harness_kind").notNull(),
  harnessSessionRefJson: text("harness_session_ref_json").notNull(),
  herdrSessionName: text("herdr_session_name").notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }).notNull(),
  leaseToken: text("lease_token").notNull(),
  paneId: text("pane_id").notNull(),
  profileId: text("profile_id").primaryKey(),
  subscriberId: text("subscriber_id").notNull(),
  terminalId: text("terminal_id").notNull(),
  workspaceId: text("workspace_id"),
});

/**
 * Phase 3 — delivery obligations (vault §8.4). The heart of reliable wake
 * delivery: one durable obligation per (profile, agent event), advanced
 * pending → leased → delivered → acked (or dead_letter after bounded
 * attempts). Explicit obligations — never a single max cursor — make partial
 * batch failure, multiple subscriptions, reconnects, and audit behavior
 * understandable (§6.2.3). Acknowledged rows are retained for audit and may
 * be pruned by later policy; pending rows may not (§6.2.7).
 */
export const profileDemandEvents = sqliteTable(
  "profile_demand_events",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => orchestratorProfiles.profileId, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    episodeId: text("episode_id").notNull(),
    activationRevision: integer("activation_revision").notNull(),
    payloadJson: text("payload_json").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("profile_demand_events_key_idx").on(
      table.profileId,
      table.sourceId,
      table.idempotencyKey,
    ),
    uniqueIndex("profile_demand_events_episode_revision_idx").on(
      table.profileId,
      table.episodeId,
      table.activationRevision,
      table.sourceId,
    ),
  ],
);

export const deliveryObligations = sqliteTable(
  "delivery_obligations",
  {
    ackedAt: integer("acked_at", { mode: "timestamp_ms" }),
    agentEventId: integer("agent_event_id"),
    profileDemandEventId: text("profile_demand_event_id").references(() => profileDemandEvents.id, {
      onDelete: "cascade",
    }),
    deliverySeq: integer("delivery_seq").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
    deliveredHarnessTurnId: text("delivered_harness_turn_id"),
    deliveredOwnerSessionRefJson: text("delivered_owner_session_ref_json"),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["agent", "demand"] })
      .notNull()
      .default("agent"),
    lastErrorCode: text("last_error_code"),
    lastErrorSummary: text("last_error_summary"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    leaseToken: text("lease_token"),
    profileId: text("profile_id")
      .notNull()
      .references(() => orchestratorProfiles.profileId, { onDelete: "cascade" }),
    state: text("state").notNull(),
    subscriptionId: integer("subscription_id"),
  },
  (table) => [
    uniqueIndex("delivery_obligations_profile_event_idx").on(table.profileId, table.agentEventId),
    uniqueIndex("delivery_obligations_profile_demand_idx").on(
      table.profileId,
      table.profileDemandEventId,
    ),
    uniqueIndex("delivery_obligations_seq_idx").on(table.deliverySeq),
    check(
      "delivery_obligations_exact_source",
      sql`(${table.kind} = 'agent' and ${table.agentEventId} is not null and ${table.subscriptionId} is not null and ${table.profileDemandEventId} is null) or (${table.kind} = 'demand' and ${table.agentEventId} is null and ${table.subscriptionId} is null and ${table.profileDemandEventId} is not null)`,
    ),
    index("delivery_obligations_profile_state_idx").on(table.profileId, table.state),
  ],
);

export const agentHistoryCache = sqliteTable(
  "agent_history_cache",
  {
    compactHistoryJson: text("compact_history_json").notNull(),
    formatterVersion: text("formatter_version").notNull(),
    historyRefJson: text("history_ref_json").notNull(),
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceMtimeMs: integer("source_mtime_ms").notNull(),
    sourcePath: text("source_path").notNull(),
    sourceSize: integer("source_size").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("agent_history_cache_source_formatter_idx").on(
      table.sourcePath,
      table.formatterVersion,
    ),
  ],
);

/**
 * Orchestration operations — the durable identity of one dispatch through a
 * profile (orchestration plan Task 2). The state machine is explicit and
 * monotonic:
 *
 *   pending_submission → submitted → settled | blocked | failed | target_lost
 *   pending_submission → submission_unknown   (timeout after bytes were sent)
 *   pending_submission → submission_rejected  (Herdr refused before send)
 *
 * Terminal rows are immutable: a duplicate identical settle is idempotent,
 * a conflicting settle fails closed. The prompt is stored only as a
 * fingerprint plus a bounded excerpt — never a full transcript.
 */
export const orchestrationOperations = sqliteTable(
  "orchestration_operations",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    errorSummary: text("error_summary"),
    herdrSessionName: text("herdr_session_name").notNull(),
    id: text("id").primaryKey(),
    lifecycle: text("lifecycle"),
    profileId: text("profile_id")
      .notNull()
      .references(() => orchestratorProfiles.profileId, { onDelete: "cascade" }),
    promptExcerpt: text("prompt_excerpt").notNull(),
    promptSha256: text("prompt_sha256").notNull(),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }),
    state: text("state").notNull(),
    targetJson: text("target_json").notNull(),
    transportRequestId: text("transport_request_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    index("orchestration_operations_profile_created_idx").on(table.profileId, table.createdAt),
    index("orchestration_operations_state_idx").on(table.state),
  ],
);
