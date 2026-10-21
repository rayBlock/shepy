import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { HerdrSocketClient } from "@/herdr/socket-client.js";

/** Below the hook's 5-second request deadline. No retry or index fallback. */
export const OWNER_TERMINAL_CHECK_MS = 1_000;

const paneListSchema = Type.Object(
  {
    type: Type.Literal("pane_list"),
    panes: Type.Array(
      Type.Object({ terminal_id: Type.String({ minLength: 1 }) }, { additionalProperties: true }),
    ),
  },
  { additionalProperties: true },
);

/** Only a complete live pane list proves absence. A transport failure,
 * unsupported method or malformed response is unknown, never "gone". */
export async function ownerTerminalGone(input: {
  socketPath: string;
  terminalId: string;
}): Promise<boolean> {
  const client = new HerdrSocketClient({
    requestTimeoutMs: OWNER_TERMINAL_CHECK_MS,
    socketPath: input.socketPath,
  });
  try {
    const result = await client.listPanes();
    if (!Value.Check(paneListSchema, result)) return false;
    return !result.panes.some((pane) => pane.terminal_id === input.terminalId);
  } catch {
    return false;
  } finally {
    client.close();
  }
}
