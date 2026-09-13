RUN-20260913-09 / operation wait settles on idle + not-started guard / attempt 1 — BUILDER packet

Work ONLY in:
  cwd     ~/dev/shepy-wt/waitfix
  branch  pilot/wait-idle-settle   (base c518663 on the shepy branch)
Never touch ~/dev/shepy, ~/.shepy, or other worktrees. No daemon start/stop, no installs, no schema/migration changes, no `git push`, no model switching. Fixtures synthetic.

## The defect (verified by ops from durable rows, 19:33–19:36Z today)

`shepy wait <operationId>` (RPC `operation.wait`) never returns when the worker finishes with Herdr status `idle`. Herdr 0.8 reports a finished agent as `done` when its tab was NOT seen in the focused UI, and as `idle` when it WAS seen. Which one you get depends on where the human's focus was, not on the operation. `src/herdr/orchestration-transport-adapter.ts:60` requests `until: ["done", "blocked"]`, so an `idle` finish never matches and the Herdr wait blocks forever. `herdr agent wait --help`: "Without --until, matches idle, done, or blocked." `lifecycleOutcome` already maps `idle` → `settled`; only the request filter is wrong.

Real rows (daemon `agent_events`, read-only): failing sample op `op_4c90b6d3e9a7a16b5051015d` (created 18:43:54.627Z, still `submitted`) — its pane `wP:p8F` / terminal `term_65b61a11c5958b7` has `agent.status.changed {from:"working", to:"idle"}` + `agent.idle` at 18:51:22 (ids 18604/18605) and again 19:05:44 (18636). Settling sample `op_6fb4ea5693a044ce6509311b` — its pane ended with `agent.done` (18586) at 18:39:13 and the wait settled.

## The race the fix opens

The same worker was `idle` at 18:41:45 (agent.idle 18591) BEFORE the dispatch at 18:43:54; it went `working` at 18:43:55 (18592). A wait armed between dispatch and that transition, with `idle` in the filter, would return instantly on the stale idle state and falsely settle. Guard from durable evidence: a genuine completion after submission always leaves a lifecycle event for the target terminal with `created_at >= submittedAt` (status change to working, or agent.idle/done/blocked). No such row → the settle is stale → do not settle.

`agent_events` columns: `id, type, pane_id, terminal_id, herdr_session_name, workspace_id, created_at (ms), payload_json`. Types seen: `agent.status.changed` (payload `{from, to, paneId, terminalId, …}`), `agent.idle`, `agent.done`, `agent.blocked`, `agent.tool.failed`. `OperationRecord` has `target {paneId, terminalId|null, herdrSessionName, workspaceId}` (see `src/db/operations.ts` `OperationTarget`) and `submittedAt` (ms in the row; check the record type for the field name and unit).

## Design (decided by ops — build this)

D1. Adapter: `until: ["idle", "done", "blocked"]` — Herdr's default settled set, stated explicitly. Update the unit test that pins the request (`test/unit/herdr-orchestration-transport-adapter.test.ts` ~line 89) — RED first (the old pin fails), then GREEN. Keep `blocked` → `blocked`, `failed` → `failed`, unknown → `transport_unknown`.
D2. `AgentEventStore.hasLifecycleEventSince(input: { herdrSessionName: string; paneId: string; terminalId: string | null; sinceMs: number }): boolean` in `src/db/agent-events.ts`. Read-only. Matches rows with the same `herdr_session_name`, `created_at >= sinceMs`, and (`terminal_id = terminalId` when terminalId is non-null, else `pane_id = paneId`), and `type in ('agent.status.changed','agent.idle','agent.done','agent.blocked')`. One prepared statement; `limit 1`.
D3. `OperationWaitService` constructor gains `events: Pick<AgentEventStore, "hasLifecycleEventSince">` (wire it in `src/daemon/service.ts` line ~81 — the store already exists there; find its variable). In `applyLifecycle`, when the event kind is `settled` or `blocked`: if the operation has a `submittedAt` and `events.hasLifecycleEventSince({ …operation.target, sinceMs: submittedAt - 5_000 })` is false → do NOT settle; call the existing `recordWaitError({ operationId, errorSummary: "settled state observed but no lifecycle event for the target since submission — prompt may not have taken" })` and return the new `WaitOutcome` `{ kind: "target_not_started", operationId, detail }`. Otherwise settle as today. The 5 s slack covers clock skew between Herdr's observation and the row's created_at. `transport_unknown`, `failed`, `target_lost`, `uncorrelated`, timeouts: unchanged.
D4. Presentation/docs: the `shepy wait` help `Outcomes:` block in `src/cli/shepy.ts` (~line 840) adds `target_not_started` (operation stays submitted; the prompt may not have taken — inspect the agent, then wait again) and says settle happens on Herdr `idle`, `done` or `blocked`. `docs/plans/2026-08-30-shepy-orchestration-design.md` line ~55 shows `--until done|blocked|settled`: correct it to say the wait consumes Herdr's settled set (idle, done, blocked) — one line, no rewrite. The human renderer needs nothing (falls through to JSON).

## Required (RED before GREEN, verbatim capture; a test that passes immediately is kept as a pin and reported as such)

R1. Adapter unit test: the request carries `until: ["idle","done","blocked"]` (RED = old pin); an `agent_info` with `agent_status: "idle"` → `settled` (probably passes already → pin).
R2. Store test (`test/integration/operations-store.test.ts` or a new `agent-events-store` test next to the existing store tests): `hasLifecycleEventSince` — true for a `agent.idle` row on the terminal at/after since; false when the only rows are before since; false for another terminal; pane fallback when `terminalId` is null; `agent.tool.failed` alone does not count; different `herdr_session_name` does not count.
R3. Wait-service unit test (`test/unit/operation-wait-service.test.ts`): with a fake events store returning false, a `settled` event → `target_not_started`, state stays `submitted`, `lifecycle`/`settledAt` null, `errorSummary` set; a following `settled` event with the fake returning true settles normally (re-waitable); `blocked` with false → `target_not_started` too; `transport_unknown` path unchanged.
R4. RPC integration (`test/integration/operation-wait-rpc.test.ts`): real stores — dispatch an operation (or insert one via the store as the existing tests do), fake Herdr client returning `agent_info {agent_status:"idle"}`: (a) with an `agent.idle` event row appended for the target AFTER submittedAt → `{ outcome: { kind: "settled" } }`, row settled; (b) with only an `agent.idle` row BEFORE submittedAt (the stale idle) → `{ outcome: { kind: "target_not_started" } }`, no RPC error, row `submitted`, `errorSummary` set; (c) the EXACT failing-sample sequence, synthetic ids: idle row at T0, submit at T0+129 s, status.changed+idle rows at T0+577 s, Herdr returns idle → settled. Use the real timestamps' spacing; ids synthetic.
R5. `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` → exit 0. Baseline at base first: `pnpm test`, record counts.

Out of scope: `packages/`, hooks, dispatch semantics, any schema change, any change to how events are appended, the CLI renderer beyond help text, the late-armed-timeout case (RUN-05 covered it; it is a distinct case), the RPC-socket-closed case. If the guard cannot be built without a schema change, STOP and report BLOCKED with the exact reason.

## Self-review + commit

Re-read the full diff. List untested claims. Commit on the branch, pathspec form, one or two commits. Report shas.

## Report

Write `/tmp/run-20260913-09/builder-report.md`: Candidate (shas, `git diff --name-only c518663..HEAD`); Baseline; RED evidence verbatim per R; GREEN (pnpm check tail + counts); Requirement table R1–R5 → test names; Untested claims; Time spent: run `date -u` at start and end and quote both lines verbatim.

Final pane line, exactly one of:
  `HERDR-SENTINEL: RUN-20260913-09 BUILD DONE`
  `HERDR-SENTINEL: RUN-20260913-09 BUILD BLOCKED <one-line reason>`

## Rails

- Budget 40 minutes wall clock; stop and report BLOCKED after 15 minutes stuck on one thing.
- NEVER `pkill -f` / `killall` on a bare tool name or any string in this packet. Kill by recorded PID only.
- Wrap anything that could hang with `perl -e 'alarm shift; exec @ARGV' <secs> <cmd>`.
- biome enforces style; match surrounding code; no commented-out code, no drive-by refactors, no `any`.
