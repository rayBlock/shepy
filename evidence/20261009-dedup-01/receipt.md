# Landing evidence — ROW 15.215 B-slice OpenCode outcome dedup

Recorded UTC: 2026-10-09T18:15:09Z

## Pins and approval
- Repository: `/Users/ray/dev/shepy`, target branch `shepy`; push target `origin/shepy`.
- Pre-merge HEAD: `52718df459816a2b3a4e9c2e4cd1090f2ed95cec` (matched `origin/shepy`).
- Frozen candidate: `b015799c5ecfb8fd5fbf45a8e1596940bca98481`, branch `spawn/dedup-01`, worktree `/Users/ray/dev/shepy-wt/dedup-01`.
- Approved exact-SHA hostile: **SURVIVES on `b015799`**; `hostile-2.md`.

## Fresh gates and attribution
TMPDIR parent `/private/tmp/dedup-bailiff/htmp` was created first. Full logs include original command exits:
- `full-suite.log`: serialized `./node_modules/.bin/vitest run --pool=forks --maxWorkers=1` — EXIT=1; 64 files / 718 passed, 1 file / 5 failed (723 total). All five are `shepy-pi-extension` reconnect/ownership-loss UI tests producing active-owner lease rejection for `unknown`.
- Engine's both-sides resolution classifies this reconnect/ownership-loss failure class as pre-existing on untouched `shepy@52718df`; its fresh targeted main run was 3 failed / 63 passed, same test class (engine cited `/private/tmp/shmain-lm`; that path is a directory in this session and is not represented as a copied log).
- `focused-suites.log`: serialized SQLite migration + profile delivery suites — EXIT=0, 2 files / 76 passed.
- `typecheck.log`: `./node_modules/.bin/tsc --noEmit -p tsconfig.json` — EXIT=0.
- `drizzle-check.log`: `./node_modules/.bin/drizzle-kit check --config drizzle.config.ts` — EXIT=0.

The five full-suite reds are recorded as the engine-classified pre-existing reconnect-UI base class, not hidden or presented as green. Candidate's migration/delivery focused suites, typecheck, and migration graph check are green.

Engine's follow-up both-sides classification directs proceeding: seat-run full suite on the merged tree at `/private/tmp/dedup-seat-full.log` reports 720/723, EXIT=1, with the three 500ms wake-timing tests (agent.done, agent.idle, blocked-bypasses-batch); engine classifies these as timing-flaky under serialized load, not this delta. The three `gitSha:null` assertion failures from the evidence commit hook are classified as environment-dependent unstamped-test-tree failures; the stamp test passes 1/1 on the stamped checkout per engine verification. Together the accepted full-suite remainder is the five pinned reconnect-base failures plus the classified environment-dependent flakes. The merged-tree full-suite log is preserved as `merged-tree-full-suite.log`; the prior hook summary is `post-merge-commit-hook.txt`.

## Merge and journal proof
- Approved merge: `git merge --no-ff --no-edit b015799c5ecfb8fd5fbf45a8e1596940bca98481`.
- Post-merge HEAD / merge commit: `9bf18cfc6d49cc7c592a4f29d04e18fe1cc69ba5` (parents `52718df459816a2b3a4e9c2e4cd1090f2ed95cec` and `b015799c5ecfb8fd5fbf45a8e1596940bca98481`).
- `git merge-base --is-ancestor b015799c5ecfb8fd5fbf45a8e1596940bca98481 HEAD` exited 0.
- `drizzle/meta/_journal.json` now has **11 entries**, sequential idx 0–10; new entry idx 10 is `0010_luxuriant_black_bird`.
- Pre-existing unrelated root checkout modifications were preserved.
