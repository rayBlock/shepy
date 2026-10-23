# SHEPYGONE — row 15.444

**BUILT** — candidate `b69e200b90e8b287925af68e68fb13ba0f517d17` on `night/shepygone`, base `6744ff6`. Completed workers survive restart during the history retry and close as finished. Independent review and live acceptance remain open.

## Acceptance block (recorded before implementation)

- Reproduce the driffs ordering with a native completed turn, owner notification, and close within seconds, including restart during the history retry.
- If the last native turn completed, close must report finished rather than gone without finishing, using durable evidence rather than the old process's memory.
- A subscription created after settlement must receive the correct departure outcome; existing completion recipients must not receive a duplicate.
- A genuinely unfinished worker still delivers exactly one gone outcome; resumed work must not inherit an old completion.
- Keep delivery otherwise unchanged; add one focused test per behaviour with a passing control.
- Run focused tests, `pnpm typecheck`, Biome, and one full suite under `lockf -k /private/tmp/shepy-full-suite.lock`, using Node 24 first, `env -i`, fresh private HOME and TMPDIR, and no Claude messaging variables.
- No live daemon, database, profiles, installs, agent messages, rebases, pushes, or landing. Commit the candidate and this report in the assigned worktree.

## Acceptance proof

- Before the 500 ms retry, journal `agent.status.changed` in SQLite. Recover that observation before reconciling a close or successor turn; keep the ordinary final/status commit atomic. No schema or migration changes, new polling, or extra steady-state event rows.
- `finished-departure.test.ts` uses producer-shaped Pi JSONL, native session identity, public index events, guarded profile subscriptions, real migrated SQLite, and inbox readback. Restart closes SQLite and recreates every store and service; the original retry cannot supply recovery memory.
- Three regression declarations cover six cases: close during retry with and without restart; late subscription after done, idle or blocked, including earlier turns and seen/unseen flaps; resumed work producing done then exactly one unfinished gone. Existing recipients retain their original event ids without another departure obligation.
- Base reproduction: three failures and one passing no-restart control before production edits. Final regressions pass. Existing lifecycle, history retry, profile delivery, hook and socket tests cover unchanged delivery; no live daemon, profiles, panes or sessions were touched.
- If close preempts the delayed read, its completion excerpt may remain empty, as before. The fix preserves honest finish classification, not a guarantee that final text was flushed. Independent acceptance and live-use verification belong to the seat.

## Checks and retained failures

Every command used `env -i`, fresh mode-0700 HOME and TMPDIR, and no CLAUDECODE, CLAUDE_CODE_MESSAGING_SOCKET or CLAUDE_CODE_MESSAGING_TOKEN. Sources: installed Node 24.18.0 and pnpm 11.9.0; copied sibling dependencies, no install. TypeScript 6.0.3, Vitest 4.1.9, Biome 2.5.1. Scratch and raw logs: `/private/tmp/factory/shepygone/`.

| Check | Result | Wall |
| --- | --- | --- |
| Frozen focused lifecycle, delivery, history and new regressions | 150 passed, exit 0 | 19.11 s |
| Earlier separate real hook/socket file | 158 passed, exit 0 | 57.72 s |
| Frozen `pnpm typecheck`; Biome whole-tree check | Both exit 0 | 4.29 s; 0.62 s |
| Frozen full Vitest, one worker, prescribed `lockf` lock | 1,193 passed in 77 files, exit 0 | 89.14 s |
| Frozen `pnpm build`; `pnpm package:check` | Both exit 0 | 3.20 s; 3.61 s |
| DB, Pi package, Herdr plugin gates | All exit 0 | 1.38 s; 7.96 s; 2.60 s |

Failed proof was retained, not erased by the green run. Initial pnpm dependency auto-verification aborted before installation; later commands disabled that automatic install check. First focused run exposed the intentionally changed journal assertion plus one hook timeout; the assertion now requires exactly one durable observation, not an empty log. An early typecheck found two corrected optional/null typing errors.

`pnpm check` itself exited 1: 25 failures including overlong nested Unix sockets, fixture startup failures, one timeout, and the pruning test below. Direct Vitest with the same clean environment removed the extra socket-path nesting; its first full run retained one pruning failure (1,192 passed). That test computes its future clock before two refreshes, then creates the subscription under test: a refresh taking over its one-second margin makes the new row too young. Recorded runtimes were 1.55 s and 4.74 s, versus 0.53 s in the focused control. No assertion or timeout was weakened. Frozen full suite passed unchanged. All aggregate components were separately exercised, but the aggregate command is not claimed green.

Full frozen-suite log SHA-256: `f6a4191a81b56142271edfa8c3e950a4ea9e3089b4981f402a8c8db0139d10f7`.

## Cost, limits and handoff

- `/usr/bin/time -l` measured gate processes and children: frozen full suite used 19.96 s user CPU, 9.22 s system CPU and 312,344,576 bytes maximum RSS. These are fixture-run costs, not live-daemon measurements.
- Node single-process lookup stress on a migrated SQLite file with 100,000 synthetic unrelated events: 10 recovery lookups took 23.47 ms (2.35 ms each), CPU 14.02 ms user and 8.61 ms system, RSS 67.55 MB. Database 6,877,184 bytes, WAL 7,345,992 bytes, SHM 32,768 bytes. Recovery lookup is once per indexed worker per service lifetime, not every tick; worst-case startup still scans retained event history. This synthetic probe is not lifecycle acceptance or a hard cap.
- Input, cache-write, cache-read, output and summary tokens are each **null**: no provider accounting was supplied to this worker. No model/API calls were added by the implementation. Live idle CPU, multi-daemon concurrency and long-running live acceptance were not measured or authorized.
- Candidate diff, tests and README reviewed locally; no independent checker was assigned. Normal Git commit used no hook bypass; configured `.husky/_` is absent in this worktree, so explicit gates above supply proof. Next owner: seat for independent review, landing and authorized live verification. No push or rebase.

## Noticed beyond my task

- `scripts/run-tests.mjs` budgets a shorter socket suffix than the Claude replacement fixtures use. The failed wrapper attempted a 109-byte path on macOS; direct execution avoids that extra nesting. Owner: test-runner maintainer.
- `agent-lifecycle.test.ts:502-532` bases pruning age on a clock taken before slow fixture refreshes. Under load it can reject the later-created row as too young. Owner: lifecycle test maintainer; compute age from the row's own timestamp without enlarging timeouts.
