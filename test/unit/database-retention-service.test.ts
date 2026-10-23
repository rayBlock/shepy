import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import {
  DatabaseRetentionService,
  RETENTION_INTERVAL_MS,
} from "@/daemon/database-retention-service.js";
import { AgentEventStore } from "@/db/agent-events.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { HerdrSessionStore } from "@/db/herdr-sessions.js";
import { RETENTION_AGE_MS, runRetention } from "@/db/retention.js";

afterEach(() => vi.useRealTimers());

test("daemon retention runs at startup and daily, avoids duplicate starts, logs counts and stops its timer", async () => {
  vi.useFakeTimers();
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  new HerdrSessionStore(sqlite).upsertRunning({
    name: "fixture",
    sessionDir: "/fixture",
    socketPath: "/fixture/no.sock",
  });
  const events = new AgentEventStore(sqlite);
  const append = () => {
    const event = events.append({
      herdrSessionName: "fixture",
      type: "agent.status.changed",
      payload: {},
    });
    sqlite
      .prepare("update agent_events set created_at = ?, compact_history_json = '{}' where id = ?")
      .run(Date.now() - RETENTION_AGE_MS - 1, event.id);
  };
  const logs: string[] = [];
  const errors: string[] = [];
  const service = new DatabaseRetentionService(
    sqlite,
    (line) => logs.push(line),
    (line) => errors.push(line),
  );
  try {
    append();
    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"eventRows":1');
    expect(logs[0]).toContain('"estimatedBytesFreed":2');
    append();
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS - 1);
    expect(logs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('"eventRows":1');
    await service.stop();
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);
    expect(logs).toHaveLength(2);
    expect(errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    // Cancellation is checked between transactions, not in the middle of one.
    for (let index = 0; index < 5; index++) append();
    const abort = new AbortController();
    const stopped = await runRetention(sqlite, {
      batchSize: 2,
      signal: abort.signal,
      onBatch: () => abort.abort(),
      pauseMs: 0,
    });
    expect(stopped).toMatchObject({ complete: false, batches: 1 });
    // No timer is needed once an abort is already visible at the batch boundary.
    const resumed = runRetention(sqlite, { batchSize: 2, pauseMs: 0 });
    await vi.runAllTimersAsync();
    expect((await resumed).eventRows).toBe(5);
  } finally {
    await service.stop();
    sqlite.close();
  }
});
