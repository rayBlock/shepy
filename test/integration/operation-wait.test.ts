import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { OperationStore } from "@/db/operations.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import type { LifecycleEvent } from "@/herdr/orchestration-transport.js";
import { OperationWaitService } from "@/observability/operation-wait-service.js";

/**
 * Task 5 gate — the wait pipeline against real SQLite: the operation must be
 * settled ONLY by a fully correlated lifecycle result; timeouts leave the
 * durable row untouched.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "shepy-wait-"));
  tempDirs.push(dir);
  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  new OrchestratorProfileStore(sqlite).createProfile({
    displayName: "Driffs",
    profileId: "driffs",
    projectRoots: [],
  });
  const operations = new OperationStore(sqlite);
  return { operations, sqlite, wait: new OperationWaitService({ operations }) };
}

function submittedOperation(operations: OperationStore) {
  const operation = operations.create({
    herdrSessionName: "default",
    profileId: "driffs",
    prompt: "run tests",
    target: {
      agentSession: "s-1",
      herdrSessionName: "default",
      paneId: "wA:p1",
      terminalId: "tA",
      workspaceId: "wA",
    },
    workspaceId: "wA",
  });
  operations.recordSubmission({
    operationId: operation.id,
    requestId: "shepy-1",
    submittedAt: new Date(),
  });
  return operations.get(operation.id) as NonNullable<ReturnType<OperationStore["get"]>>;
}

describe("operation wait — integration", () => {
  test("a correlated done result settles; the transport result is applied", () => {
    const { operations, wait } = fixture();
    const operation = submittedOperation(operations);

    const event: LifecycleEvent = {
      kind: "settled",
      operationId: operation.id,
      target: operation.target,
    };
    const outcome = wait.applyLifecycle(operation.id, event);
    expect(outcome).toEqual({ kind: "settled", operationId: operation.id });

    const stored = operations.get(operation.id);
    expect(stored?.state).toBe("settled");
    expect(stored?.lifecycle).toBe("settled");
    expect(stored?.settledAt).toBeInstanceOf(Date);
  });

  test("a timeout leaves the operation submitted and settleable later", () => {
    const { operations, wait } = fixture();
    const operation = submittedOperation(operations);

    const timeout = wait.applyTimeout({ operationId: operation.id, timeoutMs: 1000 });
    expect(timeout.kind).toBe("wait_timeout");
    expect(operations.get(operation.id)?.state).toBe("submitted");

    // A later correlated result still settles it.
    const outcome = wait.applyLifecycle(operation.id, {
      kind: "settled",
      operationId: operation.id,
      target: operation.target,
    });
    expect(outcome.kind).toBe("settled");
    expect(operations.get(operation.id)?.state).toBe("settled");
  });

  test("the first terminal result wins over a later conflicting one", () => {
    const { operations, wait } = fixture();
    const operation = submittedOperation(operations);

    wait.applyLifecycle(operation.id, {
      kind: "blocked",
      operationId: operation.id,
      target: operation.target,
    });
    const later = wait.applyLifecycle(operation.id, {
      kind: "settled",
      operationId: operation.id,
      target: operation.target,
    });

    expect(later.kind).toBe("already_terminal");
    expect(operations.get(operation.id)?.state).toBe("blocked");
  });

  test("an uncorrelated result (wrong pane) is ignored and the operation stays live", () => {
    const { operations, wait } = fixture();
    const operation = submittedOperation(operations);

    const outcome = wait.applyLifecycle(operation.id, {
      kind: "settled",
      operationId: operation.id,
      target: { ...operation.target, paneId: "wA:p9" },
    });

    expect(outcome.kind).toBe("uncorrelated");
    expect(operations.get(operation.id)?.state).toBe("submitted");
  });
});
