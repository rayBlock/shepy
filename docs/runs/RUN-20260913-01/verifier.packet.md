RUN-20260913-01 / task 10a / VERIFIER packet

You are an independent verifier. You did not build this. Your job is to find what is wrong with a frozen candidate, or to state precisely what you checked and found nothing.

  cwd        ~/dev/shepy-wt/verify-10a     (detached worktree at the candidate — read-only for source; you may add scratch tests)
  candidate  6291a60
  base       0072155 (the shepy branch)
  diff       git diff 0072155..6291a60

Do NOT read /tmp/run-20260913-01/builder-report.md until you have written your own findings section. Do not touch ~/dev/shepy, ~/.shepy, or any other worktree. No installs, no daemon start/stop, no `git push`, no commits.

## The requirement (from the run registration, not from the builder)

Before the fix, `ProfileDeliveryService.claim` (src/observability/profile-delivery-service.ts) passed any profile id to `ProfileOwnerStore.claim`, which upserts unconditionally; `profile_owners.profile_id` has no FK to `orchestrator_profiles`. A claim on a profile that does not exist created a ghost owner row.

R1. A claim on an unknown profile returns a typed rejection (`kind: "rejected"`, a `profile_not_found`-style reason), does not throw, and the check lives in the service.
R2. After R1 no `profile_owners` row exists for that id and `delivery.owner(id)` is undefined.
R3. The rejection reaches RPC callers unchanged through `profile.claim`; the Pi extension (packages/shepy-pi/src/index.ts) and the Claude hook (src/cli/claude-hook.ts) render that reason, not a "lease must expire" message.
R4. Claim / re-claim / lease_active behaviour is unchanged.
R5. `pnpm check` exits 0 at the candidate.

## What you must actually do (not read about)

1. `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` at the candidate. Record exit code and "Test Files N / Tests N".
2. Read the full diff. For each of R1–R5 say: which test or command proves it, and whether you RAN it yourself.
3. MUTATION TEST — mandatory, at least these three. For each: apply the mutation, run the relevant test file, record the NAME of the test that fails (verbatim), revert. If nothing fails, that is a finding.
   a. Remove the existence check in the service (make claim pass through again).
   b. Make the check return the rejection but STILL call the store's claim (ghost row created, correct-looking result).
   c. In the Pi extension, revert the message branch so profile_not_found renders the lease_active text.
4. Probe beyond the tests: an empty-string-ish or whitespace profile id (schema minLength 1 already rejects ""; what about " "?); a profile that exists but has zero subscriptions (must still claim); a profile deleted after a successful claim (out of scope to fix — just report what happens); a re-claim with `currentLeaseToken` on a nonexistent profile.
5. Check R3 end-to-end at the RPC layer if a test harness exists (test/integration/observability-rpc.test.ts, rpc-test-client.ts). If the builder added no RPC-level test, say whether the pass-through is proven or assumed.
6. Grep for every consumer of the claim result (`grep -rn "lease_active\|kind !== \"claimed\"\|profile.claim" src packages test`) and confirm each handles the new variant or explain why it need not.
7. Look for scope creep: any changed file outside src/observability/profile-delivery-service.ts, src/db/profile-owners.ts, src/cli/claude-hook.ts, packages/shepy-pi/src/index.ts, and tests. Report it.

## Report

Write `/tmp/run-20260913-01/verifier-report.md` with exactly these sections:
- Candidate checked: sha; `pnpm check` exit + counts
- Requirement table: R1–R5 → proof → ran-myself yes/no → pass/fail
- Mutation results: a/b/c → failing test name verbatim, or "NO TEST FAILED"
- Probe results (step 4)
- Findings by severity (blocker / should-fix / suggestion), each with a reproduction command or test
- What I could not check and why
- Recommendation: ACCEPT / REVISE / BLOCK, one sentence
- Time spent (approx wall clock)

ONLY THEN read the builder's report and add a final section "After reading the builder report": anything it claims that you did not find, and anything you found that it missed.

Then reply in the pane with exactly one final line:
  `HERDR-SENTINEL: RUN-20260913-01 VERIFY DONE`
or `HERDR-SENTINEL: RUN-20260913-01 VERIFY BLOCKED <reason>`.

## Rails

- Budget: 90 minutes wall clock. Stop and report BLOCKED after 20 minutes stuck on one thing.
- NEVER `pkill -f` / `killall` on a bare tool name or any string in this packet. Kill by recorded PID only.
- Wrap anything that could hang with `perl -e 'alarm shift; exec @ARGV' <secs> <cmd>` (no `timeout` binary on this Mac).
- Reading the builder's tests is useful but is not independent verification. Your own probes and the mutation results are the deliverable. Finding nothing is a valid result if you can show what you checked.
