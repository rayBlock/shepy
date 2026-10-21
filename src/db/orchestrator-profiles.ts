import type { DatabaseSync } from "node:sqlite";

/**
 * Phase 2 — durable profile + subscription store (vault §8.1/§8.3).
 *
 * Query-only by design in this phase: nothing here wakes an owner. The
 * resolution of subscriptions against the live agent index lives in
 * ProfileService (observability layer); this store is pure persistence.
 */

type ProfileRow = {
  claude_idle_wake: 0 | 1;
  created_at: number;
  display_name: string;
  profile_id: string;
  project_roots_json: string;
  updated_at: number;
};

type SubscriptionRow = {
  agent_selector_json: string;
  created_at: number;
  enabled: 0 | 1;
  herdr_session_name: string;
  id: number;
  legacy: 0 | 1;
  profile_id: string;
  updated_at: number;
  workspace_selector_json: string;
};

export type ProfileRecord = {
  claudeIdleWake: boolean;
  createdAt: number;
  displayName: string;
  profileId: string;
  projectRoots: string[];
  updatedAt: number;
};

export type ProfileSubscriptionRecord = {
  agentSelectorJson: string;
  createdAt: number;
  enabled: boolean;
  herdrSessionName: string;
  id: number;
  legacy: boolean;
  profileId: string;
  updatedAt: number;
  workspaceSelectorJson: string;
};

export class OrchestratorProfileStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  createProfile(input: {
    claudeIdleWake?: boolean;
    displayName: string;
    profileId: string;
    projectRoots: string[];
  }): ProfileRecord {
    const now = Date.now();
    const roots = JSON.stringify(input.projectRoots);
    this.#sqlite
      .prepare(
        `insert into orchestrator_profiles (profile_id, display_name, project_roots_json, created_at, updated_at, claude_idle_wake)
				 values (?, ?, ?, ?, ?, ?)
				 on conflict(profile_id) do update set display_name = excluded.display_name, project_roots_json = excluded.project_roots_json, updated_at = excluded.updated_at, claude_idle_wake = coalesce(?, orchestrator_profiles.claude_idle_wake)`,
      )
      .run(
        input.profileId,
        input.displayName,
        roots,
        now,
        now,
        input.claudeIdleWake === undefined ? 0 : Number(input.claudeIdleWake),
        input.claudeIdleWake === undefined ? null : Number(input.claudeIdleWake),
      );
    const created = this.getProfile(input.profileId);
    if (!created) throw new Error(`profile upsert failed to persist ${input.profileId}`);
    return created;
  }

  getProfile(profileId: string): ProfileRecord | undefined {
    const row = this.#sqlite
      .prepare(`select * from orchestrator_profiles where profile_id = ?`)
      .get(profileId) as ProfileRow | undefined;
    return row ? toProfile(row) : undefined;
  }

  listProfiles(): ProfileRecord[] {
    const rows = this.#sqlite
      .prepare(`select * from orchestrator_profiles order by profile_id`)
      .all() as ProfileRow[];
    return rows.map(toProfile);
  }

  deleteProfile(profileId: string): boolean {
    const result = this.#sqlite
      .prepare(`delete from orchestrator_profiles where profile_id = ?`)
      .run(profileId);
    return result.changes > 0;
  }

  addSubscription(input: {
    agentSelectorJson: string;
    herdrSessionName: string;
    profileId: string;
    workspaceSelectorJson: string;
    previousAgentSelectorJson?: string;
  }): ProfileSubscriptionRecord {
    if (
      input.previousAgentSelectorJson &&
      input.previousAgentSelectorJson !== input.agentSelectorJson
    ) {
      const { previousAgentSelectorJson, ...normalized } = input;
      this.#sqlite.exec("begin immediate");
      try {
        const scoped = this.listSubscriptions(input.profileId).filter(
          (row) =>
            row.herdrSessionName === input.herdrSessionName &&
            row.workspaceSelectorJson === input.workspaceSelectorJson,
        );
        const previousKey = legacySelectorKey(previousAgentSelectorJson);
        const previousRows = scoped.filter(
          (row) =>
            row.agentSelectorJson === previousAgentSelectorJson ||
            (previousKey !== undefined && legacySelectorKey(row.agentSelectorJson) === previousKey),
        );
        const previous = previousRows[0];
        const terminal = terminalSelector(input.agentSelectorJson);
        const target =
          terminal &&
          scoped.find((row) => terminalSelector(row.agentSelectorJson)?.value === terminal.value);
        if (previous && !target)
          this.#sqlite
            .prepare("update profile_subscriptions set agent_selector_json = ? where id = ?")
            .run(input.agentSelectorJson, previous.id);
        const subscription = this.addSubscription(normalized);
        for (const prior of previousRows) {
          if (prior.id === subscription.id) continue;
          // Preserve pending notices and final replay dedup when legacy
          // selector spellings collapse to the same guarded terminal row.
          this.#sqlite
            .prepare(
              "update delivery_obligations set subscription_id = ? where profile_id = ? and subscription_id = ?",
            )
            .run(subscription.id, input.profileId, prior.id);
          this.#sqlite.prepare("delete from profile_subscriptions where id = ?").run(prior.id);
        }
        this.#sqlite.exec("commit");
        return subscription;
      } catch (error) {
        this.#sqlite.exec("rollback");
        throw error;
      }
    }
    const now = Date.now();
    const terminal = terminalSelector(input.agentSelectorJson);
    const existing =
      terminal &&
      this.listSubscriptions(input.profileId).find(
        (row) =>
          row.herdrSessionName === input.herdrSessionName &&
          row.workspaceSelectorJson === input.workspaceSelectorJson &&
          terminalSelector(row.agentSelectorJson)?.value === terminal.value,
      );
    if (existing) {
      const prior = terminalSelector(existing.agentSelectorJson);
      // Resubscribe is idempotent, never permission to replace a bound session.
      // Upgrade legacy rows, but do not bind a pending guard from a repeated
      // call's cached native identity. Only a fresh observation may bind it.
      const canBind = prior?.agentSession === undefined;
      this.#sqlite
        .prepare(
          "update profile_subscriptions set enabled = 1, updated_at = ?, agent_selector_json = ?, legacy = 0 where id = ?",
        )
        .run(now, canBind ? input.agentSelectorJson : existing.agentSelectorJson, existing.id);
      const updated = this.listSubscriptions(input.profileId).find((row) => row.id === existing.id);
      if (!updated) throw new Error(`subscription upsert failed to persist ${existing.id}`);
      return updated;
    }
    this.#sqlite
      .prepare(
        `insert into profile_subscriptions (profile_id, herdr_session_name, workspace_selector_json, agent_selector_json, enabled, created_at, updated_at, legacy)
				 values (?, ?, ?, ?, 1, ?, ?, 0)
				 on conflict(profile_id, herdr_session_name, workspace_selector_json, agent_selector_json)
				 do update set enabled = 1, updated_at = excluded.updated_at, legacy = 0`,
      )
      .run(
        input.profileId,
        input.herdrSessionName,
        input.workspaceSelectorJson,
        input.agentSelectorJson,
        now,
        now,
      );
    const row = this.#sqlite
      .prepare(
        `select * from profile_subscriptions
				 where profile_id = ? and herdr_session_name = ? and workspace_selector_json = ? and agent_selector_json = ?`,
      )
      .get(
        input.profileId,
        input.herdrSessionName,
        input.workspaceSelectorJson,
        input.agentSelectorJson,
      ) as SubscriptionRow;
    return toSubscription(row);
  }

  removeSubscription(input: {
    agentSelectorJson: string;
    herdrSessionName: string;
    profileId: string;
    workspaceSelectorJson: string;
  }): boolean {
    const terminal = terminalSelector(input.agentSelectorJson);
    const stored =
      terminal &&
      this.listSubscriptions(input.profileId).find(
        (row) =>
          row.herdrSessionName === input.herdrSessionName &&
          row.workspaceSelectorJson === input.workspaceSelectorJson &&
          terminalSelector(row.agentSelectorJson)?.value === terminal.value,
      );
    const result = this.#sqlite
      .prepare(
        `delete from profile_subscriptions
				 where profile_id = ? and herdr_session_name = ? and workspace_selector_json = ? and agent_selector_json = ?`,
      )
      .run(
        input.profileId,
        input.herdrSessionName,
        input.workspaceSelectorJson,
        stored ? stored.agentSelectorJson : input.agentSelectorJson,
      );
    return result.changes > 0;
  }

  moveSubscriptions(
    moves: Array<{
      id: number;
      workspaceSelectorJson: string;
      agentSelectorJson: string;
    }>,
  ): void {
    // Vacate all old selector keys before applying any destinations. Otherwise
    // a shift or swap can collide with another row that is itself moving.
    this.#sqlite.exec("savepoint shepy_subscription_moves");
    try {
      for (const move of moves) {
        this.#sqlite
          .prepare("update profile_subscriptions set agent_selector_json = ? where id = ?")
          .run(`__shepy_moving__:${move.id}`, move.id);
      }
      for (const move of moves) {
        const source = this.#sqlite
          .prepare("select * from profile_subscriptions where id = ?")
          .get(move.id) as SubscriptionRow | undefined;
        if (!source) continue;
        const duplicate = this.#sqlite
          .prepare(
            `select * from profile_subscriptions where profile_id = ? and herdr_session_name = ?
           and workspace_selector_json = ? and agent_selector_json = ? and id != ?`,
          )
          .get(
            source.profile_id,
            source.herdr_session_name,
            move.workspaceSelectorJson,
            move.agentSelectorJson,
            move.id,
          ) as SubscriptionRow | undefined;
        if (duplicate) {
          // Keep the destination row. Pending obligations retain both old row
          // ids independently (there is deliberately no subscription FK).
          this.#sqlite
            .prepare(
              `update profile_subscriptions set enabled = ?, legacy = ?, created_at = ?, updated_at = ? where id = ?`,
            )
            .run(
              Number(Boolean(source.enabled || duplicate.enabled)),
              Number(Boolean(source.legacy && duplicate.legacy)),
              Math.min(source.created_at, duplicate.created_at),
              Math.max(source.updated_at, duplicate.updated_at),
              duplicate.id,
            );
          this.#sqlite.prepare("delete from profile_subscriptions where id = ?").run(move.id);
        } else {
          this.#sqlite
            .prepare(
              "update profile_subscriptions set workspace_selector_json = ?, agent_selector_json = ? where id = ?",
            )
            .run(move.workspaceSelectorJson, move.agentSelectorJson, move.id);
        }
      }
      this.#sqlite.exec("release shepy_subscription_moves");
    } catch (error) {
      this.#sqlite.exec("rollback to shepy_subscription_moves; release shepy_subscription_moves");
      throw error;
    }
  }

  /** Compare-and-set preserves row id (and obligation references) at first bind. */
  bindSubscription(input: {
    id: number;
    expectedSelectorJson: string;
    boundSelectorJson: string;
  }): boolean {
    const pending = terminalSelector(input.expectedSelectorJson);
    const bound = terminalSelector(input.boundSelectorJson);
    if (
      !pending ||
      pending.agentSession !== null ||
      !bound ||
      bound.agentSession == null ||
      pending.value !== bound.value
    )
      return false;
    const result = this.#sqlite
      .prepare(
        "update profile_subscriptions set agent_selector_json = ?, updated_at = ? where id = ? and agent_selector_json = ?",
      )
      .run(input.boundSelectorJson, Date.now(), input.id, input.expectedSelectorJson);
    return result.changes > 0;
  }

  listSubscriptions(profileId: string): ProfileSubscriptionRecord[] {
    const rows = this.#sqlite
      .prepare(`select * from profile_subscriptions where profile_id = ? order by id`)
      .all(profileId) as SubscriptionRow[];
    return rows.map(toSubscription);
  }
}

function legacySelectorKey(json: string): string | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if ((record.kind === "name" || record.kind === "paneId") && typeof record.value === "string") {
      return JSON.stringify([record.kind, record.value]);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function terminalSelector(json: string): { value: string; agentSession?: unknown } | undefined {
  try {
    const selector: unknown = JSON.parse(json);
    if (typeof selector !== "object" || selector === null) return undefined;
    const record = selector as Record<string, unknown>;
    if (record.kind !== "terminalId" || typeof record.value !== "string") return undefined;
    return { value: record.value, agentSession: record.agentSession };
  } catch {
    return undefined;
  }
}

function toProfile(row: ProfileRow): ProfileRecord {
  let projectRoots: string[] = [];
  try {
    const parsed = JSON.parse(row.project_roots_json) as unknown;
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      projectRoots = parsed as string[];
    }
  } catch {
    projectRoots = [];
  }
  return {
    claudeIdleWake: row.claude_idle_wake === 1,
    createdAt: row.created_at,
    displayName: row.display_name,
    profileId: row.profile_id,
    projectRoots,
    updatedAt: row.updated_at,
  };
}

function toSubscription(row: SubscriptionRow): ProfileSubscriptionRecord {
  return {
    agentSelectorJson: row.agent_selector_json,
    createdAt: row.created_at,
    enabled: row.enabled === 1,
    herdrSessionName: row.herdr_session_name,
    id: row.id,
    legacy: row.legacy === 1,
    profileId: row.profile_id,
    updatedAt: row.updated_at,
    workspaceSelectorJson: row.workspace_selector_json,
  };
}
