# S4 handover
Identity: s4; branch `night/s4`; base `07d573552d51690b51750c94f8eaa8fe4be49598`.
**PARTIAL.** All four changes are built; full-suite acceptance remains blocked. Candidate is the commit containing this report. Next owner: factory seat for independent review, locked batch checks and live acceptance.

## Acceptance block (recorded before coding)
```json
{"kind":"build","real_use":"A owns P with two pending notices; A releases; B in another pane with SHEPY_PROFILE=P claims at its next prompt and gets both once; after B's terminal closes C claims immediately.","unhappy_paths":["non-owner release refused","live owner claim refused","Herdr unreachable or timeout fails closed","two racing claimants yield one owner","SHEPY_PROFILE unset retains explicit flag behavior"],"attack_tests":["non-owner release leaves owner and notices unchanged; owner succeeds","live lease refuses rival; release admits rival immediately","Herdr failure or timeout refuses; confirmed absent terminal admits","race after release yields one winner and no notice loss or duplicate","null terminal or different Herdr session refuses takeover","foreign SessionEnd cannot release; owning SessionEnd releases","old token after release is only a normal claimant"],"running_cost":{"time":"claim and prompt latency including Herdr timeout","cpu":"hook runtime","memory":"none expected","disk":"owner and notice rows","tokens":null},"ray_check":"Hand the seat to another Claude session without settings edits or lease waits."}
```
Independent amendments: `/Users/ray/dev/agent-factory/evidence/night/acceptance-check.md`, S4. Packet supplied no hash-pinned primer; read current factory PRIMER and role contract.

## Built and proved
- CLI release resolves the live caller through Herdr `agent.get`, reads only its native-session owner file, and presents its private token. No token argument or owner-file scanning. Foreign sessions, copied mismatched records and stale tokens cannot release the current owner.
- SessionEnd only releases; it never claims, leases or acknowledges unseen notices. Clear or resume can release; the next prompt claims normally. Pending notices remain; existing in-flight leases retain expiry and possible redelivery.
- `SHEPY_PROFILE` supplies the hook profile; explicit `--profile` wins. Herdr still supplies pane and workspace identity. Unset environment retains flag-required behavior.
- Rival claims query the recorded owner's own Herdr session once, with a 1-second deadline. Only a typed, complete pane list excluding its terminal permits takeover. Unknown identity, cross-session claims and failed lookups fail closed. The exact owner generation is compared again after the lookup, fencing races.
- Real SQLite, JSON Lines sockets and source CLI subprocesses prove two-notice handover, single delivery, live-owner refusal, release and gone-terminal races, stale delayed results, malformed replies and internal-proof rejection. Fixtures follow installed Herdr's API schema; these are not live Claude panes.

## Checks and retained failures
All checks used `env -i`, fresh private HOME and short TMPDIR; the three prohibited Claude variables were absent. Tools: Node 24.18.0, TypeScript 6.0.3, Vitest 4.1.9, Biome 2.5.1, pnpm 11.9.0; existing dependencies linked from `socket-test-flake-20261020`.
- PASS: final 22 handover tests, exit 0, 6.58 s; four related files, 183 tests, exit 0, 8.26 s.
- PASS: `bunx --no-install tsc --noEmit`, exit 0, 5.79 s; final build and root package check, exit 0, 8.64 s. Built CLI help resolved its imports.
- PASS: formatting, Drizzle check, Pi typecheck and package, Herdr plugin typecheck and package, exit 0, 5.27 s; root Biome exit 0, 0.32 s, one unrelated unused-import warning.
- RED retained: initial implementation probes failed as expected. Long TMPDIR caused 37 socket-related failures; shortening only TMPDIR removed those. Broad focused runs then had 1 and 2 five-second timeouts. Latest whole hook file: 169 passed, one timeout in the new timeout probe, 99.31 s; its measured claim itself returned in 1002 ms. Unchanged-base control also timed out twice, 148 passed, 74.49 s. No timeouts or assertions were relaxed; the later selected green run does not erase these reds.
- BLOCKED: own test entry rejects externally linked Vitest. Direct full-suite fallback waited 240 s for the shared lock before tool timeout; subsequent nonblocking full-suite and `pnpm check` attempts returned 75, lock busy. Neither full suite ran. No foreign process was stopped.
- Initial pnpm attempts tried implicit dependency repair and aborted. Subsequent build gates used existing pnpm 11.9.0 with `pnpm_config_verify_deps_before_run=false`, preventing installs. A warning-banner package parse failure was retained before that correction.
Private logs, commands and controls: `.scratch/s4/`. Final selected proof: `s4-final.MwsLhp/output.log`, SHA-256 `a314eb27b88f00d4a3101f572e367afa080cc3004cc3179877b75bd41c3b8d1b`.

## Cost and limitations
Fixture measurements, not live claims: base absent-terminal claim refused in 0.83 ms; candidate accepted in 175.19 ms, including delivery persistence. Uncontended prompt: 9.18 ms, no extra Herdr call; live-owner refusal: 2.34 ms; silent Herdr: 1002.70 ms. Extra lookup occurs only on same-session, live-lease rival claims, not normal holder prompts.
`process.cpuUsage` covers hook, daemon and fake Herdr in one process: gone claim 4.66 ms user plus 2.92 ms system; timeout 1.38 plus 0.27 ms. Test-process peak RSS was 237.85 MB; production memory is null, not measured. Release deletes one owner row, claim restores one; the two pending notice rows survive release, then acknowledge once. No migration or new retained-history rows. Physical disk growth and sidecars are null, not separately measured. Input, cache-write, cache-read, output and summary tokens are null: harness ledger unavailable; no new model call is added.
Live Claude handover, actual SessionEnd timing, a real idle wait and Ray verification remain open. No real daemon restart, settings edit, push or agent message occurred. Scratch, generated build output and the dependency symlink remain uncommitted. Configured Git hooks were not changed; generated `.husky/_` is absent in this worktree.

## Exact factory follow-up (not applied)
Start script, before launching Claude:
```sh
export FACTORY_SEAT=engine-coordinator SHEPY_PROFILE=engine-coordinator
```
Use this settings command for both existing Shepy entries (current lines 21 and 36), and add a third command hook under SessionEnd with `"type":"command"` and `"timeout":15`:
```sh
if [ "${FACTORY_SEAT:-}" = "engine-coordinator" ] && [ "${SHEPY_PROFILE:-}" = "engine-coordinator" ]; then /Users/ray/.npm-global/bin/shepy claude-hook --profile-demand; fi
```
All FIVE existing guarded entries need updating: SessionEnd wake bridge (10), Stop Shepy (21), Stop wake bridge (25), UserPromptSubmit Shepy (36), UserPromptSubmit wake bridge (40). For all three wake-bridge entries, replace their command with:
```sh
if [ "${FACTORY_SEAT:-}" = "engine-coordinator" ] && [ "${SHEPY_PROFILE:-}" = "engine-coordinator" ]; then WAKEBRIDGE_AGENT_NAME=engine-coordinator /Users/ray/dev/agent-factory/tools/wakebridge/adapters/claude/claude-ending-hook.sh; fi
```
These remove both fixed workspace and pane guards; changing only the two Shepy entries leaves the new seat deaf to the wake bridge. The factory seat must arrange installation and daemon upgrade separately before trying this configuration.

## Noticed beyond my task
`scripts/check-root-package.mjs` selects the first `[` as JSON; pnpm's `[WARN]` banner can break its package check before JSON parsing. Observed and retained above. Suggested owner: packaging maintainer. No adjacent code was changed.
