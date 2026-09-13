RUN-20260913-09 — ADDENDUM 1 (from ops, 19:4xZ). REPLACES D2/D3 and R2–R4 of your packet. Same scope, rails, report and sentinel. If you already implemented the "any lifecycle row since submission" guard, change it; do not keep both.

## Why

"Any lifecycle row after submittedAt" is not completion evidence for THIS operation:
- a focus-only transition `done → idle` (the human looked at the tab) after submission is a row about the PREVIOUS completion; the new prompt may never have started;
- a `to: "working"` row alone proves the prompt started, not that it finished;
- rows for another operation's completion on the same terminal, if that operation was still running when this one was submitted (Pi queues a second prompt as steering), are not this operation's epoch.

## D2' — execution-epoch query (read-only), `src/db/agent-events.ts`

`hasCompletionEpochSince(input: { herdrSessionName: string; paneId: string; terminalId: string | null; sinceMs: number }): boolean` — true iff BOTH:
1. there is a row R1 on the target (same `herdr_session_name`; `terminal_id = terminalId` when non-null, else `pane_id = paneId`) with `created_at >= sinceMs`, `type = 'agent.status.changed'` and payload `to === "working"`; take the EARLIEST such row (lowest id);
2. there is a row R2 on the same target with `id > R1.id` and (`type in ('agent.idle','agent.done','agent.blocked')` OR (`type = 'agent.status.changed'` and payload `to in ('idle','done','blocked')`)).
Payload is `payload_json`; read `to` with `json_extract(payload_json, '$.to')` in SQL (SQLite has JSON1) or fetch the candidate rows and inspect in TS — either is fine, one or two prepared statements, bounded (`limit`).

## D3' — wait service

Same as D3 but call `hasCompletionEpochSince`. On `settled` or `blocked` from Herdr with no epoch → `target_not_started`, `error_summary` = "no working→settled epoch for the target since submission — prompt may not have taken or the observed state belongs to an earlier completion", state stays `submitted`, re-waitable. Everything else unchanged. Note the fail-closed lag case in a comment: if Herdr returns settled before the daemon indexed the settled row, the wait reports `target_not_started` once and the next wait settles.

## R2' store tests (replace R2)

(a) working row then idle row, both after since → true; (b) focus-only `done → idle` row after since, nothing else → false; (c) working row after since, no later settled row → false; (d) previous completion (working+idle) BEFORE since, then a focus-only `done → idle` after since → false; (e) op1 running since before `since`, its idle row after `since`, no new working row → false; (f) two full epochs after since → true; (g) rows on another terminal or another herdr session → false; (h) pane fallback when terminalId null; (i) `agent.tool.failed` between working and idle does not break or satisfy anything by itself.

## R3' wait-service tests (replace R3)

As before but the fake store models the epoch predicate: false → `target_not_started` (state submitted, lifecycle/settledAt null, errorSummary set); then true → settles; `blocked` with false → `target_not_started`; `transport_unknown` unchanged.

## R4' RPC tests (replace R4)

Real stores, fake Herdr returning idle `agent_info`: (a) rows working(T+1 s) + idle(T+7 min) after submit T → settled; (b) only an idle row before T → `target_not_started`; (c) the COA's case: previous completion before T, then ONLY a `done → idle` status.changed row after T → `target_not_started`, no RPC error; (d) overlapping: op1 submitted T1 with working row T1+1, op2 submitted T3 (T1 < T3 < op1's idle row at T2), op1's idle row at T2 > T3 — op2's wait → `target_not_started`; op1's wait → settled; (e) the real sample spacing (idle T0, submit T0+129 s, working T0+130 s, status.changed+idle T0+577 s) → settled.

Everything else in the original packet stands (D1 until list, D4 help/doc lines, R1, R5, report, sentinel, rails). Budget unchanged. Report R2'–R4' under the same requirement table.
