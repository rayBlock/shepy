# review-shepyvacuum (row 15.453, Shepy) — rev-shepyvacuum

**ACCEPT** — independent review of the detached candidate `4a716028ffe5adf8dd60b1c6621909e454a6a3ac` (range `2cdd20b..4a71602`: code `86a6ae3ef0226d70b005d11535b0f8abb18ece60`, docs `4a71602`). Builder report read; whole diff read first, including tests and README.

## Findings

No defects in the four briefed attack surfaces. All four verified independently, not just by tests:

- **Retention keeps what delivery, cursors, the index and departure recovery need.** The protection SQL's type sets exactly match the store readers (`outcomesForAgent`, `findPriorSettledEvent`, `findPendingSettlement` in `src/db/agent-events.ts:139-177`); departure projection and obligation creation share the agent-removal transaction (`agent-index-service.ts:313-367`), so an outcome ledger can never sit unprotected between index removal and obligation creation. Obligations are protected in every state (pending, leased, delivered, acked, dead_letter) with no state filter. On a real copy, deleting 75,249 of 109,352 events left **zero** dangling `delivery_obligations` (15,850, incl. 197 pending) and `source_entry_deliveries` references.
- **Compact/vacuum fences and is fenced.** `maintenance compact` and `db retain --vacuum` refuse while the daemon lives (both probed through the dist CLI, alias path included); a daemon cannot come up while an external holder owns the lock (daemon exits with the in-use error, `daemon status` shows stopped, log names the lock).
- **Crash mid-compact leaves a valid database.** SIGKILL during retention (68,599 rows already deleted) and during VACUUM: `integrity_check` ok, `foreign_key_check` empty, daemon starts on the crashed copy, retry compact completes.
- **The lock never blocks a normal restart.** Full CLI cycles start→stop→start→stop→compact→start all pass; SIGTERM exit code 0 also covered by the suite test.

Minor, none blocking (suggestions for the seat, not required before landing):

1. `test/integration/database-compaction-lock.test.ts` covers only the compact-vs-daemon direction; daemon-refuses-mid-compact is untested (verified here by hand). One spawned-daemon case would close it.
2. `shepy daemon start` prints a success-shaped pid when boot later dies on the held lock; the failure only surfaces via `daemon status`/logs (pre-existing spawn-and-return shape, now one more boot-failure cause).
3. `shepy db retain` without `--vacuum` still takes no lock; per-batch reference checks keep it safe, but deleting rows is now permanent where base only nulled JSON — README could say "stop the daemon" for it too.

## Tests read and counted (decision 132)

Five genuinely new cases: 2 lock tests (real spawned daemon boundary, SIGTERM/SIGKILL), 2 retention tests (deletion-without-snapshot, indexed-recovery expiry after departure; compact CLI page reclamation + integrity), plus the agent-lifecycle aging step and a unit byte-count fix. No pinning of implementation detail; no one-test-per-attack padding. Adapted assertions (gaps, missing-event tolerance, payload survival) read line by line.

## Checks (all `env -i`, fresh 0700 HOME/TMPDIR, Node 24.18.0 first, no CLAUDE vars)

- Focused 4 files: 44 passed, 6.8s wall.
- `tsc --noEmit`: clean, 4.1s. Biome check + format: clean, <2s.
- Full suite under `lockf -k /private/tmp/shepy-full-suite.lock` via `scripts/run-tests.mjs`: 1,199 tests / 78 files passed, 40.3s.
- Differential: candidate test files on base `2cdd20b` fail 7 (all new tests red on base); passes on candidate. Scratch base worktree under `/private/tmp/factory/rev-shepyvacuum/`.

## Cost/provenance (R05)

Fresh `.backup` of the live DB (read-only; live daemon and `~/.shepy/state.db` never touched): 827,555,840 B with 109,352 events → compacted 190,914,560 B (76.9% reclaimed); crash+retry path 5.7s + 4.9s, single full run matches builder's 14.7s. Builder's measurements (77.0%, 14.70s, RSS ~104 MB) reproduce within noise. Lease/deliver/ack of pending outcomes on the copy is builder-verified only; I verified inbox list, `profile diagnose --json`, and zero dangling refs on the compacted copy.

## Limitations and next owner

Not checked: live deployment, upgrade from a pre-lock daemon, `pnpm package:check` (builder ran it). First compact against an old daemon predating the lock remains an operator step (README states it). Next owner: seat (landing + deployment).

**Noticed beyond my task**: the builder's `run-tests.mjs` long-TMPDIR socket-budget note was not reproduced (my nested TMPDIR is shorter); still worth the suggested test-runner owner. Nothing else noticed.

## Artifacts

Land review JSONs: `/Users/ray/.factory/land/review-15.453-86a6ae3ef.json`, `/Users/ray/.factory/land/review-15.453-4a716028f.json`. Probes and logs: `/private/tmp/factory/rev-shepyvacuum/` (0700).

VERDICT: ACCEPT
Disposition: ACCEPT
Candidate: 4a716028ffe5adf8dd60b1c6621909e454a6a3ac
