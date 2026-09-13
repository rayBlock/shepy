import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { OperationStore } from "@/db/operations.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";

/**
 * Task 2 gate — the durable operation model (orchestration plan Task 2).
 *
 * An operation row is the durable identity of one dispatch: profile, Herdr
 * scope, resolved target identity, prompt fingerprint, transport receipt,
 * and an explicit monotonic state machine. Terminal transitions are
 * idempotent for the same outcome and fail closed on conflicts.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "shepy-operations-"));
  tempDirs.push(dir);
  const path = join(dir, "test.sqlite");
  const first = build(path);
  return { ...first, path };
}

function build(path: string) {
  const { sqlite } = openSqlite(path);
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const profiles = new OrchestratorProfileStore(sqlite);
  profiles.createProfile({ displayName: "Driffs", profileId: "driffs", projectRoots: [] });
  const operations = new OperationStore(sqlite);
  return { operations, profiles, sqlite };
}

const target = {
  agentSession: "hermes-session-1",
  herdrSessionName: "default",
  paneId: "wA:p1",
  terminalId: "tA",
  workspaceId: "wA",
};

const dispatch = {
  herdrSessionName: "default",
  profileId: "driffs",
  prompt: "run the focused tests",
  promptSha256: "a".repeat(64),
  target,
  workspaceId: "wA",
};

describe("OperationStore — durable dispatch operations", () => {
  test("creates an operation in the submitted state with full identity", () => {
    const { operations } = fixture();
    const operation = operations.create(dispatch);

    expect(operation.id).toMatch(/^op_[0-9a-z]+$/);
    expect(operation.state).toBe("pending_submission");
    expect(operation.profileId).toBe("driffs");
    expect(operation.target.paneId).toBe("wA:p1");
    expect(operation.promptSha256).toBe("a".repeat(64));
    expect(operation.createdAt).toBeInstanceOf(Date);
  });

  test("records a transport receipt and advances to submitted", () => {
    const { operations } = fixture();
    const operation = operations.create(dispatch);
    const updated = operations.recordSubmission({
      operationId: operation.id,
      requestId: "shepy-1",
      submittedAt: new Date(),
    });

    expect(updated.state).toBe("submitted");
    expect(updated.transportRequestId).toBe("shepy-1");
  });

  test("an uncertain submission (timeout after send) is submission_unknown, never success", () => {
    const { operations } = fixture();
    const operation = operations.create(dispatch);
    const updated = operations.markSubmissionUnknown({
      operationId: operation.id,
      reason: "Herdr request timed out after 10000ms: agent.prompt",
    });

    expect(updated.state).toBe("submission_unknown");
    expect(updated.errorSummary).toContain("timed out");
  });

  test("a rejected submission fails closed before any terminal success", () => {
    const { operations } = fixture();
    const operation = operations.create(dispatch);
    const updated = operations.markSubmissionRejected({
      operationId: operation.id,
      reason: "agent_not_ready",
    });

    expect(updated.state).toBe("submission_rejected");
  });

  test("terminal transition settles the operation exactly once", () => {
    const { operations } = fixture();
    const operation = operations.create(dispatch);
    operations.recordSubmission({
      operationId: operation.id,
      requestId: "shepy-1",
      submittedAt: new Date(),
    });
    const settled = operations.settle({
      lifecycle: "settled",
      operationId: operation.id,
      settledAt: new Date(),
    });
    expect(settled.state).toBe("settled");

    // Duplicate identical terminal transition is idempotent.
    const again = operations.settle({
      lifecycle: "settled",
      operationId: operation.id,
      settledAt: new Date(),
    });
    expect(again.state).toBe("settled");
    expect(again.settledAt?.toISOString()).toBe(settled.settledAt?.toISOString());
  });

  test("a conflicting terminal outcome cannot overwrite the first", () => {
    const { operations } = fixture();
    const operation = operations.create(dispatch);
    operations.recordSubmission({
      operationId: operation.id,
      requestId: "shepy-1",
      submittedAt: new Date(),
    });
    operations.settle({
      lifecycle: "blocked",
      operationId: operation.id,
      settledAt: new Date(),
    });

    expect(() =>
      operations.settle({
        lifecycle: "settled",
        operationId: operation.id,
        settledAt: new Date(),
      }),
    ).toThrow(/already terminal/i);

    const stored = operations.get(operation.id);
    expect(stored?.state).toBe("blocked");
  });

  test("invalid transitions are rejected", () => {
    const { operations } = fixture();
    const operation = operations.create(dispatch);

    // pending_submission cannot jump straight to a terminal lifecycle state.
    expect(() =>
      operations.settle({
        lifecycle: "settled",
        operationId: operation.id,
        settledAt: new Date(),
      }),
    ).toThrow(/invalid transition/i);

    // A transport receipt cannot be recorded twice.
    operations.recordSubmission({
      operationId: operation.id,
      requestId: "shepy-1",
      submittedAt: new Date(),
    });
    expect(() =>
      operations.recordSubmission({
        operationId: operation.id,
        requestId: "shepy-2",
        submittedAt: new Date(),
      }),
    ).toThrow(/invalid transition/i);
  });

  test("recordWaitError updates only error_summary and updated_at", async () => {
    const { operations } = fixture();
    const operation = operations.create(dispatch);
    operations.recordSubmission({
      operationId: operation.id,
      requestId: "shepy-1",
      submittedAt: new Date(),
    });
    const before = operations.get(operation.id);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = operations.recordWaitError({
      operationId: operation.id,
      errorSummary: "unrecognized herdr wait response (keys: agent, type)",
    });

    expect(updated.errorSummary).toBe("unrecognized herdr wait response (keys: agent, type)");
    expect(updated.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);
    // The state machine is untouched: a later correlated wait can still settle.
    expect(updated.state).toBe("submitted");
    expect(updated.lifecycle).toBeNull();
    expect(updated.settledAt).toBeNull();
    expect(updated.transportRequestId).toBe("shepy-1");
  });

  test("recordWaitError on a settled operation throws and leaves the row untouched", async () => {
    const { operations } = fixture();
    const operation = operations.create(dispatch);
    operations.recordSubmission({
      operationId: operation.id,
      requestId: "shepy-1",
      submittedAt: new Date(),
    });
    const settled = operations.settle({
      lifecycle: "settled",
      operationId: operation.id,
      settledAt: new Date(),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(() =>
      operations.recordWaitError({
        operationId: operation.id,
        errorSummary: "late unrecognized herdr wait response",
      }),
    ).toThrow(/invalid transition/i);

    const stored = operations.get(operation.id);
    expect(stored?.state).toBe("settled");
    expect(stored?.errorSummary).toBe(settled.errorSummary);
    expect(stored?.updatedAt.getTime()).toBe(settled.updatedAt.getTime());
  });

  test("operations survive a restart (reopen the SQLite file)", () => {
    const { operations, path, sqlite } = fixture();
    const operation = operations.create(dispatch);
    operations.recordSubmission({
      operationId: operation.id,
      requestId: "shepy-1",
      submittedAt: new Date(),
    });
    operations.settle({
      lifecycle: "failed",
      operationId: operation.id,
      settledAt: new Date(),
    });
    sqlite.close();

    const reopened = build(path);
    const stored = reopened.operations.get(operation.id);
    expect(stored?.state).toBe("failed");
    expect(stored?.transportRequestId).toBe("shepy-1");
    reopened.sqlite.close();
  });

  test("operations are scoped: another workspace or profile cannot read this operation", () => {
    const { operations, profiles } = fixture();
    profiles.createProfile({ displayName: "Other", profileId: "other", projectRoots: [] });
    const operation = operations.create(dispatch);

    expect(operations.get(operation.id, { profileId: "other" })).toBeUndefined();
    expect(operations.get(operation.id, { workspaceId: "wZ" })).toBeUndefined();
    expect(operations.get(operation.id, { profileId: "driffs", workspaceId: "wA" })).toBeDefined();

    expect(() =>
      operations.settle({
        lifecycle: "settled",
        operationId: operation.id,
        // caller-supplied scope that does not match the stored operation
        profileId: "other",
        settledAt: new Date(),
      } as never),
    ).toThrow(/scope/i);
  });

  test("list operations for a profile, newest first", () => {
    const { operations } = fixture();
    const first = operations.create(dispatch);
    const second = operations.create({ ...dispatch, prompt: "second dispatch" });

    const listed = operations.listForProfile("driffs");
    expect(listed.map((row) => row.id)).toEqual([second.id, first.id]);
    expect(operations.listForProfile("other")).toEqual([]);
  });
});
