# 15.261 profile component — BUILD receipt (flash, bounded)

- Row: 15.261 · dispatch 91268506817a1ba7 · worker flash-build-20261009-223411 (pane w3J:pSE)
- Identity: provider=zai model=glm-5.3-flash thinking=high (echoed from spawn receipt)
- Base (frozen): ac9526025a156b17e5b8bc846571ef4550867ce9 — the stamp fix, RETAINED untouched
- Worktree: /Users/ray/dev/shepy-wt/profilefix (branch spawn/profilefix)
- Scope of change: test-environment layer only — `test/unit/helpers/profile-sandbox.ts` (new, the stamp sandbox's family) + `test/unit/shepy-pi-extension.test.ts` setup/controls. Production code untouched; every existing assertion preserved (69 originals + 2 new controls).

## Failure mechanism

`session_start` → `registerPresence().then(claimFromEnvironment)` reads `process.env.SHEPY_PROFILE`
at fire time (packages/shepy-pi/src/index.ts:1250) and claims that profile. A dispatched pane's
ambient SHEPY_PROFILE therefore hijacked bridge tests: five reconnect/ownership-loss/shutdown
assertions saw an environment claim they never staged.

## Fix

The extension suite's setup now ALSO sandboxes SHEPY_PROFILE
(`installAmbientProfileSandbox()` at import, paired `afterAll(uninstallAmbientProfileSandbox)`):
ambient value saved + unset for the file's tests. Profile-aware paths stay covered by deliberate
injection only: two new in-file controls (sandbox-holds negative; deliberate-injection positive
asserting exactly one `profile.claim` carrying the injected id) plus the retained deliberate
suites (env-claim, pi-profile-tool, profile-renew).

## Gates (fresh, serialized, private HOME/SHEPY_HOME/TMPDIR per run)

| gate | run | state | result |
|---|---|---|---|
| paired fixture, unset | attempt-1/run-a | base ac95260 | 69/69, exit 0 |
| paired fixture, ambient | attempt-1/run-b | base ac95260 | 5 failed (reconnect/ownership/shutdown), exit 1 — matches root's paired evidence |
| paired fixture, unset | attempt-2/run-c | fix | 71/71, exit 0 |
| paired fixture, ambient | attempt-2/run-d | fix | 71/71, exit 0 (was 5 failed) |
| deliberate-profile suites ×2 env states | attempt-2/gate-* | fix | env-claim 3/3, pi-profile-tool 14/14, profile-renew 12/12 — all exit 0 both states |
| stamp controls (stamped/unstamped/corrupted) | attempt-2/run-c, run-d | fix | green (inside the 71) |
| stamp-pi-build ×2 env states | attempt-2/gate-* | fix | 1/1 exit 0 both states |

Command (both states): `/opt/homebrew/bin/node node_modules/vitest/vitest.mjs run test/unit/shepy-pi-extension.test.ts`
under `env -i` with fresh private HOME/SHEPY_HOME/TMPDIR; ambient state via
`SHEPY_PROFILE=__root_synthetic_profile_fixture__` (exact root fixture).

Also clean: `biome check` (2 files), `tsc --noEmit -p tsconfig.json`.

## Disposition

Candidate frozen on spawn/profilefix for the BAILIFF packet; not pushed; shared main untouched.
