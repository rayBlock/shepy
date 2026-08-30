import { describe, expect, test } from "vitest";

function expectParseError(result: unknown): { error: string; detail: string } {
  expect(result).toMatchObject({ error: expect.any(String) });
  return result as { error: string; detail: string };
}

import {
  parseAgentSelector,
  parseWorkspaceSelector,
  resolveAgentSelector,
  type SelectableAgent,
  selectableFromRow,
} from "../../src/observability/profile-selectors.js";

function agent(overrides: Partial<SelectableAgent> = {}): SelectableAgent {
  return {
    agent: "hermes",
    agentSessionId: "20260830_000000_abc",
    cwd: "/Users/ray/dev/driffs",
    herdrSessionName: "default",
    id: "ag-1",
    name: null,
    paneId: "wS:p1",
    terminalId: "term_1",
    workspaceId: "wS",
    ...overrides,
  };
}

describe("workspace selector parsing", () => {
  test("accepts an exact session+workspace pair", () => {
    expect(
      parseWorkspaceSelector(JSON.stringify({ herdrSession: "default", workspaceId: "wS" })),
    ).toEqual({
      herdrSession: "default",
      workspaceId: "wS",
    });
  });

  test("rejects missing or empty fields and non-JSON", () => {
    expect(expectParseError(parseWorkspaceSelector("{nope")).error).toBe(
      "invalid_workspace_selector",
    );
    expect(
      expectParseError(parseWorkspaceSelector(JSON.stringify({ workspaceId: "wS" }))).error,
    ).toBe("invalid_workspace_selector");
    expect(
      expectParseError(
        parseWorkspaceSelector(JSON.stringify({ herdrSession: "", workspaceId: "wS" })),
      ).error,
    ).toBe("invalid_workspace_selector");
    expect(
      expectParseError(parseWorkspaceSelector(JSON.stringify({ herdrSession: "default" }))).error,
    ).toBe("invalid_workspace_selector");
  });
});

describe("agent selector parsing", () => {
  test("accepts every documented kind", () => {
    expect(parseAgentSelector(JSON.stringify({ kind: "terminalId", value: "term_1" }))).toEqual({
      kind: "terminalId",
      value: "term_1",
    });
    expect(parseAgentSelector(JSON.stringify({ kind: "paneId", value: "wS:p1" }))).toEqual({
      kind: "paneId",
      value: "wS:p1",
    });
    expect(parseAgentSelector(JSON.stringify({ kind: "name", value: "driffs-worker" }))).toEqual({
      kind: "name",
      value: "driffs-worker",
    });
    expect(
      parseAgentSelector(JSON.stringify({ kind: "agentSession", value: "20260830_000000_abc" })),
    ).toEqual({
      kind: "agentSession",
      value: "20260830_000000_abc",
    });
    expect(
      parseAgentSelector(
        JSON.stringify({ kind: "runtimeKindPlusCwd", agent: "hermes", cwd: "/x" }),
      ),
    ).toEqual({
      kind: "runtimeKindPlusCwd",
      agent: "hermes",
      cwd: "/x",
    });
  });

  test("rejects glob strings, unknown kinds, and empty values — fail closed", () => {
    expect(expectParseError(parseAgentSelector(JSON.stringify("driffs-*"))).error).toBe(
      "invalid_agent_selector",
    );
    expect(
      expectParseError(parseAgentSelector(JSON.stringify({ kind: "glob", value: "*" }))).error,
    ).toBe("invalid_agent_selector");
    expect(
      expectParseError(parseAgentSelector(JSON.stringify({ kind: "name", value: "" }))).error,
    ).toBe("invalid_agent_selector");
    expect(
      expectParseError(
        parseAgentSelector(JSON.stringify({ kind: "runtimeKindPlusCwd", agent: "hermes" })),
      ).error,
    ).toBe("invalid_agent_selector");
  });
});

describe("agent selector resolution (scope pre-filtered by the caller)", () => {
  test("resolves by exact name — the preferred kind", () => {
    const result = resolveAgentSelector({ kind: "name", value: "driffs-worker" }, [
      agent({ id: "ag-1", name: null }),
      agent({ id: "ag-2", name: "driffs-worker" }),
    ]);
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") expect(result.agent.id).toBe("ag-2");
  });

  test("ambiguous match fails closed with the candidate list", () => {
    const result = resolveAgentSelector(
      { kind: "runtimeKindPlusCwd", agent: "hermes", cwd: "/Users/ray/dev/driffs" },
      [
        agent({ id: "ag-1", paneId: "wS:p1" }),
        agent({ id: "ag-2", paneId: "wS:p2", agentSessionId: "20260830_000001_def" }),
      ],
    );
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.candidates).toHaveLength(2);
  });

  test("two agents named identically also fail closed", () => {
    const result = resolveAgentSelector({ kind: "name", value: "worker" }, [
      agent({ id: "ag-1", name: "worker" }),
      agent({ id: "ag-2", name: "worker", paneId: "wS:p2" }),
    ]);
    expect(result.kind).toBe("ambiguous");
  });

  test("unmatched reports the selector in its detail", () => {
    const result = resolveAgentSelector({ kind: "name", value: "nobody" }, [agent()]);
    expect(result.kind).toBe("unmatched");
    if (result.kind === "unmatched") expect(result.detail).toContain("name nobody");
  });

  test("same pane id in a different session is not reachable — scope is the caller's filter, proven here", () => {
    // The caller filters candidates to (herdrSession, workspace) BEFORE
    // resolution; an agent with paneId wS:p1 in ANOTHER session never
    // enters the candidate list. This test documents the contract.
    const scoped = [agent()].filter(
      (candidate) => candidate.herdrSessionName === "default" && candidate.workspaceId === "wS",
    );
    const foreign = agent({ herdrSessionName: "other-session", id: "ag-9" });
    expect(scoped).not.toContain(foreign);
    expect(resolveAgentSelector({ kind: "paneId", value: "wS:p1" }, scoped).kind).toBe("matched");
  });
});

describe("selectableFromRow", () => {
  test("extracts the agent session value from the stored JSON", () => {
    const row = {
      agent: "hermes",
      agentSessionJson: JSON.stringify({
        kind: "id",
        source: "herdr:hermes",
        value: "20260822_115251_c80507",
      }),
      cwd: "/Users/ray/dev/driffs",
      herdrSessionName: "default",
      id: "ag-1",
      name: "driffs-worker",
      paneId: "wS:p1",
      terminalId: "term_1",
      workspaceId: "wS",
    };
    const selectable = selectableFromRow(row);
    expect(selectable.agentSessionId).toBe("20260822_115251_c80507");
    expect(selectable.name).toBe("driffs-worker");
  });

  test("null session JSON stays null; malformed JSON degrades to null, never throws", () => {
    expect(selectableFromRow({} as never).agentSessionId).toBe(null);
    expect(
      selectableFromRow({
        agent: null,
        agentSessionJson: "{broken",
        cwd: null,
        herdrSessionName: "default",
        id: "ag-1",
        name: null,
        paneId: "wS:p1",
        terminalId: null,
        workspaceId: "wS",
      }).agentSessionId,
    ).toBe(null);
  });
});
