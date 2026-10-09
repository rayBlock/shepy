import { stripVTControlCharacters } from "node:util";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { agentIdentityLabel } from "./agent-display.js";
import type { AgentOutcome } from "./wake.js";

export const COLLAPSED_AGENT_UPDATE_LIMIT = 3;

export type AgentUpdateMessageDetails = {
  /** Build identity carried by each visible wake, not shown in the card. */
  build?: { pkgVersion: string; gitSha: string | null };
  eventIds: number[];
  outcomes: AgentOutcome[];
  /** Factory pulse line (tools/seat/factory-pulse.zsh stamp), composed at send time; absent = stale/missing. */
  pulse?: string;
};

export type ShepyFooterState =
  | { kind: "off" }
  | { kind: "on"; updateCount: number }
  | { kind: "profile"; pendingCount: number; profileId: string }
  | { kind: "reconnecting" };

type MessageLike = {
  content: string;
  details?: unknown;
};

type RenderOptions = { expanded: boolean };

type ThemeLike = {
  bg(color: string, text: string): string;
  bold(text: string): string;
  fg(color: string, text: string): string;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isAgentOutcome(value: unknown): value is AgentOutcome {
  const candidate = record(value);
  return (
    typeof candidate.agent === "string" &&
    typeof candidate.eventId === "number" &&
    (candidate.kind === "blocked" || candidate.kind === "completed") &&
    (candidate.name === undefined ||
      candidate.name === null ||
      typeof candidate.name === "string") &&
    (candidate.paneId === null || typeof candidate.paneId === "string") &&
    typeof candidate.terminalId === "string" &&
    typeof candidate.text === "string" &&
    typeof candidate.truncated === "boolean"
  );
}

function messageDetails(value: unknown): AgentUpdateMessageDetails {
  const details = record(value);
  return {
    eventIds: Array.isArray(details.eventIds)
      ? details.eventIds.filter((eventId): eventId is number => typeof eventId === "number")
      : [],
    outcomes: Array.isArray(details.outcomes) ? details.outcomes.filter(isAgentOutcome) : [],
    ...(typeof details.pulse === "string" && details.pulse.length > 0 ? { pulse: details.pulse } : {}),
  };
}

function cleanDisplayText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function updateCountLabel(count: number): string {
  return `${count} agent update${count === 1 ? "" : "s"}`;
}

export function formatShepyFooterStatus(
  state: ShepyFooterState,
): string | undefined {
  if (state.kind === "off") return undefined;
  if (state.kind === "reconnecting") return "◇ Shepy · reconnecting";
  if (state.kind === "profile") {
    const pending = state.pendingCount === 0 ? "" : ` · ${state.pendingCount} pending`;
    return `◆ Shepy · ${state.profileId}${pending}`;
  }

  const label = "◆ Shepy";
  if (state.updateCount === 0) return label;
  return `${label} · ${updateCountLabel(state.updateCount)}`;
}

export function renderAgentUpdateMessage(
  message: MessageLike,
  options: RenderOptions,
  theme: ThemeLike,
): Component {
  const details = messageDetails(message.details);
  const count = details.outcomes.length > 0 ? details.outcomes.length : details.eventIds.length;
  if (count === 0) {
    // Zero-count is never a nothing-burger: show the factory pulse when fresh, else nothing.
    if (details.pulse) {
      const line =
        theme.fg("customMessageLabel", `◆ ${theme.bold("Shepy")}`) +
        theme.fg("muted", ` quiet · ${cleanDisplayText(details.pulse)}`);
      return new Text(line, 0, 0);
    }
    return new Text("", 0, 0);
  }
  const heading =
    theme.fg("customMessageLabel", `◆ ${theme.bold("Shepy")}`) +
    theme.fg("muted", ` ${updateCountLabel(count)}`);
  const visibleOutcomes = options.expanded
    ? details.outcomes
    : details.outcomes.slice(0, COLLAPSED_AGENT_UPDATE_LIMIT);
  const rows = visibleOutcomes.flatMap((outcome) => {
    const completed = outcome.kind === "completed";
    const color = completed ? "success" : "warning";
    const glyph = completed ? "✓" : "!";
    const summary = [
      theme.fg(color, glyph),
      theme.bold(agentIdentityLabel({ agent: outcome.agent, name: outcome.name })),
      theme.fg(color, outcome.kind),
      theme.fg("muted", cleanDisplayText(outcome.paneId ?? "unknown")),
    ].join(" ");
    if (!options.expanded) return [summary];
    const cleanedResponse = cleanDisplayText(outcome.text);
    const response = cleanedResponse.length > 0 ? cleanedResponse : "No final response";
    return [summary, theme.fg("muted", `  Last response  ${response}`)];
  });
  const hiddenCount = details.outcomes.length - visibleOutcomes.length;
  const omission = hiddenCount > 0 ? theme.fg("muted", `… ${hiddenCount} more`) : undefined;
  // State of the world rides every message (lens wake-channel: the channel earns its interruption).
  const pulseLine = details.pulse ? theme.fg("muted", `· ${cleanDisplayText(details.pulse)}`) : undefined;
  const text = [heading, ...rows, omission, pulseLine].filter((line) => line !== undefined).join("\n");
  const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
  box.addChild(new Text(text, 0, 0));
  return box;
}
