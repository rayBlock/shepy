import { basename } from "node:path";
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

const processInfoSchema = Type.Object(
  {
    type: Type.Literal("pane_process_info"),
    process_info: Type.Object(
      {
        pane_id: Type.String({ minLength: 1 }),
        foreground_process_group_id: Type.Integer({ minimum: 1 }),
        foreground_processes: Type.Array(
          Type.Object(
            {
              pid: Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER }),
              argv0: Type.Optional(Type.String({ minLength: 1 })),
              name: Type.Optional(Type.String({ minLength: 1 })),
            },
            { additionalProperties: true },
          ),
        ),
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
  claudeReplacement?: { previousSessionRefJson: string; subscriberId: string; claudePid?: number };
}): Promise<boolean> {
  const started = performance.now();
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
      if (
        !(
          result.pane.pane_id === input.paneId &&
          result.pane.terminal_id === input.terminalId &&
          current?.agent === "claude" &&
          current.kind === "id" &&
          current.source === "herdr:claude" &&
          current.value === input.claudeReplacement.subscriberId &&
          current.value !== previous.value
        )
      )
        return false;
      const pid = input.claudeReplacement.claudePid;
      if (!pid || !Number.isSafeInteger(pid) || pid < 2) return false;
      // SessionStart reports can be made by a child Claude. The claimant's
      // nearest Claude ancestor must also be the pane's sole foreground Claude.
      // Both Herdr calls share the original one-second deadline.
      const remaining = OWNER_TERMINAL_CHECK_MS - (performance.now() - started);
      if (remaining <= 0) return false;
      const processes = await client.getPaneProcessInfo({ pane_id: input.paneId }, remaining);
      if (
        performance.now() - started > OWNER_TERMINAL_CHECK_MS ||
        !Value.Check(processInfoSchema, processes) ||
        processes.process_info.pane_id !== input.paneId
      )
        return false;
      const claudes = processes.process_info.foreground_processes.filter((process) => {
        const command = process.argv0 ?? process.name;
        return (
          command !== undefined &&
          (basename(command) === "claude" || /\/claude\/versions\/[^/]+$/.test(command))
        );
      });
      return claudes.length === 1 && claudes[0]?.pid === pid;
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
