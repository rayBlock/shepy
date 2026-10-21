# S4 handover, correction 1
Identity: s4; branch `night/s4`; original base `07d5735`; correction base `6ce5bf0`; review `126a4d4` on `night/rev-s4`.
**PARTIAL.** The review's ownership and settings findings are corrected in code and fixtures. The whole hook file still has five-second test timeouts. Candidate is the commit containing this report. Next owner: factory seat for independent recheck, batch validation and live acceptance.

## Original acceptance block (recorded before coding)
```json
{"kind":"build","real_use":"A owns P with two pending notices; A releases; B in another pane with SHEPY_PROFILE=P claims at its next prompt and gets both once; after B's terminal closes C claims immediately.","unhappy_paths":["non-owner release refused","live owner claim refused","Herdr unreachable or timeout fails closed","two racing claimants yield one owner","SHEPY_PROFILE unset retains explicit flag behavior"],"attack_tests":["non-owner release leaves owner and notices unchanged; owner succeeds","live lease refuses rival; release admits rival immediately","Herdr failure or timeout refuses; confirmed absent terminal admits","race after release yields one winner and no notice loss or duplicate","null terminal or different Herdr session refuses takeover","foreign SessionEnd cannot release; owning SessionEnd releases","old token after release is only a normal claimant"],"running_cost":{"time":"claim and prompt latency including Herdr timeout","cpu":"hook runtime","memory":"none expected","disk":"owner and notice rows","tokens":null},"ray_check":"Hand the seat to another Claude session without settings edits or lease waits."}
```
Independent amendments: `/Users/ray/dev/agent-factory/evidence/night/acceptance-check.md`, S4. Original delivery and retained failures: `6ce5bf0:evidence/night/report-s4.md`. This correction follows the seat's 22:30 deadline and review `126a4d4`.

## Correction and acceptance proof
- F1 (live-owner takeover): a recorded `terminalId === paneId` never permits early takeover, even when that pane is absent. Missing pane identity also fails closed. This shared daemon guard covers both Claude and Pi fallback rows without changing their claim format.
- For other rows, the live Herdr list must exclude BOTH the recorded terminal and pane. Every list entry must supply both identities. A live pane with an inconsistent recorded terminal cannot be declared gone. The existing owner-generation comparison still fences delayed lookups and competing claims.
- Before the fix, the new regression selection failed four cases: missing owner in Shepy's index, ambiguous owner pane in two Herdr sessions, legacy pane already gone, and live pane with mismatched terminal. The confirmed-terminal control passed. After the fix, all five pass: refused claims leave the owner token and pending notice unchanged; the confirmed terminal permits takeover only after both identities disappear.
- A holder prompt repairs a fallback row once its own pane is indexed; the same token re-claims normally and receives its pending notice. **No migration or live-store edit is needed.** Until resolution, the holder can release, or another claimant must wait for normal lease expiry. Existing legacy owners remain protected rather than being evicted for cleanup.
- F2 (start-script and hook examples): the report now gives the exact command-scoped `factory-seat()` function, not an export. The README's SessionEnd entry and the factory hook object below explicitly carry `timeout: 15`.
- Existing release, SessionEnd, environment selection, two-notice handover and race probes remain in the selected proof. All use real SQLite and JSON Lines boundaries with producer-shaped Herdr fixtures, not live Claude panes.

## Correction checks and retained failures
Every check used `env -i`, fresh private HOME and short TMPDIR. `CLAUDECODE`, `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` were absent. Versions: Node 24.18.0, TypeScript 6.0.3, Vitest 4.1.9, Biome 2.5.1, pnpm 11.9.0; existing linked dependencies, no installs.
- PASS: final `bunx --no-install tsc --noEmit`, exit 0, 7.67 s; 27 selected hook handover tests, exit 0, 20.80 s; four related files, 183 tests, exit 0, 8.21 s.
- PASS: build and root package check, exit 0, 8.67 s; root Biome, exit 0, 0.26 s, with the same unrelated unused-import warning; factory function literal and both SessionEnd JSON timeouts, exit 0, 0.48 s. No assertions or test timeouts were relaxed.
- RED retained: complete `claude-hook.test.ts`, exit 1, 132.99 s: 172 passed and five five-second timeouts. Four affected unchanged socket/delivery/demand tests; one affected the existing S4 source-CLI owner-release scenario. All new correction cases passed in that run. The selected green run does not erase the broad red. Prior unchanged-base controls and the independent review also recorded variable timeout sets under load; no clean whole-file result is claimed.
- An initial root lint run failed because my archived baseline under `.scratch` introduced a nested Biome config. I moved only that private archive outside the worktree, retained its location, and reran root lint successfully. No shipped configuration changed.
- Full-suite and `pnpm check` acceptance remain open from the original delivery; this correction ran the requested targeted checks, not another batch suite. Build gates used existing pnpm with `pnpm_config_verify_deps_before_run=false` to prevent implicit installs.
Private commands and logs remain in `.scratch/s4/`; the moved baseline location is recorded there. Final selected proof: `correction1-probes-final.w2DWat/output.log`, SHA-256 `d103135442ec1587d02c9d97b379f35d714615752d47196aa4bbf7fdaf0df938`.

## Cost and limits
Fixture measurements: confirmed gone claim including persistence 257.19 ms; live-owner refusal 2.31 ms; live-pane mismatch refusal 1.72 ms; silent Herdr 1001.65 ms. Uncontended prompt 230.78 ms under load. Legacy fallback refusal makes no additional Herdr request. The bound remains one lookup with a one-second deadline for eligible rival claims.
`process.cpuUsage` covers hook, daemon and fake Herdr together: gone claim 4.54 ms user plus 3.37 ms system; timeout 1.56 plus 0.24 ms. Selected-test peak RSS was 213.34 MB, not production memory. Production memory and physical disk growth are null, not measured. No schema, owner-resolution flag or retained-history rows were added; denied claims preserve the owner and notice rows. Input, cache-write, cache-read, output and summary tokens are null because the harness ledger is unavailable; no model call is added.
Live handover and actual Claude SessionEnd timing remain unverified. No real daemon restart, user settings change, live owner-row edit, push or agent message occurred. Scratch, generated outputs and the dependency symlink remain uncommitted. Git hook configuration is unchanged; generated `.husky/_` is absent.

## Exact factory follow-up (not applied)
Replace the existing function with this command-scoped form; do not export these variables into the interactive shell:
```sh
factory-seat() { _ccf_wet; cd "$HOME/dev/agent-factory" && FACTORY_SEAT=engine-coordinator SHEPY_PROFILE=engine-coordinator FACTORY_INSTANCE="$HOME/dev/agent-factory" wet claude "$@"; }
```
Install the corrected Shepy build and arrange its daemon upgrade BEFORE changing settings; the old CLI rejects the environment-only command. For both existing Shepy commands (settings lines 21 and 36), use the command in this new SessionEnd hook object, and add the complete object under SessionEnd:
```json
{"type":"command","command":"if [ \"${FACTORY_SEAT:-}\" = \"engine-coordinator\" ] && [ \"${SHEPY_PROFILE:-}\" = \"engine-coordinator\" ]; then /Users/ray/.npm-global/bin/shepy claude-hook --profile-demand; fi","timeout":15}
```
All FIVE existing guarded entries need updating: SessionEnd wake bridge (10), Stop Shepy (21), Stop wake bridge (25), UserPromptSubmit Shepy (36), UserPromptSubmit wake bridge (40). For the three wake-bridge entries, use:
```sh
if [ "${FACTORY_SEAT:-}" = "engine-coordinator" ] && [ "${SHEPY_PROFILE:-}" = "engine-coordinator" ]; then WAKEBRIDGE_AGENT_NAME=engine-coordinator /Users/ray/dev/agent-factory/tools/wakebridge/adapters/claude/claude-ending-hook.sh; fi
```
These remove fixed workspace and pane guards; changing only the two Shepy entries leaves the new seat deaf to the wake bridge. The factory seat owns applying and verifying this configuration.

## Noticed beyond my task
No new adjacent issue was changed. The original report's `scripts/check-root-package.mjs` warning-banner parsing observation remains for the packaging maintainer.
