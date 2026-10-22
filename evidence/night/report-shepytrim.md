# SHEPYTRIM — row 15.363

Builder: shepytrim. Branch: `night/shepytrim`. Base: `7a7a3afa47c205bb5c0ac7ba0478eafaeaa44c2c`.
Code candidate: `e3d8e38b261c9d6e45f692984343a4975c8b45a2`; the following commit changes only this report.
**PARTIAL:** removal is built and committed; full-gate acceptance remains open because checks are not green. Independent review is next.

## Scope and acceptance

The [brief](../../../../agent-factory/evidence/20261022-night/brief-SHEPYTRIM.md) and [binding acceptance check](../../../../agent-factory/evidence/20261022-night/acceptance-check-SHEPYTRIM.md) govern. The acceptance block was recorded before coding and is preserved in the code candidate's report history.
Removed the demand core, publisher and lookup RPCs, capability negotiation, hook and Pi rendering, owner source-kind handling, associated tests and documentation. Rows 5 through 8 were not changed.
The deprecated `--profile-demand` flag is swallowed by `parseClaudeHookCommand`; duplicates produce one stderr-only note. No flag value reaches `runClaudeHook`. One existing test block was replaced by the flag test, observed red before implementation and passing afterward; no other permanent test was added.

## Machine proof

- Built CLI fixtures exercised prompt, mid-turn Stop, acknowledgement and inbox list, get, retry and retire through real JSON Lines sockets and migrated SQLite. Main's and the candidate's hook stdout hashes match byte-for-byte. Unknown flags and removed verbs refuse; empty, malformed and unknown-event stdin preserve control behavior.
- The candidate hook also passed against the base daemon server without demand capability. Its ten-call smoke sent zero capability probes; main's opted-in control sent ten.
- Two actual built daemon processes started with empty and seeded legacy databases and invalid leftover allowlist JSON present before startup. Legacy obligation reads and inbox operations worked. Removed RPCs answered unknown method; agent.list still answered. Herdr discovery used an owned fixture executable, never live Herdr.
- The Pi extension claimed, leased a real stored outcome, emitted hidden context and a visible wake, and acknowledged only after the context witness and successful final API events. This was an API fixture, not a live Pi model turn.
- Schema, migration runner, all migrations and `sqlite-migrations.test.ts` are unchanged from the base. SQLite `.schema` output for the two kept tables and their indexes is byte-identical: 2,505 bytes, including the source check constraint. The production database was not opened or measured.
- The acceptance grep over source, packages, scripts, tests, README, docs and migrations fell from 402 to 139 matches: 127 in the kept schema and migration paths, plus 12 in the required compatibility shim and its test. No other active demand symbol remains. Historical evidence was not rewritten.

## Checks and retained failures

Every test and gate used `env -i`, a fresh private HOME and short TMPDIR, with all three Claude variables absent. Dependencies were linked from the brief's designated checkout. Node 24.18.0, pnpm 11.9.0, TypeScript 6.0.3, Vitest 4.1.9 and Biome 2.5.1 were used. After pnpm's default automatic dependency repair aborted, subsequent commands disabled that automatic install behavior.

| Check | Result and wall time |
| --- | --- |
| Root, Pi and Herdr plugin typechecks | Passed; 6.41 s, 3.24 s and 0.70 s. Baseline typechecks also passed. |
| Focused suite; final Pi-focused suite | 339 passed in 56.44 s; 97 passed in 2.71 s. These overlap. |
| Build; root package; Pi package; Herdr package | Passed; 6.22 s, 3.82 s, 4.44 s and 2.30 s. |
| Lint; format; DB check; bunx tsc --noEmit | Passed; 1.04 s, 0.37 s, 0.58 s and 2.35 s. |
| Full baseline suite, shared lock | Exit 1: 1,285 tests, 1,242 passed, 43 failed. Run 69.69 s; 1,092.99 s including lock wait. |
| Full candidate suite, shared lock | Exit 1: 1,142 tests, 1,138 passed, 4 failed. Run 55.11 s; 2,815.95 s including lock wait. |
| Canonical pnpm check, shared lock | Exit 1 at the unchanged Vitest path guard: the required dependency symlink resolves outside this checkout. |

The full suites used each snapshot's exported runtime/environment helpers and explicit linked Vitest entry; all assertions remained enabled, including the failing path-guard test. This is not a claim that canonical `pnpm check` passed.
Three candidate failures also failed on baseline: the Codex fixture cases in `observability-rpc.test.ts` and `agent-history-readers.test.ts`, and the linked-entry guard in `run-tests.test.ts`.
**New full-run finding:** `notice-correctness.test.ts`, “watch stream publishes another pane while a missing final is pending and drains on stop,” measured 420.18 ms against 400 ms. A follow-up candidate file run passed that case but missed another timing assertion at 417.14 ms against 350 ms. Baseline's file control passed. Three subsequent paired two-case runs passed on each side. These greens do not erase either red or prove the new finding pre-existing; no assertion or timeout was relaxed.
The suite count decreased by 143, entirely from removed demand cases, two automatically enumerated inbox verbs and replacing four flag tests with one.

## Removal and cost

Excluding this report: 30 files changed, 135 insertions and 6,627 deletions. Source lost 1,849 lines and gained 83, net 1,766 removed. Tests lost 4,768 and gained 51, net 4,717 removed. Ten whole files were deleted: four source files totaling 1,151 lines, five test files below, and the seven-line allowlist document.

| Deleted test file | Lines |
| --- | ---: |
| test/integration/claude-profile-demand-validation.test.ts | 1,409 |
| test/integration/profile-demand.test.ts | 1,317 |
| test/unit/demand-eligibility-promise-breach.test.ts | 726 |
| test/unit/profile-demand-cli.test.ts | 60 |
| test/unit/profile-demand-ingress.test.ts | 248 |

Shared-source deletion was 698 lines rather than the estimated 280; hook validation and rendering alone accounted for 362 deleted lines. Shared-test deletion accounts for the amount beyond the 3,760 whole-file test lines.
Ten-call hook smoke medians were 338.02 ms on opted-in main and 181.55 ms on the candidate; shared-host timings are not a capacity benchmark. CPU and memory measurements are null; no retained runtime data was added. Input, cache-write, cache-read, output and summary token totals are null because cumulative session usage counters were not exposed. Builder elapsed time was about 82 minutes, including lock waits.
Raw logs, failed attempts, probe sources, frozen source snapshots and comparison details are retained in `/private/tmp/st363`. Full-suite JSON SHA-256: baseline `3a83fd3f727c152b82f4ebb860f7bce9f939b4204e0c4f3496de1d32d0c3f625`; candidate `a41bf551c13d89a5b149bea02fc5f0e6267677b3fa34e0bafd7c9b7f6b81856c`.

## Handoff and noticed beyond my task

The independent reviewer must adjudicate the new timing finding and the linked-dependency gate limitation. The configured `.husky/_` installation is absent in this checkout; normal Git commit commands were used without changing or bypassing hook configuration, and checks were run explicitly. The designated dependency symlink remains untracked.
Nothing was installed into the live CLI, and no existing daemon was restarted. No factory file changed. After installation, the factory seat must remove the flag from `.claude/settings.json` and `.claude/engine-coordinator-bootstrap.md`. Ray's live wake and worker-outcome check remains open; no live Claude or Pi model turn was exercised.
