# RUN-20260913-01 — Reject a claim on a nonexistent profile (plan item 10a)

First pilot under the vault program `agent-orchestration-program`. One run
record, maintained incrementally. Sections below are appended as the run
advances; nothing earlier is rewritten.

## Registration (before dispatch)

- **Experiment / hypothesis:** EXP-01. A fresh same-configuration verifier
  finds consequential defects the builder's self-review did not, at a cost
  worth paying for a task of this size. A verifier finding nothing is a valid
  result, not a failed experiment.
- **Task class:** bounded bug fix with objective regression proof.
- **Outcome:** `ProfileDeliveryService.claim` refuses a claim whose profile id
  does not exist in `orchestrator_profiles`. No owner row is created. Every
  caller that branches on the claim result reports the reason honestly.
- **Non-goals:** no schema migration or foreign key; no change to lease,
  renew, release or expiry semantics; no sweep of ghost rows already in
  `~/.shepy/state.db`; no CLI verb additions.
- **Defect, verified by ops before dispatch:** `profile_owners.profile_id` is a
  bare primary key with no reference to `orchestrator_profiles`
  (`src/db/schema.ts:171`). `ProfileOwnerStore.claim` upserts unconditionally
  (`src/db/profile-owners.ts:139`). `ProfileDeliveryService.claim` passes
  straight through (`src/observability/profile-delivery-service.ts:213`)
  although the service already holds `#profiles`. So any string claims.
- **Acceptance checks:**
  - R1: claim on an unknown profile returns a typed rejection, not a throw.
  - R2: after R1 the owners table is unchanged and `owner(id)` is undefined.
  - R3: the rejection reaches RPC callers unchanged; the Pi extension and the
    Claude hook render the reason, not the "lease must expire" message.
  - R4: existing claim / re-claim / lease_active behaviour unchanged
    (existing suite green).
  - R5: `pnpm check` exit 0 in the worktree.
- **Control / treatment:** builder self-review freezes the candidate, then a
  fresh verifier on the same configuration. Measured: what the verifier finds
  beyond self-review, and its overhead.
- **Base:** `~/dev/shepy` branch `shepy` at `0072155`. Gate re-run by ops at
  that sha: `pnpm check` exit 0, 54 files / 543 tests.
- **Work surface:** worktree `~/dev/shepy-wt/pilot-10a`, branch
  `pilot/10a-ghost-owner`. Installed with `pnpm install --frozen-lockfile
  --ignore-scripts` (the `devPreinstall` husky hook fails in a fresh
  worktree). Baseline in the worktree: 54 / 543.
- **Mutation scope:** `src/observability/profile-delivery-service.ts` (claim
  only), `src/db/profile-owners.ts` (ClaimResult type only), the two call
  sites `src/cli/claude-hook.ts` and `packages/shepy-pi/src/index.ts`, and
  tests. Any widening is recorded here, never silent.
- **Root lead:** this Claude Code session, pane `w31:p1`. Supervised run:
  the wake mechanism is one background `herdr agent wait`, Shepy is the
  inspection surface, candidate evidence decides acceptance. A wait returning
  means "inspect this worker", not "the assignment succeeded".
- **Builder:** Pi, provider `zai`, model `glm-5.3-flash`, fresh pane in
  `w31`, cwd = worktree. Name `builder-10a`.
- **Verifier:** same configuration, fresh pane, detached worktree at the
  frozen candidate sha. Name `verifier-10a`. Receives requirements and the
  candidate; does not receive the builder's report until it has written its
  own findings.
- **Limits:** one builder, one verifier, no children. 90 minutes wall clock
  per role. Cost notional (flat z.ai subscription).
- **Stop conditions:** builder blocked after one retry; builder and verifier
  disagree and ops cannot reproduce the discriminating check; any mutation
  outside scope that the builder did not record.
- **Evidence location:** this file plus `/tmp/run-20260913-01/` for raw
  reports, copied into `docs/runs/RUN-20260913-01/` at acceptance.
- **Integration owner:** ops. Landing = rebase onto `shepy`, gate,
  `git merge --ff-only`, `pnpm build`, remove worktree.
- **Packet:** `/tmp/run-20260913-01/builder.packet.md` (copied beside this
  file at acceptance).

## Execution and lineage

- 2026-09-13 09:15Z — ops re-ran `pnpm check` at `0072155` in the main
  checkout: exit 0. Worktree created and installed; baseline 54 / 543.
- 2026-09-13 09:20Z — pane `w31:pT` split from `w31:p1` (right, no focus),
  cwd worktree. `herdr agent start builder-10a --kind pi -- --provider zai
  --model glm-5.3-flash`. Pi session file
  `~/.pi/agent/sessions/--Users-ray-dev-shepy-wt-pilot-10a--/2026-09-13T09-20-30-006Z_01a09a11-…jsonl`
  (historical identity, not a reusable target).
- 2026-09-13 09:21Z — packet submitted via `herdr agent prompt` from file
  (no shell interpolation). `agent get` → `working` within 4 s. One bare
  `herdr agent wait builder-10a` armed in the background. No Shepy
  subscription or profile claim for this run: the lead is a Claude session
  and the Claude adapter's idle-wake path is not qualified, so the herdr
  wait is the wake mechanism and Shepy is used for inspection only.
- Human interventions so far: 0 (Ray approved the task and limits before
  dispatch; that is the registration, not an intervention).
- 2026-09-13 09:28Z — background wait returned; the harness notification
  did reactivate the lead (first demonstration of the wake path in this
  Claude harness). Pane state `done`, sentinel `BUILD DONE` present,
  report at `/tmp/run-20260913-01/builder-report.md`. **Candidate frozen at
  `6291a60`**, 5 files, +87/−5, one commit. Wall clock dispatch→sentinel
  ≈ 7 min. The builder's self-reported "~35 minutes" is wrong by 5×;
  self-reported time is not evidence.
- 09:30Z — ops independent checks before the verifier: read the full diff
  and the two new tests; ran `vitest run test/integration/profile-delivery.test.ts`
  in the builder worktree → 50/50. Design matches the packet: check in the
  service, new `ClaimResult` variant without `owner`, both callers branch
  on `reason`. Builder retained idle in `w31:pT` pending acceptance
  (EXP-07 baseline: retain briefly).
- 09:32Z — detached verifier worktree `~/dev/shepy-wt/verify-10a` at
  `6291a60`, installed `--ignore-scripts`. Pane `w31:pV` split under the
  builder's; `verifier-10a` started on the same configuration; packet
  submitted from file; `working` within 4 s; one bare wait armed. The
  verifier packet withholds the builder report until its own findings are
  written.
- 09:38Z — verifier wait returned (lead reactivated again). Sentinel
  `VERIFY DONE`, report `/tmp/run-20260913-01/verifier-report.md`,
  wall clock ≈ 6 min (self-reported 15). Recommendation ACCEPT. R1–R5 all
  verified by tests the verifier ran itself; `pnpm check` exit 0, 54 / 545.
  Mutations: (a) remove check → 2 named tests fail; (b) reject but still
  upsert → 2 named tests fail at `expected 1 to be +0`; **(c) revert both
  Pi rendering branches → NO TEST FAILED across 86 Pi unit tests**; (c2,
  verifier's own) disable the hook branch → 1 named test fails. Probes:
  whitespace id rejected typed, zero-subscription profile still claims,
  deleted-profile seam (orphan owner row keeps renewing) reported as a
  pre-existing hole, re-claim with a token on a nonexistent profile rejected.
  Scope: exactly the five permitted files.
- Verifier vs builder: the verifier **contradicted** the builder's claim that
  the hook path was untested (it is pinned end-to-end at
  `claude-hook.test.ts:630`) and **sharpened** the builder's half-disclosed
  Pi gap into a measured one (mutation c). The verifier also found the
  deleted-profile seam the builder did not mention. Builder call-site table
  re-derived and confirmed accurate.
- Ops decision: REVISE, not accept-with-follow-up. Ray's standing rule is no
  deferred work; the gap is tests-only and small. Revision packet
  `/tmp/run-20260913-01/builder.revision-1.packet.md` sent to the retained
  `builder-10a` (EXP-07 data point: retained builder vs fresh). Scope:
  pin the Pi rendering so mutation c fails; promote the whitespace probe.
  The deleted-profile seam goes to the delivery-confidence plan item 10
  as a tracked follow-up, not into this run.

- 09:43Z — revision wait returned. Sentinel `BUILD-R1 DONE`, commit
  `b19804c`, tests only (+80 lines, two files), ≈ 4 min wall clock
  (self-reported 10). Builder proved mutation c fails two named tests.
- 09:45Z — ops discriminating check: reverted `packages/shepy-pi/src/index.ts`
  to base in the builder worktree, ran `test/unit/pi-profile-tool.test.ts`
  → 2 failed / 12 passed, the two new tests by name; restored, tree clean.
- 09:47Z — ops gate at `b19804c`: `pnpm check` exit 0, 54 / 548, the same
  3 pre-existing biome warnings (`ops-gate-b19804c.log`).
- 09:50Z — **ACCEPTED and LANDED.** `git merge --ff-only` onto `shepy`
  (`0072155` → `b19804c`), `pnpm build` so the live CLI runs the fix,
  pilot worktree and branch removed, verifier worktree removed
  (`--force`, its scratch file was already preserved), panes `w31:pT` and
  `w31:pV` closed. Closed pane and worktree ids are historical; do not
  reuse as targets.

## Results

- **Candidate accepted:** `b19804c` (fix `6291a60` + tests `b19804c`).
- **Requirement → proof:**

  | Req | Proof | Ran by |
  |---|---|---|
  | R1 typed rejection in the service | `the service rejects the claim without creating a ghost owner`; mutation a fails it | builder, verifier, ops (file run) |
  | R2 no row, owner undefined | same test + RPC test count assertions; mutation b fails at `expected 1 to be +0` | builder, verifier |
  | R3 reason reaches callers | RPC test; hook pinned by pre-existing `claude-hook.test.ts:630` (verifier mutation c2); Pi pinned by the two revision tests (ops mutation c) | verifier, ops |
  | R4 lease behaviour unchanged | store body untouched; full suite green | builder, verifier, ops |
  | R5 gate | exit 0, 54 / 548 | builder, verifier, ops |

- **Self-review findings (builder):** disclosed the Pi rendering as "not
  asserted specifically"; disclosed the two-statement race and the missing
  FK as follow-ups; call-site table accurate (re-derived by the verifier).
- **Independent review contribution (verifier), beyond self-review:**
  1. Measured the Pi rendering gap: reverting both branches left 86 tests
     green. The builder had disclosed it as minor and had the hook/Pi
     asymmetry inverted (called the pinned hook path untested). **Validated
     defect in coverage, fixed in revision 1.**
  2. Found the deleted-profile seam (orphan owner row renews forever).
     Pre-existing, out of scope, now tracked in the delivery-confidence plan
     item 10. **New finding the builder missed.**
  3. Sharpened the race note: no `await` between check and upsert, so it is
     cross-process only. **Correct refinement.**
  4. Whitespace-id probe, promoted to a shipped test. **Minor.**
- **Review noise:** none. Every verifier finding reproduced or was a
  correct reading of the code. Zero rejected findings.
- **Verifier actual checks:** ran the full gate, ran all three mandated
  mutations plus one of its own, wrote and ran 5 scratch probes over the
  real RPC socket, re-derived the consumer grep. It did not merely read.
- **Escaped defects:** none known at landing. Follow up at the next
  delivery-confidence packet that touches `claim`.
- **Deferred, tracked:** deleted-profile seam + FK decision (plan item 10).
  Live daemon (pid 82985) still runs the pre-fix code until restarted; the
  run registration forbade a restart, so that is Ray's call.

## Experience and retirement

- **What went well (evidence):** the background `herdr agent wait`
  reactivated the Claude lead three times out of three. Sentinel + report
  file were present each time; no false settling observed. The builder
  followed TDD and captured RED verbatim. The retained builder took the
  revision in ≈ 4 min with full context; a fresh builder would have had
  to re-orient (EXP-07 data point, one sample).
- **What went wrong:** (1) A fresh worktree fails `pnpm install` on the
  husky `devPreinstall` hook; `--ignore-scripts` is the workaround
  (cause: certain; cost ≈ 2 min). (2) Both workers over-reported their own
  wall clock by 2.5–5× (builder 35 vs 7 min, verifier 15 vs 6, revision 10
  vs 4); self-reported time is not evidence, the lead's timestamps are.
  (3) The builder inverted which caller was tested; self-review is not a
  reliable coverage census.
- **Ray interventions:** 0 after approving task and limits. Repeated
  explanations: 0.
- **Lead turns:** ≈ 12 tool-bearing turns for the whole run, of which
  ≈ 4 were independent verification (diff read, test-file run, mutation c,
  gate). Lead context: all reports and diffs read in full.
- **Timeline (UTC):** base verified 09:15 · builder 09:21→09:28 · verifier
  09:32→09:38 · revision 09:39→09:43 · ops checks + gate 09:45→09:48 ·
  landed 09:50. **Dispatch → landed ≈ 29 min**, of which worker time ≈ 17.
- **Cost:** two Pi sessions on the flat z.ai subscription; notional.
- **Retained:** nothing. Evidence copied to `docs/runs/RUN-20260913-01/`.
  Subscriptions: none were created (Shepy was inspection-only). Panes: both
  closed. Worktrees: both removed. Branch deleted after ff-merge.
- **Resume pointer:** none needed; the run is closed.

## Interpretation

- **Observed:** on a small bounded fix, a fresh same-configuration verifier
  found one real coverage defect and one new out-of-scope defect that
  builder self-review missed, at a cost of ≈ 6 worker minutes plus ≈ 3
  lead turns, with zero noise. The builder's disclosure of the gap was
  present but under-measured and mis-attributed.
- **Confounders:** one task, one model, one run. The verifier packet
  mandated mutation testing, so the finding may be attributable to the
  packet design (requirement-first + mandated mutations) rather than to
  "a second agent" as such. Ray was not present, so subjective friction
  is unmeasured.
- **EXP-01 within this scope:** supported. Independent review earned its
  cost on a task this small, which was not the expected result. Not
  established: whether a lead-only mutation check would have found the
  same gap cheaper (ops did run mutation c, but only after the verifier
  named it).
- **Next discriminating experiment:** EXP-03 variant on the next
  delivery-confidence packet (item 2 or 3): give the verifier the packet
  but no mandated mutation list, and see whether it still measures
  coverage. Separately, EXP-07 with a fresh builder for the revision.
- **Proposed playbook change (not adopted yet):** mandate mutation testing
  in every verifier packet; treat worker-reported time as unknown and use
  lead timestamps; add `pnpm install --ignore-scripts` to the shepy
  worktree recipe.
