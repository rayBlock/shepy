// factory-pulse reader — one-line factory state stamped by tools/seat/factory-pulse.zsh
// (lens wake-channel builds #1+#2). Read at COMPOSE time (async sites only — renderer stays
// pure sync). Fresh <10min = trustworthy; stale/missing = null and the bridge falls back.
import { readFileSync, statSync } from "node:fs";

const PULSE_PATH = `${process.env.HOME ?? ""}/.factory/pulse.json`;
const PULSE_TTL_MS = 10 * 60 * 1000;

export function readPulseLine(): string | null {
  try {
    const st = statSync(PULSE_PATH);
    if (Date.now() - st.mtimeMs > PULSE_TTL_MS) return null;
    const parsed = JSON.parse(readFileSync(PULSE_PATH, "utf8")) as { line?: unknown };
    return typeof parsed.line === "string" && parsed.line.length > 0 ? parsed.line : null;
  } catch {
    return null;
  }
}
