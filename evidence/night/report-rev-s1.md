# rev-s1: independent review of Shepy slice 1 (notices tell the truth)

**REVISE.** One defect the change introduces: when a worker starts its next turn during the 500 ms re-read (the retry), the earlier "idle" notice is stored and delivered after the newer "working" event, with no text. The fix is about 15 lines and was tried here. Everything else in the slice holds, and red-on-main probes show the old bugs are gone.
Candidate: `f10cc62` (code), report `15a0381`, branch `night/s1`. Base `07d5735`. Reviewer: rev-s1, branch `night/rev-s1`. Directed review: the builder's report and the acceptance check were read.
The brief asks for `evidence/night/review-S1.md`; the dispatch prompt names this path, and the prompt wins.

## Findings
1. **Medium, blocking. A superseded retry appends its completion out of order.** `src/observability/agent-index-service.ts:439` only sets `superseded`. The new status (for example idle -> working) is appended at once. Then `:511` appends the old working -> idle about 500 ms later.
   Consequence: the event log ends with `working->idle` while the agent row says `working`. The seat gets an idle notice with empty text after the worker is already busy again. The next completion's previous-turn check (`findPriorSettledEvent`) then reads that empty event.
   On main the order is right. The builder's test "a new turn during the retry…" checks only the text, not the order.
   Reproduce: worker with no final text yet; `status(idle)`; after 60 ms `status(working)`. Status order on the candidate is `["idle->working","working->idle"]` and the row is `working`. On base it is `["working->idle","idle->working"]` (probe P1).
   Fix (tried): when a pending retry is superseded, append it at once with `lastAssistantMessage: null`, before the newer status. The flush then publishes that event instead of appending again. With this change, P1, the 18 builder probes and `agent-index-service.test.ts` pass, and typecheck passes.
2. **Low, not blocking. In the snapshot tick, one pane's retry holds up another pane's notice.** `#finishPendingStatuses` (`:474`) waits for every pending retry before it returns the batch's events. A fresh final on pane B in the same tick is published only after A's 500 ms.
   Reproduce: two panes go working -> idle in one `refresh()`; A has no text, B has fresh text. B is published after 522 ms (probe P6). The event-stream path is not affected (the builder's watch test and my rerun pass).
   Suggestion: publish the non-pending events of the batch first, then the retried events.
3. **Low, not blocking. A cached Claude ref is rejected when Herdr's cwd does not match the project folder.** At `src/agent-history/discovery.ts:405` the cached ref is rejected even when there is only one main transcript. Every later read then rescans `~/.claude/projects`. On this machine that is 781 transcripts and about 230 ms per scan (measured read-only), and the result is still correct.
   Suggestion: apply the folder check only when the ID has more than one main transcript. Not checked: whether Herdr's cwd ever differs from Claude's launch folder in practice, for example `/tmp` against `/private/tmp`.

## Crash window (brief item 5)
It is already on main and the candidate widens it. On main, `agent-index-service.ts:267` persists the new status, and the event is appended at `:285` after the history read. On the candidate the status is persisted at `:341`, and in the retry case the event is appended at `:511` after the sleep at `:476`.
Reproduced on both by making the first event append throw, then restarting the index and refreshing three times: 0 settled events, so the completion is lost on both. The measured window from persisted status to append:
- main: 0.5 ms to 2.7 ms;
- candidate, with text present: 1.6 ms;
- candidate, with text missing: 503 ms.
A first Claude discovery scan (about 230 ms here) also sits inside main's window.
Smallest fix: persist the status only together with its event. In the retry case, write `updateStatus` at flush time. The row then stays `working` across a crash, and the next snapshot emits the completion. With this, `#recordStatus` must ignore a second working -> settled observation for an agent that already has a pending retry, because the working-session tick refreshes during the wait.
It should not block landing on its own: the window exists on main, it only grows for completions whose text is missing, and the loss needs a daemon exit inside that window. It belongs in the same revision as finding 1 because both touch `#recordStatus`.

## Acceptance items (fixture proof, not live Herdr)
| Item | Result |
| --- | --- |
| 1. No foreign text, including a stored foreign hint; two same-kind agents in different cwds within a second | Holds. P3: B finishes 200 ms after A, A has no ID. Candidate: A gets no text and B gets "B FINAL". Base: both get "B FINAL". The builder's poisoned-hint test passes and clears `historyRef`. |
| 2. Startup unknown -> idle/done gives no notice; blocked once, also across restart; re-entering notifies again | Holds. Builder probes rerun green. P4: a persisted `working` row with the pane blocked at restart, plus three ticks, gives exactly one `working->blocked`. |
| 3. Same ID in two project folders | Holds for Claude and Pi. The folder naming matches real folders on this machine: Claude maps `_` to `-`, Pi keeps `.` and `_`. When neither folder matches, there is no text. |
| 4. Retry only for working -> idle/done with missing or previous-turn text; no wait when text is present | Holds on the event path. P5: when the next user record has flushed but the answer has not, the candidate gives no text (base gave the stale "FIRST"). See findings 1 and 2 for the ordering and the same-tick limit. |
| 6. Nothing weakened | The changed tests flip fallback expectations to refusals on purpose. The Claude fixture folder was renamed to match its cwd. The cached-ref reuse test is stronger: discovery now throws if it is called. |

## Checks (env without CLAUDECODE, CLAUDE_CODE_MESSAGING_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN, REPL_ID or AGENT; fresh HOME, TMPDIR `/tmp/rs1t.*`; Node 24.18.0 through `scripts/run-tests.mjs`)
- `tsc --noEmit`: candidate exit 0 in 6.1 s; base exit 0 in 5.0 s. Biome on the candidate: exit 0, 1 warning that is already on main.
- 15 focused files (6 touched, plus watch manager, profile delivery, demand, diagnose, health RPC, outcome, daemon-info, claude-hook):
  - candidate: 485 of 486 passed, 85 s;
  - base: 467 of 468 passed, 90 s.
  Each side had one 5 s timeout under load average 24 to 30: the candidate in the new "old text still missing…" test (5.8 s), the base in the untouched `claude-hook` test. The new file then passed 3 of 3 times alone (8 to 13 s). This test is sensitive to load; it was not marked green by rerunning.
- Reviewer probes P1 to P6, run on the candidate and on base: P1 and P6 are red on the candidate only; P3 and P5 are red on base only; P2 and P4 are green on both.
- Not run: full `pnpm check`, live Herdr with real Pi and Claude workers, a real approval prompt, daemon RSS. Live cost not measured: one Herdr `sessionSnapshot` call per status event (the fixture's client costs nothing).

Private scratch (probes `rev-s1-probes.test.ts`, the fix diff `p1-fix.diff`, logs): `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-rev-s1/1a498507-42e6-4f65-a278-dc8dd9d82a63/scratchpad`.

## Noticed beyond my task
- The new retry tests assert wall-clock bounds (`<400 ms`, `>=450 ms`) and use the default 5 s test timeout. On this shared host (load average up to 30) one of them timed out. Owner: seat, for the shared gate's flake budget.
- The builder's note on `claude-reader.ts:43-76` (non-message user records) is not checked here; I agree it is separate. Owner: seat.

Next owner: builder (S1), for finding 1 and the crash-window fix; then a recheck by rerunning P1, P2 and P6.

## Recheck (seat): ff2b52d, report 11be567
**ACCEPT** for the code. All three findings and the crash window are fixed, and my probes P1 to P7 pass. The new retry tests stay timing-sensitive on this shared host: at load 14 to 16 they sometimes fail on both f10cc62 and ff2b52d. With the timeout lifted every test completes, so this is load, not a slowdown or a hang. It needs a decision before the full gate (see the end of this section).
- **Finding 1: fixed.** A superseded retry now appends its completion at once, with no text, before the newer status (`agent-index-service.ts`, `#recordStatus`). The flush publishes that stored event instead of appending a second one. The builder's test "a new turn during the retry…" now asserts the order of the stored status events, for the event route and the snapshot route. P1 on ff2b52d: `["working->idle","idle->working"]`, and the row says working.
- **Crash window: fixed.** The status and both event records are committed in one SQLite transaction (`agents.ts` `commitStatusEvent`). A snapshot no longer writes a changed status by itself (`deferStatusChanges`), and the row stays working during the retry. P2 (the first append throws, then restart and three ticks) now recovers exactly one `working->idle`, with text present and with text missing; on f10cc62 it recovered none.
  P7, new: a tick during the retry leaves the row working, a second settled observation adds nothing, and after the flush there is one `working->idle` and the row says idle.
  A replaced pane's row is protected: the status is written only when the pane row still has the same agent id.
- **Finding 2: fixed.** The watch tick passes a callback that publishes the ready part of the batch first. P6: the fast pane is published at 5 ms with "FAST", and the retried pane at 511 ms with no text. A refresh caller without the callback keeps the old single batch; the only caller in `src` passes the callback.
- **Finding 3: fixed.** A cached Claude ref outside the cwd's project folder is now rejected only when the ID has more than one main transcript. Unchanged transcript headers are cached by inode, size and modification time.
  Measured read-only on this machine (781 transcripts, load about 40): when Herdr's cwd does not match the project folder, each read takes 340 to 450 ms (f10cc62: 750 to 1,200 ms), and the result is the correct transcript. Each read still lists the folders and checks every file's size and time; this is acceptable for a case that should be rare.
- **P3 to P5:** still green.
- **Typecheck:** exit 0 in 7 s. Biome: exit 0, with the 1 warning already on main.

**Timing failures: load, not a slowdown.**
- The builder's nine files, run in parallel at load 11.9 to 15.5, twice on each version, all green:
  - ff2b52d: 175 of 175 passed, 12 s and 16 s;
  - f10cc62: 163 of 163, 14 s and 10 s;
  - 07d5735: 145 of 145, 9 s and 9 s.
  The eight files shared with main take comparable time on all three versions; profile-delivery took 2.4 to 3.9 s on ff2b52d and 5.1 s on main.
- `notice-correctness` alone, one test at a time, at load 14.1 to 16.6:
  - ff2b52d, 7 runs: 1 failure (the first test hit the 5 s timeout once; it normally takes 0.55 to 0.8 s);
  - f10cc62, 7 runs: 2 failures (one was "expected 355.9 to be less than 350" in a fast-pane test).
  In 3 extra runs, the builder's three red tests passed on ff2b52d at 526 to 905 ms; on f10cc62, two of them have equivalents, and those passed at 544 to 694 ms.
- With `--testTimeout=60000`, 6 runs of each version at load 24 to 39: every test completed. The two slowest tests per run took 1.1 to 5.1 s on both versions, and which tests were slowest changed from run to run. Nothing hangs, and there is no consistent slowdown.
- A 16-file run at load 47: 5 timing failures, one of them in an untouched lease test (`empty-lease turn…`, 5.0 s timeout). Same pattern.
- Cost (builder's measure script, load 37 to 43, so noisy): steady-tick CPU is 1.0 to 1.6 ms on ff2b52d, against 1.0 to 1.3 ms on main and 0.6 to 1.3 ms on f10cc62. Startup median is 7 to 22 ms on ff2b52d, slower than f10cc62 (2.6 to 7.3 ms), probably because each pane seen for the first time is saved with its own write. Main measured 28 to 68 ms. No history reads per tick.

**Remaining risk:** the retry tests check wall-clock limits (`<350 ms`, `<400 ms`, `<1 s`, `>=450 ms`) and use the default 5 s timeout. On this host they fail intermittently once load reaches about 15. The cause is the host, but the full gate will hit them. Owner: seat. Choose between running the gate when the machine is quiet, or replacing these wall-clock limits with event-order checks or fake timers; I recommend the second, because nothing else will fix the flakes. Neither changes the code verdict.
Not run: full `pnpm check`, live Herdr with real workers, a real approval prompt, a real process kill (the transaction rollback stood in for the crash).
Probe file for this round: `rev-s1-probes-r1.test.ts`, with logs in the same scratch folder as above.
