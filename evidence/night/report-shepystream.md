# SHEPYSTREAM correction

PARTIAL. F1–F4 and F5a are corrected; the four focused regressions pass. The full gate remains red: two Codex failures also occur on `7aa8adb`, plus a candidate timing failure. Live acceptance remains unrun.

Candidate: the commit containing this report, directly above `961ca2c` on `night/shepystream`. Review addressed: `422d32a` (REVISE). Machine-verified only. Next owner: independent recheck, then the Shepy seat. No rebase or live daemon change.

## Correction acceptance block (recorded before coding)
Refresh stale subscriptions before retry (F1); recover done-only turns and suppress duplicate final references (F2 and F3); bound covered-pane grace to one refresh cycle (F4); back off after ACK-and-close (F5a). Replace the two bundled tests with four focused cases, retaining restart-window coverage. Enforce real Herdr ACK admission and unknown-pane rejection. Prove applicable reds on `961ca2c`, compare full-gate reds with `7aa8adb`, and run isolated focused checks, TypeScript, Biome and a locked full suite. Deadline: 19:45 local.

## Changes and proof
- **F1, stale panes:** failed opens require a successful fresh snapshot before another subscribe. The test covers stale database state, online closure between snapshot and subscribe, and later pane discovery.
- **F2, done-only recovery:** status events use the snapshot's changed-final check. The event commits before its history cursor advances.
- **F3, duplicates:** projection compares prior settled references for working-to-done too, preserving source/session identity and OpenCode's editable entry/content contract. After the existing retry, a proven repeated turn retains its reference for deduplication; a newer unanswered user still gets empty text. Content-fingerprint fixtures now use distinct native references; their assertions are unchanged.
- **F4, bounded grace:** a covered pane defers its changed final once, then records it on the following refresh. Grace state clears on events and removal.
- **F5a, backoff:** unexpected closure sets a reconnect deadline even after ACK. The existing fake-clock test checks refusal at 24 ms and recovery at 25 ms.
- The ACK-gated fixture rejects an entire subscription containing an unknown pane. Four focused cases replace two bundles, net plus two tests. Tests and shared fixture total 379 lines, versus 367 before; restart coverage uses two turns, not 39.
- **Named weakened assertion:** `awaits a removed watcher before finalizing the stopped session` changed expected `subscriptions` from zero to one in `961ca2c`. It now checks `subscriptionAbortStates === [false]`: one pre-abort attempt, none after abort.
- F1, F2, F4 and backoff fail on `961ca2c`; an isolated F3 probe produces two obligations instead of one. Restart coverage passes there but fails on `7aa8adb`; F1 passes on that base. Reviewer loss/duplication and resource probes pass after correction. Its reconnect probe initially pinned two sockets; changing only that private probe's readiness check to the subscribed pane yields one outcome. Both attempts remain retained.

## Checks
Every command used `env -i`, fresh mode-0700 HOME and TMPDIR, and absent Claude messaging variables. Tools: Node 24.18.0, pnpm 11.9.0, TypeScript 6.0.3, Biome 2.5.1, Vitest 4.1.9. Dependencies were reused locally, not installed; pnpm's dependency check was warning-only.

| Check | Result and wall time |
| --- | --- |
| Focused group | 110 passed; 15.36 s |
| Final watcher and regression group | 14 passed; 3.11 s |
| Final TypeScript and Biome | Passed; 5.19 s and 0.62 s |
| Format, DB, root build/package, Pi package, Herdr plugin | Passed; 1.75 s, 1.45 s, 6.68 s, 5.99 s, 2.05 s |
| Candidate locked `pnpm check` | 1,144 passed, 3 failed; exit 1; 46.44 s; all four regressions passed |
| Exact base `7aa8adb`, same locked command | 1,140 passed, 3 failed; exit 1; 84.17 s |

Both full suites used `lockf -k /private/tmp/shepy-full-suite.lock`. Both fail Codex default-history discovery and RPC `agent.read`. Candidate additionally fails unreadable-transcript retry timing; base additionally times out in rival-owner Stop recovery. The exact notice case passed three isolated runs on each tree. An earlier focused run also measured a 467 ms writer flush against its 450 ms limit. Green controls do not erase these reds or establish every timing failure as pre-existing; attribution remains open.

Private scratch, probes and failures: `/private/tmp/ss2-SF8sfs`. Verification logs: `correction-full.log`, SHA-256 `fa866f494c0b4cfb5224ed6457d19eaef1f9a9c1f9c370fa4dc53c853844b8a0`; `base-full.log`, SHA-256 `0d3b5742ada9238ddd1028c8319391bb48fc70a2eabf9cfc1fbe0acdd1d83f9b`.

## Cost, limits and leftovers
- Final focused run, `/usr/bin/time -lp`: 3.11 s wall, 0.99 s user CPU, 0.38 s system CPU, maximum child RSS 166,952,960 bytes, including Vitest. The 50-cycle probe retained two sockets before and after, peak five including snapshot clients, maximum three streams. Peak DB/sidecar disk is null: not sampled before cleanup. Retained scratch is 1.5 GiB logical, largely cloned dependencies. No long-history or live-daemon cost claim is made.
- Correction-only native Pi usage at 17:46, 39 assistant records, `gpt-6.1-sol`: input 306,702; cache-write 0; cache-read 9,933,056; output 34,189; summary null (not separately recorded). These are snapshot totals, not final usage. No worker model was started.
- Original 16-of-16 and 20-of-20 numbers are withdrawn as acceptance evidence: that fixture admitted pre-ACK events. No Haiku trial ran. No live profile, subscription or tab was created; `engine-coordinator` was untouched.
- Same-size/same-mtime rewrites and WAL-only changes remain fingerprint limitations. Ignored dependencies, outputs and scratch remain for recheck. The fresh worktree still lacks the configured Husky bootstrap; no hook configuration was changed or bypassed.

## Noticed beyond my task
Full-suite timing variability and the two Codex failures remain for the Shepy seat. The previously reported socket-path budget mismatch remains for the test-runner maintainer. No unrelated runtime or test timing limits changed.

shepystream done: evidence/night/report-shepystream.md
