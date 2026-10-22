# S3 corrected delivery and main-based integration

Worker: s3. Worktree: `/Users/ray/dev/shepy-wt/night-s3`.
**BUILT.** The corrections and combined S2 and S3 lifecycle path are machine-verified. Not landed or self-accepted; independent recheck and batch validation remain with the factory seat.

## Both branches

- Preserved `night/s3` tip: `c3dac36511c1f5b2367eedf50b141dced7410819` (correction code `d2d74c2`, plus its report).
- `night/s3-main` frozen code tip: `d21f85a86df9524fb2c72b7823608af2d8722f5f`, based on main `f8c108d838206e45d66dc027148e293905e9ac0c`. Its report-only successor is identified in the finish reply.
- Created the requested new branch from main and cherry-picked all five S3 commits with `-x`. No rebase, source-branch rewrite, main landing or push. Original acceptance and correction history remain at `git show c3dac36:evidence/night/report-s3.md`.

## Correction after independent review `75008c2`

- **F1 (pruning and diagnostics):** pending rows without an indexed scoped agent resolve `unmatched` and use the age gate. P4 (closure before detection) and P7 (wrong workspace or never indexed) now age out; younger rows and indexed agents awaiting native identity stay protected. The doubled pending prefix is gone. S2's healthy-presence protections still govern automatic cleanup.
- **F2 (caller-supplied guards):** `profile.subscribe` rejects any supplied `agentSession`, including null, without creating or changing a row. Only daemon-observed metadata supplies the terminal guard. P5 (guard injection) and its bare-selector control pass.
- **F3 (pending-worker departure):** an exact-terminal `agent.gone` can deliver before native identity exists. Workspace, prior-agent and bound-native-session checks remain enforced. P9 (closure before native publication) now runs through S2's actual gone path, not just the standalone seam.

## Integration and conflict resolution

- Resolved the four implementation conflicts by retaining both README sections, both store operations, all three index callbacks, and frozen-source plus native-guard delivery imports. The correction pick's additional comment conflict was combined. Kept S2's projection-before-removal transaction, move batching, migration, presence-aware prune and gone rendering.
- Preserved S2's legacy policy in S3's existing-terminal resubscribe fast path: explicit resubscribe clears `legacy` while adding the native guard. A regression verifies the same row id, guarded identity and cleared flag.
- A new combined probe reproduced a persistent SQLite uniqueness failure when a bound terminal moved into its already-pending destination row. First binding now atomically merges that identical guarded destination and reparents notices. Raw terminal selector key order is normalized; differing native guards are not overwritten. Repeated refresh succeeds, one row remains and the prior notice survives.

## Acceptance evidence

- Integrated P9 tests cover Pi and OpenCode, each with two profiles. Removing the pane from the producer-shaped Herdr snapshot invokes the real index and `projectGoneAgent` callbacks: one gone per profile, both rows removed, notices retained, no duplicate after another refresh or database/server restart. No manual gone append or unsubscribe is used in these integrated cases.
- P8 (bound-worker closure) still delivers gone and removes its row. Wrong terminal, workspace and bound session refuse delivery. Guarded subscriptions follow cross-workspace pane movement without changing the native session. Name reuse, initial binding, replacement refusal and caller-guard rejection remain green.
- All 30 inherited S2 lifecycle tests pass, including done before gone, movement collisions and swaps, rollback, legacy and modern prune behavior, live empty-pane preservation and failed-session protections. Factory files remain unchanged; start already subscribes by terminal.

## Checks and provenance

- Node 24.18.0, pnpm 11.9.0, locked TypeScript 6.0.3, Vitest 4.1.9 and Biome 2.5.1. Every runtime test, compiler, format and package invocation used `env -i`, fresh HOME and short TMPDIR; all three Claude variables were absent. No dependency installation or hook bypass.
- Requested S2 and S3 files: **64 passed**, exit 0, 9.04 seconds. Broader touched coverage: **289 passed in 14 files**, exit 0, 4.12 seconds. Typecheck: exit 0, 8.79 seconds. Changed integration-file Biome: exit 0, 0.05 seconds.
- `pnpm package:check`, including `pnpm build`: exit 0, 6.80 seconds, 330 allowed files. No migration beyond S2's existing migration was added. Frozen diffs and Git whitespace checks passed; normal Git commits used no bypass, but the configured `.husky/_` runner was absent, so no hook gate is claimed.
- The uniqueness-failure red probe is retained alongside its passing CLI and raw-client controls. No assertion was relaxed or timeout raised. The full batch suite was not claimed; it remains seat-owned.

Private proof folder: `/private/tmp/s3-main-proof.SNRMXI`. `integration.md` records exact commands, cherry-pick mappings, conflict decisions and limits; `source/` retains the standalone correction and original delivery logs. `s2-s3.log` SHA-256: `43ca9cfe366c9fc40ddcba194a80e48fe5d609479f051d1b85610712ba269f36`. `touched.log` SHA-256: `9b8db95ea3a4bf1dabd7f8b40f8a7373ef4d88a73776f125392718738ae68a8c`.

## Cost, limits and next owner

- The repeat workload still makes one Herdr call per subscribe, leaves one row and a 133-byte selector, and keeps endpoint database plus extant sidecars at 188,416 bytes. Twenty in-process requests used 21.23 milliseconds of fixture-worker CPU. RSS includes imports and fixtures, not daemon-only memory; detailed readings are in the proof ledger. Production memory, transient journal peak, live CLI latency, idle use and scaling remain unmeasured.
- Input, cache-write, cache-read, output and summary tokens are each null because task-scoped counters were unavailable. No application inference was invoked. Not checked with live Herdr: physical close-event timing or a real seat wake. The combined proof uses controlled sockets, actual lifecycle code and migrated SQLite, not a shared daemon.
- Next owner: factory seat for independent recheck and batch validation of `night/s3-main`, then landing. The standalone branch is preserved for comparison. No real profile, pane, shared daemon, foreign worktree or agent messaging was controlled.

## Noticed beyond my task

None newly noticed beyond the combined move/bind collision fixed above. The reviewed native-session-reset policy remains unchanged.
