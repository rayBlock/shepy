# RUN-20260913-04 — A silent owner must be explainable (plan item 5, first slice)

Fourth run. First run dispatched through Shepy's own operations layer
(`shepy dispatch` / `shepy wait`) instead of raw Herdr, per the 2026-09-13
architecture recommendation. If the operations path fails, the fallback is
the herdr wait and that fact is recorded here.

## Live

- state: building
- lead: `w31:p1` (Claude Code, supervised)
- workers: `builder-item5` in `w31:p13` (Pi `zai/glm-5.3-flash`), profile `run-04-builder`
- worktrees: `~/dev/shepy-wt/item5` (branch `pilot/item5-diagnose`)
- waits armed: `shepy wait op_f7ce01f8ecbce5eabefb6e91` (background, lead pane)
- next safe action: when the wait returns, read the pane sentinel and `/tmp/run-20260913-04/builder-report.md`; do not re-dispatch
- updated: 2026-09-13T11:50Z

## Registration (before dispatch)

- **Experiment:** EXP-08 flavour, infrastructure: does the Shepy operations
  path (profile per run, dispatch, correlated wait) carry a lead's
  dispatch as well as raw Herdr did in runs 01–03, and what does it add
  (operation id, machine timestamps, settle classification)? Verifier
  packet: both methods, tagged.
- **Task class:** medium read-only feature: one diagnostic command and one
  daemon-identity RPC.
- **Outcome:** `shepy profile diagnose <profileId>` answers "why did this
  outcome not reach its owner" in one read-only call, and `shepy daemon
  status` reports the running daemon's build and boot identity, not the
  CLI's.
- **Non-goals:** the three known wrong signals (hook checks enabled rather
  than matched; Pi `pendingCount` is batch size; `retire` writes `acked`
  without a reason) go to RUN-05. No `inbox explain`; `inbox get` landed in
  RUN-03. No mutation of delivery state.
- **Base:** `shepy` at `81fe685` (RUN-03 docs on `be3540e`). Gate at
  `be3540e`: exit 0, 55 / 579.
- **Work surface:** `~/dev/shepy-wt/item5`, branch `pilot/item5-diagnose`.
- **Mutation scope:** `src/observability/schemas.ts`,
  `src/daemon/observability-server.ts`, `src/daemon/service.ts` (boot
  identity), a new `src/observability/profile-diagnose-service.ts`,
  `src/cli/shepy.ts`, tests. Nothing in `src/db/` beyond read queries;
  nothing in `src/cli/claude-hook.ts` or `packages/`.
- **Roles:** builder `builder-item5`, verifier `verifier-item5`, Pi
  `zai/glm-5.3-flash`; fresh builder for any revision. Dispatch through
  profile `run-04-builder` bound by agent name.
- **Limits:** 150 min builder, 90 min verifier; no children.
- **Stop conditions:** as RUN-01..03; any delivery-state mutation in the
  diff is a scope violation.
- **Evidence:** this file + `/tmp/run-20260913-04/`, copied at acceptance.

## Execution and lineage

- 11:47Z — worktree at `81fe685`, installed `--ignore-scripts`.
- 11:49Z — pane `w31:p13`, `herdr agent start builder-item5 --kind pi …`.
  `shepy profile ensure run-04-builder`; `shepy profile subscribe
  run-04-builder --workspace w31 --name builder-item5`.
- 11:49:0xZ — **first `shepy dispatch` failed closed:** `unmatched — no
  agent in scope matches name builder-item5`, one second after Herdr
  reported the agent ready. The daemon's agent index had not yet ingested
  the new pane. 40 s later `shepy agent list --workspace w31` showed the
  pane with its name and the profile resolved `matched`. **Finding
  (infrastructure):** index freshness lags Herdr by seconds after `agent
  start`; a lead must confirm `profile show` resolves `matched` before
  dispatching, or dispatch must retry once after a short delay. Fail-closed
  behaviour was correct; no prompt was sent.
- 11:49:52Z — second `shepy dispatch --prompt-file` → `accepted`, operation
  `op_f7ce01f8ecbce5eabefb6e91`. Herdr shows `working` within 4 s. One
  background `shepy wait <opId> --json` armed (no timeout). This is the
  first run whose wake signal is a Shepy operation rather than a raw herdr
  wait; if it fails to return, the fallback is `herdr agent wait
  builder-item5` and this line gets a correction.
- 12:13Z — **correction: the `shepy wait` FAILED**, exit 1, `Herdr wait
  response did not contain a recognized lifecycle status`. The harness
  notification still reactivated the lead (a failed background task is
  also a wake). Operation `op_f7ce01f8…` stays `submitted`, `lifecycle:
  null`, `errorSummary: null` — the transport error was not recorded on
  the operation. Herdr itself reported the builder `done`. **Finding
  (product defect, not usage):** `lifecycleKind` in
  `src/herdr/orchestration-transport-adapter.ts:94` reads
  `matched.agent_status` / `final_status` / `status`, but Herdr 0.8.x
  answers `agent wait` with `{ type: "agent_info", agent: { agent_status:
  "done", … } }` (captured verbatim at 12:14Z). The other lead hit the
  identical error at 11:22:07Z in TYPO-RUN-20260913-01 and a second
  failure mode (`Observability RPC socket closed`) at 11:36Z. → RUN-05
  registered for the fix; until it lands, the wake for Shepy-dispatched
  work is a bare `herdr agent wait <name>`.
- 12:14Z — builder state: Herdr `done`, sentinel `BUILD DONE`, report
  present. **Candidate frozen at `7f15342`** (`2168dd1` daemon.info +
  diagnose service/RPC, `7f15342` CLI). 10 files, +1 528/−10, +27 tests,
  57 / 606. ≈ 24 min wall clock (11:49→12:13; self-report "≈ 28 min",
  close). Design deviations disclosed: `cliBuildStamp` param on the RPC
  so skew is a daemon-side finding; one read-only store helper
  `diagnoseQueue`; two commits not three (shared files). Ops read the
  server, daemon service and the diagnose service head: reuses
  `resolveSubscriptions` and `isLeaseAlive`, no writes, identity resolved
  once at boot.
- 12:16Z — builder pane closed. Verifier `verifier-item5` started in a
  fresh pane, profile `run-04-verifier` bound by name, resolution polled
  until `matched`, dispatched through Shepy; wake = bare herdr wait
  (fallback recorded above).

## Results

_(appended at acceptance)_

## Experience and retirement

_(appended at retirement)_

## Interpretation

_(appended at synthesis)_
