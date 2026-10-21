# SHEPYCI report: Shepy CI green again

Branch `fix/shepyci`, fix commit `48439c3`, this report committed after it. Not pushed. Report location: `evidence/report-shepyci.md` (the repo's tracked `evidence/` folder, not `docs/`).

## Answer
CI failed because of one test, not the workflow. `test/integration/claude-hook.test.ts`, "the owner file is replaced by rename, never truncated in place", asserted that the owner file's inode number changes after a hook run. On Linux (CI) a rewrite can land back on the freed old inode number, so a correct writer failed the check. On macOS (APFS) inode numbers are not reused, which is why it always passed locally.

## Evidence
- Failing runs: `39469067925` (commit 07635e5) and `39461566197` (commit f3e0635), repo rayBlock/shepy (use `gh run view -R rayBlock/shepy`; plain `gh` in this tree resolves to the upstream ryonakae/shepherd). Failing step: `pnpm check`, the vitest part. Error: `AssertionError: expected 4721738 not to be 4721738` at `claude-hook.test.ts:3336`. 1 failed, 1112 passed. Install, rebuild, lint and typechecks were not the failing part. Last green run: 2026-08-30 (`33325343632`).
- Cause: `writeOwnerRecordAtomic` in `src/cli/owner-file.ts` is correct (new temp file, fsync, rename). One hook run rewrites the record more than once, so the second temp file can reuse the first old inode once it is freed.
- Reproduced on Linux before the fix: node:24.18.0 Docker container, same test, same assertion failure (`expected 464124 not to be 464124`). Passes on macOS Node 24.19.0 (1113/1113).

## Fix (test only, no source change)
- The test now hard-links the old owner file before the second hook run. The link keeps the old inode alive, so it cannot be reused. The test still asserts the inode changed, and now also asserts the old inode kept its exact old bytes (stronger than before: an in-place truncate would change the pinned content).
- `test/integration/claude-profile-demand-validation.test.ts` pins a SHA-256 of `claude-hook.test.ts`; I updated that pin to the new hash, as earlier fix commits (e229eeb, f3e0635) did when they changed pinned files.
- No timeouts raised, nothing skipped, lint unchanged.

## Verified
| Check | Result |
|---|---|
| Linux, before fix, the one test | fails with the CI error |
| Linux, after fix, the one test, 5 runs | 5 of 5 pass |
| Linux, after fix, `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm rebuild`, `pnpm check`, `pnpm build` (non-root, Node 24.18.0, git clone) | all exit 0, 73 files, 1113 tests |
| macOS Node 24.19.0, `pnpm check` and `pnpm build` | exit 0, 1113 tests |

Not verified: a real GitHub runner run (nothing pushed). One earlier Linux run (Docker on a Mac, loaded) failed a different test, "canonical live milliseconds %i publish, bind, lease…" in `claude-profile-demand-validation.test.ts`, a timing-sensitive test; it passed on the next full run. Watch it if CI turns red again.

## pnpm audit (nothing in these was touched, so not updated)
40 advisories: 3 low, 17 moderate, 20 high. By package: brace-expansion (5, high/moderate, fixed in 5.0.12), fast-uri (8), undici (15, via `@earendil-works/pi-coding-agent`, fixed in 8.10.2), vite (3, 8.1.5 or older), vitest and @vitest/mocker (fixed in 4.1.11), postcss (2), nanoid (2), esbuild, braces, source-map-js. Updating them is a separate change.
