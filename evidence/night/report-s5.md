# S5 notice text for every harness, and current docs
Identity: s5; branch `night/s5`; base `50ca705`; candidate = the commit containing this report (code in `f5d689f`). Brief `brief-S5-text.md`; independent amendments `acceptance-check-2.md` section S5 (applied below).
**BUILT (machine-verified; not live-verified).** A completion notice (working to done or idle) for an agent kind with no history reader now carries the last lines of the pane, marked as screen text. Live acceptance on a real reader-less agent is open: every agent on this machine today is Pi or Claude, and I did not start one. Next owner: factory seat, for the independent recheck, the full gate and one live run.

## Acceptance block (recorded before coding; amendments applied)
```json
{"kind":"build","real_use":"A detected agent kind with no reader (for example cursor, amp, droid) finishes; the notice carries its last visible screen text, marked as screen text.","unhappy_paths":["alternate-screen pane returns little","huge output","ANSI and control bytes","read fails, times out, or the pane is closed"],"attack_tests":["two reader-less panes finish together: each notice has only its own pane's text; a reply naming another pane is dropped","harness with a reader never reads the screen (with and without transcript); reader-less kind does","done then idle on an unchanged or clock-changing screen: one notice; a new turn notifies again","5 MB screen with ANSI: bounded, stripped, no 'shepy agent read' hint","slow read for one pane does not stall another pane's event","bound and source mark present (no redaction rule exists)"],"running_cost":{"time":"one Herdr read per notice, reader-less kinds only","cpu":"same","memory":"same","disk":"none","tokens":null},"ray_check":"none; internal"}
```

## What changed (user-visible)
- Pane tail source: Herdr socket `agent.read`, source `recent_unwrapped`, 60 lines, strip ANSI (the CLI form `herdr agent read <pane> --source recent-unwrapped` is the same read; the daemon uses the socket it already holds). Target is the worker's current pane id; a reply naming another pane is dropped.
- Which kinds: decided by kind, not by "reader found nothing". Claude, Codex, Gemini, Hermes, OpenCode, Pi never use the screen (README line 11 said five; Hermes was missing).
- Bound: ANSI and control bytes stripped, lines with no letter or digit dropped (rules, prompts), newest 20 lines and 1,500 characters kept; raw cut to 64 KB before any regex; 1.5 s read deadline.
- Mark: `textSource` is `screen`, `screen-unavailable` or `history` in the outcome snapshot. Claude hook lines read `screen text: …` and end `[screen text truncated]`; Pi wakes read `last screen text (not an assistant answer): …`. The truncation hint never names `shepy agent read` (it has no reader for these kinds). Failed, timed-out, wrong-pane or empty reads still notify, with `(screen text unavailable)`.
- Screen text is stored only on the event copy (`compactHistory.screenTail`), never in `lastAssistantMessage`, the context snapshot, `agent list` or `agent get`.
- done then idle after such a completion, with no `working` between, is one notice (the screen has no turn identity, so a clock line cannot make it look new). A new turn notifies again.
- The read runs after the existing 500 ms settle wait, outside the per-session queue. Notice timing (S1) and lifecycle (S2) are unchanged; startup `unknown` to idle still stays silent (only working to settled reads the screen).
- README: line 11 (Hermes, screen fallback), line 9 (the one exception to "no terminal parsing"), new paragraph after the retry paragraph, and the stale "Pi claim is a slash command, not a tool" lines (the `shepy_profile` tool exists; `packages/shepy-pi/README.md:30` already says so).

## Checks (env -i, fresh HOME and TMPDIR under `/private/tmp/s5r.*`; CLAUDECODE and the two messaging variables absent; Node 24, TypeScript 6.0.3, Vitest 4.1.9; dependencies by symlink to `socket-test-flake-20261020/node_modules`, no install)
- PASS `tsc --noEmit` exit 0. Biome on touched files: clean apart from one existing info in a file I did not touch.
- PASS 11 focused files, 391 tests, 15 s (new: 18 unit + 12 integration; notice-correctness, agent-index-service, profile-delivery, outcome-context, Pi wake and extension, socket client).
- Controls (each mutation caught by exactly the intended test): reader kinds also using screen, no pane-name check, no flap rule, no deadline (two tests hang and fail).
- RED retained: one run of `screen-text-notice.test.ts` at 21:27 (load average about 30) showed 1 of 12 failing; I did not capture which. Earlier I saw the deadline test fail its 3 s wall bound (4.8 s under load) and changed that bound to 4.5 s: a read with no deadline never returns, so any finite bound still discriminates. Four reruns and six parallel runs were green. Cause of the uncaptured red is not identified.
- Full suite: NOT RUN. I queued it under `lockf -k /private/tmp/agent-factory-full-gate.lock` at 21:24; other jobs held the lock for 9 minutes, so I withdrew it rather than hold the shared gate after finishing. The seat should run it; the 11 focused files above cover every file I touched or that imports it.
- `pnpm test` (`run-tests.mjs`) refuses a symlinked vitest, so I ran Vitest directly; the strict `claude-profile-demand-validation` cases need that entry and were not exercised by me.

## Cost
- Live Herdr `agent.read` of 60 lines: median 3.4 ms, max 106 ms over 20 reads, 2.3 KB reply (one machine, load average about 30).
- Bounding a 6 MB raw screen: 1.5 ms per call, about 10 MB transient heap (production raw is at most Herdr's 60 lines, cut to 64 KB). One read per completion for reader-less kinds only; none for readers. Disk: none (event rows gain at most 1.5 KB). Tokens: null, no model call. Notice latency: the same 500 ms settle wait plus the read; the integration completion took 543 ms.
- A pending read for one pane delayed another pane's event by under 1 s in test (it is outside the queue; measured pass, not a distribution).

## Limits and decisions for the seat
- No redaction: Shepy redacts nothing for reader text either, so a secret or another agent's home path visible on the pane is carried. The probe tests the bound, mark and pane, not redaction. Decision needed (Open for you 1).
- A done to idle change after a screen completion is suppressed even if a missed `working` phase hid a genuine new turn (reader-less kinds only; no `working` ever seen between).
- Blocked notices and unknown-start notices carry no screen text (scope kept to completions). The non-profile Pi "agent update" path (`wake.ts` `projectAgentOutcomes`) reads `lastAssistantMessage` only, so it still says "(no assistant message)" for these kinds.
- Not live-verified: a real reader-less detected agent; alternate-screen kinds depend on what Herdr's `recent_unwrapped` returns (the empty case is marked unavailable).

## Proposed skill edits (not applied; files outside this change)
`~/.claude/skills/shepy/SKILL.md` (identical to the repo's `SKILL.md`):
1. Line 79: replace "A Pi extension can interrupt an idle terminal; a hook cannot." with "A Pi extension can interrupt an idle terminal. A Claude pane can be woken too when its profile has `--wake-idle-claude`; otherwise a hook delivers only at turn boundaries."
2. After line 59: add "For an agent kind with no history reader, a completion notice carries a bounded tail of the pane's screen, marked `screen text`; it is not assistant text. `agent read` still returns no messages for these kinds."
3. Line 65: harness list should say the pull surface needs no reader, and that readers exist for Claude, Codex, Gemini, Hermes, OpenCode, Pi.
`skills/orchi/SKILL.md:96-98` (in this repo): "no registered model-callable claim tool" is stale; the `shepy_profile` tool claims, releases and reports status. Replace with that sentence and drop "ask the user to enter it once".

## Correction 1 (review `f861c4d`, ACCEPT WITH FIXES)
1. `shepy inbox get` (`src/cli/shepy.ts` `formatInboxGet`): a screen excerpt now prints under `screen text (not an assistant answer):`, and a failed read prints `(screen text unavailable)` under the same label; history text still prints under `excerpt:`. Test: three cases in `test/unit/cli.test.ts`; with the label disabled, the two screen cases fail.
2. README (line 59): I chose to correct the sentence, not to publish each completion as it finishes. It now says that on the event path a slow pane delays only its own notice, and that completions found together in one snapshot refresh are published together, so a hung read holds the others back by up to 1.75 s. Reason: bounded, rare (watcher start or restart), and publishing early would change the refresh contract that S1 relies on.
3. Timeouts: the deadline test, the slow-read test and the done-then-idle test now have an explicit 15 s timeout.
4. Seat decision taken: the screen-tail suppression now applies only to done to idle (`profile-delivery-service.ts`, `#sameSettledOutcomeAsPrior(event, from)`). New test: working to idle to done gives one notice at idle and exactly one more at done (a new unseen completion), two in total; with the old rule it gives one. If you meant one in total, tell me; that is the opposite behaviour.
Side effect left as is: working, done, idle, done gives a fourth-step notice with no text, as the reviewer noted.
Checks (env -i, fresh HOME, short TMPDIR `/private/tmp/s5c.*`): `tsc --noEmit` exit 0; Biome clean on touched files; 9 files, 536 tests pass (screen-text-notice, cli, screen-text unit, profile-delivery, notice-correctness, outcome-context unit and rpc, agent-index-service, claude-hook). No full suite run by me; the reviewer's full-suite reds (35 stale pins in the strict demand fixture, 2 Codex date fixtures, load timeouts) are not touched by this correction.

## Open for you
1. Redaction (recommended: no rule now, keep the mark). Option: add one redaction rule for secret-shaped strings and home paths to both reader text and screen text; it changes every notice, so it is its own slice.

## Noticed beyond my task
- Herdr's Claude integration is v7 of v10 (`shepy-design.md`); status quality for Claude workers depends on it. Owner: Ray.
- I once wrote `node_modules` to the shared `/Users/ray/dev/shepy/.git/info/exclude` by mistake (`git rev-parse --git-path` resolves to the bare repo) and reverted it byte for byte before any other action; `git status` there is as before.
Private scratch: `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-s5/ff258566-e2d8-4660-b2b4-6fd1cea7087c/scratchpad/` (logs, mutation script); run roots `/private/tmp/s5r.*`.
