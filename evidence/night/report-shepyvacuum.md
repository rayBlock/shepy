# shepyvacuum — row 15.453 (database retention and compaction)

**BUILT**, machine-verified on `night/shepyvacuum`; independent review and landing remain with the seat.

Candidate:
86a6ae3ef0226d70b005d11535b0f8abb18ece60

## Acceptance block recorded before implementation
- Extend SHEPYRETAIN's seven-day retention to delete expendable event rows while preserving delivery references, owned cursors, agent-index state and departure recovery.
- Add `shepy maintenance compact`, coordinating with the daemon through a database-specific lock. Never compact the live database during this work.
- Start with failing focused tests and passing controls; prove retention and database validity after compaction.
- Measure a SQLite `.backup` of the real database, including size, elapsed time, delivery and `profile diagnose` before and after.
- Run focused checks, TypeScript, Biome and a locked full suite with Node 24 and isolated environments; commit code and this report.

Brief: `/Users/ray/dev/agent-factory/evidence/20261023-picture/brief-SHEPYVACUUM.md`.
Scratch, probe sources and retained raw logs: `/private/tmp/factory/shepyvacuum/`.

## Result and acceptance proof
- Extended the existing retention store and daily daemon service, without a second retention loop or schema change. Old rows without snapshots also expire; ids are never renumbered.
- All obligation states, OpenCode references and owned cursor anchors and unread rows retain complete events. Indexed agents retain their outcome ledger and latest status journal because current departure recovery walks those outcomes. After departure, those events become eligible unless another reference or the seven-day window protects them.
- `shepy maintenance compact` runs retention and VACUUM under a separate SQLite lifetime lock shared with daemon startup. The existing `db retain --vacuum` uses the same lock. It follows symlink aliases and releases on graceful exit or SIGKILL; no stale-PID cleanup is needed.
- Focused tests cover deletion, seven-day boundary, null snapshots, every obligation state, cursor gaps, dry-run immutability, batched reference arrival, finite scans, cancellation, writer contention, old unpublished-final recovery after restart, integrity and daemon lock exclusion.
- On separate pre-compaction and post-compaction backup copies, the production RPC server and CLI `profile diagnose --json` worked. Each copy leased, delivered and acknowledged five existing pending outcomes; every returned snapshot exactly matched its stored event. No watcher, transcript discovery or wake sender ran on those copies.
- Aggregate hashes of all obligations, owners, subscriptions, scopes and delivery-referenced events were identical before and after the measured compact. Integrity was `ok`; foreign-key errors were zero.

## Real database copy measurement
- Read-only `/usr/bin/sqlite3 .backup` captured 109,134 events; the live daemon and database were not modified or controlled.
- File size: 827,555,840 bytes before; 190,283,776 bytes after. Reclaimed 637,272,064 bytes, or 77.0 percent. Free pages fell from 99,475 to zero.
- Retention deleted 75,173 events, leaving 33,961. The existing 100-row batches scanned 110,537 event and cache rows; JSON-byte estimates are not file savings.
- `/usr/bin/time -l` measured the compaction Node process: 14.70 seconds wall, 0.63 seconds user CPU, 1.41 seconds system CPU, maximum RSS 108,773,376 bytes. The retained lock sidecar was zero bytes; temporary peak disk usage was not sampled.
- Measurement log: `c.EjupRO/log`; SHA-256: `8839a0c50780d7791d6f418079eae9b4f776a97fa8fde8d3369fb04f33fa14cd`.
- Additional attack: concurrent legacy compaction was refused. An initial repeat expected zero deletions incorrectly while wall time advanced: all 22 additional rows crossed the seven-day cutoff. Repeating at the same cutoff deleted zero rows.

## Checks and provenance
- Node 24.18.0 from mise; pnpm 11.9.0 from mise; Vitest 4.1.9 from this checkout's cloned, preinstalled dependencies. No dependency installation was performed. Backup CLI SQLite was 3.51.0; Node's SQLite was 3.53.1.
- Every invocation used `env -i`, a fresh private 0700 HOME and TMPDIR, Node 24 first, and no CLAUDECODE or Claude messaging variables. Pnpm used `--config.verify-deps-before-run=false` after its initial automatic-install attempt refused without a TTY.
- Focused: 78 tests passed, 6 seconds. Typecheck passed, 2 seconds. Biome lint and format passed, each under one second. Build passed, 2 seconds; package check passed, 4 seconds; migration check passed, 1 second; Pi package passed, 3 seconds; Herdr plugin passed, 1 second.
- Full suite: 1,199 tests in 78 files passed, 50 seconds, through factory `gatelog.ts` and `lockf -k /private/tmp/shepy-full-suite.lock`.
- The first `pnpm check` failed 23 socket fixtures in 32 seconds because the existing test runner added a long nested TMPDIR. A shorter nested control left six overlong replacement sockets; direct Vitest with the same clean environment passed all 181 affected tests, then the locked full suite. These reds remain in scratch; the runner was not changed.
- Initial red tests, corrected fixture setup and corrected measurement-harness assumptions are retained in scratch. Normal Git commits used no hook bypass; this worktree's configured `.husky/_` directory is absent, so hooks did not run. All required checks were executed explicitly.
- Model: `gpt-6.1-sol`, provider `openai-codex`, from PI_MODEL and PI_PROVIDER. Input, cache-write, cache-read, output and summary token counts are null: this session exposes no per-run token ledger.

## Limits, leftovers and next owner
- No independent acceptance check, live deployment, live maintenance, push or landing was performed. The seat owns review and deployment. Stop an older daemon that predates the lifetime lock before first compact; stop other database writers and make a backup too.
- This bounds expendable history, not all storage: delivery references, unread cursors and indexed-agent outcome ledgers can outlive seven days. Shrinking those recovery ledgers would require a separate recovery-contract change.
- Scratch retains about 1.2 GB of private copies and logs; ignored dependencies are a roughly 377 MB clone. Earlier supported-runner calls also retained their auto-generated `/private/tmp/shepy-t-*` runtime roots, listed in the logs. No databases or dependencies are committed.

## Noticed beyond my task
- `scripts/run-tests.mjs` underestimates its longest socket suffix: `claude-socket-identity.test.ts` uses `cc-socks/replacement.sock`, longer than the budgeted orchestration fixture. Consequence: valid private TMPDIR choices can break the standard gate on macOS. Suggested owner: Shepy test-runner maintainer; no adjacent fix included.
