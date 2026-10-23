import type { DatabaseSync } from "node:sqlite";
import { type RetentionCounts, runRetention } from "@/db/retention.js";

export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** One run at a time, at startup and daily. No automatic VACUUM. */
export class DatabaseRetentionService {
  readonly #abort = new AbortController();
  #timer: ReturnType<typeof setInterval> | undefined;
  #active: Promise<void> | undefined;

  constructor(
    readonly sqlite: DatabaseSync,
    readonly log: (line: string) => void = console.log,
    readonly logError: (line: string) => void = console.error,
  ) {}

  start(): void {
    if (this.#timer || this.#abort.signal.aborted) return;
    this.#schedule();
    this.#timer = setInterval(() => this.#schedule(), RETENTION_INTERVAL_MS);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#abort.abort();
    await this.#active;
  }

  #schedule(): void {
    if (this.#active || this.#abort.signal.aborted) return;
    this.#active = this.#run().finally(() => {
      this.#active = undefined;
    });
  }

  async #run(): Promise<void> {
    const started = Date.now();
    const counts: RetentionCounts = {
      cacheRows: 0,
      eventRows: 0,
      scannedRows: 0,
      estimatedBytesFreed: 0,
    };
    try {
      const result = await runRetention(this.sqlite, {
        signal: this.#abort.signal,
        onBatch: (batch) => {
          counts.cacheRows += batch.cacheRows;
          counts.eventRows += batch.eventRows;
          counts.scannedRows += batch.scannedRows;
          counts.estimatedBytesFreed += batch.estimatedBytesFreed;
        },
      });
      this.log(
        `Database retention: ${JSON.stringify({ ...result, elapsedMs: Date.now() - started })}`,
      );
    } catch (error) {
      // A busy writer aborts this finite run; tomorrow or the one-shot CLI
      // retries safely. Already committed batches remain accounted for.
      this.logError(
        `Database retention failed: ${JSON.stringify({ ...counts, complete: false, elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) })}`,
      );
    }
  }
}
