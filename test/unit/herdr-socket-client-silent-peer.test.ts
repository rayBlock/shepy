import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HerdrSocketClient } from "../../src/herdr/socket-client.js";

/**
 * Regression tests for the daemon wedge found live on 2026-08-30:
 * the first CLI-started daemon froze after its initial scan — the index
 * never picked up new agents, and `daemon stop` hung. Root cause class:
 * a `#request` await over the persistent socket that never settles and
 * is not abort-aware. `events.subscribe` is the critical call — it is
 * awaited BEFORE the abort-guarded yield loop, so a live-but-silent
 * herdr socket hangs the watcher's `for await` forever: no error, no
 * close, no abort propagation. The per-session operation queue then
 * chains every later refresh behind the zombie.
 *
 * These tests stand up a REAL unix socket server so the client's socket
 * lifecycle (connect/write/close) is exercised, not simulated.
 */

describe("HerdrSocketClient silent-peer recovery", () => {
  let server: Server | undefined;
  let connections: Socket[] = [];
  const sockets: string[] = [];

  afterEach(async () => {
    for (const socket of connections) socket.destroy();
    connections = [];
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    server = undefined;
  });

  function startServer(handler: (socket: Socket) => void): Promise<string> {
    const path = join(tmpdir(), `shepy-silent-${Math.random().toString(36).slice(2)}.sock`);
    sockets.push(path);
    server = createServer((socket) => {
      connections.push(socket);
      handler(socket);
    });
    return new Promise((resolve) => server!.listen(path, () => resolve(path)));
  }

  function withDeadline<T>(
    promise: Promise<T>,
    ms: number,
  ): Promise<
    { kind: "fulfilled"; value: T } | { kind: "rejected"; error: string } | { kind: "deadline" }
  > {
    return Promise.race([
      promise.then(
        (value) => ({ kind: "fulfilled" as const, value }),
        (error) => ({ kind: "rejected" as const, error: String(error?.message ?? error) }),
      ),
      new Promise<{ kind: "deadline" }>((resolve) =>
        setTimeout(() => resolve({ kind: "deadline" }), ms),
      ),
    ]);
  }

  test("events.subscribe over a silent-but-connected socket must terminate on abort", async () => {
    // Server accepts the connection and reads the subscribe request but
    // NEVER responds. The socket stays alive: no error, no close — the
    // exact live-wedge shape.
    const path = await startServer(() => {
      // deliberately no response
    });
    const client = new HerdrSocketClient({ socketPath: path });
    const controller = new AbortController();

    const iteration = (async () => {
      for await (const _event of client.subscribeEvents(
        { paneIds: ["wX:p1"] },
        { signal: controller.signal },
      )) {
        // no events will ever arrive
      }
      return "completed";
    })();

    // Give the subscribe request time to be written and stranded.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.connected()).toBe(true);
    controller.abort();

    const outcome = await withDeadline(iteration, 1_000);
    expect(outcome.kind).not.toBe("deadline");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toContain("aborted");
    }
    client.close();
  });

  test("events.subscribe must reject on request timeout against a silent peer", async () => {
    const path = await startServer(() => {
      // silent forever
    });
    const client = new HerdrSocketClient({ socketPath: path, requestTimeoutMs: 100 });

    const iteration = (async () => {
      for await (const _event of client.subscribeEvents({ paneIds: ["wX:p1"] })) {
        // unreachable
      }
      return "completed";
    })();

    const outcome = await withDeadline(iteration, 1_000);
    expect(outcome.kind).toBe("rejected");
    expect(outcome.kind === "rejected" && outcome.error).toContain("timed out");
    client.close();
  });

  test("abort before subscribe also terminates (never reaches the yield loop)", async () => {
    const path = await startServer(() => {});
    const client = new HerdrSocketClient({ socketPath: path });
    const controller = new AbortController();
    controller.abort();

    const outcome = await withDeadline(
      (async () => {
        for await (const _event of client.subscribeEvents(
          { paneIds: [] },
          { signal: controller.signal },
        )) {
          // unreachable
        }
        return "completed";
      })(),
      500,
    );
    expect(outcome.kind).not.toBe("deadline");
    client.close();
  });

  test("vi sanity: a responding server still streams events", async () => {
    const path = await startServer((socket) => {
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        const idMatch = /"id":"([^"]+)"/.exec(text);
        if (!idMatch) return;
        if (text.includes("events.subscribe")) {
          socket.write(`${JSON.stringify({ id: idMatch[1], result: { ok: true } })}\n`);
          return;
        }
      });
      // push one event after the subscription ack
      setTimeout(() => {
        for (const socket of connections) {
          socket.write(
            `${JSON.stringify({ id: "", method: "events.push", params: { hello: true } })}\n`,
          );
        }
      }, 30);
    });
    const client = new HerdrSocketClient({ socketPath: path, requestTimeoutMs: 2_000 });

    const events: unknown[] = [];
    for await (const event of client.subscribeEvents({ paneIds: ["wX:p1"] })) {
      events.push(event);
      break;
    }
    expect(events).toHaveLength(1);
    client.close();
  });
});
