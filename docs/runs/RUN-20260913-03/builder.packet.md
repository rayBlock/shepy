RUN-20260913-03 / plan item 2 (represented set == acknowledged set) / attempt 1 — BUILDER packet

Work ONLY in:
  cwd     ~/dev/shepy-wt/item2
  branch  pilot/item2-represented-equals-acked   (base 2dea955 on the shepy branch — item 3 has already landed there; read its diff first: `git log --oneline -6`, it touched inboxLease refusal codes and the hook's Stop recovery)
Never touch ~/dev/shepy, ~/.shepy, or other worktrees. No daemon start/stop, no installs, no credential changes, no `git push`, no model switching.

## The defect (verified by ops; a probe found it, diff reviewers missed it twice)

src/cli/claude-hook.ts: `LEASE_MAX_BATCH = 20` (~line 91). `handlePromptSubmit` (~513) and `handleStop` (~676) lease up to 20 obligations, persist ALL their ids in the owner file's delivered record (~558/~696), call `inbox.delivered` with all ids, then `formatHookContext` (~854) renders whole outcome lines only while they fit the 6 000-char / 120-line budget and appends "… [N more outcome(s); run shepy inbox list …]". The next hook run acks every id in the record. With 2 000-char excerpts: lease 20 → render 2 → ack 20. Eighteen outcomes are acknowledged that no model ever saw, and the note points at an inbox where those rows are now `acked`. The Pi extension does NOT have this gap (packages/shepy-pi/src/wake.ts `formatProfileObligationUpdates` renders every leased row with no budget) — do not change it.

## Design (decided by ops — build this, not an alternative)

The represented set is defined by the formatter, and only the represented set is delivered and acked. Whatever does not fit is returned to pending WITHOUT burning a delivery attempt.

D1. `formatHookContext(profileId, obligations)` returns `{ context: string; representedIds: string[]; deferredIds: string[] }`. Rendering order, oldest first as today:
    a. full outcome lines (current `outcomeLine`) while they fit the budget;
    b. then ONE-LINE stubs for the remaining obligations while they fit, e.g.
       `- <type> <identity> <pane> <transition> · event <N> · obligation <ID> — excerpt omitted for budget; run shepy inbox get <ID>`
       (same untrusted-token policy as `outcomeLine`: `safeToken` on every interpolated field);
    c. anything still unfitting is deferred, and the trailing note becomes
       `… [<K> more outcome(s) deferred to your next turn; run shepy inbox list <profile> --state pending]`
       (reserve its worst-case length up front exactly as today).
    A stub counts as represented: the model saw the outcome's identity and where to read it. Do NOT change `WAKE_POLICY` — it is byte-identical with the Pi extension by design and may be pinned; the read hint lives in the stub line.
D2. Hook: the owner-file delivered record holds `representedIds` only; `inbox.delivered` is called with `representedIds` only; `deferredIds` go to a NEW RPC `inbox.defer` `{ ids, leaseToken }` (token-fenced exactly like `inbox.nack`). If `inbox.defer` fails, the rows stay leased and expire back to pending server-side (one attempt burned) — document that in a comment; no warning, no retry. Both `handlePromptSubmit` and `handleStop`. If `representedIds` is empty but the lease was non-empty (a header-only budget — should be impossible at 6 000 chars, but be honest), defer everything and inject nothing.
D3. Store + service + server: `DeliveryObligationStore.defer({ ids, leaseToken })`: `leased → pending`, `lease_token = null`, `lease_expires_at = null`, `attempt_count = max(0, attempt_count − 1)`, `last_error_code = 'deferred_over_budget'`, only for rows in state `leased` stamped with this token (NOT `delivered` — a delivered row was represented). Service `inboxDefer`; server case `inbox.defer` with a TypeBox schema in src/observability/schemas.ts; help census untouched (this is RPC, not CLI).
D4. `inbox get <obligationId>`: RPC `inbox.get { obligationId }` → the obligation with `leaseToken: null` and `deliveredHarnessTurnId: null` (same redaction as `inboxList`, see the comment there about the token boundary) plus `outcome: InboxOutcomeSnapshot | null` built with the existing `#outcomeSnapshotFor`. CLI verb `shepy inbox get <obligationId> [--json]`; add `get` to `COMMAND_GROUP_VERBS.inbox` in src/cli/shepy.ts so the help census stays true (there is a test for it); text output shows the full excerpt.
D5. `inbox list` cursor: `--before <agentEventId>` and `--limit <n>` on the CLI; `before` in the RPC schema and in `DeliveryObligationStore.list` (`and agent_event_id < ?`), order unchanged (newest first, default 50).

## Required (tests first — RED before GREEN, verbatim capture)

R1. Overload test in test/integration/claude-hook.test.ts using the real fixture daemon (model: the injected-context budget describe at ~1254): 20 obligations with 2 000-char excerpts → the injected context contains every id in `representedIds` and NO id outside it; `representedIds ∪ deferredIds` == leased ids; after the following `Stop`, every represented row is `acked` and every deferred row is `pending` with `attempt_count` equal to its value BEFORE the lease and `last_error_code = 'deferred_over_budget'`.
R2. Unit test for `formatHookContext`: (a) all fit → no stubs, no deferred; (b) some fit as full lines, rest as stubs, none deferred; (c) more than fit even as stubs → deferred non-empty, note present, char AND line budgets respected; (d) every id that appears in `context` is in `representedIds` and vice versa (parse the ids out of the text).
R3. Store test for `defer`: fences on token; touches only `leased`; decrements attempts with a floor of 0; a `delivered` row is untouched.
R4. RPC tests: `inbox.get` returns the redacted row + snapshot, and an unknown id returns `{ obligation: null }` (not an error); `inbox.list` with `before` pages correctly (three rows, before = middle id → only the oldest).
R5. CLI: `shepy inbox --help` lists `get`; the help-census test passes; `shepy inbox get` parse + a text-rendering unit test if the CLI has a pattern for it (look at how `inbox-list` is rendered ~line 991 of shepy.ts).
R6. `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` → exit 0. Report counts (baseline: whatever `git log` says item 3 landed with — run `pnpm test` once at base and record it).

Out of scope: `LEASE_MAX_BATCH` value (leave 20), Pi extension, `WAKE_POLICY` text, item 3's admission logic (already landed — do not modify it), retire/retry semantics, `MAX_DELIVERY_ATTEMPTS`.

## Self-review + commit

Re-read the full diff. List untested claims. Commit on the branch, pathspec form, in 2–3 commits by layer (store/service/RPC; hook; CLI). Report shas.

## Report

Write `/tmp/run-20260913-03/builder-report.md`: Candidate (shas, `git diff --name-only 2dea955..HEAD`); RED evidence verbatim; GREEN evidence (pnpm check tail + counts); Requirement table R1–R6 → test names; Design deviations (any place you had to depart from D1–D5 and why); Untested claims; Limitations / follow-ups; Time spent (honest wall clock).

Final pane line, exactly one of:
  `HERDR-SENTINEL: RUN-20260913-03 BUILD DONE`
  `HERDR-SENTINEL: RUN-20260913-03 BUILD BLOCKED <one-line reason>`

## Rails

- Budget 150 minutes wall clock; stop and report BLOCKED after 25 minutes stuck on one thing.
- NEVER `pkill -f` / `killall` on a bare tool name or any string in this packet. Kill by recorded PID only.
- Wrap anything that could hang with `perl -e 'alarm shift; exec @ARGV' <secs> <cmd>`.
- biome enforces style; match surrounding code; no commented-out code, no drive-by refactors.
