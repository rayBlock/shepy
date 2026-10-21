import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readOwnerRecord } from "@/cli/owner-file.js";
import { OWNER_TERMINAL_CHECK_MS } from "@/herdr/owner-terminal.js";
import { HerdrSocketClient } from "@/herdr/socket-client.js";

/** Read only this session's credential, never scan other owner files or take a
 * token from argv. SessionEnd supplies its native hook session id; CLI release
 * obtains it from live Herdr rather than trusting a caller-chosen id. */
export function claudeReleaseProof(homeDir: string, profileId: string, sessionId: string) {
  const record = readOwnerRecord(homeDir, sessionId, profileId);
  if (!record) return null;
  try {
    const ref = JSON.parse(record.ownerSessionRefJson);
    if (
      ref.agent !== "claude" ||
      ref.kind !== "id" ||
      ref.source !== "herdr:claude" ||
      ref.value !== sessionId
    )
      return null;
    return { leaseToken: record.leaseToken, profileId };
  } catch {
    return null;
  }
}

const liveClaudeSchema = Type.Object(
  {
    agent: Type.Object(
      {
        agent: Type.Literal("claude"),
        pane_id: Type.String({ minLength: 1 }),
        workspace_id: Type.String({ minLength: 1 }),
        agent_session: Type.Object({
          agent: Type.Literal("claude"),
          kind: Type.Literal("id"),
          source: Type.Literal("herdr:claude"),
          value: Type.String({ minLength: 1 }),
        }),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

export async function callerClaudeSession(environment: NodeJS.ProcessEnv): Promise<string> {
  const {
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: paneId,
    HERDR_WORKSPACE_ID: workspaceId,
  } = environment;
  if (!socketPath || !paneId || !workspaceId)
    throw new Error("profile release requires a Claude Code session inside Herdr");
  const client = new HerdrSocketClient({ socketPath, requestTimeoutMs: OWNER_TERMINAL_CHECK_MS });
  try {
    const result = await client.getAgent({ target: paneId });
    if (
      !Value.Check(liveClaudeSchema, result) ||
      result.agent.pane_id !== paneId ||
      result.agent.workspace_id !== workspaceId
    ) {
      throw new Error("profile release cannot resolve this pane's live Claude session");
    }
    return result.agent.agent_session.value;
  } finally {
    client.close();
  }
}
