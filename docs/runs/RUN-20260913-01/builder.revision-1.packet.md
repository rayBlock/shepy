RUN-20260913-01 / task 10a / attempt 2 (revision) — BUILDER packet

Same worktree, same branch, same rails as your first packet (~/dev/shepy-wt/pilot-10a, pilot/10a-ghost-owner). Candidate 6291a60 was independently verified: R1–R5 pass, mutations a and b fail the right tests. ONE should-fix came back and it is yours to close before landing:

## The gap (proven by the verifier, mutation c)

Reverting BOTH `profile_not_found` branches in packages/shepy-pi/src/index.ts (the `handleProfileOn` notify text and the `formatShepyProfileToolText` case) leaves all 86 Pi-side unit tests green. R3's Pi-side rendering is entirely unpinned. The claude-hook side, by contrast, IS pinned by `a profile that does not exist exits 0 and says so in a systemMessage` (test/integration/claude-hook.test.ts:630) — your report had that asymmetry inverted.

## Required

1. Add unit coverage so that reverting either Pi branch fails a named test. Follow the existing patterns in test/unit/pi-profile-tool.test.ts (which already mocks a `lease_active` rejection around lines 325-369) and/or test/unit/shepy-pi-extension.test.ts. Mock `profile.claim` returning `{ kind: "rejected", reason: "profile_not_found" }` and assert:
   - the `ctx.ui.notify` text contains `profile_not_found` and `no profile` / `does not exist` wording, and does NOT contain "lease must expire";
   - the tool result carries `reason: "profile_not_found"` and `owner: undefined`;
   - `formatShepyProfileToolText` for that result mentions "no such profile" and does NOT say "held by pane".
2. Prove it: apply mutation c yourself (revert both branches), run the Pi unit tests, paste the verbatim failing test name(s) in the report, revert the mutation.
3. Promote the verifier's whitespace probe into the shipped suite: in test/integration/profile-delivery.test.ts, a claim with `profileId: " "` returns `{ kind: "rejected", reason: "profile_not_found" }` and persists no row. The verifier's scratch file is at /tmp/run-20260913-01/verifier-probes.test.ts for reference — adapt, do not copy wholesale; keep only the whitespace case (the deleted-profile seam is a tracked follow-up, not this packet).
4. `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` → exit 0. Report counts (expect 54 files / 545 + your new tests).
5. Commit on the branch, pathspec form, e.g. `git commit --only -m "test(pi): pin the profile_not_found claim rendering" -- test/unit/... test/integration/profile-delivery.test.ts`. Do NOT amend 6291a60. Report the new sha.

Out of scope: any change to src/ or packages/*/src. This is tests only. If you find you must touch source to make it testable, STOP and report BLOCKED with why.

## Report

Append a section `## Revision 1` to /tmp/run-20260913-01/builder-report.md: new sha, files changed, mutation-c failing test names verbatim, GREEN counts, time spent (wall clock — your first estimate of 35 min was 5× the real 7 min; give a real number). Then reply with exactly one final line:
  `HERDR-SENTINEL: RUN-20260913-01 BUILD-R1 DONE`  or  `HERDR-SENTINEL: RUN-20260913-01 BUILD-R1 BLOCKED <reason>`

Budget 45 minutes. Same rails as before: no pkill -f on names, wrap hangs with perl alarm, no installs, no daemon, no push.
