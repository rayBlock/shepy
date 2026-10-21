# S1 notice correctness

**PARTIAL.** Slice 1 is implemented and focused-test verified; the shared full gate and live acceptance remain open.
Candidate: `f10cc62df329e99db2132fc914a8dab47e27b00f`, branch `night/s1`, base `07d573552d51690b51750c94f8eaa8fe4be49598`.
Scope: notice identity, startup suppression, duplicate-session resolution, one bounded history retry, and initial blocked detection only.
Acceptance was recorded here before coding from `/Users/ray/dev/agent-factory/evidence/20261021-night/brief-S1-notices.md` and binding S1 amendments in `/Users/ray/dev/agent-factory/evidence/night/acceptance-check.md`. No hash-pinned PRIMER was supplied; the current PRIMER and role contract were read.

## Files changed
- `README.md`; `src/agent-history/discovery.ts`, `src/agent-history/service.ts`.
- `src/db/agents.ts`; `src/daemon/herdr-session-watch-manager.ts`.
- `src/observability/agent-context-service.ts`, `src/observability/agent-index-service.ts`, `src/observability/profile-delivery-service.ts`.
- `test/integration/notice-correctness.test.ts`, `test/integration/agent-context-service.test.ts`, `test/integration/agent-history-identity.test.ts`, `test/integration/agent-index-service.test.ts`.
- `test/unit/agent-history-discovery.test.ts`, `test/unit/agent-history-service.test.ts`; this report.

## Acceptance proof
All proof below is fixture proof through public services, real readers, migrated SQLite, profile obligations, and `projectInboxOutcome`; it is not live Herdr acceptance.
| Requirement | Proof in `test/integration/notice-correctness.test.ts` |
| --- | --- |
| No foreign fallback, including cached discoveries | No-session agent refuses foreign and same-cwd files; persisted poisoned hint is cleared. Authoritative session control reads its own final. |
| Refresh native identity before history | Two Pi workers and one Claude worker start without indexed IDs, then finish concurrently; all three profile excerpts equal their own final lines and IDs are refreshed. Failed Herdr lookup refuses history. |
| Startup idle and done suppression | Both unknown transitions without text produce zero obligations and no retry wait. Real working completions notify. |
| Duplicate session IDs | Claude project-folder selection wins even when both headers carry the same cwd; a cached old-folder hint is rejected in compact and live reads. Neither matching gives no text; a single main reads normally. Existing ambiguous-main and subagent controls also pass. |
| One delayed read, not stale text | Real 300 ms writes repair missing, previous-turn, and unreadable histories. Still-old text becomes empty. New-turn text cannot attach to the prior completion. Fresh snapshot finals do not wait; five delayed snapshot finals share one wait. |
| Initial blocked exactly once | First snapshot and recovered-event paths notify once without assistant text; service restart with persisted rows and three ticks do not repeat it. Leaving and re-entering blocked notifies again. |
| Other-pane latency | Both the index queue and actual watch-stream path publish the fresh pane before the slow pane; watcher stop drains admitted publications. |
Live three-worker notices, a real approval prompt, Ray's seat inspection, and independent review were not run: no dispatch, messaging, or real-daemon restart grant was used.

## Checks and retained failures
Every test and gate used `env -i`, a new private HOME and TMPDIR, and none of the three prohibited Claude variables. Tools: Node 24.18.0, pnpm 11.9.0, TypeScript 6.0.3, Vitest 4.1.9, Biome 2.5.1, Bun 1.3.14. Existing dependencies were copied locally; no install completed.
Private scratch, all attempts, measurements and logs: `/private/tmp/s1-notices`.
| Check | Exit and wall time |
| --- | --- |
| Eight focused files through `node scripts/run-tests.mjs --maxWorkers=1` | 0, 14.54 s; 154 tests, including 18 new probes. |
| `pnpm typecheck`; `bun x --no-install tsc --noEmit` | 0, 3.90 s; 0, 4.42 s. pnpm automatic dependency installation was explicitly disabled. |
| `pnpm build`; root package check | 0, 4.35 s; 0, 4.33 s; root tarball allowlist passes. |
| Pi package check; Herdr plugin check | 0, 2.96 s; 0, 1.56 s. |
| Biome check; format; Drizzle check; diff whitespace check | 0, 0.26 s; 0, 0.08 s; 0, 1.25 s; 0, 0.10 s. One unchanged unused-import warning remains. |
| `pnpm check` under `lockf -k -t 0 /private/tmp/agent-factory-full-gate.lock` | 75, 0.00 s: already locked, so the full check did not start. An earlier lock acquisition attempt was terminated after 240 s, before tests started. No lock bypass. |
Red proof is retained: initial candidate probes failed 10 of 12; the base snapshot fails 13 of the later 16 probes. Intermediate reds included obsolete fallback expectations, a fixture directory mismatch, the snapshot fast-path bug, and timing-sensitive fixture failures. The unreadable fixture now uses renames rather than recursive deletion during its flush, and watch latency excludes startup; thresholds were not extended. Those reds remain in scratch. An early pnpm invocation refused its automatic module reinstall; direct typecheck distinguished that environment failure from code errors.
Final focused log SHA-256: `fe67b58455bc1e3c819f9abb921f56bee67ef323cc9465b217718dd894637a8e` (`focused-frozen.log`). Git honored the existing hook configuration; `.husky/_` is absent in this worktree, so no commit hooks executed. Gates above were run explicitly.

## Cost and limits
The retained `measure.mts` compares the base snapshot with the candidate using 20 five-agent startups and 200 steady index refreshes, local synthetic histories, real SQLite, and an injected Herdr client. Node process CPU and RSS only; no real daemon or RPC cost claim.
Before and after: startup median 8.88 ms and 3.05 ms; CPU per tick 958 µs and 783 µs; wall per tick 1.08 ms and 0.87 ms; process RSS 105.6 MiB and 106.0 MiB. These short, host-load-sensitive samples are indicative, not caps.
Missing-final notice latency changed from 2.98 ms with no final to 509.53 ms with the delayed final. The other pane took 3.20 ms before and 3.19 ms during the retry after. Two status events add two Herdr snapshot calls; one extra history read repairs the missing final. Startup history reads fall from five to zero; steady ticks add no history reads or polling loop.
Each measured database retained its size across the 200 ticks, with no sidecars: base 212,992 bytes, candidate 188,416 bytes. No retained-history growth workload was added. Live daemon RSS and real RPC latency are null because live use was not exercised. Input, cache-write, cache-read, output and summary token measurements are null: the fixture invokes no models, and coding-session usage is not exposed here.
The one-shot retry is in memory: a daemon exit after the persisted status update but before semantic-event append can lose that completion (`agent-index-service.ts:341,476,511`). This crash window needs an owner decision before landing; persisted-blocked restart behavior is separately tested. Empty or stale text remaining after the single retry stays empty by design.
Next owner: seat, for the shared full gate, independent review, the crash-window decision, and admitted live acceptance. No push, live daemon change, profile claim, subscription-policy change, settings edit, or agent message was made.

## Noticed beyond my task
`src/agent-history/claude-reader.ts:43-76` still accepts non-message records such as `api-request-blob` when they carry a user role. This can distort the last-user excerpt and freshness evidence; the seat should triage that reader filter separately. No fix was added outside slice 1.
