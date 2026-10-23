# SHEPYQUIET independent review

**ACCEPT**

Candidate: `46810b7` (`night/shepyquiet`), based on `b576f26`. Scope: settled departures, unfinished gone delivery, and truthful Claude wake labels. Review worktree: `/Users/ray/dev/shepy-wt/night-rev-quiet-luna`.

## Findings

- **Defects:** none found.
- **Blocking proof gaps:** none for source acceptance. Live daemon/profile behavior was not authorized and was not checked; seat retains live-use verification.
- **Suggestions:** none.

The event log keeps `agent.gone`, while delivery projection filters only gone events whose event-time `from` is done, idle or blocked (`src/observability/profile-delivery-service.ts:329-344`). Departure status also accounts for a completion flushed during close (`src/observability/agent-index-service.ts:324-338`). Wake groups are labelled from each event type, with the existing sanitization and 240-character bound retained (`src/daemon/claude-idle-wake-service.ts:110-138`). The mixed socket test exercises done, idle, blocked, gone and tool-failed events together. I found no change to ordinary blocked/done delivery or owner scoping.

## Executed checks

- Focused lifecycle and Claude-hook integration tests: **275 passed** across 3 files, 27.46 seconds. This directly exercised settled closes and the real hook/socket path. (The command also named a nonexistent fourth test path; Vitest ran the three existing files.)
- `pnpm typecheck`, `pnpm lint` and `pnpm format:check`: passed; 167 files checked by Biome.
- All commands used Node 24.18.0, `env -i`, and fresh mode-0700 HOME/TMPDIR; Claude messaging variables were absent. Dependencies were reused from the sibling candidate worktree; no installation was needed by the review commands.
- Builder's frozen report records red-on-base and green-on-candidate for the regression cases and the full suite (1,187 tests). I did not independently replay the base comparison or full suite.

## Test and cost review

The candidate changes 168 test lines in `agent-lifecycle.test.ts` (105 added, 63 removed) and adds 63 lines in `claude-hook.test.ts`. The two added test declarations cover one settled-close behavior with a 3-status by 2-pane-exit table (six cases), and one mixed wake-label behavior. The table is useful coverage, not six distinct behavior tests. Existing unfinished-close assertions remain and retain their exactly-once check across refresh/restart. The fixtures drive lifecycle services and a real private socket/hook path; no source-text pinning or test-helper-only assertions found.

Review scratch: `/private/tmp/factory/rev-quiet-luna-review.6yGtKY` and `/private/tmp/factory/rev-quiet-luna-check.1hODaB`. No live processes, profiles, database, or panes were touched. I did not measure long-history or multi-client cost; this patch adds no polling or retained data.

## Noticed beyond my task

`scripts/run-tests.mjs` socket-path length failure under the required long TMPDIR is recorded in the builder report, not independently reproduced here. Suggested owner: test-runner maintainer.

Disposition: ACCEPT