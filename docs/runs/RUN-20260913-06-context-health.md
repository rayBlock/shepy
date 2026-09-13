# RUN-20260913-06 — Context health projection for Pi and Claude sessions (PORTFOLIO-MC01)

Sixth run. First run delegated by the interim portfolio coordinator (Pi
`wP:p70`, profile `portfolio-ray-local`) under Ray's dispatch instruction
recorded in the vault (`agent-portfolio-coordination.md` §10). Assignment
bytes preserved verbatim at `docs/runs/RUN-20260913-06/assignment.md`,
sha256 `e3d719d4897539363b4a58e724ff24f26eb943220ed6cda09365e1af55b84199`
(matches the coordinator's frozen hash). Authority: bounded supervised
local engineering run; lead owns the run, worktree, children and the
acceptance recommendation; portfolio owns cross-program acceptance.

## Live

- state: **LANDED** `36fe131` (shepy branch), retired; accepted within scope by the lead, portfolio owns cross-program acceptance
- lead: `w31:p1` (Claude Code, supervised)
- workers: none (all panes closed)
- worktrees: none (both removed; branch `pilot/context-health` deleted)
- waits armed: none
- next safe action: the next `shepy daemon restart` (not authorized in this run) makes `contextHealth` visible on the live `agent.get`; then the controlled continuity experiment in Interpretation
- updated: 2026-09-13T14:15Z

## Registration (before dispatch)

- **Experiment:** EXP-08 (infrastructure: repaired `operation.wait` on
  the restarted daemon pid 53303, recorded separately from acceptance);
  EXP-01/03 (verifier with named negative cases, both methods); EXP-07
  (fresh builder for any revision). Observational engineering run, not a
  topology proof.
- **Task class:** medium additive read-only feature: a typed context
  health projection on the existing agent inspection surface.
- **Outcome:** `agent.get` (and `shepy agent get`) report, per Pi/Claude
  session: session and model identity, a `last_reported` occupancy
  reading with its timestamp and source ref or an `unavailable` reason,
  the last recorded compaction boundary with only the fields the source
  actually records, compaction count, branch, and explicit limitation
  codes. Null/unknown is a valid answer. No wall clock in the projection
  (cache stays valid), no new store, no harness config, no `/compact`.
- **Source facts established by ops 13:15–13:17Z (no researcher; the
  remaining questions were answerable from the files):** Pi entries
  `session` header (id), `model_change` (provider, modelId), assistant
  `message.usage {input, cacheRead, cacheWrite, output, totalTokens}`,
  `compaction {tokensBefore, firstKeptEntryId, usage(summariser call),
  fromHook}` — no tokensAfter/trigger/duration/outcome. Claude entries
  carry `sessionId`/`gitBranch` each; assistant `message.model` +
  `usage {input_tokens, cache_creation_input_tokens,
  cache_read_input_tokens}`; boundary `type:"system",
  subtype:"compact_boundary", compactMetadata {trigger, preTokens,
  postTokens, durationMs}`; the summary is a `user` entry with
  `isCompactSummary` (not a boundary). Shepy: `CompactAgentHistory` is
  the cached, fingerprinted blob behind `agent.get`; readers parse once;
  `agentHistoryFormatterVersion` invalidates the cache; the change
  detector compares the blob's JSON (`agent-context-service.ts:212`).
  `tool-compaction.ts` is tool-output shortening, unrelated.
- **Design (ops), D1–D7 in the packet:** additive `contextHealth` on
  `CompactAgentHistory`; one pure projection module; readers parse the
  file once; occupancy = last assistant prompt size (input + cache
  fields), never summed totals; compaction later than the reading →
  `unavailable/post_compaction_no_turn`; model change after the reading
  → `unavailable/model_changed_since_reading`; Claude branch change →
  reading kept, `current:false`; window/percent null with limitation
  `context_window_not_recorded`; formatter version → `agent-history-v2`;
  CLI `context:` block; `agent.list` unchanged; D7 requires a test that a
  compaction-only source change creates no delivery obligation, and if
  it does, report rather than patch.
- **Base:** `shepy` at `8d1d0b0` (gate 57 / 619).
- **Work surface:** `~/dev/shepy-wt/ctx-health`, branch `pilot/context-health`.
- **Mutation scope:** `src/observability/contracts.ts`,
  `src/agent-history/{context-health.ts (new), pi-reader.ts,
  claude-reader.ts, readers.ts, service.ts}`, `src/cli/shepy.ts`
  (render), tests. Nothing under `src/db/`, `src/daemon/`, `packages/`.
- **Roles:** builder `builder-ctx`, verifier `verifier-ctx`, Pi
  `zai/glm-5.3-flash` (configured provider/model verified on the pane's
  `agent start` line; no fallback). One active child at a time.
- **Limits (from the assignment):** 150 min total envelope from 13:15Z;
  investigation ≤ 30 min (used ≈ 10); builder 75 min; verifier 60 min;
  one corrective cycle.
- **Stop conditions:** need for a new store, harness configuration, or
  active instrumentation → stop that branch, return the smallest
  decision-ready proposal. Any write path or `/compact` in the diff =
  scope violation.
- **Evidence:** this file + `docs/runs/RUN-20260913-06/` + `/tmp/run-20260913-06/`.

## Execution and lineage

- 13:15Z — assignment received (operation from `portfolio-shepy-mc01`),
  hash verified. Vault §1/§3/§9/§10 read.
- 13:17Z — worktree at `8d1d0b0`, `pnpm install --frozen-lockfile
  --ignore-scripts` (existing procedure, no version changes).
- 13:19Z — packet `/tmp/run-20260913-06/builder.packet.md` written; record
  registered (this file) before dispatch.
- 13:19:59Z — pane `w31:p19`, `builder-ctx` started (`--provider zai
  --model glm-5.3-flash`; pane header confirms `(zai) glm-5.3-flash •
  high`). Profile `run-06-builder` bound by name, `matched` on the first
  poll. `shepy dispatch --prompt-file` → `accepted`,
  `op_7a4a0062662bf9e824dde073`; Herdr `working` in 4 s; target
  `w31:p19` / `term_65b5d2c465ad3ae`.
- 13:20Z — **qualification wait armed:** ONE `shepy wait
  op_7a4a0062662bf9e824dde073 --json` in the lead's background (daemon
  pid 53303, buildStamp 2026-09-13T12:41:47.820Z). Outcome to be
  recorded here verbatim, separately from candidate acceptance.
- 13:25Z — **acceptance clarification from portfolio (agent-origin, same
  scope):** D4 mapped Claude `gitBranch` but not Pi conversation lineage;
  and "model changed since reading" compared only the final model, so
  A→B→A would pass. Ops verified in the installed Pi types/docs
  (`dist/core/session-manager.d.ts`, `docs/sessions.md`): entries form a
  tree (`id`/`parentId`); `/tree` moves the leaf and appends NOTHING
  unless a `branch_summary` is chosen (`fromId` = abandoned leaf,
  `parentId` = new position, `usage` = summariser call). So the only
  provable active lineage is the parent walk from the last appended
  entry; a silent leaf move is invisible until the next append → named
  limitation, not a guess. No local session contains a `branch_summary`
  (all synthetic fixtures). Also found: Claude writes subagent
  transcripts into the same file with `isSidechain: true`, whose small
  usage would be a false-current reading. → **Addendum 1**
  (`/tmp/run-20260913-06/builder.addendum.md`): D8 active lineage with
  `lineage_unresolved` / `branch_switched_since_reading` /
  `no_usage_on_active_lineage` / `leaf_move_not_recorded_until_next_append`;
  D9 any model-change event after the reading on the lineage; D10
  sidechains excluded, `claude_lineage_by_file_order`. Verifier packet
  gained R11–R13, mutations (9)–(11) and six probes.
- 13:31:28Z — addendum pointer delivered to the working builder as a Pi
  steering prompt (`agent_prompted`, status stayed `working`); the
  existing Shepy wait untouched. Cheaper than spending the one corrective
  cycle on a known miss; if the builder ignores it, the verifier's R11–R13
  catch it and the corrective cycle is used.
- Portfolio's separate observation preserved as a distinct timing case,
  not acted on here: its late-armed 10 s `shepy wait` on the parent
  operation `op_5ddd8e4583b23ed0e507ef7a` returned `wait_timeout` after
  this lead's setup response; durable state `submitted`. Different case
  from this run's early-armed, open-ended builder wait.
- 13:46:20Z — **QUALIFICATION RESULT (repaired `operation.wait`, daemon
  pid 53303):** the single `shepy wait op_7a4a0062662bf9e824dde073
  --json` armed 13:20:11Z returned at 13:46:20Z with
  `{"outcome":{"kind":"settled","operationId":"op_7a4a0062662bf9e824dde073"}}`,
  exit 0; durable row: `lifecycle: "settled"`, `errorSummary: null`,
  `promptSha256 e67abd56…`. Herdr: `done`. One wait, one return, no
  fallback needed. This is one successful sample of the repaired path on
  useful work; it is not crash-safety or idle-wake qualification.
- 13:46Z — builder settled; sentinel `BUILD DONE`; ≈ 26 min by lead clock
  (self-report `13:20:07Z → 13:45:07Z`, honest). **Candidate frozen at
  `5a538af`** (`505adff` contract+projection+readers+v2, `65d9af7` CLI,
  `5a538af` RPC/D7 test). 15 files, +2 081/−78, 60 / 650, gate exit 0.
  Addendum 1 folded in before any commit. Disclosed honestly: the
  implementation was drafted before the RED run; RED was then captured
  against base by stashing `src/`. D7 result: a compaction-only append
  changes the snapshot and `agent.context.changed` fan-out but mints no
  delivery obligation (obligations come only from agent events) — proven
  with a real profile + subscription, zero rows before and after.
- 13:47:12Z — builder pane closed; detached `~/dev/shepy-wt/verify-ctx`
  at `5a538af`; `verifier-ctx` in `w31:p1A` (`(zai) glm-5.3-flash •
  high` confirmed), profile `run-06-verifier` `matched` on the third
  poll (≈ 9 s), `shepy dispatch` → `op_fe7db5963dcacf6c2ce1fb63`, Herdr
  `working` in 4 s. Second native `shepy wait --json` armed.
- 13:48–13:52Z — **ops adjudication by reading + scratch probes in the
  builder worktree (file deleted after; tree clean), three defects:**
  - **O1 `[probe]` BLOCKER — Pi `sessionId` is null on real files.** The
    lineage walk stops at the first entry (`parentId: null`); the
    `session` header has no `parentId` and nothing points at it, so the
    `type === "session"` branch inside the walk never runs. The shipped
    fixture hides it: `ROOT = "pi-session-1"` links the first entry to
    the header id, which real Pi files never do (verified on today's
    sessions: first entry `model_change` with `parentId: null`).
    Fixture-assumption trap. Fix: session id from the header entry
    regardless of lineage; correct every fixture to `parentId: null` at
    the root.
  - **O2 `[probe]` should-fix — false zero.** `usage {input:0, cacheRead:0,
    cacheWrite:0}` (Pi writes zeros for providers that do not report;
    Claude equivalent) projects as `last_reported`, `tokens: 0`. A billed
    prompt of 0 is not a reading. Fix: a zero sum is no usage.
  - **O3 `[probe]` should-fix — false current.** A later assistant turn on
    the lineage with absent (or zero) usage leaves the earlier reading
    `current: true`, `reason: null`. The context grew by an unknown
    amount. Fix: any assistant turn after the reading → `current: false`,
    reason `later_turn_without_usage`.
  Verifier not told (independence); these go into the corrective cycle
  alongside its findings.
- 14:00:10Z — **QUALIFICATION SAMPLE 2:** `shepy wait
  op_fe7db5963dcacf6c2ce1fb63 --json` armed 13:47:21Z returned
  `{"outcome":{"kind":"settled",…}}`, exit 0, durable `settled`,
  `errorSummary null`. Two of two native waits on the repaired daemon.
- 14:00Z — verifier settled, sentinel `VERIFY DONE`, ≈ 13 min
  (self-report `13:47:17Z → 13:58:37Z`, honest). **REVISE.** Gate exit 0
  at 60 / 650; 11 mutations applied, 11 caught (including file-order
  lineage, final-model-only, sidechain inclusion); 20 probes, 19 clean.
  F1 `[probe]` should-fix: an EMPTY file projects `lineage_unresolved`
  instead of `no_usage_recorded`. S1 `[read]` `unavailable` readings say
  `current: true` (adopted → false); S2 undefined→string branch raises
  no marker (left, defensible); S3 no CLI test for a hostile reason
  string (adopted); S4 snapshot lag is pre-existing design (noted).
  **The verifier did not find O1–O3.** Its R6 PASS ("Pi sessionId from
  lineage header") trusted the shipped fixture, whose root entry points
  at the header id; the packet forbade reading real transcripts and the
  registration's shape list did not state that real root entries carry
  `parentId: null`. Fixture-assumption trap, second time today; lesson
  for the skill: the verifier packet must state the ROOT LINKAGE of real
  files, not only entry shapes.
- 14:01:01Z — verifier pane closed; dead `builder-ctx` selector
  unsubscribed; fresh `builder-ctx-r1` in `w31:p1B` (`(zai) glm-5.3-flash
  • high`), `matched` on the first poll, `shepy dispatch` →
  `op_fe12c375566c6357ab4bbdfb`, `working` in 4 s. Third native wait
  armed. Packet `/tmp/run-20260913-06/revision-1.packet.md`: O1 (header
  session id + real-linkage fixtures), O2 (zero sum = no usage), O3
  (`later_turn_without_usage`, precedence documented), F1, S1, S3.
- 14:11:56Z — **QUALIFICATION SAMPLE 3:** `shepy wait
  op_fe12c375566c6357ab4bbdfb --json` armed 14:01:11Z returned
  `settled`, exit 0, durable `settled`. Three of three.
- 14:12Z — revision settled, `BUILD-R1 DONE`, ≈ 11 min (self-report
  `14:01:06Z → 14:11:14Z`, honest). Commit `4e733ef`: 6 files, +343/−21;
  `context-health.ts` +32/−14 (header session id; zero sum = null;
  `lastAssistantPosition` + `later_turn_without_usage`; empty-file early
  return; `unavailable` → `current:false`; precedence comment),
  `contracts.ts` +2, fixtures re-rooted to `parentId: null`, +10 tests.
  RED captured for O1 (2 failures incl. the RPC test), O2 (2), O3 (5),
  F1 (Pi; the Claude empty case passed immediately and is kept as a
  pin); S3 passed immediately (renderer already safe), kept as a pin.
  Disclosed consequence: the Claude branch-change fixture had to move
  its branch change onto a usage-less `user` entry, because its old
  form also contained a later assistant turn without usage and now
  yields the higher-precedence marker — the old pin had stacked two
  markers unknowingly. Gate 60 / 660.
- 14:12–14:13Z — **ops adjudication against the revision (scratch test,
  deleted, tree clean): 5 / 5 pass** — O1 real-linkage session id; O2
  zero usage Pi+Claude → `unavailable`/`no_usage_recorded`/`current:false`;
  O3 later turn → `current:false` with `later_turn_without_usage`, a
  later compaction outranks it, a `branch_summary` leaf below it; F1
  empty → `no_usage_recorded` without `lineage_unresolved`; A→B→A after
  the reading → `unavailable`, `changedAt` = second change. Source diff
  read in full: exactly the named findings, no drift.
- 14:13Z — `pnpm check` in the worktree exit 0, 60 / 660. Rebased onto
  shepy `8d51dea` (three docs commits mid-run; no conflicts) →
  `6d2c3a2`, `1cb2aa6`, `a99d406`, `36fe131`. `git merge --ff-only` →
  tip `36fe131`. Gate at the tip exit 0, 60 / 660. `pnpm build` exit 0.
  Pane `w31:p1B` closed, both worktrees removed, branch deleted.
- 14:13:32Z — live check against the still-running daemon (pid 53303,
  pre-RUN-06 code; restart NOT authorized by this assignment):
  `shepy agent get w31:p1 --json` has no `contextHealth` key, as
  expected. The projection becomes live at the next restart.

## Results

- **Accepted within scope and landed** `36fe131`. Gate 60 files / 660
  tests at the tip. 15 + 6 files; one corrective cycle; zero Ray or
  portfolio interventions after the acceptance clarification.
- Delivered (read-only, additive): `CompactAgentHistory.contextHealth`
  (`src/observability/contracts.ts`) computed by one pure module
  `src/agent-history/context-health.ts` from the session file Shepy
  already reads once per `readCompact`; served by `agent.get` and
  `shepy agent get` (`context:` block); `agent.list` unchanged; cache
  invalidated once via `agent-history-v2`; no store, table, migration,
  hook, config, or `/compact`. Fields: `source`, `sessionId` (Pi header /
  Claude last entry), `model {id, provider, changedAt}`, `usage {kind
  last_reported|unavailable, tokens, reportedAt, ref, current, reason,
  window:null, percent:null}`, `lastCompaction {trigger, tokensBefore,
  tokensAfter, durationMs, timestamp, ref}`, `compactionCount`, `branch`,
  `sourceUpdatedAt`, `limitations[]`.
- Honesty rules landed and mutation-pinned: occupancy = one assistant
  turn's billed prompt, never a sum or `totalTokens`; compaction, any
  model change (A→B→A), a later usage-less turn, a Pi `/tree` branch
  switch and a Claude git-branch change each stop an old reading from
  passing as current; zero usage is no usage; Pi active lineage from the
  last appended entry; Claude sidechains excluded; empty ≠ broken.
- **Unavailable in v1, named as limitations:** context window and
  percent (neither source records the window:
  `context_window_not_recorded`); Pi compaction outcome/trigger/after
  (`compaction_outcome_not_recorded`); a Pi `/tree` move before the next
  append (`leaf_move_not_recorded_until_next_append`); Claude lineage
  (`claude_lineage_by_file_order`); Claude provider (null, not
  invented); `measured`/`estimated` kinds are defined in the contract
  but never produced — they would need the harness's own
  `getContextUsage()` and are out of this slice.
- Verification: attempt-1 verifier 11/11 mutations caught, 20 probes,
  REVISE on F1; ops probes found O1 (blocker on real files), O2, O3;
  ops re-adjudicated the revision 5/5. No fresh verifier on the revision
  (the one corrective cycle was spent; the lead's adjudication and the
  RED captures stand as the evidence).
- **Qualification (separate from acceptance):** three of three native
  `shepy wait --json` calls on the repaired daemon returned `settled`
  with durable `settled` rows, on 26, 13 and 11 minute operations. The
  portfolio's late-armed 10 s wait returning `wait_timeout` on a
  `submitted` parent is a distinct, preserved case.

## Experience and retirement

- Assignment received 13:15Z → landed 14:13Z, **≈ 58 min of the 150-min
  envelope**; investigation ≈ 10 of 30. Worker time ≈ 26 + 13 + 11 = 50
  min, all on `zai/glm-5.3-flash` (flat subscription; pi's `$` figures
  notional). Lead effort: design + two packets + addendum + three
  adjudication rounds by reading and scratch probes.
- One mid-run acceptance clarification from portfolio (lineage, A→B→A)
  handled by a steering addendum to the working builder rather than a
  revision cycle; the builder folded it in before its first commit.
- Two fixture-assumption traps in one run: the builder's fixtures linked
  Pi root entries to the header (real files: `parentId: null`), and a
  Claude fixture stacked two staleness markers. The verifier, forbidden
  from reading real transcripts, could not see the first. Neither the
  builder nor the verifier found O1–O3; the lead's own probes did.
- All three workers reported honest UTC (packets demanded `date -u`).
- Retired 14:13Z: no panes, no worktrees, no branch, no waits. Live
  daemon unchanged.

## Interpretation

- **EXP-08:** the repaired `operation.wait` carried all three wakes of a
  real run. Dispatch-through-Shepy plus one native wait is now the
  default in the run-lead skill; the bare-Herdr fallback stays documented
  for older daemons.
- **EXP-01/03:** a verifier with named negative mutations is necessary
  but not sufficient — it verified the candidate against fixtures that
  shared the builder's false assumption. The lead's independent probes
  against REAL file shapes were the decisive check. Skill rule: the
  verifier packet must state the root linkage and other structural facts
  of real files, and the lead re-derives at least one fixture from a
  real file's metadata before accepting.
- **Next controlled continuity experiment (not started, needs its own
  authorization):** on a synthetic helper session, drive a Claude
  `/compact` and a Pi `/compact`, and check `agent.get` before and after
  shows `post_compaction_no_turn` then a fresh `last_reported` on the
  next turn, with the boundary's trigger/tokens matching the file; then
  the manager-continuity test proper (goals, workers, waits, decisions,
  candidate ids preserved across the boundary) which this slice observes
  but does not test.
- A new active data source (the harness's `getContextUsage()` for a
  `measured` kind and the window) is a design decision for portfolio,
  not a v1 gap to paper over.
