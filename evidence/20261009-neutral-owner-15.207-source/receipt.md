# ROW 15.207 — bounded source-stage landing receipt

Recorded UTC: 2026-10-09T19:58:53Z

## Scope and approval
- Source-stage only; ROW 15.207 remains OPEN pending the native Codex session proof packet. No completion claim and no engine queue CAS.
- Repository/target: `/Users/ray/dev/shepy`, branch `shepy`; authorized push pair `shepy origin/shepy`.
- Pre-merge target: `2a240fade0938afd91b1ac96565be9f0930cd493`; local branch, tracking ref, and live `origin/shepy` were pinned at this SHA immediately before merge.
- Candidate: `7a8a3604188822eed4d26a017ec435d55420c0a1`, branch `spawn/neutral-owner`, worktree `/Users/ray/dev/shepy-wt/neutral-owner`.
- Engine packet approval: root exact-source **ACCEPT** plus independent Luna **ACCEPT** (`luna-neutral-owner-format-recheck.json`, as named in packet). Recomputed base-to-candidate binary diff SHA-256 `00d3998fc3e74b049de7d6369e5a101d5564792fb20e38232099c441b76e4686`, matching packet.

## Fresh gates
TMPDIR parent `/private/tmp/neutral-owner-bailiff/htmp` was created; each test/gate used an isolated child TMPDIR. `SHEPY_PROFILE` was unset for the corrected gates after the matched discriminator proved the five apparent reconnect failures were an environment leak from this seat's construction shell.
- Initial `pnpm check` with `SHEPY_PROFILE` set: EXIT=1, 727/732; retained as env-artifact evidence (`pnpm-check-with-profile.log`). The same five reconnect/ownership tests passed when run with `env -u SHEPY_PROFILE` and the matched invocation (`matched-flags-profile-cleared.log`, 66/66, EXIT=0).
- Fresh `env -u SHEPY_PROFILE ... pnpm --config.verify-deps-before-run=false check`: EXIT=0, 732/732 across 65 files. Biome reported one retained untouched-base unused-import warning in `src/observability/profile-selector-scope.ts` (`SelectableAgent`). Engine explicitly accepts the surviving reconcile-host guard mutant as named in the packet. The candidate's changed-source suite reported no candidate-caused failures.
- `pnpm --config.verify-deps-before-run=false build`: EXIT=0 (`build.log`). Build reports `gitSha unknown (dirty tree)` because the candidate worktree contains the pre-existing untracked `node_modules` symlink; no source files were modified by the gate.
- `pnpm --config.verify-deps-before-run=false pack --pack-destination /private/tmp/neutral-owner-bailiff/package`: EXIT=0 (`package.log`); tarball output remained outside the repository.
- Focused changed-file suites (profile delivery, demand, diagnose, SQLite migrations, CLI): EXIT=0, 160/160 (`focused-160.log`).
- `pnpm --config.verify-deps-before-run=false typecheck`: EXIT=0 (`typecheck.log`).
- Engine's both-sides matched matrix is retained in the packet: candidate direct test 66/66 (serial x3 plus profile-cleared run); destination direct 3/63; destination pnpm full 720/723 with wake-timing trio; claude-hook race classified as load-flake after three serial passes. Raw local gate logs and SHA-256 manifest are adjacent.

## Merge and journal proof
- Merged with `git merge --no-ff --no-edit 7a8a3604188822eed4d26a017ec435d55420c0a1`.
- Merge commit: `14cda6ae7b3dda329307e7374299bc0c9b443a60`, parents `2a240fade0938afd91b1ac96565be9f0930cd493` and `7a8a3604188822eed4d26a017ec435d55420c0a1`.
- Candidate ancestry of merge HEAD verified.
- `drizzle/meta/_journal.json`: 12 total entries, idx 0–11; source-stage entry idx 11 is `0011_real_lenny_balinger`.
- No live migration, daemon, profile claim, hook activation, or product activation was run.
- Pre-existing unrelated root checkout modifications were preserved.
