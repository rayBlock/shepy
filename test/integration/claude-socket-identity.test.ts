import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { ClaudeIdleWakeService } from "@/daemon/claude-idle-wake-service.js";
import { AgentEventStore } from "@/db/agent-events.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { ClaudeIdleWakeStore } from "@/db/claude-idle-wakes.js";
import { openSqlite } from "@/db/client.js";
import { DeliveryObligationStore } from "@/db/delivery-obligations.js";
import { HerdrSessionStore } from "@/db/herdr-sessions.js";
import { OrchestratorProfileStore } from "@/db/orchestrator-profiles.js";
import { ProfileOwnerStore, toPublicProfileOwner } from "@/db/profile-owners.js";
import { createSocketAdapter, type SocketAdapter } from "@/shared/claude-messaging-socket.js";

// A different process binds each receiver. These are test-owned Unix sockets,
// not Claude sockets. Retiring the first entry keeps its inode from recycling.
const receiverSource = `
import {createServer} from 'node:net';
import {chmodSync,lstatSync} from 'node:fs';
const [path] = process.argv.slice(1);
const server = createServer(socket => {
  let buffer = '';
  socket.on('error', () => {});
  socket.on('data', data => {
    buffer += data.toString();
    const lines = buffer.split('\\n'); buffer = lines.pop();
    for (const line of lines) process.send({kind:'frame', frame:JSON.parse(line)});
  });
});
server.listen(path, () => {
  chmodSync(path, 0o600);
  process.send({kind:'ready', ino:lstatSync(path).ino});
});
process.on('message', () => server.close(() => process.disconnect()));
`;

async function receiver(path: string) {
  const frames: unknown[] = [];
  const child = spawn(process.execPath, ["--input-type=module", "--eval", receiverSource, path], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const ready = await new Promise<{ ino: number }>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`receiver exited: ${stderr}`)));
    child.on("message", (message) => {
      const value = message as { kind: string; frame: unknown; ino: number };
      if (value.kind === "ready") resolve(value);
      if (value.kind === "frame") frames.push(value.frame);
    });
  });
  return { child, frames, ino: ready.ino };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.send("close");
  });
}

async function fixture(expired: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "shepy-socket-identity-"));
  const socketDirectory = join(dir, "cc-socks");
  mkdirSync(socketDirectory, { mode: 0o700 });
  const path = join(socketDirectory, "owner.sock");
  const first = await receiver(path);
  const receivers = [first];
  const dbPath = join(dir, "state.db");
  const sqlite = openSqlite(dbPath).sqlite;
  const databases = [sqlite];
  applyMigrations(sqlite, { migrationsFolder: join(process.cwd(), "drizzle") });
  new HerdrSessionStore(sqlite).upsertRunning({
    name: "test",
    sessionDir: dir,
    socketPath: join(dir, "unused.sock"),
  });
  const profiles = new OrchestratorProfileStore(sqlite);
  profiles.createProfile({
    profileId: "p",
    displayName: "P",
    projectRoots: [],
    claudeIdleWake: true,
  });
  const owners = new ProfileOwnerStore({ sqlite, socketDirectory });
  const claim = () => {
    const current = owners.get("p");
    return owners.claim({
      profileId: "p",
      harnessKind: "claude",
      subscriberId: "old-session",
      harnessSessionRefJson: "{}",
      herdrSessionName: "test",
      paneId: "w1:p1",
      terminalId: "owner",
      ...(current ? { currentLeaseToken: current.leaseToken } : {}),
      claudeMessagingSocket: { path, token: "old-test-token" },
      leaseMs: expired ? -60_000 : 300_000,
    });
  };
  expect(claim().kind).toBe("claimed");
  const events = new AgentEventStore(sqlite);
  const obligations = new DeliveryObligationStore(sqlite);
  const event = events.append({
    herdrSessionName: "test",
    paneId: "w1:p2",
    terminalId: "worker",
    type: "agent.done",
    payload: { name: "worker" },
  });
  obligations.project({ profileId: "p", subscriptionId: 1, agentEventId: event.id });
  const services: ClaudeIdleWakeService[] = [];
  const service = (post?: SocketAdapter, reopen = false) => {
    const db = reopen ? openSqlite(dbPath).sqlite : sqlite;
    if (reopen) databases.push(db);
    const wake = new ClaudeIdleWakeService({
      batchDelayMs: 1,
      socketDirectory,
      ...(post ? { post } : {}),
      events: new AgentEventStore(db),
      obligations: new DeliveryObligationStore(db),
      owners: new ProfileOwnerStore({ sqlite: db, socketDirectory }),
      profiles: new OrchestratorProfileStore(db),
      wakes: new ClaudeIdleWakeStore(db),
    });
    services.push(wake);
    return wake;
  };
  const replace = async (connected = false) => {
    renameSync(path, join(socketDirectory, "retired.sock"));
    if (!connected) await stop(first.child);
    const second = await receiver(path);
    receivers.push(second);
    expect(second.child.pid).not.toBe(first.child.pid);
    expect(second.ino).not.toBe(first.ino);
    return second;
  };
  return {
    first,
    sqlite,
    owners,
    claim,
    obligations,
    service,
    replace,
    attempts: () => new ClaudeIdleWakeStore(sqlite).attemptedObligationIds("p").size,
    async close() {
      for (const wake of services) wake.close();
      for (const item of receivers) await stop(item.child);
      for (const db of databases) db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test.each([
  [false, "before-timer"],
  [true, "before-timer"],
  [false, "before-connect"],
  [true, "before-connect"],
  [false, "after-connect"],
  [true, "after-connect"],
] as const)("same-path private socket replacement: expired=%s, %s sends zero frames across restart", async (expired, timing) => {
  const f = await fixture(expired);
  try {
    const ownerBefore = f.owners.get("p");
    let second: Awaited<ReturnType<typeof receiver>> | undefined;
    let posts = 0;
    let result: Awaited<ReturnType<SocketAdapter>> | undefined;
    const transport = createSocketAdapter(() => {
      const socket = new Socket();
      return {
        on: (event, listener) => socket.on(event, listener),
        connect: (path, listener) =>
          socket.connect(path, () => {
            if (timing === "after-connect") {
              void f.replace(true).then((replacement) => {
                second = replacement;
                listener();
              });
            } else listener();
          }),
        write: (line, callback) => socket.write(line, callback),
        destroy: () => socket.destroy(),
      };
    });
    const post: SocketAdapter = async (path, frames) => {
      posts++;
      if (timing === "before-connect") second = await f.replace();
      result = await transport(path, frames);
      return result;
    };
    // Reopen SQLite BEFORE scheduling: the socket binding must survive restart.
    const wake = f.service(post, true);
    if (timing === "before-timer") second = await f.replace();
    wake.start();
    if (timing === "before-timer") await settle();
    else {
      await vi.waitFor(() => expect(result).toBeDefined());
      expect(result).toEqual({ status: "ambiguous", reason: "error" });
    }
    expect(second).toBeDefined();
    expect(second?.frames).toEqual([]);
    expect(f.first.frames).toEqual([]);
    expect(posts).toBe(timing === "before-timer" ? 0 : 1);
    expect(f.attempts()).toBe(timing === "before-timer" ? 0 : 1);
    expect(f.owners.get("p")).toEqual(ownerBefore);
    expect(f.obligations.list({ profileId: "p", state: "pending" })).toHaveLength(1);
    wake.close();
    const restart = f.service(post, true);
    restart.start();
    await settle();
    expect(posts).toBe(timing === "before-timer" ? 0 : 1);
    expect(second?.frames).toEqual([]);
    expect(f.first.frames).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each([
  false,
  true,
])("the original socket still receives its wake after restart: expired=%s", async (expired) => {
  const f = await fixture(expired);
  try {
    const ownerBefore = f.owners.get("p");
    const wake = f.service(undefined, true);
    wake.start();
    await vi.waitFor(() => expect(f.first.frames).toHaveLength(2));
    expect(f.first.frames).toEqual([
      { type: "auth", token: "old-test-token" },
      { type: "user", message: { role: "user", content: "shepy: 1 finished: worker" } },
    ]);
    expect(f.owners.get("p")).toEqual(ownerBefore);
    expect(f.obligations.list({ profileId: "p", state: "pending" })).toHaveLength(1);
    expect(f.attempts()).toBe(1);
    wake.close();
    f.service(undefined, true).start();
    await settle();
    expect(f.first.frames).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test.each([
  false,
  true,
])("legacy capability without socket identity stays absent until re-claim: expired=%s", async (expired) => {
  const f = await fixture(expired);
  try {
    const owner = f.owners.get("p");
    if (!owner?.claudeMessagingSocket) throw new Error("missing socket capability");
    const { path, token } = owner.claudeMessagingSocket;
    const legacy = JSON.stringify({ path, token });
    f.sqlite.prepare("update profile_owners set claude_messaging_socket_json = ?").run(legacy);
    const current = f.owners.get("p");
    expect(current?.claudeMessagingSocket).toBeNull();
    if (!current) throw new Error("missing owner");
    expect(toPublicProfileOwner(current).socket).toBe("absent");
    const wake = f.service(undefined, true);
    wake.start();
    await settle();
    expect(f.first.frames).toEqual([]);
    expect(f.attempts()).toBe(0);
    expect(
      f.sqlite.prepare("select claude_messaging_socket_json as value from profile_owners").get(),
    ).toEqual({ value: legacy });
    expect(f.claim().kind).toBe("reclaimed");
    wake.schedule(["p"]);
    await vi.waitFor(() => expect(f.first.frames).toHaveLength(2));
    expect(f.obligations.list({ profileId: "p", state: "pending" })).toHaveLength(1);
  } finally {
    await f.close();
  }
});
