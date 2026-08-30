# Shepy Herdr Transport Adapter Plan

**Status:** READY

**Goal:** Implement the concrete Herdr adapter behind the frozen Shepy orchestration contract for exact-target prompt submission and correlated lifecycle waiting.

**Architecture:** Reuse `HerdrSocketClient` as the persistent JSON-line transport. Add only typed wrappers for the existing Herdr operations needed by Shepy: `agent.send` for dispatch and `events.wait` or the existing event subscription path for lifecycle observation. The adapter receives an already-resolved target; it must never resolve focus, choose a pane, create layout, or shell out to the Herdr CLI.

**Design authority:** `docs/plans/2026-08-30-shepy-orchestration-design.md`

**Contract authority:** `src/herdr/orchestration-transport.ts`

---

## Current evidence

- `src/herdr/socket-client.ts` already provides persistent requests, request IDs, 10-second deadlines, abort propagation, session snapshots, and event subscriptions.
- The archived Herdr control-plane mapping records `agent.send` as the correct agent-message operation and `events.wait` as the Herdr event-wait wrapper.
- `HerdrSocketClient` currently exposes `getPane`, `sessionSnapshot`, and `subscribeEvents`; it does not yet expose typed `agent.send` or a lifecycle wait helper.
- The contract currently requires `submitPrompt(target, prompt)` and `waitForLifecycle(operationId, target)`.

## Exact implementation boundary

### Modify `src/herdr/socket-client.ts`

Add narrow public methods:

- `sendAgentMessage(...)` → one `agent.send` request to the exact pane/agent target;
- `waitForEvent(...)` or a typed lifecycle event iterator → bounded event observation using existing request deadlines and abort signals.

Do not expose a generic public request method. Keep `#request` private.

### Modify `src/herdr/orchestration-transport.ts`

Add a concrete factory/class that adapts `HerdrSocketClient` to `HerdrOrchestrationTransport`.

Responsibilities:

- validate target identity before submission;
- pass exact pane/agent identity to Herdr;
- preserve request IDs;
- map Herdr failures into typed transport categories;
- reject lifecycle events unless operation ID, Herdr session, workspace, pane, terminal, and non-null agent session all match.

The adapter must not perform profile or subscription resolution. That belongs to the later target-resolver unit.

### Tests

- Modify: `test/integration/herdr-socket-client.test.ts`
- Create: `test/integration/herdr-orchestration-transport.test.ts`
- Modify: `test/unit/herdr-orchestration-transport.test.ts`

## RED tests to add

1. `agent.send` receives the exact target and prompt.
2. A missing target identity is rejected before a socket request.
3. Herdr’s rejected `agent.send` response maps to a transport failure.
4. A silent peer times out within the configured request deadline.
5. An abort before submission produces no successful receipt.
6. A lifecycle event for another operation is ignored.
7. A lifecycle event for another Herdr session/workspace/pane is ignored.
8. A lifecycle event without a stable agent session is ignored.
9. The first exact correlated terminal event resolves the wait.
10. A wait timeout returns a distinct timeout error and does not manufacture a lifecycle event.
11. Duplicate terminal events do not produce a second resolution.

## Payload contract to verify against the live Herdr source/API

Before implementation, confirm the exact `agent.send` and `events.wait` parameter and result names from the installed Herdr source or documented socket contract. Do not infer field names from the archived plan. If the installed Herdr binary/source is unavailable, stop this unit at the contract evidence and report the missing authority rather than guessing.

The test fake must assert the complete request payload, not only the method name. Use deliberately distinct values for:

- Herdr session name;
- workspace ID;
- pane ID;
- terminal ID;
- stable agent session ID;
- operation ID;
- prompt text.

## Error taxonomy

The adapter must preserve these distinctions for the operation layer:

- `target_not_found` — exact target cannot be addressed;
- `transport_rejected` — Herdr explicitly rejected the request;
- `transport_timeout` — Herdr did not answer before the request deadline;
- `transport_aborted` — caller cancelled before completion;
- `submission_unknown` — bytes may have been accepted but no receipt was obtained;
- `wait_timeout` — caller wait expired; operation remains unresolved;
- `target_lost` — target disappears after accepted submission.

Do not collapse all errors into `Error("Herdr request failed")` at this boundary.

## Verification sequence

Run focused RED before implementation:

```bash
PATH="/opt/homebrew/Cellar/node@24/24.19.0/bin:$PATH" \
  pnpm exec vitest run test/integration/herdr-orchestration-transport.test.ts
```

Expected: failure on the missing adapter methods/implementation.

After implementation:

```bash
PATH="/opt/homebrew/Cellar/node@24/24.19.0/bin:$PATH" \
  pnpm exec vitest run \
    test/unit/herdr-orchestration-transport.test.ts \
    test/integration/herdr-orchestration-transport.test.ts \
    test/integration/herdr-socket-client.test.ts

PATH="/opt/homebrew/Cellar/node@24/24.19.0/bin:$PATH" pnpm check
```

Acceptance requires the focused suite, full suite, typecheck, lint, format, Drizzle, package, Pi, and Herdr plugin gates to pass. No live prompt should be sent in this unit; live dispatch belongs after the operation RPC and target resolver exist.

## Stop boundary

Stop after the concrete adapter and its transport-level tests are green. Do not add durable operations, CLI commands, profile resolution, or live dispatch in this unit. Those are subsequent staged units.
