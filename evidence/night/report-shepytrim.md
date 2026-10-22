# SHEPYTRIM — row 15.363

Builder: shepytrim. Branch: `night/shepytrim`. Base: `7a7a3afa47c205bb5c0ac7ba0478eafaeaa44c2c`.
Initial code: `e3d8e38`; initial report: `331bacc`. The F1 correction is the branch HEAD containing this updated report.
**BUILT:** F1 compatibility is fixed and machine-verified. Independent recheck, installation and Ray's live wake check remain open.

## Scope and review correction

The [brief](../../../../agent-factory/evidence/20261022-night/brief-SHEPYTRIM.md), [acceptance check](../../../../agent-factory/evidence/20261022-night/acceptance-check-SHEPYTRIM.md) and [independent review](../../../night-rev-shepytrim/evidence/night/review-SHEPYTRIM.md) govern. The original acceptance block remains in the initial code commit's report history.
The unused demand runtime, publisher and lookup RPCs, capability and rendering remain removed. Rows 5 through 8 and all database definitions remain unchanged.
The CLI flag still produces one stderr-only deprecation note, including when repeated. The first implementation replaced its old test block with one flag test.

**F1 follow-up:** only production file `src/observability/schemas.ts` changed. `acceptedSourceKinds` on claim and `sourceKinds` on lease now accept their old optional array shape for one release. Runtime ignores both; source selection, owner metadata and the removed capability were not restored. Other unknown fields remain refused.
One new daemon RPC test first failed with `Invalid RPC params`, then passed. It verifies old-shape re-claim, old-shape lease, plain controls, unchanged stored owner kinds, delivery of agent outcomes even with a non-agent-only source list, token fencing and absence of the removed capability.
The optional review suggestion is also covered: one existing malformed-lease test now sends a missing excerpt first and a valid snapshot with non-agent `sourceKind` second. Neither reply is delivered or acknowledged.
The reviewer's built-daemon `compat.mjs` probe passed: old Pi claim and lease succeed, plain lease succeeds, stored owner kinds remain agent-only, and the historical non-agent obligation remains pending.

## Follow-up checks

All tests and gates used `env -i`, fresh private HOME and short TMPDIR, with the three Claude variables absent. Tools: Node 24.18.0, pnpm 11.9.0, TypeScript 6.0.3, Vitest 4.1.9 and Biome 2.5.1. The designated dependency symlink and disabled pnpm automatic dependency repair were retained.

| Check | Result |
| --- | --- |
| New RPC regression | Red before schema fix; green afterward, 1.04 s. |
| Final targeted RPC, malformed-lease and flag tests | 3 passed, 3.09 s. |
| Root, Pi and Herdr plugin typechecks | Passed; 6.78 s, 2.09 s and 0.61 s. |
| Biome; build; root package | Passed; 0.63 s, 3.22 s and 4.43 s. |
| Reviewer's built compatibility probe | Passed, 1.08 s. |
| Broader focused run | 274 passed and 2 timed out, 57.34 s; failures retained. |
| Those two timeout cases, isolated control | Both passed, 1.79 s; the earlier red is not erased. |
| Canonical pnpm check, requested lock | Exit 1 before tests: unchanged linked-Vitest path guard, 6.79 s. |

The two focused timeouts were the absent or invalid socket claim case and the refused-connect retry case in `claude-hook.test.ts`, each exceeding five seconds. No assertion or timeout was relaxed.
No full suite was rerun in this bounded correction: production changes stayed within `schemas.ts`. The canonical check used `lockf -k /private/tmp/shepy-full-suite.lock` and stopped before executing tests.

## Retained original removal proof

Built CLI fixtures exercised prompt, Stop, acknowledgement and inbox operations through real sockets and migrated SQLite. Main and candidate hook stdout matched byte-for-byte. The new hook also worked against the base server without demand capability.
Two actual built daemon processes started with empty and seeded legacy databases and invalid leftover allowlist JSON. Removed RPCs refused while ordinary reads worked. Herdr discovery used an owned fixture, never live Herdr.
A Pi API fixture claimed, leased a real stored outcome, emitted context and a visible wake, and acknowledged only after the consumption witness. No live Pi or Claude model turn was exercised.
Schema, migration runner, migrations and migration tests remain unchanged. SQLite `.schema` output for the kept tables and indexes matched byte-for-byte: 2,505 bytes, including the source check constraint. Production database size is unknown; it was not opened.
Current acceptance grep: 145 matches, comprising 127 kept database references and 18 compatibility shim or test references. The additional allowed paths are now `schemas.ts` and the new RPC test. No demand runtime is restored; historical evidence was not rewritten.
Original full suites under the factory lock: baseline 1,285 tests with 43 failures, candidate 1,142 with 4 failures. Runtime was 69.69 s and 55.11 s; including lock waits, 1,092.99 s and 2,815.95 s. The independent reviewer subsequently reproduced baseline timing misses and classified the candidate timing finding as pre-existing load flakiness. Original failures remain preserved.

## Removal and cost

Current aggregate, excluding this report: 31 files changed, 233 insertions and 6,640 deletions. Source net removal is 1,757 lines; test net removal is 4,641 lines. Ten whole files remain deleted: four source files totaling 1,151 lines, five test files below, and the seven-line allowlist document.

| Deleted test file | Lines |
| --- | ---: |
| test/integration/claude-profile-demand-validation.test.ts | 1,409 |
| test/integration/profile-demand.test.ts | 1,317 |
| test/unit/demand-eligibility-promise-breach.test.ts | 726 |
| test/unit/profile-demand-cli.test.ts | 60 |
| test/unit/profile-demand-ingress.test.ts | 248 |

Original shared-source deletion exceeded the estimate because hook validation and rendering alone removed 362 lines. F1 adds nine production lines and one RPC test; it adds no per-profile runtime state. Original ten-call hook medians were 338.02 ms on opted-in main and 181.55 ms on the candidate; these are shared-host smoke timings, not a capacity benchmark. CPU, memory and all five session token totals remain null because they were not measured or exposed. Initial work took about 82 minutes; the correction took about 10 minutes.
Raw logs, failed attempts, probe sources and snapshots remain in `/private/tmp/st363`; follow-up files use the `f1-` prefix. Original suite JSON SHA-256: baseline `3a83fd3f727c152b82f4ebb860f7bce9f939b4204e0c4f3496de1d32d0c3f625`; candidate `a41bf551c13d89a5b149bea02fc5f0e6267677b3fa34e0bafd7c9b7f6b81856c`.

## Handoff and noticed beyond my task

The reviewer rechecks F1 before installation. Retire the optional RPC compatibility fields after one release. The absent `.husky/_` installation and linked-entry gate limitation remain; normal Git commit commands were used without changing hook configuration. The dependency symlink remains untracked.
Nothing was installed into the live CLI, no existing daemon was restarted and no factory file changed. The seat must remove the flag from `.claude/settings.json` and `.claude/engine-coordinator-bootstrap.md`; F2 also requires dropping the bootstrap sentence “verify both accepted source kinds after takeover.” The actual factory hook uses `SHEPY_PROFILE` without `--profile`. Ray's post-install live wake and worker-outcome check remains open.
