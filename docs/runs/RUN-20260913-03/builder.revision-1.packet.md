RUN-20260913-03 / plan item 2 / attempt 2 (revision) — BUILDER packet for a FRESH builder

You did not build attempt 1. Orient first: `git log --oneline 2dea955..HEAD` and `git diff 2dea955..HEAD --stat`.

  cwd     ~/dev/shepy-wt/item2
  branch  pilot/item2-represented-equals-acked   (candidate 5081766 on base 2dea955; do NOT amend or rebase existing commits)
Never touch ~/dev/shepy, ~/.shepy, or other worktrees. No daemon start/stop, no installs, no `git push`, no model switching.

## Context

Candidate 5081766 was independently verified: all requirements pass, six mutations each caught by a named test, recommendation ACCEPT. Two things remain and Ray's rule is no deferred work:

A. **Escape leak in the truncation hint (pre-existing at base, widened by this candidate).** `normalizeOutcomeExcerpt` in src/observability/profile-delivery-service.ts (~line 103–116) strips VT/C0/C1 from the excerpt TEXT but builds the >2 000-char hint as `… [truncated; run shepy agent read ${paneId ?? "unknown"}]` from the RAW paneId. A paneId like `"]0;pwnedw2:p1"` with a 3 000-char last-assistant text puts a raw ESC into `excerpt.text`, which `inbox.lease` and the new `inbox.get` serve, the hook's `outcomeLine` injects, and the new `shepy inbox get` human formatter (src/cli/shepy.ts) prints verbatim to the operator's terminal.
B. **Stop's own delivery-with-defer branch is untested end to end** (builder and verifier both said so). Only the prompt path and the ack-only Stop are pinned.

## Required (RED before GREEN, verbatim capture)

1. **Daemon boundary.** In `normalizeOutcomeExcerpt`, interpolate a sanitized paneId into the hint: allowlist it with the same token rule the hook uses (`/^[a-z0-9][a-z0-9:_.-]{0,63}$/i`; anything else → `"unknown"`). Test in test/integration/profile-delivery.test.ts: hostile paneId + 3 000-char text → the served snapshot's `excerpt.text` contains NO C0/C1 bytes and the hint says `unknown`; a normal paneId still appears in the hint.
2. **Hook defense in depth.** In src/cli/claude-hook.ts `outcomeLine`, strip C0/C1 (the same character class `normalizeOutcomeExcerpt` strips) from `excerpt.text` before rendering — one guard, no other behaviour change. Unit test: a hand-built `LeasedObligation` whose excerpt contains ESC renders with no control bytes.
3. **CLI terminal safety.** In the `shepy inbox get` human formatter, strip C0/C1 from the excerpt (and from any other free-text field it prints) before writing to stdout; `--json` output is untouched (JSON escapes them). Unit test in test/unit/cli.test.ts next to the existing `inbox get renders the full excerpt` test.
4. **Stop delivery-with-defer end to end.** In test/integration/claude-hook.test.ts, next to `a full batch defers what the budget cannot render and acks only the represented rows`: after a prompt turn, project 20 obligations with 2 000-char excerpts mid-turn, run `Stop` with `stop_hook_active: false` → it injects (event `Stop`), the owner file's delivered record holds exactly the represented ids, `inbox.delivered` was called with those ids only, the deferred rows are `pending` with `attempt_count` restored and `last_error_code = 'deferred_over_budget'`; then run the ack-only Stop (`stop_hook_active: true`) → represented rows `acked`, deferred rows still `pending`.
5. `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` → exit 0. Report counts (candidate: 55 files / 575 tests).
6. Commit on the branch, pathspec form, two commits: `fix(delivery,claude-hook,cli): no control bytes reach a wake or a terminal through the truncation hint` and `test(claude-hook): pin Stop delivery with a deferred tail end to end`. Report shas.

Out of scope: everything else. If step 1–3 forces more than ~40 lines of source in total, STOP and report BLOCKED with why.

## Report

Append `## Revision 1 (fresh builder)` to /tmp/run-20260913-03/builder-report.md: shas, files changed, RED evidence for the hint test and the Stop test (both must fail before your change — the Stop test may pass immediately if the branch is already correct; if so say so and keep it as a pin), GREEN counts, honest wall clock in UTC.

Final pane line, exactly one of:
  `HERDR-SENTINEL: RUN-20260913-03 BUILD-R1 DONE`
  `HERDR-SENTINEL: RUN-20260913-03 BUILD-R1 BLOCKED <reason>`

## Rails

- Budget 60 minutes; stop and report BLOCKED after 20 minutes stuck on one thing.
- NEVER `pkill -f` / `killall` on a bare tool name or any string in this packet. Kill by recorded PID only.
- Wrap anything that could hang with `perl -e 'alarm shift; exec @ARGV' <secs> <cmd>`.
- biome enforces style; match surrounding code.
