# Review: SHEPYCRASH round 2 (row 15.367)

Reviewer: rev-shcrash2 (Claude Sonnet 5.5), adversarial recheck, not blinded (round-1 REVISE read first). Candidate: `b4ca875` (code `49a55d7`, `ded56d2`, `58d7e1a`) on carried main `7aa8adb`. Reviewed in my own worktree, detached at the candidate. Diff read before the builder's report.

**REVISE.** The round-1 reproduction is fixed: a nested Claude named `claude` no longer takes the profile, and the daemon's foreground check refuses when the claimant's pid is not the pane's only foreground Claude. But both layers recognise a Claude only by its process name. A nested Claude with any other name takes over the live seat and receives its pending outcome, which is the round-1 harm again (finding 1). Everything else is sound or low.

## Findings
1. **High, narrowed: a nested Claude not named `claude` still takes over the live seat.** Code: `src/cli/claude-hook.ts:331-345` (name test `basename(comm) === "claude"` or `/claude/versions/<v>`), `src/herdr/owner-terminal.ts:121-127` (same test on Herdr's `argv0`/`name`).
   - Cause: the hook finds the claimant's pid as "nearest ancestor named claude". A nested Claude with another name is invisible, so that pid becomes the live outer seat's pid. The daemon then finds the outer seat as the pane's only foreground Claude and the pids match, so it accepts the claim. On macOS `ps -o comm` shows the name the process was started with (checked: a symlink `claude-alt` shows `bin/claude-alt`), so `CLAUDE_BIN=/path/claude-code`, an alias, an npm `node cli.js` install or `bunx` all escape. The factory's own `claude -p /usage` runs `CLAUDE_BIN ?? 'claude'` (`agent-factory/tools/tanks/meter-legs.ts:96`).
   - Reproduction (real hook CLI, live outer fixture seat that has claimed, Herdr fixture naming the nested session and listing the outer pid as sole foreground Claude): variant `renamed` gives takeover true, new token, owner becomes the nested session, the seat's pending outcome delivered to it. Controls in the same run: variant `nested` (named `claude`) is refused with the stderr note, token unchanged, pending attempt 0; variant `orphan` (nested Claude reparented to pid 1, so no outer ancestor) is refused by the daemon pid check and gets the refusal context line.
   - Options (recommended first): (a) the hook accepts only a claude that is its direct parent or parent-of-a-shell (hook, then `sh`, then claude); anything else is `unknown` and refuses, which also closes renamed nested binaries because their nearest non-shell parent is not the Claude the hook was started by; (b) leave as is and add a seat rule that nested Claudes must be started as `claude` and not via `CLAUDE_BIN` overrides; (c) have the daemon also require the process's `cmdline`/`argv` to match a session flag (not checked whether Claude exposes one).
2. **Low: the "cannot verify ancestry" refusal is untested, and it blocks more than takeover.** `claude-hook.ts:358-366` skips every UserPromptSubmit and Stop claim when `ps` fails, a parent vanishes, depth reaches 64, the 1 s bound runs out, or the chain ends at pid 0 instead of 1. No test hits those branches (grep for "cannot verify" in `test/` finds nothing). If `/bin/ps` is ever unusable the seat is silently deaf (one stderr line the model never sees). Cost when it works: 8 ancestors took 17 to 21 ms at load 20, fine.
3. **Low (not tested live): a herdr server started from inside a Claude session makes every pane's Claude "nested".** The ancestor walk runs to pid 1, not to the pane's shell. On this machine the server is a child of a Ghostty-launched herdr client, so it is fine now. A suggestion for finding 1 option (a) removes this too.
4. **Low (decision 132): test shape.** 570 lines added, 92 removed across two test files; 7 new test declarations plus table rows. Three subprocess tests for the daemon log (`cli-error`, `process-events`, `null-exception`) overlap in the wrapper path; `null-exception` pins one expression. The 7 `foreground-*` rows go through the daemon RPC, not the hook CLI, which is right for a daemon rule. I would fold the three log tests into one table, not add more.

## Brief items
1. Round-1 reproduction rebuilt: refused for a `claude`-named nested session (finding 1 controls). Attacks: wrapper in between and `claude -p` from a script both keep the outer Claude in the ancestor list, so they refuse (read and via the nested variant's extra node layer). Renamed binary: bypass (finding 1). Orphaned nested Claude: refused. Process-info failing, slow, malformed, wrong pane, two Claudes, wrapper only, missing pid: all refuse in the builder's table (passed in my run; `foreground-timeout` took 1.19 s). A real crash plus same-pane restart recovers (test passed; owner replaced, old release fenced). Live Herdr shape checked read-only: for this pane `pane process-info` lists claude `argv0 "claude"`, `name "2.1.308"` plus caffeinate and MCP servers, so the daemon's filter matches real producers. Not checked: a real nested session overwriting Herdr's `agent_session` (would have changed live Herdr state).
2. Finding 2 (8-fixture timeout): split into 8 `test.each` rows, each about 0.3 s. Finding 3 (repeats): folded into the fails-closed table. Finding 4 (unstamped lines): handled for warnings, uncaught exceptions and `throw null`; module-load failures stay unstamped and the report says so. Unhandled rejections reach the stamped handler (inferred from Node's default mode, not run).
3. SHEPYTRIM carry faithful: every removed source line is a rewritten sentence or signature; `acceptedSourceKinds` legacy fields (`schemas.ts`), the deprecated `--profile-demand` flag (`shepy.ts:232`) and the SHEPYTRIM tests are intact; typecheck passes. The one removed test is the stale-token duplicate round 1 had approved.
4. Gates below.

## Checks (Node 24.18.0, `env -i`, fresh HOME and TMPDIR mode 0700; CLAUDECODE and both messaging variables unset)
| Check | Result | Wall time |
| --- | --- | --- |
| `claude-hook.test.ts` on candidate | 155 passed | 45.1 s |
| `tsc --noEmit`, `biome check .` | exit 0 / clean | 3.6 s / 0.1 s |
| Full suite under `lockf -k /private/tmp/shepy-full-suite.lock`, start load 20.2 | 1,165 of 1,168 passed, 3 red | 52.1 s |
| The 3 red, control on `7aa8adb` (extracted copy) | 2 Codex tests (`agent-history-readers`, `observability-rpc`) fail on main too, identical. The third, `notice-correctness` "delayed re-read" (`expected 464.8 < 450` ms), passes alone on both main and candidate; it is a load wall-clock assertion that never reaches changed code | 5 s |
| Nested-attack probe, 3 variants | nested refused; renamed took over; orphan refused | 5.7 s |

Load was above 15 at the start of the full run (20.2); the 450 ms assertion is the same family round 1 saw. I did not rerun the full suite.
I copied `node_modules` with `cp -cR` from the builder's worktree into mine (local, no download) because the runner refuses a symlinked tree. Probe test and logs: `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-rev-shcrash2/36a36a5d-ba78-40c6-ab6e-75d37e674503/scratchpad` (`zz-probe.test.ts`, `full.log`, `main/`). The probe file was removed from the worktree; nothing in the candidate was edited. No install, daemon restart or live profile touched.

## Limits and next owner
- Next owner: the seat decides finding 1 (option a, b or c), then a builder correction and one more recheck. The candidate changed would invalidate this review.
- Residual the check already accepted: a local RPC client can send any `claudePid`; the pid is metadata, not authentication.
- Not verified: a real restart in a live pane (producer shape only).

## Noticed beyond my task
- Two Codex tests fail on main `7aa8adb` (`test/unit/agent-history-readers.test.ts`, `test/integration/observability-rpc.test.ts`), so the Shepy full suite is never green. Suggested owner: the Shepy seat.
- `test/integration/notice-correctness.test.ts:358` asserts a 450 ms wall-clock bound that fails at load 20. Suggested owner: the Shepy seat (widen or measure CPU time).
