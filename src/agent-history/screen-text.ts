import { stripVTControlCharacters } from "node:util";
import type { ScreenTail } from "@/observability/contracts.js";

/** Lines requested from Herdr; it bounds the read on its side. */
export const SCREEN_READ_LINES = 60;
/** The daemon never waits longer than this for one screen read. */
export const SCREEN_READ_TIMEOUT_MS = 1_500;
/** What a notice carries: the last lines of the screen, newest last. */
export const SCREEN_TAIL_MAX_LINES = 20;
export const SCREEN_TAIL_MAX_CHARS = 1_500;
/** Cut before any regex runs, whatever Herdr returned. */
const SCREEN_RAW_MAX_CHARS = 64 * 1024;

/**
 * Agent kinds that have a history reader (see createAgentHistoryService).
 * The decision is by kind, never by "the reader found nothing": a Claude pane
 * whose transcript is missing stays empty rather than showing screen text.
 */
const HISTORY_READER_KINDS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "gemini",
  "hermes",
  "opencode",
  "pi",
]);

export function agentKindHasHistoryReader(kind: string | null | undefined): boolean {
  return typeof kind === "string" && HISTORY_READER_KINDS.has(kind.toLowerCase());
}

/** Only a detected agent kind without a reader may fall back to the screen. */
export function agentKindUsesScreenFallback(kind: string | null | undefined): boolean {
  return typeof kind === "string" && kind.length > 0 && !agentKindHasHistoryReader(kind);
}

/**
 * Screen read to bounded plain text: ANSI and control bytes stripped, lines
 * with no letter or digit (rules, prompts, box drawing) dropped, the last
 * lines kept. Returns "" when nothing readable is left.
 */
export function boundScreenText(raw: string): string {
  const tail = raw.length > SCREEN_RAW_MAX_CHARS ? raw.slice(-SCREEN_RAW_MAX_CHARS) : raw;
  const lines = stripVTControlCharacters(tail)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional C0/C1 stripping — screen text is untrusted.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => /[\p{L}\p{N}]/u.test(line));
  const text = lines.slice(-SCREEN_TAIL_MAX_LINES).join("\n");
  if (text.length <= SCREEN_TAIL_MAX_CHARS) return text;
  // Keep the newest end; do not cut a surrogate pair.
  let start = text.length - SCREEN_TAIL_MAX_CHARS;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
}

export function screenTailFrom(raw: string | null, capturedAt: Date): ScreenTail {
  const text = raw === null ? "" : boundScreenText(raw);
  return {
    capturedAt: capturedAt.toISOString(),
    status: text.length > 0 ? "ok" : "unavailable",
    text,
  };
}
