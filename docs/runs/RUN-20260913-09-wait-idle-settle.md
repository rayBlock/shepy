# RUN-20260913-09 — `shepy wait` never settles when the worker finishes as `idle` (operations wait/correlation)

Ninth run. Assigned by the COA (portfolio coordinator, Pi `wP:p70`) under
Ray's instruction to operate the program: qualify and, if warranted, fix the
unresolved wait-correlation gap. Budget 120 min from 19:31Z; at most one
independently verifying worker; no restart, install, migration, live CLI
replacement, row repair, re-arm or live experiment.

## Live

- state: verifying (candidate `8b7a9b6` frozen 20:29Z; ops adjudication 4/4 against the epoch query already done)
- lead: `w31:p1` (Claude Code, supervised)
- workers: `verifier-wait` in `w31:p1F` (`zai/glm-5.3-flash`), profile `run-09-verifier`, operation `op_b06384435e04c4b91aa09391` (dispatched 20:30:30Z)
- worktrees: `~/dev/shepy-wt/verify-wait` (detached at `8b7a9b6`), `~/dev/shepy-wt/waitfix` (branch `pilot/wait-idle-settle`, builder done, pane closed)
- waits armed: same two single-shot instruments on the verifier: `shepy wait op_b06384435e04c4b91aa09391 --json` (task `bv4mqaqlq`, old-filter daemon, measurement) and bare `herdr agent wait verifier-wait` (task `b6ubbhkxh`, wake). No re-arm, no polling.
- next safe action: when the herdr wait returns (deadline 21:13Z), record which instruments returned, read sentinel + `/tmp/run-20260913-09/verifier-report.md`, adjudicate; ACCEPT → gate at the tip, rebase, ff-merge, build, retire, report by 21:28Z; REVISE → land nothing, return the finding list
- updated: 2026-09-13T20:32Z

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
- 19:38:01Z — `builder-wait` in `w31:p1E` (`(zai) glm-5.3-flash • high`),
  profile `run-09-builder` `matched` on the second poll, `shepy dispatch`
  → `op_f50e6eeeff7043eb1bfa01ad`, `working` in 4 s (seq 2615). Two
  single-shot instruments armed 19:38–19:39Z (see Live).
- **Envelope note (COA clarification received ~19:45Z):** the COA's
  original wording allowed only an extra verifying worker; it now
  explicitly allows ONE builder plus ONE fresh verifier within the
  unchanged 120 min, and local frozen-lockfile dependency restoration in
  the worktree. The builder start (19:38Z) and the worktree install
  (19:35Z) happened BEFORE this clarification and are recorded as such,
  not as retroactive original permission.
- 19:45Z — **COA challenge to the guard, accepted:** "any lifecycle row
  since submittedAt" is not completion evidence — a focus-only
  `done → idle` row after submission concerns the PREVIOUS completion; a
  `working` row alone proves start, not finish; created_at + terminal
  alone cannot fix the execution epoch when operations overlap on one
  terminal. Design tightened to an **execution epoch**: the earliest
  `to: "working"` row at/after submission FOLLOWED (higher row id) by a
  settled row on the same target. Focus-only, working-only, previous
  completion, and overlapping-operation cases all yield
  `target_not_started`. Addendum 1
  (`/tmp/run-20260913-09/builder.addendum.md`) replaces D2/D3 and
  R2–R4; verifier packet R2–R4 and mutations (2)(3)(4)(10) + probes
  updated to the adversarial ordering/identity/overlap cases.
- 19:46:48Z — addendum pointer delivered to the working builder as a Pi
  steering prompt (`agent_prompted`, status stayed `working`, seq 2615
  unchanged). Instruments untouched.
- 20:22Z — COA status check: builder past its 40-min phase (started
  19:38Z). **Ops inspection 20:23:53Z (one read, no polling):** status
  `working`, seq 2615 (no state change since dispatch — the addendum and
  this steer were consumed as Pi steering, not as new turns), ~173k tokens
  in; worktree has NO commits and NO source changes; 246 lines of RED
  tests across `test/unit/herdr-orchestration-transport-adapter.test.ts`,
  `test/unit/operation-wait-service.test.ts`,
  `test/integration/operation-wait-rpc.test.ts` and a new
  `test/integration/agent-events-store.test.ts`; a read-only run shows 8
  named RED tests, some still phrased in the superseded any-row
  semantics. **Original overrun preserved:** 40-min phase → 47 min at the
  steer with zero source.
- 20:24:12Z — **checkpoint steer** (argv, Pi steering, status stayed
  `working`): hard stop 20:40Z; implement the source for D1/D2'/D3'/D4;
  make existing tests GREEN under epoch semantics; required minimum R1,
  R2'(a–e), R3', R4'(a)(b)(c)(e); everything else under Untested claims;
  `pnpm check`; commit; report; sentinel — or BLOCKED with exact failing
  names.
- **Reallocation inside the original 120-min envelope (ends 21:31Z):**
  builder to 20:40Z (62 min total, overrun recorded); freeze + verifier
  dispatch by 20:43Z; verifier 30 min (packet budget reduced from 35) to
  21:13Z; lead adjudication + gate + landing to 21:28Z. No corrective
  cycle fits; a REVISE verdict lands nothing and returns the exact
  finding list as the candidate report. If the builder reports BLOCKED
  with green tests but incomplete source, the lead implements the
  remaining source lines itself on the builder's tests (no new worker),
  still followed by the fresh verifier.
- 20:29:35Z — **both instruments returned at the same second.** The
  native `shepy wait` (old daemon, `until: [done, blocked]`) returned
  `settled`; the bare herdr wait returned `agent_info` with
  `agent_status: "done"`, `focused: false`, seq 2682. The builder's pane
  was never seen in the focused UI, so it finished as `done` and the old
  filter matched — a third-party confirmation of the diagnosis: the
  COA's pane was seen (`idle`), mine was not (`done`). Durable row
  `settled` 20:29:35.404Z. Sentinel `BUILD DONE`; honest clock
  `19:38:07Z → 20:28:47Z` (51 min; hard stop met, gate green ≈ 20:27Z).
- **Candidate frozen at `8b7a9b6`** (`4bf7de5` fix, `8b7a9b6` tests): 11
  files, +596/−24. Source: adapter `until: ["idle","done","blocked"]`;
  `AgentEventStore.hasCompletionEpochSince` (two bounded prepared
  statements, `json_extract(payload_json,'$.to')`, earliest working row
  then any later settled row by id, terminal-or-pane scope, herdr-session
  scope); `OperationWaitService` takes `events`, guards `settled`/
  `blocked`, new `WaitOutcome` `target_not_started` via the existing
  `recordWaitError`; wiring in `service.ts`; help text; design-doc line.
  Disclosed substitution: `submittedAt` is not on `OperationRecord`, so
  the lower bound is `createdAt - 5 s` (create and submit are ms apart in
  one dispatch call). Trimmed per the checkpoint steer: R2'(f)(g)(h)(i)
  and R4'(d) overlap were written, then REMOVED and listed as untested
  claims — honest, and the verifier packet probes (d) anyway.
- 20:31Z — **ops adjudication against the candidate's epoch query
  (scratch test in the builder worktree, deleted, tree clean): 4/4** —
  the real sample's rows with real timestamps (idle 18:41:45, working
  18:43:55, status.changed+idle 18:51:22; since = createdAt 18:43:54.627
  − 5 s) → epoch TRUE; the COA's focus-only `done → idle` after a previous
  completion → FALSE; overlap (op2 submitted mid-op1, op1's idle lands
  after) → op1 TRUE, op2 FALSE; working row plus a settled row from
  another terminal on the same pane → FALSE.
- 20:32Z — gate in the builder worktree: exit 0, **61 files / 686 tests**
  (base 60 / 670), 3 pre-existing biome warnings.
- 20:30:30Z — verifier `verifier-wait` in `w31:p1F`, profile
  `run-09-verifier` `matched` on the third poll, `shepy dispatch` →
  `op_b06384435e04c4b91aa09391`; two single-shot instruments armed.
- **Deadline correction (COA, 20:36Z):** the verifier started 20:30:30Z;
  its 30-minute budget ends **21:00:30Z**, not 21:13Z. The 21:13Z figure
  came from the reallocation plan's estimated 20:43Z dispatch; the actual
  dispatch was 13 min earlier and the plan was not re-derived. Landing
  window is therefore 21:00–21:28Z inside the 21:31Z envelope.
- 20:36Z — **COA boundary counterexamples against the candidate's
  `createdAt − 5 000` bound (`operation-wait-service.ts` ~81), both
  valid on reading:** (P-A) op1 `to: working` at T−2 s, op2 created at
  T, op1 settles at T+1 s on the same terminal → op2's query finds a
  working row ≥ T−5 s followed by a settled row → op2 inherits op1's
  completion; (P-B) a wholly prior epoch working T−4 s / idle T−1 s,
  nothing after T → same false epoch. My far-apart overlap probe
  (18:00 / 18:10) could not see this; the 5 s slack was the packet's
  own mistake: it was justified as "clock skew between Herdr's
  observation and the row", but both timestamps compared (`created_at`
  of the event row and `createdAt` of the operation) are written by the
  same daemon process on the same clock — there is no skew to cover.
  Correct bound = `createdAt` with ZERO backward slack (the operation
  row is written before the prompt is sent; no `submitted_at` column
  exists — submission time goes to the mutable `updated_at`).
  Residual after that fix, bounded by index lag (seconds): a working
  transition that OCCURRED just before creation but was INDEXED after
  it would still count; only Herdr's `state_change_seq` at prompt time
  could close it, and that needs a schema change (out of scope; rollout
  gate below).
- 20:38:55Z — P-A and P-B delivered to the running verifier as REQUIRED
  probes (argv steering, status stayed `working`), expected outcome:
  must not settle; actual outcome to be reported verbatim.
- **Plan under the envelope:** the verifier's report (by 21:00:30Z) is
  expected to be REVISE on P-A/P-B. No third worker is allowed, so the
  lead applies the zero-slack correction itself on the branch as attempt
  2 with the verifier's P-A/P-B and the builder's tests, re-runs the
  gate, and presents `candidate-2` as **lead-corrected, verified only by
  the lead's re-run of the independent verifier's own probes**. It is
  NOT landed on `shepy` in this run; it stays on `pilot/wait-idle-settle`
  for the COA's independent recheck (as MC01 did), because an
  independently unverified correction must not be integrated under a
  "no speculative acceptance" rule.
- 20:40–20:42Z — **lead correction prepared in the builder worktree,
  UNCOMMITTED (candidate `8b7a9b6` stays frozen for the verifier):** new
  `test/integration/operation-wait-epoch-boundary.test.ts` (real stores,
  backdated rows, real `OperationWaitService`): P-A, P-B, "working at
  exactly createdAt counts", "working 1 ms before createdAt does not".
  **RED against `8b7a9b6`:** P-A, P-B and the 1-ms case all `settled`
  (`expected 'settled' to be 'target_not_started'`) — the COA's
  counterexamples reproduce. Correction: `sinceMs = createdAt` (zero
  slack), comment rewritten with the same-clock argument and the
  index-lag residual; the one builder unit pin of `createdAt - 5_000`
  updated. **GREEN:** gate exit 0, 62 files / 690 tests.
- Causal attribution note (COA): "seen tab → idle, unseen → done" is
  Herdr's documented semantics plus two matched-code samples (COA's pane
  `idle`, mine `done`); it is not a controlled focus experiment, and no
  focus manipulation was or will be done here.
- Still unqualified by design (recorded, not fixed here): Herdr's
  `state_change_seq` at prompt time is not stored (no schema change in
  scope), so the guard reasons from indexed rows, not from Herdr's own
  sequence; a human typing into a dispatched pane would create a
  working→settled epoch the guard cannot distinguish from the prompt's;
  index lag can produce one `target_not_started` before a genuine settle
  (fail-closed, self-heals on the next wait).

## Results

_(appended at acceptance)_

## Experience and retirement

_(appended at retirement)_

## Interpretation

_(appended at synthesis)_
