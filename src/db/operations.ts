import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const PROMPT_EXCERPT_MAX_CHARS = 400;

export type OperationTarget = {
  agentSession: string | null;
  herdrSessionName: string;
  paneId: string;
  terminalId: string | null;
  workspaceId: string;
};

export type OperationState =
  | "blocked"
  | "failed"
  | "pending_submission"
  | "settled"
  | "submission_rejected"
  | "submission_unknown"
  | "submitted"
  | "target_lost";

const TERMINAL_STATES: ReadonlySet<OperationState> = new Set([
  "blocked",
  "failed",
  "settled",
  "submission_rejected",
  "submission_unknown",
  "target_lost",
]);

const LIFECYCLE_TO_STATE: Readonly<
  Record<string, Extract<OperationState, "blocked" | "failed" | "settled" | "target_lost">>
> = {
  blocked: "blocked",
  failed: "failed",
  settled: "settled",
  target_lost: "target_lost",
};

export type OperationRecord = {
  createdAt: Date;
  errorSummary: string | null;
  herdrSessionName: string;
  id: string;
  lifecycle: string | null;
  profileId: string;
  promptExcerpt: string;
  promptSha256: string;
  settledAt: Date | null;
  state: OperationState;
  target: OperationTarget;
  transportRequestId: string | null;
  updatedAt: Date;
  workspaceId: string;
};

type OperationRow = {
  created_at: number;
  error_summary: string | null;
  herdr_session_name: string;
  id: string;
  lifecycle: string | null;
  profile_id: string;
  prompt_excerpt: string;
  prompt_sha256: string;
  settled_at: number | null;
  state: string;
  target_json: string;
  transport_request_id: string | null;
  updated_at: number;
  workspace_id: string;
};

export class OperationStore {
  readonly #sqlite: DatabaseSync;
  #lastTimestampMs = 0;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  /** Strictly monotonic ms — same-millisecond creates must keep insertion order. */
  #now(): number {
    const wall = Date.now();
    this.#lastTimestampMs = wall > this.#lastTimestampMs ? wall : this.#lastTimestampMs + 1;
    return this.#lastTimestampMs;
  }

  create(input: {
    herdrSessionName: string;
    profileId: string;
    prompt: string;
    promptSha256?: string;
    target: OperationTarget;
    workspaceId: string;
  }): OperationRecord {
    const now = new Date(this.#now());
    const id = `op_${randomBytes(12).toString("hex")}`;
    const promptExcerpt = excerpt(input.prompt);
    const promptSha256 = input.promptSha256 ?? hashPrompt(input.prompt);
    this.#sqlite
      .prepare(
        `insert into orchestration_operations
           (id, profile_id, herdr_session_name, workspace_id, target_json, prompt_excerpt, prompt_sha256, state, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, 'pending_submission', ?, ?)`,
      )
      .run(
        id,
        input.profileId,
        input.herdrSessionName,
        input.workspaceId,
        JSON.stringify(input.target),
        promptExcerpt,
        promptSha256,
        now.getTime(),
        now.getTime(),
      );
    return this.get(id) as OperationRecord;
  }

  get(
    id: string,
    scope?: { profileId?: string; workspaceId?: string },
  ): OperationRecord | undefined {
    const row = this.#sqlite
      .prepare("select * from orchestration_operations where id = ?")
      .get(id) as OperationRow | undefined;
    if (!row) return undefined;
    if (scope?.profileId && row.profile_id !== scope.profileId) return undefined;
    if (scope?.workspaceId && row.workspace_id !== scope.workspaceId) return undefined;
    return toRecord(row);
  }

  listForProfile(profileId: string): OperationRecord[] {
    const rows = this.#sqlite
      .prepare(
        "select * from orchestration_operations where profile_id = ? order by created_at desc, id desc",
      )
      .all(profileId) as OperationRow[];
    return rows.map(toRecord);
  }

  recordSubmission(input: {
    operationId: string;
    requestId: string;
    submittedAt: Date;
  }): OperationRecord {
    return this.#transition(input.operationId, (row) => {
      if (row.state !== "pending_submission") {
        throw new Error(
          `invalid transition: recordSubmission requires pending_submission, found ${row.state}`,
        );
      }
      this.#sqlite
        .prepare(
          `update orchestration_operations
             set state = 'submitted', transport_request_id = ?, updated_at = ?
           where id = ?`,
        )
        .run(input.requestId, input.submittedAt.getTime(), input.operationId);
    });
  }

  markSubmissionUnknown(input: { operationId: string; reason: string }): OperationRecord {
    return this.#transition(input.operationId, (row) => {
      if (row.state !== "pending_submission") {
        throw new Error(
          `invalid transition: markSubmissionUnknown requires pending_submission, found ${row.state}`,
        );
      }
      this.#sqlite
        .prepare(
          `update orchestration_operations
             set state = 'submission_unknown', error_summary = ?, updated_at = ?
           where id = ?`,
        )
        .run(input.reason, this.#now(), input.operationId);
    });
  }

  markSubmissionRejected(input: { operationId: string; reason: string }): OperationRecord {
    return this.#transition(input.operationId, (row) => {
      if (row.state !== "pending_submission") {
        throw new Error(
          `invalid transition: markSubmissionRejected requires pending_submission, found ${row.state}`,
        );
      }
      this.#sqlite
        .prepare(
          `update orchestration_operations
             set state = 'submission_rejected', error_summary = ?, updated_at = ?
           where id = ?`,
        )
        .run(input.reason, this.#now(), input.operationId);
    });
  }

  settle(input: {
    lifecycle: "blocked" | "failed" | "settled" | "target_lost";
    operationId: string;
    profileId?: string;
    settledAt: Date;
  }): OperationRecord {
    return this.#transition(
      input.operationId,
      (row) => {
        if (input.profileId && row.profile_id !== input.profileId) {
          throw new Error(
            `operation scope mismatch: expected profile ${input.profileId}, stored ${row.profile_id}`,
          );
        }
        if (TERMINAL_STATES.has(row.state as OperationState)) {
          if (row.state === LIFECYCLE_TO_STATE[input.lifecycle]) {
            // Idempotent duplicate terminal transition with the same outcome.
            return;
          }
          throw new Error(
            `operation ${input.operationId} is already terminal (${row.state}); refusing conflicting settle as ${input.lifecycle}`,
          );
        }
        if (row.state !== "submitted") {
          throw new Error(`invalid transition: settle requires submitted, found ${row.state}`);
        }
        const state: OperationState = LIFECYCLE_TO_STATE[input.lifecycle] ?? "failed";
        this.#sqlite
          .prepare(
            `update orchestration_operations
               set state = ?, lifecycle = ?, settled_at = ?, updated_at = ?
             where id = ?`,
          )
          .run(state, input.lifecycle, input.settledAt.getTime(), this.#now(), input.operationId);
      },
      input.profileId,
    );
  }

  #transition(
    operationId: string,
    mutate: (row: OperationRow) => void,
    scopeProfileId?: string,
  ): OperationRecord {
    const row = this.#sqlite
      .prepare("select * from orchestration_operations where id = ?")
      .get(operationId) as OperationRow | undefined;
    if (!row) throw new Error(`operation not found: ${operationId}`);
    if (scopeProfileId && row.profile_id !== scopeProfileId) {
      throw new Error(
        `operation scope mismatch: expected profile ${scopeProfileId}, stored ${row.profile_id}`,
      );
    }
    mutate(row);
    return this.get(operationId) as OperationRecord;
  }
}

function toRecord(row: OperationRow): OperationRecord {
  return {
    createdAt: new Date(row.created_at),
    errorSummary: row.error_summary,
    herdrSessionName: row.herdr_session_name,
    id: row.id,
    lifecycle: row.lifecycle,
    profileId: row.profile_id,
    promptExcerpt: row.prompt_excerpt,
    promptSha256: row.prompt_sha256,
    settledAt: row.settled_at === null ? null : new Date(row.settled_at),
    state: row.state as OperationState,
    target: JSON.parse(row.target_json) as OperationTarget,
    transportRequestId: row.transport_request_id,
    updatedAt: new Date(row.updated_at),
    workspaceId: row.workspace_id,
  };
}

function excerpt(prompt: string): string {
  const flattened = prompt.replace(/\s+/g, " ").trim();
  return flattened.length > PROMPT_EXCERPT_MAX_CHARS
    ? `${flattened.slice(0, PROMPT_EXCERPT_MAX_CHARS - 1)}…`
    : flattened;
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}
