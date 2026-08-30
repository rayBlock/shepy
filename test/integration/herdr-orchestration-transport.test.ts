import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { HerdrSocketClient } from "@/herdr/socket-client.js";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";

const servers: Server[] = [];
const tempDirs: string[] = [];
const clients: HerdrSocketClient[] = [];

async function startFakeHerdr() {
  const dir = await mkdtemp(join(tmpdir(), "shepy-herdr-orchestration-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "herdr.sock");
  const requests: Array<{ id: string; method: string; params: unknown }> = [];
  const server = createServer((socket: Socket) => {
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk.toString("utf8"))) {
        const request = value as { id: string; method: string; params: unknown };
        requests.push(request);
        const result =
          request.method === "agent.prompt"
            ? { type: "agent_prompted" }
            : { type: "wait_matched", final_status: "done" };
        socket.write(encodeJsonLine({ id: request.id, result }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { requests, socketPath };
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("Herdr orchestration socket methods", () => {
  test("sends exact agent.prompt and agent.wait payloads over a real Unix socket", async () => {
    const { requests, socketPath } = await startFakeHerdr();
    const client = new HerdrSocketClient({ socketPath });
    clients.push(client);

    await expect(client.promptAgent({ target: "w1:p2", text: "run tests" })).resolves.toMatchObject(
      {
        requestId: "shepy-1",
        result: { type: "agent_prompted" },
      },
    );
    await expect(
      client.waitForAgent({ target: "w1:p2", until: ["done", "blocked"], timeout_ms: 5000 }),
    ).resolves.toMatchObject({
      requestId: "shepy-2",
      result: { type: "wait_matched", final_status: "done" },
    });

    expect(requests).toEqual([
      { id: "shepy-1", method: "agent.prompt", params: { target: "w1:p2", text: "run tests" } },
      {
        id: "shepy-2",
        method: "agent.wait",
        params: { target: "w1:p2", timeout_ms: 5000, until: ["done", "blocked"] },
      },
    ]);
  });
});
