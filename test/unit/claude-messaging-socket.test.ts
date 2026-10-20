import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  createSocketAdapter,
  parseRegisteredClaudeMessagingSocket,
  registerClaudeMessagingSocket,
  type SocketConnection,
  safeSocketPost,
  validateClaudeMessagingSocket,
  wakeFrames,
} from "@/shared/claude-messaging-socket.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

class SyntheticSocket implements SocketConnection {
  listeners = new Map<string, () => void>();
  writes: string[] = [];
  callbacks: ((error?: Error | null) => void)[] = [];
  connected: (() => void) | null = null;
  destroyed = 0;
  on(event: string, listener: () => void) {
    this.listeners.set(event, listener);
  }
  connect(_path: string, listener: () => void) {
    this.connected = listener;
  }
  write(line: string, callback: (error?: Error | null) => void): boolean {
    this.writes.push(line);
    this.callbacks.push(callback);
    return false;
  }
  destroy() {
    this.destroyed++;
  }
}

test("runner protocol: auth first, user second; each waits for local flush under backpressure, never an ack", async () => {
  const socket = new SyntheticSocket();
  const pending = createSocketAdapter(() => socket)("/fake.sock", () =>
    wakeFrames("secret", "shepy: 1 finished: builder"),
  );
  expect(socket.writes).toEqual([]);
  socket.connected?.();
  expect(socket.writes).toEqual(['{"type":"auth","token":"secret"}\n']);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  socket.callbacks[0]?.();
  expect(socket.writes[1]).toBe(
    '{"type":"user","message":{"role":"user","content":"shepy: 1 finished: builder"}}\n',
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  socket.callbacks[1]?.();
  expect(await pending).toEqual({
    status: "posted-unacknowledged",
    reason: "local-writes-complete",
  });
  socket.listeners.get("close")?.();
  expect(socket.destroyed).toBe(1);
});

test.each([
  "connect",
  "write",
])("one-second bound covers %s; late callbacks cannot send", async (stage) => {
  vi.useFakeTimers();
  const socket = new SyntheticSocket();
  const pending = createSocketAdapter(() => socket)("/fake.sock", () =>
    wakeFrames("secret", "line"),
  );
  if (stage === "write") socket.connected?.();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await pending).toEqual({ status: "ambiguous", reason: "timeout" });
  socket.connected?.();
  socket.callbacks[0]?.();
  expect(socket.writes).toHaveLength(stage === "write" ? 1 : 0);
  expect(socket.destroyed).toBe(1);
});

test.each([
  "error",
  "close",
  "end",
  "write-error",
  "write-throws",
  "frames-throws",
  "connect-throws",
])("%s is bounded and never exposes exception text", async (mode) => {
  const socket = new SyntheticSocket();
  if (mode === "connect-throws")
    socket.connect = () => {
      throw new Error("secret-path-token");
    };
  if (mode === "write-throws")
    socket.write = () => {
      throw new Error("secret-path-token");
    };
  const pending = createSocketAdapter(() => socket)("/fake.sock", () => {
    if (mode === "frames-throws") throw new Error("secret-path-token");
    return wakeFrames("secret", "line");
  });
  socket.connected?.();
  if (mode === "write-error") socket.callbacks[0]?.(new Error("secret-path-token"));
  else socket.listeners.get(mode)?.();
  const result = await pending;
  expect(result).toEqual({
    status: "ambiguous",
    reason: ["close", "end"].includes(mode) ? "early-close" : "error",
  });
  expect(socket.destroyed).toBe(1);
  expect(JSON.stringify(result)).not.toContain("secret");
});

test("safe adapter boundary drops thrown credentials and unrecognized results", async () => {
  expect(
    await safeSocketPost(
      async () => {
        throw new Error("private-path-token");
      },
      "/fake",
      () => [],
    ),
  ).toEqual({ status: "ambiguous", reason: "error" });
  expect(
    await safeSocketPost(
      async () => ({ status: "ambiguous", reason: "private-path-token" }) as never,
      "/fake",
      () => [],
    ),
  ).toEqual({ status: "ambiguous", reason: "error" });
});

test("socket admission refuses foreign uid, missing auth, noncanonical, nested and outside paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shepy-socket-admission-"));
  const expected = join(dir, "cc-socks");
  mkdirSync(expected);
  const path = join(expected, "fake.sock");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  const capability = { path, token: "fake-secret" };
  try {
    const registered = registerClaudeMessagingSocket(capability, expected);
    expect(registered).toMatchObject(capability);
    expect(registered?.identity).toEqual({
      dev: expect.stringMatching(/^\d+$/),
      ino: expect.stringMatching(/^\d+$/),
      birthtimeNs: expect.stringMatching(/^\d+$/),
      ctimeNs: expect.stringMatching(/^\d+$/),
    });
    expect(validateClaudeMessagingSocket(registered, expected)).toEqual(registered);
    expect(validateClaudeMessagingSocket(capability, expected)).toBeNull(); // Legacy cannot rebind.
    expect(registerClaudeMessagingSocket(capability)).toBeNull(); // Not the production directory.
    expect(registerClaudeMessagingSocket({ ...capability, token: "" }, expected)).toBeNull();
    if (!registered) throw new Error("socket not registered");
    for (const key of ["dev", "ino", "birthtimeNs", "ctimeNs"] as const) {
      const changed = {
        ...registered,
        identity: { ...registered.identity, [key]: "999999999999999999999" },
      };
      expect(validateClaudeMessagingSocket(changed, expected)).toBeNull();
      expect(
        parseRegisteredClaudeMessagingSocket({
          ...registered,
          identity: { ...registered.identity, [key]: 1 },
        }),
      ).toBeNull();
    }
    for (const identity of [undefined, null, {}, "bad", { dev: "1", ino: "1" }])
      expect(parseRegisteredClaudeMessagingSocket({ ...registered, identity })).toBeNull();
    for (const bad of [
      "relative.sock",
      `${expected}/../cc-socks/fake.sock`,
      `${expected}//fake.sock`,
      `${path}\n`,
      `${path}\0`,
    ])
      expect(registerClaudeMessagingSocket({ ...capability, path: bad }, expected)).toBeNull();
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Unix uid required for socket test");
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(registerClaudeMessagingSocket(capability, expected)).toBeNull();
    vi.restoreAllMocks();
    const nested = join(expected, "nested");
    mkdirSync(nested);
    symlinkSync(path, join(nested, "alias.sock"));
    expect(
      registerClaudeMessagingSocket({ ...capability, path: join(nested, "alias.sock") }, expected),
    ).toBeNull();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
