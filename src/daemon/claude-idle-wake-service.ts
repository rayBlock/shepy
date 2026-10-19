import { createHash } from "node:crypto";
import type { AgentEventStore } from "@/db/agent-events.js";
import type { ClaudeIdleWakeStore } from "@/db/claude-idle-wakes.js";
import type { DeliveryObligationStore } from "@/db/delivery-obligations.js";
import type { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { isLeaseAlive, type ProfileOwner, type ProfileOwnerStore } from "@/db/profile-owners.js";
import {
  createSocketAdapter,
  type SocketAdapter,
  safeSocketPost,
  validateClaudeMessagingSocket,
  wakeFrames,
} from "@/shared/claude-messaging-socket.js";

type WakeOptions = {
  events: AgentEventStore;
  obligations: DeliveryObligationStore;
  owners: ProfileOwnerStore;
  profiles: OrchestratorProfileStore;
  wakes: ClaudeIdleWakeStore;
  batchDelayMs?: number;
  socketDirectory?: string;
};

/** Best-effort socket nudges, independent of the hook's durable detail delivery. */
export class ClaudeIdleWakeService {
  readonly #options: WakeOptions;
  readonly #post: SocketAdapter;
  readonly #timers = new Map<string, NodeJS.Timeout>();
  #closed = false;

  constructor(options: WakeOptions & { post?: SocketAdapter }) {
    this.#options = options;
    this.#post = options.post ?? createSocketAdapter();
  }

  /** Recover pending, never-attempted nudges after a daemon restart. */
  start(): void {
    this.schedule(this.#options.profiles.listProfiles().map((profile) => profile.profileId));
  }

  schedule(profileIds: string[]): void {
    if (this.#closed) return;
    for (const profileId of profileIds) {
      const owner = this.#options.owners.get(profileId);
      if (!owner) continue;
      const previous = this.#timers.get(profileId);
      if (previous) clearTimeout(previous);
      this.#timers.set(
        profileId,
        setTimeout(() => {
          this.#timers.delete(profileId);
          void this.#tryWake(owner).catch(() => {
            // No raw error: filesystem and socket errors can carry capabilities.
            console.warn("shepy: Claude socket wake failed; hook delivery remains pending");
          });
        }, this.#options.batchDelayMs ?? 300),
      );
    }
  }

  close(): void {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  #stillOwner(owner: ProfileOwner): boolean {
    const current = this.#options.owners.get(owner.profileId);
    return (
      !this.#closed &&
      !!this.#options.profiles.getProfile(owner.profileId)?.claudeIdleWake &&
      current?.leaseToken === owner.leaseToken &&
      isLeaseAlive(current, Date.now())
    );
  }

  async #tryWake(owner: ProfileOwner): Promise<void> {
    if (owner.harnessKind !== "claude" || !this.#stillOwner(owner)) return;
    const socket = validateClaudeMessagingSocket(
      owner.claudeMessagingSocket,
      this.#options.socketDirectory,
    );
    if (!socket) return;
    const attempted = this.#options.wakes.attemptedObligationIds(owner.profileId);
    const pending = this.#options.obligations
      // The CLI store defaults to the newest 50 rows. Wake batching must not
      // strand older unattempted rows behind that readback limit.
      .list({ profileId: owner.profileId, state: "pending", limit: -1 })
      .filter((row) => {
        if (row.kind !== "agent" || row.agentEventId === null || attempted.has(row.id))
          return false;
        try {
          const event = this.#options.events.get(row.agentEventId);
          // The hook may have claimed before Herdr indexed its real terminal.
          // Match pane as well; never depend on a pane id posing as a terminal id.
          return !(
            event.herdrSessionName === owner.herdrSessionName &&
            ((event.terminalId !== null && event.terminalId === owner.terminalId) ||
              (event.paneId !== null && event.paneId === owner.paneId))
          );
        } catch {
          return false;
        }
      })
      .sort((a, b) => (a.agentEventId ?? 0) - (b.agentEventId ?? 0));
    if (!pending.length) return;
    const names = new Set<string>();
    for (const row of pending) {
      if (row.agentEventId === null) continue;
      const payload = this.#options.events.get(row.agentEventId).payload;
      if (typeof payload !== "object" || payload === null || !("name" in payload)) continue;
      if (
        typeof payload.name === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,40}$/.test(payload.name)
      )
        names.add(payload.name);
    }
    const text = `shepy: ${pending.length} finished: ${[...names].join(", ") || "worker updates"}`;
    const line = text.length <= 240 ? text : `${text.slice(0, 239)}…`;
    const obligationIds = pending.map((row) => row.id).sort();
    const batchKey = createHash("sha256").update(JSON.stringify(obligationIds)).digest("hex");
    if (!this.#stillOwner(owner)) return;
    // Reserve BEFORE connecting, including failed or ambiguous attempts. The
    // individual ids also prevent a changed pending subset from re-sending.
    if (!this.#options.wakes.recordAttempt({ batchKey, obligationIds, profileId: owner.profileId }))
      return;
    await safeSocketPost(this.#post, socket.path, () => {
      // Connect is asynchronous. Fence again before the FIRST byte, not just
      // before connect; a replacement owner must never inherit this nudge.
      if (
        !this.#stillOwner(owner) ||
        !validateClaudeMessagingSocket(socket, this.#options.socketDirectory)
      )
        throw new Error("wake no longer admitted");
      return wakeFrames(socket.token, line);
    });
  }
}
