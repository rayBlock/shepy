# SHEPYCRASH (15.367), round 3

**PARTIAL:** implementation and revision proofs pass; the full suite remains red. Independent recheck and adjudication of two timing failures remain open. No live installation or profile change occurred.

Builder: shepycrash. Worktree: `/Users/ray/dev/shepy-wt/night-shepycrash`. Branch: `night/shepycrash-2`, descendant of main `7aa8adb` and the previous report `b4ca875`. Before-code receipt: `8678b18`. Final code candidate: **`0fff224`**. The following report commit changes documentation only; no source changed after the full run.

## Authority and before-code observation

The seat selected finding 1 option (a) from `a97df00:evidence/night/review-SHEPYCRASH-2.md`: accept Claude directly or through shell layers only, retain daemon foreground-PID verification, refuse unknown intervening processes, prove ps failure and its one-second bound, close finding 3 by this policy, and consolidate daemon logging tests. Acceptance and the actual process observation were committed in `8678b18` before implementation. Deadline: 18:00 local.

An actual installed Claude `/usage` invocation, with private settings and fresh mode-0700 HOME and TMPDIR, ran a SessionStart hook through the built Shepy CLI with a recording preload:

```text
37359 37275 /Users/ray/.local/share/mise/installs/node/24.18.0/bin/node
37275 37265 /Users/ray/.local/bin/claude
```

The hook Node's direct parent was Claude. No extra runtime wrapper was observed or admitted. A subsequent actual Claude probe with an explicit shell script observed Node PID 25886, parent `/bin/sh` PID 25883, parent Claude PID 25555. Both probes reported zero API duration and zero model tokens. They used no Herdr variables or live profile; only synthetic API configuration was supplied.

Receipts under `/private/tmp/shepycrash.TJ4Ogt`:
- `r3-real-chain.log`, SHA-256 `42f3a71f4305c32409be5f4942a3d52e6b551be686df50b52e4f1167ebc2fcbe`.
- `r3-real-shell-chain.log`, SHA-256 `fc79460ce28a2ad947e25d647c2729a3f903c4905f8bec64980a1ac29014eaa1`.

## Findings addressed

1. **Immediate parent binding.** The hook stops at its own first Claude, traversing only `sh`, `bash` or `zsh` layers. Any other intervening command, missing information, failed lookup, cycle, depth limit or deadline returns unknown. Reaching PID 1 without finding Claude no longer grants permission. No generic Node or Bun wrapper is accepted. The daemon's same-pane foreground-PID check is unchanged.
   The renamed nested regression was red against the old guard: the real CLI returned the live seat's pending detail. With the new guard, the renamed `agent-x` process refuses locally before claiming. A Claude-named nested process and an orphan report their own PIDs, not the outer seat's; the daemon refuses takeover because the outer seat remains the sole foreground Claude. The orphan's actual PPID is asserted to be 1. All three retain the outer token and pending attempt 0; the real outer hook then receives and acknowledges the detail once. Declared nested RPC claims still refuse even with the current token.
2. **Unknown ancestry and what the seat sees.** Real CLI tests cover both native command failure and the one-second timer. An explicit test-only preload replaces only the ps command with an exiting or non-returning Node child, retaining native `execFile` timeout handling. For both prompt and Stop, failure yields exit 0, empty stdout and exactly one stderr line: `shepy: cannot verify Claude ancestry; profile claim skipped`. There is no model outcome context and no user-facing `systemMessage`. No claim occurs; the owner file and token remain unchanged, and the detail remains pending at attempt 0. The timeout child is actually killed; the supplied timeout is positive and at most 1,000 ms, with at least 900 ms elapsed. After ps works again, the next prompt delivers and acknowledges once. Environment names alone, without the explicit test preload, are also proved ineffective. This is machine-verified hook output, not a claim about Claude's visible diagnostics UI.
3. **Closed by option (a).** The hook no longer walks above its own Claude. A Herdr server's higher Claude ancestor cannot label every pane nested. Five CLI cases, including the ordinary public prompt boundary, also pass beneath an extra Claude-named launcher.
4. **One logging table.** CLI error, warning plus Error, and non-Error fatal cases now run in one table inside one Vitest case. They retain timestamp-per-physical-line, once-only warning and fatal exit-1 assertions. This covers runtime events after entrypoint initialization, not module-loading failures. The hook test file has 157 cases versus 155 before this revision; no existing assertion or product timeout was relaxed.

Legacy in-process hook fixtures supply a Claude-parent ps reply through a test-file module mock because Vitest itself has no Claude parent. These do not prove ancestry. The attack, crash, shell-parent and enclosing-Claude proofs use actual owned processes and the real CLI with the unmodified OS ps boundary. Only the two explicit ps-fault cases preload that command fault; production has no environment-controlled injection switch.

## Checks and retained failures

Every runner used `env -i`, a fresh physical mode-0700 HOME and TMPDIR, and no `CLAUDECODE`, `CLAUDE_CODE_MESSAGING_SOCKET` or `CLAUDE_CODE_MESSAGING_TOKEN`. Fixture credentials were synthetic. Node 24.18.0, pnpm 11.9.0, TypeScript 6.0.3 and Vitest 4.1.9; no dependency installation or download. Dependencies remain the seat-authorized local APFS clone.

| Check | Result |
| --- | --- |
| Final revision selection | Seven passed, exit 0, 15.08 s. |
| Five CLI cases beneath enclosing Claude | Five passed, exit 0, 7.88 s. |
| Hook, socket identity, delivery and socket unit selection | 261 passed and one five-second `unreachable` fixture timeout, 101.03 s. That exact case then passed its focused control and the full run; this intermediate red remains recorded. |
| Final typecheck and changed-file format check | Exit 0, 3.30 s combined. |
| Final project Biome | 159 files checked, exit 0, 1.16 s. Test-only MJS preload is outside the configured include list and was checked through execution and manual inspection. |
| Build, root package, DB, Pi and Herdr plugin checks | Exit 0, 10.35 s combined; 318 root package files. |
| Final built CLI and built fixture daemon | PASS, exit 0, 1.99 s; actual fixture SIGKILL without SessionEnd, 207 ms takeover, fresh token, once-only detail delivery and acknowledgement, old release fenced, other-pane and unreachable-Herdr refusals. |
| One full supported suite, two workers | **1,170 total, 1,166 passed, four failed**, exit 1; test interval 131.97 s, command 219.06 s including lock wait. |
| Matched candidate and frozen-main controls | Each: two timing cases passed and the same two Codex failures remained; 1.73 s candidate, 2.05 s main. |

The full run tested `0fff224` under `lockf -k -t 120 /private/tmp/shepy-full-suite.lock`. Its first under-lock load sample was **14.98**, below 15, at 16:53:54 local. Both directory modes were asserted 0700 before launch. No second full suite was run. All revision cases passed in this exact final-source snapshot, including the non-Error logging case that previously lacked full-run coverage. Load during execution was not sampled.

Four full-run failures remain:
- `agent-history-readers.test.ts`: `CodexHistoryReader is registered in the default agent history service`.
- `observability-rpc.test.ts`: `reads additional runtime histories through agent.read`.
- `claude-hook.test.ts`: `a previous turn's delivery is acked by the next prompt with no Stop in between`, five-second test timeout at 5,136 ms.
- `notice-correctness.test.ts`: `snapshot completions with fresh text do not take the retry delay`, 532 ms against the existing 400 ms assertion.

The first two reproduce on frozen main `7aa8adb` and are the seat's known Codex failures. The other two passed matched focused controls on both sides: candidate 218 ms and 46 ms, main 610 ms and 41 ms. These greens do not erase the full-run reds or prove them pre-existing. They remain for independent adjudication. None of these four cases has a changed assertion or time limit. No retry loop was added. The consolidated logging table has a 30-second combined fixture budget instead of three separate 15-second budgets. The first red-regression invocation hit the tool's 30-second cap before a result; the completed red invocation then showed the actual stolen detail. Both logs remain in scratch.

## Provenance, cost and limits

Raw logs, JSON, proof drivers and frozen main remain under `/private/tmp/shepycrash.TJ4Ogt`. Final full result: `r3-full-suite.json`, SHA-256 `e644d3138197f2ae660a0de118fe5ca6a071600940539a1fb487142924195022`. Useful receipts: `r3-renamed-red-trace.log`, `r3-final-core.json`, `r3-focused.json`, `r3-failure-controls.json`, `r3-main-controls.json`, `r3-enclosing-claude-control.log`, `r3-built-proof.log`, `r3-freeze-checks.log`, `r3-final-biome.log` and `r3-build-package.log`.

Full-command CPU was 19.42 s user plus 9.63 s system; maximum reported RSS 333 MB, not summed concurrent-tree memory. The built proof used 188,544 fixture bytes with SQLite sidecars; command CPU 1.03 s user plus 0.43 s system, maximum RSS 86 MB. At the 17:13 snapshot, 23 private round-three case directories occupied 16,708 KiB; scratch including earlier frozen bases occupied 793,496 KiB, dependencies 386,420 KiB and generated dist 2,116 KiB. APFS shared-block cost and a production idle/resource delta remain unmeasured.
Native Pi usage through the first 47 round-three calls: input 110,006; cache-write 0; cache-read 16,549,888; output 61,726; summary null, not separately metered. This cutoff precedes final report production and is not a completed-conversation total. Cache figures describe retained context, not daemon throughput.

No source changed after the full run. Normal commits were used without changing hook configuration; `.husky/_` remains absent, so Git hooks are not claimed to have run. Checks ran explicitly. Final socket-scoped cleanup found no remaining owned Claude-named orphan fixtures and signalled no foreign process. No rebase, push, main update, live installation or live profile operation occurred. PID, process names and nested flags remain descriptive metadata, not authentication against arbitrary local RPC clients. An unprompted restart still does not claim; an unknown parent deliberately blocks even the current owner's prompt and Stop delivery until verification works.

Earlier carry and round-two evidence remain immutable in `b4ca875:evidence/night/report-shepycrash.md`: original implementation `3067443` carried as `49a55d7`, correction `1100f96` as `ded56d2`, then non-Error logging hardening `58d7e1a`. This round added commits on top of `b4ca875`, without rebasing or changing the carried SHEPYTRIM removal.

Next owner: the seat and independent reviewer to recheck `0fff224`, adjudicate the two timing reds, and decide acceptance, integration and any Ray-approved installation.

## Noticed beyond my task

Even with two workers and a below-15 start, two unrelated timing checks still failed in the full run and passed focused controls. Their cause is unproved. The two Codex failures remain on main. Suggested owner: the Shepy seat; no unrelated fix was attempted.
