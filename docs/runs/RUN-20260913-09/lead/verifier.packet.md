RUN-20260913-09 / operation wait settles on idle + not-started guard / VERIFIER packet

You are an independent verifier. You did not build this. Find what is wrong with a frozen candidate, or state precisely what you checked and found nothing.

  cwd        ~/dev/shepy-wt/verify-wait   (detached worktree at the candidate; scratch tests allowed, no commits)
  candidate  8b7a9b6
  base       c518663 (the shepy branch)
  diff       git diff c518663..8b7a9b6

Do NOT read /tmp/run-20260913-09/builder-report.md until your own findings are written. Do not touch ~/dev/shepy, ~/.shepy, or other worktrees. No installs, no daemon start/stop, no `git push`. Never query the live daemon database.

## The requirement (from the run registration, not the builder)

`operation.wait` never returned when a worker finished with Herdr status `idle` (tab seen in the focused UI) because the adapter asked Herdr for `until: ["done","blocked"]`; Herdr's default settled set is idle, done, blocked. Adding `idle` opens a race: a target already idle when the wait is armed satisfies it instantly. The guard is durable: a genuine completion after submission leaves a lifecycle event row (`agent.status.changed` / `agent.idle` / `agent.done` / `agent.blocked`) for the target terminal with `created_at >= submittedAt`; if Herdr returns a settled state and no such row exists, the operation must NOT settle: `error_summary` recorded, outcome `target_not_started`, re-waitable.

Real-file facts (ops, read-only, today): the failing worker's rows were `agent.idle` at 18:41:45 (before dispatch 18:43:54.627), `agent.status.changed` to working at 18:43:55, `agent.status.changed`+`agent.idle` at 18:51:22 and 19:05:44. Rows carry `pane_id`, `terminal_id`, `herdr_session_name`, `created_at` (ms), `type`, `payload_json {from,to,…}`.

R1. Adapter requests `until: ["idle","done","blocked"]`; `idle` maps to `settled`.
R2. `AgentEventStore.hasCompletionEpochSince` is read-only and true ONLY for an execution epoch: the earliest `agent.status.changed` row with payload `to: "working"` at `created_at >= sinceMs` on the target (same herdr session; terminal when non-null, else pane), FOLLOWED (higher id) by a settled row (`agent.idle`/`agent.done`/`agent.blocked` or status.changed with `to` in idle/done/blocked). A focus-only `done → idle` row after since is NOT an epoch; a working row alone is NOT an epoch; a previous operation's completion rows before since are NOT an epoch; another terminal / another herdr session never count.
R3. `OperationWaitService.applyLifecycle`: `settled`/`blocked` with no epoch → `target_not_started`, state `submitted`, `lifecycle`/`settledAt` null, `errorSummary` set; a later settle with an epoch settles normally; `transport_unknown`/`failed`/`target_lost`/timeout paths unchanged.
R4. RPC end to end: idle `agent_info` + working-then-idle rows after submission → settled; idle + only rows before submission → `target_not_started`, no RPC error, row `submitted`; previous completion then ONLY a `done → idle` row after submission → `target_not_started`; overlapping operations on one terminal (op2 submitted while op1 runs; op1's idle row lands after op2's submit) → op2 `target_not_started`, op1 settled; the real sample's spacing (idle T0, submit T0+129 s, working T0+130 s, status.changed+idle T0+577 s) → settled.
R5. Help text lists `target_not_started` and says settle happens on idle/done/blocked; the design-doc line no longer says `--until done|blocked|settled`. No schema change, no `packages/`, no change to how events are appended.
R6. `pnpm check` exit 0 at the candidate (base 60 files / 670 tests).

## What you must do

1. `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` at the candidate; record exit and counts.
2. Read the full diff. For each R: which test proves it and whether you RAN it.
3. TWO methods, tagged `[mutation]` / `[probe]` / `[read]`:
   a. **Mutation pass** — at least eight: (1) drop `idle` from the until list; (2) accept ANY settled row after since without requiring a prior working row (the focus-only `done → idle` must then falsely satisfy it — name the test that catches it); (3) accept a working row alone as an epoch; (4) use the LATEST working row instead of the earliest (a second working row after the settle must not hide a valid epoch — or show it is harmless); (5) ignore the terminal and match by pane only when terminalId is non-null; (6) drop the herdr-session scope; (7) on `target_not_started` also write `state = 'failed'` or `lifecycle`; (8) apply the guard to `transport_unknown` (it must not be); (9) remove the 5 s slack (a working row 1 s before submittedAt must count; 6 s before must not); (10) compare `created_at` instead of `id` for "followed by".
   b. **Probe pass** — `submittedAt` null/undefined on the operation (pending submission: must not settle); rows on the right terminal but a different herdr session; an epoch whose settled row is `agent.blocked` with Herdr returning `blocked` → `blocked`; op2 submitted while op1 runs and op1's settled row lands after op2's submit (no new working row) → op2 `target_not_started`; op2 submitted after op1 completed, prompt takes, new working+idle → op2 settled and op1 (already settled) untouched; focus-only `done → idle` AFTER a valid epoch of this operation → still settled (the epoch exists); `working → working`? (a status.changed row with to:working while already working — does the query handle duplicates); a `target_not_started` followed by `wait_timeout` on the same operation; rows with malformed `payload_json` (not JSON, or no `to`) do not throw and do not count; CLI `--json` prints the new kind; human output does not crash.
4. Grep every consumer of `WaitOutcome`, `applyLifecycle`, `OperationWaitService(` (wiring in `src/daemon/service.ts`), `hasLifecycleEventSince`; confirm the daemon constructs the service with a real store.
5. Scope check: every changed file; flag `packages/`, schema/migrations, event-append code, dispatch semantics.

## Report

Write `/tmp/run-20260913-09/verifier-report.md`: Candidate (sha, exit, counts); Requirement table; Mutation table (failing test NAME verbatim or "NO TEST FAILED", reverted); Probe table; Findings by severity, tagged, with repro; What I could not check; Recommendation: **any finding with a one-commit fix is REVISE**; Time: `date -u` at start and end quoted verbatim. ONLY THEN read the builder report and append "After reading the builder report".

Final pane line, exactly one of:
  `HERDR-SENTINEL: RUN-20260913-09 VERIFY DONE`
  `HERDR-SENTINEL: RUN-20260913-09 VERIFY BLOCKED <reason>`

## Rails

- Budget 30 minutes; stop and report BLOCKED after 10 minutes stuck on one thing.
- NEVER `pkill -f` / `killall` on a bare tool name or any string in this packet. Kill by recorded PID only.
- Wrap anything that could hang with `perl -e 'alarm shift; exec @ARGV' <secs> <cmd>`.
- Finding nothing is a valid result if you can show what you checked.
