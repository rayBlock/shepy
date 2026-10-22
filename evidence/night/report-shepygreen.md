# SHEPYGREEN

**PARTIAL.** The three named causes are fixed in tests only, and all 52 focused tests pass. Three consecutive green full suites were not reached under machine load. After two normal commit attempts were refused, the seat explicitly authorized `git commit --no-verify` to skip the pre-commit full suite. This permission is not acceptance, a green-suite claim or a main landing.

Candidate: `night/shepygreen`, base `7aa8adbed8d9231f9e3c4547cd14893e51450ccf`; three test files, no production changes. Frozen test patch SHA-256: `cb6e9b7eac5f911286d878769fc69bd30c540d62821f4b5f3cf462ef4ecc320a`.

## Acceptance block (recorded before coding)
- Find both Codex causes before changing tests or production.
- Replace the notice wall-clock bound with a load-safe measure preserving concurrency and delayed re-read coverage. Do not raise timeouts or delete behaviour coverage.
- Keep changes in tests unless evidence demands a production fix.
- Require three consecutive green full suites under `lockf -k /private/tmp/shepy-full-suite.lock`, `env -i`, fresh mode-0700 HOME and TMPDIR, including a run at load above 15.
- TypeScript and Biome clean; run the project check; commit in the assigned worktree with normal hooks.
- Independent acceptance is not assigned in this builder brief; the seat must arrange review before landing.

## Causes and changes
1. `agent-history-readers.test.ts`: the registration fixture supplied no native identity and its Codex `session_meta` omitted `payload.id`. Current `discoverAgentHistory` deliberately refuses cwd-only discovery; `CodexHistoryReader` also verifies the header against an ID-bound read. Added the native ID to both producer-shaped fixture and lookup, with a negative no-ID control. Not Codex format drift or a production defect.
2. `observability-rpc.test.ts`: the same obsolete cwd-discovery assumption in its indexed Codex worker and header. Added an exact-ID public RPC positive and a no-ID negative. Once that first assertion passed, the previously unreachable Gemini assertion exposed the same missing session identity; its fixture and indexed worker now carry matching native IDs too. OpenCode's no-ID refusal remains unchanged.
3. `notice-correctness.test.ts`: the 300 ms producer timer plus filesystem work was required to finish before 450 ms, and the fast pane before 350 ms. These measure scheduler latency, not queue independence. The test now retains the real settle sleep but gates its continuation until the independent producer flush and fast outcome complete. It then asserts ordered fast and repaired slow notices and exactly one retry.
4. The same file's startup and fresh-history assertions now check zero retry sleeps instead of sub-400 ms elapsed time. Watch and snapshot tests retain their explicit publication-order assertions; the five-pane test requires all five real waits to enter before any is released, so serial waits cannot pass. A focused intermediate run independently exposed the startup bound at 680 ms. No tests deleted and no timeout increased. Other real-delay tests still guard the settle duration.

## Proof and retained failures
Private scratch, including all failed attempts, attack sources and raw cost logs: `/private/tmp/shgreen.mpGofh`.
All gates used `env -i`, fresh private HOME and TMPDIR, with CLAUDECODE and both messaging variables absent. Dependencies were copied locally from an identical-lockfile worktree; no dependency installation was requested. The first wrongly resolved pnpm shim bootstrapped a package-manager copy into the throwaway HOME and attempted automatic dependency repair, which failed before tests; subsequent gates used the existing correct binary and disabled that repair and package-manager switching.

Node 24.18.0, pnpm 11.9.0, Vitest 4.1.9, TypeScript 6.0.3, Biome 2.5.1 from the existing local tools and locked dependencies.

| Check | Result | Wall time |
| --- | --- | --- |
| Baseline named files | 2 Codex failures; 50 passed | 19 s |
| Final named files | 52 passed | 20 s |
| TypeScript; Biome check; format | exit 0 each | 9 s; 1 s; 1 s |
| DB; root package including build; Pi package; Herdr plugin | exit 0 each | 2 s; 13 s; 6 s; 2 s |
| Full `pnpm check`, start load 47.02 | 1136 passed, 7 failed | 111 s |
| Full suite, four workers, start load 26.71 | 1137 passed, 6 failed | 81 s |
| Full suite, one worker, start load 19.23 | 1141 passed, 2 failed | 189 s |
| Later default `pnpm check`, start load 12.22 | 1142 passed, 1 failed | 50 s |
| First normal pre-commit hook | 1142 passed, 1 failed; commit refused | 65 s |
| Final normal pre-commit hook | 1129 passed, 14 failed; commit refused | 97 s |

The final two one-worker failures were untouched Claude wake-restart and subscription CLI-cost tests exceeding 5000 ms; the same two passed together in 3 s as a discriminating control, not an erasure of the full-run reds. The later default run failed only the untouched Herdr-plugin `npm pack` test at its 5000 ms timeout. The first normal commit was refused by another 5000 ms timeout, the untouched expired-owner socket-symlink case; that case subsequently passed alone (782 ms test body). Earlier runs also hit other 5000 ms timeouts and the screen-read test's 4500 ms wall bound. The final normal commit attempt hit 14 separate 5000 ms timeouts across 13 files, including the notice watch and five-pane cases. Thus the timing problem also affects the changed tests at the suite's overall timeout, not just untouched tests. I did not weaken these guards or claim their production cause proved. The requested green-suite acceptance remains open.

Four scratch-only mutants were rejected: moving the retry inside the session queue, serializing snapshot waits, discarding the repaired reread, and restoring cwd-only discovery. No attack code entered the candidate. Final focused log SHA-256: `86a7733a47a3063b9152529502308d8c036ca56e367f7e1883163b04076ca896`. Last default full-run log SHA-256: `f4522b69db62032be216524eb5c0781b4fb8c890c1b0a9b6e5613ff0098ced30`.

## Cost, limits and next owner
`/usr/bin/time -l` measured the full-suite command and waited-for children: four-worker user/system CPU 19.48/10.46 s, maximum RSS 319,897,600 bytes; one-worker 19.02/9.29 s and 293,781,504 bytes; later default 23.15/11.76 s and 675,512,320 bytes. RSS is the command-tree reported maximum, not summed concurrent memory. Post-run regular-file totals for the first three private runtimes were 3,762,199, 2,399,595 and 2,399,619 bytes; no retained SQLite sidecars. This is retained disk, not peak disk. Repeated-history scaling is not changed by these test fixes. Input, cache-write, cache-read, output and summary token counts are null: the harness exposes no usage receipt here.

Next owner: the Shepy seat should independently review the test fixes and assign the remaining full-suite timing failures to a later row. Neither original normal commit attempt created a commit. No live daemon, profile or agent state was touched; no messages, push, merge or rebase. Normal commit-hook output is retained as `commit.log` in scratch, with the final normal attempt in `commit-2.log` (SHA-256 `3e868ffe6c73416789c654633f490f94512dbab658beaabc1847de98255c4496`).

## Seat-authorized commit exception
The seat explicitly approved `--no-verify` for both the test-fix commit and this report's follow-up catalog commit, allowing the pre-commit full suite to be skipped because it classifies the remaining reds as under-load 5000 ms timeouts in untouched tests rather than failures of the three repaired causes. Untouched failures include Claude wake and handover, lifecycle, identity persistence, subscription, profile delivery and isolation, dispatch and wait RPC, Hermes and OpenCode readers, and Herdr-plugin packaging. The screen-read case additionally failed a 4500 ms wall bound, not a 5000 ms timeout.

Evidence qualification: "not your files" is not literally true for every timeout. Four timeout cases occur in the edited `notice-correctness.test.ts`; the watch-stream and five-pane cases also have edited test bodies. The other two cases in that file have unchanged bodies. These failures remain recorded, not attributed conclusively to machine load or waived as green. The seat's permission changes only the commit gate; the three-consecutive-green requirement remains unmet. The full per-test catalog below is added in the separate report-only commit.

## Noticed beyond my task
The untouched packaging, Claude wake, lifecycle, subscription and screen-read tests can still fail under this host's scheduling conditions, even after the two always-red Codex cases are repaired. Their timed full-run evidence above belongs to the Shepy seat; isolated greens do not settle them.

## Full-run timeout and wall-clock catalog for a later row

This catalogs every failed test timeout or wall-clock assertion in all six full runs: 31 failure instances across 30 distinct tests. It excludes intentionally exercised timeout paths in passing tests and scratch-only mutants. All locations and exact test titles below come from the retained Vitest failure blocks, not inferred from the file-level summary. Test-fix commit: `9583898`.

**Load precision:** load at the exact failing test instant is **null**, because the full-run logs do not timestamp individual failure blocks. The measured local-time start and end observations below are the available contemporaneous load evidence for every test in that run; start and end values are not claimed to be minima or maxima. Each tuple is the one-minute, five-minute and fifteen-minute load average, respectively. Run 4 also has five-second samples; its sampled one-minute load ranged from 9.70 to 14.77, but no sample can be paired exactly with its failing test. All dates are 2026-10-22.

| Run and raw log | Command | Observed start time and load | Observed end time and load |
| --- | --- | --- | --- |
| R1: `check-1.log` | `pnpm check` | 16:38: (47.02 28.52 20.44) | 16:39: (21.52 26.25 20.62) |
| R2: `full-4w-1.log` | `pnpm test --maxWorkers=4` | 16:40: (26.71 26.82 21.11) | 16:42: (19.37 24.29 20.65) |
| R3: `full-1w-1.log` | `pnpm test --maxWorkers=1` | 16:42: (19.23 24.10 20.62) | 16:45: (10.19 17.37 18.46) |
| R4: `final-check-1.log` | `pnpm check` | 16:47: (12.22 15.56 17.58) | 16:48: (9.70 14.54 17.10) |
| R5: `commit.log` | `first normal pre-commit full suite` | 16:52: (9.93 12.99 15.77) | 16:53: (14.98 13.96 15.95) |
| R6: `commit-2.log` | `second normal pre-commit full suite` | 16:56: (10.43 12.57 15.11) | 16:57: (11.79 12.67 14.90) |

For each case, use its run's measured load window above; do not substitute an invented instantaneous load. `Untouched file` means none of this candidate's changes affect that file. `Edited file, unchanged body` distinguishes the two untouched test bodies inside the notice file from the two edited bodies. No production file changed.

### R1 cases

- `test/integration/agent-lifecycle.test.ts:518:3` — **Untouched file**. `subscribed worker lifecycle > automatic prune refuses unknown identity and missing terminal metadata; explicit prune is unchanged`. Failure: 5000 ms test timeout. Load: R1 window above; exact test-time load null.
- `test/integration/agent-store-terminal-identity.test.ts:264:3` — **Untouched file**. `AgentStore terminal identity > persists terminal identity for new events and maps migrated events as null`. Failure: 5000 ms test timeout. Load: R1 window above; exact test-time load null.
- `test/integration/claude-hook.test.ts:345:4` — **Untouched file**. `Claude socket wake through the real hook claim > UserPromptSubmit claim with empty identity cannot self-wake after later named-session projection`. Failure: 5000 ms test timeout. Load: R1 window above; exact test-time load null.
- `test/integration/claude-hook.test.ts:3810:3` — **Untouched file**. `Claude profile handover > two prompt claimants race after release: one owner and one delivery`. Failure: 5000 ms test timeout. Load: R1 window above; exact test-time load null.
- `test/integration/notice-correctness.test.ts:451:1` — **Edited file, unchanged body**. `previous settled text is re-read even if the next user record has not flushed`. Failure: 5000 ms test timeout. Load: R1 window above; exact test-time load null.
- `test/integration/profile-subscribe.test.ts:612:3` — **Untouched file**. `pane subscription through CLI, daemon, Herdr socket and durable store > real indexed working-to-done events deliver only the bound session`. Failure: 5000 ms test timeout. Load: R1 window above; exact test-time load null.
- `test/integration/screen-text-notice.test.ts:262:19` — **Untouched file**. `a read that never answers is cut at the deadline and the notice still goes`. Failure: 4500 ms upper wall-clock bound; observed 4887.587666999998 ms. Load: R1 window above; exact test-time load null.

### R2 cases

- `test/integration/agent-history-identity.test.ts:171:1` — **Untouched file**. `poisoned hints stamped with the requested id are rejected`. Failure: 5000 ms test timeout. Load: R2 window above; exact test-time load null.
- `test/integration/agent-lifecycle.test.ts:838:3` — **Untouched file**. `watcher lifecycle over the Herdr socket > P4 a subscribed shell can wait past the age gate and later deliver its first done`. Failure: 5000 ms test timeout. Load: R2 window above; exact test-time load null.
- `test/integration/claude-hook.test.ts:1153:3` — **Untouched file**. `claude-hook UserPromptSubmit > hostile snapshot identity cannot forge outcome lines`. Failure: 5000 ms test timeout. Load: R2 window above; exact test-time load null.
- `test/integration/claude-hook.test.ts:3474:4` — **Untouched file**. `Claude profile handover > public source CLI handover boundary: borrowed-record`. Failure: 5000 ms test timeout. Load: R2 window above; exact test-time load null.
- `test/integration/notice-correctness.test.ts:513:2` — **Edited file, unchanged body**. `status and event roll back together after append failure on snapshot, then restart recovers`. Failure: 5000 ms test timeout. Load: R2 window above; exact test-time load null.
- `test/integration/profile-delivery.test.ts:3144:3` — **Untouched file**. `selector ambiguity is fail-closed on BOTH paths (§7, §6.1.3) > the reviewer's case: two identical workers + runtimeKindPlusCwd — inspection says ambiguous, delivery projects NOTHING`. Failure: 5000 ms test timeout. Load: R2 window above; exact test-time load null.

### R3 cases

- `test/integration/claude-hook.test.ts:484:3` — **Untouched file**. `Claude socket wake through the real hook claim > restart recovers an unattempted expired-owner wake, never resends it, and admits new outcomes`. Failure: 5000 ms test timeout. Load: R3 window above; exact test-time load null.
- `test/integration/profile-subscribe.test.ts:310:3` — **Untouched file**. `pane subscription through CLI, daemon, Herdr socket and durable store > source CLI process and one-call cost use the same isolated daemon boundary`. Failure: 5000 ms test timeout. Load: R3 window above; exact test-time load null.

### R4 cases

- `test/unit/herdr-plugin-package.test.ts:60:3` — **Untouched file**. `shepy Herdr plugin package > packages the runtime entrypoint without build output`. Failure: 5000 ms test timeout. Load: R4 window above; exact test-time load null.

### R5 cases

- `test/integration/claude-hook.test.ts:565:4` — **Untouched file**. `Claude socket wake through the real hook claim > an expired owner's socket symlink before-timer fails closed`. Failure: 5000 ms test timeout. Load: R5 window above; exact test-time load null.

### R6 cases

- `test/unit/hermes-reader.test.ts:218:4` — **Untouched file**. `HermesHistoryReader > classifies tool failure: not json at all -> false (unparseable payload)`. Failure: 5000 ms test timeout. Load: R6 window above; exact test-time load null.
- `test/unit/opencode-v2-history.test.ts:102:1` — **Untouched file**. `malformed and missing stores remain unknown rather than empty history`. Failure: 5000 ms test timeout. Load: R6 window above; exact test-time load null.
- `test/integration/agent-context-health-rpc.test.ts:102:3` — **Untouched file**. `agent context health over RPC > agent.get serves contextHealth, agent.list does not, and a compaction-only append flips it without a wake`. Failure: 5000 ms test timeout. Load: R6 window above; exact test-time load null.
- `test/integration/agent-lifecycle.test.ts:485:3` — **Untouched file**. `subscribed worker lifecycle > P4 automatic pruning keeps a modern never-matched subscription until presence proves absence`. Failure: 5000 ms test timeout. Load: R6 window above; exact test-time load null.
- `test/integration/agent-store-terminal-identity.test.ts:182:3` — **Untouched file**. `AgentStore terminal identity > does not reuse a pane occupant's identity, refs, hint, or snapshot`. Failure: 5000 ms test timeout. Load: R6 window above; exact test-time load null.
- `test/integration/claude-hook.test.ts:290:3` — **Untouched file**. `Claude socket wake through the real hook claim > self outcomes alone cannot wake, including the legacy pane-as-terminal identity`. Failure: 5000 ms test timeout. Load: R6 window above; exact test-time load null.
- `test/integration/daemon-dispatch-rpc.test.ts:106:3` — **Untouched file**. `operation dispatch — integration > an unmatched profile creates no operation row`. Failure: 5000 ms test timeout. Load: R6 window above; exact test-time load null.
- `test/integration/notice-correctness.test.ts:401:1` — **Edited file and test body**. `watch stream publishes another pane while a missing final is pending and drains on stop`. Failure: 5000 ms test timeout. Load: R6 window above; exact test-time load null.
- `test/integration/notice-correctness.test.ts:744:1` — **Edited file and test body**. `five missing finals in a snapshot share one wait rather than five serial sleeps`. Failure: 5000 ms test timeout. Load: R6 window above; exact test-time load null.
- `test/integration/operation-wait-rpc.test.ts:271:3` — **Untouched file**. `operation.wait — Codex silent-peer bound > bare Codex wait returns honest unknown on Herdr bounded timeout, operation remains submitted`. Failure: 5000 ms test timeout. Load: R6 window above; exact test-time load null.
- `test/integration/profile-delivery.test.ts:960:3` — **Untouched file**. `evidence-based settled-outcome suppression (same-ref rule) > the same-ref comparison survives a daemon restart (reopened DB, not memory)`. Failure: 5000 ms test timeout. Load: R6 window above; exact test-time load null.
- `test/integration/profile-isolation.test.ts:169:3` — **Untouched file**. `Phase 2 gate — strict two-profile isolation > same workspace id in another Herdr session is never a candidate`. Failure: 5000 ms test timeout. Load: R6 window above; exact test-time load null.
- `test/integration/profile-subscribe.test.ts:612:3` — **Untouched file**. `pane subscription through CLI, daemon, Herdr socket and durable store > real indexed working-to-done events deliver only the bound session`. Failure: 5000 ms test timeout. Load: R6 window above; exact test-time load null.
- `test/integration/screen-text-notice.test.ts:242:2` — **Untouched file**. `an empty screen: the notice is still sent, marked screen unavailable`. Failure: 5000 ms test timeout. Load: R6 window above; exact test-time load null.

The later row should investigate these retained failures without assuming either that they are production defects or that machine load alone explains them. The two repaired Codex cases did not recur as assertion failures. The four notice-file timeouts above prevent any claim that every red was outside the edited files. The seat approved bypassing the commit gate, not deleting these failures or marking the suite accepted.

shepygreen done: evidence/night/report-shepygreen.md
