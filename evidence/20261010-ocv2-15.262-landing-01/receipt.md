# ROW 15.262 OpenCode V2 history landing receipt

Recorded UTC: 2026-10-10T00:24:09Z

## Pins, rebase, approval
- Target: `/Users/ray/dev/shepy`, branch `shepy`; authorized push pair `shepy origin/shepy`.
- Pre-merge target and live `origin/shepy`: `beb71fdd435e5b4b81f50075e5e20f2118db79b9`.
- Frozen rebased candidate: `471516dbbc9a896e0659cc79f98a91088a306642`, branch `spawn/opencode-v2`, worktree `/Users/ray/dev/shepy-wt/opencode-v2`.
- Original candidate remains preserved as tag `ocv2-original` -> `b63d40f4d5fda2a67bbd9d1858728f5679a4ede1`.
- Hostile verdict: SURVIVES on the identical candidate patch, `/private/tmp/ocv2/out/hostile-1.md` (copy retained here). Rebase/range-diff and stable patch-ID proof is in `rebase-proof.txt`; the direct diff on destination is 8 files, +266/-32.
- Dependency incident and repair: engine disclosed that its first `CI=1 pnpm install --frozen-lockfile` followed a worktree symlink and partially purged canonical node_modules; the canonical tree was then repaired with pinned pnpm 11.9.0 and frozen lockfile. Engine reports isolation proof `shepy-shared-dependency-incident-and-root-restoration.json` and raw install EXIT=0 without lockfile/config edits. Copied repair log/before-state are `canonical-repair-full.log` and `canonical-repair-before.txt`; candidate `node_modules` was independently observed as a real directory, not a symlink. No further install was run by this seat. The earlier no-CI bootstrap refusal and first hook failure are preserved in `prior-pnpm-bootstrap-stop.log` and `prior-hook-failure.log`.

## Fresh gates on exact 471516d
Node v26.5.0; pnpm 11.9.0. All seat-run commands below were invoked directly, unpiped, with raw EXIT appended; hashes are listed in `sha256.txt`.
- Candidate worktree: direct `./node_modules/.bin/tsc --noEmit -p tsconfig.json` EXIT=0 (`tsc.log`); five related Vitest files / 47 tests EXIT=0 under the repo's Vitest runner (`paired-vitest.log`); full extension file EXIT=0, 71/71 with profile unset and 71/71 with synthetic ambient `SHEPY_PROFILE=__root_synthetic_profile_fixture__` (`extension-unset.log`, `extension-ambient.log`).
- Owner's separately supplied raw gates are preserved distinctly: TSC raw result EXIT=0 (`owner-tsc.log`); Vitest result is exactly 2 files / 18 tests, EXIT=0 (`owner-two-suite-vitest.log`), not three files.

## Destination-pinned gates after merge
Ran directly in `/Users/ray/dev/shepy` at merged HEAD `8850339da79da2b6a01f091d23dfb7667868842d`, after canonical restoration and without any install: direct tsc EXIT=0 (`destination-tsc.log`); five related Vitest files / 47 tests EXIT=0 (`destination-paired-vitest.log`); full extension file 71/71 EXIT=0 with `SHEPY_PROFILE` unset and 71/71 EXIT=0 with synthetic ambient value (`destination-extension-unset.log`, `destination-extension-ambient.log`). All had fresh TMPDIR/HOME/SHEPY_HOME.

## Real hook recheck
The first evidence commit attempt before canonical repair failed because `lint-staged` was missing; raw failure is preserved above. Canonical repair restored `.modules.yaml` and `.bin/lint-staged`; a second real hook run is being attempted now, with no `--no-verify`.

## Local merge
- Method: `git merge --no-ff --no-edit 471516dbbc9a896e0659cc79f98a91088a306642` on clean non-bare `shepy@beb71fd`; no `--no-verify`.
- Merge HEAD: `8850339da79da2b6a01f091d23dfb7667868842d`, parents `beb71fdd435e5b4b81f50075e5e20f2118db79b9` and `471516dbbc9a896e0659cc79f98a91088a306642`.
- Candidate ancestry verified; exact proof in `merge-proof.txt`.
- This is source-only history resolution; no live DB migration, daemon activation, or profile activation.
- Evidence receipt and logs are being committed before the 15.262 queue CAS. Queue completion will reference the merge SHA; push only to the packet-authorized `shepy origin/shepy` pair.
