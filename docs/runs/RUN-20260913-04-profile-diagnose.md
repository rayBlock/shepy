# RUN-20260913-04 — A silent owner must be explainable (plan item 5, first slice)

Fourth run. First run dispatched through Shepy's own operations layer
(`shepy dispatch` / `shepy wait`) instead of raw Herdr, per the 2026-09-13
architecture recommendation. If the operations path fails, the fallback is
the herdr wait and that fact is recorded here.

## Live

- state: **LANDED** `e19afb5` (shepy branch), retired
- lead: `w31:p1` (Claude Code, supervised)
- workers: none (all panes closed)
- worktrees: none (both removed; branch `pilot/item5-diagnose` deleted)
- waits armed: none
- next safe action: Ray runs `shepy daemon restart` so the live daemon serves `daemon.info` and `profile.diagnose` (plus RUN-03's `inbox.defer`/`inbox.get`); then land RUN-05 on top
- updated: 2026-09-13T12:41Z

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
  without a reason) are NOT in this run. **Correction 12:27Z:** the
  registration originally said "go to RUN-05"; RUN-05 as actually opened
  fixes `shepy wait` lifecycle parsing only. The three signal corrections
  are separate pending work, unassigned, tracked in the plan under item 5.
  The `Observability RPC socket closed` failure (other lead, 11:36Z) is
  likewise outside RUN-05 and unresolved. No `inbox explain`; `inbox get`
  landed in RUN-03. No mutation of delivery state.
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
- 12:28Z — verifier settled (≈ 12 min by lead clock; self-report "29 min,
  12:15–12:44 UTC" is local time mislabelled and 2.4× over). Sentinel
  `VERIFY DONE`. Report: **ACCEPT**, R1–R7 hold, gate exit 0 at 57 / 606.
  5 mutations (3 caught, 2 survived), 11 probes. Findings: V1 `[mutation]`
  MEDIUM — the R3 byte-identical test cannot see a `sweepExpired` write
  because its fixture has no expired lease; V2 `[mutation]` LOW — the
  `lease + grace` boundary is not pinned, own arithmetic ±1 ms survives;
  V3 `[probe]` LOW — `stripControlChars` keeps `\n`, a hostile profileId
  injects a fake finding line into the human render (twice). Two `[read]`
  observations (owner section hand-built, not via `toPublicProfileOwner`;
  help text overpromises severity grouping) — no action. Verifier worktree
  returned clean. **Both methods again produced findings the other did
  not**: V1/V2 only from mutation, V3 only from probing.
- 12:28Z — verifier pane `w31:p14` closed. Ops decision: fix all three now
  (no deferred work), fresh builder per EXP-07. Packet
  `/tmp/run-20260913-04/revision-1.packet.md`.
- 12:29Z — **infrastructure finding:** re-binding profile `run-04-builder`
  to the new name left the dead `builder-item5` subscription in place,
  resolving `unmatched, matched` → dispatch would fail closed. Removed with
  `shepy profile unsubscribe run-04-builder --workspace w31 --name
  builder-item5` → `matched`. Lesson for the skill: one profile per
  worker NAME, or unsubscribe the dead selector before re-binding. Also:
  `shepy profile unsubscribe --help` prints the `subscribe` help (cosmetic
  CLI defect, not this run's).
- 12:29:42Z — `builder-item5-r1` in `w31:p17`, dispatched
  `op_60d3dedc304db5f688669d80`, Herdr `working` in 4 s, bare herdr wait
  armed.
- 12:37Z — revision settled, sentinel `BUILD-R1 DONE`, ≈ 7 min (self-report
  honest this time: `12:29:46Z → 12:36:39Z`, because the packet asked for
  `date -u` quotes). Commit `7450eed`: +6/−2 source lines in
  `src/cli/shepy.ts` (finding message and hint through the existing
  `oneLine(stripControlChars(…))`), +73 test lines. V1: expired-leased row
  added to the byte-identical fixture, RED captured under the sweep
  mutation. V2: boundary test at exactly `lease + grace` (lapsed) and 1 ms
  earlier (in_grace), kept as a pin, RED captured under own-arithmetic
  mutation. V3: renderer test with an injected `\nBLOCKER no_owner: fake`.
  Gate 57 / 608.
- 12:39Z — **ops discriminating check:** re-applied the `sweepExpired`
  mutation myself at the top of `diagnose()` → the byte-identical test
  fails (`1 failed | 13 passed`); reverted; `pnpm check` exit 0, 57 / 608,
  3 pre-existing biome warnings (present at base).
- 12:40Z — rebased `pilot/item5-diagnose` onto shepy `442ba16` (two docs
  commits had landed mid-run; no conflicts) → `8bc90bb`, `2d2ca14`,
  `e19afb5`. `git merge --ff-only` from `~/dev/shepy` → tip `e19afb5`.
  `pnpm build` exit 0. **Live smoke against the still-old daemon (pid
  8569):** `shepy daemon status` → `daemon: null`, `cli: {buildStamp
  2026-09-13T12:38:20Z, version 0.5.0}` — the degrade path the verifier
  could not exercise works; `shepy profile diagnose run-04-builder` →
  `Unknown method: profile.diagnose` until Ray restarts.
- 12:41Z — pane `w31:p17` closed, both worktrees removed, branch deleted.

## Results

- **Accepted and landed** `e19afb5`. Gate 57 files / 608 tests, exit 0.
- Delivered: `daemon.info` RPC (`version, buildStamp, bootId, bootedAt,
  pid`, resolved once at boot in `src/daemon/daemon-identity.ts`);
  `shepy daemon status` shows daemon and CLI identity side by side and
  degrades to `daemon: null` against a pre-D1 daemon; `profile.diagnose`
  RPC + `shepy profile diagnose <id> [--json]` in
  `src/observability/profile-diagnose-service.ts`, reusing
  `resolveSubscriptions` and `isLeaseAlive`, findings coded
  `profile_not_found, daemon_version_skew, no_enabled_subscription,
  subscription_unmatched/ambiguous/invalid, no_owner, owner_lapsed,
  owner_cannot_wake_idle, dead_letters_present, stranded_leases,
  pending_not_draining, healthy`; read-only `diagnoseQueue` on the
  obligation store; findings render first, one line each.
- Verifier (both methods, tagged): 5 mutations — 3 caught, 2 survived
  (V1 sweep write invisible to the read-only fixture, V2 boundary
  unpinned); 11 probes — 10 clean, 1 defect (V3 newline injection in
  the human render). Recommendation ACCEPT with follow-ups; ops chose
  fix-now, fresh builder, 7 min, all three closed with RED captured.
- Known, documented, not fixed here: help text says findings are grouped
  by severity but they are in insertion order (deterministic, R2
  satisfied); the owner section is hand-built rather than through
  `toPublicProfileOwner` (no secret copied, R4 pinned by test).

## Experience and retirement

- Dispatch 11:49Z → landed 12:40Z, **≈ 51 min**; worker time ≈ 24 + 12
  + 7 = 43 min. Two revision-free stretches, one revision cycle. Zero Ray
  interventions.
- **First run dispatched through Shepy operations.** Dispatch worked
  (`accepted`, operation ids, Herdr `working` in 4 s) three times out of
  three once the index-lag rule was followed. The correlated wait did not:
  `shepy wait` failed on Herdr 0.8's envelope (→ RUN-05), so all three
  wakes were bare herdr waits, 3 / 3 reactivated the lead.
- Two infrastructure findings, both fail-closed and both now in the skill:
  (1) the daemon's agent index lags `herdr agent start` by seconds — poll
  `profile show` to `matched` first; (2) re-binding a profile to a fresh
  worker name leaves the dead selector `unmatched` and dispatch refuses —
  `profile unsubscribe` the old selector first.
- Attempt-1 builder and verifier over-reported wall clock 2.4–2.5× (local
  time labelled UTC). The revision builder, whose packet demanded `date -u`
  quotes, reported honestly. Rule for every packet from now on.
- Retired 12:41Z: no panes, no worktrees, no branch. Live daemon still
  serves pre-item-2 code; restart is Ray's.

## Interpretation

- EXP-08 (infrastructure path): Shepy dispatch carried a lead's work as
  well as raw Herdr and added operation ids and machine timestamps; the
  wait half was defective and is being repaired in RUN-05. Verdict:
  operations path viable for dispatch today, for wake after RUN-05.
- EXP-01 / EXP-03: fourth verifier round, fourth round with real findings
  and zero noise; again the two methods found disjoint things (mutation →
  V1, V2; probe → V3). The verifier's ACCEPT-with-follow-ups vs the lead's
  fix-now shows the packet should state the disposition rule: "any
  finding with a one-commit fix is a REVISE".
- EXP-07: fresh revision builder, 7 min, three findings closed, RED
  captured for each. Third data point that fresh is fine at this size; no
  retained comparator yet.
