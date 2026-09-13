# RUN-20260913-05 — `shepy wait` cannot read Herdr's wait response (operations layer)

Fifth run. Opened from a defect found in RUN-04 and independently hit by
TYPO-RUN-20260913-01 (the other lead). Runs in parallel with RUN-04's
verification because the file sets are disjoint (proven in Registration).

## Live

- state: building
- lead: `w31:p1` (Claude Code, supervised)
- workers: `builder-opwait` in `w31:p15`, profile `run-05-builder`, operation `op_d96f4f2956ea81be6937f22a`
- worktrees: `~/dev/shepy-wt/opwait` (branch `pilot/opwait-lifecycle`)
- waits armed: `herdr agent wait builder-opwait` (background; `shepy wait` is the thing being fixed)
- next safe action: when the wait returns, read the sentinel and `/tmp/run-20260913-05/builder-report.md`
- updated: 2026-09-13T12:17Z

## Registration (before dispatch)

- **Experiment:** none. Defect fix on the operations path that the
  run-lead procedure now depends on.
- **Task class:** small correctness fix.
- **Outcome:** `shepy wait <opId>` settles on the response Herdr actually
  sends; an unrecognised response is a recorded, re-waitable outcome, not
  an RPC error that leaves the operation `submitted` with no trace.
- **Defect, verified by ops (12:13–12:14Z):** `lifecycleKind` in
  `src/herdr/orchestration-transport-adapter.ts:94–107` reads
  `matched.agent_status`, `final_status`, `agent_status`, `status` on the
  receipt result. Herdr 0.8.x answers `agent wait` with
  `{ "type": "agent_info", "agent": { "agent_status": "done", … } }`
  (captured verbatim on `builder-item5`). The adapter throws; the server's
  `operation.wait` catch rethrows anything but a timeout; the operation
  stays `submitted` with `lifecycle: null`, `errorSummary: null`. Same
  message recorded by the other lead at 11:22:07Z.
- **Design (ops):** D1 read `agent.agent_status` (and keep the legacy
  keys); D2 an unrecognised shape returns a lifecycle event of kind
  `unknown` carrying a bounded summary of the payload instead of throwing;
  D3 `OperationWaitService.applyLifecycle` maps `unknown` to outcome
  `transport_unknown`, records `error_summary` on the operation, leaves
  state `submitted` so a later `shepy wait` can still settle it; D4 the
  server file is NOT touched (RUN-04 is editing it).
- **Base:** `shepy` at `81fe685`.
- **Work surface:** `~/dev/shepy-wt/opwait`, branch `pilot/opwait-lifecycle`.
- **Mutation scope:** `src/herdr/orchestration-transport-adapter.ts`,
  `src/observability/operation-wait-service.ts`, `src/db/operations.ts`
  (error recording only), tests under `test/unit/` for those two modules
  and `test/integration/operation-wait-rpc.test.ts`. **Disjoint from
  RUN-04's set** (`src/cli/shepy.ts`, `src/daemon/*`,
  `src/db/delivery-obligations.ts`, `src/observability/profile-diagnose-service.ts`,
  `src/observability/schemas.ts`). If the CLI cannot render the new
  outcome kind without a change to `src/cli/shepy.ts`, the builder reports
  BLOCKED and the CLI line lands after RUN-04.
- **Roles:** builder `builder-opwait`, verifier `verifier-opwait`, Pi
  `zai/glm-5.3-flash`. Dispatch through profile `run-05-builder`.
- **Limits:** 90 min builder, 60 min verifier.
- **Evidence:** this file + `/tmp/run-20260913-05/`.

## Execution and lineage

- 12:16Z — worktree at `81fe685`. Pane `w31:p15` (split down from the
  lead pane), `builder-opwait` on Pi `zai/glm-5.3-flash`. Profile
  `run-05-builder` bound by name; resolution `matched` on the second poll
  (≈ 5 s). `shepy dispatch --prompt-file` → `accepted`,
  `op_d96f4f2956ea81be6937f22a`; Herdr `working` within 4 s. Wake = one
  bare herdr wait (the Shepy wait is the defect under repair).
- Parallel with RUN-04's verification; file sets proven disjoint in the
  registration. Landing order: whichever finishes first lands first, the
  other rebases.

## Results

_(appended at acceptance)_

## Experience and retirement

_(appended at retirement)_

## Interpretation

_(appended at synthesis)_
