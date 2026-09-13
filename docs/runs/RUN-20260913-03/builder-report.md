# RUN-20260913-03 / plan item 2 — BUILDER report (attempt 1)

## Candidate

- Branch: `pilot/item2-represented-equals-acked` (base `2dea955`, worktree `~/dev/shepy-wt/item2`)
- Commits (oldest → newest):
  - `675ffc3` feat(delivery): inbox.defer, inbox.get and list cursor — the store and RPC layer
  - `f770579` fix(claude-hook): the represented set is the delivered and acked set
  - `5081766` feat(cli): shepy inbox get — the read-back the deferred stubs point at
- `git diff --name-only 2dea955..HEAD`:
  - `src/cli/claude-hook.ts`
  - `src/cli/shepy.ts`
  - `src/daemon/observability-server.ts`
  - `src/db/delivery-obligations.ts`
  - `src/observability/profile-delivery-service.ts`
  - `src/observability/schemas.ts`
  - `test/integration/claude-hook.test.ts`
  - `test/integration/profile-delivery.test.ts`
  - `test/unit/cli.test.ts`

## RED evidence (verbatim)

Captured with `pnpm vitest run test/integration/claude-hook.test.ts test/integration/profile-delivery.test.ts test/unit/cli.test.ts` after writing the new tests against the new interfaces, before any src change: **15 failed | 146 passed (161)** across the three files.

- R1 (the defect itself, pinned):
  ```
  AssertionError: expected 20 to be less than 20
   ❯ test/integration/claude-hook.test.ts:1649:35
      1647|     const representedIds = readOwnerFile(fixture).delivered?.ids ?? [];
      1648|     expect(representedIds.length).toBeGreaterThan(0);
      1649|     expect(representedIds.length).toBeLessThan(20);
  ```
  (the owner file delivered ALL 20 ids — exactly the ghost-ack defect)
- R2 (formatter signature):
  ```
  AssertionError: expected undefined to deeply equal [ …(3) ]
  TypeError: Cannot read properties of undefined (reading 'length')
  TypeError: Cannot read properties of undefined (reading 'match')
  ```
- R3 (store):
  ```
  TypeError: delivery.inboxDefer is not a function
   ❯ test/integration/profile-delivery.test.ts:2163:31
  ```
- R4 (RPC):
  ```
  Error: Unknown method: inbox.get
   ❯ RpcTestClient.#handleData test/integration/rpc-test-client.ts:76:41
  ```
- R5 (CLI): `parses contextual help for [ 'inbox', 'get', '--help' ]`, `renders root and contextual help`, `parses inbox get with its obligation id and --json`, `parses inbox list --before and --limit`, `inbox get renders the full excerpt ...`, `adds contextual help hints only to usage errors` — all failing (unknown verb / missing help text).

## GREEN evidence

`perl -e 'alarm shift; exec @ARGV' 900 pnpm check` → **exit 0**. Tail:

```
$ vitest run
 Test Files  55 passed (55)
      Tests  575 passed (575)
   Duration  7.30s (transform 492ms, setup 0ms, import 8.33s, tests 19.85s, environment 0ms)
$ biome check .
Checked 126 files in 63ms. No fixes applied.
$ tsc --noEmit -p tsconfig.json
$ pnpm --dir packages/shepy-pi typecheck && node scripts/check-pi-package.mjs
$ pnpm --dir packages/shepy-herdr-plugin typecheck && pnpm --dir packages/shepy-herdr-plugin package:check
```

Counts: **55 files / 575 tests, 0 failed** (baseline at `2dea955`: 55 files / **561** tests, 0 failed → +14 tests). Biome reports 3 pre-existing `noUnusedImports` warnings in files NOT in this diff (`src/observability/profile-selector-scope.ts`, `test/integration/operation-wait-rpc.test.ts`) — verified absent from `git diff 2dea955`; untouched. `pnpm build` + `pnpm package:check` also pass (261 files in tarball, allowlist verified).

## Requirement table

| Req | What | Test names |
|---|---|---|
| R1 | Overload end-to-end on the real fixture daemon | `claude-hook represented set equals acknowledged set > a full batch defers what the budget cannot render and acks only the represented rows` |
| R2 | Formatter unit tests, all four regimes | `claude-hook formatter representation sets > (a) everything fits…`, `(b) overflow with room for stubs…`, `(c) overflow past stubs too…`, `(d) the ids in the text are exactly the represented ids` |
| R3 | Store `defer` semantics | `obligation defer — over-budget rows return to pending without burning an attempt > defers only rows leased under the presented token, floors attempts at zero`, `> a foreign token defers nothing` |
| R4 | RPC `inbox.get` + `inbox.list before` | `inbox.get and inbox.list paging — the operator read-back > inbox.get returns the redacted obligation with its snapshot; unknown id is a null, not an error`, `> inbox.list pages with before: three rows, before the middle id leaves only the oldest` |
| R5 | CLI `get` verb + census | `shepy CLI > parses inbox get with its obligation id and --json`, `> parses inbox list --before and --limit`, `> inbox get renders the full excerpt and says when the obligation is gone`, `> parses contextual help for [ 'inbox', 'get', '--help' ]`, `> renders root and contextual help`, `> adds contextual help hints only to usage errors`, plus `test/unit/cli-census.test.ts` (derives both directions from `COMMAND_GROUP_VERBS.inbox`, which now contains `get`) |
| R6 | `pnpm check` exit 0 | exit 0, counts above |

## Design deviations / clarifications (D1–D5)

- **R1's "following Stop" is the ack-only Stop (`stop_hook_active: true`).** A delivery Stop would, by design, re-lease the just-deferred rows (they are pending again) and re-render them — the assertions "every deferred row is pending with pre-lease attempt_count" uniquely determine the ack-only settle path (the Stop-injection loop's own Stop, which "only acks and never injects again"). Documented in the test body. No D1–D5 semantics departed from.
- **D4 supporting addition:** `DeliveryObligationStore.byId(id)` was added — the service needs a plain single-row read for `inbox.get` and the store had none (`byProfileEvent` is keyed differently; `retry` mutates). Same layer, same redaction contract as `inboxList`.
- **D2 ordering:** `formatHookContext` now runs BEFORE the phase-1 owner-file write (the record's contents depend on the formatter). This is crash-safer than the old ordering (compose after delivered), not weaker: the formatter is pure and cannot throw on daemon data. `deferOverBudget` is awaited (not fire-and-forget) because the RPC client closes in the handler's `finally` — an in-flight defer would usually die with it, which would silently turn every deferral into the expiry path.
- **D1 note text** matches the spec exactly; `WAKE_POLICY` untouched (byte-identical), read hint lives in the stub line. Existing assertions that check the note substrings (`"run shepy inbox list driffs"`, `"more outcome(s)"`) still hold without modification.
- No deviations from D1–D5 otherwise. `LEASE_MAX_BATCH` still 20; Pi extension untouched; item 3's admission logic untouched; help census passes as-is.

## Untested claims

1. **`inbox.defer` RPC failure → rows stay leased and expire back to pending (one attempt burned).** The fallback is a try/catch around one awaited request; the comment documents it, but no test drives a daemon without `inbox.defer` to watch the expiry sweep recover the rows. The behaviour is the same mechanism the existing `recordHandoffFailure` tests cover for `inbox.delivered`.
2. **Stop's delivery path deferring a tail end-to-end.** R1 pins the prompt path end-to-end and the Stop ack-only settle; Stop's own delivery-with-defer branch is symmetric code pinned only indirectly by the existing Stop-delivery tests (fitting batches) plus the R2 formatter regimes.
3. **`inbox.get` redaction against version-skew callers** — the redaction is asserted on the wire for a live lease row, but there is no negative test that a leaked token from an older daemon could re-enter through `inboxGet` (the null-mapping is a spread overwrite, reviewed not fuzzed).
4. **`max(attempt_count - 1, 0)` inside SQLite UPDATE** — exercised (the floor test drives a leased row to 0 and asserts 0), but only via node:sqlite's scalar `max`; a exotic SQLite build without 2-arg scalar `max` would fail at runtime (node:sqlite bundles its own; risk accepted).

## Limitations / follow-ups

- README (`README.md`) is canonical but documents inbox verbs only as passing references (`inbox list`, `inbox retry`); it does not exhaustively census verbs, so it stays truthful without edits — but a sentence on the deferral contract ("outcomes that did not fit the injection budget return to pending and re-deliver next turn; read one with `shepy inbox get`") belongs in the hook's delivery-guarantee paragraph (§ around line 119). Left out to keep this builder attempt within the ops-decided scope; flagging for the reviewer.
- Deferred rows re-lease and re-render every turn; with a permanently overloaded inbox the model sees ~a third of the batch per turn (2 full lines + several stubs at daemon-cap excerpts). That is the ops-decided contract (defer burns no attempts, so nothing degrades), but an operator draining a large backlog should use `shepy inbox list`/`retire`, not wait out the turns.
- The 3 pre-existing Biome warnings (unused imports, two files) predate this branch and are one `--unsafe` fix away; not mine to drive-by.

## Time spent

Wall clock ≈ **35 min** (orient + read item-3 diff ~10 min, tests-first RED ~10 min, implementation ~10 min, full gate + self-review + commits + report ~5 min). Nothing hit the 25-min stuck limit.

## Revision 1 (fresh builder)

Shas (on `pilot/item2-represented-equals-acked`, base 2dea955, candidate 5081766 untouched):
- `4d7a068` fix(delivery,claude-hook,cli): no control bytes reach a wake or a terminal through the truncation hint
- `a65b8c2` test(claude-hook): pin Stop delivery with a deferred tail end to end

Files changed:
- `src/observability/profile-delivery-service.ts` — `normalizeOutcomeExcerpt` hint now interpolates a paneId allowlisted with the hook's own token rule (`/^[a-z0-9][a-z0-9:_.-]{0,63}$/i`); anything else → `"unknown"` (~6 lines)
- `src/cli/claude-hook.ts` — `stripControlChars` helper (same C0/C1 class), applied to `excerpt.text` in `outcomeLine` only (~10 lines)
- `src/cli/shepy.ts` — same helper, applied to the excerpt and `last_error` in `formatInboxGet`; `--json` untouched (~11 lines)
- Tests: `test/integration/profile-delivery.test.ts` (+47), `test/unit/cli.test.ts` (+38), `test/integration/claude-hook.test.ts` (+110)

Source-line budget: ~27 added source lines total — inside the ~40-line cap.

RED evidence (all captured on the unmodified branch):
- Hint test (`the truncation hint allowlists the paneId…`): FAILED — `AssertionError: expected 'zzz…' to contain 'run shepy agent read unknown]'` (raw hostile paneId rode the hint; the no-C0/C1 assertion also failed).
- Hook guard test (`(e) an ESC inside an excerpt…`): FAILED — context matched `/[\u0000-\u0008…\u009f]/` (raw ESC reached the rendered wake).
- CLI guard test (`inbox get strips control bytes…`): FAILED — human output matched the same class (raw ESC reached the terminal path).
- Stop e2e test: PASSED IMMEDIATELY on the unmodified branch. The delivery-with-defer branch was already correct (builder+verifier had only flagged it as unpinned, not broken). Kept as a pin per packet instruction, with the full assertions it never had: injection event, delivered-record == represented set, `inbox.delivered` spy, attempt restoration, `deferred_over_budget`, and the ack-only Stop settling exactly the represented rows.

GREEN: `pnpm check` exit 0 — **55 files / 579 tests passed** (candidate baseline 55/575 + the 4 new tests). 3 biome warnings are pre-existing unused-import warnings in files this revision did not touch. One formatter iteration during GREEN (biome wanted the ternary on one line); no behaviour change.

Notes:
- The two claude-hook tests (defensive-render pin + Stop e2e pin) share one file, so both ride in the test commit; the hook fix itself is in the fix commit. Pathspec-form commits only, no amend/rebase of 5081766.
- RED→GREEN correction: the first draft of the two render-guard tests wrongly asserted `not.toContain("pwned")`; the guards strip bytes, not prose — assertions corrected to pin `]0;pwned` surviving while no control byte does. The daemon-boundary test correctly asserts the hostile paneId is fully replaced by `unknown`.

Wall clock: start 2026-09-13T11:24:33Z, finish 2026-09-13T11:32:25Z (~8 minutes).
