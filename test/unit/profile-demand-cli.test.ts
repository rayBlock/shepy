import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseCliArgs, runCliCommand } from "@/cli/shepy.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("publish-demand sends the file payload over the existing RPC, lookup carries the exact key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shepy-demand-cli-"));
  dirs.push(dir);
  const path = join(dir, "demand.json");
  writeFileSync(path, JSON.stringify({ schema: "factory.demand.v1", episodeId: "pinned" }));
  const calls: Array<{ method: string; params: unknown }> = [];
  const output: string[] = [];
  const deps = {
    socketPath: join(dir, "rpc.sock"),
    output: (line: string) => output.push(line),
    connect: async () => ({
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return { found: false };
      },
      close: () => undefined,
    }),
  };
  await runCliCommand(parseCliArgs(["inbox", "publish-demand", "--file", path, "--json"]), deps);
  await runCliCommand(
    parseCliArgs([
      "inbox",
      "lookup-demand",
      "engine",
      "--source",
      "factory-router",
      "--key",
      "episode/queue-claimable/1",
      "--json",
    ]),
    deps,
  );
  expect(calls).toEqual([
    { method: "inbox.publishDemand", params: { schema: "factory.demand.v1", episodeId: "pinned" } },
    {
      method: "inbox.lookupDemand",
      params: {
        schema: "factory.demand.lookup.v1",
        profileId: "engine",
        sourceId: "factory-router",
        idempotencyKey: "episode/queue-claimable/1",
      },
    },
  ]);
  expect(output).toEqual(['{"found":false}', '{"found":false}']);
  expect(() => parseCliArgs(["inbox", "publish-demand", "--file", "relative.json"])).toThrow(
    "absolute-path",
  );
});
