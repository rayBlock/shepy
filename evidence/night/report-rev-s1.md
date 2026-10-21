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
