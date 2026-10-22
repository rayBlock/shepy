# SHEPYSTREAM carry

PARTIAL. The accepted stream fixes are carried onto `fb15e54`. TypeScript, Biome and 41 focused tests pass. The full suite has two 5-second timeouts; the base has one different timeout. The reviewer's dedup note is listed below, not patched. Live acceptance remains unrun.

Branch: `night/shepystream-2`. Worktree: `/Users/ray/dev/shepy-wt/night-shepystream-2`. Tested runtime tip: `b5f9bfe`. Review: `e3f050c` (ACCEPT WITH FIXES). Machine-verified only. Next owner: Shepy seat for recheck and landing; no installation or push.

## Carry acceptance
Carry the named commits in order with `-x`, never rebase. Preserve main's SHEPYGREEN notice-test changes and add the refresh and subscription acknowledgements. Apply the dedup note only if safely one-line, otherwise list it. Run TypeScript, Biome, the four regressions, notice correctness and a locked full suite against exact base `fb15e54`, using Node 24 first on PATH and fresh private environments. Update and commit this report before 19:45 local.

## Carry and conflict resolution
| Original | Carried commit |
| --- | --- |
| `961ca2c`, initial stream fix | `49d3305` |
| `1b3f9d7`, recovery correction | `b5f9bfe` |

Both have the `cherry picked from commit` footer. Both named commits were necessary: main lacked the initial implementation, and the specified notice conflict belonged to that commit. The old worktree and branch remain unchanged.

The notice-test diff against `fb15e54` is exactly three additions: one `await f.refresh()` and two `options?.onSubscribed?.()` calls. Main's SHEPYGREEN edits remain intact; the removed `started = performance.now()` assignment was not restored. Seven core source/test files are blob-identical to `1b3f9d7`; socket-client and delivery-service merges retain main's changes plus the accepted stream patches. No new production behavior or test cases were added in this carry.

**Dedup note retained, not a safe one-line fix.** If a genuinely new turn has flushed neither its user nor final record after the settle retry, `sameRecordedTurn` can mistake it for the prior turn. Removing that guard in one line would restore the known duplicate-outcome defect. Distinguishing these identical transcript observations requires additional turn evidence or a policy change, not an unverified one-line heuristic. This LOW note remains for the seat if it wants a separate fix.

## Checks on the carried tip
Every test and gate used `env -i`, fresh mode-0700 HOME and TMPDIR, and no Claude messaging variables. PATH starts with Node 24.18.0, followed by pnpm 11.9.0. TypeScript 6.0.3, Biome 2.5.1 and Vitest 4.1.9 were reused from local dependencies; nothing was installed. pnpm's fresh-home dependency check was warning-only.

| Check | Result and wall time |
| --- | --- |
| TypeScript | Passed; 8.12 s |
| Biome | Passed; 2.81 s |
| Four regressions, notice correctness, existing watcher unit tests | 41 passed; 20.48 s |
| Carried `pnpm check` under `lockf -k /private/tmp/shepy-full-suite.lock` | 1,172 passed, 2 failed; exit 1; 91.49 s |
| Exact `fb15e54`, same locked command | 1,169 passed, 1 failed; exit 1; 72.68 s |

Carry reds: `profile-subscribe` source-CLI cost case and `herdr-plugin-package` runtime packaging case, both 5-second timeouts. Base red: `notice-correctness`, new-turn-during-retry via snapshot, also a timeout. All three exact cases passed three isolated runs on each tree. Those controls do not erase the full-run reds or prove their causes. Both formerly failing Codex tests pass on this base and carry. All four stream regressions and notice correctness pass in the carried full run.

Private scratch and logs: `/private/tmp/ss3-QGN535`. Verification logs: `carry-full.log`, SHA-256 `66640249eb07376f1032508b254352ef41a25de169ce3cc27ca3e307e97716b4`; `base-full.log`, SHA-256 `cb54999511a432e35e716ee2358b49fb0f9739dbd3d95d3feb8db7d9af1f9a64`. Earlier build and correction evidence remains in the original commits' reports.

## Cost, limits and leftovers
- Focused gate, `/usr/bin/time -lp`: 20.48 s wall, 1.56 s user CPU, 0.90 s system CPU, maximum child RSS 174,702,592 bytes, including Vitest rather than an isolated daemon. Peak fixture DB/sidecar disk is null because it was not sampled before cleanup. Retained scratch is 386 MiB logical; the new worktree's copied dependencies are 377 MiB. No long-history or live-daemon performance claim is made.
- Carry-only native Pi usage snapshot at 18:16, 13 assistant records, `gpt-6.1-sol`: input 26,250; cache-write 0; cache-read 4,101,888; output 8,025; summary null (not separately recorded). These are snapshot totals, not final usage. No worker model was started.
- No Haiku trial, live profile, subscription or tab was created. `engine-coordinator` and the live daemon were untouched. The original pre-ACK fixture trial numbers remain withdrawn as acceptance evidence. Ignored dependencies and private scratch remain for recheck. The fresh worktree has no configured Husky bootstrap; hook configuration was not changed or bypassed.

## Noticed beyond my task
Full-suite timeout variability remains for the Shepy seat. The listed dedup ambiguity needs separate scope if pursued; it was not silently changed during this mechanical carry.

shepystream done: /Users/ray/dev/shepy-wt/night-shepystream-2/evidence/night/report-shepystream.md
