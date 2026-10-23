# Review SHEPYGONE — rev-shepygone

**ACCEPT** — candidate `07eb466912ffe15f403ea1dd017652b29fffad0e` (`night/shepygone`, base `6744ff6`), reviewed in the detached worktree `/Users/ray/dev/shepy-wt/night-rev-shepygone`. Scope: the full diff (7 files, +487/−34) — durable completion journal (`agent-index-service.ts:807`, `agent-events.ts:152`), restart recovery (`agent-index-service.ts:729`), late-subscription departure recovery (`profile-delivery-service.ts:294`), and the regression tests.

## Findings

- **LOW** `agent-index-service.ts:748-756` — the restore identity guard checks agent kind, terminal and `agentSession`. For session-less kinds (screen fallback, `agentSession: null` on both sides), a same-kind replacement in the same terminal after a restart can inherit the previous occupant's journaled completion, so its mid-first-turn close counts as finished. Narrow window (journal written, daemon down through exit+relaunch, replacement still working); no crash, duplicate or data loss; the terminal's last native completion did happen. Reproduction: journal a working→done with null session, replace the worker in the same terminal before the next observation, close mid-turn. Suggestion for a later row: also compare `payload.paneId` or a firstSeenAt epoch in the journal.
- **INFO** close preempting the deferred read flushes the completion with a stripped excerpt even if the transcript had flushed (`agent-index-service.ts:325-337`) — outcome type is correct, verdict text absent. Pre-existing honest behavior, documented in the builder report and README; my probe A shows the non-preempted restart path does deliver the verdict text.
- **INFO** `findPendingSettlement` returns the latest of the four status types; a newer `agent.tool.failed` or `agent.blocked` twin correctly hides or rejects the journal, and a done→working transition (later turn) makes the row non-restorable — traced and covered by the resumed-worker regression.

## Executed checks (all `env -i`, fresh 0700 HOME/TMPDIR, Node 24.18.0 first on PATH, no CLAUDE* variables; scratch `/private/tmp/factory/rev-shepygone/`)

- Base `6744ff6` + candidate tests: **6 failed / 27 passed, 9.9 s** — restart=true fails with exactly the driffs symptom (`expected [ 'agent.gone' ] to deeply equal [ 'agent.done' ]`), all three late-subscription cases, resumed-worker, and the journal assertion; restart=false passes on base as the control.
- Candidate focused: new regressions 6/6, 1.0 s; lifecycle/notice/delivery/history set 222/222, 11.4 s.
- Independent probes (scratch copy, own fixture): recovered retry after restart delivers verdict text, commits done, later close quiet (gone from=done); unfinished worker across restart reports gone exactly once from=working; late subscriber holding the newest final gets no recovered duplicate. 3/3, 0.9 s.
- `tsc --noEmit` 2.3 s; Biome check + format exit 0.
- Full suite under `lockf -k /private/tmp/shepy-full-suite.lock`, one worker: **1192/1193, 67 s** — the single failure is `run-tests.test.ts > the entry is the locked vitest package inside this repository`, an artifact of my symlinked `node_modules` (realpath outside this worktree), not a candidate defect; consistent with the builder's clean 1193. The builder-flagged pruning flake did not appear in three runs.
- Cost: `findPendingSettlement` on 60,001 events — 0.014 ms hit, 1.27 ms absent-agent full scan; runs at most once per agent per process (`#settlementsRestored`), and zero queries once the row is settled. Confirms the builder's magnitude; not a steady-state cost.

## Assessment

Journal-before-yield is the minimal durable design: no schema change, no polling, no extra steady-state rows (the journal row replaces the flush-time `agent.status.changed`). Crash paths keep the journal recoverable (operation-error cleanup re-arms restore). Tests: 6 cases in 3 declarations plus one strengthened existing assertion — producer-shaped (real Pi JSONL, migrated SQLite, public events, inbox readback), no implementation pinning. README's two changed paragraphs match traced behavior.

## Limitations and next owner

Not verified: live daemon behavior, multi-workspace concurrency, the pruning flake's root cause. Next owner: seat for landing and live acceptance (driffs inbox examples glm-rev-store14, luna-handoff).

**Noticed beyond my task**: builder's report already flags `scripts/run-tests.mjs`'s socket-suffix budget (my full-suite run needed a shortened TMPDIR to stay under macOS's 103-byte limit) and the `agent-lifecycle.test.ts:502-532` clock-margin flake — both confirmed plausible, unowned. Owner: seat/test-runner maintainer.

## Artifacts

Land-review JSONs for the two source commits (R13): `/Users/ray/.factory/land/review-15.444-b69e200b9.json` (fix) and `/Users/ray/.factory/land/review-15.444-07eb46691.json` (report commit).

VERDICT: ACCEPT
Disposition: ACCEPT
Candidate: 07eb466912ffe15f403ea1dd017652b29fffad0e
