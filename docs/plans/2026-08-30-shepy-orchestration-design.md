# Shepy Orchestration Design

**Status:** APPROVED FOR IMPLEMENTATION

**Goal:** Make Shepy the profile-oriented orchestration layer for Herdr-managed agents while keeping Herdr as the authoritative transport and pane-control layer.

**Architecture:** Shepy owns intent, profile selection, fail-closed identity resolution, operation correlation, durable delivery, bounded structured context, and operator-facing receipts. Herdr owns prompt submission, pane state, terminal transport, raw output, and lifecycle waiting. Shepy must call an explicit Herdr adapter rather than reimplementing Herdr's socket or pane semantics.

**Tech Stack:** TypeScript/Node.js, SQLite/Drizzle, Shepy daemon RPC, Herdr CLI or documented Herdr control API, Pi extension, optional Herdr UI plugin, npm package.

**Execution owner:** Main agent after design acceptance.

---

## Current evidence

- `src/cli/shepy.ts` currently supports daemon, agent, profile, and inbox commands; it has no dispatch or wait primitive.
- `src/observability/` already owns profile subscriptions, context projection, agent events, durable obligations, owner leases, and delivery acknowledgements.
- `src/herdr/` already owns Herdr session discovery, pane identity, snapshots, and socket access.
- The live daemon is running from `~/.shepy`; the `driffs` profile has a real Herdr subscription.
- Live agent listing works across the current Herdr session. The active harness reports that profile context, Herdr dispatch, wait/notification, and bounded reports work in practice.
- The current CLI is checkout-linked to `dist/src/cli/shepy.js`; the supported runtime is Node >=24.18.0.

## Product boundary

### Shepy owns

- Profile-level intent: “the worker bound to profile X.”
- Selector resolution and ambiguity rejection.
- Dispatch operation identity and correlation.
- Bounded structured context and final report retrieval.
- Durable notification obligations and owner-scoped wake delivery.
- CLI receipts, JSON output, timeouts, and failure classification.
- Orchestration recipes that compose dispatch, wait, inspect, and report.

### Herdr owns

- Pane/workspace/tab lifecycle.
- Agent process startup and identity detection.
- Prompt submission transport.
- Raw terminal input/output.
- Agent lifecycle state as observed by Herdr.
- Native `wait`, focus, pane, and terminal operations.

Shepy must not create a competing pane-control protocol or duplicate Herdr's lifecycle authority.

## Proposed CLI surface

The first public surface should be profile-oriented, with explicit JSON output and operation IDs:

```text
shepy dispatch <profile> <prompt>
shepy dispatch <profile> --prompt-file <path>
shepy operation get <operation-id>
shepy wait <profile|operation-id> [--until done|blocked|settled] [--timeout N]
shepy read <profile|operation-id> [--limit N]
shepy context <profile>
shepy report <profile|operation-id>
```

The exact command spelling remains open; the semantic requirements are not.

A dispatch must:

1. Resolve the profile's enabled subscription in the explicit Herdr session/workspace scope.
2. Reject zero matches and ambiguous matches; never choose a first row.
3. Submit the prompt through a Herdr adapter.
4. Return an operation ID, target identity, and submission receipt.
5. Correlate later lifecycle/event records to that operation without relying on wall-clock proximity alone.

A wait must:

1. Use an event-driven completion path where available.
2. Fall back to bounded Herdr lifecycle polling only through the adapter.
3. Distinguish settled, blocked, timed out, transport failure, and target disappearance.
4. Return the final structured context/report and the exact correlated operation ID.
5. Never acknowledge a durable obligation merely because a timeout expired.

A read/report command must prefer Shepy's bounded structured history. Raw Herdr output remains available through Herdr, not as an unbounded Shepy transcript dump.

## Correlation contract

Every dispatch operation needs a durable identity containing at least:

- Shepy operation ID.
- Profile ID.
- Herdr session name and workspace ID.
- Resolved target identity: pane ID plus stable agent/session identity when available.
- Submission timestamp and adapter receipt.
- Lifecycle/event cursor or equivalent correlation anchor.
- Terminal state: submitted, working, blocked, settled, failed, timed out, or target-lost.

A later event must be accepted only when its scope and target identity match. A same-profile event from another pane or Herdr session is not a completion.

## Failure and safety rules

- Profile selection is fail-closed.
- Dispatch is never silently retried after an uncertain submission. An explicit operation status must report “submission unknown” when transport acknowledgement is unavailable.
- `--wait` must not mean “sleep until timeout”; it must consume a correlated lifecycle signal.
- A blocked agent is a result requiring operator/user input, not success.
- A final report is evidence, not an instruction to expand the original task.
- Shepy never sends prompts through an arbitrary pane chosen by Herdr focus.
- All waits and reads are bounded by explicit limits.
- The daemon remains the durable writer for operation/event state; CLI clients remain query/command clients.

## Distribution contract

- Development mode may use the checkout-linked CLI.
- Release mode must install a real npm package with an executable `shepy` bin entry.
- Node >=24.18.0 is mandatory and must be checked by the CLI/package smoke test.
- Bun global installation should be tested as a consumer path, but Shepy's runtime contract remains Node-compatible unless Bun-specific behavior is proven.
- `pnpm check` must run under Node 24; the current Node 22 warning/JSON pollution failure is an environment/tooling defect to eliminate from the release workflow.
- The Herdr plugin remains optional and separately distributed; the CLI and Pi extension must work without it.

## Explicit non-goals

- Replacing Herdr's pane/window/session manager.
- Sending raw terminal keystrokes from Shepy.
- Unbounded transcript mirroring.
- Automatic owner election across arbitrary Pi sessions.
- Hidden prompt retries.
- Publishing the private Herdr plugin to npm.
- Deleting the official Herdr skill or making Shepy a substitute for it.

## Acceptance gates

### Contract gate

- One profile resolves to exactly one target or fails closed.
- Two matching targets produce an ambiguity error with no dispatch.
- A dispatch receipt is durable and queryable after daemon restart.
- A completion from another workspace/session cannot settle the operation.
- Timeout, blocked, target-lost, and transport-unknown states are distinct.

### Automated implementation gate

- RED tests for selector resolution, dispatch correlation, wait state machine, uncertain submission, and duplicate completion.
- Full TypeScript typecheck, Vitest, Biome, format, Drizzle, build, root package, Pi package, and Herdr plugin checks.
- Mutation probes for the negative paths: first-match selection, uncorrelated completion, timeout-as-success, and duplicate acknowledgement.

### Live gate

Using a harmless task in a disposable or approved live workspace:

1. dispatch through `shepy` by profile;
2. observe the worker through Herdr without focusing it;
3. wait for correlated completion;
4. read bounded final context/report through Shepy;
5. verify one notification/acknowledgement and no duplicate wake;
6. repeat with a blocked or target-lost negative case.

## Implementation order after acceptance

1. Add the internal operation/correlation contract and RED tests.
2. Add a narrow Herdr adapter for prompt submission and lifecycle wait.
3. Add `dispatch`, `operation get`, and `wait` daemon RPC/CLI paths.
4. Add bounded profile `read`/`report` receipts.
5. Add live integration tests and mutation probes.
6. Repair packaging/global installation and add Node 24/Bun consumer smoke checks.
7. Update the Shepy skill, Pi extension help, README, and Herdr plugin documentation.
8. Rename stale Shepherd-facing names only after source, installed paths, docs, and release metadata have a complete census.
9. Push the repository only after the full automated and live gates pass.
