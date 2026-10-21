# rev-s4: review of S4 handover without pane binding
Identity: rev-s4; branch `night/rev-s4`. Candidate: `night/s4` at `6ce5bf0`; base `07d5735`. Exported with `git archive` to private scratch; candidate source not modified.

**REVISE.** Release, SessionEnd, `SHEPY_PROFILE` and the race handling are correct. But the new early takeover lets a rival take a profile from a live owner whenever the owner's row records its pane id as its terminal id, and that row shape is common in production.

## Findings
**F1, high: a live owner is taken over at once (ownership stolen).**
- Code: `src/observability/profile-delivery-service.ts:338-354`, `src/daemon/observability-server.ts:593-601` and `src/herdr/owner-terminal.ts:31`.
- Why it happens: an owner counts as gone when `pane.list` lacks `owner.terminalId`. The owner supplies that value itself. When its Herdr lookup fails or is ambiguous, the Claude hook records `herdrSessionName:"default", terminalId:<paneId>` (`src/cli/claude-hook.ts:1127`). The Pi extension does the same (`packages/shepy-pi/src/index.ts:554,1084`).
- Real Herdr 0.9.3 on this machine: the session is named `default`, and terminal ids are `term_…`, never `w3J:p…`. So a pane-id terminal is never in the list, and every rival claim in the same session judges the owner gone.
- Live evidence, read-only: `~/.shepy/state.db` holds 9 owner rows with `terminal_id = pane_id` under `default`, for example `driffs|default|wP:p3|wP:p3` and `swt-lead|default|w3K:pYW|w3K:pYW`.
- Consequence: the change in the daemon covers every harness, so Pi leads are affected too. A second claimant takes the profile while the owner's pane is alive. The old token dies, and pending notices go to the rival.
- The suite already knows this row shape ("legacy pane-as-terminal identity", `test/integration/claude-hook.test.ts:293-298`), but no S4 test covers it.

Reproduction: scratch test, 3 cases, real hook, SQLite and JSON Lines daemon, fake Herdr returning a complete `pane_list` that contains both live panes:
- (a) Shepy's agent index lacks the owner's pane. The owner row becomes `default w1:p1`. Rival from `w1:p2`: lease token replaced. Base `07d5735` refuses.
- (b) Pane id `w1:p1` exists in two Herdr sessions (ambiguous lookup). Same takeover.
- (c) Control: the owner resolved normally (`term_owner`). Rival refused (pass), and the owner-gone control takes over (pass).

Suggested fix (builder's choice): allow early takeover only for a terminal id that Herdr confirmed at claim time. For example, store whether the location was resolved, or require that neither the owner's `terminal_id` nor its `pane_id` appears in the list. Add tests (a) and (b).

**F2, low, settings.** The start-script line is wrong in form. The seat starts through `factory-seat()` at `~/.zshrc:43`, which sets `FACTORY_SEAT` as a command prefix. The report's `export FACTORY_SEAT=… SHEPY_PROFILE=…` would leak both variables into the interactive shell, and every later `claude` started from that shell would be a seat claimant. Correct line:
`factory-seat() { _ccf_wet; cd "$HOME/dev/agent-factory" && FACTORY_SEAT=engine-coordinator SHEPY_PROFILE=engine-coordinator FACTORY_INSTANCE="$HOME/dev/agent-factory" wet claude "$@"; }`

The settings part is right. All five guarded entries (`.claude/settings.json` lines 10, 21, 25, 36, 40) need the new guard, and the new SessionEnd Shepy hook needs `"timeout": 15`. Claude Code's docs say SessionEnd hooks otherwise get 1.5 s, and a per-hook timeout raises that, up to 60 s (code.claude.com/docs/en/hooks, SessionEnd). Install the new `shepy` before editing settings: the old CLI rejects `claude-hook` without `--profile`. Do not apply any of this until F1 is fixed.

## Brief questions
1. Steal attempts:
   - Refused as required: non-owner CLI release, borrowed owner file, foreign SessionEnd, old token after release, claim against a live and resolved owner, Herdr error, silence (1001 ms), malformed or partial replies, null terminal and another Herdr session.
   - Not refused: F1.
   - The CLI release identity (`agent.get` with `target`) matches the real Herdr socket. It is a caller guard, not authentication: a same-user process that sets `HERDR_PANE_ID` can act as another pane, but that process could also read the owner file.
2. Pending notices: release keeps them, the next owner gets each once, and two claimants racing after release give one owner and two deliveries. Tests read and pass in both runs. Leased but unacknowledged notices redeliver after lease expiry (at least once, as documented).
3. `SHEPY_PROFILE` unset: hook parsing is unchanged, except the error text now names `SHEPY_PROFILE`. Claim behaviour in the daemon changes for all claimants regardless of the variable (F1).
4. The timeout test is load, not a defect. Load averages were 17.6, then 11.5. The test passed in both runs (1276 ms and 1420 ms); the claim stopped at 1001 ms both times. Both runs had other 5-second timeouts in untouched tests (5 and 3, different sets each run). Run 1 also had one assertion failure right after a timed-out demand test, at `:3916`. Run 2 had a wall-time assertion fail (9.7 s against an 8 s limit). All 22 S4 tests passed in both runs.
5. Checks: see below.
6. See F2.

## Checks
All ran with `env -i` (PATH, HOME, TMPDIR only), a fresh HOME, TMPDIR `/private/tmp/rs4-*/t`, Node 24.18.0 and Vitest 4.1.9 directly, and dependencies linked from `night-s4`. The `CLAUDECODE` and messaging variables were absent. Each run waited on `/private/tmp/agent-factory-full-gate.lock` (held by fixid suites for about 35 minutes).

| Check | Result | Wall time |
|---|---|---|
| typecheck (`tsc --noEmit`) | exit 0 | 9 s |
| hook file, run 1 | 167 passed, 5 failed (load) | 177 s |
| hook file, run 2 | 169 passed, 3 failed (load) | 131 s |
| related files (profile-delivery, observability-rpc, herdr-socket-client, profile-diagnose, claude-socket-identity, cli, cli-census, silent-peer) | 221 passed | 2 s |
| F1 probes, candidate | (a) and (b) fail, (c) passes | — |
| F1 probes, base | (a) passes | — |

Not run: the full suite, `pnpm check` and lint. No live Claude handover was tried.

Cost: the extra `pane.list` happens only on rejected rival claims in the same session. In the fixtures it took about 1 ms; with a silent Herdr it took 1001 ms per rival prompt and Stop, which fits the 15 s hook timeout. The real list has 28 panes.

Scratch (probe source `review-s4-probes-only.ts` sha256 `e70f47e5…`, logs `probe2/probe3/probe-base/hook1/hook2/related.log`): `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-rev-s4/9a14f344-133a-4fed-a365-db1a31338d64/scratchpad`.

## Noticed beyond my task
- The live store already holds 9 pane-shaped owner rows, including one `factory-engine-seat|w3J|w3J:p6S` whose session name is a workspace id. When the fix lands, decide whether old rows need a migration or one lease of patience. Owner: S4 builder.
- The brief named the output `review-S4.md`; the dispatch prompt named this path, and I used the prompt's.

## Recheck of f9a109b (correction for F1 and F2)
**ACCEPT.** Candidate: `night/s4` at `f9a109b`, on top of `6ce5bf0`. I read the whole correction diff, which touches 6 files.

How the fix works:
- A takeover now needs both the owner's pane and its terminal to be missing from the live pane list (`src/herdr/owner-terminal.ts:36-38`).
- An owner row whose recorded terminal is just its pane id, or that has no pane, never gets an early takeover (`src/observability/profile-delivery-service.ts:349-353`). Such rows can only be released by the holder, re-claimed by the holder with a resolved location, or taken after normal lease expiry.

Results, on my own probes (the earlier scratch test plus two new cases) and the builder's new tests:
- **F1 case (a), owner's pane missing from Shepy's agent index:** the rival is refused and Herdr is not called.
- **F1 case (b), the same pane id in two Herdr sessions:** refused.
- **Old-style rows (terminal recorded as the pane id), with both pane and terminal gone:** refused. This matches the 9 such rows in the live store.
- **Owner resolved normally, pane still live:** refused.
- **Good control:** a normally resolved owner whose pane and terminal are both gone is taken over at once by the rival, which receives the pending notice (`term_owner`, one `pane.list` call).
- **Builder's new tests** (`missing-index`, `ambiguous-index`, `legacy-pane-gone`, `confirmed-terminal`, `owner-pane-still-live`): all pass in both full runs.
- **One of my original controls still fails, as intended:** "owner terminal gone" fails because the fixture's `lane-b` session also has pane `w1:p1`. That makes the location ambiguous, so the row is now fenced.

F2 is fixed in the report:
- **Start command:** the `factory-seat()` line is identical to `~/.zshrc:43` apart from the added `SHEPY_PROFILE=engine-coordinator` prefix. Nothing is exported.
- **Settings:** the SessionEnd Shepy object carries `"timeout":15`, the README example has it too, and all five guarded entries are listed. The report also says to install the new Shepy and upgrade its daemon before changing settings.

Fit with main: the pair `6ce5bf0` + `f9a109b` cherry-picks cleanly onto main `0e5d529` (S1 landed). `f9a109b` alone conflicts, because it builds on `6ce5bf0`, so land the two together. The scratch worktree was discarded afterwards.

### Recheck checks
Same setup as before: `env -i`, a fresh HOME, TMPDIR `/private/tmp/rs4-*/t`, Node 24.18.0. Full runs started only when the 1-minute load was under 20.

| Check | Result | Wall time |
|---|---|---|
| typecheck, `f9a109b` | exit 0 | 14 s |
| typecheck, main `0e5d529` + S4 pair | exit 0 | 3 s |
| hook file, `f9a109b` (load 18.1 at start, 15-min load 19.9) | 176 of 177 passed | 119 s |
| hook file, main + S4 pair (load 9.8 at start, 15-min load 18.7) | 176 of 177 passed | 105 s |
| the two timed-out tests, run alone | pass (1.1 s and 1.3 s) | 8 s and 2 s |

Each full run had one 5-second timeout:
- `f9a109b`: "a concurrent prompt's fresh record survives a slower Stop's stale write", a test S4 did not touch.
- main + S4 pair: "public source CLI handover boundary: env-prompt", which spawns a source CLI through tsx.

I count both as load, not defects: each passes alone, and each passed in the other runs.

Probe source: `review-s4-recheck.test.ts` (sha256 `9584a591…`), with logs `r-probe*`, `tc-*`, `hook-*` and `iso-*`, in the same scratch folder as before. Not run: the full suite, `pnpm check` and a live Claude handover. The factory settings are not applied; that stays with the seat.

rev-s4 done: evidence/night/report-rev-s4.md
