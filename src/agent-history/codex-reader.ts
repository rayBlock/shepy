import type { AgentHistoryMessage, AgentHistoryRef } from "@/observability/contracts.js";
import {
  type AgentHistoryReader,
  compactFromMessages,
  limitMessages,
  readJsonl,
} from "./readers.js";
import { projectCodexContextHealth } from "./codex-context.js";
import { messageRef, textFromContent, timestampFrom } from "./text.js";
import { compactToolResult } from "./tool-compaction.js";

export class CodexHistoryReader implements AgentHistoryReader {
  canRead(ref: AgentHistoryRef): boolean {
    return ref.source === "codex-jsonl" && Boolean(ref.path ?? ref.value);
  }

  async read(
    ref: AgentHistoryRef,
    options: { limit?: number } = {},
  ): Promise<AgentHistoryMessage[]> {
    const path = ref.path ?? ref.value;
    const messages: AgentHistoryMessage[] = [];
    const toolNamesByCallId = new Map<string, string>();

    const entries = await readJsonl(path);
    if (!matchesSession(ref, entries)) return [];
    for (const entry of entries) {
      const type = stringValue(entry.value.type);
      const payload = record(entry.value.payload);
      const payloadType = stringValue(payload.type);
      const id =
        stringValue(payload.id) ?? stringValue(payload.call_id) ?? stringValue(entry.value.id);
      const timestamp =
        timestampFrom(entry.value.timestamp) ??
        codexTimestamp(payload.timestamp) ??
        codexTimestamp(payload.started_at);
      const refValue = messageRef(path, id ?? undefined, entry.line);

      if (type === "event_msg") {
        if (payloadType === "user_message") {
          const text = stringValue(payload.message);
          if (text && !isSystemCodexMessage(text)) {
            messages.push({ ref: refValue, role: "user", text, timestamp });
          }
          continue;
        }
        if (payloadType === "agent_message") {
          const text = stringValue(payload.message);
          if (text) messages.push({ ref: refValue, role: "assistant", text, timestamp });
          continue;
        }
        if (payloadType === "task_complete") {
          const text = stringValue(payload.last_agent_message);
          if (text) messages.push({ ref: refValue, role: "assistant", text, timestamp });
          continue;
        }
      }

      if (type !== "response_item") continue;

      if (payloadType === "function_call" || payloadType === "custom_tool_call") {
        const callId = stringValue(payload.call_id);
        const name = stringValue(payload.name);
        if (callId && name) toolNamesByCallId.set(callId, name);
        continue;
      }

      if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
        const callId = stringValue(payload.call_id);
        const toolName = (callId ? toolNamesByCallId.get(callId) : null) ?? "unknown";
        const text = textFromCodexOutput(payload.output);
        const compact = compactToolResult({ isError: false, ref: refValue, text, toolName });
        messages.push({
          compact,
          ref: refValue,
          role: "tool_result",
          text: compact.text,
          timestamp,
          toolName,
        });
        continue;
      }

      if (payloadType === "message") {
        const role = stringValue(payload.role);
        if (role === "developer") continue;
        if (role === "user") {
          const text = textFromCodexContent(payload.content, "input_text");
          if (text && !isSystemCodexMessage(text)) {
            messages.push({ ref: refValue, role: "user", text, timestamp });
          }
          continue;
        }
        if (role === "assistant") {
          const text =
            textFromCodexContent(payload.content, "output_text") ??
            textFromContent(payload.content);
          if (text) messages.push({ ref: refValue, role: "assistant", text, timestamp });
        }
      }
    }

    return limitMessages(messages, options.limit);
  }

  async readCompact(ref: AgentHistoryRef) {
    const path = ref.path ?? ref.value;
    const entries = await readJsonl(path);
    if (!matchesSession(ref, entries)) return compactFromMessages(ref, []);
    return compactFromMessages(
      ref,
      await this.read(ref),
      projectCodexContextHealth(path, entries),
    );
  }
}

// Native Codex turn fields use Unix seconds; other readers keep timestampFrom's
// millisecond semantics. Outer event timestamps denote completion, not start.
function codexTimestamp(value: unknown): string | null {
  if (typeof value !== "number") return timestampFrom(value);
  if (!Number.isFinite(value)) return null;
  const date = new Date(Math.abs(value) < 1e11 ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function matchesSession(ref: AgentHistoryRef, entries: Awaited<ReturnType<typeof readJsonl>>): boolean {
  if (ref.kind !== "agent_session" || ref.value === (ref.path ?? ref.value)) return true;
  const ids = entries
    .filter((entry) => entry.value.type === "session_meta")
    .map((entry) => stringValue(record(entry.value.payload).id));
  return ids.length > 0 && ids.every((id) => id === ref.value);
}

function textFromCodexContent(content: unknown, blockType: string): string | null {
  if (!Array.isArray(content)) return typeof content === "string" ? content : null;
  const parts = content
    .map((block) => {
      const item = record(block);
      if (item.type !== blockType) return "";
      return stringValue(item.text) ?? "";
    })
    .filter((part) => part.trim().length > 0);
  return parts.length > 0 ? parts.join("\n") : null;
}

function textFromCodexOutput(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? "");
}

function isSystemCodexMessage(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<environment_context>") || trimmed.startsWith("<user_instructions>");
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
