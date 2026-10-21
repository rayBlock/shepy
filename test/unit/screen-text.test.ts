import { describe, expect, test } from "vitest";
import {
  agentKindHasHistoryReader,
  agentKindUsesScreenFallback,
  boundScreenText,
  SCREEN_TAIL_MAX_CHARS,
  SCREEN_TAIL_MAX_LINES,
  screenTailFrom,
} from "@/agent-history/screen-text.js";

describe("screen text bound", () => {
  test("keeps an ordinary last answer and drops rules, prompts and blank lines", () => {
    const raw = [
      "────────────────────────",
      "I changed two files and the tests pass.",
      "",
      "❯ ",
      "────────────────────────",
      "  ? for shortcuts",
    ].join("\n");
    expect(boundScreenText(raw)).toBe("I changed two files and the tests pass.\n? for shortcuts");
  });

  test("strips ANSI sequences and control bytes", () => {
    const raw = "\u001b[31mred\u001b[0m text\u0007\u0000 with\u001b]0;title\u0007 bytes\u009b";
    const text = boundScreenText(raw);
    expect(text).toBe("red text with bytes");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive.
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  test("a 5 MB screen is bounded to the newest lines and characters", () => {
    const old = `OLDEST-LINE sk-${"a".repeat(40)}\n`;
    const filler = `\u001b[2K${"noise ".repeat(100)}\n`;
    const raw = `${old + filler.repeat(9_000)}the newest line\n`;
    expect(raw.length).toBeGreaterThan(5_000_000);
    const started = performance.now();
    const text = boundScreenText(raw);
    expect(performance.now() - started).toBeLessThan(500);
    expect(text.length).toBeLessThanOrEqual(SCREEN_TAIL_MAX_CHARS);
    expect(text.split("\n").length).toBeLessThanOrEqual(SCREEN_TAIL_MAX_LINES);
    expect(text.endsWith("the newest line")).toBe(true);
    expect(text).not.toContain("OLDEST-LINE");
    expect(text).not.toContain("shepy agent read");
  });

  test("one enormous line keeps its newest end without splitting a surrogate pair", () => {
    const text = boundScreenText(`${"😀".repeat(5_000)} tail`);
    expect(text.length).toBeLessThanOrEqual(SCREEN_TAIL_MAX_CHARS);
    expect(text.endsWith(" tail")).toBe(true);
    expect(text).not.toMatch(/^[\udc00-\udfff]/);
  });

  test("a screen with nothing readable is marked unavailable, not empty ok", () => {
    const empty = screenTailFrom("────\n❯\n", new Date(0));
    expect(empty).toEqual({
      capturedAt: "1970-01-01T00:00:00.000Z",
      status: "unavailable",
      text: "",
    });
    expect(screenTailFrom(null, new Date(0)).status).toBe("unavailable");
    expect(screenTailFrom("answer", new Date(0))).toMatchObject({ status: "ok", text: "answer" });
  });
});

describe("which kinds use the screen", () => {
  test.each([
    "pi",
    "claude",
    "codex",
    "opencode",
    "gemini",
    "hermes",
    "Claude",
  ])("%s has a reader and never falls back", (kind) => {
    expect(agentKindHasHistoryReader(kind)).toBe(true);
    expect(agentKindUsesScreenFallback(kind)).toBe(false);
  });

  test.each([
    "cursor",
    "amp",
    "droid",
    "copilot",
    "kimi",
  ])("%s has no reader and uses the screen", (kind) => {
    expect(agentKindUsesScreenFallback(kind)).toBe(true);
  });

  test("a missing kind is not claimed as reader-less", () => {
    expect(agentKindUsesScreenFallback(null)).toBe(false);
    expect(agentKindUsesScreenFallback("")).toBe(false);
  });
});
