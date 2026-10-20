import { lstatSync, realpathSync } from "node:fs";
import { Socket } from "node:net";
import { dirname, isAbsolute, normalize } from "node:path";

export const CLAUDE_SOCKET_DIRECTORY = "/tmp/cc-socks";
export type ClaudeMessagingSocket = { path: string; token: string };
export type RegisteredClaudeMessagingSocket = ClaudeMessagingSocket & {
  identity: { dev: string; ino: string; birthtimeNs: string; ctimeNs: string };
};

/** Capture identity only at registration, never upgrade an old capability during a wake. */
export function registerClaudeMessagingSocket(
  value: ClaudeMessagingSocket | undefined | null,
  directory = CLAUDE_SOCKET_DIRECTORY,
): RegisteredClaudeMessagingSocket | null {
  if (
    !value ||
    typeof value.path !== "string" ||
    typeof value.token !== "string" ||
    !value.token ||
    !process.getuid
  )
    return null;
  const path = value.path;
  if (!isAbsolute(path) || normalize(path) !== path || /[\0\r\n]/.test(path)) return null;
  try {
    // Resolve the platform's /tmp alias, but never follow a socket symlink or
    // accept a socket outside the expected directory (including nested paths).
    const expected = realpathSync(directory);
    if (realpathSync(dirname(path)) !== expected) return null;
    const parent = lstatSync(expected);
    if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o022) !== 0)
      return null;
    // Decimal strings retain the full device/inode and nanosecond timestamp
    // precision through JSON persistence (JSON cannot encode bigint).
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isSocket() || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n)
      return null;
    return {
      path,
      token: value.token,
      identity: {
        dev: String(stat.dev),
        ino: String(stat.ino),
        birthtimeNs: String(stat.birthtimeNs),
        ctimeNs: String(stat.ctimeNs),
      },
    };
  } catch {
    return null;
  }
}

/** Legacy/unbound or malformed persisted capabilities are absent until a new claim. */
export function parseRegisteredClaudeMessagingSocket(
  value: unknown,
): RegisteredClaudeMessagingSocket | null {
  if (!value || typeof value !== "object") return null;
  const socket = value as Partial<RegisteredClaudeMessagingSocket>;
  if (
    typeof socket.path !== "string" ||
    typeof socket.token !== "string" ||
    !socket.token ||
    !socket.identity ||
    typeof socket.identity !== "object" ||
    ![
      socket.identity.dev,
      socket.identity.ino,
      socket.identity.birthtimeNs,
      socket.identity.ctimeNs,
    ].every((part) => typeof part === "string" && /^\d+$/.test(part))
  )
    return null;
  return socket as RegisteredClaudeMessagingSocket;
}

/** Recheck admission AND the registered instance before connect and before frames.
 * Path metadata is not connected-peer authentication: replacement after the last
 * check (or inode/metadata reuse) can still race it. Claude's token is the second fence.
 */
export function validateClaudeMessagingSocket(
  value: unknown,
  directory = CLAUDE_SOCKET_DIRECTORY,
): RegisteredClaudeMessagingSocket | null {
  const registered = parseRegisteredClaudeMessagingSocket(value);
  if (!registered) return null;
  const current = registerClaudeMessagingSocket(registered, directory);
  if (
    !current ||
    current.identity.dev !== registered.identity.dev ||
    current.identity.ino !== registered.identity.ino ||
    current.identity.birthtimeNs !== registered.identity.birthtimeNs ||
    current.identity.ctimeNs !== registered.identity.ctimeNs
  )
    return null;
  return registered;
}

export type SocketOutcome =
  | { status: "posted-unacknowledged"; reason: "local-writes-complete" }
  | { status: "ambiguous"; reason: "timeout" | "error" | "early-close" };
export type SocketAdapter = (
  path: string,
  frames: () => readonly string[],
) => Promise<SocketOutcome>;
export interface SocketConnection {
  on(event: "error" | "close" | "end", listener: () => void): unknown;
  connect(path: string, listener: () => void): unknown;
  write(line: string, callback: (error?: Error | null) => void): boolean;
  destroy(): unknown;
}

/** Protocol copied from agent-factory tools/runner/socket.ts and wake.ts
 * (claude-2.1.257). Auth precedes the user frame. There is NO remote ack:
 * write callbacks prove only local flush, never confirmed delivery.
 * Shepy's stricter policy makes exactly one attempt, even on connect failure.
 */
export const wakeFrames = (token: string, line: string): readonly string[] => [
  `${JSON.stringify({ type: "auth", token })}\n`,
  `${JSON.stringify({ type: "user", message: { role: "user", content: line } })}\n`,
];

export function createSocketAdapter(
  connect: () => SocketConnection = () => new Socket(),
): SocketAdapter {
  return (path, frames) =>
    new Promise((resolve) => {
      const socket = connect();
      let settled = false;
      const finish = (outcome: SocketOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ status: "ambiguous", reason: "timeout" }), 1_000);
      socket.on("error", () => finish({ status: "ambiguous", reason: "error" }));
      socket.on("close", () => finish({ status: "ambiguous", reason: "early-close" }));
      socket.on("end", () => finish({ status: "ambiguous", reason: "early-close" }));
      try {
        socket.connect(path, () => {
          if (settled) return;
          try {
            const lines = frames();
            const write = (index: number): void => {
              if (settled) return;
              if (index === lines.length) {
                finish({ status: "posted-unacknowledged", reason: "local-writes-complete" });
                return;
              }
              try {
                const line = lines[index];
                if (line === undefined) throw new Error("missing socket frame");
                socket.write(line, (error) => {
                  if (error) finish({ status: "ambiguous", reason: "error" });
                  else write(index + 1);
                });
              } catch {
                finish({ status: "ambiguous", reason: "error" });
              }
            };
            write(0);
          } catch {
            finish({ status: "ambiguous", reason: "error" });
          }
        });
      } catch {
        finish({ status: "ambiguous", reason: "error" });
      }
    });
}

/** Never expose credential-bearing exceptions or adapter-controlled output. */
export async function safeSocketPost(
  adapter: SocketAdapter,
  path: string,
  frames: () => readonly string[],
): Promise<SocketOutcome> {
  try {
    const outcome = await adapter(path, frames);
    if (outcome.status === "posted-unacknowledged" && outcome.reason === "local-writes-complete")
      return { status: "posted-unacknowledged", reason: "local-writes-complete" };
    if (
      outcome.status === "ambiguous" &&
      ["timeout", "error", "early-close"].includes(outcome.reason)
    )
      return { status: "ambiguous", reason: outcome.reason };
  } catch {
    // Exceptions can contain the private path or token. Discard them.
  }
  return { status: "ambiguous", reason: "error" };
}
