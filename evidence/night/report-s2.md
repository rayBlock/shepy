# s2 — lifecycle and self-cleaning
Worktree: `/Users/ray/dev/shepy-wt/night-s2`; branch: `night/s2`; base: `50ca705`.
PARTIAL — implementation and fixture acceptance built; full-suite gate remains blocked by the shared lock. Candidate is this report's commit. Next owner: factory seat and independent reviewer.

## Acceptance block (recorded before coding)
```acceptance
{
  "kind": "build",
  "real_use": "The seat subscribes three workers; one finishes and its pane is closed by the seat; the seat gets that worker's done notice and then exactly one gone notice, and the subscription row is gone. A worker whose agent exits but whose pane stays open gives gone once too.",
  "unhappy_paths": "Herdr event stream drops and reconnects (missed close); pane closed before the done notice was delivered; daemon restart with stale rows; a name reused by a new agent in another pane.",
  "attack_tests": [
    {"probe": "Close the pane of a subscribed worker while the daemon is stopped, then start the daemon: one gone notice and the row removed on the first tick, not zero and not two.", "good_input_control": "Live close while running: one gone notice."},
    {"probe": "A new agent takes the old worker's name in a different pane: the old subscription does not follow the name to the new agent.", "good_input_control": "The new agent subscribed explicitly gets its own notices."},
    {"probe": "Done notice still pending when the pane closes: the done notice is delivered before or with gone, never dropped.", "good_input_control": "Normal order done then gone."}
  ],
  "running_cost": {"time": "watch tick wall before and after", "cpu": "daemon CPU over 10 minutes idle", "memory": "daemon RSS", "disk": "store size after 100 start-close cycles", "tokens": "null", "expected": "no new polling loop; prune is O(rows) per tick"},
  "ray_check": "none visible; the board's worker list stops showing dead subscriptions"
}
```
Binding amendments: [acceptance-check-2.md](/Users/ray/dev/agent-factory/evidence/night/acceptance-check-2.md), S2. Sources re-grepped against this worktree, not the acceptance check's old line numbers.

## Built and acceptance proof
- Herdr 0.9.3 schema confirms global `pane.agent_detected`, `pane.exited`, `pane.closed`, `pane.created`, `pane.moved`, `workspace.closed`; there is no separate agent-exited event. All six are now subscribed (`socket-client.ts:273`).
- Prior identity, pending-final recovery, gone projection and subscription removal share the index replacement transaction (`agent-index-service.ts:258`, `agents.ts:84`, `profile-delivery-service.ts:223`). Gone does not resolve through a replacement's live name. OpenCode recovery uses a composable savepoint.
- Watch refreshes drive two-minute age pruning only after a complete healthy snapshot, scoped to that session (`herdr-session-watch-manager.ts:304`, `service.ts:174`). Moves carry uniquely resolved subscriptions within the transaction, including legacy pane selectors.
- 19 lifecycle tests cover three workers, actual status then close, exit into an open shell, disconnected stream, reused names, two profiles, explicit unsubscribe, missing-final retry, projection rollback, moved panes, unavailable and malformed snapshots, stopped sessions, aged live rows and silent legacy prune. Socket tests use real JSON Lines sockets, real index/delivery services and migrated SQLite; leases prove done precedes gone.
- Separate actual daemon processes, a fixture Herdr producer and public RPC prove an offline close is reconciled on startup, with one obligation unchanged after a second process restart. These are fixture acceptance, not a claim of live Herdr or board verification. The real daemon was not restarted; nothing was pushed.
- Policy: if the agent identity was deleted before upgrade, its legacy unmatched subscription age-prunes silently. Attribution cannot honestly be recovered. Ambiguous and invalid subscriptions remain.

## Checks and retained failures
All gates used empty private HOME and TMPDIR with `env -i`; the three forbidden Claude variables were absent. Node 24.18.0, TypeScript 6.0.3, Vitest 4.1.9 and pnpm 11.9.0 used existing linked dependencies; no dependency install completed.
- Final focused run: 134 tests, seven files, exit 0, 27.53 s with one worker. Typecheck: exit 0, 7.81 s.
- Lint, formatting, DB check, build, root package, Pi package and Herdr plugin checks: exit 0; respective walls 2.06, 0.72, 1.19, 4.70, 8.43, 5.05 and 2.36 s. Diff whitespace check passes.
- Full Vitest and `pnpm check`: lock acquisition exits 75 after five seconds; an earlier 120-second wait also never entered the gate. No shared-lock bypass. The supported test runner independently refuses the external node_modules symlink, so the brief's direct Vitest fallback was used for focused checks.
- Retained reds: initial 11 lifecycle failures; OpenCode nested-transaction regression reproduced before its fix; socket fixture decoder error fixed. A later parallel focused run had 133 passes and one existing test's 5-second timeout (`profile-delivery.test.ts:3095`); identical baseline and candidate isolated controls passed, as did the serial run. This does not erase the unreproduced timeout or establish it as pre-existing.
- First pnpm attempts refused its automatic dependency reinstall before running checks. Successful reruns used the installed pnpm path and `pnpm_config_verify_deps_before_run=warn` to reuse the tree without installing. Git hook configuration is unchanged; its configured `.husky/_/pre-commit` is absent here.

## Running cost and provenance
Private scratch, raw logs, scripts and measurements: `/private/tmp/shepy-s2.0BCYy7`. Runtime result SHA-256: `1174c2139ecbd4225fbeca718b45552135a20aed0e3cbf61ab4e4ccaeb7a7ca6`.
- Real 600-second idle wait, three subscribed idle workers, baseline versus candidate daemon PIDs only: `ps` CPU time rose 0.19 s each (about 0.032 percent of one core); final RSS 110.4 versus 109.6 MiB. Producer, driver and transient Herdr CLI children are excluded. Nine snapshots each during idle; no additional polling loop.
- Scratch-only instrumented 65-second run: first five ordinary ticks ranged 0.16–3.11 ms before and 0.21–3.09 ms after; full-rescan tick 3.49 versus 2.59 s. Shared-host scheduling and fixture CLI startup make these noisy, not a performance improvement claim.
- Actual candidate daemon: 100 detect-subscribe-close cycles in 9.18 s; database 184 to 260 KiB, WAL and SHM sidecars absent at sampled boundaries (rollback-journal peaks unmeasured); 100 additional gone events and two original live subscriptions remaining. The offline-close probe accounts for the 101st gone row. CPU idle run predates the OpenCode-only savepoint correction; the 65-second run used the corrected source.
- Input, cache-write, cache-read, output and summary tokens: null; per-model API usage is unavailable to this worker. Fixture daemons perform no model inference. Retained event history grows linearly; no retention policy was added.

## Limits, leftovers and noticed beyond my task
Live Herdr and board acceptance, independent review, the full suite and timeout investigation remain with the seat. Own test daemon processes are stopped. The untracked `node_modules` symlink is retained and excluded from the commit.
Noticed beyond my task: `agent-events.ts:151` recovers finals by scanning retained agent events; there is no event-log retention or agent-id index in `schema.ts:86–107`. Added gone rows therefore accumulate, and recovery cost grows with retained history. Suggested owner: Shepy seat for a separately scoped retention and indexing decision.
