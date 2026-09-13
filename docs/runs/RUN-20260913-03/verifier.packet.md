RUN-20260913-03 / plan item 2 / VERIFIER packet

You are an independent verifier. You did not build this. Find what is wrong with a frozen candidate, or state precisely what you checked and found nothing.

  cwd        ~/dev/shepy-wt/verify-item2   (detached worktree at the candidate; scratch tests allowed, no commits)
  candidate  5081766
  base       2dea955 (the shepy branch)
  diff       git diff 2dea955..5081766

Do NOT read /tmp/run-20260913-03/builder-report.md until your own findings are written. Do not touch ~/dev/shepy, ~/.shepy, or other worktrees. No installs, no daemon start/stop, no `git push`.

## The requirement (from the run registration, not the builder)

Before the fix the Claude hook (src/cli/claude-hook.ts) leased up to 20 obligations, recorded ALL their ids as delivered, rendered only the outcomes that fit a 6 000-char / 120-line budget, and the next hook run acked every recorded id. With 2 000-char excerpts: lease 20, render 2, ack 20.

R1. `formatHookContext` returns `{ context, representedIds, deferredIds }`. Full outcome lines while they fit, then one-line stubs (identity + obligation id + `run shepy inbox get <id>`) while they fit, then the rest deferred with a trailing note. Every id in the context is in `representedIds` and vice versa. Char AND line budgets respected. `WAKE_POLICY` unchanged.
R2. Both `handlePromptSubmit` and `handleStop` record and `inbox.delivered` ONLY `representedIds`; `deferredIds` go to a new `inbox.defer` RPC. Nothing deferred is ever acked by the following hook run.
R3. `DeliveryObligationStore.defer`: only `leased` rows stamped with the presented token go back to `pending`, lease cleared, `attempt_count` decremented with a floor of 0, `last_error_code = 'deferred_over_budget'`; `delivered` rows untouched; foreign tokens rejected.
R4. `inbox.get { obligationId }` returns the obligation with `leaseToken` and `deliveredHarnessTurnId` redacted plus the immutable outcome snapshot; unknown id → `{ obligation: null }`, not an error. `inbox.list` accepts `before` (agent_event_id cursor) and `limit`.
R5. CLI: `shepy inbox get <id> [--json]` exists and is listed in `shepy inbox --help`; `shepy inbox list` accepts `--before` and `--limit`; the help census test passes.
R6. Pi extension untouched; item 3's admission logic untouched; `LEASE_MAX_BATCH` still 20.
R7. `pnpm check` exit 0 at the candidate.

## What you must do

1. `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` at the candidate; record exit and "Test Files N / Tests N".
2. Read the full diff. For each of R1–R7: which test or command proves it, and whether you RAN it yourself.
3. TWO methods, both required, and your report must say which method produced each finding:
   a. **Mutation pass** — measure whether the shipped tests protect the requirements. Choose your own mutations (at least four); for each: apply, run the relevant test file(s), record the failing test NAME verbatim or "NO TEST FAILED", revert. Obvious candidates: ack all leased ids again instead of `representedIds`; make `defer` skip the attempt refund; make `defer` also touch `delivered` rows; drop the stub tier so everything past the full lines is deferred; let the stub line exceed the line budget by one.
   b. **Probe pass** — exercise what the tests do not: e.g. exactly-at-budget boundaries (one stub fits / one does not); a lease where the FIRST outcome alone exceeds the whole budget; deferred rows re-leased on the very next prompt in agent_event_id order; a deferred row that has already hit `MAX_DELIVERY_ATTEMPTS − 1` (does the refund keep it alive?); `inbox.defer` failure leaving rows leased and expiring; `inbox.get` on an acked row and on a dead_letter row; `--before` with a non-existent event id; untrusted tokens (a pane id with an OSC escape) inside a stub line.
4. Grep every consumer of `formatHookContext`, `inbox.delivered`, `inbox.ack` and `LEASE_MAX_BATCH` (src, packages, test) and confirm each still holds.
5. Scope check: list every changed file; flag anything outside src/cli/claude-hook.ts, src/db/delivery-obligations.ts, src/observability/profile-delivery-service.ts, src/observability/schemas.ts, src/daemon/observability-server.ts, src/cli/shepy.ts and tests. Any change under packages/ is scope creep.

## Report

Write `/tmp/run-20260913-03/verifier-report.md` with sections: Candidate checked (sha, exit, counts); Requirement table (R1–R7 → proof → ran-myself → pass/fail); Mutation results (table: mutation → failing test name verbatim or NO TEST FAILED); Probe results (table: probe → command/test → result); Findings by severity (blocker / should-fix / suggestion), each tagged `[mutation]` or `[probe]` or `[read]`, each with a reproduction; What I could not check and why; Recommendation ACCEPT / REVISE / BLOCK in one sentence; Time spent (honest wall clock, UTC).

ONLY THEN read the builder report and append "After reading the builder report": claims you did not find, and things you found it missed.

Final pane line, exactly one of:
  `HERDR-SENTINEL: RUN-20260913-03 VERIFY DONE`
  `HERDR-SENTINEL: RUN-20260913-03 VERIFY BLOCKED <reason>`

## Rails

- Budget 90 minutes; stop and report BLOCKED after 20 minutes stuck on one thing.
- NEVER `pkill -f` / `killall` on a bare tool name or any string in this packet. Kill by recorded PID only.
- Wrap anything that could hang with `perl -e 'alarm shift; exec @ARGV' <secs> <cmd>`.
- Finding nothing is a valid result if you can show what you checked.
