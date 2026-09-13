import type { AgentHistoryMessage, AgentHistoryRef } from "@/observability/contracts.js";
import { projectPiContextHealth } from "./context-health.js";
import {
  type AgentHistoryReader,
  compactFromMessages,
  type JsonlEntry,
  limitMessages,
  readJsonl,
} from "./readers.js";
import { messageRef, textFromContent, timestampFrom } from "./text.js";
import { compactToolResult } from "./tool-compaction.js";

export class PiHistoryReader implements AgentHistoryReader {
  canRead(ref: AgentHistoryRef): boolean {
    return ref.source === "pi-jsonl" && Boolean(ref.path ?? ref.value);
  }

  async read(
    ref: AgentHistoryRef,
    options: { limit?: number } = {},
  ): Promise<AgentHistoryMessage[]> {
    const path = ref.path ?? ref.value;
    return limitMessages(messagesFromEntries(path, await readJsonl(path)), options.limit);
  }

  async readCompact(ref: AgentHistoryRef) {
    // One read serves both projections: the message extraction and the
    // context-health projection walk the same parsed entries.
    const path = ref.path ?? ref.value;
    const entries = await readJsonl(path);
    return compactFromMessages(
      ref,
      messagesFromEntries(path, entries),
      projectPiContextHealth(path, entries),
    );
  }
}

function messagesFromEntries(path: string, entries: JsonlEntry[]): AgentHistoryMessage[] {
  const messages: AgentHistoryMessage[] = [];
  for (const entry of entries) {
    const message = record(entry.value.message);
    const role = stringValue(message.role);
    if (entry.value.type !== "message" || !role) continue;
    const id = stringValue(entry.value.id);
    const timestamp = timestampFrom(entry.value.timestamp) ?? timestampFrom(message.timestamp);
    const refValue = messageRef(path, id ?? undefined, entry.line);
    if (role === "user" || role === "assistant") {
      const text = textFromContent(message.content);
      if (text) messages.push({ ref: refValue, role, text, timestamp });
    }
    if (role === "toolResult") {
      const text = textFromContent(message.content) ?? "";
      const toolName = stringValue(message.toolName) ?? "unknown";
      messages.push({
        compact: compactToolResult({
          isError: message.isError === true,
          ref: refValue,
          text,
          toolName,
        }),
        ref: refValue,
        role: "tool_result",
        text: compactToolResult({
          isError: message.isError === true,
          ref: refValue,
          text,
          toolName,
        }).text,
        timestamp,
        toolName,
      });
    }
  }
  return messages;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
