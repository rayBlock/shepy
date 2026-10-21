# rev-s5: independent review of Shepy slice 5 (notice text for every harness)
Identity: rev-s5; branch `night/rev-s5`; candidate `a5bc4f9` (code `f5d689f`, base `50ca705`), reviewed detached in a scratch worktree with a real offline `pnpm install`. Brief `brief-rev-S5.md`; acceptance `acceptance-check-2.md` section S5. The brief asked for `review-S5.md`; my prompt named this path, so this is the review.

**ACCEPT WITH FIXES.** Screen text is read only for reader-less kinds, only from the right pane, bounded, and kept off every surface except the event copy. Three fixes are needed. One renderer still shows the text unmarked (finding 1). One README sentence is wrong for snapshot batches (finding 2). One S5 test has too little timing margin and went red in the full suite (finding 3). No S1 or S4 regression: every other red I saw also happens on the base.

## Findings
1. **Medium: `shepy inbox get` shows screen text with no mark.** `src/cli/shepy.ts:1904-1931` (`formatInboxGet`) prints `excerpt:` then the text, and prints `(no assistant message)` for `screen-unavailable`. It never reads `textSource`. This is the one human read-back of a notice, and it is the third renderer next to the hook and the Pi wake. Reproduce: `runCliCommand(parseCliArgs(["inbox","get","ob-1"]))` with a fake RPC client returning `outcome: {excerpt:{text:"prompt chrome and screen words"}, textSource:"screen"}` prints the words under `excerpt:` with no label (probe P-G). Fix: label it `screen text (not an assistant answer):` and print `(screen text unavailable)` for that source.
2. **Low: README says "a slow pane delays only its own notice". That is false for snapshot batches.** `agent-index-service.ts:538-596` runs every pending completion of one refresh in a single `Promise.all`, and the refresh resolves only when the slowest screen read ends. Probe P-B: two reader-less panes complete in one snapshot refresh and one read hangs. The fast pane's notice is published after 2,260 ms instead of about 500 ms. On the event path the fast pane takes 507 ms, which is correct. The watcher also awaits this refresh before it subscribes (`herdr-session-watch-manager.ts:240`), so at a watcher start or restart a hung read adds up to 1.75 s before events are read. The wait is bounded, so this is not a stall. Fix: correct the README sentence (`README.md:59`), or publish each pending completion as it finishes.

3. **Low: an S5 test times out in the full suite.** `test/integration/screen-text-notice.test.ts:266` ("a slow read for one pane…") needs about 2.3 s against Vitest's default 5 s timeout. In my full suite at load 28 it hit `Test timed out in 5000ms`. On its own it took 2.26 to 2.44 s every time, including 6 parallel copies, so this is load, not a hang. The same thin margin applies to `:252` (deadline, 4.5 s bound) and "done then idle" (3.8 s once under load). Fix: give these three tests an explicit timeout of about 15 s.

## The seat's seven questions
1. Pane isolation holds. In the test, two panes finishing together each carry only their own text. A reply naming another pane is dropped. A reply with no `pane_id` is also dropped (probe P-C). A failed read sends a notice with `(screen text unavailable)`. Live check on my own pane (`w3J:p1B6`): Herdr's `agent.read` reply `read.pane_id` matches the snapshot's `pane_id` form, in 95 ms. Limit, from before S5: if the pane really closes and its agent row is deleted before the append, no notice goes at all (`projectAgentEvent` needs the live row). The test simulates "closed" only as a read error.
2. Reader kinds never read the screen. Probe P-A: all six kinds (claude, codex, gemini, hermes, opencode, pi) with no transcript made 0 reads. The candidate test covers pi with a transcript.
3. The bounds hold. Raw input is cut to 64 KB before any regex. 100 bounds of a 64 KB input full of whitespace took 56 ms. Output is 20 lines and 1,500 characters. The deadline is 1.5 s on the Herdr request plus 1.75 s on the race, and the hung-read test ends at about 2.3 s. Bidi override and zero-width characters (U+202E, U+200B) pass through. That is not a control byte, so it is not a defect; a suggestion is below.
4. Screen text reaches no other surface. Probe P-E: after a screen notice, the marker string is in `agent_events` only. It is in no other table: not the context snapshot, the agents row, the history cache or the obligations.
5. done then idle gives one notice, and a new turn notifies again. Probe P-D: working to done to idle gives 1 notice. **The limit is acceptable, not a defect**, because the suppression applies only to the first settled change after a screen completion. Two side effects:
   - working to idle to done, with no working seen between, gives 0 notices. In Herdr's model, idle to done is a new unseen completion.
   - working to done to idle to done gives a second notice with no text and `textSource` null.

   Both need a missed `working` or an idle-to-done flap, and I could not prove either one live. Suggestion: suppress only done to idle (`profile-delivery-service.ts:277`, `:549-553`).
6. No S1 or S4 regression. I ran each file on the base and on the candidate, alternating, at the same load. `notice-correctness` timing reds were 1, 0 and 4 on the base and 0, 2 and 2 on the candidate. The tests were "snapshot completions … retry delay", "five missing finals … one wait" and "P6 …". `claude-hook` 5 s timeouts were 0, 0 and 4 on the base and 1, 5 and 0 on the candidate. The failing tests differ from run to run. Every red is a timing bound or a 5 s timeout, at load 10 to 24.
7. `screen-text-notice.test.ts` ran 5 times out of 5 green (TMPDIR `/private/tmp/rs5.XXXX/t`, load 9 to 15, 14.6 to 32 s wall). In the slowest run, "done then idle" took 3,847 ms against the default 5 s test timeout. It normally takes about 1.1 s. **It is load, not a production defect**, but the test margins are thin (finding 3): it went red once in my full suite. This is the same class as the S1 timing reds on the base.

## Checks
All runs used `env -i` with a fresh HOME and TMPDIR under `/private/tmp/rs5.*`. CLAUDECODE and both messaging variables were absent. Node 24.18.0 came from mise, with a real `pnpm install --offline --ignore-scripts` (no symlinked node_modules).
- `tsc --noEmit` exited 0 in 12.7 s. Biome found nothing in the 8 touched source and test files.
- I ran 17 focused files: S5, S1 (`notice-correctness`, `agent-history-identity`, `agent-context-service`, `agent-index-service`, history unit tests), S4 (`claude-hook`, lapsed-recovery), Pi wake and extension, socket client, profile-delivery and outcome-context. 608 of 613 tests passed in 118 s at load 24. The 5 reds are the load-timing class described in question 6.
- Full suite with `node scripts/run-tests.mjs` (real install, its own Vitest entry, the shared gate lock held, started at load 28): 1,169 passed and 41 failed in 101 s.
  - 35 are in `claude-profile-demand-validation`: "fixture source pairing mismatch: src/cli/claude-hook.ts". The fixture's pinned hashes for `claude-hook.ts`, `shepy.ts`, `claude-hook.test.ts` and `README.md` already fail to match base `50ca705`, so this is from before S5.
  - 2 are Codex history tests in `agent-history-readers` and `observability-rpc`. They fail the same way on the base (see Noticed).
  - 4 are 5 s timeouts. 3 are the load class also seen on the base; the fourth is finding 3.
- The first full attempt waited 20 minutes for the lock and gave up. The second got the lock but started at load 57, above the limit of 40, so I discarded it.
- Probes P-A to P-G are in `zz-rev-s5-probe.test.ts` in my scratch folder, not in the candidate.

## Cost
- A live `agent.read` of 60 lines took 95 ms and returned 1,982 raw characters, bounded to 1,500.
- Each reader-less completion costs one read. Reader kinds cost nothing extra.
- A hung read adds at most 1.75 s, and in a snapshot batch the other panes wait for it (finding 2).
- Disk: an event row grows by at most about 1.5 KB.
- Tokens: none.

## Suggestions (not required)
- Old renderers show screen text without the mark. A Pi session started before the upgrade renders it as `last assistant:` (`wake.ts` before S5), and an older hook adds "[truncated; use shepy agent read before acting]". If the daemon put the mark in the excerpt text itself, the label would survive version skew.
- Strip Unicode format characters (category Cf: bidi overrides, zero-width) in `boundScreenText`.
- The Pi wake does not say when the 1,500-character bound cut the text, because `truncated` stays false.

## Noticed beyond my task
- From S1, before S5: a done to idle change after a startup unknown to done without text notifies with "(no assistant message)", because the startup event is silent but has no reference to dedupe against. Owner: seat (S1 follow-up).
- On base `50ca705`, the strict demand fixture is effectively NOTRUN: its pins (`claude-profile-demand-validation.test.ts:64-75`) no longer match four files. S5 changes two pinned files again. Owner: seat; whoever repins needs the S4 and S5 hashes.
- `agent-history-readers.test.ts:334` and `observability-rpc` "reads additional runtime histories" fail on the base too. Their Codex session fixture is dated 2026-07-09, which looks like a test that broke as the calendar moved on. Owner: seat.
- `discovery.ts:149` maps any session `source` containing "pi" to the Pi reader (for example "copilot"). Owner: seat.

Private scratch: `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-rev-s5/22039f5d-09a2-4f1b-a755-6f8fae88d6b4/scratchpad/` (logs, probes, `cand` and `base` worktrees).
