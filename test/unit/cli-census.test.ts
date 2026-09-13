import { describe, expect, test } from "vitest";
import {
  COMMAND_GROUP_VERBS,
  type CommandGroup,
  helpText,
  TOP_LEVEL_COMMANDS,
} from "@/cli/shepy.js";

/**
 * Census: the help output must list exactly what the parser accepts, in
 * both directions. The parseable set is DERIVED from the parser's own
 * command tables (COMMAND_GROUP_VERBS / TOP_LEVEL_COMMANDS — the same
 * tables the parsers consult for membership), never hand-listed here. A
 * verb added to a table without a help listing fails; a help listing
 * without a table entry fails; a parseable verb without a detail help
 * page fails. This exists because `shepy inbox --help` once shipped
 * listing only {list, retry} while the parser also accepted `retire`,
 * making the verb undiscoverable.
 */
function listedCommands(help: string): string[] {
  const lines = help.split("\n");
  const start = lines.indexOf("Commands:");
  if (start < 0) return [];
  const verbs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^ {2}(\S+)/.exec(line);
    if (!match) break;
    verbs.push(match[1] ?? "");
  }
  return verbs;
}

/** Help pages list commands in display order, tables in canonical order —
 * the census compares the SETS, not the sequence. */
function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe("CLI help census — help lists exactly what the parser accepts", () => {
  test("root help lists exactly the top-level commands", () => {
    expect(sorted(listedCommands(helpText("root")))).toEqual(sorted(TOP_LEVEL_COMMANDS));
  });

  test("every top-level command has a help page", () => {
    for (const command of TOP_LEVEL_COMMANDS) {
      expect(typeof helpText(command), `help page for ${command}`).toBe("string");
    }
  });

  for (const [group, verbs] of Object.entries(COMMAND_GROUP_VERBS) as [
    CommandGroup,
    readonly string[],
  ][]) {
    test(`${group} help lists exactly its parseable verbs`, () => {
      expect(sorted(listedCommands(helpText(group)))).toEqual(sorted(verbs));
    });

    for (const verb of verbs) {
      test(`${group} ${verb} has a detail help page`, () => {
        const topic = (
          group === "profile" && verb === "unsubscribe" ? "profile-subscribe" : `${group}-${verb}`
        ) as Parameters<typeof helpText>[0];
        expect(typeof helpText(topic), `help page for ${group} ${verb}`).toBe("string");
      });
    }
  }
});
