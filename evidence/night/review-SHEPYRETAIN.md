Disposition: ACCEPT

Candidate: Shepy `3c4f204` (`fd6804a` code + `3c4f204` report) on `night/shepyretain`, base main `d3f02f4`. Reviewer rev-shepyretain (GLM), blinded build, directed by brief-rev-SHEPYRETAIN. Scope: 7-day `agent_events.compact_history_json` retention, obsolete cache deletion, daemon schedule, `shepy db retain` CLI, migration 0014. Land artifact: `/Users/ray/.factory/land/review-15.398.json`.

## Findings

No defects requiring revision. Verified positives and notes:

- **INFO — protection predicate holds on live data.** `src/db/retention.ts:20-33`. On a `.backup` copy of the live 826 MB database (migrated, then real retention via the CLI): 74,018 events nulled, 0 nulled among obligation-referenced events (15,641 obligations, every state), source-entry projections, a synthetic owned scope's anchor and an old unread event after it (`e.id >= acked_event_id`), each agent's latest done/idle, and events newer than the cutoff. Event exactly at the 7-day edge is kept (strict `<`, asserted in `test/integration/database-retention.test.ts:75-77`). Timeline, payloads and all other tables unchanged; integrity `ok`.
- **INFO — locks bounded end to end.** `src/db/retention.ts:65-77,110-118`. Exclusive lock held by another process: CLI dry-run and real run both fail fast (~330 ms wall including tsx boot; 25 ms busy timeout), DB untouched. Concurrent appender writing 16,535 age-eligible events over 20 s: retention completed (1,089 batches), zero appended rows nulled (finite high-water mark), zero writer errors, integrity `ok`. Daemon startup reaches listening in 0.5 s with retention still running; `agent list` RPC answered in 0.33 s during the active run.
- **INFO — pre-existing, not this candidate:** daemon boot under an externally held exclusive lock exits `database is locked` (~5-6 s) before listening, on the candidate and identically on main `d3f02f4` (reproduced in `/Users/ray/dev/shepy-wt/main-land`). Retention starts only after listening (`src/daemon/service.ts:182-185`) and cannot stall boot; the 5 s boot-path busy timeout predates this diff. One earlier locked-boot trial took ~65 s to surface the same error with different leftover DB state — same pre-existing path, worth the seat's awareness when running manual VACUUM.
- **INFO — migration 0014 verified.** Index-only; applies to the live copy in 1.2 s, integrity `ok`, `pnpm db:check` clean; `EXPLAIN QUERY PLAN` shows all three indexes used (covering for both obligation probes, `agent_events_latest_settled_idx` for the latest-settled subquery).
- **INFO — dry-run byte-exact; VACUUM only on request.** Through the real CLI on the live copy: SHA-256 identical before/after dry-run, no journal residue; second real run nulled 0 rows (idempotent); plain retain leaves file size unchanged (827,240,448 B); `--vacuum` shrank to 219,148,288 B; `--dry-run --vacuum` refused, exit 1.
- **INFO — readers null-safe (independently audited).** `src/db/agent-events.ts:150-167` maps null; `src/db/delivery-obligations.ts:168-170` skips null finals; `src/observability/profile-delivery-service.ts:74-82,612-648` null-safe via optional chaining; wake service reads payloads only. Live RPC probe on the retained copy: 450 nulled events in `agent.events`, each carrying `outcomeContext.state: "unavailable"`, none missing context, no throws.
- **INFO — cost without indexes.** Dry-run on an unmigrated live-size copy: 36.7 s vs 12.8 s migrated. README already directs migrating first; the daemon applies 0014 at startup (`src/daemon/service.ts:60`).
- **Decision 132: compliant.** 5 tests added (4 integration, 1 unit), each behaviour asserted once; no repetition, no implementation-detail pinning beyond the 25 ms timeout regression test, which guards a real prior defect.

## Checks executed (wall times)

Focused retention tests: 5/5 passed, 1.7 s (new files; absent on `d3f02f4` by construction). `pnpm typecheck` 5.2 s; `pnpm lint` (biome, 167 files) clean 2.3 s; full suite under `lockf -k /private/tmp/shepy-full-suite.lock`, `env -i`, fresh mode-0700 HOME/TMPDIR, Node 24.18.0: 1,181/1,181 in 76 files, 38.7 s, zero reds (no main comparison needed). Live-copy work (own `.backup`, never the live file or daemon): migrate 1.2 s; dry-run 13.2 s; real retention 17.0 s; vacuum run 18.1 s; lock probes ~0.3 s each; daemon probes ≤65 s worst case. Scratch: `/private/tmp/factory/rev-shepyretain/` (mode 0700, includes all probe logs and DB copies).

## Limits and next owner

Daily schedule verified with fake timers only, not a live 24-hour observation; all DB measurements are copy-process measurements. Live rollout, live VACUUM timing and post-rollout size monitoring belong to the seat. Referenced histories and event rows still grow (acknowledged in the builder's report).

**Noticed beyond my task:** pre-existing daemon boot failure under an external exclusive lock (above) — owner: seat/daemon maintainers; the README's "stop the daemon first" VACUUM runbook already avoids it.

rev-shepyretain done: /Users/ray/dev/shepy-wt/night-rev-shepyretain/evidence/night/review-SHEPYRETAIN.md
