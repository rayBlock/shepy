# rev-s3: review of Shepy slice 3 (subscriptions pinned to one terminal session)

Reviewer: rev-s3. Candidate: `night/s3` at `f698a61` (code `f13ec10`, base `50ca705`). Independent review, not a recheck.

**ACCEPT WITH FIXES.** The terminal-plus-session guard does what the seat's option 1 asks: a pending row binds exactly the first session observed on its terminal, survives a daemon restart and database reopen, refuses a replacement session without a notice, and `profile show` names both session ids. One fix is needed before landing: a pending row whose terminal never comes back can never be pruned (F1). The factory side is a real no-op.

## Findings

**F1, medium: a pending row with no live terminal is kept forever, by manual prune and by S2's automatic prune.**
`src/observability/profile-selectors.ts:191-196` reports "pending" whenever no indexed agent has the terminal. That covers both cases: the pane exists but has no agent yet, and the terminal is gone or never existed. `src/observability/profile-service.ts:216-220` refuses every "pending" row. Before S3, the same unguarded terminal row read "unmatched" and was pruned after the age gate. So S3 makes dead rows unprunable. This conflicts with the seat's S2 ruling that rows whose pane is gone are pruned.
Reproduce (`probe/rev-s3-probes.*.test.ts`, P4 and P7):
- Subscribe `--pane` to a pane with no agent, close the pane, refresh, then prune with an age of 2 minutes at now + 3 minutes. Result: `removed: []` with refusal "pending: pending: terminal term_1 has no native session yet".
- `profile subscribe seat --workspace wrong --terminal term_1` (the form the factory uses) succeeds and stores a pending row in workspace `wrong`. That row can never bind, because binding requires the same workspace, and it is never pruned.

Fix: treat "pending" with no indexed agent like "unmatched" under the age gate, and keep the "matched" pending row (an agent but no session yet) protected. The other way is for S2 to judge these rows by terminal liveness. The seat decides which slice owns it. The refusal text also repeats its prefix ("pending: pending:"), from `profile-service.ts:217` on top of `profile-selectors.ts:195`.

**F2, low: the RPC accepts a session guard supplied by the caller.**
`src/observability/schemas.ts:49-66` admits `agentSession` on a `terminalId` selector, and `src/daemon/observability-server.ts:877` stores it unchecked. A local client can create a row bound to any session, without a fresh observation. The CLI cannot send this field. Reproduce with P5: RPC `profile.subscribe` with `agentSession: <some other session>` stores it and resolves `replacement_refused` against the real worker. Suggestion: strip a non-null guard from the input, or refuse it.

**F3, low, interaction with S2 (owner: S2 or the seat): a pending row is removed without a notice when its pane closes.**
On `d3e5169` plus S3, S2's gone path resolves a "matched" pending row as matched and removes it (`profile-delivery-service.ts:251` on S2), but S3's delivery check drops the gone event because the row has no bound session. A worker that dies before its first prompt leaves the seat with no notice and no row (P9). The factory detects start failure on its own, so this is low severity.

## Brief items
1. Holds. Builder test `profile-subscribe.test.ts:339` and my P6: first bind, restart and reopen, replacement refused, no new obligation, `expectedSessionId` and `actualSessionId` shown. The binding happens before events are projected in the same refresh (`agent-index-service.ts:250`).
2. Holds, except for F1. Name reuse on another terminal never reaches the profile (`:387`, `:416`). Missing pane and wrong or missing workspace refuse with no row for `--pane` (`:402`). Twenty repeats leave one row (`:296`). Legacy name rows consolidate and keep their pending notices (`:524`). The obligation index is unique per profile and event, so moving rows cannot collide.
3. Holds. `tools/seat/worker.ts:419` already subscribes `--terminal`. Before the first prompt, the proof at `:420-422` sees `kind: matched` with `bindingState: pending`; when the native id is known, the guard binds to it (test `:726`). Live Herdr `pane.get` and `agent list` return `agent_session` as `{agent, kind, source, value}`, the same shape Pi presence sends (`herdr:pi`, path), so binding through either source compares equal.
4. S2's fix is not committed: `night/s2` is still `d3e5169`, and its worktree has uncommitted edits. Cherry-picking `f13ec10` onto `d3e5169` gives 4 conflicts, all additive: `README.md`, `orchestrator-profiles.ts` (`moveSubscription` next to `bindSubscription`), `agent-index-service.ts` (constructor hooks), and `profile-delivery-service.ts` (imports). Resolved by keeping both sides: typecheck exit 0, and S3 plus S2 tests 147 of 147 passed. A pending S3 row is **not** removed by S2's prune after more than 2 minutes, in both forms (P1 and P2, age 120000 ms, now + 180 s, scoped to session "default"). With S3 merged, S2's F5 does not hit S3 rows, because they resolve "pending", not "unmatched". A bound guarded row still gets its gone notice and is then removed (P8), because S3 adds `agentSession` to the gone payload.
5. S5 `f5d689f`: `f13ec10` cherry-picks cleanly with no conflicts. Typecheck exit 0; S3 tests 121 of 121 passed.

## Checks (fresh HOME and TMPDIR, the three Claude variables unset, node_modules copied from the builder's pnpm install)
- `tsc --noEmit`: exit 0, 3.7 s.
- S3 tests, S1 and S4 test files, and the related profile and RPC files: 14 files, 398 passed and 2 failed, 92 s, load 26. `observability-rpc.test.ts` "reads additional runtime histories through agent.read" fails the same way on base `50ca705` under bare vitest, so it depends on the environment, not on S3. The `notice-correctness` timing case (4.7 s against a 1 s limit) passed on rerun; it is load-sensitive.
- My probes P1 to P9: as described above. P4 is the intended red case for F1.
- Full suite: `node scripts/run-tests.mjs` (the supported entry, not bare vitest), run under `lockf -k /private/tmp/agent-factory-full-gate.lock`. The first wait for the lock was cut off when the load rose above 40. The second got the lock at 22:37 with load 39.5. Result: 75 files, 1166 passed and 39 failed, 348 s of wall time including the lock wait (the suite itself took 61 s).
  - 37 of the 39 failures also fail on base `50ca705` with the same entry at load 12: `claude-profile-demand-validation` (35, "fixture source pairing mismatch: src/cli/claude-hook.ts", a file S3 does not touch), `observability-rpc` agent.read codex (1) and `agent-history-readers` codex registration (1). They come from this environment, not from S3.
  - The other 2 failures are `notice-correctness` timing cases. Across three back-to-back runs at load 12, the candidate passed 3 of 3 and base failed 1 of 3 with a different timing case. These failures depend on load and are present on base too.

Probe sources and logs: `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-rev-s3/4df67cca-ead9-4ace-9e67-a1e2060d8e12/scratchpad` (`probe/`, `logs/`).

## Noticed beyond my task
- A guarded Claude worker that runs `/clear` gets a new session id and stops delivering (`replacement_refused`). This is consistent with option 1, but seat-run Claude reviewers would go silent. Owner: the seat, to decide if that is wanted.
- On `d3e5169`, the conflicts in item 4 must be resolved by hand when S2 and S3 both land. Owner: whoever lands second.

Next owner: the factory seat. Fix F1, or give it to S2, then recheck.

## Recheck: `night/s3-main` at `a2fd350`, against main `f8c108d` (S2 landed)

**ACCEPT.** F1 to F3 are fixed, and both slices' behaviour survives the conflict resolution. Candidate code tip: `d21f85a`. It contains the five S3 commits cherry-picked with `-x` onto main, including the correction `407e6c2` (from `d2d74c2`). It adds one integration fix, `d21f85a`: first binding merges into a pending row that already exists for the same terminal. The earlier tip `night/s3` at `c3dac36` was not rechecked separately. This is a directed recheck of my findings, not a fresh review.

Probes (`/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-rev-s3/4df67cca-ead9-4ace-9e67-a1e2060d8e12/scratchpad/probe2/rev-s3-recheck.test.ts`, 9 of 9 passed). The automatic prune runs the daemon's real call: a refresh, then `pruneSubscriptions` with the snapshot's presence data, at now plus 3 minutes.
- **F1 fixed.** A pending row whose pane closed before any agent appeared is refused while younger than 2 minutes, then removed by the automatic prune (P4). A pending row whose pane is still alive but has no agent yet is kept by the automatic prune, because S2's presence check protects it (P1). A row whose indexed agent has no native session yet (`matched` with `bindingState: pending`) is kept by both prunes (P2). A `--terminal` row with the wrong workspace is removed by manual prune (P7). The doubled "pending: pending:" text is gone.
- **F2 fixed.** A caller-supplied `agentSession`, whether a session object or `null`, is refused as "Invalid RPC params" and no row is created. The schema no longer admits the field, and `observability-server.ts:834` refuses it as a second layer. Control: a bare `--terminal` subscribe stores the guard from the daemon's own observation (P5).
- **F3 fixed, through S2's gone path.** When a worker's pane closes before its first native session, the pending row gets exactly one gone notice and is removed, also after a restart and a second refresh (P9). Control: a bound row behaves the same (P8). Negative control: another terminal's gone event does not reach a pending row (P10). The exception sits at `profile-delivery-service.ts:372-377` and applies only to `agent.gone` on the exact same terminal. Scoped resolution against the frozen prior agents still applies.
- The replacement session is still refused after a bind and a restart, with no notice (P6).

Conflict resolution: `git diff f8c108d a2fd350` changes no S2 test. S2's prune rules are intact in `profile-service.ts:184-262`: legacy rows age out, and modern unmatched rows need the terminal or pane to be absent from a healthy snapshot. S3 only adds its own resolution kinds next to them. The index callbacks `onAgentGone`, `onAgentsMoved` and `onAgentsObserved` are all wired in `service.ts:132-139`. S2's `agent-lifecycle.test.ts` passed 30 of 30, three times each on base and candidate in isolation.

Checks. All runs used a fresh HOME and TMPDIR, with the three Claude variables unset.
- `tsc --noEmit`: exit 0, 5.9 s.
- S2 and S3 test files plus the delivery, migration and hook files: 8 files run in parallel, 354 passed and 2 failed, 75 s.
  - S2's `agent-lifecycle` P4 failed once in this run and passed 6 of 6 when run alone (3 each on base and candidate). Likely cause, not proven: the test fixes `now` at its start with a 1-second margin, so a slow parallel run makes the second row look younger than 2 minutes. This is test fragility, not an S3 defect.
  - The other failure was a `claude-hook` timeout; base also had `claude-hook` failures in its full-suite run.
- Full suite: `node scripts/run-tests.mjs` under `lockf -k /private/tmp/agent-factory-full-gate.lock`, back to back in one hold that started at 02:45 (load 8.5 for the candidate, 6.2 for base). Candidate: 1211 passed and 40 failed in 89 s. Base `f8c108d`: 1171 passed and 41 failed in 95 s. Both share the same 37 environmental failures (35 demand-validation "fixture source pairing mismatch", 1 codex `agent.read`, 1 codex reader registration). The rest are timing failures: candidate 3 in `notice-correctness`; base 2 in `notice-correctness` and 2 in `claude-hook`. The candidate has no failure outside the base pattern.

Limits, not defects:
- Manual prune removes a pending row whose pane is still alive but has no agent, once the row is older than 2 minutes (P1 manual). The README says so, and the automatic prune keeps that row.
- A wrong-workspace `--terminal` row is kept by the automatic prune, because the terminal exists in another workspace. That follows S2's absence rule, and manual prune removes it.
- Not checked against live Herdr close timing or a real seat wake.

Noticed beyond my task: the 1-second time margin in S2's `agent-lifecycle.test.ts:489-514` (`now: Date.now() + 121000` against a 120000 ms age) can fail under parallel load. Owner: S2 or the seat.
