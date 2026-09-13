RUN-20260913-01 / task 10a / attempt 1 — BUILDER packet

You are the builder. Work ONLY in this worktree:
  cwd     ~/dev/shepy-wt/pilot-10a
  branch  pilot/10a-ghost-owner   (base 0072155 of the shepy branch)
Never touch ~/dev/shepy (the main checkout), ~/.shepy (live daemon state), or any other worktree. Do not start or stop the shepy daemon. No installs, no credential changes, no `git push`, no model switching.

## The defect

`ProfileDeliveryService.claim` (src/observability/profile-delivery-service.ts:213) passes straight through to `ProfileOwnerStore.claim` (src/db/profile-owners.ts:99), which upserts a row for ANY profile id. `profile_owners.profile_id` has no foreign key to `orchestrator_profiles` (src/db/schema.ts:171). Result: a claim on a profile that does not exist creates a ghost owner that can never receive anything. The service already holds `#profiles: OrchestratorProfileStore` (which has `getProfile(profileId)`), so it can check.

## Required outcome

R1. `ProfileDeliveryService.claim` returns a typed rejection when the profile id does not exist. Extend the `ClaimResult` union in src/db/profile-owners.ts with a variant like `{ kind: "rejected"; reason: "profile_not_found" }` (no `owner` field — there is none). Do not throw. Do the check in the SERVICE, not in the store (the store is a plain owners table) and not only in the RPC layer.
R2. After R1, no row exists in `profile_owners` for that id and `delivery.owner(id)` is undefined.
R3. The rejection reaches callers unchanged over RPC (`profile.claim` in src/daemon/observability-server.ts:452 already passes the result through — verify, do not assume). Every caller that branches on the claim result must report the reason honestly. Known call sites — MUTATE EVERY ONE or state in the report why a site needs no change:
   - src/cli/claude-hook.ts ~line 400-440 (the hook's claim + its failure message)
   - packages/shepy-pi/src/index.ts ~line 925-960 (currently says "the active owner's lease must expire first" for ANY non-claimed kind — wrong for profile_not_found)
   - anything else: `grep -rn "lease_active\|kind !== \"claimed\"\|profile.claim" src packages test` and list every hit in your report with what you did.
R4. Existing claim / re-claim / lease_active behaviour is unchanged. The existing suite stays green.
R5. `pnpm check` exits 0 in the worktree.

Out of scope (do NOT do): schema migration or FK; lease/renew/release/expiry changes; sweeping existing ghost rows; new CLI verbs; refactors beyond what R1–R3 need. If you believe a FK belongs here, say so in the report under "follow-ups"; do not build it.

## Method — TDD, RED before GREEN

1. Write the failing tests FIRST in test/integration/profile-delivery.test.ts (a new `describe("profile.claim on a nonexistent profile")`). Use the existing `fixture()` in that file. Assert R1 and R2 (query `select count(*) from profile_owners` before and after via `built.sqlite`). If test/integration/observability-rpc.test.ts already exercises `profile.claim`, add an RPC-level case there for R3; if not, say so.
2. Run them and CAPTURE the red output verbatim (the failing assertion line) — it goes in the report.
3. Implement the minimum for green.
4. Update the call sites (R3).
5. Run `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` (there is no `timeout` binary on this Mac). Must exit 0. Baseline at your base is 54 test files / 543 tests; report your counts.
6. Self-review: re-read the full `git diff`, list every claim you have NOT tested, list every call site and its disposition.
7. Commit on your branch with the pathspec form, e.g.
   `git commit --only -m "fix(delivery): reject a claim on a nonexistent profile" -- <your changed paths>`
   Never a bare `git commit`. Report the sha.

## Report

Write `/tmp/run-20260913-01/builder-report.md` with exactly these sections:
- Candidate: sha, branch, `git diff --name-only 0072155..HEAD`
- RED evidence: the verbatim failing assertion(s) from step 2
- GREEN evidence: last ~15 lines of `pnpm check`, plus "Test Files N / Tests N"
- Call sites: table of every hit from R3 with what changed or why not
- Untested claims: anything you believe true but did not prove
- Limitations / follow-ups
- Time spent (wall clock, approximately)

Then reply in the pane with exactly one final line:
  `HERDR-SENTINEL: RUN-20260913-01 BUILD DONE`
or, if you cannot finish:
  `HERDR-SENTINEL: RUN-20260913-01 BUILD BLOCKED <one-line reason>`

## Rails

- Budget: 90 minutes wall clock. If one thing blocks you for more than 20 minutes, stop and report BLOCKED with what you tried.
- NEVER run `pkill -f` / `killall` on a bare tool name or on any string that appears in this packet (`vitest`, `pnpm`, `node`, `tsc`, `herdr`, `pi`). Kill by recorded PID only (`nohup … & echo $! > pidfile`).
- Wrap anything that could hang with `perl -e 'alarm shift; exec @ARGV' <secs> <cmd>`.
- Style is enforced by biome (`pnpm lint`, `pnpm format:check`); match the surrounding code.
- Keep the diff small and clean. No commented-out code, no drive-by changes.
