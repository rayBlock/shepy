# RUN-20260913-09 — builder report (operation wait settles on idle + not-started guard)

## Candidate

- Branch `pilot/wait-idle-settle` (base c518663), commits:
  - `4bf7de5` fix(wait): consume Herdr's idle/done/blocked settled set with an execution-epoch guard
  - `8b7a9b6` test(wait): pin the idle settled-set and the target_not_started epoch guard
- `git diff --name-only c518663..HEAD`:
  - docs/plans/2026-08-30-shepy-orchestration-design.md
  - src/cli/shepy.ts
  - src/daemon/service.ts
  - src/db/agent-events.ts
  - src/herdr/orchestration-transport-adapter.ts
  - src/observability/operation-wait-service.ts
  - test/integration/agent-events-store.test.ts
  - test/integration/operation-wait-rpc.test.ts
  - test/integration/operation-wait.test.ts
  - test/unit/herdr-orchestration-transport-adapter.test.ts
  - test/unit/operation-wait-service.test.ts

## Baseline (at base c518663)

`pnpm test`: Test Files 60 passed (60), Tests 670 passed (670). Duration 9.00s.

## RED evidence

Original-packet RED was captured verbatim before any src change (all four test files against unmodified source), 19:5xZ:

```
 ❯ test/unit/operation-wait-service.test.ts (16 tests | 3 failed) 8ms
     × a settled result with no lifecycle event since submission records the error and stays submitted 2ms
     × the operation is re-waitable once evidence appears after a target_not_started 1ms
     × a blocked result with no lifecycle event since submission also stays submitted 1ms
 ❯ test/unit/herdr-orchestration-transport-adapter.test.ts (13 tests | 2 failed) 8ms
     × normalizes Herdr done and blocked wait results 3ms
     × requests Herdr's settled set idle, done, blocked on every wait 1ms
 ❯ test/integration/agent-events-store.test.ts (6 tests | 6 failed) 27ms
     × true for an agent.idle row on the terminal at/after since 7ms
     × false when the only rows are before since 4ms
     × false for another terminal 4ms
     × falls back to the pane when the query terminal is null 4ms
     × agent.tool.failed alone does not count 4ms
     × a different herdr session does not count 4ms
 ❯ test/integration/operation-wait-rpc.test.ts (7 tests | 4 failed) 44ms
     × the captured agent_info shape settles the operation 9ms
     × an agent.idle row after submission settles an idle Herdr report 5ms
     × only a stale idle (before submission) reports target_not_started and keeps the operation submitted 6ms
     × the failing-sample sequence settles: stale idle, dispatch, later status change and idle 5ms
 FAIL  test/unit/herdr-orchestration-transport-adapter.test.ts > normalizes Herdr done and blocked wait results
AssertionError: expected 2nd "vi.fn()" call to have been called with [ { target: 'w1:p2', …(2) }, …(1) ]
 FAIL  test/unit/operation-wait-service.test.ts > …re-waitable once evidence appears…
AssertionError: expected 'settled' to be 'target_not_started' // Object.is equality
 Test Files  4 failed (4)
      Tests  15 failed | 27 passed (42)
```

- R1 RED = the old request pin `until: ["done","blocked"]` failing (adapter RED above). R1's second half (`agent_info` idle → `settled`) passed immediately pre-change → kept as a pin.
- Store RED surfaced as `Error: FOREIGN KEY constraint failed` (append needs a `herdr_sessions` row) — fixtures now seed sessions via `upsertRunning`; the method-missing RED for `hasCompletionEpochSince` was not separately captured (see Deviations).

## ADDENDUM 1 handling

The addendum (received after the original-packet RED capture) replaced D2/D3 (any-lifecycle-row guard) with the execution-epoch guard. The committed tests encode epoch semantics; the any-row tests were replaced/trimmed.

## GREEN

`perl -e 'alarm shift; exec @ARGV' 900 pnpm check` → **exit 0**. Tail:

```
 Test Files  61 passed (61)
      Tests  686 passed (686)
$ pnpm --dir packages/shepy-herdr-plugin typecheck && pnpm --dir packages/shepy-herdr-plugin package:check
$ tsc -p tsconfig.json
$ node check-package.mjs
```

686 = baseline 670 + 16 new (adapter +2, wait-service +5, store +5, RPC +4). `pnpm lint:fix` applied Biome formatting to 5 files before the green run.

## Requirement table

| Req | Test names |
|---|---|
| R1 request pin (RED then GREEN) | `HerdrOrchestrationTransportAdapter > normalizes Herdr done and blocked wait results`; `requests Herdr's settled set idle, done, blocked on every wait` |
| R1 idle→settled (passed pre-change; pin) | `reads idle from the live agent_info shape as settled` |
| R2' (a) working+idle after since → true | `AgentEventStore.hasCompletionEpochSince … (a) working row then idle row, both after since → true` |
| R2' (b) focus-only done→idle → false | `(b) focus-only done → idle row after since, nothing else → false` |
| R2' (c) working only → false | `(c) working row after since, no later settled row → false` |
| R2' (d) prev completion before since + focus row after → false | `(d) previous completion before since, then focus-only done → idle after since → false` |
| R2' (e) working before since, idle after → false | `(e) working before since, its idle row after since, no new working row → false` |
| R3' | `OperationWaitService — stale-settle guard (RUN-20260913-09)` × 5: no-epoch settled → `target_not_started`; evidence → settles; re-waitable; no-epoch blocked → `target_not_started`; `transport_unknown path never consults the guard` |
| R4' (a) | `operation.wait — stale-settle guard … (a) working and idle rows after submission settle an idle Herdr report` |
| R4' (b) | `(b) only an idle row before submission reports target_not_started, no RPC error` |
| R4' (c) | `(c) previous completion before submission, then only a focus-only done → idle row → target_not_started` |
| R4' (e) | `(e) the failing-sample spacing settles: stale idle, dispatch, working, later settled rows` |
| R5 | `pnpm check` exit 0 (61 files / 686 tests) |

## Untested claims

Per the 20:25Z checkpoint steer the suite was trimmed to the required minimum; the following were written, then REMOVED and are NOT in the committed suite (untested):

- R2' (f) two full epochs after since → true; (g) another terminal/another herdr session → false; (h) pane fallback when terminalId null; (i) `agent.tool.failed` between working and idle neither breaks nor satisfies.
- R4' (d) overlapping operations on one pane (op1's idle row after op2's submission must not settle op2).

Other untested claims in the shipped code:

- `submittedAt` is not persisted on `OperationRecord` (no `submitted_at` column); the guard uses `operation.createdAt - 5_000` as the durable lower bound. This is faithful only because dispatch writes create→submit within one call milliseconds apart; a lifecycle row landing in that sub-5s window counts as evidence of the new prompt (same exposure as the packet's own `submittedAt - 5_000` slack).
- `json_extract(payload_json, '$.to')` is trusted to be the completion direction; status rows with a missing/non-string `to` are simply never evidence (never false-satisfy).
- Fail-closed indexing lag: if Herdr answers settled before the daemon indexes the settled row, the first wait reports `target_not_started` and a later wait settles — asserted only at unit level (re-waitable test), not at RPC level.
- No test drives the daemon over the real socket path in `src/daemon/service.ts` beyond existing harness coverage (wiring change is one constructor argument).
- Late-armed-timeout and RPC-socket-closed cases: out of scope per packet.

## Deviations from the packet

- ADDENDUM 1 replaced D2/D3 and R2–R4 mid-flight; committed implementation is the epoch guard.
- No clean RED capture exists for the epoch-design tests specifically: after the 20:25Z checkpoint steer the source was implemented immediately; the only post-addendum RED observed was a naming slip (`TypeError: this[#events].hasCompletionEpochSince is not a function`) in one unit test, fixed before the green run. The pre-addendum RED block above is verbatim and does pin the R1 RED and the guard-shape REDs.
- Test rows are clock-controlled by direct SQL `update agent_events/orchestration_operations set created_at…` in integration tests (the stores write wall-clock now; no sleeping for the real samples' 129 s / 577 s / 7 min spacings). Production append paths untouched.

## Time spent

Start: Sun Sep 13 19:38:07 UTC 2026
End:   Sun Sep 13 20:28:47 UTC 2026

(One ADDENDUM 1 + one checkpoint steer were absorbed mid-run; the 20:40Z hard stop was met with check green at ~20:27Z.)
