# ROW 15.261 profile-environment sandbox landing receipt

Recorded UTC: 2026-10-09T22:56:24Z

## Pins and approval
- Target: `/Users/ray/dev/shepy`, branch `shepy`; authorized push pair `shepy origin/shepy`.
- Pre-merge target and live remote `origin/shepy`: `ac9526025a156b17e5b8bc846571ef4550867ce9`.
- Frozen candidate: `414f8a7cc16b52e2730c26eaa6dbca52bb40312a`, branch `spawn/profilefix`, worktree `/Users/ray/dev/shepy-wt/profilefix`, parent `ac9526025a156b17e5b8bc846571ef4550867ce9`.
- Exact candidate hostile: **SURVIVES** on `414f8a7c`; `/private/tmp/profilefix/out/hostile-1.md` is copied here. Candidate's retained evidence, paired matrix, intentional-profile controls, stamp controls, and unpublished-manifest are under `evidence/20261010-profilefix-15.261/` in the merged tree.

## Fresh paired gate — full extension file
Both runs used the hostile's serialized direct runner, `node_modules/vitest/vitest.mjs run --no-cache test/unit/shepy-pi-extension.test.ts`, with independent fresh HOME/SHEPY_HOME/TMPDIR under `/private/tmp/profilefix-bailiff/` and `env -i`.
- Unset `SHEPY_PROFILE`: 1 file, 71/71 tests passed, EXIT=0 (`extension-profile-unset.log`).
- Ambient synthetic `SHEPY_PROFILE=__root_synthetic_profile_fixture__`: 1 file, 71/71 tests passed, EXIT=0 (`extension-profile-ambient.log`).
- Raw logs and hostile report hashes are in `sha256.txt`.

## Merge and completion
- Method: `git merge --no-ff --no-edit 414f8a7cc16b52e2730c26eaa6dbca52bb40312a` on the clean, non-bare local target `shepy@ac95260`; no `--no-verify` was used.
- Merge HEAD: `73e0e91015b90d5f7044620983c8e0d192a26007`, parents `ac9526025a156b17e5b8bc846571ef4550867ce9` and `414f8a7cc16b52e2730c26eaa6dbca52bb40312a`.
- Candidate ancestry verified. Scope is test-environment sandboxing; no production code changes.
- Row 15.261 evidence is written before its queue CAS. This source component completes the row; the CAS receipt is recorded separately.
- Push authorization: `shepy origin/shepy` only. No agent-factory push.
