# SHEPYSTREAM

PARTIAL. Option 1 removes topology and rescan deaf windows; fixture trials caught **16 of 16 restart-window turns and 20 of 20 base turns**, without duplicate outcomes. The requested live Haiku trial is unrun, and the full gate is red.

Candidate: the commit containing this report, based on `7aa8adb`, branch `night/shepystream`. Machine-verified, not independently accepted or Ray-verified. Next owner: independent reviewer, then the Shepy seat.

## Acceptance block (recorded before coding)
- Remove the stream restart deaf window, trying overlapping subscription or subscribe-before-snapshot first. Do not change Herdr.
- Also reconcile an unchanged settled status when its authoritative final assistant reference changes; use a cheap transcript fingerprint, not pane revision.
- Do not double-deliver overlapping or replayed events.
- Requested live proof: 16 restart turns and 20 base turns on a throwaway profile and Haiku worker. Never touch `engine-coordinator`, install, or restart the live daemon.
- Run focused tests, TypeScript and Biome, then the full suite under `/private/tmp/shepy-full-suite.lock`, all with `env -i`, fresh private HOME and TMPDIR, and no Claude messaging variables.
- Independent review follows this build. Commit the candidate and this report in the assigned worktree.

## Implementation and proof
- Healthy existing pane streams remain open through snapshot refreshes. Only newly discovered panes get a new subscription, acknowledged before another snapshot. Disjoint pane sets avoid unsequenced status replay; data streams retire when all their panes disappear. The primary stream carries global lifecycle events. Periodic rescans no longer retire healthy watchers.
- Option 2 was unnecessary and unavailable: installed Herdr 0.9.3's schema requires `pane_id` for status subscriptions. Herdr was not changed.
- The backstop stats the bound transcript's size and mtime, refreshes changed history at revision 1, and records a changed settled final once. Events persist before the cache cursor advances, preserving recovery after append failure. Healthy covered panes leave completion to their stream without consuming that recovery cursor.
- Two new permanent tests use actual JSON Lines sockets, migrated SQLite, the Claude reader, the index and profile obligation projection. No test was removed. Existing watcher mocks now acknowledge subscriptions; no timeout was extended.
- The stream fixture includes 20 base turns, 16 turns wholly inside blocked topology snapshots, one blocked subscription ACK, one full rescan, and one physical disconnect: **39 ordered outcomes, no duplicates**. All first 38 working transitions are present; the disconnected turn may be buffered or recovered from its final. Five final repeated fixture runs passed.
- The second test covers startup silence, unchanged snapshots, index restart, seen-state changes, projection replay, append failure, and disconnect recovery after a covered snapshot. Four distinct finals yield four obligations.
- Red proof against the base caught both the restart loss (after the passing 20-turn control) and absent same-status recovery. An intermediate overlapping implementation duplicated a turn; retaining disjoint streams fixed it. A reconnect probe initially incorrectly required a lost working transition; the final test checks exact working coverage before disconnect and exact outcomes after it.

## Checks and retained failures
All checks used fresh mode-0700 HOME and TMPDIR with `env -i`; the three Claude variables were absent. Tools: Node 24.18.0, pnpm 11.9.0, TypeScript 6.0.3, Vitest 4.1.9, Biome 2.5.1. Dependencies were copied from an existing local checkout, not installed. pnpm's fresh-home dependency check initially attempted an install and refused before removal; later commands used its warning-only mode, without changing repository configuration.

| Check | Exit and wall time |
| --- | --- |
| Focused seven-file group | 0; 142 tests; 15.93 s |
| Final stream, socket and watcher group | 0; 19 tests; 2.05 s |
| Final TypeScript, Biome, build | 0; 4.70 s, 1.22 s, 2.09 s |
| Format, DB, root package, Pi package, Herdr plugin | 0; 0.40 s, 1.80 s, 4.79 s, 5.44 s, 3.13 s |
| Final `lockf -k /private/tmp/shepy-full-suite.lock pnpm check` | 1; 1,138 passed, 7 failed; 78.53 s; both new tests passed |
| Subsequent notice, plugin-package and test-runner controls | 0; 51 tests; 13.82 s |

The final full gate's two Codex history failures reproduce on an archived copy of exact base `7aa8adb`. Its other five failures were 5-second timeouts in the hook, socket identity, notice retry, plugin package and test-runner tests. Baseline controls also timed out in a different hook case; this does **not** establish every timeout as pre-existing. Shorter isolated controls passed, but the red gate remains unresolved. Earlier full runs and their failures remain retained, including six Unix socket failures caused by a 105-byte test path; the shorter-TMPDIR socket control passed all ten cases.

Private scratch and all raw logs: `/private/tmp/ss-g6yDf8`. Required verification logs: `pnpm-check.log` SHA-256 `6feec4a5c799f0e342debae0d911381404fe0f59353fd40b451ec9c5e777ace3`; `baseline-controls.log` SHA-256 `9882d9f7b90496a010234d20bcc0cc6bed79f7c1277b4706b7b25ba7de2e9006`.

## Cost, limits and leftovers
- `/usr/bin/time -lp`, final 39-turn fixture run: 1.30 s wall, 0.76 s user CPU, 0.28 s system CPU, maximum child RSS 162,840,576 bytes. Coverage includes the runner and Vitest subtree, not an isolated daemon. Peak streams: three for two observed panes; retired streams and fixture sockets close on cleanup. Each additional retained data stream must own a still-present pane.
- Native Pi usage snapshot at about 17:05, model `gpt-6.1-sol`: input 208,653; cache-write 0; cache-read 10,942,720; output 42,658; summary null (not separately recorded). These are cumulative session counters, not final totals. No worker model was started.
- Logical retained disk: scratch 395 MiB, copied local dependencies 377 MiB, build output 2.1 MiB. Peak fixture DB and sidecar disk is null because it was not sampled before teardown. Live daemon CPU, memory, disk and trial latency are null because no live daemon trial ran. Repeated inputs append real fixture history; no long-history or sustained-idle scale claim is made.
- The current user forbids messaging other agents, so no Haiku prompts were sent. No live profile, subscription, tab or daemon was created, restarted, installed or changed; `engine-coordinator` was untouched. The 1-to-26-second live timing trial remains an acceptance gap, not a fixture equivalent.
- The fingerprint backstop cannot detect a rewrite preserving both size and mtime; SQLite WAL-only changes are not covered by the existing primary-file fingerprint. Live and long-history behavior remain unverified.
- The configured `.husky/_` bootstrap is absent in this fresh worktree. No hook configuration or tracked hook was changed or bypassed; check components were run explicitly. Ignored local dependencies, build outputs and private scratch remain for review.

## Noticed beyond my task
- `scripts/run-tests.mjs` budgets a shorter socket suffix than `claude-socket-identity.test.ts` actually uses, allowing an overlong path. Suggested owner: test-runner maintainer.
- The full gate has unresolved timeout variability beyond the two reproduced Codex failures. Suggested owner: Shepy seat. This packet does not change those tests, the hook, owner storage or observability server.

shepystream done: evidence/night/report-shepystream.md
