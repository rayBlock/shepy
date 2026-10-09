import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { discoverAgentHistory } from "@/agent-history/discovery.js";
import { OpenCodeHistoryReader } from "@/agent-history/opencode-reader.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function fixture(version: 1 | 2 | "both") {
  const homeDir = await mkdtemp(join(tmpdir(), "oc-history-"));
  homes.push(homeDir);
  const dbPath = join(homeDir, ".local/share/opencode/opencode.db");
  await mkdir(join(homeDir, ".local/share/opencode"), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (version === 1 || version === "both") {
    db.exec(`create table session (id text primary key, directory text, time_updated integer);
      create table message (id text primary key, session_id text, time_created integer, data text);
      create table part (id text primary key, message_id text, time_created integer, data text);`);
    db.prepare("insert into session values (?, ?, ?)").run("ses_v1", "/proj", 1);
    db.prepare("insert into message values (?, ?, ?, ?)").run(
      "m1",
      "ses_v1",
      1000,
      '{"role":"user"}',
    );
    db.prepare("insert into part values (?, ?, ?, ?)").run(
      "p1",
      "m1",
      1000,
      '{"type":"text","text":"hello"}',
    );
  }
  if (version === 2 || version === "both") {
    db.exec(`create table session_v2 (id text primary key, directory text, time_updated integer);
      create table session_message (id text primary key, session_id text, time_created integer, data text);`);
    db.prepare("insert into session_v2 values (?, ?, ?)").run("ses_v2", "/proj", 2);
    db.prepare("insert into session_message values (?, ?, ?, ?)").run(
      "m2",
      "ses_v2",
      2000,
      '{"role":"user","parts":[{"type":"text","text":"hello"}]}',
    );
  }
  db.close();
  return { homeDir, dbPath };
}

const input = (homeDir: string, id: string | null) => ({
  agent: "opencode",
  agentSession: id
    ? { agent: "opencode", kind: "id" as const, source: "herdr:opencode", value: id }
    : null,
  cwd: "/proj",
  foregroundCwd: null,
  homeDir,
});

test("paired V1 and V2 exact IDs discover and read the same logical message", async () => {
  for (const [version, id] of [
    [1, "ses_v1"],
    [2, "ses_v2"],
  ] as const) {
    const { homeDir, dbPath } = await fixture(version);
    const ref = await discoverAgentHistory(input(homeDir, id));
    expect(ref).toMatchObject({ kind: "agent_session", path: dbPath, value: id });
    if (!ref) throw new Error("exact session fixture did not resolve");
    expect(await new OpenCodeHistoryReader().read(ref)).toMatchObject([
      { role: "user", text: "hello" },
    ]);
    expect(await discoverAgentHistory(input(homeDir, null))).toBeNull();
  }
});

test("mixed store resolves only the requested family; frozen V1 does not impersonate V2", async () => {
  const { homeDir } = await fixture("both");
  for (const id of ["ses_v1", "ses_v2"]) {
    const ref = await discoverAgentHistory(input(homeDir, id));
    expect(ref?.value).toBe(id);
    if (!ref) throw new Error("exact session fixture did not resolve");
    expect((await new OpenCodeHistoryReader().read(ref))[0]?.text).toBe("hello");
  }
  const frozen = await fixture(1);
  expect(await discoverAgentHistory(input(frozen.homeDir, "ses_v2"))).toBeNull();
  await expect(
    new OpenCodeHistoryReader().read({
      kind: "agent_session",
      source: "opencode-sqlite",
      path: frozen.dbPath,
      value: "ses_v2",
    }),
  ).rejects.toThrow("exact session");
});

test("malformed and missing stores remain unknown rather than empty history", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "oc-bad-"));
  homes.push(homeDir);
  const path = join(homeDir, "missing.db");
  expect(await discoverAgentHistory(input(homeDir, "ses_v2"))).toBeNull();
  const reader = new OpenCodeHistoryReader();
  await expect(
    reader.read({ kind: "agent_session", source: "opencode-sqlite", path, value: "ses_v2" }),
  ).rejects.toThrow();
  await writeFile(path, "not sqlite");
  await expect(
    reader.read({ kind: "agent_session", source: "opencode-sqlite", path, value: "ses_v2" }),
  ).rejects.toThrow();
  const malformed = await fixture(2);
  const db = new DatabaseSync(malformed.dbPath);
  db.prepare("update session_message set data = ?").run('{"unexpected":"shape"}');
  db.close();
  await expect(
    reader.read({
      kind: "agent_session",
      source: "opencode-sqlite",
      path: malformed.dbPath,
      value: "ses_v2",
    }),
  ).rejects.toThrow("unsupported V2 message shape");
});
