RUN-20260913-02 / plan item 3 / VERIFIER packet

You are an independent verifier. You did not build this. Find what is wrong with a frozen candidate, or state precisely what you checked and found nothing.

  cwd        ~/dev/shepy-wt/verify-item3   (detached worktree at the candidate; you may add scratch tests, no commits)
  candidate  8b5fa09
  base       9f49898 (the shepy branch)
  diff       git diff 9f49898..8b5fa09

Do NOT read /tmp/run-20260913-02/builder-report.md until your own findings are written. Do not touch ~/dev/shepy, ~/.shepy, or other worktrees. No installs, no daemon start/stop, no `git push`.

## The requirement (from the run registration, not the builder)

Before the fix, `ProfileDeliveryService.inboxLease` admitted any caller whose token matched the owner row, with no clock check, while `ProfileOwnerStore.claim` and `renew` both apply `leaseExpiresAt + DEFAULT_LEASE_GRACE_MS`. A Claude hook never renews during a turn, so a long turn's closing `Stop` runs on a lapsed owner.

R1. One exported liveness predicate is used by `claim`, `renew` and `inboxLease`; no duplicated arithmetic.
R2. `inboxLease` refuses with a stable code: `not_owner` (token mismatch) and `owner_lapsed` (token matches, lease dead past grace). The code travels through the RPC error envelope and is available on the client-side rejection. Existing `not_owner` behaviour and message text unchanged.
R3. Hook `Stop` on a lapsed owner with no rival: acks its delivered record, re-claims with `currentLeaseToken` (proof of possession → `reclaimed`), persists the new token via the guarded owner-file write, leases once more, delivers and injects as normal. Exactly one recovery attempt.
R4. Hook `Stop` on a lapsed owner when a rival claimed meanwhile: re-claim rejected `lease_active`; nothing new injected; nothing acked that was not delivered; a systemMessage warning names the rival; owner file token left as-is; no second attempt.
R5. `UserPromptSubmit` behaviour unchanged (it claims first with proof of possession).
R6. Pi extension needs no change (its lease sits in a catch-all and its 10 s renew detects loss) — or is changed with proof.
R7. `pnpm check` exit 0 at the candidate.

Out of scope for the candidate (report as scope creep if touched): lapsed-row sweep, Pi renew cadence, `pendingCount`, `formatHookContext`, the ack id set, `LEASE_MAX_BATCH`.

## What you must do

1. `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` at the candidate; record exit and "Test Files N / Tests N".
2. Read the full diff. For each of R1–R7: which test or command proves it, and whether you RAN it yourself.
3. Independent verification means checks you ran, not reports you read. Your method is yours; the deliverable is evidence that each requirement's protection is real, plus anything the tests do not cover. Probe the boundaries you think matter (for example: the exact lapse instant vs. one ms before; a Stop with `stop_hook_active: true` on a lapsed owner; the recovery when the owner file write is contested; whether `not_owner` and `owner_lapsed` can be confused when the token is stale AND lapsed; what a Pi owner sees if its renew is late).
4. Grep every consumer of `inbox.lease` and of the RPC error path (src, packages, test) and confirm each handles the new code or explain why it need not.
5. Scope check: list every changed file; flag anything outside src/db/profile-owners.ts, src/observability/profile-delivery-service.ts, src/daemon/observability-server.ts, src/daemon/client.ts, src/cli/claude-hook.ts, src/cli/owner-file.ts and tests.

## Report

Write `/tmp/run-20260913-02/verifier-report.md` with sections: Candidate checked (sha, exit, counts); Requirement table (R1–R7 → proof → ran-myself → pass/fail); What I probed and how (commands/tests, results); Findings by severity (blocker / should-fix / suggestion) each with a reproduction; What I could not check and why; Recommendation ACCEPT / REVISE / BLOCK in one sentence; Time spent (honest wall clock).

ONLY THEN read the builder report and append "After reading the builder report": claims you did not find, and things you found it missed.

Final pane line, exactly one of:
  `HERDR-SENTINEL: RUN-20260913-02 VERIFY DONE`
  `HERDR-SENTINEL: RUN-20260913-02 VERIFY BLOCKED <reason>`

## Rails

- Budget 90 minutes; stop and report BLOCKED after 20 minutes stuck on one thing.
- NEVER `pkill -f` / `killall` on a bare tool name or any string in this packet. Kill by recorded PID only.
- Wrap anything that could hang with `perl -e 'alarm shift; exec @ARGV' <secs> <cmd>`.
- Finding nothing is a valid result if you can show what you checked.
