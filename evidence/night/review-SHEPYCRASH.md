# Review: SHEPYCRASH (row 15.367)

Reviewer: rev-shepycrash (Claude Opus), adversarial, directed by `brief-rev-SHEPYCRASH.md`. Candidate: code `3067443`, report `f62ca13`, base `ef30d4e`. Reviewed in my own worktree, detached at `f62ca13`. Diff read before the brief and the report.

**REVISE.** The candidate implements the binding amendment faithfully, and the wake, context-line and timestamp parts are right. But "Herdr's own word" is not Herdr's observation. Herdr's `agent_session` is whatever a Claude SessionStart hook last reported for that pane. So any Claude started inside a live seat's pane takes the profile from the live seat, along with its pending outcome. On main the same claim is refused.

## Findings
1. **High: a live owner is taken over by a nested Claude in its pane.** Code: `src/herdr/owner-terminal.ts:52-73` and `src/daemon/observability-server.ts:621-631`.
   - Cause: Herdr learns the pane's session only from `~/.claude/hooks/herdr-agent-state.sh` (`pane.report_agent_session`). That hook runs on SessionStart in every Claude whose environment has `HERDR_PANE_ID`, and a child process inherits it.
   - I checked with a fresh HOME and no login that `claude -p "say hi"` fires both SessionStart and UserPromptSubmit. `claude -p /usage` (used by `agent-factory/tools/tanks/meter-legs.ts:96`) fires only SessionStart, so it changes Herdr's view but makes no claim.
   - The seat's hook gate checks only `FACTORY_SEAT` and `SHEPY_PROFILE` (`agent-factory/.claude/settings.json:19`), and a child inherits both.
   - Reproduction (scratch test through the real hook CLI): the seat claims and stays alive. Herdr reports a nested session for pane `w1:p1`. The nested session claims, becomes owner, and receives the seat's pending outcome (state `delivered`, attempt 1). The seat's next prompt is refused with the stale-token warning until the lease lapses (5 min 30 s).
   - Whether the seat ever sees that outcome later: not checked.
   - The acceptance check's assumption that Herdr names "the newer foreground session" does not hold. Herdr names the newest one to report itself.
2. **Medium: the candidate adds a test that times out under load.** `test/integration/claude-hook.test.ts:4321` ("same-pane takeover trusts only Herdr's exact new Claude session") builds 8 full fixtures, with 16 hook processes, inside one test under the default 5 s timeout. It took 1.0 s alone and 5.5 s (timed out) in my full run at load 16; the builder's full run passed it. Fix: split it with `test.each`, or give it an explicit timeout.
3. **Low (decision 132): repeated behaviour.**
   - Tests: 11 added, 2 removed (net +9). Lines: +318 and −79 across the two test files.
   - `a crashed Claude's replacement … (false)` (`:4262`) repeats `takeover fails closed for unreachable` (same pane, no Herdr, token unchanged). Only its `attemptCount` check is new.
   - The `same-pane-error` mode repeats the bad-reply matrix.
   - Suggestion: fold both into the fails-closed table.
   - The removed stale-token test was a true duplicate of the "superseded" test; I checked the two bodies line by line. Removing the `refused-connect` case is correct for the new rule.
4. **Low (suggestion): not every log line is timestamped.** The wrapper (`src/cli/shepy-daemon.ts:12-18`) stamps only `console.*`. Node's own output for an uncaught exception or a process warning bypasses it and stays unstamped. No parser of `shepy.log` exists in Shepy or agent-factory (only a fake in `tools/factory/gauge.test.ts`), so nothing breaks.

## Brief items 1 to 7
1. Takeover: the following all refuse, as specified:
   - a live owner still reported by Herdr, a mismatched pane, terminal, agent, source or kind, a missing or malformed session, and a malformed owner reference;
   - a legacy owner (`profile-delivery-service.ts:499`), a Herdr error, and a reply slower than 1 s (refused in 1.29 s);
   - a delayed proof against a refreshed generation. The token compare-and-set after the await (`profile-owners.ts:176`) also makes the second of two racing claims refuse.

   A claimant from another pane that sends the owner's pane, terminal and the session currently in that pane still wins. The acceptance check accepted this residual. Finding 1 is the case it missed.
2. Wake: `not-connected` is possible only while `connected` is false, which is before any write (`claude-messaging-socket.ts:141-149`). Everything after connect stays `ambiguous` and keeps its reservation, so there is no double wake. After a release the obligation stays pending with its attempt unused, and the next claim delivers it once (the builder's test, rerun green).
3. Context line: it is built only on the `rejected` branch of `handlePromptSubmit` (`claude-hook.ts:642-647`). It is one line, cut to `CONTEXT_MAX_CHARS`, and never sent on Stop. Confirmed by reading and by the test.
4. Timestamps: no log parser exists to break (see finding 4).
5. The two disputed full-run failures are **load timing, not the candidate**.
   - Neither test reaches changed code; `profile-owners.ts` changed in comments only.
   - Each passed 3 of 3 alone on main and on the candidate (P4 533 to 551 ms, snapshot 46 to 65 ms).
   - P4 fixes `now` at start plus 121 s against a 120 s age gate (`profile-service.ts:233`), so a stall of more than 1 s fails it. It took 958 ms in my candidate full run.
   - My main full run at load 24 had five 5-second timeouts and one wall-clock assertion failure in the same files.
6. SHEPYTRIM: seven files overlap (README, `claude-hook.ts`, `claude-idle-wake-service.ts`, `observability-server.ts`, `profile-owners.ts`, `profile-delivery-service.ts`, `claude-hook.test.ts`).
   - `git merge-tree` is clean against both `331bacc` and `b60f207` (b60f207 is presumably the F1 fix; its worktree has no uncommitted source).
   - The merged tree typechecks. Its hook, delivery and socket tests gave 232 of 234 with two 5 s timeouts under load; both timeouts passed 2 of 2 alone on the merged tree and on the candidate. The changes compose.
7. Test counts: see finding 3.

## Checks (Node 24.18.0, `env -i`, fresh HOME and TMPDIR; never the live daemon)
| Check | Result | Wall time |
| --- | --- | --- |
| Targeted hook and socket tests, candidate | 199 passed (first run used Node 26.5 by mistake; later runs used 24.18.0) | 33.5 s |
| Nested-Claude attack, through the hook CLI | Takeover reproduced, twice | about 0.35 s per run |
| Two disputed tests, 3 times each on main and on the candidate | All 12 runs green | about 2 s per run |
| Full suite, candidate, under `lockf`, load 16 | 38 of 1,294 failed: the 37 known failures on main plus finding 2 | 115.5 s |
| Full suite, main control, under `lockf`, load 24 | 43 of 1,285 failed: the 37 known plus 6 timing failures | 94.5 s |
| Candidate `tsc` and `biome check` | Exit 0 | `tsc` not timed; `biome` 1.4 s |
| Merged tree with SHEPYTRIM | Typechecks; tests as in item 6 | — |

Scratch (probe test, logs, main and merged snapshots): `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-rev-shepycrash/9b6c28f5-93a9-4edb-9966-9c19626b1451/scratchpad`.

## Limits and next owner
- Not checked against live Herdr: whether `pane.process_info` could tell a nested Claude from a replacement. I did not observe a real restart.
- Options for finding 1, for the seat to decide (recommended first):
  - (a) The daemon also requires Herdr's `pane.process_info` for the owner's pane to show exactly one `claude` process. This needs a live check that a child of the Bash tool appears there.
  - (b) The hook refuses to claim when one of its ancestors is another Claude above its own.
  - (c) Accept the hole and add a seat rule: a nested `claude` must start without `HERDR_PANE_ID`, `FACTORY_SEAT` and `SHEPY_PROFILE`.
- Next owner: the seat, which decides on finding 1 and then sends a correction to the builder.

## Noticed beyond my task
- The Shepy suite on main is not reliable under normal factory load. At load 24, six tests failed on time limits (5 s timeouts and one wall-clock assertion) besides the 37 known failures. A full run means little above load 15. Suggested owner: the Shepy seat (test timeouts, or a lower load ceiling for the lock).
