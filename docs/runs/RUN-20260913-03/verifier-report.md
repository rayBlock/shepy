# Verifier report — RUN-20260913-03 / plan item 2

Verifier: independent Pi agent (did not build the candidate).
Worktree: `~/dev/shepy-wt/verify-item2` (detached at candidate; scratch tests created and deleted; no commits, no installs, no daemon lifecycle, no `git push`; `~/dev/shepy`, `~/.shepy` untouched).

## Candidate checked

| | |
|---|---|
| Candidate sha | `5081766` (3 commits on `2dea955`: `675ffc3` store/RPC, `f770579` hook represented-set, `5081766` CLI read-back) |
| Command | `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` |
| Exit | **0** |
| Counts | **Test Files 55 passed (55) / Tests 575 passed (575)** |
| Worktree state at end | pristine (`git status` clean; scratch probe file deleted) |

## Requirement table

| Req | Proof | Ran myself | Verdict |
|---|---|---|---|
| R1 formatter `{context, representedIds, deferredIds}`, full lines → stubs → deferred + trailing note, ids ⇄ represented, char AND line budgets, WAKE_POLICY unchanged | `formatHookContext` rewritten as 3 tiers (claude-hook.ts:1001–1071); tests: formatter tests (a)–(d) + rewritten budget test + end-to-end 20×2000-char integration test; WAKE_POLICY compared base↔candidate by sha256 (`fc09953e…` both) | Yes — read the code, ran the full suite, and ran my own boundary sweep + hostile-token probes (see probe table) | **PASS** |
| R2 both hook paths record/deliver ONLY `representedIds`; deferred → `inbox.defer`; nothing deferred acked next run | Both `handlePromptSubmit` (585–634) and `handleStop` (818–871) render first, record/deliver `represented`, defer `deferred` after commit; next-run ack uses `previous.delivered.ids` (509–513). Tests: "a full batch defers what the budget cannot render and acks only the represented rows" (asserts acked == represented, pending == deferred, attemptCount restored, `last_error_code='deferred_over_budget'`) | Yes — ran it; plus mutation M1 resurrecting the ghost-ack was caught | **PASS** |
| R3 `defer`: only leased+token rows → pending, lease cleared, attempt floor 0, `deferred_over_budget`, delivered untouched, foreign tokens rejected | `DeliveryObligationStore.defer` (196–220): `where id=? and lease_token=? and state='leased'`, `attempt_count = max(attempt_count-1, 0)`. Tests: "defers only rows leased under the presented token, floors attempts at zero", "a foreign token defers nothing" | Yes — ran both; plus mutations M2/M3 and probes P2/P3 | **PASS** |
| R4 `inbox.get` returns obligation with token + turn id redacted + immutable snapshot; unknown id → `{obligation: null}`; `inbox.list` accepts `before`/`limit` | Service `inboxGet` (412–421) nulls both credentials, snapshot via `#outcomeSnapshotFor` (same builder as lease — append-time, never a live re-read); server case returns `{obligation: …}` (558–561); `list` gains `before` cursor (`agent_event_id < ?`, newest-first kept); schemas add `before` (int ≥0), `inboxDeferInputSchema`, `inboxGetInputSchema`. Tests: "inbox.get returns the redacted obligation…", "inbox.list pages with before…" | Yes — ran both; plus probe on acked/dead_letter rows and absurd cursors | **PASS** |
| R5 CLI `inbox get <id> [--json]` in `shepy inbox --help`; `list --before/--limit`; census passes | `COMMAND_GROUP_VERBS.inbox` gains `"get"`; parser, help pages, `inbox.get` dispatch, human formatter with full excerpt; list flags validated 1–500 / int ≥0. Census test (`test/unit/cli-census.test.ts`) derives verbs from the table, so `get` is forced into help — passed in the full run | Yes — full `pnpm check`; unit parse/help tests ran | **PASS** (end-to-end against a live daemon socket not run — daemon lifecycle forbidden; wire path covered by rpcFixture tests) |
| R6 Pi extension untouched; item 3 admission untouched; `LEASE_MAX_BATCH` = 20 | `git diff 2dea955..5081766 --stat -- packages/` empty; no diff touches claim/lease admission or liveness fence; `LEASE_MAX_BATCH = 20` at claude-hook.ts:91 | Yes — grepped + diffed | **PASS** |
| R7 `pnpm check` exit 0 at candidate | See Candidate checked | Yes | **PASS** |

## Mutation results

All mutations applied to the pristine candidate, relevant test file(s) run, then reverted (`git checkout --`). Worktree verified pristine afterwards.

| # | Mutation | Failing test name (verbatim) | Result |
|---|---|---|---|
| M1 | Record/deliver all leased ids again (`ids: [...represented, ...deferred]`) in `handlePromptSubmit` | `claude-hook.test.ts > claude-hook represented set equals acknowledged set > a full batch defers what the budget cannot render and acks only the represented rows` | Caught (1 failed / 56 passed) |
| M2 | `defer` skips attempt refund (`attempt_count = attempt_count`) | `profile-delivery.test.ts > obligation defer — over-budget rows return to pending without burning an attempt > defers only rows leased under the presented token, floors attempts at zero` AND `claude-hook.test.ts > … a full batch defers what the budget cannot render and acks only the represented rows` | Caught (2 failed / 117 passed) |
| M3 | `defer` drops `state = 'leased'` (also touches delivered rows) | `profile-delivery.test.ts > obligation defer — … > defers only rows leased under the presented token, floors attempts at zero` | Caught (1 failed / 61 passed) |
| M4 | Drop the stub tier (defer everything past the full lines) | `claude-hook.test.ts > claude-hook formatter representation sets > (b) overflow with room for stubs: full lines, then stubs, nothing deferred` | Caught (1 failed / 56 passed) |
| M5 | Stub tier allowed 5 lines past `lineBudget` | `claude-hook.test.ts > the line budget is enforced even when every line is short` | Caught (1 failed / 98 passed) |
| M6 | `inboxGet` stops nulling `leaseToken` | `profile-delivery.test.ts > inbox.get and inbox.list paging — the operator read-back > inbox.get returns the redacted obligation with its snapshot; unknown id is a null, not an error` | Caught (1 failed / 61 passed) |

(An initial sloppier M6 variant that leaked `deliveredHarnessTurnId` from both `inboxList` and `inboxGet` was caught by `profile-delivery.test.ts > the inbox.list variant: the delivered turn id must not complete the credential`; the table records the precise single-site mutation.)

The shipped tests protect the requirements: no mutation survived.

## Probe results

Scratch suite `test/integration/verify-probe.test.ts` (9 tests, all passing before deletion) — real migrated SQLite + real `ProfileDeliveryService`, plus pure formatter probes.

| Probe | Command/test | Result |
|---|---|---|
| Deferred rows re-leased on the very next lease, agent_event_id order, attempt restored then re-burned | lease 5 → deliver 2 → defer 3 → re-lease same token | PASS: exactly [102,103,104] ascending, attempts back to 1 |
| Deferred row at `MAX_DELIVERY_ATTEMPTS − 1` (refund keeps it alive) | drive to MAX−1, re-lease to MAX, deliver one / defer the other; contrast: the MAX row that EXPIRED instead | PASS: deferred row pending at MAX−1, re-leasable; the expired MAX row is dead_letter by the sweep — the refund is materially load-bearing |
| `inbox.defer` failure → rows stay leased → expiry recovery | lease 2, never defer, jump clock 3 min, re-lease | PASS: rows recovered in agent_event_id order with one attempt burned (documented degradation is real) |
| `inbox.get` on acked row and dead_letter row; `--before` with non-existent event id | ack one, force `dead_letter`, `inboxGet` both; `inboxList` before=1e9 / 0 / 401 / limit interplay | PASS: both terminal states read back redacted with snapshot; `before` is an exclusive upper bound — huge cursor returns all (never an error), 0 returns none |
| Exactly-at-budget boundary: largest stub that fits vs one char over | bisection on the filler's excerpt length flipping the fixed stub represented↔deferred | PASS: at the last fitting char the stub is represented with no note; one char less budget defers it, its id appears NOWHERE in the injected text, note says "1 more outcome(s) deferred", both budgets still held |
| First outcome alone exceeds the whole budget | single obligation, 20 000-char excerpt | PASS: full line skipped, stub still represents it (`shepy inbox get` hint), no deferral note, excerpt text absent, budgets held |
| Hostile tokens in a stub line | ESC/OSC/BEL in paneId/name/agent/type, `<script>` in obligation id, forced into the stub tier | PASS: every identity field allowlist-rejected to placeholders, id → `obligation unavailable`, stub stays exactly one line, no control bytes in output |
| Daemon excerpt sanitization is the real boundary | `projectInboxOutcome`-built snapshots (what lease/get actually ship) fed to the formatter | PASS for text; **but see Finding 1** — the truncation hint embeds the RAW paneId |
| Truncation hint + hostile paneId (>2 000-char excerpt) | `daemonExcerpt("y".repeat(3000), "\u001b]0;pwned\u0007w2:p1")` | **LEAK CONFIRMED**: `excerpt.text` contains the raw ESC; `formatHookContext` renders it; Finding 1 below |

## Findings by severity

### Blocker

None.

### Should-fix

1. **[probe] Truncation hint embeds the raw `paneId` — control characters from a pane id reach wake context, the new read-back, and the operator terminal.** `normalizeOutcomeExcerpt` (profile-delivery-service.ts:103–116) strips VT/C0/C1 from the excerpt TEXT but builds the >2 000-char cap hint as `` ` … [truncated; run shepy agent read ${paneId ?? "unknown"}]` `` from the un-sanitized paneId (line 111). Repro (my probe, verified passing): a paneId `"\u001b]0;pwned\u0007w2:p1"` + 3 000-char last-assistant text ⇒ the served snapshot's `excerpt.text` contains raw ESC; `outcomeLine` renders it into the hook's `additionalContext`; and the candidate's new `shepy inbox get` prints `excerpt.text` verbatim to the operator's terminal (`formatInboxGet`), i.e. a terminal-escape injection surface. The hook itself treats paneIds as untrusted (`PANE_ID_TOKEN` allowlist) and daemon-side ingestion schemas accept any `minLength: 1` string, so the layers disagree. **Pre-existing at base** (line 111 identical in `2dea955`, diff count 0) — NOT introduced by this candidate; the candidate only widens exposure (the stub now explicitly sends the model to `inbox get`, which serves the same snapshot). Fix: interpolate `safeToken`-style sanitized paneId (or strip C0/C1 from the hint) in `normalizeOutcomeExcerpt`.

### Suggestions

2. **[probe] The hook relies entirely on daemon-side sanitization for excerpts.** `outcomeLine`/`stubLine` allowlist identity fields but print `excerpt.text` with no local control-byte guard; a hand-crafted `LeasedObligation` with ESC in the excerpt renders it raw. Unreachable via the daemon today (except via Finding 1's hint), but a one-line defense-in-depth strip in the hook would decouple the two layers.
3. **[probe] A single outcome can never be deferred.** The daemon caps excerpts at 2 000 chars (`INBOX_OUTCOME_EXCERPT_CHARS`), so one full line (~2.1k) always fits the 6 000-char budget; the stub tier only engages from roughly the third crowded outcome onward. Not a defect — but it means the round-4 "lease 20, render 2" scenario renders 2 full lines + stubs, and single-outcome wakes are always fully represented. Documented here so nobody "fixes" the stub tier in isolation.
4. **[read] R1's "every id in the context is in representedIds" holds for well-formed ids only.** A malformed obligation id renders as `obligation unavailable` inside a represented stub, so that represented id is textually absent (slot still recorded/delivered/acked — no ghost ack, just a non-clickable hint). Daemon ids are generated UUIDs, so unreachable in practice.

## What I could not check and why

- **Live-CLI end-to-end** (`shepy inbox get <id>` against a running daemon socket): daemon start/stop is forbidden by the packet. Mitigated: the wire path (`inbox.get`/`inbox.defer` RPC cases, schema enforcement) is covered by the rpcFixture integration tests I ran, and the CLI parser/formatter by unit tests in the 575.
- **Claude Code's own truncation of `additionalContext`**: external behavior; the candidate reserves worst-case note space and holds both budgets pre-injection, which is all this repo can control.
- **Whether real Herdr pane ids can carry control characters**: determines the practical exploitability of Finding 1; Herdr's pane-id production is outside this repo.
- **Pi extension behavioral parity**: `packages/` has zero diff (verified); its formatter is a separate implementation by design (R6), and running its suite against this candidate's daemon semantics was out of scope.

## Recommendation

**ACCEPT** — all seven requirements hold at the candidate with exit-0 `pnpm check`, six targeted mutations were each caught by a named shipped test, and the only real probe finding is a pre-existing (base-present) paneId/escape leak that this candidate merely touches, to be filed as a follow-up should-fix.

## Time spent

Start 13:04 UTC (background `pnpm check` launched), probes finished and worktree restored pristine by 13:22 UTC, report written 13:21–13:27 UTC — **≈ 25 minutes wall clock**.

---

## After reading the builder report

Read only after my findings were written and saved, as instructed.

### Builder claims I did not find (checked out or taken on evidence)

- **RED evidence (15 failed / 146 passed before src changes)**: I did not reproduce the RED state — reverting src while keeping tests in a shared detached worktree is not worth the risk — but the RED failures they quote are consistent with the test names my mutations exercised, and every one of their new test names appears verbatim in the suite I ran green. Consistent, not independently reproduced.
- **Baseline count (561 tests at `2dea955`, +14)**: not independently verified; I only ran the candidate (55 files / 575 tests, exit 0).
- **3 pre-existing Biome `noUnusedImports` warnings outside the diff**: not checked by me; my gate evidence is only that `pnpm check` exits 0 at the candidate.
- **D2 render-before-phase-1 ordering and the awaited `deferOverBudget` rationale**: confirmed by my own code read (claude-hook.ts:585, 642–647, 818, 860–864) — I agree with the crash-safety reasoning.
- **Their untested claim #1 (defer-RPC-failure → stay leased → expiry sweep recovers with one attempt burned)**: I went further and PROVED it — probe "undelivered+undeferred rows stay leased past the turn, expire, and re-deliver with one attempt burned" passes. Their claim is correct and no longer untested.
- **Their untested claim #2 (Stop's delivery path deferring a tail end-to-end)**: I also did not exercise Stop-with-defer end-to-end (my deferred-lease probes are service-level; the shipped e2e test uses the ack-only Stop). Symmetry argument is plausible; still genuinely untested by anyone.
- **Their untested claim #4 (2-arg scalar `max` in SQLite)**: also not checked by me.

### Things I found that the builder missed

1. **[probe] The truncation-hint paneId escape leak (my should-fix Finding 1).** `normalizeOutcomeExcerpt` (profile-delivery-service.ts:111, present verbatim at base) interpolates the RAW `paneId` into the >2 000-char truncation hint after sanitizing only the text — a hostile paneId puts ESC/BEL into the outcome snapshot served by `inbox.lease` and, new in this candidate, by `inbox.get`, and the new `shepy inbox get` human formatter prints that excerpt verbatim to the operator terminal. Verified by a passing probe (leak present) plus a byte-identical-at-base diff check. The builder's report does not mention it; it should be filed as a follow-up (fix the hint, not this candidate).
2. **[probe] No single outcome can ever be deferred**: the daemon's 2 000-char excerpt cap guarantees one full line always fits the budget, so the stub tier only engages from ~the third crowded outcome onward. This refines the builder's own "~a third of the batch per turn" backlog note with the actual trigger threshold; worth a comment near the formatter so the stub tier isn't tuned against single-outcome expectations.
3. **[mutation] Their untested claim #3 (redaction "reviewed not fuzzed") is actually mutation-covered**: my M6 (delete `leaseToken: null as null` from `inboxGet`) fails their shipped test `inbox.get returns the redacted obligation with its snapshot; unknown id is a null, not an error`. The protection they thought missing exists.
4. **[mutation] The line budget is independently pinned** by the pre-existing test `the line budget is enforced even when every line is short` — my M5 (stub tier +5 line slack) was caught by it. The builder never claimed line-budget protection; it exists.
5. **[probe] Defense-in-depth gap**: the hook never re-sanitizes excerpt text (identity fields are allowlisted, excerpts are not) — safe today only because the daemon sanitizes (modulo item 1). Suggestion-grade.

No contradiction with anything in the builder report was found; my verdict stands at **ACCEPT**, with item 1 filed as a follow-up against the base-era code, not this candidate.
