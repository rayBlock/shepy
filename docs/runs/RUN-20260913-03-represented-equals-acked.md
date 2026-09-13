# RUN-20260913-03 — Represented set equals acknowledged set (plan item 2)

Third run under the vault orchestration program. Serial after item 3
(RUN-20260913-02), which landed at `2dea955`.

## Registration (before dispatch)

- **Experiment:** EXP-01 repeat on a medium task with a design fixed by the
  lead up front (D1–D5 in the packet). Verifier packet asks for BOTH
  mutation testing and free probes, since RUN-01 showed mutations only
  happen when asked and RUN-02 showed probes happen unprompted.
- **Task class:** medium correctness fix across hook, store, service, RPC
  and CLI.
- **Outcome:** the Claude hook delivers and acks only the obligations it
  actually represented in the injected context; the rest return to pending
  without burning a delivery attempt. `inbox get` and a list cursor make
  the truncation hints usable.
- **Non-goals:** `LEASE_MAX_BATCH` value, Pi extension (renders every row
  unbudgeted, so it has no such gap), `WAKE_POLICY` text, item 3 logic,
  retire/retry semantics, `MAX_DELIVERY_ATTEMPTS`.
- **Defect, verified by ops:** `claude-hook.ts` leases 20, records all ids
  in the owner file, calls `inbox.delivered` with all ids, renders only the
  outcomes that fit 6 000 chars / 120 lines, then the next hook run acks
  every recorded id. With 2 000-char excerpts: lease 20 → render 2 → ack 20.
- **Design (ops):** formatter returns `{context, representedIds,
  deferredIds}`; full lines → one-line stubs → deferred; new `inbox.defer`
  (leased→pending, attempt refunded, `deferred_over_budget`); `inbox.get`
  RPC + CLI verb; `inbox list --before/--limit`.
- **Base:** `shepy` at `2dea955` (item 3 landed). Gate at `2dea955`: exit 0,
  55 / 561.
- **Work surface:** `~/dev/shepy-wt/item2`, branch
  `pilot/item2-represented-equals-acked`.
- **Mutation scope:** `src/cli/claude-hook.ts`, `src/db/delivery-obligations.ts`,
  `src/observability/profile-delivery-service.ts`, `src/observability/schemas.ts`,
  `src/daemon/observability-server.ts`, `src/cli/shepy.ts`, tests.
- **Roles:** lead = this Claude session (`w31:p1`), supervised. Builder
  `builder-item2`, verifier `verifier-item2`, both Pi `zai/glm-5.3-flash`,
  fresh panes. Revision, if any, to a fresh builder.
- **Limits:** 150 min builder, 90 min verifier; one of each; no children.
- **Stop conditions:** as RUN-01/02; any change to Pi or to item 3's
  admission logic is a scope violation.
- **Evidence:** this file + `/tmp/run-20260913-03/`, copied at acceptance.

## Execution and lineage

- 10:45Z — worktree `~/dev/shepy-wt/item2` at `2dea955`, installed
  `--ignore-scripts`. Pane `w31:pZ` (split right of `w31:p1`, no focus),
  `builder-item2` on Pi `zai/glm-5.3-flash`; packet
  `/tmp/run-20260913-03/builder.packet.md` submitted from file; `working`
  within 4 s; one bare wait armed. Verifier packet pre-written with both a
  mutation pass and a probe pass required.
- 11:03Z — builder wait returned (lead reactivated). Sentinel `BUILD
  DONE`. **Candidate frozen at `5081766`** (three commits by layer:
  `675ffc3` store/service/RPC, `f770579` hook, `5081766` CLI). 9 files,
  +787/−59. Wall clock ≈ 18 min (self-reported "≈ 35 min"; over again).
  Report: 15 RED tests captured verbatim before any src change, the R1
  overload RED being `expected 20 to be less than 20` — the defect
  reproduced exactly. GREEN 55 / 575 (+14). Design deviations disclosed:
  R1's "following Stop" is the ack-only Stop (`stop_hook_active: true`)
  because a delivery Stop would re-lease the just-deferred rows; a
  `byId` store read was added for `inbox.get`; the formatter now runs
  before the phase-1 owner-file write; `deferOverBudget` is awaited
  because the client closes in `finally`. Untested: `inbox.defer` failure
  path, Stop's own defer branch end-to-end, `inbox.get` against skewed
  callers.
- 11:05Z — ops read the full source diff (hook, store, service, server,
  schemas): matches D1–D5; the stub tier and the deferred note reserve
  budget as specified; `defer` is token-fenced and `leased`-only with the
  floored refund; `inbox.get` redacts like `inboxList`. Builder pane
  closed (revision, if any, goes to a fresh builder). Verifier worktree
  `~/dev/shepy-wt/verify-item2` at `5081766`; `verifier-item2` started;
  one bare wait armed.
- 11:23Z — verifier wait returned (lead reactivated). Sentinel `VERIFY
  DONE`, ≈ 19 min wall clock (self-reported 25, UTC labelled but two hours
  off). `pnpm check` exit 0, 55 / 575. R1–R7 all PASS by tests it ran.
  **Both methods executed as asked.** Mutations: six, every one caught by
  a named shipped test (ghost-ack resurrection, refund skipped, defer
  touching delivered, stub tier dropped, line budget +5, `inbox.get`
  token un-redacted). Probes: nine over the real store/service and the
  pure formatter — deferred rows re-lease next in event order with the
  attempt restored; the refund is load-bearing at `MAX − 1` (an expired
  row at MAX dead-letters, a deferred one does not); defer-RPC failure
  recovers via expiry with one attempt burned (the builder's untested
  claim #1, now proven); exact-budget boundary flips one stub between
  represented and deferred with the id absent from the text when
  deferred; a 20 000-char single outcome is still represented by its
  stub; hostile tokens in a stub line are allowlisted away; `WAKE_POLICY`
  sha-identical base↔candidate.
- Findings: no blocker. **One should-fix [probe]: the >2 000-char
  truncation hint in `normalizeOutcomeExcerpt` embeds the RAW paneId**, so
  a pane id carrying ESC/BEL reaches the served snapshot, the hook's
  injection, and the new `shepy inbox get` terminal output. Pre-existing
  at base (line identical), widened by this candidate. Suggestions: hook
  does not re-sanitise excerpt text (relies on the daemon); a single
  outcome can never be deferred because the 2 000-char cap always fits;
  a malformed obligation id is represented but textually absent.
- Verifier vs builder: no contradiction. Verifier proved untested claim
  #1 and showed #3 was already mutation-covered (M6). Both agree Stop's
  own delivery-with-defer branch is untested end to end.
- Ops decision: ACCEPT the candidate; one revision before landing (no
  deferral): sanitise the hint's paneId at the daemon, strip control
  bytes in the hook's excerpt render and in the CLI's human formatter, and
  pin Stop-with-defer end to end. Fresh builder (EXP-07 arm). Verifier
  pane closed and worktree removed at 11:25Z; it had already deleted its
  scratch suite, so only its report and check log are preserved.
- 11:24Z — fresh builder `builder-item2-r1` (pane `w31:p12`, same worktree
  and branch) given the revision packet; `working` within 4 s; one bare
  wait armed. Ops will gate and mutation-check the revision itself.
- 11:33Z — revision wait returned. Sentinel `BUILD-R1 DONE`, two
  commits (hint sanitised at the daemon with the hook's pane-id token
  rule; C0/C1 stripped in the hook's excerpt render and the CLI's human
  `inbox get`; Stop-with-defer pinned end to end), ≈ 27 source lines,
  +4 tests, ≈ 8 min wall clock with honest UTC stamps. The Stop pin passed
  immediately on the unmodified branch: the path was correct, only
  unpinned. Three RED assertions captured for the three guards.
- 11:33Z — ops discriminating check: reverted the service file to
  `5081766` → `the truncation hint allowlists the paneId — a hostile pane
  never reaches the served excerpt` fails, 62 pass; restored. Ops gate at
  the branch tip: exit 0, 55 / 579.
- 11:34Z — **ACCEPTED and LANDED.** The shepy branch had moved by one
  docs commit (`18eedae`), so the five commits were rebased onto it
  (pre-rebase tip `a65b8c2` → `be3540e`) and fast-forwarded; `pnpm build`;
  worktree and branch removed; revision builder pane closed. Evidence in
  `docs/runs/RUN-20260913-03/`.

## Results

- **Candidate accepted:** `be3540e` (five commits: `a3961b1` store/service/
  RPC, `98f1508` hook, `25c3646` CLI, `c1bdd0c` control-byte guards,
  `be3540e` Stop pin). Pre-rebase identities `675ffc3`/`f770579`/
  `5081766`/`4d7a068`/`a65b8c2` appear in the raw reports.
- **Requirement → proof:** R1 formatter regimes (a)–(d) + the rewritten
  line-budget test (verifier M4, M5). R2 the overload e2e test (verifier
  M1) + the new Stop-with-defer e2e pin. R3 store tests (verifier M2, M3)
  + refund proven load-bearing at `MAX − 1` (verifier probe). R4 RPC
  tests + redaction (verifier M6). R5 census + parse + render tests. R6
  `packages/` diff empty, `LEASE_MAX_BATCH` 20. R7 gate 55 / 579 by
  builder, verifier (575 at the candidate) and ops.
- **Self-review (builder):** disclosed four untested claims; one later
  proven by the verifier, one already mutation-covered, one closed by the
  revision, one accepted (SQLite scalar `max`).
- **Independent review contribution (verifier, both methods):**
  **[mutation]** six mutations, all caught → the shipped tests protect
  every requirement (a null result with evidence). **[probe]** one
  should-fix, pre-existing, widened by the candidate: raw paneId in the
  truncation hint → **product defect**, fixed in revision 1 with guards
  at all three render points. Probes also proved the refund matters at
  the cap and that defer-RPC failure recovers by expiry. Two
  suggestions recorded (single outcomes never defer; malformed ids are
  represented but textually absent). **Review noise: 0.**
- **Escaped defects:** none known. Follow up at the next packet touching
  the formatter, `inbox get`, or excerpt projection.
- **Deferred, tracked:** nothing. Live daemon (pid 83426, restarted by
  Ray at 10:48Z) predates items 2's RPCs; one more restart needed.

## Experience and retirement

- **What went well:** the ops-fixed design (D1–D5) needed no deviation
  beyond the builder's own honest clarification of which Stop "follows".
  Both verifier methods ran and each produced a different kind of
  evidence: mutations gave a clean null, probes found the real defect.
  Fresh revision builder: 8 min, honest UTC, kept a passing pin as a pin.
  Four of four waits reactivated the lead.
- **What went wrong:** attempt-1 builder over-reported time again (35 vs
  18). The branch had to be rebased because docs landed on `shepy`
  mid-run; harmless, but shas in the raw reports no longer match the
  landed ones (recorded above).
- **Ray interventions:** 0 after "go". Ray restarted the daemon mid-run on
  his own initiative; no effect on the run.
- **Lead turns:** ≈ 12 tool-bearing; ≈ 4 independent verification (source
  diff, mutation, gate, rebase check).
- **Timeline (UTC):** dispatch 10:45 · build done 11:03 · verifier
  11:04→11:23 · revision 11:24→11:33 · ops check + gate + land 11:33→11:34.
  **Dispatch → landed ≈ 49 min**, worker time ≈ 46.
- **Cost:** three Pi sessions on the flat z.ai subscription; notional.
- **Retained:** nothing. Panes `w31:pZ`, `w31:p0`, `w31:p12` closed;
  worktrees `item2` and `verify-item2` removed; branch deleted.

## Interpretation

- **Observed:** asking for both methods produced both. Mutation gave a
  null result with six named tests as evidence; probing found a
  pre-existing product defect the candidate widened. Neither method
  alone would have given the full picture (RUN-01: mutation only, found a
  coverage gap; RUN-02: probes only, found coverage gaps + hygiene).
- **Across RUN-01/02/03 (EXP-01):** three of three verifier rounds earned
  their cost with zero noise, on small, medium and medium tasks. Cost per
  round ≈ 6–19 worker minutes plus ≈ 3 lead turns. Not established: that
  a lead-only pass would have found less; the lead did not run an
  independent probe pass in any run.
- **EXP-07:** fresh revision builders 12 and 8 min vs retained 4 min;
  sizes differ; fresh builders twice caught something (heartbeat hazard;
  honest "passed immediately, kept as pin"). Still inconclusive, leaning
  "fresh is fine".
- **Proposed playbook change (recommend adopting):** verifier packets
  require both a mutation pass and a probe pass, findings tagged by
  method; lead timestamps are the only timing evidence; a fresh shepy
  worktree uses `pnpm install --ignore-scripts`; rebase-before-land is
  normal when docs commit mid-run, and the run record maps pre- and
  post-rebase shas.
