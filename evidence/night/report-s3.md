# S3 builder report

Worker: s3. Worktree: `/Users/ray/dev/shepy-wt/night-s3`. Branch: `night/s3`.
**BUILT.** Terminal subscriptions bind their first native session once and refuse replacements. Not accepted or landed; independent review and the full batch gate remain with the factory seat.
Candidate: `f13ec100699e141979993431fa558e5d341b3253`. Base: `50ca705526a409aa363ba144f1d33d703a85c2f6`. This report supersedes the blockers in `41782ac` under the seat's option-1 decision.

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
    {"probe": "Wrong or missing workspace and missing pane refuse without a row; repeated pane, terminal and resolved-name subscriptions leave one row.", "good_input_control": "Correct workspace succeeds; distinct terminals keep distinct rows."}
  ],
  "running_cost": {"time": "subscribe wall", "cpu": "subscribe fixture process", "memory": "fixture RSS; production null", "disk": "one row", "tokens": null, "expected": "one pane.get per pane subscribe"},
  "ray_check": "none; internal"
}
```

Binding amendments: `/Users/ray/dev/agent-factory/evidence/night/acceptance-check-2.md:21-35`; factory timing is superseded by the seat's explicit no-op decision.

## Acceptance proof

- Twenty new integration cases use the public CLI, real daemon RPC, migrated on-disk SQLite, the real agent index and a producer-shaped local Herdr socket. An actual source CLI subprocess also subscribes successfully. Indexed working-to-done events reach the CLI inbox for the bound session, never the replacement.
- Pending and bound rows survive reopening the database. First binding happens before delayed history publication, including Pi presence before agent detection. Stale cached identities cannot bind through inspection or repeated terminal subscribe; delayed replacement events cannot deliver after the original session returns.
- Pane movement, name reuse, malformed pane metadata, absent native identity, workspace refusal, repeat deduplication and legacy name consolidation all have passing controls. Legacy notices survive consolidation. Event-time terminal, harness and native identity fence delivery, not merely the live index row.
- Factory is a no-op: `/Users/ray/dev/agent-factory/tools/seat/worker.ts:419` already subscribes by terminal. Its pre-prompt proof at line 423 still works: an indexed terminal may be `matched` with `bindingState: pending`, while its guard is pending and cannot deliver outcomes. No factory file changed.

## Checks and retained failures

- Node 24.18.0; pnpm 11.9.0; locked TypeScript 6.0.3, Vitest 4.1.9 and Biome 2.5.1. Every invocation used `env -i`, a fresh HOME and short TMPDIR; all three Claude variables were absent.
- Final touched tests: **228 passed in 11 files**, exit 0, 14.82 seconds. Direct installed `tsc --noEmit`: exit 0, 11.62 seconds. Changed-file Biome check: exit 0, 0.82 seconds. `git diff --check` passed.
- Final `pnpm package:check`, including its `pnpm build` prepack: exit 0, 32.19 seconds, 328 allowed files. Built CLI import/help/version smoke: exit 0, 1.00 second. No database schema migration was needed.
- Full `pnpm check` was attempted twice under the required shared lock: both admissions exited **75, already locked**. The full check did not run; no lock bypass. Normal Git invocation used no hook bypass; the configured `.husky/_` runner was absent, so no hook gate is claimed.
- Red baseline, delayed-event, factory-proof, legacy-JSON and Pi-presence probes are retained. Initial fixture-decoder and TypeScript errors were corrected as harness/build failures, not labelled production failures. No assertions were weakened. The earlier dependency-install deviation was approved; dependencies and build outputs are not committed.

Private proof folder: `/private/tmp/s3-proof.Lv9N1e`. `checks.md` gives exact commands, coverage, cost provenance and retained red logs. `final-touched.log` SHA-256: `d69b160634ec3f346fcffe2003a3e87475b1cefce29c642f5df1d96aeb4a9f21`.

## Cost and limits

- One profile and worker, 20 repeat subscribes: exactly one Herdr call each, one row, 133-byte selector. Median in-process wall 1.58 milliseconds; CPU across 20 calls 33.89 milliseconds. One source CLI subprocess took 959 milliseconds including tsx startup; this is not installed-CLI latency.
- Fixture-worker RSS rose 3.19 MiB; lifetime peak 107.64 MiB includes imports and test machinery, not daemon-only memory. Database plus extant sidecars stayed 188,416 bytes at the repeat-call endpoints; transient journal peak was not sampled. `cost.log` SHA-256: `03f8dde49f74c6815f74eedcf1ea6a744761286975963ffaf5877f80ca485f2b`.
- Production memory, live worker-start time, multi-worker scaling and idle waits are null or untested: no live worker/resource-control grant was supplied. Input, cache-write, cache-read, output and summary tokens are each null because task-scoped harness counters were unavailable. No application inference was invoked.
- Existing selectors without guards remain legacy until re-subscribed; unresolved name callers retain their old name semantics. A new guarded subscription remains pending if its harness never publishes native identity. No live seat wake, installation, push, rebase, foreign edit, profile claim or agent message was performed.

## Noticed beyond my task

- S2 must judge pending-terminal cleanup from terminal liveness, not missing agent rows; `profile-service.ts` deliberately refuses to prune pending guards. Guarded lifecycle outcomes also need event-time native identity. Owner: factory seat and S2.
- `README.md:163-166` still says the Pi claim is slash-command-only, while `packages/shepy-pi/src/index.ts:1212` registers `shepy_profile`. Left for S5's documentation pass.

Next owner: factory seat for independent review, full batch validation when the shared lock is available, and landing. No resources were closed outside the owned test fixtures.
