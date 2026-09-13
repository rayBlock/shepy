RUN-20260913-02 / plan item 3 / attempt 2 (revision) — BUILDER packet for a FRESH builder

You did not build attempt 1. Orient first: `git log --oneline 9f49898..HEAD` and `git diff 9f49898..HEAD --stat` in the worktree.

  cwd     ~/dev/shepy-wt/item3
  branch  pilot/item3-lease-admission   (candidate 8b5fa09 on top of base 9f49898; do NOT amend or rebase existing commits)
Never touch ~/dev/shepy, ~/.shepy, or other worktrees. No daemon start/stop, no installs, no `git push`, no model switching.

## Context

Candidate 8b5fa09 was independently verified: all requirements pass, recommendation ACCEPT. The verifier wrote seven probes (`/tmp/run-20260913-02/verifier-probes.test.ts`, all passing at the candidate) that exercise behaviour the builder listed as untested, and raised one contract-hygiene point. Ray's rule: no deferred work. Close both now.

## Required

1. **Promote the probes into the shipped suite** — adapt to the surrounding style, do not copy wholesale, keep the assertions:
   a. Same-instant agreement (verifier P1a/P1b): at `lease + grace − 1 ms` `inboxLease` admits, `renew` is true, and a tokenless rival claim is rejected `lease_active`; at exactly `lease + grace` `renew` is false, `inboxLease` throws `owner_lapsed`, and the tokenless rival claim succeeds. One test in test/integration/profile-delivery.test.ts, inside the existing "lease admission" describe. This is the real R1 hazard and the shipped suite does not pin it.
   b. Stale-and-lapsed (P2): a rival claimed during the lapse and the rival's lease also lapsed; the original token gets `not_owner`, not `owner_lapsed`. Same describe.
   c. `stop_hook_active: true` on a lapsed owner (P5): the hook acks its delivered record and issues NO `inbox.lease` and NO `profile.claim`. test/integration/claude-hook.test.ts, in the Stop describe next to the two lapse tests.
   d. Contested recovery write (P6): a competing unsettled owner-file record written during the recovery re-claim makes the guarded write fail; Stop returns null, injects nothing, exit 0, the competing record and stale token stay on disk, the batch stays pending. Same describe.
   P3 and P4 are already covered by shipped tests (the hook recovery test and the `isLeaseAlive` boundary test); skip them unless you find they are not.
2. **Only refusal errors carry a wire code.** Today src/daemon/observability-server.ts (~303–313) serialises `code` for ANY thrown error with a string `.code`, so a Node system error (`EACCES`, `ENOENT`) would ride the envelope as if it were a stable Shepy code. Fix: introduce one small base class (e.g. `RpcRefusedError extends Error { readonly code: string }` in a shared module under src/observability/ or src/shared/), make `InboxRefusedError` extend it, and have the server serialise `code` only for `instanceof` that base. Add a test in test/integration/profile-delivery.test.ts (or observability-rpc.test.ts if it fits better) that a dispatch throwing a plain `Error` with `.code = "EACCES"` yields an envelope WITHOUT `code`, while `owner_lapsed` still carries it. The client (src/daemon/client.ts) and the hook branch on `code` are unchanged.
3. `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` → exit 0. Report counts (candidate: 55 files / 556 tests).
4. Commit on the branch, pathspec form, e.g. one commit `test(delivery,claude-hook): pin same-instant lapse agreement, stop_hook_active and contested recovery` and one `fix(daemon): only refusal errors carry a wire code`. Report shas.

Out of scope: everything else. If step 2 forces a change you consider larger than ~30 lines of source, STOP and report BLOCKED with why.

## Report

Append `## Revision 1 (fresh builder)` to /tmp/run-20260913-02/builder-report.md: shas, files changed, which probes were promoted and any assertion you changed and why, RED evidence for the `EACCES` envelope test (it must fail before your server change), GREEN counts, honest wall clock (UTC, please).

Final pane line, exactly one of:
  `HERDR-SENTINEL: RUN-20260913-02 BUILD-R1 DONE`
  `HERDR-SENTINEL: RUN-20260913-02 BUILD-R1 BLOCKED <reason>`

## Rails

- Budget 60 minutes; stop and report BLOCKED after 20 minutes stuck on one thing.
- NEVER `pkill -f` / `killall` on a bare tool name or any string in this packet. Kill by recorded PID only.
- Wrap anything that could hang with `perl -e 'alarm shift; exec @ARGV' <secs> <cmd>`.
- biome enforces style; match surrounding code.
