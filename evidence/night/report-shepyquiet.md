# shepyquiet

BUILT — settled workers close silently; unfinished workers still notify once as gone.

Branch: `night/shepyquiet`. Base: `b576f26`. Candidate: the commit containing this report.
Brief: `/Users/ray/dev/agent-factory/evidence/20261023-picture/brief-SHEPYQUIET.md`.

## Acceptance block (recorded before implementation)

1. Removing a worker whose latest status is done, idle or blocked records no new owner delivery or wake, through Claude hook and Pi delivery paths.
2. Claude socket wakes describe each worker's actual outcome: finished, blocked or gone without finishing.
3. Removing an unfinished worker still creates exactly one gone notice for its owner.
4. Add one regression guard per behaviour, prove red then green, run focused checks, typecheck, Biome and the full suite in isolated environments; serialize the full suite with the prescribed lock.
5. Do not touch the live daemon or profiles. Commit the candidate and this report in the assigned worktree.

## Candidate and acceptance evidence

- Filter settled departures before shared inbox projection; retain the gone audit event and subscription cleanup. Hook and Pi profile delivery share that inbox.
- Preserve a pending completion when close interrupts its history retry. Recovered completions still schedule their original wake, rather than relying on a second gone notice.
- Group socket text by actual event type; retain the existing sanitization, 240-character cap and attempt fencing. README describes the changed behaviour.
- Permanent guard map: lifecycle status/removal table guards silent settled close; existing unfinished-close guard covers one gone across refresh/restart; one mixed socket test guards truthful labels. Existing recovery tests now expect only the original completion and commit their fixture status with its event, like production.
- Red: six settled-close cases and mixed wake failed; both unfinished-close controls passed. Green: all seven cases pass in the frozen full suite.
- Additional disposable probes checked done, idle, blocked, working, unknown, each settled status returning to working, and crash-before-publication recovery. Real private socket frames and leased hook/Pi rendering agreed: no extra wake or gone delivery for settled workers; one gone for unfinished workers; one recovered completion. Repeated close/schedule produced no extra wakes.
- No live daemon, profile, pane or session was inspected or changed. No live-use grant or independent checker was supplied; independent review and live acceptance remain open for the seat.

## Checks (exit 0 unless noted)

Tools: Node 24.18.0 from the assigned mise installation; pnpm 11.9.0; locked Vitest 4.1.9 and Biome 2.5.1. Reused a local dependency clone; no dependency installation completed.
Every check used `env -i`, fresh private HOME/TMPDIR and no inherited Claude environment. Private scratch/logs: `/private/tmp/factory/shepyquiet/`.

| Check | Result | Wall time |
| --- | --- | --- |
| Focused four integration files | 285 passed | 53.55 s |
| Frozen `pnpm typecheck` | Passed | 2.81 s |
| Frozen `pnpm lint` and `pnpm format:check` | Passed | 1.09 s and 0.66 s |
| Frozen full Vitest suite | 1,187 passed, 76 files | 58.07 s |
| `pnpm db:check` | Passed | 2.65 s |
| `pnpm package:check`, including build | Passed | 9.42 s |
| Pi package and Herdr plugin checks | Passed | 4.20 s and 2.23 s |
| Disposable boundary probes | Nine scenarios passed | 2.07 s |

The frozen suite ran through factory `gatelog.ts`, then `lockf -k /private/tmp/shepy-full-suite.lock pnpm exec vitest run`. All `pnpm check` components ran, but not that aggregate command: its test wrapper nests socket paths beyond macOS's limit under the mandated scratch root. Initial wrapper runs retained 22 and then 6 environment failures; a socket-only control bound at 103 bytes and refused 111 bytes with EINVAL. Direct Vitest retained the required clean environment and short private paths. Initial pnpm automatic dependency verification aborted before installation; subsequent commands disabled that automatic install check. An initial probe error was a missing fixture delivery field, corrected without changing production code or assertions.

Frozen full-suite log SHA-256: `34295cd83fb2ff9ce6ebe8f63e327a69e2a60a44223a580bfd459414b87d0cb2`.
Frozen code/test/README patch SHA-256: `5de48be421211db4512a6fcb53b77bd32f0ece2aab2a72820ab9f5517b92bdcb`.

## Cost, limits and next owner

`/usr/bin/time -lp` measured command-tree CPU and reported maximum RSS, not simultaneous aggregate process memory. Frozen suite: 21.01 s user, 11.46 s system, 389,152,768 bytes maximum RSS. Nine probes: 0.69 s user, 0.28 s system, 188,186,624 bytes RSS; each SQLite fixture was 204,800 bytes with no WAL/SHM sidecars present. Probe history held one to three events; repeated-close evidence does not establish long-history performance. No polling, schema or new retained data was added. Input, cache-write, cache-read, output and summary tokens: null; model-usage records were not available through this packet.

Next owner: the seat for independent review, integration and authorized live verification. Existing queued gone obligations are not retroactively deleted. Normal Git hook configuration is unchanged; its configured generated `.husky/_` directory was absent in this worktree, so commit-time hooks are unavailable, not bypassed.

## Noticed beyond my task

`scripts/run-tests.mjs` budgets a shorter socket suffix than the Claude socket replacement fixtures actually use. Under long private TMPDIR paths this causes EINVAL before behaviour runs; the test-runner owner should correct that budget. No unrelated fix was made.
