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

Evidence qualification: "not your files" is not literally true for every timeout. Four timeout cases occur in the edited `notice-correctness.test.ts`; the watch-stream and five-pane cases also have edited test bodies. The other two cases in that file have unchanged bodies. These failures remain recorded, not attributed conclusively to machine load or waived as green. The seat's permission changes only the commit gate; the three-consecutive-green requirement remains unmet. The full per-test catalog follows in a separate report-only commit.

## Noticed beyond my task
The untouched packaging, Claude wake, lifecycle, subscription and screen-read tests can still fail under this host's scheduling conditions, even after the two always-red Codex cases are repaired. Their timed full-run evidence above belongs to the Shepy seat; isolated greens do not settle them.

shepygreen done: evidence/night/report-shepygreen.md
