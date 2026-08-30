# Shepy Orchestration Implementation Plan

**Status:** READY

**Goal:** Add reliable profile-oriented dispatch, correlated waiting, bounded reads, and operator receipts on top of Herdr without creating a second pane-control engine.

**Architecture:** The daemon owns durable operation state and correlation. A narrow Herdr adapter owns prompt submission and lifecycle observation. CLI and Pi consume the same daemon contract; the optional Herdr UI plugin remains a read surface. All target resolution is profile/subscription based and fails closed.

**Tech Stack:** TypeScript/Node.js 24+, SQLite/Drizzle, Vitest, Herdr JSON-line socket/CLI contract, npm package, optional Bun consumer smoke.

**Execution owner:** Main agent.

**Design authority:** `docs/plans/2026-08-30-shepy-orchestration-design.md`

---

## Scope and non-goals

In scope:

- durable dispatch operation identity;
- exact profile-to-target resolution;
- Herdr prompt submission adapter;
- correlated wait state machine;
- bounded profile/operation read and final report;
- JSON and human CLI output;
- mutation-proof negative paths;
- live harmless multi-agent proof;
- durable npm installation and Bun consumer verification;
- updated Shepy skill, Pi help, README, and Herdr plugin docs.

Out of scope:

- replacing Herdr's pane/window/session manager;
- raw terminal keystrokes from Shepy;
- automatic owner election;
- unbounded transcript mirroring;
- hidden retries after uncertain prompt submission;
- publishing the Herdr plugin to npm;
- deleting or replacing the official Herdr skill.

## Required implementation sequence

Each numbered task is one scoped commit. Every code task follows RED → implementation → focused GREEN → full gate. Do not push until the live gate passes.

### Task 1: Freeze the transport contract

Files:

- Modify: `src/herdr/socket-client.ts`
- Modify: `src/herdr/session-snapshot.ts`
- Create: `src/herdr/orchestration-transport.ts`
- Test: `test/unit/herdr-orchestration-transport.test.ts`

Define a narrow adapter interface for:

- submit prompt to an exact pane/agent target;
- observe lifecycle for an exact target;
- read bounded raw output only when explicitly requested;
- return transport request IDs and typed failures.

Do not expose generic “send anything” APIs. Preserve the existing 10-second request deadline and abort propagation.

RED tests:

- transport timeout is distinct from target-not-found;
- aborted submission rejects and does not produce a successful receipt;
- a response for another request ID cannot settle this request;
- silent peer is bounded.

### Task 2: Add the durable operation model

Files:

- Modify: `src/db/schema.ts`
- Create: `src/db/operations.ts`
- Create: `drizzle/0007_*.sql` via `pnpm db:generate`
- Modify: `src/db/migrate.ts` only if the existing migration runner requires registration
- Test: `test/integration/operations-store.test.ts`

Add an operation record containing:

- operation ID;
- profile ID;
- Herdr session/workspace;
- resolved pane/terminal/agent-session identity;
- prompt fingerprint or bounded prompt metadata, never an unbounded transcript;
- transport receipt;
- lifecycle cursor/correlation anchor;
- state and terminal reason;
- timestamps and bounded error details.

State transitions must be explicit and monotonic. Duplicate terminal transitions are idempotent; conflicting terminal transitions fail closed.

RED tests:

- invalid transition rejected;
- duplicate same terminal transition is harmless;
- conflicting completion cannot overwrite the first terminal result;
- restart preserves the operation;
- operation from another workspace cannot be read as this profile's operation.

### Task 3: Implement profile target resolution for dispatch

Files:

- Modify: `src/observability/profile-service.ts`
- Create: `src/observability/operation-target-resolver.ts`
- Test: `test/unit/operation-target-resolver.test.ts`
- Test: `test/integration/profile-operation-resolution.test.ts`

Resolve enabled profile subscriptions against one explicit Herdr session/workspace snapshot.

Required outcomes:

- exactly one match → dispatchable target;
- zero matches → named diagnostic, no Herdr call, no operation row;
- multiple matches → ambiguity diagnostic, no Herdr call, no operation row;
- stale/disconnected target → explicit target-lost result;
- no implicit focused-pane fallback;
- same profile in another Herdr session is invisible unless explicitly selected.

Mutation probes must kill:

- selecting the first match;
- ignoring `enabled`;
- dropping Herdr session from the scope;
- falling back to focused pane.

### Task 4: Add daemon RPC for dispatch

Files:

- Modify: `src/daemon/observability-server.ts`
- Modify: `src/daemon/client.ts`
- Modify: `src/observability/agent-orchestrator-service.ts` or a new operation service, according to the current ownership boundary
- Test: `test/integration/daemon-dispatch-rpc.test.ts`

Add one daemon method that:

1. validates the profile and explicit scope;
2. resolves exactly one target;
3. creates the durable operation before transport submission;
4. submits through the Herdr adapter;
5. records accepted, rejected, or submission-unknown outcome;
6. returns the operation receipt.

A transport timeout after bytes may have been sent must be `submission_unknown`, never an automatic retry or false rejection.

### Task 5: Add correlated wait

Files:

- Create: `src/observability/operation-wait-service.ts`
- Modify: `src/daemon/observability-server.ts`
- Test: `test/unit/operation-wait-service.test.ts`
- Test: `test/integration/daemon-wait-rpc.test.ts`

Implement event-driven waiting first. The wait service must correlate by operation ID plus scope and target identity.

Terminal outcomes:

- `settled` / completed;
- `blocked`;
- `failed`;
- `target_lost`;
- `transport_unknown`;
- `timed_out`.

A timeout only terminates the client wait request; it must not mark the operation successful, acknowledge an obligation, or erase later evidence.

Mutation probes must kill:

- timeout-as-success;
- any-event completion;
- same-pane/different-session completion;
- duplicate completion producing duplicate delivery.

### Task 6: Add CLI dispatch, operation, wait, and read commands

Files:

- Modify: `src/cli/shepy.ts`
- Modify: `test/unit/cli.test.ts`
- Create or modify: `test/integration/cli-orchestration.test.ts`
- Modify: `README.md`
- Modify: `SKILL.md`

Recommended commands:

```text
shepy dispatch <profile> <prompt> [--workspace <id>] [--session <name>] [--json]
shepy dispatch <profile> --prompt-file <path> [scope] [--json]
shepy operation get <operation-id> [--json]
shepy wait <operation-id> [--until settled|blocked|done] [--timeout N] [--json]
shepy read <operation-id> [--limit N] [--json]
shepy report <operation-id> [--json]
```

The CLI must reject missing scope outside Herdr unless the profile operation already contains an authoritative scope. It must preserve exact prompt text from `--prompt-file`, bound all output, and use stable exit classes for success, blocked, timeout, target-lost, and transport-unknown.

Add shell-friendly human output, but make JSON the automation contract.

### Task 7: Integrate operation results with existing obligations

Files:

- Modify: `src/db/agent-events.ts`
- Modify: `src/db/delivery-obligations.ts`
- Modify: `src/observability/agent-orchestrator-service.ts`
- Modify: `packages/shepy-pi/src/daemon-client.ts`
- Modify: `packages/shepy-pi/src/wake.ts`
- Test: `test/integration/operation-obligation-correlation.test.ts`
- Test: `test/unit/shepy-pi-wake.test.ts`

Use the existing durable obligation system for notification delivery, but bind each notification to the operation/event identity. Preserve:

- one owner-visible wake;
- ack only after Pi settles and produces a final response;
- nack on failure;
- no duplicate wake after reconnect;
- no delivery across profiles or workspaces.

Do not make Pi responsible for operation truth; Pi remains a consumer and owner-scoped delivery surface.

### Task 8: Add Herdr UI/plugin operation surface

Files:

- Modify: `packages/shepy-herdr-plugin/index.mjs`
- Modify: `packages/shepy-herdr-plugin/README.md`
- Modify: `packages/shepy-herdr-plugin/check-package.mjs`
- Test: `packages/shepy-herdr-plugin` existing checks plus a focused contract test if needed

Expose compact operation state and final bounded report links in the Herdr UI. Dispatch controls are optional in the first slice; if added, they must call the Shepy daemon operation API and never bypass profile resolution.

### Task 9: Fix distribution and CLI installation

Files:

- Modify: `package.json`
- Modify: `scripts/clean-dist.mjs` or build entrypoint as required
- Modify: `docs/releasing.md`
- Modify: `README.md`
- Test: `test/unit/package-publication.test.ts`
- Create: `scripts/smoke-installed-cli.mjs` if no existing equivalent

Requirements:

- generated CLI bin is executable after every build;
- local development linking is explicitly documented;
- published npm installation works without the source checkout;
- `shepy daemon start/status` works from a clean global install;
- Bun global installation is tested as a consumer path;
- Node >=24.18.0 is checked and reported clearly;
- package JSON output checks cannot be polluted by engine warnings;
- root and Pi package names/paths are `shepy` and `shepy-pi`, with no Shepherd release names in active documentation.

Do not silently make Bun the runtime authority unless a complete Bun compatibility gate passes.

### Task 10: Rename stale Shepherd surfaces

Files:

- Modify: `SKILL.md`
- Modify: `README.ja.md`
- Modify: `packages/shepy-pi/README.md`
- Modify: `packages/shepy-herdr-plugin/README.md`
- Modify: installed skill/plugin paths only through documented install commands, not by mutating unrelated user files in the repository task

Perform a complete census first. Keep historical archived plans intact unless they are actively presented as current instructions. Replace current runtime-facing names and commands only after the new CLI/package paths are verified.

### Task 11: Full automated proof

Run under Node 24.19.0:

```bash
pnpm check
pnpm build
pnpm package:check
```

Add required mutation probes and ensure every negative probe is RED when the guarded behavior is removed. A count-only green suite is insufficient.

### Task 12: Live multi-agent proof

Use a harmless task in an approved workspace or disposable Herdr session:

1. bind a profile to one exact target;
2. dispatch via `shepy dispatch <profile>`;
3. verify Herdr receives the prompt;
4. wait via `shepy wait <operation-id>`;
5. read via `shepy read <operation-id>`;
6. verify final report and operation receipt;
7. verify exactly one Pi wake/ack;
8. repeat a zero-match and ambiguity case and prove no prompt was sent;
9. repeat a blocked or target-lost case and prove it is not reported as success;
10. restart the daemon and read the operation again.

Record exact commands, IDs, exit statuses, and bounded JSON receipts. Do not store raw sessions, credentials, or full transcripts in the repository.

### Task 13: Repository release

Only after all gates pass:

- verify branch, status, ancestry, and remote;
- decide whether the GitHub repository should be renamed from `shepherd` to `shepy` before publishing;
- update package repository/homepage URLs consistently;
- publish exact npm package versions through the release procedure;
- verify clean consumer installs;
- push the reviewed branch and tag only after the user confirms the final release target.

No force push, history rewrite, or deletion of the upstream remote.

## Design decisions still fixed by this plan

- Shepy owns intent and correlation; Herdr owns transport.
- Profile resolution is always fail-closed.
- An uncertain prompt submission is visible and never silently retried.
- Wait timeout is not operation completion.
- Structured history is the default read surface.
- Raw terminal output stays with Herdr.
- Pi consumes durable Shepy events; it does not become the operation authority.
- npm is the primary distribution path; Bun is an additional verified consumer path.
