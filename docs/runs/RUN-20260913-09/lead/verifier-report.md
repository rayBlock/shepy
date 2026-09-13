# RUN-20260913-09 — Verifier Report

Operation: `operation wait` settles on idle + not-started guard
Verifier: independent (did not build the candidate)
Start time: `Sun Sep 13 20:30:36 UTC 2026`

## Candidate

- SHA: `8b7a9b6` (diff base `c518663`; candidate = 2 commits: `4bf7de5` fix + `8b7a9b6` test pin)
- `pnpm check` at candidate: **EXIT=0** (captured on a full re-run; first run's log agrees)
  - Test Files: **61 passed (61)** — base was 60 → +1 (`agent-events-store.test.ts`)
  - Tests: **686 passed (686)** — base was 670 → +16 (2 adapter + 5 service-unit + 5 store + 4 RPC)
  - Biome: "Found 3 warnings" — all 3 pre-exist at base (`rmSync`/`AgentHistoryService` unused imports in `test/integration/operation-wait-rpc.test.ts` exist verbatim in `git show c518663:…`; third in `src/observability/profile-selector-scope.ts`, not in the diff). Warnings, not errors; chain still exits 0.

## Requirement table

| R | Requirement | Proving test (name verbatim) | RAN? |
|---|---|---|---|
| R1 | `until: ["idle","done","blocked"]`; `idle`→`settled` | adapter: "requests Herdr's settled set idle, done, blocked on every wait"; "reads idle from the live agent_info shape as settled"; plus updated assertion in "normalizes Herdr done and blocked wait results" | YES — ran file, 46/46 green at candidate |
| R2 | `hasCompletionEpochSince` read-only, earliest-working-then-settled, scoped | store: "(a) working row then idle row, both after since → true"; "(b) focus-only done → idle row after since, nothing else → false"; "(c) working row after since, no later settled row → false"; "(d) previous completion before since, then focus-only done → idle after since → false"; "(e) working before since, its idle row after since, no new working row → false" | YES — ran file, green |
| R3 | no epoch → `target_not_started`, state `submitted`, lifecycle/settledAt null, errorSummary set; later settle OK; other paths unchanged | unit: "a settled result with no lifecycle event since submission records the error and stays submitted"; "a settled result with lifecycle evidence since submission settles normally"; "the operation is re-waitable once evidence appears after a target_not_started"; "a blocked result with no lifecycle event since submission also stays submitted"; "the transport_unknown path never consults the guard" | YES — ran file, green; also read `OperationStore.recordWaitError` (writes only `error_summary`+`updated_at`, requires `submitted`) |
| R4 | end to end | RPC: "(a) working and idle rows after submission settle an idle Herdr report"; "(b) only an idle row before submission reports target_not_started, no RPC error"; "(c) previous completion before submission, then only a focus-only done → idle row → target_not_started"; "(e) the failing-sample spacing settles: stale idle, dispatch, working, later settled rows" (idle T0 / submit T0+129 s / working T0+130 s / status.changed+idle T0+577 s) | YES — ran file, green. **R4-d (overlapping ops) has NO candidate test** — covered by my probes P4a/P4a-gap10s/P-A/P-B below |
| R5 | help text lists `target_not_started`, settle on idle/done/blocked; design-doc `--until` line updated; no schema/packages/append changes | src/cli/shepy.ts:842-844 and docs/plans/2026-08-30-shepy-orchestration-design.md:55 (read); `git diff --stat -- packages/ drizzle/` = empty; `agent-events.ts` diff is purely additive (no removed lines), `append()` untouched; dispatch code untouched | YES (read + git) |
| R6 | `pnpm check` exit 0 at candidate | — | YES — EXIT=0, 61 files / 686 tests |

## Mutation table (all reverted with `git checkout --`; worktree verified clean)

| # | Mutation | Failing test (verbatim) / none |
|---|---|---|
| M1 | drop `idle` from until list | "normalizes Herdr done and blocked wait results"; "requests Herdr's settled set idle, done, blocked on every wait" |
| M2 | any settled row after since, no working anchor | "(b) focus-only done → idle row after since, nothing else → false"; "(d) previous completion before since, then focus-only done → idle after since → false"; "(e) working before since, its idle row after since, no new working row → false"; "(c) previous completion before submission, then only a focus-only done → idle row → target_not_started" |
| M3 | working row alone = epoch | "(c) working row after since, no later settled row → false" |
| M4 | LATEST working row (`order by id desc`) | **NO TEST FAILED** — see F3 |
| M5 | pane-only match, terminal ignored | **NO TEST FAILED** — see F3 |
| M6 | herdr-session scope dropped | **NO TEST FAILED** — see F3 |
| M7 | target_not_started also settles as `failed` | "a settled result with no lifecycle event since submission records the error and stays submitted"; "the operation is re-waitable once evidence appears after a target_not_started"; "a blocked result with no lifecycle event since submission also stays submitted"; "(b) only an idle row before submission reports target_not_started, no RPC error"; "(c) previous completion before submission, then only a focus-only done → idle row → target_not_started" |
| M8 | guard applied to transport_unknown | "the transport_unknown path never consults the guard" |
| M9 | 5 s slack removed | "a settled result with no lifecycle event since submission records the error and stays submitted" (pins `sinceMs = createdAt − 5000`) |
| M10 | `created_at >` instead of `id >` for "followed by" | "(a) working row then idle row, both after since → true"; "the first terminal result wins over a later conflicting one" (same-millisecond appends make `created_at >` false). Note: catch relies on equal-ms timestamps — mostly deterministic, mildly clock-dependent |

## Probe table (scratch file `test/integration/verify-scratch.test.ts`, untracked, deleted after; real SQLite + real stores, backdated `created_at`)

| # | Probe | Result |
|---|---|---|
| P1 | pending-submission op, settled event | covered by existing unit test "waiting on a pending_submission operation fails closed" → `not_submitted`, guard not consulted — PASS |
| P2 | rows on right terminal, DIFFERENT herdr session | `false` / `target_not_started`, op stays `submitted` — PASS |
| P3 | epoch settled row `agent.blocked` + Herdr `blocked` | outcome `blocked`, row `state=blocked`, `lifecycle=blocked` — PASS |
| P4a-gap10s | op2 submitted 10 s after op1's working row; op1 idle lands later | op1 `settled`, op2 `target_not_started`, op2 stays `submitted` — PASS |
| P4a | op2 submitted 1 s after op1's working row; op1 idle lands later | op2 actual = **`settled`** (required `target_not_started`) — **FAIL** (F1) |
| P4b | both ops submitted before both execution rows (slow prompt start) | both `settled` on the same epoch (rows carry no operation id; unattributable) — documented |
| P5 | op2 submitted after op1 completed; new working+idle | op2 `settled`; op1 untouched (earlier settledAt) — PASS |
| P6 | focus-only done→idle row AFTER a valid epoch | still `settled` — PASS |
| P7 | duplicate `working→working` rows then idle | earliest working anchors; epoch `true`; settles — PASS |
| P8 | `target_not_started` then `wait_timeout`, then evidence | `wait_timeout` (row untouched, still `submitted`), later `settled` — PASS |
| P9a | malformed `payload_json` in range | `hasCompletionEpochSince` **THROWS** "malformed JSON" (json_extract) — FAIL (F2) |
| P9b | status.changed, valid JSON, no `to` | `json_extract` → null; doesn't count, no throw — PASS |
| P-A (ops) | op1 working T−2s, op2 CREATED at T, op1 idle T+1s, Herdr idle | op2 actual = **`settled`** (required: NOT settle) — **FAIL** (F1) |
| P-B (ops) | working T−4s, idle T−1s, op2 created T, nothing after T, Herdr idle | op2 actual = **`settled`** (required: NOT settle) — **FAIL** (F1) |
| P10 | CLI `--json` prints new kind; human output no crash | checked by reading (no daemon allowed): `operation-wait` has no outcome-kind switch — `--json` → `JSON.stringify(result)`; human → `formatHumanResult` falls through to `JSON.stringify(result)` (src/cli/shepy.ts:1140). Cannot crash; kind printed verbatim in both modes — PASS (static) |

Note on ops instruction "use the RPC path": P-A/P-B/P4a/P4b were run at the service+store level — the identical `applyLifecycle` call the RPC server makes (`observability-server.ts:481`) over the same real SQLite stores; the RPC wrapper adds no guard logic (RPC tests (b)/(c) already prove RPC-level `target_not_started` propagation). Deviation noted for honesty; verdict unaffected.

## Findings

### F1 [MEDIUM] [probe] — 5 s slack false-settles operations against wholly-prior or overlapping epochs (should-fix)
`src/observability/operation-wait-service.ts` line ~81: `sinceMs: operation.createdAt.getTime() - 5_000`. Any `to:"working"` row within 5 s BEFORE the operation's creation counts as THIS operation's epoch start. So a second operation submitted against an already-working (or just-finished) pane within that window consumes the previous operation's epoch and settles on it.
- Repro P-B (ops'): working T−4s, idle T−1s, op created T, nothing after T → wait returns `settled`; required `target_not_started`. Verbatim actual: `expected 'settled' to be 'target_not_started' … Received: "settled"`.
- Repro P-A (ops'): working T−2s, op2 created T, idle T+1s → op2 `settled`.
- The packet's own M9 pins the slack's existence (working row 1 s before submission must count), so the fix is a narrower window and/or a persisted submission timestamp (dispatch and row-creation are documented "ms apart", so a ~1 s window satisfies both M9 and P-A/P-B). One-commit fix → **REVISE**.
- Scope honesty: gap >5 s behaves correctly (P4a-gap10s PASS), and the registered R4-d scenario text ("op2 submitted while op1 runs") is satisfied only when op2 is created >5 s after op1's working row; the candidate's registered requirement text has no such qualifier.

### F2 [LOW] [probe] — malformed `payload_json` makes the wait throw instead of answering
`json_extract` raises `malformed JSON`; `hasCompletionEpochSince` propagates → `applyLifecycle` throws → RPC error instead of an outcome. Unreachable via the daemon today (`append()` always `JSON.stringify`s; diff adds no writers), so informational robustness. One-commit fix: `and json_valid(payload_json)` in both queries.

### F3 [LOW] [mutation] — no test discriminates three scoping mutants
M4 (latest working row — would wrongly `target_not_started` when a NEXT operation's working row lands after this epoch's settled row), M5 (pane-only when terminal non-null), M6 (herdr-session scope dropped) all pass the entire suite. Store-level tests never vary terminal or herdr session (fixture creates session "other" but never uses it). Correctness of M5/M6 behavior is supported by my P2 probe; M4's behavior (spurious `target_not_started` for a completed op) is untested and plausibly wrong in the field. Suggest 3 small store tests.

### F4 [INFO] — R4-d has no candidate-authored test; registered packet name mismatch
The candidate's RPC suite covers R4 a/b/c/e only; overlap semantics existed untested until my probes (which found F1). Also: the packet's grep name `hasLifecycleEventSince` does not exist anywhere; the actual method is `hasCompletionEpochSince` (all consumers verified: store definition, service `Pick<>`, daemon wiring `src/daemon/service.ts:61,81-84` with the real `AgentEventStore`, RPC fixture, unit fakes).

## What I could not check
- Live daemon / real `~/.shepy` database (forbidden) — the real sample is represented only by the synthetic-spacing RPC test (e).
- Actual CLI binary execution against a daemon (needs a daemon) — CLI checked by reading only.
- M10's catch is timestamp-dependent (equal-ms appends); I observed it fail deterministically in this environment but cannot promise it fails on every machine.
- Whether Herdr 0.8 can actually emit `agent.status.changed to:"working"` while already working (P7 models it synthetically; the query demonstrably handles duplicates either way).

## Recommendation
**REVISE** — F1 has a one-commit fix (narrow the `createdAt − 5000` window or persist a true submission bound); everything else is green or low-severity.

End time: `Sun Sep 13 20:42:35 UTC 2026` (report drafted; afterword timestamp below)

## After reading the builder report

Read at `Sun Sep 13 20:43:52 UTC 2026`. Findings unchanged; no new discrepancies.

- Builder's GREEN (exit 0, 61 files / 686 tests) matches my independent run exactly.
- Builder's "Untested claims" independently corroborates my F3 and F4: the RED-era store tests "another terminal" and "a different herdr session does not count" and R4' (d) overlapping-operations were written, then REMOVED in the 20:25Z steer — which is precisely why my mutations M4/M5/M6 find no failing test and why F1 had to be found by probe rather than by the committed suite.
- Builder disclosed the `createdAt − 5_000` proxy and called its exposure "the same as the packet's own slack". My P-A/P-B (ops') show that exposure is real and decisive in the registered scenarios: both actual = `settled`, both required = not settle. The builder framed it as accepted; the run registration's R4-d wording does not qualify it, so it stands as the REVISE driver.
- Builder's deviations (ADDENDUM 1 mid-flight, no clean epoch-RED capture, SQL backdating instead of sleeping) match what I see in the committed tests and do not weaken the GREEN evidence; the pre-addendum RED block is consistent with the R1/R3 assertions I mutated against.
- No builder claim contradicted any measurement I made.

Final recommendation: **REVISE** (F1 one-commit fix: narrow the slack window and/or persist a true submission bound; F2 `json_valid` guard and F3 scoping tests are cheap rides-along).

Afterword end time: `Sun Sep 13 20:44:02 UTC 2026`
