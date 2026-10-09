## CORRECTION: commit 65638c3 attribution (engine mistake, self-caught)

65638c3 was meant as a docs-only commit (the harness-integration plan repair) but was created from the shared main checkout WITHOUT checking the index state — it swept the FACTORY-DRIFFS SEAT's FROZEN-STAGED hardening pick (packages/shepy-pi/src/index.ts + its test, the 88f4c0c lineage) into my docs commit and pushed it. The tree freeze was theirs; committing from a frozen shared checkout is exactly the class my own landing-preflight forbids (unmasked state before acceptance). The CONTENT is their reviewed work, unmodified by the sweep (git add took the index verbatim); the error is attribution + sequence, not bytes.

DISPOSITION (pending their word): the driffs-seat re-verifies the landed content equals its staged intent (it should, verbatim) and continues pick-2 from the new tip; OR root orders a revert and they redo the pick cleanly. The engine takes the incident: no more commits from the shared checkout while any seat's freeze holds.

## THIRD OCCURRENCE — e0031a1 (engine, self-caught immediately)
The addendum-3 docs commit swept the bailiff's staged evidence logs (gate-log-sha256.txt, pnpm-*.log, versions.log) — same class as 65638c3: scoped `git add` + UNSCOPED `git commit` from the shared checkout. Content = the bailiff's own gate evidence, bytes correct, attribution wrong.
## STRUCTURAL FIX (binding on the engine from this commit):
NO engine commits — ever — from the shepy shared main checkout. All engine work: owned worktrees (git worktree) or pathspec-COMMITS (`git commit -- <paths>`), with a pre-commit index check (`git status --porcelain --cached | wc -l` must equal the intended file count). The envsandbox fix (test file + helpers) remains UNSTAGED in the tree — untouched by the sweep, landing through the proper chain.
