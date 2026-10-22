import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { HerdrSocketClient } from "@/herdr/socket-client.js";
import { parseAgentSessionRef } from "@/observability/contracts.js";

/** Below the hook's 5-second request deadline. No retry or index fallback. */
export const OWNER_TERMINAL_CHECK_MS = 1_000;

const paneListSchema = Type.Object(
  {
    type: Type.Literal("pane_list"),
    panes: Type.Array(
      Type.Object(
        { pane_id: Type.String({ minLength: 1 }), terminal_id: Type.String({ minLength: 1 }) },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const claudePaneSchema = Type.Object(
  {
    type: Type.Literal("pane_info"),
    pane: Type.Object(
      {
        pane_id: Type.String({ minLength: 1 }),
        terminal_id: Type.String({ minLength: 1 }),
        agent: Type.Literal("claude"),
        agent_session: Type.Unknown(),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

/** A complete live pane list proves terminal absence. In the same pane,
 * only Herdr's exact new Claude session proves replacement. Caller-supplied
 * location alone never proves the old session gone. Errors stay unknown. */
export async function ownerTerminalGone(input: {
  socketPath: string;
  paneId: string;
  terminalId: string;
  claudeReplacement?: { previousSessionRefJson: string; subscriberId: string };
}): Promise<boolean> {
  const client = new HerdrSocketClient({
    requestTimeoutMs: OWNER_TERMINAL_CHECK_MS,
    socketPath: input.socketPath,
  });
  try {
    if (input.claudeReplacement) {
      const previous = parseAgentSessionRef(
        JSON.parse(input.claudeReplacement.previousSessionRefJson),
      );
      if (
        previous?.agent !== "claude" ||
        previous.kind !== "id" ||
        previous.source !== "herdr:claude"
      )
        return false;
      const result = await client.getPane({ pane_id: input.paneId });
      if (!Value.Check(claudePaneSchema, result)) return false;
      const current = parseAgentSessionRef(result.pane.agent_session);
      return (
        result.pane.pane_id === input.paneId &&
        result.pane.terminal_id === input.terminalId &&
        current?.agent === "claude" &&
        current.kind === "id" &&
        current.source === "herdr:claude" &&
        current.value === input.claudeReplacement.subscriberId &&
        current.value !== previous.value
      );
    }
    const result = await client.listPanes();
    if (!Value.Check(paneListSchema, result)) return false;
    return !result.panes.some(
      (pane) => pane.terminal_id === input.terminalId || pane.pane_id === input.paneId,
    );
  } catch {
    return false;
  } finally {
    client.close();
  }
}
