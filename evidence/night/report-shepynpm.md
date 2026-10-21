# shepynpm report

**BUILT.** `node scripts/run-tests.mjs` now finds the npm that ships with this Mac's Homebrew node and runs the full suite to its normal end. Under load, 10 tests hit the 5000 ms default timeout (details below). With the timeout raised on the command line only, all 1122 pass.

Brief: `/Users/ray/dev/agent-factory/evidence/20261021-night/brief-SHEPYNPM.md`. Branch `night/shepynpm`, worktree `/Users/ray/dev/shepy-wt/night-shepynpm`. Not pushed.

## Acceptance block (copied before coding)

```acceptance
{"kind":"build","real_use":"On this Mac (Homebrew node 26.5), node scripts/run-tests.mjs runs the full Shepy suite to its normal end.","unhappy_paths":"npm missing entirely; a different npm earlier on PATH than the one shipped with node; node invoked through a symlink","attack_tests":[{"probe":"A fixture layout where only an unrelated npm exists on PATH: the script refuses rather than using it.","good_input_control":"Homebrew-style layout (bin symlink into Cellar, npm under prefix/lib/node_modules): found."},{"probe":"No npm anywhere: clear refusal naming each location tried.","good_input_control":"Classic layout next to the real node path still works."}],"running_cost":{"time":"suite wall","cpu":"same","memory":"same","disk":"none","tokens":"null","expected":"unchanged"},"ray_check":"none; internal"}
```

## Cause and change

On this Mac the real node is `/opt/homebrew/Cellar/node/26.5.0/bin/node`. The old lookup looked for npm at `Cellar/node/26.5.0/lib/node_modules/npm`, which does not exist. Homebrew keeps npm at `/opt/homebrew/lib/node_modules/npm`, and `Cellar/.../bin/npm` is a symlink to it.

`scripts/run-tests.mjs` now tries four places, in order (new exported `npmCandidates`):
1. `<prefix>/lib/node_modules/npm/bin/npm-cli.js` for the prefix of the node's real path (classic, nvm, mise, official installers).
2. The same for the prefix of the node path as invoked (Homebrew bin symlink).
3. The `npm` launcher beside the real node.
4. The `npm` launcher beside the invoked node.

A launcher is accepted only if it resolves to a file ending in `npm/bin/npm-cli.js`. A shell shim beside node is refused. PATH is never read, so a different npm earlier on PATH cannot be picked. The refusal names every place tried, each marked missing or "resolves to X, not an npm package". The chosen path is the physical `npm-cli.js`, as before.

Not checked: nvm, mise and the official installer on real installs. They are covered only by fixture layouts (classic prefix layout). On this Mac, `process.execPath` is already the real path, so "invoked through a symlink" is tested by passing the symlink path to `trustedTools`, not by launching node through a link.

## Acceptance results

| Probe | Result |
|---|---|
| Real use: Homebrew node 26.5 runs the entry | Reproduced the failure first (`required test tool npm not found with node: …/Cellar/node/26.5.0/lib/…`). Now the suite runs to its end. |
| Only an unrelated npm on PATH | Refused, and the message does not name the PATH directory. Control: Homebrew layout is found with that same PATH. |
| No npm anywhere | Message contains all four candidate paths. Control: classic layout found. |
| Node invoked through a symlink | npm beside the link is found. The real node alone is refused when its own prefix has no npm. |
| Wrong npm earlier | The real-path location wins over a different npm at the invoked prefix. |

I ran the new tests before the change: 9 failed (5 new, 4 older tests that call the real `trustedTools()`). After the change, `test/unit/run-tests.test.ts` is 19 of 19 green, 9 of them new.

## Checks

| Check | Result |
|---|---|
| `tsc --noEmit` | clean, 7 s |
| `biome check` on the 2 changed files | clean |
| `test/unit/run-tests.test.ts` through the entry | 19/19, 1.3 s |
| Full suite through the entry, default timeouts | **10 failed, 1112 passed** of 1122 (6 files), 91 s wall |
| Rerun of those 6 files, default timeouts | 1 failed, 299 passed (a different test), 89 s |
| Full suite, `--testTimeout=60000 --hookTimeout=60000` on the command line | **1122/1122 pass**, 73 files, 90 s wall |

Failures are kept, not erased. All 11 are "Test timed out in 5000ms", in tests that spawn processes or sockets (claude-hook, profile-delivery, profile-diagnose, claude-socket-identity, claude-profile-demand-validation, herdr-plugin-package's `npm pack`). Load average was 13 to 26 from other agents on this Mac. Different tests timed out in the rerun, and nothing failed on an assertion. I take this as environment load, with the 60 s control as the evidence. A quiet-machine run at default timeouts is not done. I did not change any timeout in the repo.

Pre-fix comparison is not possible: the entry could not start before this change.

Cost: no change expected, and none measured. The change adds a few `existsSync` and `realpathSync` calls once per run. Suite wall time was about 90 s in both full runs.

Logs: `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-shepynpm/626ff4c2-06b9-4011-b535-6f656e20f604/scratchpad/full/` (suite.txt sha256 prefix bedfdfa121ec0930, suite-t60.log 0cda3fc6e69cba3a). Environment for every run: CLAUDECODE, CLAUDE_CODE_MESSAGING_SOCKET and CLAUDE_CODE_MESSAGING_TOKEN unset, fresh HOME and TMPDIR under `/tmp/snpm.XXXX`.

## Limits

- The worktree had no `node_modules`. Installing was not granted, so I APFS-cloned `/Users/ray/dev/shepy/node_modules` into the worktree (gitignored, not committed). `pnpm-lock.yaml` is identical to main.
- `pnpm lint` and `pnpm format:check` could not run: pnpm starts a dependency check that fails under a fresh HOME. I ran `biome check` directly on the 2 changed files only.

## Noticed beyond my task

- Under a loaded machine the 5000 ms default test timeout makes the full suite flaky (see above). A seat decision is needed on whether tonight's full-suite gates run with a longer timeout or only on a quiet machine. Owner: factory seat.
- `herdr-plugin-package.test.ts` calls `npm` from the caller PATH (`execFileSync("npm", …)`). Inside the entry that PATH is the trusted bin, so it works, but outside the entry it uses whatever npm is first. Owner: Shepy maintainer, low.
