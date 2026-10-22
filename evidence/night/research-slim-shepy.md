# SLIM research (Shepy): which Shepy tests earn their place under decision 132

**Answer: keep 431 of the 1,285 tests, fold 443 more into them as table rows or extra asserts, drop 265, and 146 leave with SHEPYTRIM.** The summed test time falls from 244 s to about 116 s. The wall time of the suite is set by one file, `claude-hook.test.ts`, which alone takes 54 to 65 s of the 56 to 68 s total; after the cut it is about 23 s, so the suite should finish in roughly 25 to 30 s at the same load (estimated, not measured). Two findings are about tests that are wrong today: 35 demand tests can never pass, and 2 Codex tests assert a lookup the code removed on purpose.

Kind: research, read only. No test, source or gate changed; the only file I wrote besides this report is the appendix. Classified against Shepy main `7a7a3af` (this branch's base). Brief: `/Users/ray/dev/agent-factory/evidence/20261022-night/brief-SLIM-shepy.md`. Every test, with its reason: `evidence/night/research-slim-shepy-appendix.md` (1,328 lines).

## How this was done and what was not checked

- Two full runs of the suite on this commit through `scripts/run-tests.mjs` (its own runtime root and environment), started under `env -i` with CLAUDECODE and the two messaging variables unset, a fresh HOME and TMPDIR, Node 24.18.0, Vitest 4.1.9, machine load 17 to 19. Per-test durations come from the Vitest JSON reporter. Run 1: 1,285 tests, 1,245 pass, 40 fail, wall 67.7 s. Run 2: 1,247 pass, 38 fail, wall 55.5 s. The JSON of run 2 is in my scratch folder `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-slim-shepy/888b76f5-7724-48e8-b647-9dd0ab82b552/scratchpad` (`v2.json`, sha256 starts `5f29821cadf57e97`).
- The brief says about 1,210 tests. This commit registers 1,285 (parametrised rows count one each). The 35 "not run" in the reviews are not skipped here: they run and fail (below).
- For the runs only, I linked `node_modules` from `/Users/ray/dev/shepy-wt/socket-test-flake-20261020/node_modules` (the link SHEPYTRIM's brief also uses) and removed the link before committing. No install. That link causes one failure that is not code: `run-tests` "the entry is the locked vitest package inside this repository" (the Vitest entry resolves outside the repository). I count it as an environment artifact.
- Five readers (forks of this session, same model and same written rules) read the tests. Reading depth differs, and the appendix headers say so:
  - Every test body read: the claude hook cluster (8 files, 253 tests) and the agent index, history and context cluster (13 files, 138 tests).
  - Mostly titles, comments and sampled bodies: `outcome-context` (145 tests), `context-health-pi`, and the rest of the Pi and CLI cluster (14 files, 406 tests).
  - Read in full for the timing tests, fixtures and dedup sections; the remaining bodies classified from titles and file structure: `profile-delivery`, `profile-subscribe`, `profile-diagnose`, `profile-isolation`, `profile-operation-resolution`, the scope store, and the demand files (18 files, 307 tests).
  - Daemon, Herdr client, config, operations, packaging and runner cluster (25 files, 181 tests): the reader's section does not state how deep the reading went, and I did not re-read it.
  - I spot-checked only the findings below myself. I did not run any test with its guard removed to see it fail, so "drop" means the behaviour has another named guard or no user, not that I proved the guard catches a mutant.
- "Merge" counts tests folded into a named keeper. If the folded case is written as a `test.each` row it still registers as a test in Vitest, so the registered count after the cut is between 431 and 874. Most merges are rows of loops that already exist (for example `outcome-context` 145 tests become 25 keepers plus table rows).

## Findings before any test is dropped

1. **35 tests can never pass.** `claude-profile-demand-validation.test.ts` pins SHA-256 hashes of seven files (`claude-hook.ts`, `shepy.ts`, two test files, `README.md`, `profile-demand-ingress.ts`) and fails with "fixture source pairing mismatch" the moment any of them changes. The pinned `claude-hook.ts` hash `08aeb882…` differs from the file's hash today (`2a1f86d9…`). 4 of its 39 tests pass (path guards). The whole file is demand, so it goes with SHEPYTRIM, and so do the `SHEPY_DEMAND_FIXTURE_*` lines in `scripts/run-tests.mjs`.
2. **Two Codex tests are stale, not calendar rot.** `agent-history-readers` "CodexHistoryReader is registered in the default agent history service" and `observability-rpc` "reads additional runtime histories through agent.read" fail in both runs. Both look up Codex history by working directory with no session identity. `src/agent-history/discovery.ts` resolves Codex only through a session id (commit `2a0bade`; README: "Without a native session identity, history is empty"). The review `rev-s5` guessed the 2026-07-09 fixture date; that is not the cause. I did not re-run with a changed date. Fix or drop; the readers drop the first, and the second needs a decision (below).
3. **The suite's critical path is one file.** `claude-hook.test.ts` (4,642 lines, 178 tests, 54 to 65 s) runs its tests one after another and sets the wall time. 675 to 721 of the 1,285 tests take under 10 ms; 49 take over 1 s.
4. **Two "defers" tests check nothing.** `claude-hook` #76 and #77 are titled as deferral to pending but assert that nothing is deferred. The deferral code exists for demand rows.
5. **The wall-clock class is mostly "sleep, then assert nothing happened".** Those can pass for the wrong reason under load (a false green), which is worse than a flake. The one real red in my runs is `notice-correctness.test.ts:358`: a flush path must finish under 450 ms against a 500 ms production wait, and took 480.9 ms in run 1 at load 17. `herdr-plugin-package` "packages the runtime entrypoint without build output" timed out at 8.5 s in run 1 and passed in run 2 (a 5 s default test timeout, not a sub-1 s bound).

## 1. What Shepy does for its users, and the tests that guard it

| # | Behaviour in plain words | Best guards (file > test) |
|---|---|---|
| 1 | A Claude seat pane that owns a profile sees a finished worker's outcome at the next prompt and at Stop, once, bounded, marked untrusted. The hook never breaks Claude: exit 0 and silence on daemon down, bad input or missing Herdr variables, and the operator is told when a pane is deaf. | claude-hook > #39, #59, #72, #74, #78, #87, #91, #51, #94 |
| 2 | No outcome is marked seen unless the model was shown it, across crashes, failures and racing hooks. A pane that is not the owner learns why and nothing is stolen. Handover (SessionEnd, `profile release`) passes notices on once. | claude-hook > #66, #68, #71, #99, #102, #103, #48, #54, #167, #176, #153 |
| 3 | An idle Claude seat is nudged through its own messaging socket: one bounded line, other panes' outcomes only, only the socket it registered, never retried when ambiguous. | claude-hook > #1, #4, #6, #15, #21, #25, #33, #36; claude-socket-identity > #1, #5 |
| 4 | A Pi seat owning a profile gets one wake per leased batch naming the exact worker event, and acknowledges only after a successful turn. A failed or racing delivery never loses or doubles an outcome. | shepy-pi-extension > "pump leases obligations, delivers ONE wake, acks after successful settle", "failed TRIGGER enqueue nacks…", "overlapping pump ticks… cannot double-lease"; shepy-pi-profile-renew > "two overlapping renewed:false continuations recover exactly once" |
| 5 | A worker's completion reaches the owning seat once with that worker's own final text; an old or missing text is never swapped for the previous turn. | notice-correctness > "one real delayed re-read repairs missing text…", "a new turn during the retry cannot be attached…"; profile-delivery > "live incident shape: same assistant ref…" |
| 6 | An agent kind with no history reader carries a marked, bounded screen tail, never an "assistant" answer, and a hung read still sends the notice. | screen-text-notice > "a reader-less kind finishes…", "a read that never answers is cut at the deadline…"; screen-text > "a 5 MB screen is bounded…" |
| 7 | A seat subscribes a worker and receives outcomes only from that worker's bound session; a replacement or foreign session is refused; a worker's pane move or exit gives exactly one "gone". | profile-subscribe > "pending before detection, first bind while working, then replacement refused after restart"; agent-lifecycle > "one gone after close", "move preserves subscription", "old name never follows a new terminal" |
| 8 | Only the current owner can lease or acknowledge; unacknowledged notices survive a daemon restart and arrive once per lease; the token never leaks. | profile-delivery > "claim, renew and inbox.lease flip together at exactly lease + grace", "unacked obligations survive restart…", "the full attack: both halves reconstructed from public RPC…" |
| 9 | `shepy agent list/get/read` shows the right transcript: the exact session id wins, a neighbour in the same directory never does, no identity means empty history. Context fullness is right for Codex, Pi and Claude, and unavailable never shows as 0 percent. | agent-history-discovery > "ID lookup selects the exact session"; agent-history-identity > "poisoned hints… are rejected"; outcome-context > "Pi: newest per-call prompt occupancy…"; context-health-claude > #1, #4, #9, #11, #13 |
| 10 | The operator can see why a seat is not receiving (`profile diagnose`), who owns a profile, retire a backlog and read one notice back; the CLI `--json` is verbatim, screen text is labelled, control bytes never reach the terminal. | profile-diagnose > (a), (d), (e), (h), (i); cli > "inbox get marks a screen excerpt", "inbox get strips control bytes…" |
| 11 | The daemon starts, stops and reports status without removing a live socket or starting a second daemon; an upgraded database keeps owners, tokens, subscriptions and its obligation rows; Herdr is spoken to over a persistent socket that survives a silent peer. | daemon-process-manager > status, "refuses to remove a reachable daemon socket"; sqlite-migrations > the five upgrade tests; herdr-socket-client > all seven |
| 12 | A bare-workspace Pi owner (`/shepy on`) is told of worker outcomes after a 500 ms batch and keeps ownership across brief disconnects and pane moves (no factory caller; SHEPYTRIM plan row 7: keep). | shepy-pi-extension > "wakes once at 500 ms…"; orchestrator-disconnect-grace; orchestrator-pane-move |
| 13 | (ops, Ray may remove) `operation dispatch` and `operation wait`: a prompt goes to exactly one resolved pane, an uncertain send is never retried, only a fully correlated result settles. | daemon-dispatch-rpc > dispatch; operation-wait-rpc; operation-wait; operations-store > "uncertain submission", "settles exactly once" |
| 14 | (demand, goes with SHEPYTRIM) Factory "demand" notices. 0 rows ever, no publisher in any repository. | none kept |

## 2. Classification counts

Gate seconds are each file's own tests in run 2 (summed over tests, not wall time); units with 0 take under 0.05 s. Per-file counts for all 78 files are in the appendix headers.

| file | tests | gate s | keep | merge | drop | trim |
|---|--:|--:|--:|--:|--:|--:|
| integration/claude-hook.test.ts | 178 | 54.1 | 55 | 35 | 41 | 47 |
| unit/outcome-context.test.ts | 145 | 0 | 25 | 52 | 68 | 0 |
| integration/profile-delivery.test.ts | 81 | 18.1 | 30 | 45 | 6 | 0 |
| unit/shepy-pi-extension.test.ts | 71 | 4.7 | 36 | 24 | 11 | 0 |
| unit/cli.test.ts | 66 | 0 | 21 | 21 | 20 | 4 |
| integration/claude-profile-demand-validation.test.ts | 39 | 4.5 | 0 | 0 | 0 | 39 |
| integration/profile-subscribe.test.ts | 34 | 18.0 | 14 | 18 | 2 | 0 |
| unit/cli-census.test.ts | 32 | 0 | 1 | 29 | 0 | 2 |
| integration/agent-lifecycle.test.ts | 30 | 11.6 | 15 | 10 | 5 | 0 |
| integration/notice-correctness.test.ts | 27 | 18.8 | 13 | 12 | 2 | 0 |
| unit/demand-eligibility-promise-breach.test.ts | 26 | 5.9 | 0 | 0 | 0 | 26 |
| unit/context-health-pi.test.ts | 23 | 0 | 6 | 8 | 9 | 0 |
| unit/herdr-orchestration-transport-adapter.test.ts | 19 | 0 | 7 | 8 | 4 | 0 |
| unit/run-tests.test.ts | 19 | 9.8 | 7 | 10 | 2 | 0 |
| unit/context-health-claude.test.ts | 18 | 0 | 5 | 10 | 3 | 0 |
| unit/screen-text.test.ts | 18 | 0 | 6 | 11 | 1 | 0 |
| unit/shepy-pi-wake.test.ts | 18 | 0 | 7 | 7 | 0 | 4 |
| unit/agent-history-readers.test.ts | 16 | 0.9 | 10 | 5 | 1 | 0 |
| integration/profile-diagnose.test.ts | 15 | 6.4 | 6 | 9 | 0 | 0 |
| unit/agent-history-service.test.ts | 15 | 1.3 | 4 | 3 | 8 | 0 |
| unit/hermes-reader.test.ts | 15 | 1.8 | 6 | 8 | 1 | 0 |
| unit/profile-selectors.test.ts | 15 | 0 | 4 | 7 | 4 | 0 |
| other 56 files | 365 | 88.2 | 153 | 111 | 77 | 24 |
| **total 78** | **1,285** | **244.1** | **431** | **443** | **265** | **146** |

Trim (146) is: 87 in the five whole demand files (`profile-demand` 8, `claude-profile-demand-validation` 39, `demand-eligibility-promise-breach` 26, `profile-demand-ingress` 13, `profile-demand-cli` 1), 48 demand cases inside `claude-hook.test.ts` and the lapsed-recovery warning test, and 11 in `shepy-pi-wake`, `shepy-pi-profile-renew`, `cli` and `cli-census`. SHEPYTRIM's flag test replaces `cli` 63 to 66.

Ops-tagged (the operations feature and Herdr orchestration transport, SHEPYTRIM plan rows 5 and 6, still an open question for Ray): 82 tests in 11 files, classified on their merits (keep 30, merge 32, drop 17 in the 79 of cluster 5, plus 3 in `profile-operation-resolution`). All 82 leave if Ray removes dispatch and wait.

## 3. What each drop group loses

| drop group (tests) | protection lost | can a likely regression slip through? |
|---|---|---|
| Demand: 146 trim tests | Admission, ledger and delivery rules for demand notices | No: no publisher anywhere, 0 rows, 35 already red. Reverses the 2026-10-08 build decision (row 15.216), as SHEPYTRIM already does |
| `outcome-context` spelling twins: about 68 dropped, 52 folded as rows (the 12+8+6+6 calendar spellings, renderer twins, unusable-window spellings) | Each malformed date, percentage or window spelling has no test of its own | Low: one shared validation function and a byte-for-byte renderer check stay; the context line is advisory |
| claude-hook socket wake timing and replacement cells: about 20 + 6 in socket-identity | Each individual race (timer, connect, post-connect) and replacement kind (gone, file, symlink) | Low: one fence rule per class stays. The window between identity check and connect no longer has its own test |
| claude-hook Herdr answer shapes (6), owner-file internals (10), warning wording duplicates (6), formatter cells (4) | Each malformed pane list, old file layout, wording repeat | Low: one error and one timeout stay; the behaviours stay in named keepers |
| Review-round and "P"-numbered variants (profile-delivery 8, profile-subscribe 3, notice-correctness 9, cli "CORRECTION" repeats) | Nothing new | No |
| Scope-store class tests (6) | Direct tests of cursor and ownership rules in the Pi owner store | Low: service and server tests cover every public path |
| agent-history-service mock call-count checks (7) + formatter-version pin (1) | A change that makes every refresh rediscover or reread (CPU and disk) goes unnoticed | Low for results, yes for performance only |
| Config schema (4), json-lines, contract type pins (7 shape pins in cluster 5) | Direct shape assertions | No: the same schemas run in their consumers |
| Packaging and manifest pins (5: `package-publication` 2, plugin pack 1, plugin toml 1, run-tests script text 1) | A reminder that the Herdr plugin stays private and four package versions stay in step | Low to medium: `pnpm check` checks packed files; nothing else checks version lockstep |
| `run-tests.test.ts` 19 tests of the test runner (keep 7, merge 10, drop 2; two child-process tests take 3.5 s each) | Machine-specific runner paths | No for users; a runner that leaks the caller's credentials into tests would be caught by the kept environment test |
| Stale (3): the two Codex cwd tests and `claude-hook` #76/#77 | Nothing: they check removed or non-existing behaviour | No |

## 4. Target counts and time

| | now | after |
|---|--:|--:|
| tests (registered) | 1,285 | 431 test blocks; 431 to 874 registered, depending on how many folded cases stay as table rows |
| trim (leaves with SHEPYTRIM) | 146 | 0 |
| summed test time (run 2, load 17) | 244.1 s | about 115.8 s |
| suite wall time (runs 1 and 2) | 67.7 s and 55.5 s | about 25 to 30 s, not measured: `claude-hook.test.ts` falls from 54.1 s to about 22.6 s and sets the floor |

Method for the seconds: sum of each kept test's duration in run 2, plus 30 percent of a merged test's duration in clusters that counted it (the others count merged rows as 0, under 0.1 s each); file imports and database setup are not counted. Per cluster: claude hook 65.4 s to 27.0 s, profile and notice 104.7 s to 43.5 s (of which 16.3 s is demand), Pi and CLI 7.5 s to 2.1 s, agent history 37.1 s to 23.6 s, daemon and runner 29.3 s to 19.6 s.

Where the seconds are after the cut: the five slowest remaining claude-hook tests are real-process or real-socket tests (3.0, 2.9, 2.5, 2.0 s); `run-tests` still spends 9.1 s, mostly two child-process tests (merging them into one process saves about 3.5 s); `sqlite-migrations` 3.3 s. The Pi and CLI files are 3 percent of the time; their gain is count and fewer lines, not minutes.

## 5. Wall-clock bounds under 1 s (the flaky class)

"Failed" means it failed in my two runs. All other entries are time-sensitive but green at load 17 to 19; `rev-s5` saw several red at load 24 to 28.

| file:line | bound | what it does | class | failed |
|---|---|---|---|---|
| notice-correctness:358 | under 450 ms | slow pane's flush path against a 500 ms production wait (50 ms headroom) | keep (test 8) | yes, run 1: 480.9 ms |
| notice-correctness:252, :357, :380, :410-429, :673-693, :723-725, :763-765 | under 350 or 400 ms | fast pane or fresh text must not wait for the retry | 3, 8, 11, 12, 23 keep; 25, 27 drop (timing) | no (rev-s5 saw 23, 25, 26 red) |
| notice-correctness:740-754 | sleep 300 ms, then under 1,000 ms | five missing finals share one wait | keep (26) | no |
| notice-correctness:336, :351, :446, :466, :558 | sleeps 300 and 60 ms | "give it time" for a producer flush or a retry to start | mixed | no |
| screen-text-notice:275 | under 1,000 ms | quick pane not held by a hung read; line 276 already asserts the order | keep, remove the clock | no |
| unit/screen-text:39 | under 500 ms | CPU time to bound a 5 MB string (normally 1 ms) | keep, remove the clock | no |
| claude-hook:114 (`settleSocketWake`, 13 call sites) | sleep 30 ms | "give the wake time", then assert no frame was posted; can pass vacuously under load | 8 keep, rest merge or drop | no |
| claude-hook (11 sites) and socket-identity (:216, :249, :291) | `vi.waitFor` default 1,000 ms | wait for socket frames; exactly 1 s | keep | no |
| claude-socket-identity:168 (4 call sites) | sleep 60 ms | the same "sleep then assert no frames" | keep/drop | no |
| claude-hook:92 | `batchDelayMs: 1` | production batch timer shortened so two schedules land in one batch | keep (#2) | no |
| claude-hook:4240-4263, :4407 | under 2,000 ms | silent Herdr peer must end within 2 s of a 1 s deadline (measured 1,274 ms) | keep | no |
| owner-file:255-268 and claude-hook :2970, :3238 | waits the real 500 ms lock budget | the hook gives up after the budget | merge/keep | no |
| herdr-socket-client:223, :239-251, :272-284 | 100 ms; server answers at 300 ms against a 200 ms client timer, wait 400 ms | ordering of timers; 100 ms margins | keep #5, #6; merge the second 300 ms case into #6 | no |
| herdr-socket-client-silent-peer:85, :101, :134, :150 | 50 ms sleep; deadlines 1,000 ms and 500 ms; 30 ms | give a write time; end within the deadline | keep 2, merge 1, drop 1 | no |
| agent-lifecycle:283 | sleep 30 ms against a 500 ms production retry | give the index time before the pane closes; a stall of about 470 ms flips the result | keep | no (958 ms under load) |
| agent-lifecycle:784, :825 | sleeps 100 ms | wait to confirm no third event, or that one 80 ms rescan failed; can pass vacuously | keep | no |
| agent-context-service:324 | 1 ms | a re-written snapshot's `updatedAt` must be strictly later | keep | no |
| herdr-session-watch-manager helper `waitFor` | polls 10 ms, deadline 1,000 ms | wait for a reconnect or handled event | keep (9, 10) | no |
| orchestrator-disconnect-grace:264, orchestrator-pane-move:306 | sleep 20 ms | "give it time" before a negative assert | keep | no |
| integration/rpc-test-client:57 | 100 polls of 2 ms (about 0.2 s nominal) | `waitForNotification` deadline, counts attempts so it drifts under load | helper | no |
| shepy-pi-extension:2114-2622 (about 20 sites) | sleeps 10 and 30 ms | wait for the claim pump to lease, enqueue and ack before asserting; suggested fix: wait on the recorded calls | 52, 53, 54, 55, 57-62, 64 | no (one body took 3.4 s from a load stall) |
| shepy-pi-daemon-client | retry 5 ms; poll 5 ms to a 1,000 ms deadline; sleep 10 ms (:160) | reconnect ordering | keep | no |
| operations-store:196, :225 | sleep 5 ms | make `updatedAt` strictly later (clock resolution) | drop (ops) | no |

Fake-timer uses are not listed (not flaky): `claude-messaging-socket` (1,000 ms virtual), about 30 `shepy-pi-extension` tests, all 12 `shepy-pi-profile-renew`, `orchestrator-disconnect-grace` (`ManualScheduler`), `profile-delivery`/`profile-diagnose` injected clocks, `herdr-session-watch-manager` tests 2 to 5, 7, 8. `claude-hook` also writes `console.info("S4 fixture …")` timing lines at :4244, :4411 and :4531 that assert nothing.

The pattern to keep from this list: replace elapsed-time upper bounds with an order assertion (the fast pane's notice exists before the slow pane's retry may finish; `screen-text-notice:276` already does this), and replace "sleep N ms then assert nothing" with a wait on the recorded calls. Lower bounds ("the retry really waited 450 ms") cannot flake, only run slow, and can stay.

## 6. The ten riskiest drops for Ray

1. **Scope-store tests, `agent-orchestrator-scope-store` 1 to 6 (drop).** The only direct tests of cursor and ownership rules for the Pi workspace owner. A store change that stops supplying a cursor could make a Pi owner miss or replay events while the one-session service tests stay green. Dropped because every public path is tested.
2. **Socket-replacement cells, claude-hook #23 to #28, #30 to #32 and socket-identity #2, #3, #4, #6, #8, #10 (drop).** A swapped socket is the one place a messaging token could reach another process. Kept: symlink before timer, owner replacement fence, identity before timer and after connect. The window between identity check and connect has no test of its own after the cut.
3. **Unresolved identity cells, claude-hook #9, #11, #12, #13 (drop or merge).** If a lookup fails at Stop, a stale socket could stay on the record and the pane could be woken about its own outcome. #10 and #14 cover the prompt and the Stop ambiguity; if the clearing code is ever split by hook type, add the Stop cells back.
4. **Identity-precedence rows, profile-subscribe 7, 14, 15, 16 (merge into 13).** They decide whose text a seat sees when Pi, Herdr and the cache disagree. If the fold keeps only one row, three cases are lost and a seat could see another worker's text.
5. **Superseded-token variants, profile-delivery 38, 39 (merge into 37) and 55, 60 (into 59).** Test 39 states a design rule: a superseded token still acknowledges exactly the rows its own lease stamped. Without it as an assert, a takeover could double-deliver.
6. **Stop recovery races, claude-hook #63 and #65 (drop).** Rival wins the recovery, or the compare-and-swap is contested mid-recovery. A wrong recovery shows outcomes in two panes. #99 (two real processes) and #62 stay.
7. **Renewal and duplicate-wake variants, shepy-pi-profile-renew 6 and 10, shepy-pi-extension 56 (drop).** Two exact orderings of a late `renewed:false`, and the delivered-RPC failure after a queued trigger. A regression could strand a batch or duplicate a wake; 7, 3, 55 and 52 keep the rules.
8. **Move rollback, agent-lifecycle 17 (drop).** A failed batch move that rolls back; a half-applied move could leave subscriptions on the wrong pane and send a later "gone" to the wrong seat. #22 guards the same commit-together path for "gone". If Ray wants one rollback test for moves, keep 17 instead of 22.
9. **Package manifest pin, package-publication #1 (drop).** Nothing then checks that the root, shepy-pi and Herdr plugin packages carry the same version, or that the plugin stays `private`. A forgotten bump would publish mismatched packages. Decision 132 forbids source-text pins; a release-script check is the proper home. (Not verified: whether `package:check` already compares versions.)
10. **Operations unit tests and the stale RPC read, operation-wait-service (8 dropped) and observability-rpc #5.** The real-SQLite test keeps only the wrong-pane case, so a change that stops comparing the Herdr session or agent session would not fail; the reader advises one extra assert in `operation-wait` #1. Observability-rpc #5 is the only end-to-end `agent.read` for Codex, OpenCode and Gemini over RPC; it is stale today. All of this is moot if Ray removes the operations feature, and a rewritten #5 using native ids would restore the Codex proof.

## 7. Limits

- The classification rests on reading, not on mutants (see "How this was done"). A drop is safe only as far as the named guard is real.
- Reading depth differs by cluster. The weakest are `outcome-context` and `context-health-pi` (titles and sampled bodies) and the unread bodies in the profile cluster. Treat their numbers as plus or minus 10 percent.
- The after-times are sums of per-test durations from one loaded run. Wall time after the cut is an estimate from the biggest file; it is not measured.
- The 56 files folded into one table row are in the appendix with their own counts.

## Noticed beyond my task

- **Stale source pins break every README edit.** `claude-profile-demand-validation` pins `README.md` and two source files, so the 35 tests fail on every ordinary change. SHEPYTRIM removes them; until it lands, `pnpm test` is never green. Owner: SHEPYTRIM builder.
- **`run-tests.test.ts` fails when `node_modules` is a symlink.** "the entry is the locked vitest package inside this repository" rejects a Vitest entry outside the repository, but the factory's worktrees all link `node_modules` from another worktree (for example `main-land`). Whether that makes it fail in the gate is not checked. Owner: seat.
- **The Codex test fixtures were never updated when Codex lookup changed to session ids.** Two stale tests have been red for several reviews and each review rediscovered them. Owner: seat, one fix or drop.

## Open for you

1. Decide the operations feature now (SHEPYTRIM plan rows 5 and 6): if dispatch and wait are removed, 82 more tests leave and risk 10's operations half disappears. Recommended: decide before the slimming build, so the build does not trim and then delete the same tests.
2. Choose how far to cut. Recommended: keep 431 plus the folded rows, then add back the ten items above only where a named guard is missing (the seat can choose items 1, 3, 4, 5 first). The middle option is to cut only demand and stale tests first (146 trim plus 3 stale, about 150 tests, no judgement needed) and slim the rest in a second pass, folder by folder, largest first as decision 132 says.
3. Order of work. Recommended: first cut the demand tests with SHEPYTRIM; second, slim `claude-hook.test.ts` (it sets the wall time); third, replace the elapsed-time bounds in `notice-correctness` and `screen-text-notice`.

