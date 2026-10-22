# S3 builder report

Worker: s3. Worktree: `/Users/ray/dev/shepy-wt/night-s3`. Branch: `night/s3`.
**BUILT, corrected after review.** Not landed or self-accepted; correction recheck and combined S2 validation remain with the factory seat.
Candidate: `d2d74c2445a7fa117710242118cb4a8d37f7129a`. Reviewed candidate: `f698a61`, original code `f13ec10`, base `50ca705`. The seat's correction decisions supersede the original pending-row cleanup policy.

## Correction after independent review `75008c2`

- **F1 (pruning and diagnostics):** without an indexed agent in the subscription's scope, a pending terminal resolves `unmatched` and uses the normal age gate. With an indexed agent but no native session, it remains protected. P4 (closure before detection), P7 (wrong workspace or never indexed), young-row controls and the single-prefix diagnostic pass. The guard stays pending in storage; only resolution changed.
- **F2 (caller-supplied guards):** the RPC schema refuses any supplied `agentSession`, including null, and admission no longer accepts that shortcut. P5 (guard injection) proves rejection without creating or changing a row; a bare selector still binds the observed native identity.
- **F3 (pending-worker departure):** the S3 consumer admits an exact-terminal `agent.gone` even with a pending guard, while retaining workspace, prior-agent and bound-session fences. P9 (death before native publication) seam tests pass for Pi and OpenCode, including no transcript text, wrong-terminal refusal, wrong-workspace refusal, one durable obligation after subscription removal and replay deduplication. Bound guards still reject another session's gone event.
- **Integration limit:** this base has no S2 lifecycle producer. The P9 tests append the S2-shaped departure while the prior agent is still indexed, then remove the subscription and agent. They prove the S3 consumer seam, not automatic close detection. No S2 lifecycle producer was imported, and no S2 worktree file changed.
- **After both land:** retain this guard exception inside S2's private event projection, its frozen-prior `projectGoneAgent` path, projection-before-removal transaction and gone rendering. Run actual close-and-refresh P9 without manually appending an event or unsubscribing: one gone per subscribed profile, row removed, notice retained, no duplicate after another refresh or restart. Recheck P8 (bound-worker closure), replacement-session refusal, manual P4 and P7 age-out, and S2's healthy-snapshot automatic-prune protections.
- **Correction checks:** 235 touched tests in 11 files passed, exit 0, 11.51 seconds; `tsc --noEmit` passed in 13.35 seconds; changed-file Biome passed in 0.59 seconds; `pnpm package:check`, including `pnpm build`, passed in 6.90 seconds with 328 allowed files. All used `env -i`, fresh HOME and short TMPDIR; all three Claude variables were absent. The four requested probes failed before the fixes; their red log is retained.
- **Correction cost:** the existing 20-request fixture still leaves one 133-byte selector and one row; total worker CPU was 22.86 milliseconds and endpoint database size stayed 188,416 bytes. These are fixture readings, not production measurements. Full batch validation remains seat-owned; no new dependency installation, rebase, push or agent message occurred.

Private proof folder: `/private/tmp/s3-correction.diZhkB`. `correction.md` records commands and the integration handoff; `initial/` retains the original proof ledger. Current `touched.log` SHA-256: `c3edbf8990e4b8d9a4a5bb3c0aed236dcc8d60c556a83f165bec9b4dc5b975f0`.

## Revised acceptance block

```acceptance
{
  "kind": "build",
  "real_use": "Shepy subscribe --pane resolves one pane.get and stores one terminal selector with an optional native-session guard. Without a native session the row is pending, then binds the first observed session. Factory start is unchanged.",
  "unhappy_paths": "Missing pane; no agent yet; wrong or missing workspace; changed native session; reused name in another pane.",
  "attack_tests": [
    {"probe": "Subscribe before detection or native publication: one pending terminal row, then first-session binding.", "good_input_control": "Already detected agent: same row shape, known native guard."},
    {"probe": "Bound terminal restarts with another session: no replacement notice; profile show reports replacement refused with both ids.", "good_input_control": "Original session continues delivering after pane movement and daemon restart."},
    {"probe": "A different terminal reuses the subscribed worker's name: its finish does not reach the profile.", "good_input_control": "The originally subscribed terminal's finish reaches the inbox."},
    {"probe": "Pane subscribe with wrong or missing workspace, or a missing pane, refuses without a row; repeated pane, terminal and resolved-name subscriptions leave one row.", "good_input_control": "Correct workspace succeeds; distinct terminals keep distinct rows."},
    {"probe": "Pending terminal rows with no indexed scoped agent, including a wrong workspace, age out.", "good_input_control": "Young rows and indexed agents awaiting native identity stay protected."},
    {"probe": "Caller-supplied terminal native guards are rejected without writes.", "good_input_control": "Bare selectors use the daemon's observed native identity."},
    {"probe": "A pending detected worker's gone event yields one durable notice before row removal; verify automatic production after S2 integration.", "good_input_control": "Wrong terminal, workspace or bound session cannot deliver the gone event."}
  ],
  "running_cost": {"time": "subscribe wall", "cpu": "subscribe fixture process", "memory": "fixture RSS; production null", "disk": "one row", "tokens": null, "expected": "one pane.get per pane subscribe"},
  "ray_check": "none; internal"
}
```

Binding amendments: `/Users/ray/dev/agent-factory/evidence/night/acceptance-check-2.md:21-35`; factory timing is superseded by the seat's explicit no-op decision.

## Original delivery proof (retained history)

- Twenty new integration cases use the public CLI, real daemon RPC, migrated on-disk SQLite, the real agent index and a producer-shaped local Herdr socket. An actual source CLI subprocess also subscribes successfully. Indexed working-to-done events reach the CLI inbox for the bound session, never the replacement.
- Pending and bound rows survive reopening the database. First binding happens before delayed history publication, including Pi presence before agent detection. Stale cached identities cannot bind through inspection or repeated terminal subscribe; delayed replacement events cannot deliver after the original session returns.
- Pane movement, name reuse, malformed pane metadata, absent native identity, workspace refusal, repeat deduplication and legacy name consolidation all have passing controls. Legacy notices survive consolidation. Event-time terminal, harness and native identity fence delivery, not merely the live index row.
- Factory is a no-op: `/Users/ray/dev/agent-factory/tools/seat/worker.ts:419` already subscribes by terminal. Its pre-prompt proof at line 423 still works: an indexed terminal may be `matched` with `bindingState: pending`, while its guard is pending and cannot deliver outcomes. No factory file changed.

## Original delivery checks and retained failures

- Node 24.18.0; pnpm 11.9.0; locked TypeScript 6.0.3, Vitest 4.1.9 and Biome 2.5.1. Every invocation used `env -i`, a fresh HOME and short TMPDIR; all three Claude variables were absent.
- Final touched tests: **228 passed in 11 files**, exit 0, 14.82 seconds. Direct installed `tsc --noEmit`: exit 0, 11.62 seconds. Changed-file Biome check: exit 0, 0.82 seconds. `git diff --check` passed.
- Final `pnpm package:check`, including its `pnpm build` prepack: exit 0, 32.19 seconds, 328 allowed files. Built CLI import/help/version smoke: exit 0, 1.00 second. No database schema migration was needed.
- Full `pnpm check` was attempted twice under the required shared lock: both admissions exited **75, already locked**. The full check did not run; no lock bypass. Normal Git invocation used no hook bypass; the configured `.husky/_` runner was absent, so no hook gate is claimed.
- Red baseline, delayed-event, factory-proof, legacy-JSON and Pi-presence probes are retained. Initial fixture-decoder and TypeScript errors were corrected as harness/build failures, not labelled production failures. No assertions were weakened. The earlier dependency-install deviation was approved; dependencies and build outputs are not committed.

The original exact commands and red logs are under `initial/checks.md`; the original 228-test log remains `initial/final-touched.log`.

## Cost and limits

- One profile and worker, 20 repeat subscribes: exactly one Herdr call each, one row, 133-byte selector. Median in-process wall 1.58 milliseconds; CPU across 20 calls 33.89 milliseconds. One source CLI subprocess took 959 milliseconds including tsx startup; this is not installed-CLI latency.
- Fixture-worker RSS rose 3.19 MiB; lifetime peak 107.64 MiB includes imports and test machinery, not daemon-only memory. Database plus extant sidecars stayed 188,416 bytes at the repeat-call endpoints; transient journal peak was not sampled. `initial/cost.log` SHA-256: `03f8dde49f74c6815f74eedcf1ea6a744761286975963ffaf5877f80ca485f2b`.
- Production memory, live worker-start time, multi-worker scaling and idle waits are null or untested: no live worker/resource-control grant was supplied. Input, cache-write, cache-read, output and summary tokens are each null because task-scoped harness counters were unavailable. No application inference was invoked.
- Existing selectors without guards remain legacy until re-subscribed; unresolved name callers retain their old name semantics. A new guarded subscription remains pending if its harness never publishes native identity. No live seat wake, installation, push, rebase, foreign edit, profile claim or agent message was performed.

## Noticed beyond my task

- The original pending-prune finding is addressed by F1 above. S2's live-pane presence and failed-refresh protections must survive integration; the actual combined lifecycle check is still required.
- `README.md:163-166` still says the Pi claim is slash-command-only, while `packages/shepy-pi/src/index.ts:1212` registers `shepy_profile`. Left for S5's documentation pass.

Next owner: factory seat for independent review, full batch validation when the shared lock is available, and landing. No resources were closed outside the owned test fixtures.
