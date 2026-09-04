import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { HerdrSocketClient } from "@/herdr/socket-client.js";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("HerdrSocketClient", () => {
  test("gets pane metadata over the persistent Herdr socket", async () => {
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.write(
        encodeJsonLine({
          id: request.id,
          result: { pane: { pane_id: "w1:p2", terminal_id: "term_2" } },
        }),
      );
    });

    const client = new HerdrSocketClient({ socketPath });
    await expect(client.getPane({ pane_id: "w1:p2" })).resolves.toEqual({
      pane: { pane_id: "w1:p2", terminal_id: "term_2" },
    });
    client.close();

    expect(requests).toEqual([
      {
        id: "shepy-1",
        method: "pane.get",
        params: { pane_id: "w1:p2" },
      },
    ]);
  });

  test("uses Herdr session snapshots when available", async () => {
    const sessionSnapshot = {
      type: "session_snapshot",
      snapshot: {
        agents: [{ agent: "pi", pane_id: "w1:p1", workspace_id: "w1" }],
        focused_pane_id: "w1:p1",
        focused_tab_id: "w1:t1",
        focused_workspace_id: "w1",
        layouts: [{ focused_pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" }],
        panes: [{ focused: true, pane_id: "w1:p1", workspace_id: "w1" }],
        protocol: 16,
        tabs: [{ focused: true, tab_id: "w1:t1", workspace_id: "w1" }],
        version: "0.7.2",
        workspaces: [{ focused: true, label: "Repo", workspace_id: "w1" }],
      },
    };
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.write(encodeJsonLine({ id: request.id, result: sessionSnapshot }));
    });

    const client = new HerdrSocketClient({ socketPath });
    await expect(client.sessionSnapshot()).resolves.toEqual(sessionSnapshot);
    client.close();

    expect(requests.map((request) => request.method)).toEqual(["session.snapshot"]);
  });

  test("falls back to list APIs when Herdr session snapshots are unavailable", async () => {
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      if (request.method === "session.snapshot") {
        socket.write(
          encodeJsonLine({
            error: {
              code: "invalid_request",
              message: "invalid request: unknown variant `session.snapshot`",
            },
            id: "",
          }),
        );
        return;
      }
      if (request.method === "workspace.list") {
        socket.write(
          encodeJsonLine({
            id: request.id,
            result: {
              type: "workspace_list",
              workspaces: [{ focused: true, label: "Repo", workspace_id: "w1" }],
            },
          }),
        );
        return;
      }
      if (request.method === "pane.list") {
        socket.write(
          encodeJsonLine({
            id: request.id,
            result: { panes: [{ focused: true, pane_id: "w1:p1", workspace_id: "w1" }] },
          }),
        );
        return;
      }
      if (request.method === "tab.list") {
        socket.write(
          encodeJsonLine({
            id: request.id,
            result: { tabs: [{ focused: true, tab_id: "w1:t1", workspace_id: "w1" }] },
          }),
        );
        return;
      }
      if (request.method === "agent.list") {
        socket.write(
          encodeJsonLine({
            id: request.id,
            result: { agents: [{ agent: "Pi", pane_id: "w1:p1", status: "working" }] },
          }),
        );
        return;
      }
      socket.write(encodeJsonLine({ id: request.id, result: {} }));
    });

    const client = new HerdrSocketClient({ socketPath });
    await expect(client.sessionSnapshot()).resolves.toEqual({
      snapshot: {
        agents: [{ agent: "Pi", pane_id: "w1:p1", status: "working" }],
        focused_pane_id: "w1:p1",
        focused_workspace_id: "w1",
        panes: [{ focused: true, pane_id: "w1:p1", workspace_id: "w1" }],
        tabs: [{ focused: true, tab_id: "w1:t1", workspace_id: "w1" }],
        workspaces: [{ focused: true, label: "Repo", workspace_id: "w1" }],
      },
    });
    client.close();

    expect(requests.map((request) => request.method)).toEqual([
      "session.snapshot",
      "workspace.list",
      "pane.list",
      "tab.list",
      "agent.list",
    ]);
  });

  test("subscribes to Herdr events and yields socket notifications", async () => {
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.write(encodeJsonLine({ id: request.id, result: { subscribed: true } }));
      socket.write(
        encodeJsonLine({
          data: { agent_status: "idle", pane_id: "w1:p1", workspace_id: "w1" },
          event: "pane.agent_status_changed",
        }),
      );
      socket.write(
        encodeJsonLine({
          data: { pane_id: "w1:p2", workspace_id: "w1" },
          event: "pane_created",
        }),
      );
    });

    const client = new HerdrSocketClient({ socketPath });
    const controller = new AbortController();
    const iterator = client
      .subscribeEvents({ paneIds: ["w1:p1"] }, { signal: controller.signal })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        agent_status: "idle",
        pane_id: "w1:p1",
        type: "pane.agent_status_changed",
        workspace_id: "w1",
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { pane_id: "w1:p2", type: "pane.created", workspace_id: "w1" },
    });
    controller.abort();
    client.close();

    expect(requests[0]).toMatchObject({
      method: "events.subscribe",
      params: {
        subscriptions: [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }],
      },
    });
  });

  test("rejects the event stream when the Herdr socket closes", async () => {
    const { socketPath } = await openFakeHerdrServer((socket, request) => {
      socket.end(encodeJsonLine({ id: request.id, result: { subscribed: true } }));
    });

    const client = new HerdrSocketClient({ socketPath });
    const iterator = client.subscribeEvents()[Symbol.asyncIterator]();
    const nextEvent = Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("event stream did not close")), 100);
      }),
    ]);

    await expect(nextEvent).rejects.toThrow("Herdr socket closed");
    client.close();
  });

  // The 10 s wait cut of 2026-09-04: the default per-request deadline applied
  // to agent.wait too, so every wait longer than 10 s died client-side. These
  // tests shrink the default to 200 ms and let herdr answer at 300 ms —
  // proving the wait deadline is derived from herdr's timeout_ms (plus grace)
  // and that an unbounded wait disables the client timer entirely.
  test("lets a bounded agent.wait outlive the default request deadline", async () => {
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      if (request.method !== "agent.wait") return;
      setTimeout(() => {
        socket.write(
          encodeJsonLine({
            id: request.id,
            result: { type: "wait_matched", final_status: "done" },
          }),
        );
      }, 300);
    });

    const client = new HerdrSocketClient({ socketPath, requestTimeoutMs: 200 });
    await expect(
      client.waitForAgent({ target: "w1:p2", timeout_ms: 400, until: ["done", "blocked"] }),
    ).resolves.toMatchObject({
      requestId: "shepy-1",
      result: { type: "wait_matched", final_status: "done" },
    });
    client.close();

    expect(requests).toEqual([
      {
        id: "shepy-1",
        method: "agent.wait",
        params: { target: "w1:p2", timeout_ms: 400, until: ["done", "blocked"] },
      },
    ]);
  });

  test("never cuts an unbounded agent.wait with the default request deadline", async () => {
    const { requests, socketPath } = await openFakeHerdrServer((socket, request) => {
      if (request.method !== "agent.wait") return;
      // herdr's bare wait (no timeout_ms) is unbounded by design; the fake
      // peer just answers slowly — later than the 200 ms client default.
      setTimeout(() => {
        socket.write(
          encodeJsonLine({
            id: request.id,
            result: { type: "wait_matched", final_status: "blocked" },
          }),
        );
      }, 300);
    });

    const client = new HerdrSocketClient({ socketPath, requestTimeoutMs: 200 });
    await expect(
      client.waitForAgent({ target: "w1:p2", until: ["done", "blocked"] }),
    ).resolves.toMatchObject({
      requestId: "shepy-1",
      result: { type: "wait_matched", final_status: "blocked" },
    });
    client.close();

    expect(requests[0]).toMatchObject({
      method: "agent.wait",
      params: { target: "w1:p2", until: ["done", "blocked"] },
    });
  });
});

async function openFakeHerdrServer(
  onRequest: (socket: Socket, request: Record<string, unknown>) => void,
): Promise<{ requests: Record<string, unknown>[]; socketPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), "shepy-herdr-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "herdr.sock");
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk.toString("utf8"))) {
        const request = message as Record<string, unknown>;
        requests.push(request);
        onRequest(socket, request);
      }
    });
  });
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return { requests, socketPath };
}
