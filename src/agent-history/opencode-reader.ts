import { DatabaseSync } from "node:sqlite";
import type { AgentHistoryMessage, AgentHistoryRef } from "@/observability/contracts.js";
import { type AgentHistoryReader, compactFromMessages, limitMessages } from "./readers.js";
import { messageRef, textFromContent, timestampFrom } from "./text.js";
import { compactToolResult } from "./tool-compaction.js";

type OpenCodeRow = {
  message_id: string;
  message_time: number;
  part_data: string | null;
  part_id: string | null;
  part_time: number | null;
  role: string | null;
};

export class OpenCodeHistoryReader implements AgentHistoryReader {
  canRead(ref: AgentHistoryRef): boolean {
    return ref.source === "opencode-sqlite" && Boolean(ref.path) && Boolean(ref.value);
  }

  async read(
    ref: AgentHistoryRef,
    options: { limit?: number } = {},
  ): Promise<AgentHistoryMessage[]> {
    const dbPath = ref.path;
    if (!dbPath || !ref.value)
      throw new Error("OpenCode history: missing store or session identity");
    let sqlite: DatabaseSync | null = null;
    try {
      sqlite = new DatabaseSync(dbPath, { readOnly: true });
      const tables = sqlite
        .prepare(
          "select name from sqlite_master where type = 'table' and name in ('session', 'session_v2')",
        )
        .all() as { name: string }[];
      const has = (name: string) => tables.some((table) => table.name === name);
      // Never use the other family as a fallback after an exact session miss.
      if (
        has("session_v2") &&
        sqlite.prepare("select id from session_v2 where id = ?").get(ref.value)
      ) {
        return limitMessages(readV2(sqlite, dbPath, ref.value), options.limit);
      }
      if (
        !has("session") ||
        !sqlite.prepare("select id from session where id = ?").get(ref.value)
      ) {
        throw new Error("OpenCode history: exact session not found");
      }
      const rows = sqlite
        .prepare(`
          select
            m.id as message_id,
            m.time_created as message_time,
            json_extract(m.data, '$.role') as role,
            p.id as part_id,
            p.time_created as part_time,
            p.data as part_data
          from message m
          left join part p on p.message_id = m.id
          where m.session_id = ?
          order by m.time_created asc, p.time_created asc, p.id asc
        `)
        .all(ref.value) as OpenCodeRow[];

      const messages: AgentHistoryMessage[] = [];
      for (const row of rows) {
        if (!row.part_data) continue;
        const part = parseJsonRecord(row.part_data);
        const partType = stringValue(part.type);
        const timestamp = timestampFrom(row.part_time ?? row.message_time);
        const refValue = messageRef(dbPath, row.part_id ?? row.message_id, 0);

        if (partType === "text") {
          const role = row.role === "assistant" || row.role === "user" ? row.role : null;
          const text = stringValue(part.text) ?? textFromContent(part.content);
          if (role && text) messages.push({ ref: refValue, role, text, timestamp });
          continue;
        }

        if (partType === "tool") {
          const toolName = stringValue(part.tool) ?? "unknown";
          const state = record(part.state);
          const output = state.output ?? state.error ?? part.output ?? part.content ?? part;
          const text = typeof output === "string" ? output : JSON.stringify(output);
          const isError = Boolean(state.error) || stringValue(state.status) === "error";
          const compact = compactToolResult({ isError, ref: refValue, text, toolName });
          messages.push({
            compact,
            ref: refValue,
            role: "tool_result",
            text: compact.text,
            timestamp,
            toolName,
          });
        }
      }
      return limitMessages(messages, options.limit);
    } finally {
      sqlite?.close();
    }
  }

  async readCompact(ref: AgentHistoryRef) {
    return compactFromMessages(ref, await this.read(ref));
  }
}

// V2 store (opencode 2.x, live-checked against 2.0.25): one session_message row
// per entry, the entry kind in the `type` column. Conversation rows are `user`
// ({text}) and `assistant` ({content:[reasoning|text|tool parts], finish,
// error}); the remaining kinds are session bookkeeping, not conversation.
const V2_NON_CONVERSATION = new Set([
  "compaction",
  "idle",
  "model-switched",
  "synthetic",
  "system",
]);

function readV2(sqlite: DatabaseSync, dbPath: string, sessionId: string): AgentHistoryMessage[] {
  const rows = sqlite
    .prepare(`
    select id, type, time_created, data from session_message
    where session_id = ? order by seq asc, id asc
  `)
    .all(sessionId) as { id: string; type: string; time_created: number; data: string }[];
  const messages: AgentHistoryMessage[] = [];
  for (const row of rows) {
    if (V2_NON_CONVERSATION.has(row.type)) continue;
    const data = JSON.parse(row.data) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("OpenCode history: malformed V2 message");
    }
    const message = record(data);
    const timestamp = timestampFrom(row.time_created);
    if (row.type === "user") {
      const text = stringValue(message.text);
      if (!text) throw new Error("OpenCode history: unsupported V2 message shape");
      messages.push({ ref: messageRef(dbPath, row.id, 0), role: "user", text, timestamp });
      continue;
    }
    if (row.type !== "assistant" || !Array.isArray(message.content)) {
      throw new Error("OpenCode history: unsupported V2 message shape");
    }
    // Text parts carry no id of their own; the row id is their source entry.
    const textParts: string[] = [];
    for (const [index, value] of message.content.entries()) {
      const part = record(value);
      const type = stringValue(part.type);
      if (type === "text") {
        const text = stringValue(part.text);
        if (text) textParts.push(text);
      } else if (type === "tool") {
        const refValue = messageRef(dbPath, stringValue(part.id) ?? undefined, index);
        const toolName = stringValue(part.name) ?? "unknown";
        const state = record(part.state);
        const failure = record(state.error);
        const isError =
          stringValue(state.status) === "error" ||
          Object.keys(failure).length > 0 ||
          (typeof record(state.metadata).exit === "number" && record(state.metadata).exit !== 0);
        const text =
          textFromContent(state.content) ??
          stringValue(failure.message) ??
          JSON.stringify(state.content ?? state.error ?? null);
        const compact = compactToolResult({ isError, ref: refValue, text, toolName });
        messages.push({
          compact,
          ref: refValue,
          role: "tool_result",
          text: compact.text,
          timestamp,
          toolName,
        });
      }
    }
    // A failed turn has no answer text; surface its error rather than letting
    // the previous turn's answer stand in as this outcome.
    const turnError = stringValue(record(message.error).message);
    const text =
      textParts.length > 0
        ? textParts.join("\n")
        : stringValue(message.finish) === "error" && turnError
          ? `OpenCode turn failed: ${turnError}`
          : null;
    if (text) {
      messages.push({ ref: messageRef(dbPath, row.id, 0), role: "assistant", text, timestamp });
    }
  }
  return messages;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
