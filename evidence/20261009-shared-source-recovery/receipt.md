# Shared-source recovery landing — local-only receipt

Recorded UTC: 2026-10-09T21:40:59Z

## Scope and authority
- Engine-directed local recovery landing for the shared-source reconciliation. Do not conflate this with the FD seat's 1.299 closure.
- Push was not authorized and was not attempted. The remote remains on its parent line.
- Frozen candidate: `047339ff4caad30f8e87a70182195ff2a1adff9a`, branch `seat/recovery`, source worktree `/Users/ray/dev/shepy-wt/recovery`; candidate tree `4f8aaa94a0af051a240305f5cbc6c070d92f8463`.
- Approval as stated in the engine packet: root exact-source ACCEPT stamped `2026-10-09T21:25:00.88Z`; independent sidekick-r SURVIVES at `2026-10-09T21:22:57Z` (native `64d63170`) covering the exact diff. The packet names `evidence/20261009-shared-source-recovery/root-exact-source-approval.json`; that file was not present in the visible checkout when inspected, so it is referenced as packet-supplied approval and is not reconstructed here.
- Base-to-candidate diff from remote parent `094dda869c2badf5a2aa8b886cd2e494d49eeb4d` is exactly eight paths; binary diff SHA-256 `43ff154f44a15c90dcb2b784c6bc577b790ecee36cf70f39ca3567acf969cf96`.

## Restoration and preflight
- Engine restoration direction referenced `evidence/20261009-core-bare-recurrence/engine-restoration-receipt.md`; that path was not present in the visible checkout when inspected. Independently observed immediately before merge: `/Users/ray/dev/shepy` resolved as the non-bare top-level worktree, `HEAD=bfdc88d5ee276f524923f5b146b88ceac54aacc2`, clean index/worktree; no foreign staged/tracked changes.
- Recovery source worktree was clean at frozen candidate `047339f...` with a clean index.
- `origin/shepy` local tracking and live remote both equaled `094dda869c2badf5a2aa8b886cd2e494d49eeb4d`.
- Candidate is a descendant of both the local sibling `bfdc88d...` and remote parent `094dda8...`; its parent `1afd0bf` is the merge of those sibling lines. `merge-tree --write-tree bfdc88d... 047339f...` returned `4f8aaa94a0af051a240305f5cbc6c070d92f8463` without conflict.

## Fresh gates
All ran in `/Users/ray/dev/shepy-wt/recovery` with `SHEPY_PROFILE` unset. Node/pnpm versions and raw command output plus EXIT receipts are preserved in adjacent files; SHA-256 manifest: `gate-log-sha256.txt`.
- Node `v26.5.0`, command EXIT=0; pnpm `11.9.0`, command EXIT=0 (`versions.log`).
- `pnpm check`: EXIT=0; 65 files / 737 tests passed. One retained Biome unused-import warning in `src/observability/profile-selector-scope.ts` (`SelectableAgent`); other tool output is in `pnpm-check.log`.
- `pnpm build`: EXIT=0; build stamped exact candidate SHA `047339ff4caad30f8e87a70182195ff2a1adff9a` (`pnpm-build.log`).
- `pnpm package:check`: EXIT=0 (`pnpm-package-check.log`).
No gate failure or waiver/filter/retry. The build/test commands did not run a live migration, daemon, profile claim, hook activation, or product activation.

## Local merge and lineage
- Method: from the restored, clean main checkout, `env -u SHEPY_PROFILE git -C /Users/ray/dev/shepy merge --no-ff --no-edit 047339ff4caad30f8e87a70182195ff2a1adff9a`; no `--no-verify` was used.
- Merged HEAD: `8962140d77dd920b888f84e0f7f364fe17bad706`, parents `bfdc88d5ee276f524923f5b146b88ceac54aacc2` and `047339ff4caad30f8e87a70182195ff2a1adff9a`.
- Candidate ancestry verified (`git merge-base --is-ancestor 047339f... HEAD`, EXIT=0); remote parent ancestry also verified. The merge preserves the `094dda8` attribution lineage, `bfdc88d` backstop lineage, and `047339f` recovery lineage. `docs/plans/ATTRIBUTION-65638c3.md` remains in the merged tree.
- Shepy migration journal: 12 entries total, idx 0–11; idx 11 is `0011_real_lenny_balinger`.
- Remote push: none. `origin/shepy` remains `094dda869c2badf5a2aa8b886cd2e494d49eeb4d`.
- Engine queue row 15.207 remains open/running pending native session proof; no queue-row mutation preceded this receipt.
