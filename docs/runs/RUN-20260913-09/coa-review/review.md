# COA independent recheck — RUN09 candidate 2

Candidate: `37c9b0ba54d30295ad5479bf6e4041be51bc6726`, `/Users/ray/dev/shepy-wt/waitfix`, inspected clean at review start. No live daemon/operation/schema mutation, builds, installs requested, focus manipulation or new workers.

## Disposition

**PARTIAL: the enumerated corrections are independently verified; operation correlation/rollout is NOT qualified. Hold candidate branch; no integration/live build/restart authorization from this review.**

- Replayed six affected suites: **54/54 passed** (not a replay of the author's entire 694-test gate).
- Independently exercised the real SQLite stores/wait service against synthetic in-memory rows: **9/9 correction regression checks passed**. These cover P-A/P-B, pre-creation 1ms, valid post-creation epoch, malformed start and settle JSON, foreign terminal, foreign Herdr session, and earliest-epoch preservation.
- Three further safety probes fail; preserve them, rather than turning them into expected-success safety tests:
  1. **Same-millisecond, already indexed old epoch:** both working and idle rows are inserted BEFORE operation creation, with the same millisecond timestamp. Operation falsely settles. This does not require index lag. `created_at >= createdAt` cannot recover the lost ordering.
  2. **Replacement native session in the same terminal:** rows for another native session settle the original operation. The adapter also accepts a stubbed Herdr response explicitly naming the replacement, returns `settled`, and echoes the requested original identity. This adapter behavior predates candidate 2; it is an uncovered existing boundary, not claimed a newly introduced regression. Terminal/Herdr-session isolation is not native-session identity validation.
  3. **Two operations created before one execution:** the same epoch qualifies both. This was already disclosed by the lead; independently reproduced here.

Full results: `results.json`; independent executable `probes.mts`; replay: `replay.log`. Fixtures are synthetic, not live timing/cancellation qualification. A first invocation of `probes.ts` failed before tests because /tmp was interpreted as CommonJS and disallowed top-level await. The identical source was preserved as `.mts`, then executed with the existing tsx CLI; this is a reviewer setup error, not a candidate failure. Node reported v24.19.0 (the requested PATH's24.18 path did not select that historical version). No dependencies were added; pnpm printed its existing up-to-date check.

## Claims and next boundary

- The idle/done filter defect is supported. Zero slack and malformed/scoping fixes improve the local implementation; they do not authenticate an operation's execution.
- Prompt-time sequence and durable submission metadata are candidate design ingredients, not proven necessary-and-sufficient correlation. Exact native identity, event ordering, overlapping/queued prompts and human intervention need explicit treatment. Do not silently authorize a schema change.
- Bare Herdr wait can be an observation/wake fallback, **not a safe per-operation settlement or task-acceptance oracle**.
- Reusing the same independent verifier within its existing allocation was not prohibited by the no-third-worker cap. The lead chose handback; this COA recheck supplies the independent correction review. Do not attribute the lack of a same-worker pass to a nonexistent prohibition.
- Preserve F1/F2/F3 and the original seven-of-ten mutation outcome. This recheck did not repeat the mutation campaign.
- If the installed CLI resolves to the main checkout's dist, a build there replaces live CLI code even without daemon restart. No main-checkout build/rollout is authorized here.

Close/reconcile this bounded run as partial after evidence custody and actual worker/operation receipts are recorded. Keep original sessions, candidate branch/worktree and accountable owner. A stronger correlation design needs a separately explicit envelope, not another unbounded patch round.
