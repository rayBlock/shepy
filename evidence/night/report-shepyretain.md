BUILT. Seven-day context retention is implemented and machine-verified on a SQLite backup; nothing was deployed or changed in the live daemon, database or profiles.

Candidate: `fd6804a05c89b3eba7f0fadcfe35832021330b99` on `night/shepyretain`, based on main `d3f02f4`. Independent GLM review and the seat's acceptance remain open.

## Acceptance block recorded before coding
- Null compact history only on events older than seven days; retain event rows and payloads.
- Preserve events referenced by delivery obligations and owned scope cursors, and latest settled outcomes needed by readers.
- Drop obsolete history-cache formatter rows, preserving the current formatter.
- Bound daemon work into resumable batches at startup and daily, with run counts and estimated reclaimed bytes logged.
- Provide `shepy db retain --dry-run` and explicit `--vacuum`; no automatic VACUUM.
- Prove age/reference safety, nullable readers, dry-run immutability and batch resume with focused tests.
- Run typecheck, Biome, a locked full suite, build/package checks; compare failures with main.
- Back up the live database using SQLite `.backup`; exercise dry-run, real retention and VACUUM only on that copy, recording preservation checks and file sizes.

## Results
All acceptance checks above were exercised. The brief's seven-day rule applies to all event types, with conservative protection for **every** obligation state, OpenCode projection references, owned cursor anchors and unread events, and each agent's latest done or idle event. No obligations are retired or deleted.

Daemon runs scan 100 rows per transaction, yield 10 milliseconds, exclude concurrent appends and log committed counts, estimated bytes, cutoff and completion. Cancellation stops between batches. Startup reads and batches temporarily use a 25-millisecond busy timeout.

Migration `0014_tearful_hardball.sql` adds three lookup indexes only. `pnpm db:migrate` applied it to the backup; query plans use the indexes. Backup acquisition initially encountered a lock; SQLite `.backup` with a 10-second busy timeout succeeded, with integrity `ok`.

| Final-copy stage | Database bytes |
| --- | ---: |
| Original backup, before migration | 825,831,424 |
| Migrated, before and after retention | 826,548,224 |
| After explicit CLI VACUUM | 218,624,000 |

The final CLI run nulled 73,969 snapshots, deleted 4,624 obsolete caches, and estimated 546,663,279 JSON bytes released across 1,129 batches. All 106,926 event rows and 1,234 current caches remain. Dry-run preserved the database's SHA-256 exactly; its slightly earlier cutoff explains its two fewer eligible events.

Copy proofs verified unchanged timeline ids, payloads and metadata; referenced snapshots; latest settled lookups; recent-delivery dedupe; 26,229 recent event projections; scope unread counts; and all other tables. Obligations remained 219 pending and 15,387 acknowledged, with no missing events. Integrity stayed `ok`.

## Nullable-reader audit
No reader changes were needed; existing null handling was verified in source and exercised through store, projection and RPC tests.
- `AgentEventStore.get`, `listAfter`, `nextDeliverableAfter`, `findPriorSettledEvent` and `outcomesForAgent` map missing history to null.
- `DeliveryObligationStore.recentDeliveredFinals` skips null histories; `ProfileDeliveryService` replay fingerprints, prior-outcome comparison, pane-close reconciliation and inbox snapshot enrichment use nullable history.
- `AgentIndexService` prior-settled comparisons use optional history access; the latest settled snapshot remains protected.
- `ClaudeIdleWakeService` reads event identity and payload, not compact history; referenced events remain intact.
- `AgentOrchestratorService` preserves nullable event records and cursor ordering; `agent.events` RPC uses `projectOutcomeContext`, which reports unavailable context.
- `createAgentHistoryService` reads only the current formatter; an obsolete-cache miss re-reads the transcript.

## Checks, retained failures and cost
Node 24.18.0, pnpm 11.9.0, TypeScript 6.0.3, Biome 2.5.1 and Vitest 4.1.9 came from the frozen offline install. Every test used `env -i`, private mode-0700 HOME and TMPDIR, with all three Claude variables absent. Full checks held both the factory gate lock and `/private/tmp/shepy-full-suite.lock`.

Final focused checks passed 41 tests in 1.70 seconds wall time. Final `pnpm check` passed all 1,181 tests in 76 files, plus typecheck, Biome, formatting, migration and package checks: 96.45 seconds including gate wait; Vitest took 40.77 seconds. `bunx tsc --noEmit` passed in 3.48 seconds; explicit build passed in 3.83 seconds.

Two intermediate full runs remain recorded: a five-second Herdr package-test timeout and a lifecycle-prune assertion. The unchanged main snapshot and candidate each passed those 35 tests in focused controls, and both package commands passed in 0.33 seconds. Neither failure is claimed to be a proven pre-existing failure. No assertion or timeout was weakened. An exclusive-lock probe also exposed a five-second startup stall in the first implementation; its regression test failed, the timeout coverage was fixed, and the final probe recovered after about 34 milliseconds.

Final CLI retention took 12.96 seconds wall, 0.65 seconds user CPU and 0.96 seconds system CPU, with 105.5 MB maximum RSS. Maximum event-loop delay was 14.1 milliseconds; a loaded probe recorded 148.5 milliseconds, not a guarantee. External 1-millisecond sampling observed a 373,976-byte journal peak, a lower bound; same-process sampling missed journals. Proof scripts peaked at 1.23 GB while hashing the whole database. These are copy-process measurements, not live daemon measurements.

Sol usage through 83 completed assistant records: input 210,903; cache-write 0; cache-read 7,839,872; output 41,612; summary null because it is not separately exposed. Source: native Pi usage records, excluding the in-flight final response.

Scratch and all raw logs, probes, main controls and private database copies: `/private/tmp/factory/shepyretain/`. Final preservation proof log SHA-256: `7a10bf3ae630536748a4b87c2aa70e039916efe7685d51717f9900d3b9d8e375` (`final-proof-after.log`).

## Limits and next owner
The daily schedule is fake-timer verified, not a live 24-hour daemon observation. Live rollout, independent review and any live VACUUM belong to the seat. Event rows and referenced histories still grow; daily scanning is linear in retained rows.

**Noticed beyond my task:** The lifecycle test leaves a one-second age margin before later subscriptions (`test/integration/agent-lifecycle.test.ts:489–514`), consistent with the observed failure. This checkout lacks `.husky/_/pre-commit` despite its configured hook path: Git was invoked normally without disabling hooks, but no hook ran. Required checks ran independently. Owner: Shepy test and development setup maintainers.

shepyretain done: /Users/ray/dev/shepy-wt/night-shepyretain/evidence/night/report-shepyretain.md
