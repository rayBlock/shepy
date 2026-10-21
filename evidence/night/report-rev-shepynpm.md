# Review: SHEPYNPM (rev-shepynpm)

**ACCEPT** for the npm lookup change. The full suite passes with a 60 s timeout; at the default 5 s timeout it is not green on this Mac under load, for reasons that do not come from this diff.

- Candidate: `night/shepynpm` at `dcd7008` (`scripts/run-tests.mjs`, `test/unit/run-tests.test.ts`, `evidence/night/report-shepynpm.md`). Base: `07d5735`, the parent. Reviewed in a detached worktree; my branch `night/rev-shepynpm` is unchanged.
- Environment: Node v26.5.0 from Homebrew (`/opt/homebrew/Cellar/node/26.5.0/bin/node`), pnpm 11.9.0, `pnpm install --frozen-lockfile` from the candidate's lockfile. Run with `env -i` and a fresh `HOME` and short `TMPDIR` under `/tmp/rnpm.XXXX`. `CLAUDECODE`, `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` were absent.

## Findings

**No defects in the lookup.** Checked against the diff and by running it.

1. **Lookup order (scripts/run-tests.mjs:80-96).** PATH is never read. The candidates are the prefix of the real node path, then the prefix as invoked, then the `npm` launcher beside each node. Each candidate is accepted only if its realpath ends in `npm/bin/npm-cli.js`. On this Mac `trustedTools()` returns `/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js`, reached through the Cellar launcher `Cellar/node/26.5.0/bin/npm`. Result: correct npm, no PATH lookup.
2. **Refusal names every place (scripts/run-tests.mjs:103-111).** Each missing or non-npm candidate is listed with its reason. The "no npm anywhere" test pins all four candidates.

**Test count (test/unit/run-tests.test.ts:235-398).** The brief expects 9 new tests to fail on `main`. Measured: **5 of 9 fail on `main`** (Homebrew layout, launcher symlink, real-node-wins, no-npm-anywhere, this-machine's-node). The other 4 pass on `main` by design: classic layout, symlink prefix, unrelated-PATH control, and launcher shim. They pin behaviour that `main` already had. This matches the builder's report (line 37). Not a defect; the brief's wording is wrong.

**Suggestion (not blocking): the package check is a suffix match.** `isNpmPackageCli` (scripts/run-tests.mjs:97-100) accepts any path ending in `npm/bin/npm-cli.js`. This is only reachable for launchers beside the trusted node, so the risk is small. A stricter check would also compare the path to the node's own prefix. Owner: shepy test-tooling owner.

**Suggestion (not blocking): the suite is not green at default timeouts on this Mac.** See the checks below. Owner: whoever owns the test timeout budget.

## Checks

| Check | Result | Wall | Load at start |
|---|---|---|---|
| `tsc --noEmit -p tsconfig.json` (candidate) | exit 0 | — | — |
| `biome check` on the two changed files | exit 0 | — | — |
| `run-tests.test.ts` on `main` script + candidate test (vitest direct) | 9 failed, 10 passed (19); the 5 failures listed above | — | — |
| `run-tests.test.ts` on candidate | 19 of 19 pass | ~7 s | — |
| Full suite, candidate, default timeouts, run 1 | 7 failed, 1115 passed (1122); all "Test timed out in 5000ms" | 116 s | 41.6 |
| Full suite, candidate, default timeouts, run 2 | 19 failed, 1103 passed; timeouts plus one assertion in a hook test | 132 s | 7.5 |
| Three integration files alone, candidate | 2 failed, 298 passed; timeouts | 90 s | 6.0 |
| Full suite, candidate, `--testTimeout=60000 --hookTimeout=60000` | **73 of 73 files, 1122 of 1122 tests pass** | 105 s | 11.2 |

## Load control for the default-timeout failures

`main`'s script cannot run on this Mac at all: it throws `required test tool npm not found with node: …/Cellar/node/26.5.0/lib/node_modules/npm/bin/npm-cli.js`. So I ran the `main` suite through a copy of the Cellar node placed in a scratch prefix with a classic `lib/node_modules/npm` layout. This lets the old script run. Result: 7 failed, 1115 passed; 3 failures were 5 s timeouts in `claude-hook`, `claude-profile-demand-validation` and `profile-delivery`, the same files as the candidate. The other 4 were the new Homebrew tests that `main` cannot satisfy. The timeout failures therefore occur without this diff. The integration tests do not call npm (`grep` finds no `npm` use in `test/integration` apart from a comment in `claude-hook.test.ts`), so the npm change does not touch their timing. The "database is locked" and "herdr socket gone" lines are test-expected noise.

Failures came at load 7 as well as 41, and each run failed a different set. Raising the timeout clears them. The failures are load-correlated timeouts in the default 5 s budget, not a logic result from this change.

## Not checked

- Real nvm, mise or official-installer layouts. The tests cover them with fixture layouts only.
- The `herdr-plugin-package.test.ts` PATH `npm` call the builder noted (report line 66) is outside this change.

## Noticed beyond my task

- `herdr-plugin-package.test.ts` calls `execFileSync("npm", …)` from the caller PATH (builder's report, line 66). Consequence: outside the entry, it uses whatever npm is first. Suggested owner: shepy test-tooling owner.

## Cleanup

Temporary detached worktrees (candidate and base) and the copied node control prefix live under my scratchpad and were removed after the run.

rev-shepynpm done: /Users/ray/dev/shepy-wt/night-rev-shepynpm/evidence/night/report-rev-shepynpm.md
