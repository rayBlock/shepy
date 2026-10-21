# S1: Correction 1

**PARTIAL.** All requested fixes are implemented and 14 current review probes pass. The latest nine-file check still has three timing failures; it is not green.
Candidate: `ff2b52dc878bab8084771d9bd48383f82ba5c504`, branch `night/s1`, correcting `f10cc62` and report `15a0381`.
Authority: seat's Correction 1 and `git -C /Users/ray/dev/shepy show 8ff2940:evidence/night/report-rev-s1.md`. Original acceptance and preparation evidence remain in `15a0381:evidence/night/report-s1.md`.

## Files changed in this correction
- `src/observability/agent-index-service.ts`; `src/db/agents.ts`; `src/daemon/herdr-session-watch-manager.ts`.
- `src/agent-history/discovery.ts`; `src/agent-history/service.ts`; `README.md`.
- `test/integration/notice-correctness.test.ts`; `test/integration/agent-history-identity.test.ts`; this report.

## Requested proof
| Item | Implementation and fixture proof |
| --- | --- |
| P1: superseded retry ordering | Append its empty completion immediately, before the newer status; retain that event for flush publication without another append. The new-turn test now asserts audit order, exactly two outcomes, and the final row status, for both event and snapshot routes. |
| Crash window, P2 | Status plus both event records commit in one SQLite transaction. Snapshot metadata refresh preserves committed statuses. The row stays working during the retry; duplicate settled observations are ignored. Injected first-append and semantic-twin failures roll back; a restarted index recovers exactly one completion. Both routes, text present and missing, are exercised. Initial blocked append failure also recovers. |
| P6: ready snapshot outcomes first | The watcher publishes the ready portion before waiting for retries, then publishes only the retry portion. The public watch-manager test asserts the fast notice arrives while the slow notice is absent, no duplicate outcomes, and final context statuses reflect both completions. |
| Cached Claude main | A unique validated main survives a cwd alias or missing cwd. Multiple mains require the matching project folder; absent cwd fails closed. Tests cover compact and live reads, a new copy, an initially incomplete copy, and removal of that copy. A per-service fingerprint cache avoids reopening unchanged headers; directory enumeration and stats still detect new copies. |
| P4 and P5 controls | Persisted working becomes blocked once after restart and repeated ticks. A flushed next-user record cannot deliver the previous settled text. Both controls pass. |
All proof uses synthetic producer-shaped transcripts, real readers, migrated SQLite and profile obligations, not live Herdr workers. Nine selected regressions fail on the reviewed `f10cc62` snapshot. A supplemental missing-cwd cached-ref probe also failed before its guard was corrected.

## Checks and retained red results
Every test and gate used `env -i`, a fresh private HOME, short TMPDIR, and no Claude messaging variables, CLAUDECODE, REPL_ID or AGENT. Tools remain Node 24.18.0, pnpm 11.9.0, TypeScript 6.0.3, Vitest 4.1.9 and Biome 2.5.1. Automatic pnpm dependency installation was disabled.
Private scripts, complete attempts, logs and measurements: `/private/tmp/s1-r1`.
| Check | Exit, wall time and result |
| --- | --- |
| Current typecheck | 0, 10.81 s. |
| Current review and correction probes | 0, 10.23 s; 14 passed, 21 unrelated cases unselected. Includes P1, P2, P4, P5, P6 and cached-ref controls. |
| Latest touched and dependent nine-file batch | 1, 110.42 s; 172 of 175 passed. Pending-duplicate and five-agent-startup cases hit the unchanged 5 s timeout; the five-final batch exceeded its unchanged 1 s wall bound at 1.617 s. |
| Earlier nine-file batch | 0, 94.59 s; 175 passed, before the supplemental missing-cwd guard. This does not erase the later red result. |
| Expanded sixteen-file batch | 1, 130.79 s; 506 of 507 passed. One untouched Claude-hook case hit its 5 s timeout. Isolated before and after controls both passed; that does not resolve the wider red. |
| Build; root package check | 0, 10.05 s; 0, 17.47 s; tarball allowlist passes. |
| Biome; diff whitespace | 0, 0.74 s; 0, 0.35 s. One unchanged unused-import warning remains. |
| Full `pnpm check` under the shared lock | 75, 0.00 s; lock already held, so the check did not start. No bypass. |
Earlier red attempts also retain the producer flush missing its timing bound at 540 ms, the nine before-fix regressions, the missing-cwd probe, and an intermediate type-narrowing error. No assertion or timeout was weakened. The isolated green probes are not acceptance of the red batch.
Current probe log SHA-256: `ea8cc01b77cf0e324a5dbffd447bd80185e438044ad1f92eebbe0c4633767fae` (`review-probes-current.log`). Latest nine-file red: `69f9fb0dd58774a028a9f464a4f95cb9ea9690bcf459fa8bcbd5e72f60df369a` (`touched-final-current.log`).

## Running cost and limits
Measurements compare `f10cc62` with the committed correction using injected Herdr snapshots, local transcripts and Node process CPU and RSS. They are host-sensitive samples, not daemon capacity guarantees.
For 301 Claude transcripts and ten warm cached reads with a cwd alias, full rediscovery calls fall from ten to zero; mean read wall time is 23.94 ms before and 4.78 ms after, CPU 24.55 ms and 5.00 ms. Directory walks and stats remain proportional to file count; cached header metadata grows with discovered paths and prunes deleted paths on a scan. There is no new polling loop.
For a mixed snapshot, ready notice publication measured 509.42 ms before and 284.53 ms after; the retried notice measured 824.18 ms after. An earlier after-run measured 5.17 ms and 506.00 ms respectively. Both runs publish two distinct events once, in two batches rather than one.
Across twenty five-agent startups and 200 steady refreshes, startup median measured 4.25 ms before and 53.34 ms after; CPU per tick 0.72 ms and 1.33 ms; wall per tick 1.35 ms and 9.35 ms. Earlier after samples were 3.27 ms startup and 0.72 ms CPU per tick, so these short shared-host measurements are highly variable. Node RSS measured 105.0 MiB before and 105.8 MiB after. Steady ticks read no histories; no extra Herdr snapshot calls were added by this correction.
Disk sizes remained unchanged across steady ticks, with no sidecars: 188,416 bytes in each core fixture; 196,608 bytes in each mixed-snapshot fixture. Input, cache-write, cache-read, output and summary tokens are null: fixtures invoke no models and coding-session usage is not exposed. Live daemon RSS and real RPC latency are null because no live runtime was exercised.
The formerly reported status-before-event crash window is addressed by transactional persistence and restart fixtures. Actual process-kill delivery, live Pi and Claude notices, a real approval prompt and Ray's seat inspection remain unverified. No real daemon restart, profile claim, subscription-policy change, settings edit, agent message or push occurred. Git honored normal hook configuration; `.husky/_` remains absent, so gates were run explicitly.
Next owner: seat, for independent recheck, the retained timing failures, shared full gate and admitted live acceptance. The candidate is not accepted or landed.

## Noticed beyond my task
The Claude reader's non-message user-record filtering remains unchanged (`src/agent-history/claude-reader.ts:43-76`); the seat should triage it separately. The review's shared-host test timing concern remains open rather than being hidden by relaxed assertions or timeouts.
