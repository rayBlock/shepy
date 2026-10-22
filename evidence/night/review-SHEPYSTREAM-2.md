# Review SHEPYSTREAM recheck: ACCEPT WITH FIXES

Reviewer rev-shstream (Sonnet), recheck of my F1 to F5 against Shepy `1b3f9d7` (`git diff 961ca2c 1b3f9d7`, one commit on `night/shepystream`). Compared with main `fb15e54`. Node 24.18.0, `env -i`, fresh mode-0700 HOME and TMPDIR, no Claude messaging variables. Machine-verified only; the live Haiku trial is still not run, so nothing here is Ray-verified.

**Verdict: ACCEPT WITH FIXES.** All five original findings are fixed in my reruns. The remaining fixes are a mechanical merge conflict with main and one low-risk dedup note, neither a reason for another build round. Not installed.

## F1 to F5, rerun against `1b3f9d7`
My probes (same sources as round one, outside the tree) now give exactly one outcome each:

| Probe | Round one (`961ca2c`) | Now |
| --- | --- | --- |
| A1 pane closes between snapshot and subscribe | endless retry of the dead pane, no refresh | 1 refusal, then a snapshot, then recovery; 3 subscribes in all |
| A2 restart with a stale indexed pane | 70 retries in 1.5 s, 0 outcomes | 2 subscribes (one rejected, one snapshot-fresh), 1 outcome |
| A3 new pane, only `done` after the ACK | 0 outcomes | 1 outcome (`done>done` recovered from the changed final) |
| A5 snapshot-final then the stream's working and done | 2 outcomes | 1 outcome |
| A4 covered pane, no status events | 0 outcomes | 1 outcome (after the second refresh) |
| R1 50 create and close cycles | sockets 2, peak 5, 2 | same: 2, peak 5, 2 |
| R2 pane id reuse, A3c control, A6 interrupted turn (new user line, no assistant line) | 1, 1, 2 | 1, 1, 2 |

A3b (existing stream drops, working missed) still gives 1 outcome. My probe's old assumption of two sockets after reconnect is gone: the primary stream now reopens with all uncovered panes, leaving one socket. That is a probe change, not a defect.

- **F1:** `herdr-session-watch-manager.ts` sets `needsSnapshot` on any failure and refreshes before retrying, so stale ids are no longer reused. If the refresh itself fails, ids stay unused.
- **F2 and F3:** a same-status stream event records a changed final (`#hasNewSettledFinal`, `agent-index-service.ts`), and `profile-delivery-service.ts` now suppresses a repeated final for working to done too, comparing final reference, source and session.
- **F4:** a covered pane gets one refresh cycle (`#coveredSettledFinals`), then the backstop records it.
- **F5a:** reconnect waits `reconnectAt`; a fake-timer test checks the delay.

## Fixture and tests
`test/integration/short-turn-fixture.ts` now acts like real Herdr: a stream is registered and events written only after the ACK is sent, and an unknown pane id gets `pane_not_found` (checked against my round-one throwaway `herdr server`). The two bundled tests are replaced by four: F1, F2 and F3 together, F4, and the topology-refresh control. Red proof: with the new fixture and tests copied onto `961ca2c`, F1, F2/F3 and F4 fail and the control passes. Five repeats on the tip: 4 of 4 pass, 0.7 s each.
- Still two bundled cases (F1 holds a stale-at-start and a closing-pane case; F2/F3 holds two behaviours). The F1 assertion on the first rejection is conditional and is skipped if the watcher avoids the rejection; the second half still binds. Suggestion only.
- The old "no subscription after retirement" unit check became "the one subscription was not aborted"; fine.

## Checks
- `tsc` 2.7 s, biome 0.3 s, both clean; 130 focused tests in 5 files pass (9.9 s).
- Full suite under `lockf -k`, `scripts/run-tests.mjs`: tip 4 failed, 1143 passed, 63 s; main `fb15e54` 2 failed, 1168 passed, 90 s.
  - Tip: the two Codex tests (`agent-history-readers`, `observability-rpc`) fail on `7aa8adb` and the tip, and pass on main because main has the test fix `25a83db`. The other two (`claude-hook` queued socket batch, `herdr-plugin-package`) are 5 s load timeouts; both pass when rerun together (136 tests). None involves the stream code.
  - Main: `claude-hook` owner-file durability and `notice-correctness` five missing finals; both are timeouts in that run, so main is not green either. Nothing new on the tip fails in a way main does not.

## Remaining
1. **Merge conflict, MEDIUM for landing.** `git merge-tree fb15e54 1b3f9d7` conflicts in `test/integration/notice-correctness.test.ts` (the tip's three `onSubscribed` and `refresh` additions against main's large edit); source files merge cleanly, including `socket-client.ts` and `profile-delivery-service.ts`, but I did not run the merged tree. Owner: seat or builder; a recheck after the merge is needed before landing.
2. **LOW:** `sameRecordedTurn` keeps the prior final's reference when both the final and the user message reference match, which lets projection suppress it. A genuinely new turn whose transcript has flushed neither its user line nor its final within the retry window would then be suppressed, not delivered with empty text. A6 (user line flushed, no final) still delivers. I did not construct the both-lagging case. Owner: builder if the seat wants it closed.
3. **Not run:** the live Haiku trial and real Herdr timing.

## Noticed beyond my task
- Tip and main are based on different bases (`7aa8adb`); the two Codex reds are already fixed on main, so a landing run will look cleaner than this one. Owner: seat.
- Probe sources and logs: `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-rev-shstream/8a713fb5-7c48-489b-b1db-c1788dda245a/scratchpad` (`exp-tip/test/integration/attack*.ts`, `full-2-tip.log`, `full-2-main.log`).
