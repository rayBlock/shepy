# rev-s2: review of Shepy slice 2 (lifecycle and self-cleaning)

Reviewer: rev-s2. Candidate: `night/s2` at `d3e5169`, base `50ca705`, 15 files, read in full. Reviewed detached in my own scratch worktree. Brief: `brief-rev-S2.md`; acceptance: `acceptance-check-2.md`, section S2.

**REVISE.** The core design holds. Done comes before gone, the old identity is frozen for attribution, and subscription removal shares the index transaction. A reused name does not inherit a subscription, and pruning is scoped to one session. Three defects need a fix and a recheck. A Claude seat sees each gone notice as a second "done" (F1). Two inputs that Herdr's own schema allows make every refresh of a session fail, which freezes gone, done-by-snapshot and pruning (F2, F3).

## Findings
**F1 (high). A Claude seat sees gone as "done".** `src/cli/claude-hook.ts:1301-1308` has no case for `agent.gone`, so the line reads `- builder done (pi, w1:p1): (no assistant message)`. The real use ("done notice, then exactly one gone notice") fails for the factory seat, which is a Claude session. Pi prints the type and is unaffected. Reproduction: probe P6, `formatHookContext("seat", [obligation with type "agent.gone"])`.
**F2 (medium). A move can collide with a unique index and stop every refresh.** `moveSubscriptions` (`profile-delivery-service.ts:251-277`) rewrites the row in place (`orchestrator-profiles.ts:171`). If the same profile already has an identical row (same name in the target workspace), SQLite throws `UNIQUE constraint failed` inside the replacement transaction. The whole refresh rolls back, and every later refresh fails the same way. The session gets no gone, no index updates and no prune until the other worker leaves. Reproduction: probe P7b. Two workers named "builder" are in w1 and w2, with one name subscription per workspace. The w1 worker moves to w2 (same terminal, new pane): 4 of 4 refreshes throw.
**F3 (medium, regression). One `agent: null` entry refuses the whole snapshot.** `agent-index-service.ts:219-229` throws when any agent entry lacks `agent`. Herdr 0.9.3's schema (`AgentInfo.agent: string|null`, plus a `launch_pending` flag) allows this. The base indexes such a snapshot normally, and the candidate refuses it on every refresh, so a real close in the same session is never seen. Reproduction: probe P1 adds `{agent:null, launch_pending:true}` next to three healthy workers. Candidate: error, zero gone. Base: no error. The live snapshot has 0 such entries out of 43, so this has not been seen in practice. Suggested fix: skip that entry and keep its terminal and pane counted as present, rather than refusing everything.
**F4 (low). A pane-id shift or swap merges pane subscriptions.** Moves are applied one at a time, and each is resolved against the pre-move list after earlier rows were already rewritten. If worker A moves p1 to p2 and worker B moves p2 to p3, both subscriptions end on B. In a swap, both end on A (probe P2/P2b). The base was already wrong here in a different way. Herdr's ids look random (`w3J:p0C`), so this is unlikely. Fix: compute all moves first, then apply them.
**F5 (low, question 4). Auto-prune also removes rows that never matched, not only legacy rows.** `profile-service.ts:180` removes any unmatched row older than 2 minutes after a healthy refresh. A subscription made before Herdr detects the agent (the S3 plan: "subscribe a pane with no agent yet") is deleted silently after 2 minutes. That worker's later done is then never delivered (probe P4). The factory's `worker.ts` subscribes after `agent start`, so it is not hit today. The README (`:174`) describes only the legacy case. Owner: seat, before S3.

## Answers to the brief
1. One gone per worker: holds for a live close, a close while the daemon is stopped (one on the first refresh after restart, then zero on later refreshes), an agent exit with its pane left open, and a disconnect. Tests and my reruns confirm this. Exception: F2 and F3 give zero.
2. Order: done is always projected before gone. On the real refresh path (P3), a close that lands inside the 0.5 s retry window for a missing final message shares the in-flight refresh (`agent-index-service.ts:143`). Gone then waits for the next refresh: up to 10 s while another worker is working, otherwise up to 60 s. Not a defect. The test "close during the missing-final retry" calls `handleHerdrEvent` with `pane.closed`, a path the watch loop never takes (`:417`), so it does not test the real path.
3. A reused name does not follow the old subscription (tests plus my reads). Moves: see F2 and F4.
4. Unavailable, malformed and stopped sessions and a second Herdr session do not prune (tests, plus `watch-manager:304` and `profile-service.ts` session filter). Silent prune: see F5. A small extra: P5 shows that a done which was ambiguous when it happened (two workers with the same name) is delivered later, at gone, by the replay (`profile-delivery-service.ts:243`).
5. No S1 or S4 regression found. The failures listed below are timing failures, not defects.
6. `profile-delivery.test.ts:3095` passed 5 of 5 runs. Run 5 had a different 5 s timeout at `:2307`, a test S2 does not touch. With the timeout lifted, 3 runs on base and 3 on candidate all passed. Both tests normally take 12 to 108 ms, and multi-second stalls hit base (4.4 s) and candidate (2.1 s) alike. **Load, not a defect.**
7. S5 (`f5d689f`) cherry-picks onto S2 with no conflicts. The combination typechecks, and the lifecycle, socket and screen-text tests pass (56). Landing order cost is low. But the F1 fix sits next to S5's hunk at `claude-hook.ts:1306`, so expect one small manual merge there.

## Checks (Node 24.18.0, Vitest 4.1.9 via `node_modules/.bin/vitest run`; `run-tests.mjs` refuses the linked dependencies, no install; `env -i` with fresh HOME and TMPDIR `/private/tmp/rs2/*/t`; Claude variables absent)
- Typecheck: candidate exit 0, 8.3 s. S2 plus S5: exit 0, 10.7 s.
- Lifecycle file alone: 4 of 5 runs green (4 to 24 s). With `--testTimeout=60000`, 6 of 6 green, and multi-second stalls hit a different test each run. Load.
- Touched plus S1/S4 files (12 files, 370 tests, load 24, 138 s): 362 passed and 8 failed. Five are 5 s timeouts (claude-hook 3, lifecycle disconnect 1 at its 2 s fixture deadline, notice-correctness 1). Three are wall-clock limits in notice-correctness, as rev-s1 reported. Load.
- Full suite under `lockf`, started at load 36 (57 s): 1159 passed and 40 failed. None of the 40 is S2's. 35 are `claude-profile-demand-validation`, which says NOTRUN because only `run-tests.mjs` grants its admission. 1 is `run-tests.test.ts`, which refuses the linked dependencies. 2 are Codex history tests (`observability-rpc` agent.read, `agent-history-readers`), which fail the same way on base `50ca705`. 2 are notice-correctness wall-clock limits (510 and 520 ms against 450), which rev-s1 already reported. An earlier full run does not count because it got the lock at load 68. Its results were the same apart from the notice-correctness pair.
- Probes P1 to P7b: P1, P2, P2b, P6 and P7b fail as described; P3, P4, P5 and P7 run and show the stated behavior.

## Limits and provenance
Not checked against live Herdr: how often `pane.created`, `pane.agent_detected` and the other new global events arrive. Each one now restarts the subscription and runs a full refresh plus a prune for every profile. The builder's cost figures are for idle only. Not checked: `shepy profile unsubscribe` on a row the daemon already removed, which is `worker.ts:251`'s abort path after a pane close. Live read-only: `herdr api schema --json` and a count-only `herdr api snapshot`. No daemon touched. Scratch (probes `probes.test.ts` sha256 3ea6ad06…, `probes2.test.ts` 3702ebd3…, logs): `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-rev-s2/0d8834e7-fd64-44ca-94b1-9677362a0826/scratchpad`.
Next owner: S2 builder for F1 to F4, then a recheck. Seat for F5.

## Noticed beyond my task
- The socket fixture's `until()` has a fixed 2 s deadline (`agent-lifecycle.test.ts`), and testTimeout does not cover it. It will flake in the shared gate under load. Owner: S2 builder.
- `agent_events` has no index on `agent_id`, so each gone scans the whole table inside the transaction (`agent-events.ts:151`). The builder noted this too. Owner: seat, for a retention decision.

## Recheck of correction dd879f2 (2026-10-22)
Directed recheck of my own findings, not blind discovery. Candidate: `night/s2` at `dd879f2` (one commit on `d3e5169`, 17 files, diff read in full). Seat rulings checked: gone gets its own line, and F5 prunes only legacy rows or rows whose pane is absent from a complete healthy snapshot.

**ACCEPT.** All five findings and the fixture deadline are fixed. My original probes now pass, and the new failures in the full suite are not caused by S2.

- F1 fixed: a Claude seat now reads `- builder gone (pi, w1:p1)`, without "done" and without an excerpt (P6).
- F2 fixed: the duplicate destination now merges into one row, and repeated refreshes succeed (P7b, 4 of 4).
- F3 fixed: an `agent: null` launch-pending entry no longer blocks a real close in the same snapshot (P1 gives one gone).
- F4 fixed: in a pane-id shift and in a swap, each subscription keeps its own terminal (P2, P2b).
- F5 fixed as ruled. A new terminal row whose shell pane exists but has no agent yet is kept past 2 minutes, and its later done is delivered (P4a). A new row whose terminal is absent from a healthy snapshot is pruned, while a new name row is kept (P4b). A new row is never pruned without presence data, and a legacy row is pruned (P4c).
- Fixture deadline fixed: `until()` now waits on Vitest's test signal (`agent-lifecycle.test.ts:691`), so the test timeout governs it and there is no separate 2 s limit. The lifecycle file passed 30 of 30 in each of 3 runs (4 to 6 s).
- P3 and P5 behave as before (both were notes, not defects).
- Note, not a defect (P8): after the F2 merge, the profile's single `name builder` row in w2 matches two workers, so it follows neither until one leaves. The base behaves the same (that workspace's name is ambiguous), so this is not a regression.

### Checks (load 4 to 10, same environment as above)
- Typecheck: exit 0. My probe file has its own type errors, so I ran it outside the candidate's tree.
- Touched files plus S1/S4 files, 15 files: 398 of 398 passed, 21 s.
- Full suite under `lockf`, at load 5.1 (62 s): 1171 passed and 41 failed. None of the 41 is S2's:
  - 35 are `claude-profile-demand-validation` NOTRUN, because it needs `run-tests.mjs` admission.
  - 1 is `run-tests.test`, which refuses the linked dependencies.
  - 2 are Codex history tests, which also fail on the base.
  - 1 is the `herdr-plugin-package` `npm pack` 5 s timeout. The base also failed it in 2 of 5 control runs.
  - 2 are notice-correctness wall-clock limits (463 and 533 ms against 450).
- Notice-correctness timing: run alone, the retry test passed 6 of 6 on both versions. Whole-file runs, alternating: base failed 2 of 5, candidate 4 of 5. A different test failed each run, including a 4.9 s stall on the base. Other heavy processes were running on the host (a node at 160% CPU, fseventsd at 100%). I count this as load, not a slowdown. The candidate failed more often in my samples, but I found no S2 code on these tests' status-event path that would add time. Owner: seat, for the gate's timing budget, as rev-s1 already recommended.

### Cherry-picks onto dd879f2 (conflicts only)
- S5 (`night/s5` tip is now `bbb080c`, not `a5bc4f9`; all 3 commits): no conflicts, `claude-hook.ts` included.
- S3 (`night/s3` tip `f698a61`): `f13ec10` conflicts in 4 files, one hunk each.
  - `README.md` (30 lines): both slices add a section.
  - `src/db/orchestrator-profiles.ts` (86 lines): S2's `moveSubscriptions` and S3's new store code sit at the same place.
  - `src/observability/agent-index-service.ts` (6 lines): `onAgentsMoved` against `onAgentsObserved`.
  - `src/observability/profile-delivery-service.ts` (10 lines): imports.
  - The other S3 commits apply. S3 adds no migration, so there is no clash with `0013`.
- S5 then S3: the same 3 code conflicts. README resolves itself.
- I did not judge the semantics of these conflicts. Whoever merges S3 needs to decide how S2's move and prune treat S3's new terminal-session selector.

Probes: `recheck-probes.test.ts` (sha256 c48d8d53…) in the scratch folder named above. Scratch worktrees are removed.
