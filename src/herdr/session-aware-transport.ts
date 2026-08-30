import type { HerdrSessionStore } from "@/db/herdr-sessions.js";
import type {
  HerdrOrchestrationTransport,
  HerdrTargetIdentity,
  SubmitPromptResult,
} from "@/herdr/orchestration-transport.js";
import { HerdrOrchestrationTransportAdapter } from "@/herdr/orchestration-transport-adapter.js";
import { HerdrSocketClient } from "@/herdr/socket-client.js";

/**
 * Session-aware orchestration transport for the daemon: resolves the Herdr
 * socket path from the target's Herdr session per call, opens a dedicated
 * connection for the request, and always closes it. Dispatch is a rare,
 * operator-initiated operation — a short-lived socket is simpler and safer
 * than sharing the watcher's persistent subscription client.
 */
export class SessionAwareOrchestrationTransport implements HerdrOrchestrationTransport {
  readonly #sessions: HerdrSessionStore;
  readonly #clientFactory: (options: { socketPath: string }) => HerdrSocketClient;

  constructor(options: {
    clientFactory?: (options: { socketPath: string }) => HerdrSocketClient;
    sessions: HerdrSessionStore;
  }) {
    this.#sessions = options.sessions;
    this.#clientFactory = options.clientFactory ?? ((input) => new HerdrSocketClient(input));
  }

  async submitPrompt(
    target: HerdrTargetIdentity,
    prompt: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SubmitPromptResult> {
    const socketPath = this.#socketPathFor(target);
    const client = this.#clientFactory({ socketPath });
    try {
      const adapter = new HerdrOrchestrationTransportAdapter(client);
      return await adapter.submitPrompt(target, prompt, options);
    } finally {
      client.close();
    }
  }

  async waitForLifecycle(
    operationId: string,
    target: HerdrTargetIdentity,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) {
    const socketPath = this.#socketPathFor(target);
    const client = this.#clientFactory({ socketPath });
    try {
      const adapter = new HerdrOrchestrationTransportAdapter(client);
      return await adapter.waitForLifecycle(operationId, target, options);
    } finally {
      client.close();
    }
  }

  #socketPathFor(target: HerdrTargetIdentity): string {
    const session = this.#sessions.findRunningByName(target.herdrSessionName);
    if (!session) {
      throw new Error(`Herdr session is not running: ${target.herdrSessionName}`);
    }
    return session.socketPath;
  }
}
