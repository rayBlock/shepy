import type { AgentStore } from "@/db/agents.js";
import type { HerdrSessionStore } from "@/db/herdr-sessions.js";
import type { HerdrSessionListEntry, HerdrSessionListRunner } from "@/herdr/session-list.js";
import type { SessionPanePresence } from "@/herdr/session-snapshot.js";
import { HerdrSocketClient } from "@/herdr/socket-client.js";
import type {
  AgentIndexRefreshResult,
  AgentIndexService,
} from "@/observability/agent-index-service.js";
import type { AgentEventRecord, AgentIndexRecord, AgentScope } from "@/observability/contracts.js";

export const ACTIVE_REVISION_POLL_MS = 10_000;
export const FULL_RESCAN_MS = 60_000;
export const SUBSCRIPTION_PRUNE_AGE_MS = 120_000;

/** A tick that fails this many times IN A ROW flips the observable health
 * to "degraded". Three tolerates the 2026-10-08 shape — one transient
 * SQLITE_BUSY blip — while still surfacing a permanently failing tick loop
 * (dead herdr socket, locked database) within half a minute. */
export const DEGRADED_AFTER_TICK_FAILURES = 3;

/** The observable answer to "is the session watcher actually working?".
 * Served live over the `daemon.health` RPC and printed by
 * `shepy daemon status`: permanent tick failures used to only log, so a
 * silently dying daemon was indistinguishable from a healthy one. */
export type SessionWatchHealth = {
  consecutiveTickFailures: number;
  degradedAfterTickFailures: number;
  lastTickError: string | undefined;
  lastTickSucceededAt: string | undefined;
  status: "degraded" | "healthy";
};

type Watcher = {
  abort: AbortController;
  entry: HerdrSessionListEntry;
  loop: Promise<void>;
  refreshRequested: boolean;
  continuousPaneIds: string[];
  wake?: (() => void) | undefined;
};

type Stream = {
  abort: AbortController;
  client: Pick<HerdrSocketClient, "close" | "subscribeEvents">;
  ended: boolean;
  loop: Promise<void>;
  paneIds: string[];
  ready: Promise<void>;
};

export class HerdrSessionWatchManager {
  readonly #agents: AgentStore;
  readonly #activeRevisionPollMs: number;
  readonly #clientFactory: (input: {
    socketPath: string;
  }) => Pick<HerdrSocketClient, "close" | "subscribeEvents">;
  readonly #fullRescanMs: number;
  readonly #herdrSessions: HerdrSessionStore;
  readonly #index: AgentIndexService;
  readonly #onAgentContextChanged: (scope: AgentScope) => void;
  readonly #onAgentEvent: (event: AgentEventRecord) => void;
  readonly #onAgentIndexRefreshed: (input: {
    agents: AgentIndexRecord[];
    herdrSessionName: string;
  }) => void;
  readonly #reconnectDelayMs: number;
  readonly #onSessionRefreshed: (herdrSessionName: string, presence?: SessionPanePresence) => void;
  readonly #refreshPublications = new WeakMap<
    Promise<AgentIndexRefreshResult>,
    Promise<AgentIndexRecord[]>
  >();
  readonly #retiringWatcherLoops = new Set<Promise<void>>();
  readonly #sessionList: HerdrSessionListRunner;
  readonly #watchers = new Map<string, Watcher>();
  #lastFullRescanAt = 0;
  #lifecycleGeneration = 0;
  #scheduler: NodeJS.Timeout | undefined;
  #stopping = false;
  #tickInFlight: Promise<void> | undefined;
  #consecutiveTickFailures = 0;
  #lastTickError: string | undefined;
  #lastTickSucceededAt: string | undefined;

  constructor(options: {
    activeRevisionPollMs?: number;
    agents: AgentStore;
    clientFactory?: (input: {
      socketPath: string;
    }) => Pick<HerdrSocketClient, "close" | "subscribeEvents">;
    fullRescanMs?: number;
    herdrSessions: HerdrSessionStore;
    index: AgentIndexService;
    onAgentContextChanged?(scope: AgentScope): void;
    onAgentEvent(event: AgentEventRecord): void;
    onAgentIndexRefreshed?(input: { agents: AgentIndexRecord[]; herdrSessionName: string }): void;
    reconnectDelayMs?: number;
    onSessionRefreshed?(herdrSessionName: string, presence?: SessionPanePresence): void;
    sessionList: HerdrSessionListRunner;
  }) {
    this.#activeRevisionPollMs = options.activeRevisionPollMs ?? ACTIVE_REVISION_POLL_MS;
    this.#agents = options.agents;
    this.#clientFactory = options.clientFactory ?? ((input) => new HerdrSocketClient(input));
    this.#fullRescanMs = options.fullRescanMs ?? FULL_RESCAN_MS;
    this.#herdrSessions = options.herdrSessions;
    this.#index = options.index;
    this.#onAgentContextChanged = options.onAgentContextChanged ?? (() => undefined);
    this.#onAgentEvent = options.onAgentEvent;
    this.#onAgentIndexRefreshed = options.onAgentIndexRefreshed ?? (() => undefined);
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.#sessionList = options.sessionList;
    this.#onSessionRefreshed = options.onSessionRefreshed ?? (() => undefined);
  }

  async start(): Promise<void> {
    this.#stopping = false;
    this.#lifecycleGeneration += 1;
    const generation = this.#lifecycleGeneration;
    await this.rescanNow();
    if (this.#stopping || generation !== this.#lifecycleGeneration) return;
    this.#scheduler = setInterval(() => {
      if (!this.#tickInFlight) {
        // A rejected tick must never escape the interval: unhandled, it is a
        // fatal process crash (2026-10-08: `database is locked` from a
        // concurrent writer killed the daemon and stalled every delivery
        // pump whose lease then lapsed). Transient errors are logged and
        // dropped — the next tick retries, watchers keep their own loops.
        // Every outcome is also COUNTED: permanent failure no longer hides
        // behind the log line, it degrades the observable health instead
        // (queried via daemon.health / `shepy daemon status`) — no alert
        // spam, one queryable state.
        this.#tickInFlight = this.#tick()
          .then(() => {
            this.#consecutiveTickFailures = 0;
            this.#lastTickError = undefined;
            this.#lastTickSucceededAt = new Date().toISOString();
          })
          .catch((error) => {
            this.#consecutiveTickFailures += 1;
            this.#lastTickError = error instanceof Error ? error.message : String(error);
            console.error("Shepy session tick failed (will retry):", error);
          })
          .finally(() => {
            this.#tickInFlight = undefined;
          });
      }
    }, this.#activeRevisionPollMs);
  }

  /** Live scheduler health — the backstop for permanently failing ticks.
   * Cheap, synchronous, no params: safe to serve on every status read. */
  health(): SessionWatchHealth {
    return {
      consecutiveTickFailures: this.#consecutiveTickFailures,
      degradedAfterTickFailures: DEGRADED_AFTER_TICK_FAILURES,
      lastTickError: this.#lastTickError,
      lastTickSucceededAt: this.#lastTickSucceededAt,
      status:
        this.#consecutiveTickFailures >= DEGRADED_AFTER_TICK_FAILURES ? "degraded" : "healthy",
    };
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#lifecycleGeneration += 1;
    if (this.#scheduler) clearInterval(this.#scheduler);
    this.#scheduler = undefined;
    await this.#abortWatchers();
    await this.#tickInFlight?.catch(() => undefined);
    await Promise.all([...this.#retiringWatcherLoops]);
    await this.#abortWatchers();
  }

  async rescanNow(): Promise<void> {
    const generation = this.#lifecycleGeneration;
    const sessions = await this.#sessionList();
    if (this.#stopping || generation !== this.#lifecycleGeneration) return;
    const running = sessions.filter((session) => session.running);
    const runningNames = new Set(running.map((session) => session.name));
    const removed: Promise<void>[] = [];

    for (const [name, watcher] of this.#watchers) {
      if (!runningNames.has(name)) removed.push(this.#retireWatcher(name, watcher));
    }
    await Promise.all(removed);
    if (this.#stopping || generation !== this.#lifecycleGeneration) return;
    this.#herdrSessions.markStoppedMissingFrom([...runningNames]);

    for (const entry of running) {
      if (this.#stopping || generation !== this.#lifecycleGeneration) return;
      const existing = this.#watchers.get(entry.name);
      if (existing && existing.entry.socketPath === entry.socketPath) {
        existing.entry = entry;
        this.#requestRefresh(existing);
      } else {
        if (existing) await this.#retireWatcher(entry.name, existing);
        await this.#startWatcher(entry, generation);
      }
    }
    if (!this.#stopping && generation === this.#lifecycleGeneration) {
      this.#lastFullRescanAt = Date.now();
    }
  }

  async #tick(): Promise<void> {
    if (Date.now() - this.#lastFullRescanAt >= this.#fullRescanMs) {
      await this.rescanNow();
      return;
    }
    const workingSessions = [...this.#watchers.values()].filter(({ entry }) =>
      this.#agents.listForHerdrSession(entry.name).some((agent) => agent.agentStatus === "working"),
    );
    await Promise.all(workingSessions.map(({ entry }) => this.#refresh(entry)));
  }

  async #startWatcher(entry: HerdrSessionListEntry, generation: number): Promise<void> {
    if (this.#stopping || generation !== this.#lifecycleGeneration) return;
    this.#herdrSessions.upsertRunning({
      name: entry.name,
      sessionDir: entry.sessionDir,
      socketPath: entry.socketPath,
    });
    const watcher: Watcher = {
      abort: new AbortController(),
      entry,
      loop: Promise.resolve(),
      refreshRequested: true,
      continuousPaneIds: [],
    };
    watcher.loop = this.#watch(watcher).catch(() => undefined);
    this.#watchers.set(entry.name, watcher);
    if (this.#stopping || generation !== this.#lifecycleGeneration) {
      await this.#retireWatcher(entry.name, watcher);
    }
  }

  #retireWatcher(name: string, watcher: Watcher): Promise<void> {
    if (this.#watchers.get(name) === watcher) this.#watchers.delete(name);
    watcher.abort.abort();
    watcher.wake?.();
    this.#retiringWatcherLoops.add(watcher.loop);
    const clear = () => this.#retiringWatcherLoops.delete(watcher.loop);
    void watcher.loop.then(clear, clear);
    return watcher.loop;
  }

  async #abortWatchers(): Promise<void> {
    const retiring = [...this.#watchers].map(([name, watcher]) =>
      this.#retireWatcher(name, watcher),
    );
    await Promise.all([...retiring, ...this.#retiringWatcherLoops]);
  }

  #requestRefresh(watcher: Watcher): void {
    watcher.refreshRequested = true;
    watcher.wake?.();
  }

  async #watch(watcher: Watcher): Promise<void> {
    const signal = watcher.abort.signal;
    const publications = new Set<Promise<void>>();
    const streams = new Set<Stream>();
    let primary: Stream | undefined;
    let paneIds = this.#agents.listForHerdrSession(watcher.entry.name).map((agent) => agent.paneId);
    try {
      while (!signal.aborted) {
        watcher.refreshRequested = false;
        try {
          const covered = () =>
            [...streams].filter((stream) => !stream.ended).flatMap((stream) => stream.paneIds);
          const missing = paneIds.filter((id) => !covered().includes(id));
          if (!primary || primary.ended || missing.length) {
            const lifecycle = !primary || primary.ended;
            const next = this.#openStream(watcher, missing, publications, lifecycle);
            streams.add(next);
            await next.ready;
            if (lifecycle) primary = next;
          }
          watcher.continuousPaneIds = watcher.continuousPaneIds.filter((id) =>
            covered().includes(id),
          );
          const agents = await this.#refresh(watcher.entry);
          watcher.continuousPaneIds = covered();
          paneIds = agents.map((agent) => agent.paneId);
          // Herdr status events carry no sequence number. Re-subscribing
          // existing panes on an overlapping socket can replay working/done
          // out of order. Keep their original stream; add ONLY new pane IDs.
          // Retire a data stream when none of its panes remain. The primary
          // stream stays for global lifecycle events, even with no panes.
          for (const stream of streams) {
            if (stream === primary && !stream.ended) continue;
            if (!stream.ended && stream.paneIds.some((id) => paneIds.includes(id))) continue;
            stream.abort.abort();
            stream.client.close();
            await stream.loop;
            streams.delete(stream);
          }
          if (signal.aborted) return;
          if (primary?.ended || paneIds.some((id) => !covered().includes(id))) continue;
          if (!watcher.refreshRequested) {
            await new Promise<void>((resolve) => {
              watcher.wake = resolve;
              if (watcher.refreshRequested || signal.aborted) resolve();
            });
            watcher.wake = undefined;
          }
        } catch {
          if (signal.aborted) return;
          // Failed candidates do not retire healthy existing subscriptions.
          for (const stream of streams) {
            if (!stream.ended) continue;
            stream.abort.abort();
            stream.client.close();
            await stream.loop;
            streams.delete(stream);
          }
          await delay(this.#reconnectDelayMs, signal);
        }
      }
    } finally {
      for (const stream of streams) {
        stream.abort.abort();
        stream.client.close();
      }
      await Promise.all([...streams].map((stream) => stream.loop));
      await Promise.all(publications);
    }
  }

  #openStream(
    watcher: Watcher,
    paneIds: string[],
    publications: Set<Promise<void>>,
    lifecycle: boolean,
  ): Stream {
    const { entry } = watcher;
    const abort = new AbortController();
    const signal = AbortSignal.any([watcher.abort.signal, abort.signal]);
    const client = this.#clientFactory({ socketPath: entry.socketPath });
    let subscribed!: () => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      subscribed = resolve;
      failed = reject;
    });
    const stream: Stream = { abort, client, ended: false, loop: Promise.resolve(), paneIds, ready };
    stream.loop = (async () => {
      try {
        for await (const event of client.subscribeEvents(
          { lifecycle, paneIds },
          { signal, onSubscribed: subscribed },
        )) {
          if (signal.aborted) return;
          const eventRecord = record(event);
          if (eventRecord.type === "pane.agent_status_changed") {
            // A settlement retry must not stop either stream pump.
            const publication = this.#index
              .handleHerdrEvent({
                event,
                herdrSessionName: entry.name,
                sessionDir: entry.sessionDir,
                socketPath: entry.socketPath,
              })
              .then((result) =>
                this.#publishResult({
                  agents: this.#agents.listForHerdrSession(entry.name),
                  herdrSessionName: entry.name,
                  ...result,
                }),
              )
              .catch((error) => {
                console.error("Shepy status event failed (snapshot will reconcile):", error);
              });
            publications.add(publication);
            void publication.then(() => publications.delete(publication));
          } else if (isTopologyEvent(eventRecord.type)) {
            this.#requestRefresh(watcher);
          }
        }
      } catch (error) {
        failed(error);
      } finally {
        stream.ended = true;
        failed(new Error("Herdr event stream closed before subscription"));
        if (!signal.aborted) {
          watcher.continuousPaneIds = watcher.continuousPaneIds.filter(
            (id) => !paneIds.includes(id),
          );
          this.#requestRefresh(watcher);
        }
        client.close();
      }
    })();
    return stream;
  }

  #refresh(entry: HerdrSessionListEntry): Promise<AgentIndexRecord[]> {
    const source = this.#index.refreshHerdrSession(
      {
        herdrSessionName: entry.name,
        sessionDir: entry.sessionDir,
        socketPath: entry.socketPath,
        continuousPaneIds: this.#watchers.get(entry.name)?.continuousPaneIds ?? [],
      },
      (ready) => this.#publishResult({ herdrSessionName: entry.name, ...ready }),
    );
    const existing = this.#refreshPublications.get(source);
    if (existing) return existing;
    const publication = source.then((result) => {
      this.#publishResult({ herdrSessionName: entry.name, ...result });
      // The existing tick/rescan drives age pruning. Never prune against a
      // cached, stopped or failed session, or before its first full refresh.
      this.#onSessionRefreshed(entry.name, result.presence);
      return result.agents;
    });
    this.#refreshPublications.set(source, publication);
    return publication;
  }

  #publishResult(input: {
    agents: AgentIndexRecord[];
    contextChangedScopes: AgentScope[];
    events: AgentEventRecord[];
    herdrSessionName: string;
  }): void {
    this.#onAgentIndexRefreshed({ agents: input.agents, herdrSessionName: input.herdrSessionName });
    for (const scope of input.contextChangedScopes) this.#onAgentContextChanged(scope);
    for (const event of input.events) this.#onAgentEvent(event);
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function isTopologyEvent(type: unknown): boolean {
  return (
    type === "pane.agent_detected" ||
    type === "pane.exited" ||
    type === "pane.closed" ||
    type === "pane.created" ||
    type === "pane.moved" ||
    type === "workspace.closed"
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
