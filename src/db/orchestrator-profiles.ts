import type { DatabaseSync } from "node:sqlite";

/**
 * Phase 2 — durable profile + subscription store (vault §8.1/§8.3).
 *
 * Query-only by design in this phase: nothing here wakes an owner. The
 * resolution of subscriptions against the live agent index lives in
 * ProfileService (observability layer); this store is pure persistence.
 */

type ProfileRow = {
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
  profile_id: string;
  updated_at: number;
  workspace_selector_json: string;
};

export type ProfileRecord = {
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
    displayName: string;
    profileId: string;
    projectRoots: string[];
  }): ProfileRecord {
    const now = Date.now();
    const roots = JSON.stringify(input.projectRoots);
    this.#sqlite
      .prepare(
        `insert into orchestrator_profiles (profile_id, display_name, project_roots_json, created_at, updated_at)
				 values (?, ?, ?, ?, ?)
				 on conflict(profile_id) do update set display_name = excluded.display_name, project_roots_json = excluded.project_roots_json, updated_at = excluded.updated_at`,
      )
      .run(input.profileId, input.displayName, roots, now, now);
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
  }): ProfileSubscriptionRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        `insert into profile_subscriptions (profile_id, herdr_session_name, workspace_selector_json, agent_selector_json, enabled, created_at, updated_at)
				 values (?, ?, ?, ?, 1, ?, ?)
				 on conflict(profile_id, herdr_session_name, workspace_selector_json, agent_selector_json)
				 do update set enabled = 1, updated_at = excluded.updated_at`,
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
    const result = this.#sqlite
      .prepare(
        `delete from profile_subscriptions
				 where profile_id = ? and herdr_session_name = ? and workspace_selector_json = ? and agent_selector_json = ?`,
      )
      .run(
        input.profileId,
        input.herdrSessionName,
        input.workspaceSelectorJson,
        input.agentSelectorJson,
      );
    return result.changes > 0;
  }

  listSubscriptions(profileId: string): ProfileSubscriptionRecord[] {
    const rows = this.#sqlite
      .prepare(`select * from profile_subscriptions where profile_id = ? order by id`)
      .all(profileId) as SubscriptionRow[];
    return rows.map(toSubscription);
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
    profileId: row.profile_id,
    updatedAt: row.updated_at,
    workspaceSelectorJson: row.workspace_selector_json,
  };
}
