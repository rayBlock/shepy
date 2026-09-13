# RUN-20260913-05 — `shepy wait` cannot read Herdr's wait response (operations layer)

Fifth run. Opened from a defect found in RUN-04 and independently hit by
TYPO-RUN-20260913-01 (the other lead). Runs in parallel with RUN-04's
verification because the file sets are disjoint (proven in Registration).

## Live

- state: **LANDED** `ea1163e` (shepy branch), retired
- lead: `w31:p1` (Claude Code, supervised)
- workers: none (all panes closed)
- worktrees: none (both removed; branch `pilot/opwait-lifecycle` deleted)
- waits armed: none
- next safe action: Ray runs `shepy daemon restart`; then the first Shepy-dispatched run proves `shepy wait` live (the fix runs daemon-side, unprovable until restart)
- updated: 2026-09-13T12:43Z

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
- 12:26Z — builder settled `idle` (≈ 10 min by lead clock; self-report
  "~25 min, 14:15Z–14:40Z" is local time mislabelled and 2.5× over).
  Sentinel `BUILD DONE`. **Candidate frozen at `1a4a03a`** (one commit,
  8 files, +291/−18, +9 tests, 55 / 588, gate exit 0). Diff read by ops:
  D1–D4 as designed; `LifecycleEvent` gained optional `detail`
  (`src/herdr/orchestration-transport.ts`, a type-only file outside the
  declared scope but disjoint from RUN-04's set — accepted); `WaitOutcome`
  gained `transport_unknown`; `recordWaitError` goes through `#transition`
  so it refuses an unknown operation id. R4 store test placed in
  `test/integration/` (where the store tests live), not `test/unit/` as
  the packet guessed. D4: no CLI change needed (`formatHumanResult` falls
  through to JSON for `operation-wait`); stale help text at the
  `Outcomes:` line noted for a later docs touch. Builder's untested
  claims: no live-Herdr round trip; >300-char truncation branch untested.
- 12:27Z — builder pane closed. Detached worktree `~/dev/shepy-wt/verify-opwait`
  at `1a4a03a`. First `herdr agent start` on the fresh pane failed
  `agent_pane_busy` (shell not yet at prompt, ~1 s after split); retry
  after 2 s succeeded. Profile `run-05-verifier` bound by name, `matched`
  on the first poll. `shepy dispatch` → `op_bcbdc302294ee7f3a906e215`,
  Herdr `working` in 4 s. Bare herdr wait armed 12:28Z.
- 12:36Z — verifier settled, sentinel `VERIFY DONE`, ≈ 7 min (self-report
  `12:28:34Z → 12:35:32Z`, honest). **ACCEPT**, R1–R5 hold, gate exit 0 at
  55 / 588. 6 mutations — 5 caught by named tests, 1 survived (M6: the
  >300-char truncation off by one → `NO TEST FAILED`). 13 probes, all
  clean: precedence when live and legacy keys disagree (live wins),
  non-string status, null/string result, `blocked` then `done` on one
  operation (`already_terminal`, fail-closed), double `recordWaitError`,
  `recordWaitError` on a settled row (overwrites, unreachable via the
  service — S1). Findings: F1 `[mutation]` should-fix, truncation test;
  S1 `[probe]` store guard; S2 `[read]` stale `Outcomes:` help line in
  `src/cli/shepy.ts` (pre-existing at base, RUN-04's file). Consumers
  grep: no reference to the old throw or `lifecycleKind` anywhere.
- 12:37Z — verifier pane `w31:p16` closed. Ops decision: F1 + S1 now, fresh
  builder; S2 by the lead after RUN-04 lands. Dead `builder-opwait` selector
  unsubscribed first (RUN-04's lesson). `builder-opwait-r1` in `w31:p18`,
  `matched` on the second poll, `op_de2f51c2947063d252f7c307`, bare wait.
- 12:40Z — revision settled, `BUILD-R1 DONE`, ≈ 3 min (self-report
  `12:37:24Z → 12:39:52Z`, honest). Commit `3010cb5`: `recordWaitError`
  throws `invalid transition: recordWaitError requires submitted, found
  <state>` inside `#transition`, mirroring `settle`; truncation pin test
  (RED `expected 301 to be 300`); guard test (RED `expected [Function] to
  throw`). 55 / 590.
- 12:41Z — **ops discriminating check:** re-applied the original defect
  myself (settle `transport_unknown` as `failed`) → 3 named tests fail
  (`a transport_unknown result records the error but never settles the
  operation`, `the operation is re-waitable after a transport_unknown
  result`, `an unreadable wait shape returns transport_unknown and keeps
  the operation submitted`); reverted; `pnpm check` exit 0, 55 / 590.
- 12:42Z — rebased `pilot/opwait-lifecycle` onto shepy `3e4b7d6` (RUN-04
  landed mid-run; disjoint files, no conflicts) → `5addf3c`, `ea1163e`.
  `git merge --ff-only` → tip `ea1163e`. **Gate at the merged tip: exit 0,
  57 / 619** (RUN-04's 608 + RUN-05's 11). `pnpm build` exit 0. Pane
  `w31:p18` closed, both worktrees removed, branch deleted.
- 12:43Z — lead follow-up S2: the `Outcomes:` help line now lists
  `transport_unknown` and the four pre-existing unlisted kinds (own commit,
  see below). **Not provable until restart:** the fix runs inside the
  daemon's `operation.wait`; the live daemon (pid 8569) still has the
  throwing adapter.

## Results

- **Accepted and landed** `ea1163e`. Gate 57 files / 619 tests at the tip.
- Delivered: adapter reads Herdr 0.8's `result.agent.agent_status` first,
  legacy keys after; an unreadable response yields a `transport_unknown`
  `LifecycleEvent` with a ≤ 300-char detail of keys and raw status, never
  the payload; `applyLifecycle` records `error_summary` via the new
  `OperationStore.recordWaitError` (only on `submitted` rows, only
  `error_summary` + `updated_at`) and leaves the operation `submitted` and
  re-waitable; `WaitOutcome` gains `transport_unknown`; CLI prints it as
  JSON; help text lists every outcome kind.
- Verifier (both methods, tagged): 6 mutations, 5 caught; 13 probes,
  clean; 1 should-fix + 3 suggestions, 2 adopted, 1 deferred to the lead,
  1 (S4 precedence semantics) recorded as an explicit choice: a live
  `unknown` never falls through to a legacy `done`.
- Known: no live-Herdr round trip in any test; whether a `blocked` agent
  answers `agent_info` or a Herdr `timeout` error at wait-settle is
  unverified either way (both paths fail safe).

## Experience and retirement

- Dispatch 12:16Z → landed 12:42Z, **≈ 26 min**; worker time ≈ 10 + 7 +
  3 = 20 min. One revision cycle. Zero Ray interventions. Ran fully in
  parallel with RUN-04's verification and revision on proven-disjoint
  files; RUN-04 landed first, RUN-05 rebased with no conflicts.
- Three of three bare herdr waits reactivated the lead. `herdr agent
  start` failed once with `agent_pane_busy` ~1 s after the split; retry
  after 2 s worked.
- Both workers reported honest UTC because their packets demanded `date
  -u` quotes; the two RUN-04 attempt-1 workers, whose packets did not,
  over-reported 2.4–2.5×. Rule adopted for every packet.
- Retired 12:43Z: no panes, no worktrees, no branch.

## Interpretation

- The operations path's wake half is repaired in code; the proof is the
  first Shepy-dispatched run after Ray's restart. Until then the skill
  keeps the bare-herdr fallback and says when to use it.
- Fifth verifier round: real findings, zero noise; mutation found the
  gap (F1), probing found the hardening (S1). Verdict pattern holds.
- Parallel runs on disjoint files with one lead worked without incident:
  two records, two Live blocks, four waits, two rebases. The cost was the
  Live-block staleness a coordinating agent caught — the lead's attention
  is the bottleneck, which is the argument for the ledger project.
