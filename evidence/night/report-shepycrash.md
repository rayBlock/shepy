# SHEPYCRASH (15.367)

PARTIAL pending full-suite validation. Builder: shepycrash. Base: `ef30d4e`, branch `night/shepycrash`. Implementation and focused proof pass. The seat authorized a local APFS clone of the existing locked dependencies, which is now present. No package-manager install, download, live install or landing occurred.

## Acceptance block (recorded before implementation)
Authority: [brief](/Users/ray/dev/agent-factory/evidence/20261022-day/brief-SHEPYCRASH.md) as replaced by [acceptance amendments](/Users/ray/dev/agent-factory/evidence/20261022-day/acceptance-check-SHEPYCRASH.md).
1. Extend existing early takeover: daemon-owned, one-second Herdr `pane.get` verifies recorded pane and terminal, valid `herdr:claude` native session equal to claimant and different from owner; legacy owners, errors and mismatches refuse; retain generation CAS and existing closed-pane rule.
2. Connect failure before any messaging frame releases the wake reservation; post-connect ambiguity retains it. Pending details remain available once to the next claim.
3. Refused UserPromptSubmit claim emits one capped model-context line naming owner, claim time and claimable time through ExpectedHookError; Stop never injects the refusal.
4. Daemon console lines carry ISO timestamps.
5. Prove behaviour through hook CLI or daemon RPC, including negative Herdr proof, stale socket file, once-only pending delivery, fencing and built CLI against fixture daemon. Read-only real Herdr check must show a restarted Claude's new native session in its reused pane; otherwise stop and report.
6. No schema, install, live daemon or live Shepy-home changes. Isolated clean-environment tests and one locked full gate below load 30. Independent review and installation belong to the seat.

## Acceptance results
- Extended the existing daemon takeover callback, not a second ownership path. Exact Herdr pane, terminal, agent, source, native-session kind and session value are checked. Missing identity, old or mismatched sessions, malformed owner metadata, legacy owners, unavailable Herdr and its one-second timeout refuse. The token-generation fence remains after the await.
- Two fixture Claude processes share one fake pane. SIGKILL leaves the first owner intact; replacement claims immediately and receives pending details once. With unreachable Herdr it remains refused. A returning old prompt and SessionEnd cannot evict the replacement. The delayed-proof test now exercises daemon RPC and cannot evict a refreshed owner generation.
- A real stale Unix socket survives fixture SIGKILL and passes pathname validation. Its actual failed connection now deletes the reservation, leaving pending details with attemptCount 0; the next hook claim delivers and acknowledges once. Timeouts and post-connect failures retain their no-retry fence.
- Refused prompts emit owner, claim time and claimable time in one bounded model-context line, alongside the existing user warning. Refused Stop recovery injects nothing. Console output is timestamped once at the daemon entrypoint, including multiline messages.
- Built CLI against a migrated fixture daemon passed in 1.22 s: takeover 180 ms, new token, pending delivery and acknowledgement once, old SessionEnd fenced, another pane refused, unavailable Herdr refused. No live daemon or live Shepy home was used.
- Read-only real `pane.get` returned `w3J:p0C`, terminal `term_65e180a4d721d79`, and valid `herdr:claude` session `9e3a36cf-8aca-44ed-ae93-df522d0d9871`, matching the restarted seat documented in COLDSEAT. This is a post-restart readback against existing restart evidence, not a newly observed before-and-after restart. The old trial pane `w3J:p1CN` is gone; no pane was changed.

## Checks and retained failures
All test commands started with `env -i`, fresh physical HOME and TMPDIR, and none of the three forbidden Claude variables. Existing local dependencies were reused by symlink; later pnpm commands disabled automatic dependency verification.
- Four regression tests failed before implementation for the four intended missing behaviours, then passed. Latest focused acceptance run: 23 passed, exit 0, 10.74 s. Earlier discriminating controls: 31 passed, exit 0, 31.79 s.
- `bunx --no-install tsc --noEmit`: exit 0, 9.21 s. `pnpm build`: exit 0, 15.64 s. `pnpm package:check`: exit 0, 21.32 s, 334 packaged files. Changed-file Biome formatting passed; its optional-chain warning was corrected afterward.
- First broader focused run retained 16 failures: changed refusal and takeover expectations, the adapter's changed connect outcome, and three default-five-second timeouts. Expectations were updated without weakening the behaviour; a duplicate stale-token test and obsolete refused-connect case were removed. The affected timeout cases passed discriminating controls; their original failures are not erased or claimed pre-existing. A second broader run hit the harness's 120-second limit without a result; no processes remain under my retained runtime roots.
- Full-gate attempts exited 75 on busy locks before starting tests. Ray's amendment changes the lock to `/private/tmp/shepy-full-suite.lock`; no old-lock waiter remains.
- The supported `pnpm test` entry refuses the shared dependency symlink because Vitest resolves outside this worktree. This also blocks normal commit hooks. No runner guard or hook was bypassed. The first pnpm invocation attempted its automatic install check but aborted before removal or install; subsequent commands explicitly disable that behaviour.

## Cost and provenance
Scratch: `/private/tmp/shepycrash.TJ4Ogt` (raw logs, proof driver and runtime-root index; 78 KB at measurement). Node 24.18.0, pnpm 11.9.0, Vitest 4.1.9; existing locked local dependencies, no download. Built fixture: 188,544 bytes including SQLite sidecars, driver RSS 85 MB, CPU 0.126 s user and 0.060 s system; BSD time reports command-and-child CPU 0.96 s user and 0.30 s system and maximum RSS 86 MB, not summed concurrent tree memory. No real long idle wait was performed. Native Pi usage through 68 completed assistant calls: input 131,777; cache-write 0; cache-read 6,565,120; output 33,943; summary null (not separately metered). These are this builder's retained-context totals, not a runtime benchmark. Production startup and ongoing resource deltas remain null because nothing was installed.
Proof log SHA-256: `3172ebcb7364473fbb29dc9e9efe3541d6ce59a1c21db19d92c3dd0caa685a48` (`built-proof.log`).

## Limits and next owner
The dependency question in [question-shepycrash-dependencies.md](question-shepycrash-dependencies.md) is resolved by the seat's explicit local-copy grant. The old symlink alone was removed and the same locked install was cloned with `cp -cR`; its shared target was unchanged. Full-suite completion and the code commit are the next checks. Local `node_modules` and generated `dist` are ignored and uncommitted. Main still reads `ef30d4e`; SHEPYTRIM has not been integrated here, and its documented conflicts remain for the seat. An unprompted restarted session still never claims; timeout or post-connect ambiguity still intentionally uses the one wake attempt. Next owner: the seat for independent review, integration and any Ray-approved installation.

## Noticed beyond my task
- `scripts/run-tests.mjs` rejects Vitest outside the repository, including the dependency symlink used by these worktrees. This prevents supported checks and normal commit hooks until dependencies are physically local. Suggested owner: the Shepy seat; no runner-policy change was made.
