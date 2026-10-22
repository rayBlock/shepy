# Appendix: every Shepy test classified (slim-shepy research)

Companion to `research-slim-shepy.md`. Five readers wrote these parts; each test is in exactly one line group, and the counts add up to the 1,285 registered tests. Test numbers (`#n`, `[n]` or bare `n`) are the 1-based line numbers of the per-test list from full run 2 (file order as vitest registered them; a `test.each` row counts as one test). Reason codes: probe, round, impl, pin, stale, dup, timing, retired, trim (goes with SHEPYTRIM), ops (operations feature Ray may remove).

Parts: 1 claude hook and sockets; 2 profile, notice, orchestrator and demand; 3 Pi extension, outcome context and CLI; 4 agent index, history and context; 5 daemon, Herdr client, config, operations, packaging and runner.

---

# Part 1

Numbering: "#n" is the 1-based position of the test in `scratchpad/titles/<file>.txt` (second full run, load about 17). Gate seconds are the sum of per-test durations in that run. Every test body was read. "Keeper" names the test a merged test folds into.

### FILES

#### test/integration/claude-hook.test.ts (own 178, gate 54.1 s) keep 55 / merge 35 / drop 41 / trim 47

Socket wake group (#1 to #37, 17 of them drop):
- #1: KEEP — opt-in off by default, a real hook claim registers the socket, the wake posts auth then one user frame, never for the owner's own outcome, once across a restart. The headline wake behaviour.
- #2: KEEP — a working owner gets one queued batch ("shepy: 2 finished: ..."), no terminal prompting. #3 (the blocked row of the same `test.each`): MERGE as a row of #2.
- #4: KEEP — 55 pending outcomes give one bounded single-line nudge (at most 240 characters, no newline).
- #5: KEEP — Stop recovery of a lapsed owner records the current session's socket, not a stale one (a wake to the wrong pane otherwise).
- #6: KEEP — absent, relative, outside, regular-file, symlink and group-writable sockets never wake, hook delivery still works. Safety refusal.
- #7: MERGE into #1 (self outcome alone never wakes; the legacy pane-as-terminal row becomes one more assert in #1). #8: MERGE into #7 as a second row (same pane id in another Herdr session is not "own").
- #9 to #13: DROP probe — five of the six cells of "unresolved identity cannot self-wake" (UserPromptSubmit and Stop times empty, lookup-failure, ambiguous). Keeper: #10 (prompt, lookup-failure; it also covers clearing a previously admitted socket). #14 (Stop, ambiguous): MERGE as a row of #10. Drops: #9, #11, #12, #13.
- #15: KEEP — the unchanged owner wakes without renewing the lease or delivering. #17 (already-expired): MERGE as a row of #15. #16 (grace), #18 (expires-before-timer), #19 (expires-after-connect): DROP probe, timer-race cells of one rule.
- #20: KEEP — a restart recovers an unattempted wake once and never resends it (the only test of `start()` recovery).
- #21: KEEP — a different session claiming an expired owner fences the old wake (before-timer). #22 (after-connect): DROP probe.
- #25: KEEP — an expired owner's socket path swapped for a symlink fails closed (the one that could leak a token). #23, #24, #26, #27, #28 (gone and file, before and after connect, and symlink after connect): DROP probe, same fail-closed rule by another replacement.
- #29 (owner replaced, before-timer): MERGE into #21 (same fence, same assert). #30 (after-connect), #31 (socket permissions changed), #32 (released after expiry), #34 (service closed): DROP probe or impl. #33 (profile switched off): KEEP — a switched-off profile never wakes, even with a queued batch.
- #36: KEEP — an ambiguous send is never retried, not after a SQLite reopen and not for a changed pending subset. #35 (refused-connect) and #37 (throws): MERGE as rows of #36.

Hook turn behaviour (#38 to #104):
- #38: DROP dup — claude-hook argument parsing; `test/unit/cli.test.ts` holds the parser tests (it has a "claude-hook --profile-demand opt-in parsing" block) and #177 covers SHEPY_PROFILE.
- #39: KEEP — pending outcomes become bounded context, are marked delivered, the token is stored 0600 and never on stdout. Main happy path.
- #40: KEEP — the next prompt acks the previous delivery when no Stop ran. #41 (stale record cleared when nothing is pending): MERGE as a second turn in #40.
- #42: MERGE into #60 (nothing pending is silent and still claims).
- #43: KEEP — a hostile worker name cannot forge outcome lines. Safety.
- #44: DROP probe — owner file stays 0600 over a pre-existing 0644 file (the 0600 mode is already asserted in #39).
- #45: KEEP — a symlink planted at the owner-file path is never followed.
- #46: KEEP — one session owning two profiles keeps two records and a Stop acks only its own.
- #47: KEEP — acks are fenced by the stored record, so a corrupt record acks nothing.
- #48: KEEP — a claim held by another pane exits 0 and names the owning pane. #49: KEEP — an unknown profile says so. #50 (profile with no subscriptions): MERGE as a row of #49.
- #51: KEEP — an unwritable owners directory warns the operator and loses nothing.
- #52: DROP impl — "first claim omits currentLeaseToken" asserts a wire key is absent; a first claim that works is shown by #39.
- #53: KEEP — a re-claim presents the stored token, gets the new one, stores it.
- #54: KEEP — a pane whose token was superseded gets the distinct stale-token line and nothing is leased. #55: DROP dup — a copy of #54 with the same body (only an `if` gate differs). #57 (the same two warning lines as a unit): DROP dup of #54 and #48. #58 (both warning lines fit the systemMessage budget and are one line): MERGE into #54.
- #56: KEEP — a lapsed owner re-claims at the next prompt by proof of possession and is delivered.
- #59: KEEP — Stop delivers a fresh outcome as additionalContext and acks this prompt's delivery. #60: KEEP — nothing pending at Stop is silent and acks. #61: KEEP — stop_hook_active never continues again. #64 (stop_hook_active on a lapsed owner settles and never re-claims or leases): MERGE as a second turn in #61.
- #62: KEEP — a Stop on a lapsed owner recovers exactly once. #63 (a rival wins the Stop recovery race): DROP probe; the warning wording is covered by the lapsed-recovery unit test and #48. #65 (owner-file compare-and-swap contested mid-recovery): DROP probe; the real cross-process race is #99.
- #66: KEEP — a record stranded at "leased" by a crash is never acked; the outcome is re-delivered. #67 (record persisted before inbox.delivered): DROP impl, ordering spy; outcome shown by #66.
- #68: KEEP — when inbox.delivered fails the record is reverted so nothing is acked unseen. #69 (the same on Stop): MERGE as a row of #68.
- #70: DROP round — an owner file in a previous round's shape (no phase field) is discarded. A review-round compatibility case for a format that only ever existed on this branch family.
- #71: KEEP — a slow Stop cannot overwrite a newer prompt's record (Claude Code does not serialise hooks).
- #72: KEEP — the untrusted-output policy line appears on every delivery and notices carry no machine ids. #73 (constants pinned to 6,000 and 120): MERGE into #74 (keep only "at most the platform caps 8,000 and 200"; drop the toBe pins).
- #74: KEEP — 20 fat outcomes stay under the character and line caps, one bullet each. #75 (line cap with 100 short lines): MERGE as a row of #74. #76 and #77: MERGE into #74. Their titles say "defers" but both assert that nothing is deferred (`deferredIds` is `[]`), so the deferral half is dead for agent outcomes. What stays is "all 20 delivered, then the ack-only Stop acks exactly those", added to #74.
- #78: KEEP — blocked outcomes lead and excerpts cap at 200 characters with the read hint. #79 (status words), #80 (gone has its own line), #81 (read hint rules): MERGE as rows of #78.
- #82, #83, #84, #85: DROP dup or stale — (a) to (d) formatter cells. (c) is titled "a deferred tail" and asserts no deferral. #85 repeats the no-machine-ids assert of #72.
- #86: KEEP — an ESC in an excerpt never reaches the rendered context.
- #87: KEEP — daemon unreachable exits 0 with no stdout. #88 (malformed stdin), #89 (no session id), #90 (unknown hook event): MERGE as rows of #87.
- #91: KEEP — missing Herdr pane variables warn the operator, name the variable, and lease nothing. #92 (only one variable missing): MERGE as a row of #91.
- #94: KEEP — a persistent inbox.delivered failure warns on every repeat turn before the rows dead-letter. #93 (malformed lease response is silent once, warns on repeat), #95 (the same on Stop), #96 (an empty-lease turn keeps the failure marker): MERGE as rows or extra turns of #94.
- #97: KEEP — the production hook child process ignores inherited test-synchronisation variables and delivers normally (the only real child-process happy path; guards that test hooks do not ship). #98 (the same child, lock contended): DROP dup of #102.
- #99: KEEP — two real hook processes race one owner record and no batch is acked unseen. #100 (second ACK is not a write-phase witness): DROP probe, harness-ordering variant of #99.
- #101: DROP dup — profile ids `a:b` and `a_b` get distinct owner files; the injective filename unit test (owner-file #2) covers it.
- #102: KEEP — a lock that cannot be taken within 500 ms makes the hook abandon the batch; rows stay leased. Folds in owner-file #10.
- #103: KEEP — a SIGKILL between the temp write and the rename leaves the old record readable; recovery steals the orphan lock. Folds in owner-file #7 and #11. Costs 2.5 s because it waits 2.1 s of real time for the lock to age. #104 (inode replaced by rename): DROP impl, the SIGKILL test shows the behaviour.

Demand group (#105 to #151, 47 tests): TRIM — goes with SHEPYTRIM. #105 to #112 opt-in and capability (8), #113 to #145 demand delivery (33 including 21 nack cells), #146 to #151 demand formatter (6). Also the shared helpers `validDemand`, `leaseAsDemands`, `utcFromNow` and the `profileDemand` override in `runHook`, which go with them. One non-demand row in this block: #151 "an all-agent batch keeps the agent-only header" is covered by #72 and #78.

Handover group (#152 to #178, 27 tests):
- #152: KEEP — a live owner terminal blocks a rival's takeover. #154 (owner pane still live, legacy shape): MERGE as a row of #152.
- #153: KEEP — a gone owner terminal lets the rival take over and receive the pending notices.
- #155: KEEP — a Herdr error, malformed or partial answer fails closed (one representative). #156, #157, #158, #159 (malformed, missing-type, wrong-type, partial): DROP probe. #163 (unreachable Herdr): MERGE as a row of #155.
- #160: KEEP — a silent Herdr peer fails closed within the one-second deadline. Real wait of about 1 s (see wall-clock list).
- #161: KEEP — an owner with no terminal id never permits early takeover. #162 (owner in another Herdr session): MERGE as a row of #161.
- #164: KEEP — the real CLI with SHEPY_PROFILE set claims without a flag. #165: KEEP — a non-owner cannot release the profile (CLI and SessionEnd). #166 (a borrowed record in a foreign session file): MERGE as a row of #165. #167: KEEP — `shepy profile release` by the owner hands pending notices to the next pane once, and a later takeover after the pane closes.
- #168 (missing index, then repair): MERGE into #170. #169 (ambiguous index): DROP probe. #170: KEEP — a legacy owner whose terminal id is its pane id never permits early takeover, even if the pane is gone (documented in the README). #171 (confirmed terminal): DROP dup of #152 and #153.
- #172: KEEP — two rivals racing a gone owner: one wins, one delivery. #178 (two claimants after release): MERGE as a row of #172.
- #173: KEEP — an owner with a current token makes no Herdr request (hook latency stays flat).
- #174: DROP probe — calls `claimWithOwnerCheck` directly, not a public entrypoint.
- #175: KEEP — the wire cannot supply the daemon's internal gone-owner proof. Safety refusal.
- #176: KEEP — SessionEnd releases only its own session, and pending notices transfer once.
- #177: MERGE into cli.test.ts (the parser keeper there): SHEPY_PROFILE replaces the flag but never overrides it.

#### test/unit/claude-hook-lapsed-recovery-warning.test.ts (own 2, gate 0 s) keep 1 / merge 0 / drop 0 / trim 1
- #1: KEEP — the rival warning names pane and harness, is one line, within budget, and hostile identity cannot forge lines. The cheap guard that replaces integration #63.
- #2: TRIM — "demand-capable pane is not told nothing can arrive". The agent-only wording half is asserted by integration #49/#50.

#### test/integration/claude-socket-identity.test.ts (own 10, gate 9.9 s) keep 4 / merge 0 / drop 6 / trim 0
- #1: KEEP — a different process bound at the same socket path before the timer sends zero frames (inode identity). #5: KEEP — the same swap after connect sends nothing. #2, #3, #4, #6: DROP probe — the expired-lease and before-connect cells of the same rule (three timings times two lease states).
- #7: KEEP — the original socket still receives its wake after a restart (positive control). #8 (expired=true): DROP probe, 2.5 s.
- #9: KEEP — a legacy capability without socket identity stays absent until the pane re-claims. #10 (expired=true): DROP probe.

#### test/unit/claude-messaging-socket.test.ts (own 12, gate 0.4 s) keep 4 / merge 3 / drop 5 / trim 0
- #1: KEEP — auth first, user second, each waits for local flush, never an ack. #2: KEEP — one-second bound on connect (fake timers); #3 (write): MERGE as a row.
- #8: KEEP — a throw while writing is bounded and never exposes exception text. #5 (close) and #11 (safe adapter boundary): MERGE into #8. #4, #6, #7, #9, #10 (error, end, write-error, frames-throws, connect-throws): DROP probe, same rule by another stage.
- #12: KEEP — socket admission refuses foreign uid, missing auth, noncanonical, nested and outside paths.

#### test/unit/owner-file.test.ts (own 12, gate 1.0 s) keep 2 / merge 6 / drop 4 / trim 0
- #2: KEEP — the filename pairing is injective. #1, #3, #4 (distinct ids, long ids, lock path): MERGE into #2. Integration #101 is dropped in favour of this.
- #9: KEEP — a moved record refuses the swap; the newer record survives.
- #7 (atomic replace) and #11 (orphan lock stolen): MERGE into integration #103. #10 (lock held by a live process times out): MERGE into integration #102.
- #5 (record for another profile reads as absent): DROP probe. #6 (old filename scheme reads as absent): DROP stale — a migration of a layout no longer produced. #8 (symlink at the record path): DROP dup of integration #45. #12 (unusable storage is a classified failure): DROP dup of integration #51.

#### test/unit/context-health-claude.test.ts (own 18, gate 0 s) keep 5 / merge 10 / drop 3 / trim 0
- #1: KEEP — the reading is the last manager assistant entry's billed prompt. #2 (all-zero usage), #3 (empty file): MERGE as rows of #1.
- #4: KEEP — a compact boundary blocks usage recorded before it. #5 (a compact summary is not a boundary): MERGE as a row.
- #9: KEEP — a later entry without usage marks the reading stale. #10 (all-zero later usage): MERGE as a row. #6 (branch change): MERGE as a row of #11.
- #11: KEEP — a model change after the reading invalidates it. #14 (away and back): MERGE as a row.
- #13: KEEP — a sidechain never becomes the reading. #15, #16, #17, #18 (the four P2 sidechain cells): MERGE as rows of #13.
- #7 (two session ids add a limitation), #8 (unknown trigger degrades), #12 (string compactMetadata): DROP probe.

#### test/unit/profile-selectors.test.ts (own 15, gate 0 s) keep 4 / merge 7 / drop 4 / trim 0
- #4: KEEP — globs, unknown kinds and empty values fail closed. #1, #2, #3 (workspace and agent selector parse cells): MERGE as rows of #4.
- #5: KEEP — resolves by exact name. #11 (legacy unguarded terminal selector still matches): MERGE as a row.
- #6: KEEP — an ambiguous match fails closed with the candidates. #8 (unmatched names the selector): MERGE as a row. #7 (two agents named alike): DROP dup of #6.
- #13: KEEP — equal native values from a different source cannot bypass the session guard. #10 (guard round trip) and #12 (pending guard readiness): MERGE as rows.
- #9: DROP stale — "scope is the caller's filter, proven here" filters an array in the test and asserts nothing about the source.
- #14, #15 (`selectableFromRow` shape and malformed JSON): DROP impl.

#### test/unit/profile-selector-scope.test.ts (own 6, gate 0 s) keep 1 / merge 1 / drop 4 / trim 0
- #1: KEEP — an identical workspace id in another Herdr session is never a candidate. #5 (no in-scope match is unmatched): MERGE as a row.
- #2 (runtime kind plus cwd ambiguous), #4 (name held by two live workers): DROP dup of selectors #6. #3 (out-of-scope twins do not inflate): DROP probe. #6 (matched resolution carries the raw record): DROP impl.

#### test/support/claude-hook-loader.ts, test/support/owner-file-injected.ts (66 lines, not tests)
Test-only preload that swaps the owner-file module for a version with gates. After the cut only #99 and #103 use it. Keep. It reads `SHEPY_HOOK_TEST_*` only in test-owned code. The shipped `casOwnerRecord(input, hooks)` signature carries the hook parameter, which is a test seam in a shipped file (B06).

### BEHAVIOURS

| Behaviour in plain words for a user | Best guard tests (file > title) |
|---|---|
| A Claude seat pane that owns a profile sees finished-worker outcomes at the next prompt and at Stop, once, bounded, marked untrusted | claude-hook > #39, #59, #72, #74, #78 |
| The hook never breaks Claude: exit 0 and silence on daemon down, bad input, missing Herdr variables; the operator is told when a pane is deaf | claude-hook > #87, #91, #51, #94 |
| A pane that is not the owner learns why and nothing is stolen; a stale token gets its own message | claude-hook > #48, #54, #165 |
| Handover works: SessionEnd or `profile release` passes pending notices on once; a takeover only when the owner's terminal is truly gone | claude-hook > #167, #176, #153, #170, #172 |
| No outcome is marked seen unless the model was shown it, across crashes, failures and racing hooks | claude-hook > #66, #68, #71, #99, #102, #103 |
| An idle Claude seat is nudged through its own messaging socket: one bounded line, only for other panes' outcomes, only the socket it registered, never retried when ambiguous, opt-in | claude-hook > #1, #4, #6, #15, #21, #25, #33, #36; claude-socket-identity > #1, #5 |
| Hostile worker names and control bytes cannot forge or corrupt the injected text | claude-hook > #43, #86 |
| The Claude pane's context fullness is read from the transcript, ignoring sidechains, compactions and model changes | context-health-claude > #1, #4, #9, #11, #13 |
| Subscriptions pick workers by exact name, pane, terminal or session; ambiguity and wrong scope fail closed | profile-selectors > #4, #5, #6, #13; profile-selector-scope > #1 |

### WALL-CLOCK BOUNDS UNDER 1 s

Real elapsed time under 1,000 ms in, or relied on by, these files. "Class" is my classification of the test that contains it. "Failed" is whether it failed in either of my two full runs (none of these did; the parent's earlier review rev-s5 reports `claude-hook` 5 s timeouts at load 24 to 28 in some runs).

| file:line | bound | what it does | class | failed here |
|---|---|---|---|---|
| claude-hook.test.ts:114 (`settleSocketWake`), used at :150, :182, :281, :310, :417, :476, :507, :554, :591, :645, :669, :671, :683 | 30 ms | sleeps "to give the wake time", then asserts that no frame was posted. Under load the wake may not have started within 30 ms, so the absence assert can pass without proving anything (false green, not a flake) | #1, #6, #7..#37 (13 call sites); keep 8, merge or drop the rest | no |
| claude-hook.test.ts:170, :186, :210, :240, :261, :335, :433, :469, :501, :511 | `vi.waitFor` default: 1,000 ms timeout, 50 ms interval | waits for socket frames to arrive; real sockets, `batchDelayMs: 1`. Exactly 1 s, so any load stall past 1 s fails the test | #1, #2, #4, #5, #6, #8, #9..#14, #15..#19, #20 | no (rev-s5 saw this class red under load) |
| claude-hook.test.ts:2173 | `vi.waitFor` default 1,000 ms | waits for the parked Stop to reach `inbox.ack` | #71 (keep) | no |
| claude-hook.test.ts:92 (`batchDelayMs: 1`) | 1 ms | the production wake batching timer shortened; two `schedule()` calls must land in one batch ("shepy: 2 finished") | #2 (keep) | no |
| claude-hook.test.ts:4240 to 4263 | assertion `elapsed < 2,000` for a silent Herdr peer; production deadline is 1,000 ms | real 1 s wait plus the 2 s ceiling. Measured 1,274 ms | #160 (keep). The ceiling is above 1 s but only 0.7 s of slack | no |
| claude-hook.test.ts:4407 to 4414 | `elapsed < 2,000` | the third takeover must finish within 2 s | #167 (keep) | no |
| claude-hook.test.ts:2958 to 2975 | `< 8,000` ms | child process start and delivery, "excludes either former 10-second pause" | #97 (keep). Above 1 s, listed because it has failed in the factory when loaded | no |
| claude-hook.test.ts:3308 | waits until the lock file is older than 2,100 ms | real 2.1 s wait for production `OWNER_LOCK_STALE_MS` (2,000 ms) | #103 (keep) | no |
| claude-hook test mechanism: owner-file-injected.ts:34 | 5 ms poll up to 10,000 ms | gate wait inside the test-owned child | #99, #103 | no |
| claude-socket-identity.test.ts:168 (`settle`), used at :214, :230, :259, :283 | 60 ms | the same "sleep then assert no frames" | #1..#10 (4 call sites) | no |
| claude-socket-identity.test.ts:216, :249, :291 | `vi.waitFor` default 1,000 ms | waits for a result or frames from a receiver in another process; the comment at :137 says the second receiver must start "before the transport's one-second deadline", which a loaded machine can miss | #1, #5, #7 | no |
| owner-file.test.ts:255 to 268 | `elapsed >= 100` and `< 10,000` | waits out the real 500 ms lock budget (`OWNER_LOCK_BUDGET_MS`) | #10 (merge into integration #102) | no |
| claude-hook.test.ts:2970 and :3238 (tests #97 contended, #102) | 500 ms real wait (production `OWNER_LOCK_BUDGET_MS`) | the hook gives up after the production lock budget | #102 (keep), #98 (drop) | no |

Fake-timer uses (not flaky): claude-messaging-socket.test.ts:76 and :82 (`useFakeTimers`, `advanceTimersByTimeAsync(1_000)`), one `test.each`, #2 and #3. Date arithmetic that is not a bound: claude-hook.test.ts:451 (`Date.now() - 1_000`, a grace-period timestamp), :2017, :2680, :2741, :2792, :2843, :3321 (simulated "now" a few minutes ahead).

Not wall-clock but noise: claude-hook.test.ts:4244 and :4411 and :4531 call `console.info("S4 fixture ...")` with timings and CPU counts. They measure for a report and assert nothing; they belong in a build report, not the suite.

### DROP GROUPS: WHAT IS LOST

| Group (tests) | Protection lost | Can a likely regression slip through? |
|---|---|---|
| Socket wake timing and replacement cells: #9 to #13, #16, #18, #19, #22 to #28, #30 to #32, #34 (about 20 in claude-hook) and socket-identity #2, #3, #4, #6, #8, #10 (6) | Each individual race (timer, connect, post-connect) and each replacement kind (gone, file, symlink) no longer has its own test | Low: one fence rule per class stays (#10, #15, #21, #25, #33; identity #1, #5, #7, #9). A new race path added beside the fence would not be caught |
| Herdr answer shapes: #156 to #159, #169, #171 (6) | Malformed, missing-type, wrong-type and partial pane lists each fail closed | Low: one error and one timeout stay; all go through one parser |
| Owner-file internals: #44, #67, #70, #98, #100, #104, owner-file #5, #6, #8, #12 | Mode over 0644, write-before-delivered order, old file shapes, inode replacement, classified storage failure | Low: the behaviours (0600 file, symlink refusal, crash safety, storage warning) stay in #39, #45, #51, #66, #103 |
| Warning wording duplicates: #38, #52, #55, #57, #63, #65 | Wire key absence on first claim, duplicate stale-token test, rival-wins race, CAS contested mid-recovery | Low: #48, #54, #62 and the lapsed-warning unit keep the messages; #99 keeps the race |
| Formatter cells #82 to #85 | Budget cells (a) to (d) | None: #74 and #78 assert the same caps and ids |
| Selector cells (selectors #7, #9, #14, #15; scope #2, #3, #4, #6) | Some duplicates of ambiguity and shape | None found; #9 asserts nothing about the source |
| Context-health probes #7, #8, #12 | Two session ids, unknown trigger, string metadata | Low: unusual transcript shapes only; a wrong reading shows as a wrong percent in `agent get` |
| Messaging socket stage cells (4 of 5) | Each socket stage error | None: one code path |

### RISKIEST DROPS

1. **#12 / #13 and #9, #11 (unresolved identity cells, Stop and prompt)**. If the identity lookup fails at a Stop claim, a stale socket from before could stay on the record and a later projection could wake the pane about its own outcome. Dropped because #10 covers the prompt and lookup-failure case and #14 (merged) the Stop ambiguity; the empty-index cells are the same code. If the owner-clearing code is ever split by hook type, add the Stop cells back.
2. **Socket-replacement cells (#23 to #28, #30 to #32, identity #2 to #4, #6, #8, #10)**. A swapped socket is the one place a messaging token could be sent to another process. I kept symlink-before-timer, the owner replacement fence and the identity before-timer and after-connect cells. The before-connect cell (identity #3, #4) is the window between identity check and connect and no longer has its own test.
3. **#63 and #65 (rival wins the Stop recovery race, CAS contested mid-recovery)**. If recovery after a lapse injected to the wrong pane, the user sees outcomes in two panes. #99 (two real processes) and #62 (single recovery) stay, and the rival warning is a unit test. The exact mid-recovery interleave is not repeated.
4. **#70 (round-2 owner file without a phase)** and **owner-file #6 (old filename scheme)**. They guard the upgrade path from an older file layout. They are review-round cases for a layout that never shipped beyond this branch family, so I dropped them; if a deployed seat still has old files, the failure is a one-off duplicate delivery, not a loss (the README says re-claim re-delivers).
5. **#76 / #77 (deferral to pending)**. The only tests of "the budget cannot show everything, so defer and ack only what was shown". They currently assert nothing is deferred, so they guard nothing today. The deferral code exists for demand rows, which go with SHEPYTRIM. If deferral is deleted in the trim, this risk is gone; if the code stays, the stale behaviour is unguarded either way.

### TOTALS

| File | own | keep | merge | drop | trim | gate s now | est. gate s after |
|---|---:|---:|---:|---:|---:|---:|---:|
| claude-hook.test.ts | 178 | 55 | 35 | 41 | 47 | 54.1 | 22.6 |
| claude-hook-lapsed-recovery-warning.test.ts | 2 | 1 | 0 | 0 | 1 | 0.0 | 0.0 |
| claude-socket-identity.test.ts | 10 | 4 | 0 | 6 | 0 | 9.9 | 3.9 |
| claude-messaging-socket.test.ts | 12 | 4 | 3 | 5 | 0 | 0.4 | 0.4 |
| owner-file.test.ts | 12 | 2 | 6 | 4 | 0 | 1.0 | 0.0 |
| context-health-claude.test.ts | 18 | 5 | 10 | 3 | 0 | 0.0 | 0.0 |
| profile-selectors.test.ts | 15 | 4 | 7 | 4 | 0 | 0.0 | 0.0 |
| profile-selector-scope.test.ts | 6 | 1 | 1 | 4 | 0 | 0.0 | 0.0 |
| **cluster total** | **253** | **76** | **62** | **67** | **48** | **65.4** | **27.0** |

Method for the seconds: the sum of per-test durations (vitest JSON, second full run, load about 17) of the kept tests; merged tests add a few asserts and are counted as 0. File setup (about 1 s for `claude-hook.test.ts` imports) is not in either column. The 27 s is the cluster after cut, a 59 percent drop in test time, about 70 percent drop in test count (253 to 76 kept plus 62 folded).
After the cut, the five slowest remaining tests are #6 (3.0 s), #170 (2.9 s), #103 (2.5 s), #21 (2.0 s) and socket-identity #1 (1.4 s); they are real-process or real-socket tests, not sleeps, except #103's 2.1 s lock-age wait.

---

# Part 2

Reader fork of slim-shepy. Base: Shepy main `7a7a3af` (this worktree). Timings: second full run under `env -i`, fresh HOME and TMPDIR, node 24.18.0, load about 17; durations are per test from the vitest JSON. Not every body was read in full. Read in full: notice-correctness (all timing tests and fixtures), screen-text-notice (hung, slow, 5 MB and failure tests), agent-orchestrator-service, orchestrator-disconnect-grace, the dedup, filter, lease-admission and renew sections of profile-delivery, and the subscribe fixture and `test.each` blocks. Classified from titles plus file structure and grep: the rest of profile-delivery and profile-subscribe, profile-diagnose, profile-isolation, profile-operation-resolution, scope-store, herdr-pane-identity-resolver and the demand files. Test numbers are the 1-based line numbers of `scratchpad/titles/<file>.txt` (a `test.each` row counts as one test). Class `merge` means: fold into the named keeper as a table row or an extra assert, so the test disappears but its assert stays.

### FILES
#### test/integration/profile-delivery.test.ts (own 81, gate 18.1 s) keep 30 / merge 45 / drop 6 / trim 0
- [1] keep — status.changed never reaches the owner; the semantic events do (absorbs 3 and 24).
- [3,24] merge,dup — "done wakes once, not twice" and "working/blocked still project" are extra asserts of 1.
- [20,21] keep — the live incident: seen-transition gives ONE notice; a genuinely new completion after reconnect still delivers (the no-lost-message control).
- [2,22,23] merge,round — seen-tab, missing-ref and restart variants of 20/21; fold into 20 as extra steps.
- [4] keep — replay dedup: four flaps deliver X once, a new final Y still delivers.
- [5,6,9] merge,probe — older-final, two-sessions and TTL invariants as rows of 4.
- [7] keep — a crash before delivery can never suppress a pending or leased final (nothing silently skipped).
- [8] drop,dup — asserts the Pi wake projection, which `shepy-pi-wake.test.ts` guards.
- [10] keep — OpenCode: four idle flaps with one source entry give one notice, across restart.
- [11] merge,probe — crash between stamp and obligation write; becomes a step of 10.
- [12] keep — a leased notice carries the event's own immutable snapshot, not live history.
- [13,18] merge,round — "row 15.309" later-lease and missing-event variants of 12.
- [14] keep — a Claude event carrying Pi history leases an explicit mismatch, never a wrong figure.
- [15] merge,round — missing context health gives a reason; row of 14.
- [16] keep — long excerpts are bounded with a read-back hint, tool bodies never ride.
- [17] merge,probe — hostile paneId in the hint; row of 16.
- [19] drop,dup — lease fencing is guarded by 37-39.
- [25,26] keep — operator retire clears the stale backlog without delivering, and never touches an actively leased row.
- [27,33] merge,round — olderThan and operator-retry variants of 25.
- [28,29] keep — profile-scoped projection; lease, delivery, ack retires exactly the batch.
- [30,36] merge,dup — foreign-token ack and nack are asserts of 29 and 37.
- [31] keep — unacked notices survive a daemon restart and redeliver once per lease.
- [61] merge,round — pre-upgrade lease stamps return to pending at startup; one step of 31.
- [32] keep — expired lease returns stranded rows; bounded attempts dead-letter.
- [34] merge,dup — subscription prune; guarded by profile-subscribe P4 prune (profile-subscribe #20).
- [35] drop,dup — "owner replacement" is the claim refusal in 43 and 44.
- [37] keep — inbox.lease with an unknown token is refused (the owner-only rule).
- [38,39] merge,probe — superseded-token variants of 37.
- [43] keep — claim, renew and inbox.lease flip together at exactly lease + grace (fake clock; one liveness rule).
- [40,41,51] merge,impl — the predicate, the owner_lapsed refusal and "renew never resurrects" are the same boundary as 43.
- [52,53] drop,dup — boundary and "stealable after 5m30s" repeat 43.
- [44] keep — a stale token stays not_owner even after the rival's lease lapsed.
- [42,58] merge,probe — rotated-token and stale-token-on-claim variants of 44.
- [45] keep — inbox.lease refusals carry a machine-readable code (the hook reads it).
- [46] merge,probe — "system errors carry no code"; an assert of 45.
- [47] keep — inbox.list never discloses the live lease token (security).
- [48,54,56] merge,probe — own-rows control; rejected claim and profile.owner never show token or subscriberId; rows of 47.
- [49] keep — profile.renew keeps a pumping owner unstealable past lease + grace.
- [50,57] merge,probe — non-owner renew returns false; holder re-claim control; asserts of 49.
- [59] keep — the takeover chain: two halves built from public RPC cannot mint a token.
- [55,60] merge,round — A2-2 and inbox.list variants of 59 ("round-3 review").
- [62] drop,probe — no-op control for the startup invalidation.
- [63] keep — `shepy profile owner` prints pane, workspace and expiry, never the token.
- [64] merge,probe — unowned message; row of 63.
- [65] keep — over-budget rows defer back to pending without burning an attempt.
- [66] merge,probe — foreign token defers nothing; row of 65.
- [67] keep — inbox.get returns the redacted obligation; unknown id is null.
- [68] merge,probe — list paging; assert of 67.
- [69] keep — an ambiguous selector projects nothing on delivery and says "ambiguous" on inspection.
- [70,71,72] merge,probe — same-name, wrong-worker and happy-path control; rows of 69.
- [73] keep — a same-workspace-id in another Herdr session is never a candidate (cross-session leak).
- [75] keep — claiming a nonexistent profile is rejected over RPC; no ghost owner.
- [74,76] merge,impl — service-level and whitespace variants of 75.
- [77] keep — a neutral (host-free) owner claims; profile.owner shows nulls.
- [78,79] merge,probe — partial host tuple refusal and token authority; asserts of 77.
- [80] keep — host events never touch a neutral owner (no terminal lookup, no presence claim).
- [81] merge,dup — hosted Pi positive control; control row of 80.


#### test/integration/profile-subscribe.test.ts (own 34, gate 18.0 s) keep 14 / merge 18 / drop 2 / trim 0
- [1] keep — the only real source-CLI process through daemon, Herdr socket and store; drop the 20-sample cost loop and the console.info (measurement, not a regression guard), about 3.5 s saved.
- [2] keep — pending before detection, first bind while working, replacement refused after restart.
- [5,18] merge,probe — repeat subscribes keep one row and one notice; delayed replacement event refused. Steps of 2.
- [3] keep — name reuse elsewhere cannot receive outcomes; a pane move keeps the subscribed terminal.
- [30] merge,dup — follow a terminal across workspaces; row of 3.
- [17] keep — bad pane identity and malformed session guards fail closed, then good input succeeds.
- [4,22] merge,probe — missing pane, wrong workspace, and caller-supplied native guards (including null) refuse without a row; rows of 17.
- [8] keep — a guarded subscription refuses old events without native identity.
- [26] merge,probe — "F3" another session's gone event; row of 8.
- [9] keep — re-subscribing legacy names consolidates rows without losing pending notices.
- [10,33] merge,round — legacy row id kept, legacy flag cleared; steps of 9.
- [12] keep — real indexed working-to-done events deliver only the bound session.
- [6,11] merge,impl — "binds before a history read" and "observations outside the workspace"; asserts of 12.
- [13] keep — Pi presence before detection pins the first session.
- [7,14,15,16] merge,probe — stale cached identity, older Herdr session, Herdr-over-Pi precedence, no inventory tick; rows of 13.
- [19] keep — the factory's existing terminal proof works before the first prompt publishes a session (the seats' real path).
- [20] keep — a pending row whose pane closes is pruned only after its age gate.
- [21,34] merge,probe — never-indexed row ages out; no-native-identity row is not pruned as dead; rows of 20.
- [23,24] drop,dup — service-seam copies of the gone-obligation checks in 27 and 29.
- [25] keep — a bound worker with missing native metadata shows one pending diagnostic prefix.
- [27] keep — close before native publication delivers one gone per profile.
- [28] merge,dup — opencode row of 27.
- [29] keep — closing a bound worker delivers gone and removes the guarded row.
- [31] keep — moving a bound terminal into a pending destination row binds without a uniqueness failure.
- [32] merge,dup — raw-source row of 31.


#### test/integration/profile-diagnose.test.ts (own 15, gate 6.4 s) keep 6 / merge 9 / drop 0 / trim 0
- [1] keep — healthy profile gives exactly one healthy info.
- [4,5,8] keep — no_owner, owner_lapsed and pending_not_draining blockers (the findings an operator acts on).
- [9] keep — the report never carries lease token, subscriber id or session ref.
- [14] keep — diagnose is read-only (byte-identical tables).
- [2,3,7,15] merge,probe — not-found, unmatched subscription, dead-letter warning, neutral Codex owner; rows of one table test with 1.
- [6,12,13] merge,probe — Claude cannot-wake-idle info and the version-skew warning with its control; rows of the same table.
- [10,11] merge,dup — in_grace and exact boundary repeat the liveness rule of profile-delivery 43.


#### test/integration/profile-isolation.test.ts (own 6, gate 2.9 s) keep 3 / merge 2 / drop 1 / trim 0
- [1] keep — each profile resolves only its exact subscribed worker.
- [2,5] merge,dup — unrelated worker absent; unmatched selector never matches cross-workspace; asserts of 1.
- [3] keep — same workspace id in another Herdr session is never a candidate (inspection path; the delivery path is profile-delivery 73).
- [4] drop,dup — ambiguity fails closed on both paths is profile-delivery 69.
- [6] keep — subscribe and unsubscribe round trip.


#### test/integration/profile-operation-resolution.test.ts (own 3, gate 0.7 s) keep 1 / merge 2 / drop 0 / trim 0
- [1] keep,ops — resolves exactly one dispatch target across a cross-session decoy.
- [2,3] merge,dup,ops — ambiguous and no-subscription refusals are 1's rows (and profile-delivery 69). Goes away if Ray removes the operations feature.


#### test/integration/notice-correctness.test.ts (own 27, gate 18.8 s) keep 13 / merge 12 / drop 2 / trim 0
- [1] keep — with no native identity, newer foreign and same-cwd files are refused (wrong text never shown).
- [7] merge,dup — duplicate Claude IDs choose the cwd project folder; row of 1 (and guarded in agent-history-identity).
- [2] keep — identity refreshed before reading; two Pi workers and Claude keep their own final text.
- [3] keep — startup unknown to idle or done without text never notifies (test.each over idle and done).
- [4] merge,dup — done row of 3.
- [5] keep — startup blocked emits once across restart and ticks; leaving and re-entering emits again.
- [6,21] merge,round — recovered unknown policy and "P4" persisted-working; steps of 5.
- [8] keep — one real delayed re-read repairs missing text without blocking another pane (README rule).
- [9,10,13,22] merge,round — previous-turn, unreadable, unflushed-next-user, "P5" variants; rows of 8.
- [11] keep — text still missing after the retry stays empty, never the previous turn; fresh text never waits.
- [12] keep — the watch stream publishes another pane while a final is pending and drains on stop.
- [14] keep — a new turn during the retry never attaches to the prior completion (event route).
- [15] merge,dup — snapshot route row of 14.
- [16] keep — status and event roll back together after an append failure, then restart recovers.
- [17,18,20] merge,round — snapshot route, semantic twin and initial-blocked failure; rows of 16.
- [19] keep — a pending retry leaves the row working; duplicate settled observations ignored.
- [23] keep — a snapshot batch publishes its fresh pane before the other pane's retry.
- [24] keep — a failed identity refresh refuses history instead of trusting the old session.
- [26] keep — five missing finals share one wait, not five serial sleeps.
- [25,27] drop,timing — "no retry delay" and "no per-agent sleep" only assert elapsed < 400 ms, repeats of 23 and 26.


#### test/integration/screen-text-notice.test.ts (own 13, gate 15.0 s) keep 8 / merge 4 / drop 1 / trim 0
- [1] keep — a reader-less kind finishes: the notice carries screen text, marked as screen text.
- [12] merge,dup — snapshot-refresh route; row of 1.
- [2] keep — a harness with a reader never reads the screen.
- [3] keep — two reader-less panes each carry only their own screen.
- [4] merge,probe — a reply naming another pane is dropped; assert of 3.
- [5] keep — done then idle on the same turn is one notice.
- [13] merge,dup — idle-then-done new completion notifies; row of 5.
- [6] keep — a failed read still sends the notice, marked unavailable (test.each over failed and empty screen).
- [7] merge,dup — empty-screen row of 6.
- [8] keep — a read that never answers is cut at the deadline and the notice goes.
- [9] keep — a slow read for one pane does not hold back another pane's event.
- [10] drop,dup — the 5 MB bound is guarded by the fast unit screen-text 3 and the label by 11.
- [11] keep — both renderers say "screen text", never "assistant", never point at `shepy agent read`.


#### test/unit/screen-text.test.ts (own 18, gate 0.0 s) keep 6 / merge 11 / drop 1 / trim 0
- [1] keep — an ordinary last answer survives; rules, prompts and blank lines drop.
- [3] keep — a 5 MB screen is bounded to the newest lines and characters.
- [2,4] merge,probe — ANSI stripping and one enormous line; asserts of 3.
- [5] keep — nothing readable is marked unavailable, not "empty ok".
- [6] keep — a harness with a reader never uses the screen (table over the six kinds).
- [7,8,9,10,11] merge,dup — claude, codex, opencode, gemini, hermes rows of 6.
- [12] drop,dup — "Claude" repeats [7].
- [13] keep — a reader-less kind uses the screen (table over five kinds).
- [14,15,16,17] merge,dup — amp, droid, copilot, kimi rows of 13.
- [18] keep — a missing kind is not claimed as reader-less.


#### test/integration/agent-orchestrator-scope-store.test.ts (own 6, gate 3.2 s) keep 0 / merge 0 / drop 6 / trim 0
- [1,2,3,4,5,6] drop,impl — unit tests of the scope store class; every transition is also asserted through the service (agent-orchestrator-service 1,3,4,5) and the server (disconnect-grace, pane-move). Row 7 of the trim plan (Pi workspace owner) stays, so the behaviour is kept elsewhere.


#### test/integration/agent-orchestrator-service.test.ts (own 5, gate 1.8 s) keep 4 / merge 1 / drop 0 / trim 0
- [1] keep — claim once, replacement, release only by the current owner.
- [5] merge,dup — persisted owners across sessions; assert of 1.
- [2] keep — ordered non-self pending events across scan pages.
- [3] keep — ownerless events dropped, replacement events kept; ack only the next pending event and only by the current owner.
- [4] keep — move ownership with ownerless-drop and active-owner preservation.


#### test/integration/orchestrator-disconnect-grace.test.ts (own 5, gate 1.8 s) keep 3 / merge 2 / drop 0 / trim 0
- [1] keep — an absent owner expires after the disconnect grace and the observer is told (manual scheduler).
- [3] merge,round — expiry follows an owner moved during the grace window; step of 1.
- [2] keep — same-terminal reconnect and overlapping sockets preserve ownership.
- [4] keep — startup grace preserves a matching reconnect and expires an absent owner.
- [5] merge,impl — intentional stop cancels startup timers; step of 4.


#### test/integration/orchestrator-pane-move.test.ts (own 2, gate 1.5 s) keep 2 / merge 0 / drop 0 / trim 0
- [1,2] keep — non-owner presence follows terminal identity across a pane move; an owner moves across workspaces and routes by the new scope.


#### test/integration/herdr-pane-identity-resolver.test.ts (own 5, gate 0.2 s) keep 3 / merge 2 / drop 0 / trim 0
- [1] keep — finds only running sessions by exact socket path.
- [2] keep — normalizes direct and wrapped pane results.
- [3,4] merge,impl — second wrapped row and malformed optional metadata; rows of 2.
- [5] keep — rejects incomplete identity and always closes the client.


#### test/integration/profile-demand.test.ts (own 8, gate 5.5 s) keep 0 / merge 0 / drop 0 / trim 8
- [1,2,3,4,5,6,7,8] trim — all demand publication, ledger and promise-breach tests; goes with SHEPYTRIM.


#### test/integration/claude-profile-demand-validation.test.ts (own 39, gate 4.5 s) keep 0 / merge 0 / drop 0 / trim 39
- [1,2,3,4] trim — pure path-guard contrasts of the demand fixture (the only 4 that pass today).
- [5..39] trim — 35 real-demand tests; every one fails today with "fixture source pairing mismatch: src/cli/claude-hook.ts" because the file pins sha256 hashes of claude-hook.ts, shepy.ts, claude-hook.test.ts, cli.test.ts, README.md and profile-demand-ingress.ts and those files have changed (claude-hook.ts is now 2a1f86d9…, the pin says 08aeb882…). They also pass only under `scripts/run-tests.mjs`.


#### test/unit/demand-eligibility-promise-breach.test.ts (own 26, gate 5.9 s) keep 0 / merge 0 / drop 0 / trim 26
- [1..26] trim — eligibility rules for the demand feature; goes with SHEPYTRIM.


#### test/unit/profile-demand-ingress.test.ts (own 13, gate 0.4 s) keep 0 / merge 0 / drop 0 / trim 13
- [1..13] trim — publish admission for demand; goes with SHEPYTRIM.


#### test/unit/profile-demand-cli.test.ts (own 1, gate 0.0 s) keep 0 / merge 0 / drop 0 / trim 1
- [1] trim — `inbox publish-demand` / `lookup-demand` verbs; goes with SHEPYTRIM.

### BEHAVIOURS
| Behaviour in plain words for a user | Best guard tests (file > title) |
|---|---|
| A worker's completion reaches the owning seat once, with that worker's own final text; an old or missing text is never swapped for the previous turn | notice-correctness > "one real delayed re-read repairs missing text…", "old text still missing after retry stays empty…", "a new turn during the retry cannot be attached…"; profile-delivery > "live incident shape: same assistant ref…", "a NEW completion across reconnect DELIVERS" |
| A completion with no history reader carries a marked, bounded screen tail, never an "assistant" answer, and a hung or failing read still sends the notice | screen-text-notice > "a reader-less kind finishes…", "a failed read…", "a read that never answers…", "both renderers say screen text…"; screen-text (unit) > "a 5 MB screen is bounded…" |
| A seat subscribes a pane and receives outcomes only from that pane's bound session; a replacement or foreign session is refused | profile-subscribe > "pending before detection, first bind while working, then replacement refused after restart", "real indexed working-to-done events deliver only the bound session", "Pi presence before agent detection pins the first session…", "factory's existing terminal proof works before the first prompt…" |
| Only the current owner can lease or acknowledge; one liveness rule for claim, renew and lease; the token never leaks | profile-delivery > "claim, renew and inbox.lease flip together at exactly lease + grace", "a token superseded by a re-claim can no longer lease", "the A2-1 attack: inbox.list must not disclose…", "the full attack: both halves reconstructed from public RPC…" |
| An unacknowledged notice survives a daemon restart and is delivered once per lease; expired leases return stranded rows; attempts are bounded | profile-delivery > "unacked obligations survive restart and redeliver exactly once per lease", "lease expiry returns stranded obligations; bounded attempts dead-letter", "a crash before delivery cannot suppress a pending or leased final" |
| An ambiguous selector, or a same-workspace-id in another Herdr session, delivers nothing to the wrong seat | profile-delivery > "the reviewer's case: two identical workers…", "cross-session same-workspace-id stays excluded…"; profile-isolation > "each profile resolves ONLY its exact subscribed worker", "same workspace id in another Herdr session is never a candidate" |
| The operator can see why a seat is not receiving (diagnose), who owns a profile, retire a stale backlog and read one notice back | profile-diagnose > (a), (d), (e), (h), (i) and "read-only"; profile-delivery > "retires pending obligations without delivering them", "prints the owning pane, workspace, and local lease expiry, never the token", "inbox.get returns the redacted obligation…" |
| A Pi workspace owner keeps ownership across brief disconnects and pane moves and still gets events routed by its new scope | orchestrator-disconnect-grace > "expires an absent owner…", "same-terminal reconnect and overlapping sockets…", "startup grace…"; orchestrator-pane-move (both); agent-orchestrator-service > "drops ownerless events but preserves direct replacement events", "moves ownership…" |
| A Claude worker's notice never shows a Pi context figure; long excerpts are bounded with a read-back hint | profile-delivery > "correction F1: a Claude worker event carrying Pi history leases an explicit mismatch…", "long excerpts are bounded with a read-back hint…" |
| Demand publication and delivery (no caller, 0 rows ever) | none kept; goes with SHEPYTRIM |

### WALL-CLOCK BOUNDS UNDER 1 s
Failures seen in my two full runs (load about 17): run 1, notice-correctness test 10 failed at `:358` (flushElapsed 480.9 ms against 450). Run 2: none of these failed. Earlier rev-s5 report names three more timing reds in the same file (tests 25, 26, 23) at higher load.

| file:line | bound | what it does | my class | failed in my runs |
|---|---|---|---|---|
| notice-correctness:252 | upper < 400 ms | elapsed of "startup unknown to idle/done, no retry" (tests 3, 4) | 3 keep, 4 merge | no |
| notice-correctness:336, :351 | sleep 300 ms and 60 ms | "give it time": producer flush lands during the 500 ms retry; fast pane written 60 ms later (tests 8, 9, 10) | 8 keep, 9 and 10 merge | no |
| notice-correctness:357 | upper < 350 ms | fast pane's status call | 8 keep (9, 10 merge) | no |
| notice-correctness:358 | upper < 450 ms | slow pane's flush path against a 500 ms production wait: 50 ms of headroom | 8 keep (9, 10 merge) | yes, run 1 (test 10, 480.9 ms) |
| notice-correctness:359, :371, :453 | lower >= 450 ms | proves the retry really waited (cannot flake, only slow) | 8, 11 keep; 13 merge | no |
| notice-correctness:380 | upper < 400 ms | "fresh text never waits" (test 11) | keep | no |
| notice-correctness:410-429 | upper < 400 ms | watch stream publishes the fast pane (test 12) | keep | no |
| notice-correctness:446 and :466, :558 | sleep 300 ms, 60 ms, 60 ms | writer flush and "let the retry start" (tests 13, 14 and 15, 19) | 13 and 15 merge; 14, 19 keep | no |
| notice-correctness:673-693 | upper < 400 ms | snapshot batch publishes fresh pane before the slow retry (test 23) | keep | no (rev-s5 saw it red at load 24 to 28) |
| notice-correctness:723-725 | upper < 400 ms | fresh text takes no retry delay (test 25) | drop,timing | no (rev-s5 saw it red) |
| notice-correctness:740-754 | sleep 300 ms; >= 450 ms; upper < 1000 ms | five missing finals share one wait (test 26) | keep | no (rev-s5 saw it red) |
| notice-correctness:763-765 | upper < 400 ms | five-agent startup has no per-agent sleep (test 27) | drop,timing | no |
| screen-text-notice:275 | upper < 1000 ms | quick pane's event is not held by a hung read (test 9). Line 276 already asserts the order, so the clock adds nothing | keep (remove the bound) | no |
| screen-text-notice:262 | upper < 4,500 ms | not sub-1 s; the hung-read test really waits about 2.3 to 2.7 s (default test timeout 5 s, file sets 15 s) | 8 keep | no |
| unit/screen-text:39 | upper < 500 ms | CPU time to bound a 5 MB string (normally 1 ms) | 3 keep (remove the bound) | no |
| orchestrator-disconnect-grace:264 (called at :39, :64, :69, :88) | sleep 20 ms | "give it time" for the server to see a socket close | 1, 2, 3, 4 | no |
| orchestrator-pane-move:306 (called at :137, :144, :153 and one more) | sleep 20 ms | "give it time" before asserting that no notification arrived. A negative check after a 20 ms sleep can pass vacuously under load | 1, 2 keep | no |
| integration/rpc-test-client.ts:53-58 (`waitForNotification`) | poll 100 times at 2 ms | real deadline of roughly 0.2 to 0.5 s for any RPC notification; used by disconnect-grace, pane-move and observability-rpc (not my file) | support helper | no |
Fake or injected clocks (not flaky): orchestrator-disconnect-grace `ManualScheduler` (50 ms and 100 ms graces advanced by hand); profile-delivery and profile-diagnose `now: () => clock` leases, boundaries and 5m30s lapse; profile-subscribe uses `performance.now()` only to print a cost line (no assertion) and prune ages are passed in. No other sub-1 s real-time bound exists in profile-isolation, profile-operation-resolution, agent-orchestrator-*, herdr-pane-identity-resolver or the demand files.
What the flaky class guards: only "other panes are not blocked by one pane's 500 ms retry or 1.75 s read" and "fresh text does not wait". Replace the upper bounds with an order assertion (the fast pane's notice exists before the slow pane's retry is allowed to finish), as `screen-text-notice` already does at :276. Keep the lower bounds, which cannot flake.

### DROP GROUPS: WHAT IS LOST
| group (tests) | protection lost | can a likely regression slip through? |
|---|---|---|
| Demand: profile-demand 8, demand-validation 39 (35 fail today on stale hash pins, 4 pure path guards), promise-breach eligibility 26, ingress 13, cli 1 = 87 (trim) | Admission, ledger and delivery rules for factory "demand" notices | No: 0 rows ever, no publisher in any repository (shepy-trim.md); 35 tests already red |
| Scope-store class tests, 6 (drop,impl) | Direct checks of cursor and ownership rules in `AgentOrchestratorScopeStore` | Low: the service tests assert claim, release, ack order and move; the server tests assert disconnect and pane-move. Row 7 (Pi owner) stays |
| Lease-boundary and token-disclosure repeats: profile-delivery 8, 19, 35, 52, 53, 62 dropped; 38, 39, 40, 41, 42, 46, 48, 50, 51, 54, 55, 56, 57, 58, 60 folded | Individual wording of each refusal | No, if the folded rows stay as asserts of 37, 43, 44, 45, 47, 49, 59; yes if folding is skipped. Not-checked: I did not rewrite the tests |
| Review-round and "P"-numbered variants: profile-delivery 2, 11, 13, 15, 18, 22, 23, 61; profile-subscribe 10, 18, 33; notice-correctness 6, 9, 10, 13, 17, 18, 20, 21, 22 | Nothing new: each repeats a kept behaviour in a different setup | No |
| Subscribe identity-precedence rows (7, 14, 15, 16) and refusal rows (4, 22, 26) | Which session binds first when Pi, Herdr and cache disagree | Medium if the rows are not kept: this decides whose text a seat sees. See riskiest drops |
| Service-seam duplicates: profile-subscribe 23, 24; profile-isolation 4; screen-text-notice 10; screen-text unit 12 | None | No: each is guarded by a kept test named in its line |
| Timing-only: notice-correctness 25, 27 | A "less than 400 ms" check on two paths | Low: 23 and 26 keep the order and count checks |
| Probe tables in profile-diagnose, screen-text kinds, subscribe pane-move | Individual finding codes and agent kinds as separate tests | No: kept as rows of one table test |
| Cost loop in profile-subscribe 1 | A printed cost line (no assertion) | No |

### RISKIEST DROPS
1. **Scope-store tests (agent-orchestrator-scope-store 1 to 6, drop).** They are the only direct tests of the cursor and ownership rules in the store. If a store change breaks "cursor supplied with every claim" or "lists only owned scopes for the session", the service tests may still pass because they use one session. A Pi workspace owner would then miss or replay events. Dropped because every public path (service, server) is tested and the store is internal.
2. **Identity-precedence rows in profile-subscribe (7, 14, 15, 16 folded into 13).** Four tests answer "which session binds first". A wrong answer sends one seat another worker's text. They are folded, not deleted; if the fold becomes only one row, three cases are lost. Merged because they are probes of one rule.
3. **Superseded-token variants in profile-delivery (38, 39 into 37; 55, 60 into 59).** Test 39 states a design rule (a superseded token still acknowledges exactly the rows its own lease stamped), not just an attack. If it is not kept as an assert, a takeover could cause double delivery without a failing test. Merged because 37 and 59 hold the attack and the rest repeat it ("round-3 review").
4. **Timing replacement in notice-correctness (25 and 27 dropped, bounds in 8 to 12, 23, 26 rewritten).** Without an elapsed check, five panes could wait 0.5 s each in turn (2.5 s late) and only the count-based test 26 would show it. Dropped because the elapsed bound is the flaky class; keep the order and count assertions.
5. **screen-text-notice 10 (5 MB through the real pipeline, drop,dup).** The unit test proves the bound function and test 11 proves the label, but nothing runs a 5 MB ANSI screen through the real notice path. Low risk, listed because it is the only end-to-end check of the size cap.
Also for Ray: the 87 "trim" tests are the largest cut and reverse the 2026-10-08 build decision for demand (row 15.216); see shepy-trim.md.

### TOTALS
Files covered: 18, 307 registered tests (from the second full run). keep 93, merge 108, drop 19, trim 87. After the cut (keep only; merge rows become asserts or table rows inside a keeper): 93 tests, plus 0 for trim.
Estimated seconds: the same 307 tests took 104.7 s of summed test time in run 2 (load about 17), of which 16.3 s is demand (trim). The 93 kept tests sum to 47.0 s; subtracting about 3.5 s for removing the cost loop in profile-subscribe 1 gives about 43.5 s. Method: sum of per-test durations from the vitest JSON of run 2, kept tests only; file import and setup time is not included, and merged rows will add a little to their keeper. Summed time overstates wall time because files run in parallel (the whole suite took 68 s wall). Not measured: wall time after the cut.
Other notes: profile-delivery lines 348 to 352 hold a helper guard for a demand obligation (`agentEventId === null`); it goes with SHEPYTRIM. `profile-operation-resolution` is tagged ops: it goes with row 5 if Ray removes dispatch.

---

# Part 3

Reason codes: probe, round, impl, pin, stale, dup, timing, trim. Merge = folded into the named keeper as a table row or extra assert. Test numbers are the line numbers in scratchpad/titles/<file>.txt (second full run).

### FILES

#### test/unit/shepy-pi-extension.test.ts (own 71, gate 4.7 s) keep 36 / merge 24 / drop 11 / trim 0
- 1: KEEP — Pi finds the daemon socket (SHEPY_HOME/shepy.sock)
- 2: KEEP — hidden context formatting; a control-bearing worker name cannot inject '[SYSTEM]' (safety)
- 3: KEEP — no connection outside a complete Herdr environment
- 4: KEEP — registers presence, adopts daemon location, reconnects
- 5: KEEP — owner-only cached context injected once and pinned for a run
- 6..7: MERGE dup — →5: off / outside scope / role loss clear the cached context (extra asserts on 5)
- 8: KEEP — owner updates acknowledged in id order only after a successful final answer settles
- 9: MERGE probe — →10: row of the stop-reason table
- 10: KEEP — failed turn (stop reason error) leaves updates pending with a warning (table keeper with rows undefined, aborted, toolUse)
- 11..12: MERGE probe — →10: rows aborted, toolUse
- 13: KEEP — partial acknowledgement failure keeps only the unacknowledged events (full failure folded in)
- 14: DROP dup — footer refresh after each ack; footer text is asserted in 8
- 15: MERGE dup — →13: full acknowledgement failure
- 16: MERGE dup — →47: role loss invalidates a delivered batch
- 17: MERGE dup — →5: non-owner gets no context or updates
- 18: KEEP — /shepy on, off and status commands and their messages
- 19: KEEP — only a replaced owner is told; no duplicate self-off feedback
- 20: KEEP — registration failure is contained and shows 'reconnecting' (21, 23 folded in)
- 21: MERGE dup — →20: previous-owner reconnecting restored silently
- 22: DROP probe — repeated failure callbacks keep reconnecting state (second look at 20)
- 23: MERGE dup — →20: non-owner disconnect shows no footer
- 24: KEEP — ownership loss discovered on reconnect is reported (table keeper, row term_other)
- 25: MERGE probe — →24: row null
- 26: KEEP — owner moves to another workspace: pending state is refreshed (44 folded in)
- 27: KEEP — an outcome (agent.done) wakes once after the 500 ms batch window (28, 31 folded in)
- 28: MERGE probe — →27: row agent.idle
- 29: KEEP — blocked skips the 500 ms batch but still goes through delivery and ack (30 folded in)
- 30: MERGE dup — →29: blocked wake consumed and acknowledged
- 31: MERGE dup — →27: routine turn-end stays batched
- 32: DROP dup — non-outcome / done-to-idle / null-terminal / self filtering; the same table is guarded in shepy-pi-wake 'does not project'
- 33: KEEP — several outcomes coalesce into one visible wake
- 34: MERGE probe — →37: wake preparation failure keeps pending (no retry storm)
- 35: KEEP — a busy Pi defers the wake until it settles idle (36 folded in)
- 36: MERGE dup — →35: events during a delivered batch schedule a later wake
- 37: KEEP — after a failed batch there is no retry until a newer outcome (34, 38 folded in)
- 38: MERGE dup — →37: same rule after ack failure
- 39: KEEP — a sent-but-not-started wake is not replayed after reconnect (no duplicate wake)
- 40: KEEP — pending outcomes replayed after registration wake the owner (restart recovery)
- 41: KEEP — a replacement Pi wakes the previous owner's unacknowledged batch (handover)
- 42: KEEP — a normal user run does not acknowledge a Shepy wake it never saw
- 43: DROP probe — timer refresh reveals a missed workspace move (variant of 26)
- 44: MERGE probe — →26: reconnect registration reveals a missed move
- 45: DROP probe — stale timer when the same terminal moves (variant of 26)
- 46: KEEP — same-terminal workspace move invalidates and aborts a delivered batch
- 47: KEEP — role loss cancels the pending wake and aborts only a Shepy-triggered turn (16 folded in)
- 48..49: MERGE impl — →50: shutdown clears reconnecting UI and the wake timer
- 50: KEEP — shutdown closes; a fresh Pi session registers with its own subscriber id
- 51: KEEP — /shepy on <profile> claims the profile and starts the pump (the factory seat's Pi path)
- 52: KEEP — pump leases obligations, delivers ONE wake, acknowledges after a successful settle
- 53: KEEP — wake names the exact leased event, never a roster (the wrong-worker attribution incident)
- 54: MERGE dup — →55: failed context enqueue nacks, retry delivers once
- 55: KEEP — failed wake enqueue nacks and a later user turn cannot acknowledge it (54 folded in)
- 56: DROP probe — delivered-RPC failure after a queued trigger; one more failure variant of 55
- 57: KEEP — older daemon lease without outcome: ids rendered honestly, no pane invented (daemon and Pi ship separately)
- 58: KEEP — a lease resolving after /shepy off must not enqueue and cannot be acknowledged
- 59: KEEP — overlapping pump ticks with one lease token cannot double-lease
- 60: MERGE dup — →61: a user run during the lease RPC defers delivery (no enqueue, no ack)
- 61: KEEP — a wake no run consumed is never acknowledged (60 folded in)
- 62: KEEP — failed settle nacks; obligations stay pending server-side
- 63: KEEP — a rejected claim (active lease elsewhere) never enters profile mode
- 64: KEEP — session_shutdown releases the profile lease (65, 66 folded in)
- 65..66: MERGE probe — →64: release rejection contained on close / on disconnect
- 67: DROP dup — build-stamp sandbox: unstamped wake still delivers; same as 52
- 68..69: DROP impl — tests of the test sandbox for build-stamp fixtures (injected / corrupted stamp rides the wake); parse safety is in shepy-pi-build-info
- 70: DROP impl — tests that the test sandbox hides ambient SHEPY_PROFILE; no user behaviour
- 71: DROP dup — injected SHEPY_PROFILE claims on session_start; same as shepy-pi-env-claim 'dispatched pane owns its profile'

#### test/unit/shepy-pi-wake.test.ts (own 18, gate 0.0 s) keep 7 / merge 7 / drop 0 / trim 4
- 1: KEEP — done outcome selected; raw events kept in ascending id order
- 2: KEEP — blocked and working-to-idle fallback classified as outcomes
- 3: KEEP — non-outcomes are not projected (table keeper; done-to-idle duplicate, tool.failed, status.changed, no terminal id folded in)
- 4..7: MERGE probe — →3: rows (blocked-to-idle, tool.failed, status.changed, no terminal id)
- 8: KEEP — reversed raw ids deduplicated, distinct work cycles retained
- 9: KEEP — fixed wake policy text comes before bounded agent evidence
- 10: MERGE probe — →9: unnamed or malformed live name falls back to the kind
- 11: MERGE probe — →12: 1,999 characters not truncated (boundary row)
- 12: KEEP — excerpt cut inside 2,000 characters with the exact pane read hint (11, 13 folded in)
- 13: MERGE probe — →12: 'unknown' in the hint when pane id is absent
- 14: KEEP — terminal control sequences removed before formatting (safety)
- 15..18: TRIM trim — demand wake rendering and promise-breach consumer wiring: goes with SHEPYTRIM

#### test/unit/shepy-pi-profile-renew.test.ts (own 12, gate 0.1 s) keep 5 / merge 4 / drop 2 / trim 1
- 1: KEEP — pump renews the lease before leasing, on the claim pump and every tick (5, 8, 9 folded in)
- 2: KEEP — renewed:false recovers by proof-of-possession re-claim (4 folded in)
- 3: KEEP — recovery rejected by a rival owner stops the pump for good
- 4..5: MERGE probe — →2 / →1: recovery transport failure retried next tick; renew transport failure still leases
- 6: DROP probe — stale renewed:false after a same-profile re-claim; interleaving variant of 7
- 7: KEEP — two overlapping renewed:false continuations recover exactly once
- 8..9: MERGE probe — →1: busy owner and in-flight batch still renew
- 10: DROP probe — overlapping recovery rejected after a fresh token; interleaving variant of 7
- 11: KEEP — a redelivered obligation set gets a fresh turn id per delivery
- 12: TRIM trim — negotiated demand capability claims and renders a non-agent obligation

#### test/unit/shepy-pi-agent-update-ui.test.ts (own 11, gate 0.0 s) keep 6 / merge 3 / drop 2 / trim 0
- 1: KEEP — valid agent identities shown, malformed or control-bearing tokens rejected (9 folded in)
- 2: DROP impl — heading colour
- 3: KEEP — themed collapsed summary without event ids
- 4: MERGE impl — →3: collapsed card limited to three rows
- 5: KEEP — expanded card shows every outcome with its bounded final response
- 6: DROP impl — absence of expand/collapse hints
- 7: KEEP — legacy event-only details from an old saved session render without exposing old content (8 folded in)
- 8: MERGE dup — →7: malformed custom message details contained
- 9: MERGE dup — →1: control-bearing identity tokens rejected
- 10: KEEP — terminal controls stripped again at the rendering boundary (safety)
- 11: KEEP — every footer state renders as plain text

#### test/unit/shepy-pi-build-info.test.ts (own 2, gate 0.0 s) keep 1 / merge 1 / drop 0 / trim 0
- 1: KEEP — malformed, partial or unreadable build stamp gives UNKNOWN and never throws at import (a throw would stop the extension loading)
- 2: MERGE dup — →1: valid full commit stamp is accepted (positive control)

#### test/unit/shepy-pi-env-claim.test.ts (own 3, gate 0.1 s) keep 2 / merge 1 / drop 0 / trim 0
- 1: KEEP — a pane started with SHEPY_PROFILE owns its profile before its first token (3 folded in)
- 2: KEEP — a rejected env claim notifies, leaves the pane unowned, never retries
- 3: MERGE dup — →1: unset, empty or whitespace SHEPY_PROFILE changes nothing

#### test/unit/pi-profile-tool.test.ts (own 14, gate 0.1 s) keep 5 / merge 9 / drop 0 / trim 0
- 1: KEEP — shepy_profile claim requires a non-empty profile id; release/status need none; unknown actions refused (2, 3 folded in)
- 2..3: MERGE probe — →1: trimmed id; release and status without id
- 4..5: MERGE dup — →12: result text of a claim names the profile, never the lease token; re-claim wording
- 6: KEEP — rejection names the owning pane and harness and forbids retrying (7, 8, 9 folded in as rows)
- 7..9: MERGE probe — →6: rejection without owner details, profile_not_found, blocked claim
- 10: MERGE probe — →11: release result text
- 11: KEEP — status reports profile mode, pending count and connection from local state (10 folded in)
- 12: KEEP — through execute(): the model-facing result of a claim never carries the lease token (4, 5 folded in)
- 13: KEEP — a rejected claim comes back as a normal result naming the owner, never a throw (14 folded in)
- 14: MERGE dup — →13: profile_not_found rejection reported through notify and text

#### test/unit/stamp-pi-build.test.ts (own 1, gate 0.9 s) keep 0 / merge 0 / drop 1 / trim 0
- 1: DROP impl — build script replaces the stamp file atomically instead of truncating its inode (0.9 s, runs git); a build-time detail, a bad stamp is already handled by shepy-pi-build-info

#### test/integration/shepy-pi-daemon-client.test.ts (own 5, gate 0.1 s) keep 4 / merge 1 / drop 0 / trim 0
- 1: KEEP — connects after the server appears; handles responses and streams (2 folded in)
- 2: MERGE dup — →1: agent context change stream decoded
- 3: KEEP — in-flight work rejected, reconnects once, later requests accepted
- 4: KEEP — malformed JSON disconnects without crashing, then reconnects
- 5: KEEP — explicit close stops reconnect and rejects later requests

#### test/unit/outcome-context.test.ts (own 145, gate 0.0 s) keep 25 / merge 52 / drop 68 / trim 0
- 1: KEEP — Pi: newest per-call prompt occupancy, current at the event, window unknown (29, 40 folded in)
- 2: KEEP — Claude: manager occupancy; sidechain usage never counts (38 folded in)
- 3: KEEP — after compaction or model change the figure is unavailable, old tokens never resurrected (4, 5, 8, 24 folded in)
- 4..5: MERGE dup — →3: Claude compaction boundary; model change
- 6: KEEP — a later assistant without usage keeps the number but says stale (7 folded in)
- 7: MERGE dup — →6: Claude git branch change marks stale
- 8: MERGE dup — →3: no usage on any call is unavailable with the recorded reason
- 9: KEEP — a discovered-file fallback (latest file in cwd) is not the event's agent: no figure (10, 11, 12, 23 folded in)
- 10..12: MERGE dup — →9: reading from another file; reading without ref; Claude native id must equal bound session
- 13: KEEP — an event recorded without history or without context health says so
- 14: KEEP — non-finite, negative or fractional counts invalid, never rounded (66 to 69 folded in)
- 15: KEEP — a percent renders only with an authoritative positive window on a current reading (48, 77, 78 folded in)
- 16: KEEP — the line is event-attached: delayed delivery never relabels it as current-at-delivery
- 17: KEEP — absent or malformed DTO renders an explicit reason; both renderers agree byte for byte (45, 129, 130, 144 folded in)
- 18: KEEP — Claude hook short notice for a Pi wake: done and idle, truncated excerpt, redelivered duplicate, old daemon (20, 21 folded in)
- 19: KEEP — Pi profile wake: leased snapshot carries context; a missing snapshot says why
- 20..21: MERGE dup — →18: one line per outcome keeps excerpt and truncation hint; legacy snapshot fallback
- 22: KEEP — Codex: exactly bound settled turn shows tokens over the window Codex reported
- 23..24: MERGE dup — →9 / →3: newest-cwd guess refused; compaction shows unavailable not 0%
- 25: KEEP — an event stored by the old reader keeps its stored projection; nothing rewrites it
- 26: DROP probe — a Claude file with two session ids gives no figure (variant of 9)
- 27: KEEP — age = event time minus reading time; unknown or negative age shown as nothing (28 folded in)
- 28: MERGE dup — →27: age buckets identical in daemon and Pi renderers
- 29: MERGE dup — →1: matched positive (Pi event, Pi history, Pi health)
- 30: KEEP — a Claude worker event carrying Pi history and health is refused (pane reused by another harness) (31, 32, 33 folded in)
- 31..33: MERGE probe — →30: disagreeing history source; history's own source field; unknown harness (no payload)
- 34..37: DROP probe — three more spellings of 'unknown worker harness' (payload without agent, no context reader, non-string agent, array payload)
- 38: MERGE dup — →2: native generation within one harness stays bound by session id
- 39: KEEP — a reading one day after its event is refused, both timestamps kept (41, 42, 43 folded in)
- 40: MERGE dup — →1: reading at the event instant is current with age 0
- 41..43: MERGE probe — →39: invalid reading time; missing reading time; unknown event time
- 44: DROP probe — upstream stale reason kept over a time reason
- 45: MERGE dup — →17: renderers refuse a reading-after-event DTO
- 46..47: DROP probe — renderers refuse current DTO without reading time / without event time (variants of 45)
- 48: MERGE dup — →15: coherent window renders the derived percentage in both renderers
- 49: KEEP — a bad supplied percentage (negative) is refused, never rendered, in both renderers
- 50..51: MERGE probe — →49: oversized, incoherent supplied percentage
- 52..55: DROP probe — slightly-off, NaN, infinite, string supplied percentage (more rows of 49)
- 56: MERGE probe — →49: unusable zero window refused identically
- 57..65: DROP probe — nine more unusable-window spellings (negative, fractional, huge, below tokens, string, percent without window, status without window, inconsistent, percent on stale)
- 66..69: MERGE probe — →14: zero, negative, fractional, huge token counts are not a reading
- 70..73: DROP probe — projector twin of 49 to 55 (negative, oversized, incoherent, NaN supplied percentage keeps raw tokens)
- 74: MERGE probe — →75: rounding boundary .x5
- 75: KEEP — percentage rounding at a float-error boundary renders in both renderers
- 76: MERGE probe — →75: rounding boundary with a large window
- 77..78: MERGE dup — →15: coherent supplied percentage derives the shown value; tokens above the window
- 79: KEEP — the public context object publishes no transcript path in any projected state (privacy)
- 80: KEEP — an impossible reading date is unknown, never current with age 0 (81, 82, 85, 98, 102 are rows of this and 94)
- 81: MERGE dup — →80: impossible event date
- 82: MERGE probe — →80: reading time 2026-02-29
- 83..84: DROP probe — impossible reading times 1900-02-29 and 2026-02-30
- 85: MERGE probe — →80: month 13
- 86..93: DROP probe — eight more impossible time spellings (month 0, 04-31, day 0, hour 24, minute 60, second 60, offsets +24:00, +05:60)
- 94: KEEP — a valid leap-day reading time is kept as written and current; both renderers print it (control for 80)
- 95..97: DROP probe — three more valid time spellings (2000-02-29, 2026-02-28T23:59:59Z, nanosecond precision)
- 98: MERGE probe — →94: valid +05:30 offset
- 99..101: DROP probe — three more valid time spellings (negative offset, fractional second, plain Z)
- 102: MERGE dup — →94: valid offset event time
- 103: KEEP — daemon renders a coherent tuple: reported window with derived percent (104 to 108 folded in as rows)
- 104..108: MERGE probe — →103: window without percent; unknown status; inconsistent status; stale with reason; older DTO
- 109..114: DROP dup — Pi-renderer twin of 103 to 108; 17 asserts both renderers print the same bytes
- 115: KEEP — daemon refuses a 'current' DTO with an impossible reason (post_compaction_no_turn) (116 to 119, 122 folded in)
- 116..119: MERGE probe — →115: other impossible reasons / statuses
- 120..121: DROP probe — inconsistent status with a window; older DTO with a window (variants of 115)
- 122: MERGE probe — →115: unrecognised windowStatus token
- 123..128: DROP probe — empty / case-variant / number windowStatus and three 'reviewer probe' repeats of 115
- 129..130: MERGE dup — →17: explicit missing-context fallback; Pi refuses post_compaction_no_turn
- 131..143: DROP dup — Pi-renderer twin of 116 to 128
- 144: MERGE dup — →17: Pi missing-context fallback
- 145: KEEP — the projector only emits coherent tuples (every projected state renders without context_invalid)

#### test/integration/outcome-context-rpc.test.ts (own 3, gate 1.5 s) keep 1 / merge 1 / drop 1 / trim 0
- 1: KEEP — real store → inbox.lease and agent.events RPC → both renderers: exact per-call line; served DTO carries no path
- 2: MERGE dup — →1: a Claude worker event carrying Pi health is refused on the lease and the event wire (unit rule is outcome-context 30)
- 3: DROP dup — impossible reading date reaches the wire as unknown; guarded in outcome-context 80

#### test/unit/cli.test.ts (own 66, gate 0.0 s) keep 21 / merge 21 / drop 20 / trim 4
- 1: KEEP — agent list uses the current Herdr workspace (2, 3 folded in)
- 2..3: MERGE dup — →1: explicit scopes; agent get and read parsing
- 4: KEEP — unknown command is a usage error (44 folded in)
- 5: KEEP,OPS — dispatch and wait commands parse (7 folded in)
- 6: DROP,OPS dup — contextual help for dispatch and wait; cli-census 'every verb has a help page'
- 7: MERGE,OPS dup — →5: operation get and list
- 8: KEEP — profile ensure can opt a Claude owner into idle wakes; default unchanged
- 9: MERGE dup — →11: profile owner parsing
- 10: DROP dup — profile owner help; cli-census
- 11: KEEP — profile owner renders for humans and never prints lease secrets (9, 12, 13, 14 folded in)
- 12..14: MERGE probe — →11: lapsed owner claimable; neutral owner; unowned claimable
- 15: KEEP — --json output printed verbatim (54, 60 folded in)
- 16: MERGE dup — →35: root help and version flags
- 17..32: DROP dup — sixteen contextual-help spellings; cli-census checks every verb's help page against the parser
- 33: MERGE dup — →34: help flag precedence over trailing arguments
- 34: KEEP — root and contextual help render (16, 33 folded in)
- 35: KEEP — package version renders
- 36: MERGE dup — →38: inbox get parsing
- 37: KEEP — inbox list --before and --limit
- 38: KEEP — inbox get renders the full excerpt and says when the obligation is gone (36 folded in)
- 39: KEEP — inbox get labels a screen excerpt as screen text, not an answer (S5 requirement) (40, 41 folded in)
- 40..41: MERGE dup — →39: screen-unavailable; history excerpt label
- 42: DROP probe — partial obligation without inventing a known count
- 43: KEEP — inbox get strips control bytes from the excerpt (terminal safety)
- 44: MERGE dup — →4: contextual help hints only on usage errors
- 45: KEEP — help and version work without connecting to the daemon
- 46: KEEP — main runs when the package bin symlink points at the CLI module (npm global install)
- 47: KEEP — agent JSON commands dispatch to the daemon
- 48: KEEP — human agent list (55: separate name and agent kind folded in)
- 49: KEEP — context block for a last_reported reading (50, 51 folded in)
- 50..51: MERGE dup — →49: unavailable reading; stale reading and manual boundary
- 52: KEEP — a hostile model id renders on one line without control bytes (53 folded in)
- 53: MERGE round — →52: hostile usage reason (S3 round)
- 54: MERGE dup — →15: agent object passed through untouched
- 55: MERGE dup — →48: separate live name and agent kind in get and read
- 56: MERGE dup — →58: profile diagnose parsing
- 57: DROP dup — profile diagnose help; cli-census
- 58: KEEP — profile diagnose renders findings first (56 folded in)
- 59: KEEP — each finding on one line so a hostile id cannot forge a finding (safety)
- 60: MERGE dup — →15: diagnose --json prints the full report
- 61: KEEP — daemon status shows identity fields next to pid and socket (62 folded in)
- 62: MERGE dup — →61: CLI stamps kept when the socket is dead
- 63..66: TRIM trim — --profile-demand opt-in parsing (4 tests); SHEPYTRIM replaces them with one 'flag accepted and ignored' test

#### test/unit/cli-census.test.ts (own 32, gate 0.0 s) keep 1 / merge 29 / drop 0 / trim 2
- 1: KEEP — help lists exactly the parser's top-level commands; one loop over every verb's help page (all rows 2 to 32 fold in)
- 2..14: MERGE dup — →1: help page rows (top-level, agent, daemon, inbox get/list)
- 15..16: TRIM trim — inbox lookup-demand and publish-demand help pages
- 17..18: MERGE dup — →1: inbox retire, retry help pages
- 19..21: MERGE,OPS dup — →1: operation verbs and help pages
- 22..32: MERGE dup — →1: profile verbs and help pages

#### test/unit/context-health-pi.test.ts (own 23, gate 0.0 s) keep 6 / merge 8 / drop 9 / trim 0
- 1: KEEP — a Pi reading is the last assistant message's billed prompt only (10 folded in)
- 2: KEEP — a compaction after the last assistant message makes usage unavailable (4, 9 folded in)
- 3: KEEP — an empty file is empty, not broken (6, 7, 8 folded in)
- 4: MERGE dup — →2: compaction followed by a new assistant message reads the new one
- 5: KEEP — a model change after the reading invalidates it (18 folded in)
- 6: DROP probe — non-numeric tokensBefore degrades to null
- 7: MERGE dup — →3: no assistant usage at all is unavailable
- 8: DROP probe — all-zero usage is not a reading (O2 round)
- 9: MERGE dup — →2: the compaction entry's own usage is never the reading
- 10: DROP impl — every projection reports an unrecorded window
- 11: KEEP — a branch summary re-roots: the earlier lineage's reading goes stale (15, 20, 22 folded in)
- 12: KEEP — a later assistant turn without usage marks the reading stale (13 folded in)
- 13: MERGE dup — →12: later turn with all-zero usage
- 14: DROP probe — later_turn_without_usage outranks the branch marker (O3 c round)
- 15: MERGE dup — →11: branch summary re-root with no usage above
- 16..17: DROP probe — unknown parentId breaks the lineage; off-lineage compaction not counted (D8 k, l round)
- 18: MERGE dup — →5: model change away and back
- 19: DROP probe — branch marker persists through appends (P1 a round)
- 20: MERGE dup — →11: a new assistant reading clears the marker
- 21: DROP probe — later_turn_without_usage outranks the persisted marker (P1 c round)
- 22: MERGE dup — →11: a branch summary before the reading does not invalidate it
- 23: DROP probe — user and thinking_level_change appends keep the marker (P1 e round)

### BEHAVIOURS

| Behaviour for a user | Best guard tests (file > test) |
|---|---|
| A Pi seat that owns a profile (`/shepy on <profile>`, or `SHEPY_PROFILE` in its environment) gets exactly one wake per leased batch, naming the exact worker event, and acknowledges only after a successful turn that really saw the wake. | shepy-pi-extension > "pump leases obligations, delivers ONE wake, acks after successful settle"; "wake names the EXACT leased event…"; "a wake never consumed by any run is never acked"; "failed settle nacks"; shepy-pi-env-claim > "a dispatched pane owns its profile before its first token" |
| A failed or racing delivery never loses or duplicates an outcome (nack on failed enqueue, no double lease, off means off). | shepy-pi-extension > "failed TRIGGER enqueue nacks and a later user turn cannot ack it"; "a lease resolving after owner-off must not enqueue…"; "overlapping pump ticks… cannot double-lease"; shepy-pi-profile-renew > "renews the lease before leasing…", "two overlapping renewed:false continuations recover exactly once", "recovery rejected by a rival owner stops the pump for good" |
| A bare-workspace Pi owner (`/shepy on`, row 7 of the trim plan, no factory caller) is told of worker outcomes after a 500 ms batch; blocked skips the batch; busy Pi defers; restart and handover do not lose or repeat wakes. | shepy-pi-extension > "wakes once at 500 ms…", "blocked bypasses the routine 500 ms batch…", "defers a busy wake…", "does not replay a sent-but-not-started wake after reconnect", "lets a replacement Pi wake the previous owner's unacknowledged batch" |
| The owner sees a readable card and footer; hostile worker names or terminal controls cannot forge or inject text. | shepy-pi-agent-update-ui > identities, collapsed, expanded, "strips terminal controls again at the rendering boundary"; shepy-pi-extension > "formats named hidden context and rejects control-bearing names"; shepy-pi-wake > "removes terminal control sequences…" |
| The model can claim, release and ask status of a profile through the `shepy_profile` tool; a refusal names the real owner and says not to retry; the lease token never reaches the model. | pi-profile-tool > "…execute() boundary the model-facing result of a successful claim never carries the lease token"; "a rejected claim comes back as a normal result…"; "a rejection names the owning pane and harness and forbids retrying" |
| Every delivered outcome carries one `context:` line (the worker's context-window use at the event), honest about absence, staleness, wrong session and impossible dates. | outcome-context > "Pi: newest per-call prompt occupancy…", "a discovered-file fallback… is not the event agent", "a Claude worker event carrying Pi history and health is refused", "a reading one day after its event is refused", "absent or malformed DTOs render an explicit reason; both renderers agree byte-for-byte", "the public context object publishes no transcript path"; outcome-context-rpc > "healthy Pi worker…"; context-health-pi > "reads the last assistant message's billed prompt only", "a compaction after the last assistant message…" |
| The `shepy` CLI: agent list/get/read, inbox get/list, profile owner/diagnose/ensure, daemon status; `--json` is verbatim; screen text is labelled; control bytes never reach the terminal; help matches the parser; the npm bin symlink starts the CLI. | cli > "dispatches agent JSON commands", "inbox get marks a screen excerpt", "inbox get strips control bytes…", "runs main when the package bin symlink points at the CLI module", "profile diagnose renders each finding on one line…"; cli-census > "root help lists exactly the top-level commands" |
| Pi's daemon client reconnects after a restart, survives malformed data, and stops on explicit close. | shepy-pi-daemon-client > "rejects in-flight work, reconnects once…", "malformed JSON disconnects without crashing…", "explicit close stops reconnect…" |

### WALL-CLOCK BOUNDS UNDER 1 s

No test in these 14 files asserts an upper bound on elapsed real time. No test in them failed in either full run (run 1 and run 2, load about 17). One shows a load stall: "failed context enqueue nacks…" took 3,394 ms in run 2 for a body that sleeps 60 ms (event loop starved; it still passed).

Real-time "give it time" sleeps (the flaky class: the assertion after the sleep fails if the pump has not finished on a loaded box):

| file:line | bound | what it does | tests (my class) | failed? |
|---|---|---|---|---|
| shepy-pi-extension.test.ts:2114 | 30 ms | wait for the claim pump to lease, enqueue and ack | 52 keep | no |
| :2222, :2249 | 30 ms ×2 | wait for the pump, before and after a roster change | 53 keep | no |
| :2273, :2299 | 30 ms ×2 | wait after the first claim, then after re-claim | 54 merge→55 | no (3.4 s stall in run 2) |
| :2324 | 30 ms | wait for failed trigger enqueue to nack | 55 keep | no |
| :2349 | 30 ms | wait for delivered-RPC failure case | 56 drop | no |
| :2402 | 30 ms | wait for older-daemon lease render | 57 keep | no |
| :2426, :2430, :2452 | 10 ms, 30 ms ×2 | lease in flight while owner goes off, then re-claim | 58 keep | no |
| :2473, :2478, :2481 | 10 ms ×2, 30 ms | overlapping pump ticks with one token | 59 keep | no |
| :2506, :2510, :2534 | 10 ms, 30 ms ×2 | user run starts during lease | 60 merge→61 | no |
| :2555 | 30 ms | wait for a wake nobody consumed | 61 keep | no |
| :2587 | 30 ms | wait for failed settle | 62 keep | no |
| :2622 | 10 ms | wait for shutdown release | 64 keep | no |
| :2045 `tick()` | 0 ms | one macrotask turn between emits (used throughout) | many | no |
| shepy-pi-daemon-client.test.ts:23-170 | `reconnectDelaysMs: [5]`; polls every 5 ms up to a 1,000 ms deadline (`waitFor`, line 208); 10 ms sleep at :160 | client reconnect ordering depends on a 5 ms retry; the :160 sleep gives the connect time before `close()` | 1, 3, 4 keep; 5 keep (:160) | no |

Fix suggested for the kept ones: wait on the call (`vi.waitFor` on `client.calls`) instead of a fixed 10 or 30 ms sleep; that removes the whole class from these files without removing a test.

Fake timers (not flaky, listed once): shepy-pi-extension.test.ts (about 30 tests use `vi.useFakeTimers` and `advanceTimersByTimeAsync(500)`), shepy-pi-profile-renew.test.ts (all 12; 10,000 and 21,000 ms ticks), shepy-pi-env-claim.test.ts (60,000 ms), pi-profile-tool.test.ts (3 tests), outcome-context.test.ts:459 (`setSystemTime`).

Not timing bounds: `toBeLessThan(400)` and `(700)` in outcome-context.test.ts:507 and :1071 are line and JSON length caps.

### DROP GROUPS: WHAT IS LOST

| group (tests) | protection lost | can a likely regression slip through? |
|---|---|---|
| outcome-context: the 12 + 8 + 6 + 6 calendar spellings, 14 renderer-tuple twins, 13 Pi-renderer twins, 9 unusable-window spellings, 4 unknown-harness spellings (about 68 drops, 52 more folded as table rows) | Each individual malformed date, percentage, window or windowStatus spelling gets no test of its own | Low: the keeper test loops over a shared table of examples and the renderers share the validation code; the context line is a diagnostic read by a seat, not a delivery control. A new spelling that one renderer prints and the other refuses would be caught only by the byte-for-byte keeper (17) |
| context-health-pi: lineage and marker probes (9 drops) | Odd Pi session trees (unknown parentId, off-lineage compaction, marker persistence ordering) | Low: affects only the context line's "stale/unavailable" label; 11 and 12 keep the branch and later-turn rules |
| shepy-pi-extension orchestrator bridge: variants of workspace move (43, 45), repeated reconnect callbacks (22), footer refresh (14), non-outcome filter (32) | Detail of the bare `/shepy on` owner, which has no factory caller (trim plan row 7: KEEP, but nothing uses it) | Low for the seats; medium for any user of bare `/shepy on` after a Pi-side change to the move logic |
| shepy-pi-extension profile bridge: delivered-RPC failure (56), build-stamp and ambient-profile sandbox controls (67 to 71) | One extra failure variant; tests of the test sandbox | No: 55 and 52 cover the behaviour; the sandbox controls test test code |
| profile-renew: two interleaving races (6, 10) | Two exact orderings of renewed:false vs re-claim | Low to medium: 7 and 3 keep the "recover exactly once" and "rival stops the pump" rules; the drops are other orderings of the same code |
| cli: 16 contextual-help spellings, 3 help-page tests, partial inbox obligation | Per-verb help text parse | No: cli-census loops over every verb's help against the parser. The partial-obligation test (42) guards "no invented count"; low |
| stamp-pi-build (1) | The build step replaces the stamp file atomically rather than truncating | Low: a truncated stamp makes the build identity UNKNOWN, which shepy-pi-build-info already proves is safe |
| outcome-context-rpc: calendar RPC case (3) | The impossible-date path through the real RPC | No: outcome-context 80 guards the rule; the RPC keeper still proves the wire path |
| trim (11): wake 15 to 18, renew 12, cli 63 to 66, cli-census 15, 16 | Demand rendering and flag parsing | Goes with SHEPYTRIM; the flag acceptance test is the one new test that replaces cli 63 to 66 |

### RISKIEST DROPS

1. **profile-renew 6 and 10** (lease renewal races). They are the only tests of two exact orderings of a late `renewed:false` answer against a fresh token. If recovery code is touched, a Pi seat could lose its lease silently while looking owned. Dropped because 7 (exactly once) and 3 (rival stops the pump) hold the rules; worth a second look from the seat if the renew code changes.
2. **shepy-pi-extension 56** (delivered-RPC failure after a queued trigger keeps the batch ackable, no duplicate). A regression there duplicates a wake or strands a batch. Dropped as a variant of 55 and 52; it is the nearest to a real duplicate-wake path among the drops.
3. **shepy-pi-extension 43 and 45** (workspace-move edge timing: missed move found by timer refresh; stale timer after a move). Only matters for bare `/shepy on` owners that move panes. Dropped because the feature has no factory caller and 26, 44 and 46 keep the main move behaviours.
4. **outcome-context 52 to 55 and 57 to 65** (bad percentage or window spellings). A renderer change could print a nonsense percentage for one spelling (for example a string window) with no test failing. Kept: one percentage refusal (49), one window refusal (56 as a row), and the byte-for-byte renderer check (17). Dropped because the validation is one shared function and the line is advisory.
5. **cli 42** (partial inbox obligation: no invented known count) and **cli 6 / 57 / 10** (help for dispatch, diagnose, owner). Low user impact; listed because they are the only direct checks of those messages. Help is covered by the census loop; the partial-obligation case is not.
(Also noted: stamp-pi-build 1, the atomic-replace test, is the only guard of a build-script property and the slowest test in this set at 0.9 s.)

### TOTALS

Files: 14. Registered tests: 406 (matches the titles files).

| class | tests | note |
|---|---:|---|
| keep | 120 | stay as tests |
| merge | 161 | fold into a keeper as a table row or an extra assert; they stop being separate tests (most are rows of an existing `test.each` or a loop in a keeper) |
| drop | 114 | removed |
| trim | 11 | go with SHEPYTRIM (wake 15 to 18, renew 12, cli 63 to 66, cli-census 15 and 16) |

Tests left in these files after the cut: 120 of 406 (30 percent). The 11 trim tests are counted separately and leave with SHEPYTRIM.
Estimated time: the 14 files hold 7.5 s of summed test time in run 2; the kept tests sum to about 2.1 s. Of the 7.5 s, 3.4 s is one load stall (extension test 54, a body that sleeps 60 ms) and 0.9 s is the stamp-pi-build test. So these files are about 3 percent of the suite's 244 s of summed file time, and the gain here is count, lines and flake exposure, not minutes. Method: per-test durations from scratchpad/titles (run 2, load about 17) for kept tests; import and setup cost per file is not counted.

---

# Part 4

Read: every test body in the 13 files. Numbers "i" below are line numbers in `scratchpad/titles/<file>.txt` (run 2, load about 17). Gate seconds are that file's own tests in run 2; "after" = kept tests' seconds plus 30 percent of merged tests' seconds (the extra asserts and rows folded into a keeper). Run 2 had one failure in these files (agent-history-readers, test 5); run 1 had the same one. No test in these files carries a demand or operations tag, so trim = 0.

### FILES

#### test/integration/agent-lifecycle.test.ts (own 30, gate 11.6 s) keep 15 / merge 10 / drop 5 / trim 0
- 1: keep — one gone after close, two other workers retained, across a daemon restart (README: close gives one gone). 2 (restart=true row): merge into 1.
- 3: keep — agent exits but shell pane stays: gone once. 4 (null agent row): merge into 3.
- 5: keep — an old name never follows a new terminal; an explicit new subscription works.
- 6: keep — each profile gets one gone; a pending done is never erased by removal (crash between append and publish). 21 (unsubscribing one profile leaves the other's gone): merge into 6 as extra asserts.
- 7: drop dup — OpenCode source-entry dedupe plus close recovery; recovery is guarded by 6, dedupe by notice-correctness.
- 8: keep — close during the missing-final retry publishes done before gone (an upper bound of 30 ms against a 500 ms production wait, see wall-clock).
- 9: keep — move keeps a paneId subscription across workspace and pane ids. 10, 11 (terminalId, name rows): merge into 9.
- 12: keep — launch-pending panes keep presence without freezing another worker's close.
- 13: keep — a pane shift (A to p2, B to p3) rewrites all subscriptions consistently. 14 (swap row): merge into 13.
- 15: drop probe — P7b colliding destination row; rare, one case of 13.
- 16: drop probe — duplicate move keeps pending outcomes; same reason.
- 17: drop impl — injected SQL trigger proves a batch move rolls back; the atomic-move claim is covered by 22.
- 18: keep — automatic pruning keeps a never-matched modern subscription until presence proves absence. 19 (refuses unknown identity and missing terminal metadata): merge into 18.
- 20: keep — startup before first refresh, a Herdr failure and a malformed snapshot never delete subscriptions.
- 22: keep — projection and subscription removal roll back together (README: transitions and events commit together).
- 23: drop impl — a fake-timer test of the test helper `until` (no production code).
- 24: keep — three workers over a real JSON Lines socket: status event delivers done, close delivers gone, others kept.
- 25: keep — pane.closed reconciles exactly once and leases done before gone. 26 (pane.exited), 27 (disconnect): merge into 25 as rows (each costs a socket server).
- 28: keep — age prune runs after a healthy full refresh, not an unreachable one, and skips stopped sessions.
- 29: keep — a subscribed shell waits past the age gate and later delivers its first done. 30 (agent-detected refreshes an empty session): merge into 29 (same first steps).

#### test/integration/agent-index-service.test.ts (own 6, gate 2.5 s) keep 4 / merge 0 / drop 2 / trim 0
- 1: keep — only missing, revised or identity-changed agents are re-read; pane moves publish both workspaces.
- 2: keep — a rename publishes without re-reading history and event payloads carry the new name.
- 3: keep — a status change refreshes immediately; an unknown pane gets one synthesized transition; a duplicate event gives nothing.
- 4: drop impl — refresh coalescing asserted by promise identity (`toBe`) and snapshot count.
- 5: keep — a Pi session hint registered before the agent is indexed is applied at the first refresh.
- 6: drop probe — hint serialized with refreshes; a race variant of 5.

#### test/integration/agent-context-service.test.ts (own 8, gate 5.0 s) keep 4 / merge 4 / drop 0 / trim 0
- 3: keep — a stored refs table (revision advance, reset, identity change, deleted file): never reuse a no-session hint, always rediscover. 1, 2 (missing snapshot, changed source): merge into 3 as rows.
- 5: keep — a resolved path is reused for the same authoritative ID and rebound for a changed ID. 4 (changed vs unchanged authoritative path ref): merge into 5.
- 6: keep — a snapshot is written only when the payload changes (no wake storm).
- 7: keep — cached reads join agents with persisted histories and never invoke history. 8 (no workspace context without non-self snapshots; stopped sessions excluded): merge into 7.

#### test/integration/agent-context-snapshot-store.test.ts (own 3, gate 0.8 s) keep 1 / merge 1 / drop 1 / trim 0
- 1: keep — round trip, upsert, list and cascade on agent removal. 2 (snapshot without readable history): merge into 1.
- 3: drop impl — asserts one internal error message.

#### test/integration/agent-context-health-rpc.test.ts (own 2, gate 1.0 s) keep 1 / merge 0 / drop 1 / trim 0
- 1: keep — over the real RPC, agent.get serves contextHealth, agent.list does not, and a compaction-only append flips it with no wake.
- 2: drop dup — branch_summary then user append reads stale; the same rule (`branch_switched_since_reading`) is in context-health-pi.test.ts.

#### test/integration/agent-history-identity.test.ts (own 8, gate 0.6 s) keep 5 / merge 2 / drop 1 / trim 0
- 1: keep — a Claude parent id resolves to the main transcript, never subagent copies (end to end).
- 2: merge into 3 — a validated hint avoids rediscovery (performance side of the alias rule).
- 3: keep — a unique cached Claude main survives a cwd alias without rediscovery (README sentence).
- 4: keep — a second main arriving after a cached unique ref re-enables cwd disambiguation (new file). 5 (incomplete file row): merge into 4.
- 6: keep — poisoned hints (subagent copy, foreign file stamped with the id) are rejected.
- 7: drop impl — nested compact reference kind after a warm discovery cache.
- 8: keep — same-revision refresh recovers a late Pi file and repairs a wrong-session hint (README).

#### test/integration/agent-store-terminal-identity.test.ts (own 9, gate 3.3 s) keep 3 / merge 4 / drop 2 / trim 0
- 1: keep — an agent keeps its id when its terminal moves to a new pane and workspace. 5 (move preserves refs), 7 (name change or clear keeps identity): merge into 1.
- 2: keep — pane revisions, and reported versus Pi-hint session ref priority. 3 (a Pi hint is rejected for a terminal indexed as another agent), 4 (hint cleared when the terminal changes agent): merge into 2.
- 6: keep — a new occupant of a pane never inherits the old identity, refs, hint or snapshot.
- 8: drop probe — a hint for an unknown terminal creates nothing.
- 9: drop impl — event terminal id column, and migrated events read as null (the migration itself is in sqlite-migrations).

#### test/unit/agent-history-discovery.test.ts (own 11, gate 0.8 s) keep 5 / merge 4 / drop 2 / trim 0
- 1: keep — a missing exact Pi path never falls back to a neighbour's same-cwd session.
- 2: keep — ID lookup selects the exact session, never the newer cwd neighbour (table). 3, 4 (claude, codex rows): merge into 2 (already rows of one `test.each`; they stay rows).
- 5: drop dup — Claude parent id to main transcript; guarded end to end by identity>1.
- 6: keep — two genuine mains with one id fail closed. 7 (subagent-only matches stay unresolved): merge into 6.
- 8: drop impl — `historySourceFromSessionRef` mapping table.
- 9: merge into 10 — Codex cwd-only discovery returns null (the README rule: no native identity, no history).
- 10: keep — OpenCode refuses cwd-latest and resolves only an exact V1 id.
- 11: keep — Gemini discovery by id through `.project_root`; no id gives null.

#### test/unit/agent-history-readers.test.ts (own 16, gate 0.9 s) keep 10 / merge 5 / drop 1 / trim 0
- 1: keep — Codex timestamps: seconds, milliseconds, ISO and invalid.
- 2: keep — two same-cwd Codex sessions bind by id; cumulative and cached tokens never add to the fill figure.
- 3: merge into 16 — absent, malformed or cumulative-only token_count never reports fill.
- 4: keep — Codex user, assistant and tool output messages.
- 5: **drop stale** — "CodexHistoryReader is registered in the default agent history service" (the failing test). See the finding below.
- 6: keep — OpenCode text and tool parts. 7: keep — an unreadable OpenCode DB schema is an error, not empty history.
- 8: keep — Gemini user and assistant messages. 9 (tool result), 10 (malformed JSON gives empty): merge into 8.
- 11: keep — Codex token_count then task_complete settles the turn. 12: keep — a new task_started invalidates the reading.
- 13: keep — compaction plus all-zero token_count is unavailable, never 0 percent. 14 (positive sample recovers), 15 (zero without compaction): merge into 13.
- 16: keep — malformed or cumulative-only, model change and session change stay unavailable.

#### test/unit/agent-history-service.test.ts (own 15, gate 1.3 s) keep 4 / merge 3 / drop 8 / trim 0
- 1: keep — a cached OpenCode cwd hint cannot bypass the refusal without native identity.
- 2: keep — an exact session path overrides another same-cwd agent's cached history (real files).
- 3: drop impl — valid preferred ref skips discovery (fake reader call counts).
- 4: drop impl — fresh cache skips the reader (fake cache).
- 5: drop impl — `forceDiscovery` option ignores the preferred ref.
- 6: merge into 9 — a disappeared direct ref gives empty history.
- 7: drop impl — OpenCode DB path used as fingerprint path.
- 8: merge into 9 — live read falls back once when the ref is missing.
- 9: keep — rediscover exactly once when the preferred ref is missing or the reader fails. 10 (same rule for live reads): merge into 9.
- 11: drop impl — `getCompactHistory` compatibility wrapper.
- 12: drop impl — `cacheSourcePathForRef` string format.
- 13: drop pin — asserts the literal `agent-history-v3` and a v1 cache row is recomputed; behaviour kept by 14.
- 14: keep — a stored v2 Codex projection under an unchanged file fingerprint is recomputed after upgrade.
- 15: drop impl — non-Pi readers keep `contextHealth` null (a shape check on four readers).

#### test/unit/hermes-reader.test.ts (own 15, gate 1.8 s) keep 6 / merge 8 / drop 1 / trim 0
- 1: keep — reads user, assistant and tool messages. 2 (epoch seconds), 10 (compact projection last turns): merge into 1.
- 3: keep — excludes compacted history, never leaks another session. 11 (fails closed without a session id, survives a missing DB): merge into 3.
- 4: keep — never surfaces system prompts or reasoning.
- 5: keep — tool failure classification (a `test.each` of five payloads). 6, 7, 8, 9: merge into 5 (they stay rows; the controls 8 and 9 are the useful two).
- 12: keep — session revision moves only for the session that changed.
- 13: merge into 14 — exact session id resolves to the state store.
- 14: keep — Hermes refuses to guess between sessions sharing one cwd.
- 15: drop impl — session ref routes to the `hermes-sqlite` source (mapping).

#### test/unit/opencode-v2-history.test.ts (own 5, gate 4.1 s) keep 2 / merge 3 / drop 0 / trim 0
- 1: keep — paired V1 and V2 exact IDs discover and read the same logical message. 2 (mixed store: only the requested family; frozen V1 never impersonates V2): merge into 1.
- 3: merge into 1 — malformed and missing stores stay unknown rather than empty. 5 (unknown V2 row kind stays an error): merge into 3, then 1.
- 4: keep — live V2 rows: answer, tool results and failures, bookkeeping rows skipped.

#### test/unit/herdr-session-watch-manager.test.ts (own 10, gate 3.5 s) keep 5 / merge 2 / drop 3 / trim 0
- 1: drop pin — asserts exported constants 10,000 and 60,000.
- 2: keep — working sessions poll at the active cadence and rescan once at the boundary (fake timers). 5 (all-idle sessions are not polled): merge into 2.
- 3: keep — a failing tick is survivable (the 2026-10-08 daemon crash). 4 (observable degraded health, then recovery): merge into 3.
- 6: drop probe — awaits a removed watcher before finalizing the stopped session (one race).
- 7: drop probe — no watcher starts after stop wins a rescan race (one race).
- 8: keep — one shared refresh result publishes once. 9: keep — reconnects when the stream closes with no restart event.
- 10: keep — reconcile before publishing context and events after a pane move.

### BEHAVIOURS

| Behaviour in plain words | Best guard tests (file > title) |
|---|---|
| A seat subscribed to a worker gets exactly one "gone" after the pane closes, the agent exits or Herdr disconnects, with any pending done delivered first and the other workers kept | agent-lifecycle > "one gone after close; restart=%s"; "reconciles %s exactly once and leases pending done before gone"; "each profile gets one gone and removal never erases pending done" |
| Subscriptions follow a worker through pane and workspace moves, but an old name never follows a new terminal | agent-lifecycle > "move preserves %s subscription"; "old name never follows a new terminal"; agent-store-terminal-identity > "keeps an agent id when its stable terminal moves" |
| Nothing is deleted on a Herdr failure, a malformed snapshot or before the first refresh; automatic pruning needs proof of absence and the age gate | agent-lifecycle > "startup before first refresh, Herdr failure and malformed snapshots never delete"; "P4 automatic pruning keeps…"; "age prune runs after a healthy full refresh" |
| A completed turn and its excerpt are read once, with a retry for missing final text; a status change refreshes immediately | agent-index-service > "refreshes status immediately and synthesizes an unknown-pane transition exactly once"; agent-lifecycle > "close during the missing-final retry publishes done before gone" |
| `shepy agent get` shows the right transcript: the exact session id or path wins, a neighbour in the same cwd never does, and no native identity means empty history | agent-history-discovery > "ID lookup selects the exact session"; "refuses OpenCode cwd-latest…"; agent-history-service > "an exact session path overrides another same-cwd agent's cached history"; agent-history-identity > "poisoned hints… are rejected" |
| Claude parent ids resolve to the main transcript, never subagent copies; a cwd alias keeps a unique cached main; a second main re-enables disambiguation | agent-history-identity > "claude parent id resolves…"; "a unique cached Claude main survives a cwd alias…"; "a second main arriving…" |
| A Pi file that appears after startup is picked up on the next refresh; a wrongly bound cached hint repairs itself without deleting the database | agent-history-identity > "same-revision refresh recovers a late Pi file and repairs a persisted wrong-session hint" |
| Context health (percent of window) is right for Codex and Pi: settled turn, new turn, compaction, model or session change; unavailable is never shown as 0 percent | agent-history-readers > "Codex context from real rollout structure" (S3 block); agent-context-health-rpc > "agent.get serves contextHealth, agent.list does not…" |
| Each runtime's history is read faithfully and unreadable storage is an error, not "empty" | agent-history-readers > OpenCode, Gemini and Codex reads; hermes-reader > "reads user, assistant, and tool messages"; opencode-v2-history > "paired V1 and V2 exact IDs…" |
| Hermes and OpenCode never leak another session's text or private reasoning | hermes-reader > "excludes compacted history and never leaks another session"; "never surfaces system prompts or reasoning" |
| The daemon keeps polling after a transient failure and reports degraded health after repeated ones; it reconnects when Herdr's event stream closes | herdr-session-watch-manager > "a failing tick is survivable"; "reconnects when Herdr event stream closes…" |

### WALL-CLOCK BOUNDS UNDER 1 s

Real elapsed time. Status column: none of the tests below showed `f` in either full run, except as noted.

| file:line | bound | what it does | class | failed? |
|---|---|---|---|---|
| agent-lifecycle.test.ts:283 | 30 ms sleep | gives the real index time to admit the deferred final, then closes the pane; the production retry waits 500 ms (`agent-index-service.ts:684`), so the test needs fewer than about 470 ms of stall between the refresh start and the close event, else `excerpt` is no longer null | test 8 keep | no (958 ms under load 17) |
| agent-lifecycle.test.ts:652-654 | polls 20 ms, rescan 80 ms, reconnect 5 ms | real watcher timers in the socket fixture; tests 24 to 30 wait on outcomes via `until`, which has no deadline of its own (stops at the 5 s test timeout) | tests 24, 25 to 30 keep/merge | no |
| agent-lifecycle.test.ts:784 | 100 ms sleep | after two outcomes arrive, waits to confirm that no third one ("exactly once") appears: a lower bound that only shows a duplicate if it arrives within 100 ms | test 25 and rows 26, 27, keep | no |
| agent-lifecycle.test.ts:825 | 100 ms sleep | while Herdr answers "unavailable", waits long enough for at least one 80 ms rescan to fail, then asserts no prune: a lower bound; on a stalled loop the rescan may not have run, which would pass for the wrong reason | test 28 keep | no |
| agent-lifecycle.test.ts:699 | 5 ms poll | `until` loop step | helper | no |
| agent-context-service.test.ts:324 | 1 ms | `updatedAt` of a re-written snapshot must be strictly later than the stored one (two `new Date()` stamps); the re-read and DB write between them normally take more than 1 ms | test 6 keep | no |
| herdr-session-watch-manager.test.ts:329-335, 396, 520 (helper `waitFor`, 10 ms step, 1,000 ms deadline) | 1,000 ms (not under, but equal to 1 s) | tests 9 and 10 wait for a reconnect or `handled > 0` against a deadline of exactly 1 s; the message is "condition was not met" | tests 9, 10 keep | no |
| herdr-session-watch-manager.test.ts:330 | 20 ms | pacing sleep inside a fake event stream (test 9) | test 9 | no |
| herdr-session-watch-manager.test.ts:520 | 10 ms | `waitFor` poll step | helper | no |

Fake-timer uses (not flaky, real time unaffected): herdr-session-watch-manager tests 2, 3, 4, 5, 7, 8 (`vi.useFakeTimers`, 5 to 60 ms of virtual time); agent-lifecycle test 23 (virtual 2,100 ms, dropped).

Not wall-clock, but time-shaped: `Date.now() + 121000` in agent-lifecycle (fixed offsets, fine); `utimes(worker, 1, 1)` and `utimes(neighbor, 2, 2)` in discovery (explicit mtimes, fine). No test in the other eight files (agent-index-service, snapshot-store, health-rpc, history-identity, store-terminal-identity, history-readers, history-service, hermes, opencode-v2) uses a timer or a time bound.

### DROP GROUPS: WHAT IS LOST

| group (tests) | protection lost | can a likely regression slip through? |
|---|---|---|
| Mock call-count and option checks in the history service (3, 4, 5, 7, 11, 12, 15 of agent-history-service: 7) | A change to when the service skips discovery or reads the cache goes unnoticed; the visible result (right transcript, empty when unknown) stays guarded by 1, 2, 9 and by the identity tests | Low: a regression shows up as wrong or stale history, which the kept tests see; a pure performance regression (extra discovery scans) would slip |
| Formatter-version pin (agent-history-service 13) | A bump of `agent-history-v3` that forgets the cache would not be flagged by name | Low: test 14 proves a stored old Codex projection is recomputed |
| Race probes (lifecycle 15, 16, 17; index-service 6; watch manager 6, 7: 6) | P7b merge collisions, duplicate moves, move rollback, hint-versus-refresh ordering, stop-versus-rescan | Low to medium: each is a rare ordering; the move rollback (17) is the one with a data-loss shape, but 22 guards the same atomic commit path |
| Helper and constant pins (lifecycle 23; watch manager 1; discovery 8; hermes 15: 4) | Nothing user visible | No |
| Dup of a kept guard (lifecycle 7; discovery 5; health-rpc 2: 3) | Nothing new | No |
| Stale (readers 5: 1) | A test that currently fails and asserts the old cwd-only Codex lookup | No: it contradicts the README rule; discovery > "ID lookup selects the exact session" guards the Codex id path |
| Store and shape checks (snapshot-store 3; identity 7; store-terminal-identity 8, 9: 4) | One error message, one nested ref kind, an unknown-terminal hint, the event terminal-id column | Low; the migration of the event column is in sqlite-migrations |

### RISKIEST DROPS

1. **lifecycle 17** (failed batch move rolls back): a half-applied pane move could leave subscriptions pointing at the wrong pane while the agent index shows the new one, and a later gone would go to the wrong seat. Dropped because 22 proves the same commit-together path for the gone case and the trigger is an injected SQL failure. If Ray wants one rollback test for moves, keep 17 instead of 22.
2. **lifecycle 15 (P7b)**: two workspaces with a same-named worker move into one; ambiguity handling is lost. Rare; the visible result is `ambiguous` instead of `matched`.
3. **agent-history-service 3, 4, 5** (skip discovery, skip reader, force discovery): a change that makes every refresh rediscover or reread (CPU and disk at 60 s rescans) is not caught. Kept guards check results, not work done.
4. **watch manager 6 and 7** (stop races): the 2026-10-08 style incident class (daemon crash) was a failing tick, which test 3 keeps; the stop races could leave a watcher running after `daemon stop`.
5. **agent-history-service 13** (formatter version literal): a forgotten version bump after a reader change would show old context percent until the file changes; test 14 covers only the Codex v2 case.

### Finding: the failing Codex test is stale, not calendar rot

`agent-history-readers.test.ts` "CodexHistoryReader is registered in the default agent history service" calls `createAgentHistoryService({homeDir}).read({agent: "codex", agentSession: null, cwd: "/repo"})` and expects the transcript found by cwd. `discoverAgentHistory` (`src/agent-history/discovery.ts`, the final `return null` after the id branch) returns a path for Codex only when `agentSession.kind === "id"` matches a session header; `service.read` then returns `{historyRef: null, messages: []}`. This is the intended rule from commit `2a0bade` (README: without a native session identity, history is empty), and `agent-history-discovery` test 9 asserts it ("refuses Codex cwd-only discovery"). The fixture date (2026-07-09) plays no part: `discovery.ts` has no date or age filter (grep for Date, days and lookback finds nothing), and the failing assert is `historyRef: null` on an `agentSession: null` lookup. Not re-run with a changed date. Fix if wanted: not worth it; drop it (the Codex id path is guarded by discovery test 2 and readers test 2). `observability-rpc` "reads additional runtime histories through agent.read" (another file) fails for the same reason and belongs to another reader's list.

### TOTALS

| | tests | keep | merge | drop | trim |
|---|---:|---:|---:|---:|---:|
| 13 files | 138 | 65 | 46 | 27 | 0 |

- Counts per file: lifecycle 15/10/5; index-service 4/0/2; context-service 4/4/0; snapshot-store 1/1/1; health-rpc 1/0/1; history-identity 5/2/1; store-terminal-identity 3/4/2; discovery 5/4/2; readers 10/5/1; history-service 4/3/8; hermes 6/8/1; opencode-v2 2/3/0; watch-manager 5/2/3 (keep/merge/drop).
- Tests after: 65 (merged tests become rows or extra asserts inside keepers; where the keeper is already a `test.each`, the rows stay and the count of registered tests would be a few higher).
- Gate seconds: 37.1 s of test time in run 2 (load 17), about 23.6 s after (kept seconds plus 30 percent of merged seconds). Method: per-test `duration` from `vitest.json` of run 2; includes about 300 ms of database harness setup per integration test, so merging saves roughly that per removed test. File wall times in run 1: agent-lifecycle 7.6 s, others under 1.7 s.

---

# Part 5

Base: Shepy 7a7a3af, my second full run (load about 17). 25 test files, 181 registered tests. Ops-tagged files are the operations feature and the Herdr orchestration transport that Ray may remove later (row 5 and 6 of shepy-trim); nothing here is demand code, so no test is classed trim.

### FILES
#### test/integration/observability-rpc.test.ts (own 9, gate 2.6 s) keep 7 / merge 1 / drop 1 / trim 0; after 2.0 s
- test 1: KEEP — agent.list/get/read/events over the real socket; unknown method refused (the CLI and Pi plugin path)
- test 2: KEEP — target resolution order: identifiers, then live names, then kinds (README rule)
- test 3: MERGE (dup) — ambiguity error lists only the highest-priority candidates; fold into #2 as a second assert (same seeded fixture); never guess
- test 4: KEEP — agents of a stopped Herdr session are hidden from list/get
- test 5: DROP (stale) — fails today (both runs): asserts cwd-only Codex/OpenCode discovery that README and discovery.ts no longer allow ('without a native session identity history is empty'); Gemini cwd read is guarded by agent-history-readers Gemini tests. Reviewer's calendar guess is wrong: the fixture date is irrelevant
- test 6: KEEP — events reach only the newest owner socket; role changes reach the exact scope; ack of own event refused (Pi seat contract); uses 20 ms tick + polling client
- test 7: KEEP — list is served from cache; persisted ref used only for live detail reads (cost guard)
- test 8: KEEP — context pushed only to current owner, null clearing snapshot
- test 9: KEEP — stale pane alias resolves from live Herdr; invalid params refused

#### test/integration/daemon-dispatch-rpc.test.ts (own 3, gate 1.0 s) keep 2 / merge 1 / drop 0 / trim 0; after 0.7 s
- test 1: KEEP (ops) — operation.dispatch resolves, persists, submits; queryable (the only public-entrypoint dispatch test)
- test 2: MERGE (ops,dup) — unmatched profile creates no operation: fold into #1 as a second case (resolver table covers all codes)
- test 3: KEEP (ops) — transport rejection leaves an auditable row

#### test/integration/daemon-info.test.ts (own 9, gate 2.5 s) keep 2 / merge 4 / drop 3 / trim 0; after 0.7 s
- test 1: KEEP — daemon.info returns the five identity fields over the real RPC (seats read it to know which build runs)
- tests 2,3: MERGE (dup) — bootId stable per boot / different per instance: fold into #1 as asserts
- test 4: DROP (impl) — explicit info served verbatim: test-constructor detail
- test 5: KEEP — daemon.health serves the live session-watch snapshot (health backstop)
- test 6: MERGE (dup) — no watch manager answers unknown, not healthy: fold into #5
- test 7: DROP (impl) — resolveBuildStamp returns mtime ISO: helper detail, exercised by #1
- test 8: MERGE (dup) — missing file degrades to unknown: fold into #1 (buildStamp field)
- test 9: DROP (impl) — createDaemonInfo resolves stamp once: constructor detail

#### test/integration/herdr-orchestration-transport.test.ts (own 1, gate 0.0 s) keep 1 / merge 0 / drop 0 / trim 0; after 0.0 s
- test 1: KEEP (ops) — exact agent.prompt / agent.wait payloads over a real Unix socket (producer-shaped wire; only real-socket test of the transport)

#### test/integration/herdr-socket-client.test.ts (own 7, gate 0.7 s) keep 6 / merge 1 / drop 0 / trim 0; after 0.4 s
- test 1: KEEP — pane metadata over the persistent Herdr socket
- test 2: KEEP — uses Herdr session snapshots when available
- test 3: KEEP — falls back to list APIs when snapshots unavailable (older Herdr)
- test 4: KEEP — event subscription yields notifications
- test 5: KEEP — event stream rejects when the socket closes (the watch manager reconnects on this)
- test 6: KEEP — bounded agent.wait outlives default request deadline (incident of 2026-09-04); timing: server 300 ms vs client 200 ms
- test 7: MERGE (dup) — unbounded agent.wait is not cut: fold into #6 as a second request (halves the timer-ordering tests)

#### test/integration/operation-wait-rpc.test.ts (own 7, gate 2.2 s) keep 5 / merge 2 / drop 0 / trim 0; after 1.4 s
- test 1: KEEP (ops) — captured Herdr 0.8 agent_info shape settles the operation
- test 2: KEEP (ops) — unreadable wait shape returns transport_unknown and keeps the operation submitted
- test 3: KEEP (ops) — Codex: old-turn done cannot settle on the same identity
- test 4: MERGE (ops,probe) — late later-turn: fold into #3 as a row
- test 5: KEEP (ops) — bare Codex wait returns honest unknown on Herdr bounded timeout
- test 6: KEEP (ops) — herdr bounded-wait expiry reports clean wait_timeout
- test 7: MERGE (ops,dup) — socket-level request timeout is an RPC error, not wait_timeout: fold into #6 as a second case

#### test/integration/operation-wait.test.ts (own 4, gate 1.1 s) keep 2 / merge 2 / drop 0 / trim 0; after 0.6 s
- test 1: KEEP (ops) — correlated done result settles against real SQLite
- test 2: KEEP (ops) — timeout leaves the operation submitted and settleable later
- tests 3,4: MERGE (ops) — first terminal wins; wrong-pane result ignored: fold into #1 as asserts on the same fixture

#### test/integration/operations-store.test.ts (own 12, gate 2.2 s) keep 5 / merge 4 / drop 3 / trim 0; after 0.9 s
- test 1: KEEP (ops) — create in submitted state with full identity
- test 2: MERGE (ops,dup) — transport receipt advances to submitted: fold into #1
- test 3: KEEP (ops) — uncertain submission (timeout after send) is submission_unknown, never success
- test 4: MERGE (ops,dup) — rejected submission fails closed: fold into #3
- test 5: KEEP (ops) — terminal transition settles exactly once
- tests 6,7: MERGE (ops,dup) — conflicting terminal cannot overwrite; invalid transitions rejected: fold into #5
- tests 8,9: DROP (ops,impl) — recordWaitError field-level behaviour (two tests, two 5 ms sleeps for timestamp ordering): internal bookkeeping; the visible effect (transport_unknown stays re-waitable) is guarded in operation-wait-service/RPC
- test 10: KEEP (ops) — operations survive a restart (reopen the SQLite file)
- test 11: KEEP (ops) — another workspace or profile cannot read the operation
- test 12: DROP (ops,impl) — list newest first: sort order of an internal list (no CLI caller found in tests)

#### test/integration/sqlite-migrations.test.ts (own 6, gate 3.5 s) keep 5 / merge 1 / drop 0 / trim 0; after 3.3 s
- test 1: KEEP — upgrade marks existing subscriptions legacy; new rows stay modern (real data protection; SHEPYTRIM says this file stays)
- test 2: KEEP — backfills delivery_seq and agent source while preserving obligations (14,160 live obligation rows)
- test 3: KEEP — recovers a partial owner column; rejects a legacy schema mismatch
- test 4: KEEP — forward upgrade from 0011 preserves owners, tokens, obligations, indexes, journal; reapply safe
- test 5: MERGE (dup) — same upgrade from 0012: fold into #4 as a second starting point
- test 6: KEEP — fresh install creates the agent index schema (also holds the kept demand table check)

#### test/unit/observability-contracts.test.ts (own 5, gate 0.0 s) keep 1 / merge 2 / drop 2 / trim 0; after 0.0 s
- test 1: KEEP — list scopes validated (--all, --workspace) at the contract boundary
- tests 2,3: MERGE (dup) — get/read input and orchestrator connection-bound inputs: fold into #1 as a table; the RPC refuses these in observability-rpc #9
- test 4: DROP (pin) — exposes final cached-context types: a type-presence pin
- test 5: DROP (impl) — keeps terminal identity in orchestrator contracts: contract shape pin

#### test/unit/daemon-process-manager.test.ts (own 14, gate 0.3 s) keep 7 / merge 5 / drop 2 / trim 0; after 0.2 s
- test 1: KEEP — status stopped when no pid file
- test 2: KEEP — status orphaned: no pid file but socket reachable
- tests 3,4: MERGE (probe) — EPERM = live, ESRCH = stopped: fold into #5 as a table
- test 5: KEEP — status running for a live pid
- test 6: MERGE (dup) — stale pid + reachable socket = orphaned: fold into #2
- tests 7,8: DROP (impl) — runtime record write/read and invalid record: #13 and config-runtime #8 guard the visible behaviour
- test 9: KEEP — refuses to remove a reachable daemon socket (safety)
- test 10: MERGE (dup) — removes an unreachable stale socket: fold into #9
- test 11: KEEP — refuses to start when already running
- test 12: MERGE (dup) — refuses to start on an orphaned reachable socket: fold into #11
- test 13: KEEP — starts a detached daemon and writes pid and runtime record
- test 14: KEEP — stop sends SIGTERM and removes the pid file

#### test/unit/daemon-service.test.ts (own 1, gate 0.0 s) keep 1 / merge 0 / drop 0 / trim 0; after 0.0 s
- test 1: KEEP — migrations found from the package root, not the launch cwd (installed binary run from any directory)

#### test/unit/config-loader.test.ts (own 3, gate 0.0 s) keep 2 / merge 1 / drop 0 / trim 0; after 0.0 s
- test 1: KEEP — loads a valid YAML config
- test 2: KEEP — rejects unknown fields (typo in config is refused, not ignored)
- test 3: MERGE (dup) — YAML parse errors returned without throwing: fold into config-runtime #7 (invalid config) 

#### test/unit/config-runtime.test.ts (own 11, gate 0.0 s) keep 5 / merge 5 / drop 1 / trim 0; after 0.0 s
- test 1: KEEP — ~/.shepy default home when SHEPY_HOME absent
- tests 2,3: MERGE (dup) — explicit SHEPY_HOME; default paths under home: rows of #1
- test 4: KEEP — relative config paths resolve from Shepy home
- test 5: MERGE (dup) — absolute paths kept: row of #4
- test 6: KEEP — '.env' values override shell values; SHEPY_ variables ignored
- test 7: KEEP — invalid config throws unless allowed
- test 8: KEEP — management commands fall back to the runtime record paths
- test 9: MERGE (dup) — no runtime record falls back to home defaults: row of #8
- test 10: MERGE (dup) — explicit runtime path values: row of #4
- test 11: DROP (impl) — resolves from an already loaded config: internal overload

#### test/unit/config-schema.test.ts (own 4, gate 0.0 s) keep 0 / merge 0 / drop 4 / trim 0; after 0.0 s
- test 1: DROP (dup) — minimal config accepted: config-loader #1 does the same through the loader
- test 2: DROP (impl) — default telemetry excerpt limit: a constant
- tests 3,4: DROP (dup) — unknown keys rejected: config-loader #2 guards this through the loader

#### test/unit/herdr-orchestration-transport-adapter.test.ts (own 19, gate 0.0 s) keep 7 / merge 8 / drop 4 / trim 0; after 0.0 s
- test 1: KEEP (ops) — submit to the exact pane, return Herdr's request id
- test 2: KEEP (ops) — captures Codex prompt receipt identity and sequence at accept
- test 3: KEEP (ops) — Codex: represented idle completion never settles from pane state alone (becomes the table of 5 cases)
- tests 4,5,6,7: MERGE (ops,probe) — old-turn, later-turn, replacement session, replacement terminal: rows of #3 (four probes of one rule; RPC #3 covers it end to end)
- test 8: KEEP (ops) — unstable targets rejected before calling Herdr
- test 9: KEEP (ops) — normalises done and blocked wait results
- test 10: MERGE (ops,dup) — Pi receipt evidence keeps the original filter: row of #9
- test 11: KEEP (ops) — reads the live Herdr 0.8 agent_info shape
- tests 12,13: MERGE (ops,dup) — blocked from live shape; agent_status unknown never settled: rows of #11
- test 14: KEEP (ops) — unrecognised wait result becomes transport_unknown, never throws
- test 15: MERGE (ops) — detail names top-level keys, never the payload (no leak): extra assert on #14
- test 16: DROP (ops,impl) — truncation to exactly 300 chars with an ellipsis: formatting detail
- tests 17,18,19: DROP (ops,dup) — silent Codex socket bounded; bounded-wait expiry maps to timeout error; request timeout is not a wait timeout: all three are guarded through the public entrypoint in operation-wait-rpc #5, #6, #7

#### test/unit/herdr-orchestration-transport.test.ts (own 4, gate 0.0 s) keep 1 / merge 2 / drop 1 / trim 0; after 0.0 s
- test 1: KEEP (ops) — lifecycle correlation requires the exact target identity
- tests 2,3: MERGE (ops,dup) — event from another Herdr session; target missing session identity: rows of #1
- test 4: DROP (ops,impl) — capability keys are explicit: asserts Object.keys of the transport object (a shape pin)

#### test/unit/herdr-plugin-package.test.ts (own 5, gate 1.5 s) keep 1 / merge 2 / drop 2 / trim 0; after 0.0 s
- test 1: DROP (pin) — toml contains the strings 'agent-list', titles: manifest text pin
- test 2: KEEP — Herdr action renders agent rows from the daemon RPC (what a Herdr user sees)
- tests 3,4: MERGE (dup) — missing Herdr context exits 2 with HERDR_ENV hint; empty list text: rows/asserts of #2
- test 5: DROP (dup) — npm pack --dry-run of the plugin: duplicate of 'pnpm herdr-plugin:check' (check-package.mjs); 1.5 s alone, 8.5 s and a 5 s-timeout failure under load in run 1

#### test/unit/herdr-socket-client-silent-peer.test.ts (own 4, gate 0.2 s) keep 2 / merge 1 / drop 1 / trim 0; after 0.2 s
- test 1: KEEP — subscribe over a silent-but-connected socket terminates on abort (the live-wedge case); 50 ms sleep, 1 s deadline
- test 2: KEEP — subscribe rejects on request timeout against a silent peer (requestTimeoutMs 100)
- test 3: MERGE (dup) — abort before subscribe: row of #1 (500 ms deadline)
- test 4: DROP (dup) — control that a responding server still streams: herdr-socket-client #4 covers it

#### test/unit/json-lines.test.ts (own 3, gate 0.0 s) keep 1 / merge 1 / drop 1 / trim 0; after 0.0 s
- test 1: DROP (dup) — encode one frame per newline: every RPC test uses it
- test 2: KEEP — decodes frames split across chunks
- test 3: MERGE (dup) — final frame without trailing newline: row of #2

#### test/unit/operation-dispatch-service.test.ts (own 10, gate 0.0 s) keep 3 / merge 6 / drop 1 / trim 0; after 0.0 s
- test 1: DROP (ops,dup) — happy path: guarded through the RPC in daemon-dispatch-rpc #1
- test 2: KEEP (ops) — the durable operation row exists before the transport call
- test 3: KEEP (ops) — resolution failure creates no operation and never calls the transport (one table for all five codes)
- tests 4,5,6,7: MERGE (ops,probe) — ambiguous, unstable_target, target_lost, invalid: rows of #3
- test 8: KEEP (ops) — transport timeout after send is submission_unknown, never retried
- tests 9,10: MERGE (ops,dup) — explicit rejection is submission_rejected; rejection before send not unknown: rows of #8

#### test/unit/operation-target-resolver.test.ts (own 8, gate 0.0 s) keep 2 / merge 6 / drop 0 / trim 0; after 0.0 s
- test 1: KEEP (ops) — exactly one matched subscription with a stable session resolves
- tests 2,3,5,6,7,8: MERGE (ops,probe) — zero, unmatched, multiple matched, no stable session, not running, invalid selectors: rows of #4
- test 4: KEEP (ops) — ambiguous subscription fails closed with candidates (table of the refusals; never guesses)

#### test/unit/operation-wait-service.test.ts (own 11, gate 0.0 s) keep 2 / merge 1 / drop 8 / trim 0; after 0.0 s
- tests 1,2,3,4: DROP (ops,dup) — correlated settle; other pane, other Herdr session, other agent session never settle: operation-wait integration #1 and its folded wrong-pane assert guard the same rule on real SQLite
- tests 5,6: DROP (ops,dup) — blocked is not success; already-terminal not applied twice: operation-wait integration (first terminal wins, uses blocked)
- test 7: DROP (ops,dup) — wait timeout never settles: operation-wait integration #2
- test 8: KEEP (ops) — waiting on a pending_submission operation fails closed (not covered elsewhere)
- test 9: DROP (ops,impl) — unknown operation id is not_found: trivial lookup
- test 10: KEEP (ops) — transport_unknown records the error but never settles
- test 11: MERGE (ops,dup) — operation is re-waitable after transport_unknown: second half of #10

#### test/unit/package-publication.test.ts (own 2, gate 1.7 s) keep 0 / merge 0 / drop 2 / trim 0; after 0.0 s
- test 1: DROP (pin) — package.json / manifest pin: scripts, files, versions, private flag. 'pnpm package:check' and 'pi-package:check' check the packed result; npm itself refuses to publish a private package
- test 2: DROP (impl) — runs the real Husky in a temp repo (1.7 s): tests the developer tool, not Shepy

#### test/unit/run-tests.test.ts (own 19, gate 9.8 s) keep 7 / merge 10 / drop 2 / trim 0; after 9.1 s
- test 1: DROP (pin) — package.json 'test' script text
- test 2: KEEP — each run gets a fresh physical owner-only runtime disjoint from the repository
- tests 3,4: MERGE (probe) — socket budget counts UTF-8 bytes; falls back to /tmp: rows of #5
- test 5: KEEP — this run's TMPDIR can bind the longest real test socket (the cause of earlier socket flakes)
- test 6: KEEP — child environment built from scratch: no inherited config or credentials (3.5 s; mentions SHEPY_DEMAND_FIXTURE env, edit with SHEPYTRIM)
- test 7: KEEP — an executable on the caller PATH is not discoverable (3.6 s)
- test 8: MERGE (dup) — missing required tool names itself: row of #14
- tests 9,10,11,12,13,15,16: MERGE (probe) — npm lookup layouts (classic, Homebrew, symlink, launcher, real-path wins, launcher refused, no-npm message): rows of #14
- test 14: KEEP — unrelated npm on PATH refused; Homebrew control found (table of the layouts above)
- test 17: DROP (dup) — this machine's node resolves an npm package: every other test calls trustedTools()
- test 18: KEEP — the entry is the locked vitest inside the repository (fails in my worktree only because node_modules is a symlink; environment artifact)
- test 19: KEEP — runVitest starts the child once with 'run' plus the exact arguments and returns its exit

TOTAL own 181, gate 29.3 s (sum of per-test ms), keep 77 / merge 66 / drop 38 / trim 0; kept-test time 19.6 s
### BEHAVIOURS
| Behaviour in plain words | Best guards |
|---|---|
| A seat or the CLI lists, gets and reads agents by pane, terminal, id, live name or kind; an ambiguous name lists candidates and never guesses; agents of a stopped Herdr session disappear | observability-rpc > "serves agent methods over JSONL"; "resolves identifiers before live names…"; "reports ambiguity…"; "hides retained agents…" |
| A Pi seat receives events and context only when it is the current owner; a newer owner replaces an older one; own events cannot be acked | observability-rpc > "routes events to the newest owner socket…"; "returns and pushes context only to the current owner…" |
| The list is served from cache and never touches history files; only a detail read opens the file | observability-rpc > "serves cached lists and uses the persisted ref only for live detail reads" |
| A seat can ask which daemon build is running and whether session watching is healthy; unknown is never reported as healthy | daemon-info > "returns all five identity fields…"; "serves the watch manager's live health snapshot…" |
| `shepy daemon start/stop/status` tells stopped, orphaned and running apart, never removes a live socket, never starts a second daemon, and finds its migrations when run from any directory | daemon-process-manager > status, "refuses to remove a reachable daemon socket", "refuses to start when the daemon is already running", "sends SIGTERM…"; daemon-service > "finds migrations from the package root…" |
| An upgraded database keeps its owners, tokens, subscriptions and 14,160 obligation rows | sqlite-migrations > the five upgrade and recovery tests |
| Shepy talks to Herdr over a persistent socket, uses snapshots when Herdr has them, falls back to list calls, survives a silent peer, and never cuts a long agent.wait | herdr-socket-client > all seven; herdr-socket-client-silent-peer > "must terminate on abort", "must reject on request timeout" |
| Config typos are refused; SHEPY_HOME and .env resolve as documented | config-loader > "rejects unknown fields"; config-runtime > ".env values over shell values", "throws on invalid config" |
| The Herdr plugin action shows the agent table | herdr-plugin-package > "renders agent rows from daemon RPC" |
| (ops) `operation dispatch` and `operation wait`: a prompt goes to exactly one resolved pane, a row exists before the send, an uncertain send is never retried, only a fully correlated result settles, a timeout or unreadable reply leaves the operation waitable | daemon-dispatch-rpc > dispatch; operation-wait-rpc > captured shape, unreadable shape, Codex old turn, silent Codex, wait_timeout; operation-wait; operations-store > "uncertain submission", "settles exactly once", "survive a restart", "scoped" |
| `pnpm test` runs in a private runtime with no inherited credentials and a socket path that fits | run-tests > fresh runtime, child environment, PATH, TMPDIR socket |

### WALL-CLOCK BOUNDS UNDER 1 s
No `vi.useFakeTimers` in these files. No test asserts an elapsed-time upper bound. Real-time dependencies below 1 s:

| file:line | bound | what it does | my class | failed in a run? |
|---|---|---|---|---|
| herdr-socket-client.test.ts:223 | 100 ms | race: the event stream must reject within 100 ms after the socket closes (fail-fast guard) | keep (#5) | no |
| herdr-socket-client.test.ts:239-251 | server answers at 300 ms, client default 200 ms, wait timeout_ms 400 | "bounded wait outlives the default deadline": passes only if the 200 ms client timer does not fire before 300 ms and the wait deadline (400 ms + grace) does not fire first; margins 100 ms | keep (#6) | no (margin shrinks under load) |
| herdr-socket-client.test.ts:272-284 | same 300 ms against 200 ms | "unbounded wait is never cut": same ordering | merge into #6 (halves the timing-sensitive tests) | no |
| herdr-socket-client-silent-peer.test.ts:85 | 50 ms sleep | give the subscribe request time to be written before abort; then expects connected() true | keep (#1) | no |
| herdr-socket-client-silent-peer.test.ts:101 | requestTimeoutMs 100, deadline 1,000 ms | subscribe must reject with "timed out" within 1 s | keep (#2) | no |
| herdr-socket-client-silent-peer.test.ts:134 | 500 ms deadline | abort before subscribe must end within 500 ms | merge (#3) | no |
| herdr-socket-client-silent-peer.test.ts:150 | 30 ms | server pushes the event 30 ms after ack, client timeout 2,000 ms | drop (#4) | no |
| integration/rpc-test-client.ts:57 | 100 polls of 2 ms (about 0.2 s nominal; counts attempts, so drifts longer under load) | `waitForNotification` for observability-rpc #6 and #8 and files of other readers | helper kept | no |
| observability-rpc.test.ts:649 | 20 ms `tick()` | "give it time" before asserting that other sockets got nothing (a late message would be missed, so a false pass, not a flake) | keep (#6, #8) | no |
| operations-store.test.ts:196,225 | 5 ms sleeps | so that updatedAt is strictly later (clock resolution) | drop (#8, #9) | no |
| daemon-process-manager.test.ts:290 | timeoutMs 100 with injected no-op `waitMs` | fake wait loop, not the real clock | keep (#14) | n/a |
Inert numbers (a parameter echoed back, no real waiting): operation-wait*.test timeoutMs 1000/5000, adapter 30_000, transport timeout_ms 5000.
Near the 5 s default test timeout (not under 1 s, but the same flake class): herdr-plugin-package #5 (1.5 s alone; timed out at 8.5 s in run 1), run-tests #6 and #7 (3.5 s and 3.6 s each; both start child processes), package-publication #2 (1.7 s), sqlite-migrations #3 (0.9 s).

### DROP GROUPS: WHAT IS LOST
| Group (tests) | Protection lost | Can a likely regression slip through? |
|---|---|---|
| Stale Codex/OpenCode/Gemini read through the RPC (observability-rpc #5) (1) | End-to-end RPC read for Codex, OpenCode, Gemini | Low. It fails today and checks behaviour that was removed on purpose. Reader-level tests cover Codex by id, OpenCode by id, Gemini by cwd. The RPC `agent.read` path itself stays covered by #1 |
| Config schema (config-schema all 4, config-runtime #11, config-loader folded) (6) | Direct schema assertions | No: config-loader goes through the same schema |
| Operation unit tests duplicated by RPC and real-SQLite tests: wait-service 8, adapter 4 (12) | The same settle, correlation and timeout rules at unit level | Low: operation-wait-rpc and operation-wait guard each rule through the public entrypoint |
| Operations store bookkeeping (3) and dispatch happy path (1) | recordWaitError columns, list order, unit happy path | No caller in tests; the visible effect is in the RPC tests |
| Daemon-info helper tests (3) and runtime-record tests (2) | Build-stamp helper, record write/read | Low: the RPC returns the stamp; start/stop tests write the record |
| Packaging and manifest pins: package-publication 2, plugin pack 1, plugin toml 1, run-tests script text 1 (5) | A reminder that Herdr plugin stays private, versions in lockstep, hooks:install works, `npm pack` of plugin has no dist/ | Low-medium: `pnpm package:check`, `pi-package:check` and `herdr-plugin:check` (inside `pnpm check`) check the packed files and versions; the `private: true` flag is checked by npm itself at publish, nothing checks the lockstep of four versions |
| Contract type pins (2), transport capability-keys pin (1), json-lines encode (1), silent-peer control (1), runner machine-npm (1), truncation (1) (7) | Shape pins | No |

### RISKIEST DROPS
1. package-publication #1 (manifest pin, 1 test). Lost: nothing now checks that root, shepy-pi, herdr package.json and herdr-plugin.toml carry the same version, or that the Herdr plugin is `private`. A forgotten bump would publish mismatched packages. Dropped because decision 132 forbids source-text pins; a release script check would be the proper home.
2. observability-rpc #5 (stale, 1 test). Lost: the only end-to-end `agent.read` for Codex, OpenCode and Gemini at the RPC. The test already fails on HEAD, so nothing real is lost, but a rewritten version using native ids would restore RPC-level proof for Codex. The seat should decide fix or drop; the review's calendar explanation is wrong (reproduced: `discover()` returns null for `agentSession: null`).
3. operation-wait-service unit tests (8 dropped). Lost: unit-level proof that other-session and other-agent-session results never settle. The real-SQLite test keeps only the wrong-pane case. A change that stopped comparing the Herdr session or agent session would not fail. Kept one folded assert is advisable: add the session mismatch as a second case in operation-wait #1.
4. herdr-plugin-package #5 plus run-tests #17 (dup drops). Lost: `npm pack` check inside the suite; `herdr-plugin:check` stays in `pnpm check`, so a gate that runs only `pnpm test` would not catch a plugin with dist/ output.
5. Merged adapter Codex probes (#4 to #7 into #3). Lost: separate failure per case if the table loop is written with one expect; keep each case as a labelled row so a failure names the case.
All of ops (79 tests) could vanish if Ray removes dispatch/wait (row 5) and the transport (row 6); that is a larger cut than any drop above and makes items 3 and 5 moot.

### TOTALS
Own 181 tests, gate 29.3 s (sum of per-test ms, run 2). Keep 77, merge 66 (folded into keepers as rows or asserts), drop 38, trim 0. After: 77 tests, about 19.6 s, of which run-tests 9.1 s (two 3.5 s child-process tests and runVitest 1.0 s) and sqlite-migrations 3.3 s. Method: sum of the run-2 durations of kept tests; merged rows add under 0.1 s. Merging run-tests #6 and #7 into one child process would save about 3.5 s more.
Ops-tagged: 79 tests (10 files), gate about 6.5 s; keep 30 / merge 32 / drop 17 on merits; all 79 go if Ray removes the operations feature.
Failures seen: observability-rpc #5 (stale, both runs); herdr-plugin-package #5 (timeout under load, run 1 only); run-tests #18 (environment artifact: symlinked node_modules, not code).
