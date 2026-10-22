# Review SHEPYSTREAM (row 15.368): REVISE

Reviewer rev-shstream (Sonnet), blinded discovery, read-only. Candidate Shepy `961ca2c` on base `7aa8adb`. Node 24.18.0, `env -i`, fresh mode-0700 HOME and TMPDIR, no Claude messaging variables. Machine-verified only; not installed, not Ray-verified.

**Verdict: REVISE.** The deaf window for existing panes is closed and resources are bounded. Four defects remain; F1 is a regression from base, and F2 to F4 are outcome loss or duplication in the exact windows the brief names. The 16 of 16 and 20 of 20 numbers are fixture numbers only; the live Haiku trial was not run, and the fixture delivers events before the subscription ACK, which real Herdr does not.

## Findings

**F1 HIGH, regression: a stale pane id wedges the watcher forever.** `src/daemon/herdr-session-watch-manager.ts:264` seeds `paneIds` from the database rows, and `:271-276` subscribes to them before any snapshot. Real Herdr 0.9.3 rejects the whole subscription with `{"code":"pane_not_found"}` when one `pane_id` does not exist (checked against a throwaway `herdr server` with its own HOME and socket, since stopped). The `catch` at `:309-317` retries with the same `paneIds` and never refreshes, so the loop never recovers.
- Reproduction A2: index two panes, close one while the daemon is down, start the manager. Result: 70 identical subscribe attempts in 1.5 s, zero outcomes for a later turn on the live pane. Base passes the same test.
- Same wedge online (A1): a pane that closes between the snapshot and its subscription. The old stream keeps working, but the loop retries the dead pane forever (1 per second at the default delay), never refreshes, and no later new pane is subscribed.
- Fix: after a failed data-stream open, refresh the snapshot before retrying, or take the snapshot first as base did. Add one test with a fixture that rejects unknown panes.

**F2 MEDIUM, lost outcome: stream `done` handled before the catch-up snapshot.** `src/observability/agent-index-service.ts:572` refreshes and persists history for a status event, and `:682` drops `done` to `done`. A turn that straddles a new subscription's ACK (working missed, `done` delivered after it) therefore records nothing, and the snapshot then sees an already-current cursor. Reproduction A3: a new pane's turn with only the `done` event after the ACK gives 0 outcomes; the same run without the `done` event gives 1; the control with working and done after the ACK gives 1. The candidate's disconnect case (turn 39) passes only because its fixture writes events before the held ACK. A snapshot that wins the race gives 1 (A3b), so this is an ordering race, not a constant. Fix: treat a same-status event with a changed final as a reconciled completion, as the snapshot path does.

**F3 MEDIUM, duplicate outcome: snapshot-final then the stream's own pair.** For a pane not yet covered (new, or reconnecting), a snapshot whose history read follows the whole turn records `done` to `done` with `snapshot-final:<ref>`. The stream's `working` then `done` for the same turn records a second completion with the same final reference. `profile-delivery-service.ts:365` suppresses only when `from` is `done` or `idle`, so working to done delivers. Reproduction A5: events `done>done`, `done>working`, `working>done`; 2 obligations for one turn. The seat is woken twice. Fix: compare the final reference with the prior settled event for working to done as well, or mark the stream's completion as the same turn.

**F4 MEDIUM, backstop yields forever on a covered pane.** `agent-index-service.ts:433,480`: while a stream covers the pane, a changed settled final is left to the stream and the cursor never advances. If Herdr emits no status event (a turn shorter than its detection poll, which the research did not test), nothing is ever recorded until the stream drops. Reproduction A4: transcript final changes, no events, a topology refresh and a full rescan: 0 outcomes. Cost side: a stale cursor makes every refresh re-stat and re-resolve that agent. Suggest a bounded grace (for example one refresh cycle) after which the backstop records the done.

**F5 LOW:** (a) A stream that ACKs then closes at once reconnects with no delay (`:299` continues; delay only on error). (b) The README line "Pending completion outcomes ... A reused name" is unchanged, but the README now says overlapping subscriptions cannot replay; true only for disjoint pane sets, which is what the code does. (c) Same size and same mtime rewrite is undetected, as the report says; a clock moving back is detected because the test is `!==` (read, not run).

## Checks I ran
- Passed: `tsc` 3.7 s; biome 2.2 s; 5 focused files, 50 tests, 10.6 s (including both new files, 5 repeats of `short-turn-stream`, 0.7 s each alone).
- Resources (R1): 50 pane create and close cycles with unique ids: server-side sockets 2 before, 2 after, peak 5 (transient snapshot clients), max data streams 3. Bounded; retired streams close. Pane id reuse (R2, 5 rapid close and recreate cycles): 1 outcome, no leak.
- Full suite under `lockf -k /private/tmp/shepy-full-suite.lock`: candidate 8 failed, 1137 passed, 69 s; base `7aa8adb` 4 failed, 1139 passed, 65 s.
  - Both: Codex `agent-history-readers` default service, `observability-rpc` agent.read.
  - Base only: `notice-correctness` five missing finals, `herdr-plugin-package`.
  - Candidate only: `short-turn-stream` flagship test (5 s timeout under load; passes alone 5 of 5), `agent-lifecycle` P4, `claude-hook` empty identity, two `notice-correctness` tests, `profile-subscribe`. Re-run in groups they pass, except one `notice-correctness` rollback test that timed out once at 5.3 s with six files in parallel and passed 3 of 3 alone on both trees. I read these as load timeouts, not shown to be caused by the change; the new test is a load-sensitive addition (39 sequential turns against a 5 s default).

## Decision 132
Two tests, 367 lines (about 190 of fixture). Each bundles many behaviours: the first covers a control, 16 refresh turns, handover, rescan, working count and disconnect; the second covers about eight. A failure names none of them. Neither exercises F1 to F4; both use a server that delivers events before the ACK and never rejects an unknown pane. Ask for fewer, better tests: one for F1, one for F2 and F3 together. The edit to `herdr-session-watch-manager.test.ts` changes `subscriptions` from 0 to 1, which weakens the old "no subscription after retirement" check; fine, but name it.

## Limits
Live Haiku trial and live Herdr timing not run (builder disclosed). Probe sources and logs: `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-rev-shstream/8a713fb5-7c48-489b-b1db-c1788dda245a/scratchpad` (`exp-cand/test/integration/attack.test.ts`, `attack-fixture.ts`, `full-cand.log`, `full-base.log`). The probes are copies outside the candidate tree.

## Noticed beyond my task
- Herdr rejects a whole `events.subscribe` for one unknown `pane_id`; any code that subscribes from stored ids needs a refresh on that error. Owner: Shepy seat.
- The full gate fails on base too (4 reds); the load-timeout catalog is still open. Owner: Shepy seat.

Next owner: builder for F1 to F4, then a recheck.
