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

export type HerdrSocketClientOptions = {
  requestTimeoutMs?: number;
  socketPath: string;
};

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
};

type HerdrResponse = {
  data?: unknown;
  error?: { message?: string };
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
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const id = `shepy-${this.#nextId}`;
    this.#nextId += 1;

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const settle: PendingRequest = {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          if (onAbort) options.signal?.removeEventListener("abort", onAbort);
          resolve(value);
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
      if (this.#requestTimeoutMs > 0) {
        timer = setTimeout(
          () =>
            settle.reject(
              new Error(`Herdr request timed out after ${this.#requestTimeoutMs}ms: ${method}`),
            ),
          this.#requestTimeoutMs,
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
        pending.reject(new Error(response.error.message ?? "Herdr request failed"));
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
