# SHEPYCRASH dependency prerequisite

Resolved: the seat explicitly authorized removing only this worktree's symlink and running `cp -cR /Users/ray/dev/shepy-wt/socket-test-flake-20261020/node_modules ./node_modules`. Applied without download, package-manager install or mutation of the shared target. The subsequent correction uses `/private/tmp/shepy-full-suite.lock` with full-suite starts below load 15.

The implementation, targeted behaviour tests, built-CLI fixture proof, typecheck, build and root package check pass. The supported test runner refuses the reused `node_modules` symlink because Vitest resolves outside this worktree (`scripts/run-tests.mjs: resolveVitest`). Normal commit hooks call that runner, so committing without resolving this prerequisite would fail; no hook bypass is proposed.

Question: may I copy the already-installed local dependencies into this worktree (no package-manager install, download or change to the shared source)?

1. Recommended: authorize a local dependency copy, then run the full checks and normal commit hooks under `/private/tmp/shepy-full-suite.lock` when load is below 30.
2. The seat supplies an in-worktree dependency tree; resume checks and commit when available.
3. Keep the partial candidate and report for the seat, with full-suite validation and commit blocked. Do not bypass hooks.

Evidence: `/private/tmp/shepycrash.TJ4Ogt/supported-runner-control.log`. Two full-gate attempts exited 75 on busy locks before starting; no full suite has completed. The failed initial pnpm-exec invocation attempted automatic dependency verification, but the dependency-install subprocess aborted before removal or install. Later commands explicitly disable that automatic behaviour.
