import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { discoverAgentHistory, historySourceFromSessionRef } from "@/agent-history/discovery.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempHome(name: string) {
  const dir = await mkdtemp(join(tmpdir(), name));
  tempDirs.push(dir);
  return dir;
}

describe("agent history discovery", () => {
  test("a missing exact path never falls back to a neighbor's same-cwd session", async () => {
    const homeDir = await tempHome("shepy-pi-missing-");
    const dir = join(homeDir, ".pi", "agent", "sessions", "repo");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "owner.jsonl"),
      `${JSON.stringify({ type: "session", cwd: "/repo" })}\n`,
    );
    await expect(
      discoverAgentHistory({
        agent: "pi",
        agentSession: {
          agent: "pi",
          kind: "path",
          source: "herdr:pi",
          value: join(dir, "not-created-yet.jsonl"),
        },
        cwd: "/repo",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toBeNull();
  });

  test.each([
    {
      agent: "pi",
      root: [".pi", "agent", "sessions"],
      header: (id: string) => ({ type: "session", id, cwd: "/repo" }),
    },
    {
      agent: "claude",
      root: [".claude", "projects"],
      header: (id: string) => ({ type: "user", sessionId: id, cwd: "/repo" }),
    },
    {
      agent: "codex",
      root: [".codex", "sessions"],
      header: (id: string) => ({ type: "session_meta", payload: { id, cwd: "/repo" } }),
    },
  ])("$agent ID lookup selects the exact session, never the newer cwd neighbor", async ({
    agent,
    root,
    header,
  }) => {
    const homeDir = await tempHome("shepy-id-");
    const dir = join(homeDir, ...root);
    await mkdir(dir, { recursive: true });
    const worker = join(dir, "worker.jsonl");
    const neighbor = join(dir, "neighbor.jsonl");
    await writeFile(worker, `${JSON.stringify(header("worker"))}\n`);
    await writeFile(neighbor, `${JSON.stringify(header("neighbor"))}\n`);
    await utimes(worker, 1, 1);
    await utimes(neighbor, 2, 2);
    const input = {
      agent,
      agentSession: { agent, kind: "id" as const, source: `herdr:${agent}`, value: "worker" },
      cwd: "/repo",
      foregroundCwd: null,
      homeDir,
    };
    await expect(discoverAgentHistory(input)).resolves.toMatchObject({
      kind: "agent_session",
      path: worker,
      value: "worker",
    });
    await expect(
      discoverAgentHistory({ ...input, agentSession: { ...input.agentSession, value: "absent" } }),
    ).resolves.toBeNull();
  });

  test("maps session refs for new runtime sources", () => {
    expect(
      historySourceFromSessionRef({
        agent: "codex",
        kind: "path",
        source: "herdr:codex",
        value: "/tmp/c.jsonl",
      }),
    ).toBe("codex-jsonl");
    expect(
      historySourceFromSessionRef({
        agent: "opencode",
        kind: "id",
        source: "herdr:opencode",
        value: "ses_1",
      }),
    ).toBe("opencode-sqlite");
    expect(
      historySourceFromSessionRef({
        agent: "gemini",
        kind: "path",
        source: "herdr:gemini",
        value: "/tmp/g.json",
      }),
    ).toBe("gemini-json");
  });

  test("discovers Codex JSONL by session_meta cwd", async () => {
    const homeDir = await tempHome("shepy-codex-home-");
    const dir = join(homeDir, ".codex", "sessions", "2026", "07", "09");
    await mkdir(dir, { recursive: true });
    const older = join(
      dir,
      "rollout-2026-07-09T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
    );
    const newer = join(
      dir,
      "rollout-2026-07-09T11-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl",
    );
    await writeFile(
      older,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/other" } })}\n`,
    );
    await writeFile(
      newer,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } })}\n`,
    );

    await expect(
      discoverAgentHistory({
        agent: "codex",
        agentSession: null,
        cwd: "/repo",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path: newer,
      source: "codex-jsonl",
      value: newer,
    });
  });

  test("discovers OpenCode DB session by cwd", async () => {
    const homeDir = await tempHome("shepy-opencode-home-");
    const dbPath = join(homeDir, ".local", "share", "opencode", "opencode.db");
    await mkdir(join(homeDir, ".local", "share", "opencode"), { recursive: true });
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(
      "create table session (id text primary key, directory text not null, time_updated integer not null)",
    );
    sqlite
      .prepare("insert into session (id, directory, time_updated) values (?, ?, ?)")
      .run("s_old", "/repo", 1);
    sqlite
      .prepare("insert into session (id, directory, time_updated) values (?, ?, ?)")
      .run("s_new", "/repo", 2);
    sqlite.close();

    await expect(
      discoverAgentHistory({
        agent: "opencode",
        agentSession: null,
        cwd: "/repo",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path: dbPath,
      source: "opencode-sqlite",
      value: "s_new",
    });
    await expect(
      discoverAgentHistory({
        agent: "opencode",
        agentSession: { agent: "opencode", kind: "id", source: "herdr:opencode", value: "absent" },
        cwd: "/repo",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toBeNull();
  });

  test("discovers Gemini session JSON through .project_root", async () => {
    const homeDir = await tempHome("shepy-gemini-home-");
    const projectDir = join(homeDir, ".gemini", "tmp", "repo-project");
    const chatsDir = join(projectDir, "chats");
    await mkdir(chatsDir, { recursive: true });
    await writeFile(join(projectDir, ".project_root"), "/repo\n");
    const sessionPath = join(chatsDir, "session-2026-07-09T12-00-00abcdef.json");
    await writeFile(
      sessionPath,
      JSON.stringify({
        sessionId: "gemini-worker",
        messages: [{ type: "user", content: [{ text: "hello" }] }],
      }),
    );

    await expect(
      discoverAgentHistory({
        agent: "gemini",
        agentSession: null,
        cwd: "/repo",
        foregroundCwd: null,
        homeDir,
      }),
    ).resolves.toMatchObject({
      kind: "discovered_file",
      path: sessionPath,
      source: "gemini-json",
      value: sessionPath,
    });
    for (const id of ["gemini-worker", "absent"]) {
      const result = await discoverAgentHistory({
        agent: "gemini",
        agentSession: { agent: "gemini", kind: "id", source: "herdr:gemini", value: id },
        cwd: "/repo",
        foregroundCwd: null,
        homeDir,
      });
      if (id === "absent") expect(result).toBeNull();
      else expect(result).toMatchObject({ kind: "agent_session", path: sessionPath, value: id });
    }
  });
});
