# HOSTILE review — row 15.261 profile component, candidate 414f8a7c

- Hostile: flash-lens 0eecaae92db52f04 (qwen-cloud/deepseek-v4-flash-0731, thinking high) — pane w3J:pSG
- Candidate: 414f8a7cc16b52e2730c26eaa6dbca52bb40312a on spawn/profilefix
- Base (frozen): ac9526025a156b17e5b8bc846571ef4550867ce9 — ancestor of candidate, verified via `git merge-base --is-ancestor`
- Worktree /Users/ray/dev/shepy-wt/profilefix: HEAD == 414f8a7c, working tree clean (only untracked node_modules symlink). READ-ONLY held; all candidate runs were executed from private scratch trees under /private/tmp/profilefix/htmp/{base,head} via `git archive`, not from the worktree.

## Fail-first matrix (BY NUMBER) — reproduced fresh, both env states, serialized, raw exits

Runner: `/opt/homebrew/bin/node node_modules/vitest/vitest.mjs run --no-cache test/unit/shepy-pi-extension.test.ts` under `env -i` with fresh private HOME/SHEPY_HOME/TMPDIR=/private/tmp/profilefix/htmp. Ambient state via `SHEPY_PROFILE=__root_synthetic_profile_fixture__`.

| run | tree | env state | result | matches evidence |
|---|---|---|---|---|
| my-base-unset | ac95260 | unset | 69/69, exit 0 | attempt-1/run-a (69/69, exit 0) ✓ |
| my-base-ambient | ac95260 | ambient | 69 tests, 5 failed, exit 1 | attempt-1/run-b (5 failed, exit 1) ✓ |
| my-head-unset | 414f8a7c | unset | 71/71, exit 0 | attempt-2/run-c (71/71, exit 0) ✓ |
| my-head-ambient | 414f8a7c | ambient | 71/71, exit 0 | attempt-2/run-d (71/71, exit 0) ✓ |

- The 5 failed tests in the base-ambient replicate are byte-identical to the frozen evidence run-b set (diff of the FAIL lines is empty): *shows reconnecting only for a previous owner…*, *keeps a previous owner reconnecting…*, *reports ownership loss discovered on reconnect to term_other*, *reports ownership loss discovered on reconnect to null*, *clears reconnecting UI on shutdown*.
- 69 originals + 2 new controls = 71 on the candidate; `test(` count 59 → 61 between base and head matches the +2 controls.

1. **Fail-first matrix**: CONFIRMED. ac95260 red (5 fails) under ambient SHEPY_PROFILE, green (69/69) unset; 414f8a7c green (71/71) under both states, same full assertion set.
2. **Fix is test-environment layer ONLY**: CONFIRMED. `git diff ac95260 414f8a7c --name-only` = 18 evidence files + `test/unit/helpers/profile-sandbox.ts` (new) + `test/unit/shepy-pi-extension.test.ts`. Zero changes under `src/` or `packages/`. Production profile handling (`packages/shepy-pi/src/index.ts:1250` reads `process.env.SHEPY_PROFILE`, claim at 1279) untouched.
3. **Deliberate-injection controls retained**: CONFIRMED. Deliberate-profile suites still TESTED (my fresh runs, both env states): env-claim 3/3 exit 0, pi-profile-tool 14/14 exit 0, profile-renew 12/12 exit 0. In-file: negative control (sandbox-holds, asserts NO profile.claim) + positive control (asserts exactly ONE profile.claim carrying injected id `env-claim-control`, lease token asserted). Profile-aware paths are exercised, not hidden.
4. **Stamp controls still green**: CONFIRMED. stamp-pi-build suite 1/1 exit 0 both states; the 3 stamp controls (unstamped/stamped-isolated/mutation-corrupt) inside the extension suite pass within the 71/71. The ac95260 build-info sandbox file is unchanged (not in the diff).
5. **Fresh paired run**: DONE (table above), satisfying TMPDIR=/private/tmp/profilefix/htmp, mkdir -p, both env states, serialized, raw exits.

## Hostile mutation probes (each control independently fails when its mechanism is removed — teeth, not decoration)

- **Sandbox removal**: comment out `installAmbientProfileSandbox()` in a scratch copy, run with ambient SHEPY_PROFILE → exit 1, 6 failed: the original 5 leak-failures return AND the new negative control fails. The control detects the exact leak class the fix claims to fix.
- **Injection removal**: comment out `injectProfileForControl("env-claim-control")`, run with ambient → exit 1, exactly 1 failed: the positive control. Proves the claim path is genuinely asserted (exactly one claim with the injected id), not vacuous.

## Evidence integrity

- All 17 files in evidence/20261010-profilefix-15.261 have sha256 matching unpublished.json (receipt.md 5f64fa37… confirmed; per-file loop all OK).
- Queue pointer sha256 c07e61c3… matches /Users/ray/dev/agent-factory/queue.json. Queue row 15.261 = TEST-ENV-SANDBOXING, spec says FIX is "the suite sandboxes its env-sensitive tests (…explicit unset in test setup)"; bounded test-setup layer only. The candidate implements exactly that.

## Hygiene gates

- `tsc --noEmit -p tsconfig.json` on candidate: exit 0.
- `biome check` on the two changed files: exit 0 (2 files, no fixes).

## Limitations

- Hostile reviewed the frozen tree only; the branch is unpushed and shared main untouched (per receipt). No review of other queue rows.

## VERDICT

- Candidate: 414f8a7cc16b52e2730c26eaa6dbca52bb40312a (row 15.261 profile component, spawn/profilefix)
- Scope: 15.261 TEST-ENV-SANDBOXING — ambient SHEPY_PROFILE sandbox for the extension suite
- Evidence: fresh paired matrix (4 runs + 8 gate runs + 2 mutation probes, raw exits, logs my-*.log in this dir), diff audit, evidence-hash audit, queue-row cross-check, tsc + biome
- Disposition: **SURVIVES**
- Limitations: review of frozen candidate only; no push; shared main untouched; stamp controls verified green both states; no defects found
- Unresolved owners: none; next consumer = BAILIFF packet (candidate frozen for landing review)