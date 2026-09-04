import { createConnection, type Socket } from "node:net";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";

export type HerdrRequestId = string;

/**
 * Default per-request deadline over the persistent herdr socket. A herdr
 * peer that accepts the connection but never answers (the silent-peer
 * class) must fail in bounded time: every `#request` await participates in
 * the per-session operation queue, so one zombie request would otherwise
 * chain every later refresh behind it — the daemon wedge of 2026-08-30.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Grace added on top of herdr's own wait deadline when bounding a client-side
 * `agent.wait` request. herdr answers a bounded wait itself (matched status or
 * a `timeout` error response), so the client only needs to outlast herdr's
 * deadline plus round-trip slack — never the wait duration alone.
 */
export const WAIT_REQUEST_TIMEOUT_GRACE_MS = 5_000;

/**
 * The client's own socket-level deadline expired. This is NOT herdr's wait
 * timeout: herdr may still be waiting (or have answered after we gave up),
 * so callers must never interpret it as a completed bounded wait.
 */
export class HerdrRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrRequestTimeoutError";
  }
}

/** A herdr error response carried over the persistent socket. `code` preserves
 * herdr's own error taxonomy (e.g. "timeout" for an expired bounded wait). */
export class HerdrRequestError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "HerdrRequestError";
    this.code = code;
  }
}

export type HerdrSocketClientOptions = {
  requestTimeoutMs?: number;
  socketPath: string;
};

type RequestReceipt = {
  requestId: string;
  result: unknown;
};

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
};

type HerdrResponse = {
  data?: unknown;
  error?: { code?: string; message?: string };
  event?: string;
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
};

type EventSubscriber = {
  fail(error: Error): void;
  push(event: unknown): void;
};

export class HerdrSocketClient {
  readonly #decoder = new JsonLineDecoder();
  readonly #pending = new Map<HerdrRequestId, PendingRequest>();
  readonly #requestTimeoutMs: number;
  readonly #subscribers = new Set<EventSubscriber>();
  readonly #socket: Socket;
  readonly #socketPath: string;
  #nextId = 1;

  constructor(options: HerdrSocketClientOptions) {
    this.#socketPath = options.socketPath;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#socket = createConnection(options.socketPath);
    this.#socket.on("data", (chunk) => this.#handleData(chunk));
    this.#socket.on("error", (error) => this.#rejectAll(error));
    this.#socket.on("close", () => this.#rejectAll(new Error("Herdr socket closed")));
  }

  /** Socket is connected — distinguishes the silent-peer shape from a dead socket. */
  connected(): boolean {
    return this.#socket.readyState === "open";
  }

  close(): void {
    this.#socket.destroy();
  }

  #request(
    method: string,
    params: unknown = {},
    options: {
      includeRequestId?: boolean;
      signal?: AbortSignal;
      /** Per-call deadline override; <= 0 disables the client-side timer. */
      timeoutMs?: number;
    } = {},
  ): Promise<unknown | RequestReceipt> {
    const id = `shepy-${this.#nextId}`;
    this.#nextId += 1;

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const settle: PendingRequest = {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          if (onAbort) options.signal?.removeEventListener("abort", onAbort);
          resolve(options.includeRequestId ? { requestId: id, result: value } : value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          if (onAbort) options.signal?.removeEventListener("abort", onAbort);
          this.#pending.delete(id);
          reject(error);
        },
      };
      this.#pending.set(id, settle);
      if (options.signal) {
        if (options.signal.aborted) {
          settle.reject(new Error(`Herdr request aborted before send: ${method}`));
          return;
        }
        onAbort = () => settle.reject(new Error(`Herdr request aborted: ${method}`));
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
      if (timeoutMs > 0) {
        timer = setTimeout(
          () =>
            settle.reject(
              new HerdrRequestTimeoutError(
                `Herdr request timed out after ${timeoutMs}ms: ${method}`,
              ),
            ),
          timeoutMs,
        );
      }
      try {
        this.#socket.write(encodeJsonLine({ id, method, params }));
      } catch (error) {
        settle.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  getPane(params: { pane_id: string }): Promise<unknown> {
    return this.#request("pane.get", params);
  }

  async sessionSnapshot(): Promise<unknown> {
    try {
      return await this.#requestOnce("session.snapshot");
    } catch (error) {
      if (!isUnsupportedSessionSnapshotError(error)) {
        throw error;
      }
    }

    const [workspacesResult, panesResult, tabsResult, agentsResult] = await Promise.all([
      this.#requestOnce("workspace.list"),
      this.#requestOnce("pane.list"),
      this.#requestOnce("tab.list"),
      this.#requestOnce("agent.list"),
    ]);
    const workspaces = arrayProperty(workspacesResult, "workspaces");
    const panes = arrayProperty(panesResult, "panes");
    const tabs = arrayProperty(tabsResult, "tabs");
    const agents = arrayProperty(agentsResult, "agents");

    return {
      snapshot: {
        agents,
        ...focusedId("focused_pane_id", panes, "pane_id"),
        ...focusedId("focused_workspace_id", workspaces, "workspace_id"),
        panes,
        tabs,
        workspaces,
      },
    };
  }

  async promptAgent(
    params: { target: string; text: string; wait?: { timeout_ms?: number; until?: string[] } },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ requestId: string; result: unknown }> {
    if (params.text.trim().length === 0) {
      return Promise.reject(new Error("Herdr agent prompt must not be empty"));
    }
    const result = await this.#request("agent.prompt", params, {
      ...options,
      includeRequestId: true,
    });
    if (!isRequestReceipt(result)) throw new Error("Herdr prompt did not return a request receipt");
    return result;
  }

  async waitForAgent(
    params: { target: string; timeout_ms?: number; until?: string[] },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ requestId: string; result: unknown }> {
    // herdr bounds the wait itself when timeout_ms is set, so the client only
    // needs herdr's deadline plus slack. Without timeout_ms herdr's bare wait
    // is unbounded by design and 0 disables the client-side timer entirely —
    // the default deadline must never cut a wait short (the 10 s wait cut of
    // 2026-09-04). Options are passed explicitly (not spread) so a caller's
    // unrelated timeoutMs option can never override this derivation.
    const requestTimeoutMs =
      params.timeout_ms !== undefined ? params.timeout_ms + WAIT_REQUEST_TIMEOUT_GRACE_MS : 0;
    const result = await this.#request("agent.wait", params, {
      includeRequestId: true,
      timeoutMs: requestTimeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!isRequestReceipt(result)) throw new Error("Herdr wait did not return a request receipt");
    return result;
  }

  async *subscribeEvents(
    params: { paneIds?: string[] } = {},
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<unknown> {
    const queue: unknown[] = [];
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    const subscriber: EventSubscriber = {
      fail(error) {
        failure ??= error;
        wake?.();
        wake = undefined;
      },
      push(event) {
        queue.push(event);
        wake?.();
        wake = undefined;
      },
    };
    if (options.signal?.aborted) return;
    this.#subscribers.add(subscriber);
    try {
      // Abort-aware by necessity: this await runs BEFORE the abort-guarded
      // yield loop, so a live-but-silent herdr peer would otherwise hang the
      // subscription (and every queued refresh behind it) forever — the
      // daemon wedge of 2026-08-30.
      const requestOptions: { signal?: AbortSignal } = {};
      if (options.signal) requestOptions.signal = options.signal;
      await this.#request(
        "events.subscribe",
        {
          subscriptions: (params.paneIds ?? []).map((pane_id) => ({
            pane_id,
            type: "pane.agent_status_changed" as const,
          })),
        },
        requestOptions,
      );
      if (options.signal?.aborted) return;
      while (!options.signal?.aborted) {
        if (failure) throw failure;
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        if (failure) throw failure;
        while (queue.length > 0) {
          yield queue.shift();
        }
      }
    } finally {
      this.#subscribers.delete(subscriber);
    }
  }

  #requestOnce(method: string, params: unknown = {}): Promise<unknown> {
    const id = `shepy-${this.#nextId}`;
    this.#nextId += 1;

    return new Promise((resolve, reject) => {
      const decoder = new JsonLineDecoder();
      const socket = createConnection(this.#socketPath);
      let settled = false;
      const finish = (result: { error?: Error; value?: unknown }) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (result.error) {
          reject(result.error);
          return;
        }
        resolve(result.value);
      };

      socket.on("connect", () => socket.write(encodeJsonLine({ id, method, params })));
      socket.on("data", (chunk) => {
        for (const message of decoder.push(chunk.toString("utf8"))) {
          const response = message as HerdrResponse;
          if (response.error) {
            finish({ error: new Error(response.error.message ?? "Herdr request failed") });
            return;
          }
          if (response.id === id) {
            finish({ value: response.result });
            return;
          }
        }
      });
      socket.on("error", (error) => finish({ error }));
      socket.on("close", () => finish({ error: new Error("Herdr socket closed") }));
    });
  }

  #handleData(chunk: Buffer): void {
    for (const message of this.#decoder.push(chunk.toString("utf8"))) {
      const response = message as HerdrResponse;
      if (!response.id) {
        this.#publishNotification(response);
        continue;
      }

      const pending = this.#pending.get(response.id);
      if (!pending) {
        continue;
      }

      this.#pending.delete(response.id);
      if (response.error) {
        pending.reject(
          new HerdrRequestError(
            response.error.message ?? "Herdr request failed",
            response.error.code,
          ),
        );
        continue;
      }

      pending.resolve(response.result);
    }
  }

  #publishNotification(message: HerdrResponse): void {
    const event = notificationEvent(message);
    for (const subscriber of this.#subscribers) {
      subscriber.push(event);
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
    for (const subscriber of this.#subscribers) {
      subscriber.fail(error);
    }
  }
}

function notificationEvent(message: HerdrResponse): unknown {
  if (typeof message.event === "string" && isRecord(message.data)) {
    return {
      ...message.data,
      type: normalizeEventName(message.event),
    };
  }
  if (isRecord(message.params)) {
    return notificationPayload(message.params.event ?? message.params);
  }
  return notificationPayload(message.result ?? message);
}

function notificationPayload(value: unknown): unknown {
  if (!isRecord(value) || typeof value.event !== "string" || !isRecord(value.data)) return value;
  return {
    ...value.data,
    type: normalizeEventName(value.event),
  };
}

function normalizeEventName(value: string): string {
  return value.includes(".") ? value : value.replace("_", ".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRequestReceipt(value: unknown): value is RequestReceipt {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RequestReceipt).requestId === "string" &&
    "result" in value
  );
}

function isUnsupportedSessionSnapshotError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("session.snapshot") && error.message.includes("unknown variant");
}

function arrayProperty(value: unknown, key: string): unknown[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const property = (value as Record<string, unknown>)[key];
  return Array.isArray(property) ? property : [];
}

function focusedId(
  outputKey: string,
  records: unknown[],
  recordKey: string,
): Record<string, string> {
  const focused = records.find(
    (record) =>
      typeof record === "object" &&
      record !== null &&
      (record as { focused?: unknown }).focused === true,
  );
  if (typeof focused !== "object" || focused === null) {
    return {};
  }
  const id = (focused as Record<string, unknown>)[recordKey];
  return typeof id === "string" ? { [outputKey]: id } : {};
}
