# RUN-20260913-09 — `shepy wait` never settles when the worker finishes as `idle` (operations wait/correlation)

Ninth run. Assigned by the COA (portfolio coordinator, Pi `wP:p70`) under
Ray's instruction to operate the program: qualify and, if warranted, fix the
unresolved wait-correlation gap. Budget 120 min from 19:31Z; at most one
independently verifying worker; no restart, install, migration, live CLI
replacement, row repair, re-arm or live experiment.

## Live

- state: building
- lead: `w31:p1` (Claude Code, supervised)
- workers: `builder-wait` in `w31:p1E` / `term_65b6274118915bc` (`(zai) glm-5.3-flash • high`), profile `run-09-builder`, operation `op_f50e6eeeff7043eb1bfa01ad` (dispatched 19:38:01Z, `working` in 4 s, seq 2615)
- worktrees: `~/dev/shepy-wt/waitfix` (branch `pilot/wait-idle-settle`, base `c518663`)
- waits armed: TWO single-shot instruments on the same worker, deliberately: (1) `shepy wait op_f50e6eeeff7043eb1bfa01ad --json` (lead task `bs12dop1g`) = the defect under repair, expected to HANG if the pane ends `idle`, kept as a live measurement; (2) bare `herdr agent wait builder-wait` (task `bxp9xswbm`) = the wake, Herdr's default set includes idle. No re-arm, no polling. If (1) hangs after (2) returns, it is killed by recorded PID at retirement and recorded as a second sample of the defect.
- next safe action: when the herdr wait returns, read sentinel + `/tmp/run-20260913-09/builder-report.md`; record which instrument returned; freeze; verifier
- updated: 2026-09-13T19:39Z

## Registration (before dispatch)

- **Assignment:** `/tmp/run-20260913-09/assignment.md` (verbatim COA packet).
- **Experiment:** EXP-08 (infrastructure). Observational; no topology claim.
- **Task class:** small correctness fix on the operations wait path plus a
  fail-closed guard.
- **Observed cause (evidence, 19:33–19:36Z, read-only):**
  - Failing sample `op_4c90b6d3e9a7a16b5051015d` (profile
    `portfolio-idle-survey`, created 18:43:54.627Z, durable `submitted`,
    `errorSummary null`): `agent_events` rows for its pane `wP:p8F` /
    `term_65b61a11c5958b7` show `agent.status.changed` `working → idle`
    + `agent.idle` at 18:51:22 (id 18604/18605) and again at 19:05:44
    (18636). The worker finished as **`idle`**, twice.
  - Settling sample `op_6fb4ea5693a044ce6509311b` (created 18:08:49Z,
    settled 18:39:13.393Z): rows 18585/18586 at 18:39:13 are
    `agent.status.changed` + **`agent.done`** on `w31:pS`.
  - `src/herdr/orchestration-transport-adapter.ts:60` requests Herdr
    `agent.wait` with `until: ["done", "blocked"]`. Herdr 0.8 (`herdr agent
    wait --help`): "Without --until, matches idle, done, or blocked".
    Herdr's `idle` = ready for input and the tab has been SEEN in the
    focused UI; `done` = the same state when unseen. Which one a finished
    worker reports depends on where the human's UI focus was, not on the
    operation. The adapter's filter therefore excludes a legitimate settled
    state and the Herdr wait blocks forever; `lifecycleOutcome` would have
    mapped `idle` → `settled` had it ever been returned.
  - Earlier samples are consistent: RUN-04/05/06 workers were in panes of
    an unfocused workspace and reached `done` (7 of 7 waits settled); the
    COA's worker sat in its own workspace `wP` and reached `idle`.
  - **Hypotheses excluded:** the 17:11Z restart (this op was dispatched
    after it, on the new daemon); socket loss (wait stdout/stderr empty,
    client PID alive until SIGTERM at closure); the RUN-05 envelope-shape
    defect (fixed, and the sample never returned a shape at all); a
    late-armed timeout (this wait was early-armed, unbounded).
- **Race the fix opens, and its guard:** a target that is already `idle`
  when the wait is armed (the worker was `idle` at 18:41:45, before
  dispatch at 18:43:54) would satisfy an `idle`-inclusive wait instantly.
  Guard from durable evidence, no migration: the daemon's own
  `agent_events` rows for the target terminal. A genuine completion after
  submission necessarily produced a lifecycle event after `submittedAt`
  (`agent.status.changed`/`agent.idle`/`agent.done`/`agent.blocked` on that
  terminal, created_at ≥ submittedAt). If Herdr returns a settled state
  and no such row exists, the settle is stale: do NOT settle, record
  `error_summary`, return a re-waitable outcome `target_not_started`.
- **Design (ops), D1–D4 in the packet:** D1 `until: ["idle","done","blocked"]`
  (Herdr's default settled set, explicit); D2 `AgentEventStore.hasLifecycleEventSince`
  read-only query; D3 `OperationWaitService` takes the events store,
  applies the guard on `settled`/`blocked`, new `WaitOutcome` kind
  `target_not_started`; D4 CLI help + design-doc line corrected.
- **Base:** `shepy` at `c518663` (gate expected 60 files / 670+ tests).
- **Work surface:** `~/dev/shepy-wt/waitfix`, branch `pilot/wait-idle-settle`.
- **Mutation scope:** `src/herdr/orchestration-transport-adapter.ts`,
  `src/observability/operation-wait-service.ts`, `src/db/agent-events.ts`
  (read-only method), `src/daemon/service.ts` (wiring one argument),
  `src/cli/shepy.ts` (help text only), `docs/plans/2026-08-30-shepy-orchestration-design.md`
  (one line), tests. Nothing in `packages/`, no schema.
- **Roles:** builder `builder-wait`, verifier `verifier-wait`, both Pi
  `zai/glm-5.3-flash` (small, precisely specified diff; flat-rate route;
  the lead adjudicates with real event rows). Method chosen by the lead,
  not assumed.
- **Limits:** builder 40 min, verifier 35 min, one corrective cycle if the
  budget allows; stop with a precise blocker otherwise.
- **Evidence:** this file + `/tmp/run-20260913-09/`.

## Execution and lineage

- 19:33Z — receipts read (`dispatch.json`, `wait-receipt.json`, empty
  `parent-wait.*`, measurements, retirement); operation rows and
  `agent_events` rows queried read-only; adapter and Herdr help read.
- 19:35Z — worktree at `c518663`, installed `--ignore-scripts`.
- 19:38Z — record registered; packet `/tmp/run-20260913-09/builder.packet.md`.

## Results

_(appended at acceptance)_

## Experience and retirement

_(appended at retirement)_

## Interpretation

_(appended at synthesis)_
