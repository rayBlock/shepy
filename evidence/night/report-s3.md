# S3 builder report

Worker: s3. Worktree: `/Users/ray/dev/shepy-wt/night-s3`. Branch: `night/s3`.
Base: `50ca705526a409aa363ba144f1d33d703a85c2f6`.

**BLOCKED.** No implementation changes. The binding acceptance correction exposes an unresolved session-binding contract; the separate factory worktree was not assigned. This report is the partial delivery, not acceptance.

## Acceptance block, recorded before coding

```acceptance
{
  "kind": "build",
  "real_use": "worker.ts start creates a worker; the subscription row names its terminal and session; the worker's finish notice reaches the seat.",
  "unhappy_paths": "Pane not found; pane has no agent yet; agent restarted in the same pane (new session); name reused elsewhere.",
  "attack_tests": [
    {"probe": "Subscribe by pane, then a different agent takes the same name in another pane: its finish does not reach the profile.", "good_input_control": "The subscribed terminal's finish does."},
    {"probe": "Agent in the pane restarts with a new session: the old subscription does not silently follow; the caller is told.", "good_input_control": "Same session keeps delivering."}
  ],
  "running_cost": {"time": "subscribe call wall", "cpu": "same", "memory": "none", "disk": "one row", "tokens": "null", "expected": "one Herdr call per subscribe"},
  "ray_check": "none; internal"
}
```

Binding additions: `/Users/ray/dev/agent-factory/evidence/night/acceptance-check-2.md:21-35`: no-agent terminal binding, pane movement, wrong or missing workspace refusal, repeat-subscribe deduplication, and factory start timing. All remain unexecuted; no attack or passing-control proof is claimed.

## Verified preparation and blockers

- Read the brief, builder role, current PRIMER and role contract, plan slice 3, design research, README, and binding acceptance correction. The packet did not supply primer or role hashes.
- `src/cli/shepy.ts:446-490` already accepts `--pane` but serializes `paneId`; it requires an explicit workspace. `src/daemon/observability-server.ts:473-482` stores that selector without resolving Herdr.
- `src/herdr/pane-identity-resolver.ts:11-32` already resolves terminal and workspace with one `pane.get`; its result contains no native-session identity.
- `src/observability/profile-selectors.ts:25-30,151-158` and `src/observability/schemas.ts:47-64` have separate terminal and session selector variants, not a terminal plus session binding. Two independent subscriptions would match either identity, not require both, and would not fence restart delivery.
- The brief requires accepting a pane before an agent exists while also refusing silent attachment to a replacement session. The correction explicitly notes that factory starts subscribe before native session publication. The pending-binding behavior and selector schema need a seat decision under builder rule B07 before implementation.
- Read factory code only by absolute path. `/Users/ray/dev/agent-factory/tools/seat/worker.ts:419` already subscribes by terminal; lines 423-427 retain the proof poll. Its README line 15 confirms native identity may appear only after prompting. No assigned factory worktree or branch exists in this packet, so no factory edits were made. WORKERFIX landing was not verified.

## Checks and cost

- One preparation typecheck: `pnpm typecheck`, exit 0; Node v24.18.0, pnpm 11.9.0, TypeScript 6.0.3 from the lockfile installation. Wall 15.86 seconds, user CPU 10.05 seconds, system CPU 10.19 seconds, measured by `/usr/bin/time -p` across pnpm and its children, including the unexpected installation below.
- Used `env -i` with inherited PATH prefixed by pinned Node, fresh private HOME and TMPDIR; all three Claude variables were absent. No application test, live Herdr operation, full gate, build, package check, or factory check ran.
- **Procedure deviation:** although only `pnpm typecheck` was requested, pnpm automatically installed missing dependencies first: 260 packages downloaded, with dependency lifecycle scripts. This was not authorized by the no-install rule and is not a clean no-install measurement. No additional install, cleanup, or implementation followed. Ignored dependency files are retained for seat disposition, never staged.
- Private scratch: `/private/tmp/shepy-s3.Dkd76A`; `typecheck.log` SHA-256 `015c4e7ff1422f469b713043f5ad2c466044ebcdf4f510c6b31dcd0f1a705898` preserves that deviation and successful typecheck. Peak memory and disk growth are null, not measured. Subscribe cost is null because no candidate exists. Input, cache-write, cache-read, output and summary tokens are each null because task-scoped usage was unavailable.

## Open for the factory seat

1. Recommended: approve one terminal selector with an optional native-session guard, plus an explicit pending state when no session exists. Decide when it may bind its first session and how `profile show` exposes replacement refusal. This preserves one row and restart fencing but changes the selector contract.
2. Alternatively, split delivery: authorize pane-to-terminal resolution now, explicitly defer native-session fencing, and revise the acceptance block. Terminal-only subscriptions cannot claim the original restart probe passes.
3. If the factory change remains required, assign its exact worktree and branch after confirming WORKERFIX; otherwise declare it a no-op because start already uses terminal subscription.

Next owner: factory seat for scope and contract decisions, dependency-install deviation disposition, and a corrected packet. No push, rebase, peer messages, profile claims, live worker starts, or foreign edits occurred.

## Noticed beyond my task

The available pnpm invocation installed dependencies while executing a check in a dependency-free worktree. Future fresh-HOME check instructions need an explicit no-install preflight or an admitted existing dependency link; otherwise validation itself can cross the packet's no-install boundary. Owner: factory seat.
