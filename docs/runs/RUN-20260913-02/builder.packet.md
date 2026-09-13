RUN-20260913-02 / plan item 3 (lease admission) / attempt 1 — BUILDER packet

Work ONLY in:
  cwd     ~/dev/shepy-wt/item3
  branch  pilot/item3-lease-admission   (base 9f49898 on the shepy branch)
Never touch ~/dev/shepy, ~/.shepy, or other worktrees. No daemon start/stop, no installs, no credential changes, no `git push`, no model switching.

## The defect (verified by ops)

`ProfileDeliveryService.inboxLease` (src/observability/profile-delivery-service.ts ~line 259) admits any caller whose token equals the owner row's token — it never looks at the clock. `ProfileOwnerStore.renew` (src/db/profile-owners.ts ~191) and `claim` (~131) both apply `leaseExpiresAt + DEFAULT_LEASE_GRACE_MS` against now. So an owner whose lease lapsed at t=0 can still lease a batch at t=1,000,000, even after `claim` would have handed the profile to someone else. Pi renews every 10 s (packages/shepy-pi/src/index.ts ~500) so it practically never lapses; the Claude hook (src/cli/claude-hook.ts) claims on `UserPromptSubmit` only and never renews during a turn, so a long Claude turn outlives its 5-minute lease and its closing `Stop` runs on a lapsed owner. Today that Stop still leases (wrong); once the admission rule is right, that Stop would be refused and the outcomes would strand — so the admission rule and a hook recovery path ship TOGETHER.

RPC errors reach clients as `error: { message }` only (src/daemon/observability-server.ts ~304; src/daemon/client.ts ~46 wraps it in `new Error(message)`). Callers cannot distinguish refusal kinds without parsing prose.

## Required

R1. **One predicate.** Extract the liveness rule into one exported function in src/db/profile-owners.ts, e.g. `isLeaseAlive(owner, now, graceMs = DEFAULT_LEASE_GRACE_MS)`, and use it in `claim`, `renew`, AND `inboxLease`. No three copies of the arithmetic. `now` stays injectable (`inboxLease` already takes `input.now`; the store has `#now`).
R2. **Distinguishable refusal.** `inboxLease` refuses with a stable code: `not_owner` (token mismatch — existing behaviour, existing tests) and `owner_lapsed` (new: token matches but the lease is dead past grace). Implement as an error class carrying `code` (e.g. `InboxRefusedError`). Extend the RPC error envelope so `error: { code?: string, message }` is serialised (observability-server.ts ~304) and the client attaches `code` to the rejected Error (client.ts ~46). Existing prose-matching tests for `not_owner` must keep passing — keep the message text.
R3. **Hook recovery, no contention.** In `handleStop` (claude-hook.ts ~628): after the existing ack of the delivered record, when `inbox.lease` is refused with `owner_lapsed`: call `profile.claim` with `currentLeaseToken: file.leaseToken` (proof of possession → the store's fast path → `reclaimed` with a new token), persist the new token in the owner file through the existing guarded write helpers (owner-file.ts; never a bare write), then lease ONCE more with the new token and continue exactly as the normal path (delivered record, `inbox.delivered`, inject). Exactly one recovery attempt per Stop.
R4. **Hook recovery, contention.** Same trigger, but the re-claim is rejected `lease_active` because a rival claimed during the lapse: Stop injects nothing new, acks nothing it did not deliver, emits a systemMessage warning naming the rival pane/harness (mirror the existing `claimRejectionWarning` wording), leaves the owner file's token as-is (the next `UserPromptSubmit` claim already handles rejection today). No second attempt. Exit code unchanged (expected-failure surface, not a crash).
R5. **UserPromptSubmit unchanged.** It claims first with proof of possession, so a lapsed-but-uncontested owner reclaims on the fast path before it ever leases. Prove with a test (a lapsed owner + prompt submit → `reclaimed` and delivered); if such a test already exists (grep "lapsed", "proof of possession" in test/integration/claude-hook.test.ts and profile-delivery.test.ts ~866, ~1221, ~1284), cite it by name instead of duplicating.
R6. **TDD, and the plan's order: pin the hook cases BEFORE tightening admission.** Write RED tests first for R3 and R4 (hook, real fixture daemon — the harness used by `a profile that does not exist exits 0 and says so in a systemMessage` at claude-hook.test.ts ~630 is the model) and for R1/R2 at the service level (profile-delivery.test.ts `fixture()` with injected `now`, like the renew-boundary tests at ~1221/~1284). To make a lapse in a hook test, either inject `now` or update `profile_owners.lease_expires_at` directly in the fixture's sqlite — say which. Capture the RED assertions verbatim. Then implement.
R7. `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` → exit 0. Baseline 54 files / 548 tests; report yours.

Pi extension (packages/shepy-pi): read `pumpProfile`/`pumpProfileOwned` (~504–743). Its lease call sits in a try/catch that treats any error as transient, and its 10-second renew already detects loss (`renewed:false`). Expected: NO change needed. State in the report what you checked and why it holds — or change it if you can prove it does not.

Out of scope — do NOT touch: the lapsed-row sweep (a held branch exists), Pi renew cadence, `pendingCount`, `formatHookContext`, the ack id set, `LEASE_MAX_BATCH`, anything about render budgets (that is item 2, next packet). Keep the diff to the files named in R1–R4 plus tests.

## Self-review + commit

Re-read the full diff. List every claim you did not test. Commit on the branch with pathspec form (`git commit --only -m "..." -- <paths>`), one or two commits (e.g. `fix(delivery): one lease-liveness rule for claim, renew and lease` and `fix(claude-hook): recover a lapsed owner on Stop by proof of possession`). Report shas.

## Report

Write `/tmp/run-20260913-02/builder-report.md` with sections: Candidate (sha(s), `git diff --name-only 9f49898..HEAD`); RED evidence (verbatim); GREEN evidence (last ~15 lines of pnpm check + counts); Requirement table R1–R7 → test name(s); Pi extension check; Untested claims; Limitations / follow-ups; Time spent (wall clock, honest — the last builder reported 35 min for a 7-minute job).

Final pane line, exactly one of:
  `HERDR-SENTINEL: RUN-20260913-02 BUILD DONE`
  `HERDR-SENTINEL: RUN-20260913-02 BUILD BLOCKED <one-line reason>`

## Rails

- Budget 120 minutes wall clock; stop and report BLOCKED after 25 minutes stuck on one thing.
- NEVER `pkill -f` / `killall` on a bare tool name or any string in this packet. Kill by recorded PID only.
- Wrap anything that could hang with `perl -e 'alarm shift; exec @ARGV' <secs> <cmd>` (no `timeout` binary here).
- biome enforces style; match surrounding code; no commented-out code, no drive-by refactors.
