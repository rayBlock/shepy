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

- state: building
- lead: `w31:p1` (Claude Code, supervised)
- workers: `builder-ctx` in `w31:p19` (Pi `zai/glm-5.3-flash`, reasoning high, verified on the pane), profile `run-06-builder`, operation `op_7a4a0062662bf9e824dde073`
- worktrees: `~/dev/shepy-wt/ctx-health` (branch `pilot/context-health`, base `8d1d0b0`)
- waits armed: ONE `shepy wait op_7a4a0062662bf9e824dde073 --json` (background, lead harness task `bjt7pu45r`) — the repaired daemon's first useful qualification; if it fails or returns `transport_unknown`: inspect once, then one bare `herdr agent wait builder-ctx`, recorded here
- next safe action: when the wait returns, record its outcome in the lineage FIRST (qualification), then read the sentinel and `/tmp/run-20260913-06/builder-report.md`; freeze; verifier
- updated: 2026-09-13T13:20Z

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

## Results

_(appended at acceptance)_

## Experience and retirement

_(appended at retirement)_

## Interpretation

_(appended at synthesis)_
