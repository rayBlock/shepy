# RUN-20260913-02 — One admission rule for lease expiry (plan item 3)

Second run under the vault orchestration program. Serial with item 2
(RUN-20260913-03) because both touch the delivery service and the hook.

## Registration (before dispatch)

- **Experiment:** EXP-01 repeat with one variable changed toward EXP-03:
  the verifier packet does **not** mandate mutation testing or name
  mutations. Question: does a same-configuration verifier measure coverage
  on its own, or was RUN-01's finding a product of the packet?
- **Task class:** bounded correctness fix with a recovery path; medium.
- **Outcome:** `inboxLease` admits a lease only while the owner's lease is
  alive under the same predicate `renew` and `claim` use. A Claude hook
  whose turn outlived its lease recovers on `Stop` by re-claiming with
  proof of possession when uncontested, and fails closed with a warning
  when a rival took the profile.
- **Non-goals:** lapsed-row sweep (held), Pi renew cadence, `pendingCount`,
  anything in item 2 (render/ack set, `formatHookContext`).
- **Defect, verified by ops before dispatch:**
  `inboxLease` (`profile-delivery-service.ts:259`) checks
  `owner.leaseToken === input.leaseToken` only; `renew`
  (`profile-owners.ts:191`) and `claim` (`:131`) apply
  `leaseExpiresAt + DEFAULT_LEASE_GRACE_MS` against now. RPC error envelope
  (`observability-server.ts:304`) serialises only `message`, so callers
  cannot distinguish refusal kinds. Pi renews every 10 s
  (`shepy-pi/src/index.ts:500`); the Claude hook claims on
  `UserPromptSubmit` only and never renews during a turn.
- **Acceptance:** R1–R7 in the packet.
- **Base:** `shepy` at `9f49898` (docs on top of `b19804c`). Gate at
  `b19804c`: exit 0, 54 / 548.
- **Work surface:** `~/dev/shepy-wt/item3`, branch `pilot/item3-lease-admission`.
- **Mutation scope:** `src/db/profile-owners.ts` (shared predicate),
  `src/observability/profile-delivery-service.ts` (`inboxLease`),
  `src/daemon/observability-server.ts` (error envelope `code`),
  `src/daemon/client.ts` (surface `code`), `src/cli/claude-hook.ts`
  (`handleStop` recovery), tests. Pi extension: read, not changed unless
  the builder proves it must.
- **Roles:** lead = this Claude session (`w31:p1`), supervised. Builder
  `builder-item3`, verifier `verifier-item3`, both Pi `zai/glm-5.3-flash`,
  fresh panes. Revision, if any, goes to a **fresh** builder (EXP-07 arm).
- **Limits:** 120 min wall clock per role; one builder + one verifier;
  no children.
- **Stop conditions:** as RUN-01, plus: any change to the ack set or the
  formatter is a scope violation.
- **Evidence:** this file + `/tmp/run-20260913-02/`, copied at acceptance.

## Execution and lineage

- 09:55Z — worktree created at `9f49898`, installed `--ignore-scripts`.
- 09:57Z — pane `w31:pW` (split right of `w31:p1`, no focus), `builder-item3`
  on Pi `zai/glm-5.3-flash`; packet `/tmp/run-20260913-02/builder.packet.md`
  submitted from file; `working` within 4 s; one bare wait armed.
- Ray's mid-run question answered: daemon verbs are `stop` / `start` /
  `restart`; the daemon (pid 82985) is not consumed by these runs.
- 10:19Z — builder wait returned (lead reactivated). Sentinel `BUILD DONE`.
  **Candidate frozen at `8b5fa09`** (two commits: `efe6c6a` liveness rule +
  refusal codes, `8b5fa09` Stop recovery). 8 files, +580/−31. Wall clock
  dispatch→sentinel ≈ 22 min; the builder self-reported "~21 minutes" with
  local-time stamps mislabelled Z — the honesty prompt worked, the clock
  label did not. Report claims 55 / 556, 7 RED tests captured verbatim,
  lapse injected by direct sqlite update of `lease_expires_at`. Builder
  disclosed: three pre-existing clock-simulation hook tests were modified
  (`keepOwnerLeaseAheadOfSimulatedNow`) because admission now judges
  liveness at the injected `now`. Ops will read that adaptation itself.
- 10:22Z — ops read the full source diff: predicate `isLeaseAlive` used in
  all three places; `InboxRefusedError` with `code`; envelope + client carry
  `code`; Stop recovery is one re-claim + one lease, contention warns via
  `lapsedRecoveryWarning` and throws the expected-failure surface. Matches
  the packet. Verifier worktree `~/dev/shepy-wt/verify-item3` at `8b5fa09`;
  `verifier-item3` started in a pane under the builder's; packet has NO
  mutation instructions (the EXP-03 variable). Builder retained idle.
- 10:30Z — verifier wait returned (lead reactivated). Sentinel `VERIFY
  DONE`, ≈ 10 min wall clock (self-reported 20, local-time stamps).
  `pnpm check` exit 0, 55 / 556. All R1–R7 PASS by tests it ran itself.
  **With no mutation instruction, the verifier performed no mutation
  testing at all.** Instead it wrote 7 probes over the real RPC stack:
  same-instant agreement of claim/renew/lease at the exact lapse boundary
  (P1a/P1b), stale-and-lapsed classification (P2), late Pi renew (P3),
  predicate boundary (P4), `stop_hook_active` on a lapsed owner (P5), and a
  contested recovery write (P6). It also established that the wire never
  forwards `now` into `inboxLease`, so the fence cannot be bypassed.
  Findings: no blocker, no should-fix; three suggestions — the server echoes
  any string `.code` (a Node `EACCES` would ride the envelope as a "stable
  code"), a recovery-then-crash window that self-heals within one lease,
  and keeping `now` off the wire.
- Verifier vs builder: it exercised the CAS-lost branch the builder called
  "argued safe, not exercised" (P6), pinned the same-instant agreement the
  builder had no test for (P1), and covered `stop_hook_active` (P5). It did
  not re-run the RED phase at base and said so. Its scratch probes: 7 pass.
- Ops decision: ACCEPT the candidate; one revision to ship the probes and
  close the `.code` echo before landing (no deferral). Per the run plan the
  revision goes to a **fresh** builder (EXP-07 arm: fresh vs retained).
  Both attempt-1 panes closed at 10:32Z; verifier worktree removed after
  copying its probes and check log to `/tmp/run-20260913-02/`.
- 10:31Z — fresh builder `builder-item3-r1` (Pi `zai/glm-5.3-flash`, pane
  `w31:pY`, same worktree and branch) given the revision packet: promote
  probes P1a/P1b, P2, P5, P6 into the suite; only refusal errors carry a
  wire code (base class + `instanceof` in the server, with an `EACCES`
  negative test). `working` within 4 s; one bare wait armed. Ops will gate
  and mutation-check the revision itself; no second verifier round.
- 10:43Z — revision wait returned. Sentinel `BUILD-R1 DONE`, commits
  `da79fed` (5 promoted tests) + `2dea955` (`RpcRefusedError` base class,
  server serialises `code` only for `instanceof`), ≈ 12 min wall clock
  (self-reported "~10 min, UTC" — first honest UTC self-report of the day).
  The fresh builder found and documented a real hazard in promoting P1:
  `renew` is a heartbeat, so a naive single-fixture merge moves the
  boundary; it kept one test with an unextended claim per side.
- 10:43Z — ops discriminating check: reverted the server file to `8b5fa09`
  (any-code echo) → `only deliberate refusals carry a wire code; a system
  error's code never rides the envelope` fails, 57 pass; restored. Ops gate
  at `2dea955`: exit 0, 55 / 561.
- 10:45Z — **ACCEPTED and LANDED.** `git merge --ff-only` `9f49898` →
  `2dea955`; `pnpm build`; item 3 worktree and branch removed; revision
  builder pane closed. Evidence copied to `docs/runs/RUN-20260913-02/`.

## Results

- **Candidate accepted:** `2dea955` (`efe6c6a` rule + codes, `8b5fa09` Stop
  recovery, `da79fed` promoted probes, `2dea955` coded-error allowlist).
- **Requirement → proof:** R1 `isLeaseAlive` sole arithmetic site, three
  callers, plus the promoted same-instant test (verifier). R2 service +
  wire tests, `not_owner` prose unchanged; `EACCES` negative test (ops
  mutation). R3/R4 the two Stop lapse tests; R4 wording pinned in a unit
  test. R5 the prompt-path lapsed-reclaim pin (gated `runIf`, verified to
  run). R6 Pi untouched, verifier-confirmed by source read + probes. R7
  gate 55 / 561 by builder, verifier and ops.
- **Self-review (builder):** honest untested list (CAS-lost branch,
  `stop_hook_active`, empty recovery lease, deadlines); disclosed the
  three adapted clock-simulation tests with rationale.
- **Independent review contribution (verifier, no mutation mandate):**
  no product defect, no coverage defect in the "test does not protect"
  sense. Three exercisable gaps closed by its probes (same-instant
  agreement, `stop_hook_active`, contested CAS) → **coverage additions**,
  now shipped. One contract-hygiene defect (any-code echo) → **product
  hardening**, now shipped. One pre-existing self-healing crash window
  (reclaim-then-die) → **out-of-scope observation**, recorded below.
  Established that `now` never crosses the wire. **Review noise: 0.**
- **Verifier actual checks:** full gate; targeted runs of every new test;
  7 probes over the real RPC stack at the exact lapse instant; consumer
  grep; scope check. It did not re-run RED at base and said so.
- **Escaped defects:** none known. Follow up at the next packet touching
  `handleStop` or the owner file.
- **Deferred, tracked:** reclaim-then-crash window (self-heals within one
  lease, warning names the pane's own id); belongs with plan item 7
  (request deadlines / attempt classification). Live daemon still pre-fix.

## Experience and retirement

- **What went well:** three of three waits reactivated the lead. Both
  builders captured RED verbatim. The fresh revision builder oriented from
  `git log` + the packet alone and finished in ≈ 12 min; it caught a
  subtlety (renew heartbeat) the verifier's probes had papered over with
  two fixtures. The design fixed up front (one predicate, coded refusal,
  one recovery attempt) needed no deviation.
- **What went wrong:** nothing blocking. Workers still label local time as
  UTC (builder 1); the revision builder got it right after being asked.
  The verifier left a scratch test in the worktree (fine, it said so).
- **Ray interventions:** 0 after "go". One mid-run question (daemon verbs),
  answered without affecting the run.
- **Lead turns:** ≈ 14 tool-bearing turns; ≈ 4 independent verification
  (source diff, adapted-test read, mutation, gate).
- **Timeline (UTC):** dispatch 09:57 · build done 10:19 · verifier
  10:20→10:30 · revision 10:31→10:43 · ops checks + gate 10:43→10:45 ·
  landed 10:45. **Dispatch → landed ≈ 48 min**, worker time ≈ 44.
- **Cost:** three Pi sessions on the flat z.ai subscription; notional.
- **Retained:** nothing. Panes `w31:pW`, `w31:pX`, `w31:pY` closed;
  worktrees `item3` and `verify-item3` removed; branch deleted after
  ff-merge. No Shepy subscriptions were created.

## Interpretation

- **Observed:** without a mutation mandate the verifier did no mutation
  testing; it wrote boundary probes instead and found three coverage gaps
  plus one hardening defect, with zero noise. Same model, same task class
  as RUN-01, different packet → different method.
- **Reading (EXP-03 flavour):** the verifier's method is packet-driven.
  Mutation testing measures whether existing tests protect; probing finds
  what no test exercises. They are complementary, and neither happens
  reliably unless asked. Confounder: one run each; the tasks differ in
  size.
- **EXP-07 (fresh vs retained revision builder):** fresh builder ≈ 12 min
  for a tests-plus-small-source revision vs retained builder ≈ 4 min for a
  tests-only revision in RUN-01. Not comparable in size; the fresh builder
  paid ≈ 3 min orientation and found a real subtlety the retained one
  might have missed or might not. Inconclusive; needs a same-size pair.
- **Proposed playbook change (not adopted yet):** the verifier packet asks
  for both a mutation pass and free probes, and states that the report
  must say which of the two found each finding.
