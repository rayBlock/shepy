import { lstatSync, realpathSync } from "node:fs";
import { Socket } from "node:net";
import { dirname, isAbsolute, normalize } from "node:path";

export const CLAUDE_SOCKET_DIRECTORY = "/tmp/cc-socks";
export type ClaudeMessagingSocket = { path: string; token: string };

/** Admission is fail-closed. A missing or invalid capability never disables hook delivery. */
export function validateClaudeMessagingSocket(
  value: ClaudeMessagingSocket | undefined | null,
  directory = CLAUDE_SOCKET_DIRECTORY,
): ClaudeMessagingSocket | null {
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
    const stat = lstatSync(path);
    if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return null;
    return { path, token: value.token };
  } catch {
    return null;
  }
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
