# SHEPYCRASH (15.367), correction and carry

## Round 3 acceptance, recorded before implementation
The seat chose finding 1 option (a) in independent review `a97df00:evidence/night/review-SHEPYCRASH-2.md`. Before code changes, an actual Claude `/usage` invocation in a fresh mode-0700 HOME and TMPDIR ran a SessionStart hook using the built Shepy CLI with a recording preload. The observed chain was hook Node PID 37359 (`/Users/ray/.local/share/mise/installs/node/24.18.0/bin/node`), direct parent Claude PID 37275 (`/Users/ray/.local/bin/claude`). No shell or extra runtime wrapper was present. `/usage` reported zero API duration and zero model tokens; only private fixture settings were used, with no Herdr variables, live profile or live daemon access. Raw receipt: `/private/tmp/shepycrash.TJ4Ogt/r3-real-chain.log`.
Design to that observation: accept the nearest parent only when it is Claude directly or through `sh`, `bash` or `zsh` layers; any other intervening process is unknown. No generic Node wrapper is admitted. Stop at that Claude instead of walking above it, closing finding 3. Preserve daemon foreground-PID verification. Prove named, renamed and orphan nested cases and crash recovery through the real hook CLI; prove ps failure and the real one-second bound; consolidate logging cases. Gate with fresh private mode-0700 directories, focused tests, tsc, Biome and one locked full suite; retain the below-15 start ceiling and the two known Codex failures. Deadline: 18:00 local.

PARTIAL: corrections are committed and carried; independent recheck and full-gate acceptance remain open because the suite is not green.
Builder: shepycrash. Worktree: `/Users/ray/dev/shepy-wt/night-shepycrash`. Branch: `night/shepycrash-2`. Base: `7aa8adb` (SHEPYTRIM landed). Code candidate: `58d7e1a`; the following documentation commit changes no source.

## Acceptance and carry
Authority: the [brief](/Users/ray/dev/agent-factory/evidence/20261022-day/brief-SHEPYCRASH.md), [amendments](/Users/ray/dev/agent-factory/evidence/20261022-day/acceptance-check-SHEPYCRASH.md), [REVISE review](/Users/ray/dev/shepy-wt/night-rev-shepycrash/evidence/night/review-SHEPYCRASH.md) and subsequent seat calls. Original and correction acceptance blocks were recorded before coding and remain in commit history.
Binding corrections: bounded ancestry refusal without stdout or user warnings; foreground Claude PID verification; split the eight-fixture test and fold duplicate refusals; timestamp process warnings and fatal errors; cherry-pick onto a fresh branch, never rebase; one full suite below load 15 under the Shepy lock before 15:30.

| Original commit | Carried commit |
| --- | --- |
| `3067443`, implementation | `49a55d7` |
| `f62ca13`, earlier report | `109a994` |
| `1100f96`, correction | `ded56d2` |

After carry, `58d7e1a` hardens fatal formatting for non-Error throws. The implementation merged cleanly. The correction conflicted in the hook, daemon handler and RPC schema. Resolutions preserve SHEPYTRIM's removed demand runtime and ignored legacy fields, adding only PID and nested-claim metadata. No migration, rebase, main update, push or live installation occurred.

## Machine proof
- The real hook CLI now walks actual ancestors with `ps`, bounded to 64 parents and one monotonic second. Nested or unverifiable ancestry emits only one stderr note. The nested-child regression failed before the fix; now the live outer owner retains its token, details stay pending at attempt 0, and that owner receives and acknowledges them once. Declared nested claims also refuse with a valid current token. Fixtures are reparented before hooks run; all four native-process proofs also passed beneath a Claude-named launcher.
- Same-pane takeover requires Herdr's exact new session and the claimant's nearest Claude PID as the pane's sole foreground Claude. Both lookups share one second; missing, malformed, mismatched, ambiguous, failed and timed-out proof refuses. A `wet claude` wrapper is not accepted. The crash proof uses actual fixture PIDs and the real CLI; old release and delayed proof remain fenced. The eight validation fixtures are separate `test.each` cases; duplicate refusals now share the fails-closed table.
- Actual fixture daemon warnings, Error exceptions and a `throw null` attack produced timestamped physical lines, one warning and fatal exit 1. Node's default warning listener is replaced to prevent an unstamped duplicate. This covers runtime events after entrypoint initialization, not module-loading failures.
- Final built CLI against a built fixture daemon passed: 156 ms takeover, fresh token, once-only pending delivery, old release fenced, other-pane refusal and unreachable-Herdr refusal. Wake and bounded refusal-context proofs still pass.
- Read-only Herdr process-info on `w3J:p0C` showed Claude PID 39288 (`argv0: claude`, name `2.1.308`) separately from the `wet` wrapper; read-only `ps` confirmed comm `claude`. No `~/.claude/sessions/<pid>.json` file was read or relied on. This verifies producer shape, not a new live restart. No live daemon or pane was changed.

## Checks and retained failures
Every gate used `env -i`, fresh physical HOME and TMPDIR, without CLAUDECODE or either Claude messaging variable in the runner environment. Fixture credentials were synthetic. Tools: Node 24.18.0, pnpm 11.9.0, TypeScript 6.0.3, Vitest 4.1.9. Dependencies are the seat-authorized local APFS clone; no download or installation occurred in this revision.

| Check | Result and wall time |
| --- | --- |
| Carried hook, socket, identity and delivery tests | 259 passed; exit 0; 61.16 s. |
| Carried typecheck, changed-file Biome and diff check | Exit 0; 3.26 s. |
| Final build and root package check | Exit 0; 4.71 s including rebuild; 318 packaged files. |
| Final logging and ownership proof selection; typecheck and Biome | Six passed in 3.56 s; checks exit 0 in 3.11 s. |
| Lint, format, DB, Pi and Herdr plugin checks | Exit 0; combined 9.70 s. |
| Four real-hook proofs beneath a Claude-named launcher | Passed; exit 0; 3.39 s. |
| Full supported suite, two workers | Exit 1: 1,167 total, 1,160 passed, seven failed in five files. Test interval 114.03 s; 598.89 s including waits. |
| Matched main and candidate failure controls | Each: five passed, same two Codex failures; 6.97 s main, 3.48 s candidate. |

The one completed carried full run tested `ded56d2`, held `/private/tmp/shepy-full-suite.lock` and started at load 13.32 after a bounded wait. The earlier refusal at 27.15 started no suite. Load during execution was not sampled. The only production change afterward is the fatal-error formatting expression, with a new `null` regression case. Six targeted proofs, typecheck, build and packaging passed afterward; the full suite was not repeated, respecting the one-run limit. Its final-source coverage gap remains explicit.
Two Codex failures reproduce on frozen main `7aa8adb`: `agent-history-readers.test.ts` and `observability-rpc.test.ts`. Five other cases hit unchanged five-second limits: invalid socket claims, pending Stop delivery and deferred-tail Stop in `claude-hook.test.ts`; missing-identity refusal in `notice-correctness.test.ts`; delayed replacement in `profile-subscribe.test.ts`. All five passed focused controls on both sides. Greens do not erase the reds or prove these five failures pre-existing; review must adjudicate them. Every revision case present in that full snapshot passed; the later null-exception case passed its targeted run. No existing assertion, timeout or fixture hash was relaxed.
Intermediate failures remain in scratch: macOS rejected the first shell fixture; a floating-point subprocess timeout was caught and corrected. One remaining fixture process was verified through its private socket and stopped; cleanup is now registered before execution. Nested takeover and unstamped process output were observed red before their fixes.

## Cost, limits and next owner
Scratch: `/private/tmp/shepycrash.TJ4Ogt` holds logs, frozen bases, proof driver and JSON results. Full command CPU: 21.45 s user plus 12.18 s system; maximum reported RSS 307 MB, not summed concurrent-tree memory. Built fixture: 188,544 bytes with SQLite sidecars, driver RSS 84 MB, command-and-child CPU 0.88 s plus 0.24 s. Dependency trees report 377 MB each; APFS shared-block cost is unmeasured. Native Pi totals through 190 calls: input 245,494; cache-write 0; cache-read 38,022,912; output 137,366; summary null (not separately metered). These are retained-context totals, not daemon throughput. No real idle wait or production resource delta was measured.
Full JSON SHA-256: `31314a0bd25ff82ff905755b50ba96261e35313ce69719bdb2499fc21dfdcf57` (`carried-low-load-full.json`). Built proof log: `25d7a85042ade04d9da8b867b117acf1ad559ee55d330f80cd4d18e0b846de77` (`final-carried-built-proof.log`).
Normal commit and cherry-pick commands changed no hook configuration. The configured `.husky/_` installation is absent, so hooks are not claimed to have executed; checks ran explicitly. PID and nested flags are metadata, not authentication against arbitrary local RPC clients. An unprompted restarted session still does not claim. Next owner: the seat and independent reviewer for recheck, the five unresolved timeouts, acceptance and any Ray-approved installation.

## Noticed beyond my task
The full suite still hits five-second limits with two workers and a below-15 start; focused greens do not establish the cause. The two Codex fixture failures persist on main. Suggested owner: the Shepy seat. No unrelated fix was attempted.
