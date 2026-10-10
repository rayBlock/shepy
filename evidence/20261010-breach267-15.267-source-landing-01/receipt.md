# ROW 15.267 — isolated source landing receipt

**Disposition:** `SOURCE LANDED` only. Operational adoption remains held.

## Pins and destination

- Accepted candidate: `9bfad159cd2c33ad5a46e745ea29ee28745b0760` (`spawn/breach-adapter`), exact root `ACCEPT-SOURCE` disposition.
- Local destination before merge: `shepy` at `d602a030ea7540668d9c61edb391db107e834b3a`.
- Remote `origin/shepy` before landing: `22594646ca33f805e091128674602373d8bb5361`.
- Landing worktree: `/Users/ray/dev/shepy-wt/breach-adapter`, branch `shepy`.
- No `origin/main` or upstream push is authorized. The only authorized push is `shepy -> origin/shepy`. The first push of evidence tip `b2ff7a9b5d60da8b9a76e09af34876f3ea82b7cb` succeeded (exit 0); live and tracking `origin/shepy` both verified at that SHA. The supplemental push-result evidence commit will go only to the same ref; final live tip is to be verified before the engine row close.

## Merge and identity proof

- Merge commit: `dcdccfaa8a543344d228b5b0110babac22d79440` (`--no-ff`).
- Exact parents, in order: local closeout `d602a030ea7540668d9c61edb391db107e834b3a`, accepted candidate `9bfad159cd2c33ad5a46e745ea29ee28745b0760`.
- Candidate delta: eight approved source/test paths, exact to the root disposition. The six local 15.262 closeout evidence paths were disjoint and remain byte-identical. `merge-content-proof.txt`, `source-pins.sha256`, `destination-closeout-pins.sha256`, and `path-intersection.txt` carry the hash proof.

## Fresh gates and exits

All required gates were run against the frozen candidate before merge. The normal Git pre-commit hook ran on the first evidence commit in the merged landing worktree and exited 0; it ran under mise Node 24.18.0 / pnpm 11.9.0 and reported 783/783 full-suite tests. Raw outputs and exit files are preserved here.

- Exact root-reviewed source family: `test/unit/demand-eligibility-promise-breach.test.ts` + `test/integration/profile-demand.test.ts` — **34/34 passed**, exit 0 (`--no-cache`).
- Supplemental ingress/wake family — **31 passed**, exit 0.
- Promise-breach unit — **26 passed**, exit 0.
- Demand integration plus ingress — **21 passed**, exit 0.
- Full suite: first attempt exited 1 because the deliberately long scratch `TMPDIR` made Unix socket paths invalid (`listen EINVAL`) and one socket test timed out. The unmodified candidate was rerun with short physical `TMPDIR=/private/tmp/b267-59`: **783/783 passed**, exit 0. Both raw runs are retained; no test or source was changed to obtain the green result.
- Root typecheck, `packages/shepy-pi` typecheck, lint, format check, and DB check each exited 0. Lint reported one warning; no fixes were applied.

The separate new-worktree hook-setup attempt is also retained: `pnpm run pnpm:devPreinstall` tried to invoke an install and aborted with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` before removal. No install completed. The original candidate worktree's physical dependencies and generated hooks were verified intact; the landing reused that same worktree path and normal hook configuration. No install was retried.

## Explicit operational limit

This source landing does **not** establish live promise-breach behavior, public API/schema adoption, demand/daemon/profile activation, DB migration or live DB access, upstream receipt-producer qualification, or native/private execution. The upstream receipt writer remains a runtime prerequisite. Do not describe the complete feature as live or finished.

## Evidence status

This receipt records the local source merge and pre-push checks. Push verification and the final `origin/shepy` tip will be recorded before the engine queue row is closed.
