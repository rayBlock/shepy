# RUN-20260913-02 / plan item 3 — VERIFIER report

Verifier: independent (did not build). Worktree: `~/dev/shepy-wt/verify-item3` (detached at candidate).

## Candidate checked

- **sha**: 8b5fa09 ("fix(claude-hook): recover a lapsed owner on Stop by proof of possession"), parent efe6c6a ("fix(delivery): one lease-liveness rule for claim, renew and inbox.lease"), base 9f49898. Worktree clean at start (except my scratch test, see below).
- **`pnpm check`**: `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` → **EXIT=0**. Full chain ran: typecheck → vitest → biome check → biome format → drizzle-kit check → root package check (+ build, bin-exec, pi package typecheck/check, herdr plugin typecheck/package check). **Test Files 55 passed (55), Tests 556 passed (556)**, ~8.8 s vitest. Log: `/tmp/run-20260913-02/pnpm-check.log`.

## Requirement table

| Req | Proof | Ran myself | Verdict |
|---|---|---|---|
| R1 — one exported liveness predicate, no duplicated arithmetic | `isLeaseAlive` exported at `src/db/profile-owners.ts:22`, sole arithmetic site line 27 (`leaseExpiresAt + graceMs > now`). Callers: `claim` (profile-owners.ts:143), `renew` (:204), `inboxLease` fence (profile-delivery-service.ts:304). Grep for `leaseExpiresAt +` / `lease_expires_at +` across src: only comments elsewhere (`src/cli/shepy.ts:1360` is a pre-existing comment). | Yes — grep + read all three call sites | PASS |
| R2 — stable codes `not_owner` / `owner_lapsed` through RPC envelope to client rejection; existing `not_owner` text unchanged | Service throws `InboxRefusedError` (profile-delivery-service.ts:299–309); `not_owner` message string byte-identical to base in the diff; server envelope adds `code` only when a string (observability-server.ts:303–313); client surfaces `error.code` (client.ts `codedError`). Tests: "lease admission" block in test/integration/profile-delivery.test.ts — boundary test, `owner_lapsed` service test, stale-token-while-rival-live → `not_owner`, and a real-socket wire test asserting `notOwner.code === "not_owner"` (message `/not the active owner/`) and `lapsed.code === "owner_lapsed"` after direct sqlite lapse. Pre-existing `not_owner` assertion (line ~987) still green in suite. | Yes — `pnpm vitest run test/integration/profile-delivery.test.ts -t "lease admission"` → 4 passed; full suite | PASS |
| R3 — Stop on lapsed owner, no rival: ack, re-claim with `currentLeaseToken` → `reclaimed`, guarded owner-file write, lease again, deliver+inject, exactly one attempt | test/integration/claude-hook.test.ts "a Stop on a lapsed owner recovers exactly once…": asserts `claims` length 1, `params.currentLeaseToken === staleToken`, kind `reclaimed`, owner file holds fresh token matching server row, batch delivered once, injection contains mid-turn outcome, no systemMessage. Ordering verified by reading handleStop (claude-hook.ts:697–779): ack (stamp authority, no liveness fence — confirmed `inboxAck` delegates straight to obligations.ack) → lease → catch `owner_lapsed` → reclaim → CAS write (`handled=null` after ack-clear) → one more lease → normal path. No recursion possible: the recovery lease is issued inside the catch, a throw there propagates. | Yes — `pnpm vitest run test/integration/claude-hook.test.ts -t "lapse"` → 3 passed; plus my probe P3 | PASS |
| R4 — Stop on lapsed owner, rival claimed: re-claim `lease_active`, nothing injected, nothing foreign acked, warning names rival, file token untouched, one attempt | Same file, "a rival claiming during the lapse wins the Stop recovery race…": rival claims inside the recovery window via spy; asserts `recoveryClaims === 1`, exit 0, no hookSpecificOutput, systemMessage contains profile id + `w9:p9` + `(pi)`, owner file token still stale, row subscriber = rival, batch pending=1 / leased=0. The only ack that ran settled the ids this session actually had delivered earlier (ack block precedes the lease attempt by design). | Yes — same targeted run; plus probe P6 for the contested-write variant | PASS |
| R5 — UserPromptSubmit unchanged (claims first with proof of possession) | Prompt path untouched by the diff (only handleStop and error plumbing changed). New test "a lapsed owner reclaims on the next prompt by proof of possession…": asserts claim presented `currentLeaseToken === staleToken`, kind `reclaimed`, and this happens BEFORE any lease; delivered normally. Pre-existing prompt tests green in suite. | Yes — `-t "lapse"` run covers it; diff read | PASS |
| R6 — Pi extension needs no change | `git diff 9f49898..8b5fa09 -- packages/` is EMPTY. Read packages/shepy-pi/src/index.ts unchanged: `inbox.lease` (line ~610) sits in `pumpProfileOwned`'s try/catch-all ("transient daemon error: the timer retries"); every tick renews FIRST (10 s interval, line ~498) and `renewed:false` → stop timer, clear mode, "ownership lost" warning. My probes P1b/P3 prove renew fails closed at exactly the instant the lease fence flips, so a late Pi renew gets `false` → clean teardown; a lease racing the flip gets `owner_lapsed`, swallowed by the catch-all, then renew false next tick. No hang, no crash, no change needed. | Yes — source read + probes + pi unit tests green in suite | PASS |
| R7 — `pnpm check` exit 0 | See "Candidate checked". | Yes | PASS |

## What I probed and how

Scratch file `test/integration/verify-item3-probes.test.ts` (untracked, left in worktree; delete freely). Run: `pnpm vitest run test/integration/verify-item3-probes.test.ts` → **7 passed**. All probes use injected clocks and the real migration/RPC stack.

1. **P1a (one ms before the lapse instant)**: `inboxLease` admits, `renew` returns true, tokenless rival claim rejected `lease_active`. All three paths agree while alive.
2. **P1b (EXACTLY at lease+grace)**: `renew` → false, `inboxLease` → `owner_lapsed`, tokenless rival claim succeeds (`reclaimed` — an existing row yields "reclaimed"). All three paths flip at the SAME instant; no 1-ms disagreement window.
3. **P2 (stale token AND lapsed)**: rival claimed during the lapse, then the rival's lease ALSO lapses; original token presented → **`not_owner`** (classification order: token match decided first, liveness second). Correct: possession is not provable against a rotated row, so no recovery is offered; system not stuck (a tokenless claim reclaims via the expiry rule).
4. **P3 (Pi owner whose renew is late)**: renew → false (fail closed), lease with still-matching token → `owner_lapsed`, proof-of-possession re-claim → `reclaimed` with fresh token, fresh token leases again. This is exactly the hook's recovery sequence at service level.
5. **P4**: `isLeaseAlive` strict inequality at the exact boundary with default (30_000) and zero grace.
6. **P5 (Stop with `stop_hook_active: true` on a lapsed owner)**: exit 0, empty stdout, RPC spy shows `inbox.ack` ran (settling the already-delivered record under the stamped token) and **no** `inbox.lease`, **no** `profile.claim` — the pre-existing stop_hook_active guard returns before the lease attempt; no recovery churn on the injection loop path.
7. **P6 (recovery when the owner-file CAS write is contested)**: a competing unsettled record written during the recovery reclaim → recovery's guarded write fails → Stop returns null, nothing injected, exit 0; owner file keeps the competing record and the stale token; mid-turn batch stays pending (leased=0), nothing lost. Matches the code comment's stated semantics; verified they are actually implemented.

Additional wire check: `inbox.lease`'s schema/dispatch path (observability-server.ts:505–513) **never forwards a caller-supplied `now`** — the fence always reads the service clock, so the liveness rule cannot be bypassed from the wire. `inboxAck` intentionally has no liveness fence (stamp authority), which is what lets R3's Stop settle its delivered record before recovering.

## Findings by severity

**Blocker** — none.

**Should-fix** — none found.

**Suggestions / observations** (no reproduction fails; all are hardening notes):

1. **Server echoes any string `.code`** (observability-server.ts:303–313). A Node system error thrown inside dispatch (e.g. fs `EACCES`) would now also serialize `code: "EACCES"` and ride onto the client rejection. Harmless today — the only branch is `code === "owner_lapsed"` — but it dilutes "stable code" exclusivity. Consider prefixing (`shepy:owner_lapsed`) or an allowlist. Repro: any dispatch path throwing a SystemError with `.code`.
2. **Recovery widens a pre-existing crash window by one link.** If a Stop re-claims (fresh token minted server-side) and dies before the CAS write, the file keeps the stale token while the row holds the fresh one; the next prompt's claim is then rejected `lease_active` with a warning naming the pane's OWN pane id, until the fresh ≤5-min lease lapses. Self-healing, warning-only, and the same risk class as the pre-existing claim-then-crash window — not introduced by this candidate, just worth knowing. Repro: kill -9 between reclaim RPC and CAS write (not testable here without process kills; reasoned from P6 + code).
3. `inboxLease`'s `now?: number` parameter remains in-process-only (verified above); keeping it out of the wire schema contract would prevent future accidents.

## What I could not check and why

- Real Claude Code / Herdr end-to-end: daemon start/stop is out of bounds per packet; hook behavior was verified in-process against a real socket, real migrated SQLite, and the real owner-file boundary (the repo's own integration method).
- Wall-clock (non-injected) grace timing over real minutes: all lapse boundaries were exercised with injected clocks at exact instants instead; Date.now defaults are exercised by the suite's unpached paths.
- Pi extension at runtime (no installs; extension behavior verified by reading the unchanged source plus its green unit tests, e.g. shepy-pi-profile-renew.test.ts ordering/renewed:false tests, in the full suite).
- Nothing about `~/.shepy` or other worktrees was touched.

## Scope check

Changed files (8) — all within the allowed set + tests:

- src/cli/claude-hook.ts, src/daemon/client.ts, src/daemon/observability-server.ts, src/db/profile-owners.ts, src/observability/profile-delivery-service.ts
- test/integration/claude-hook.test.ts, test/integration/profile-delivery.test.ts, test/unit/claude-hook-lapsed-recovery-warning.test.ts

`src/cli/owner-file.ts` (allowed but unchanged) and `packages/` (untouched). Out-of-scope items untouched: no lapsed-row sweep, no Pi renew cadence change, no `pendingCount`, no `formatHookContext` (the new `lapsedRecoveryWarning` is a separate function), ack id set unchanged, `LEASE_MAX_BATCH` only re-indented (value/pre-existing constant passthrough unchanged). **No scope creep.**

## Recommendation

**ACCEPT** — every requirement R1–R7 is proven by tests I ran myself plus boundary probes at the exact lapse instant, the stale+lapsed confusion, stop_hook_active, and a contested recovery write, all behaving as specified; findings are suggestions only.

## Time spent

~20 minutes wall clock (12:20–12:40 CEST), single session, no dead ends beyond two probe-assertion fixes of my own (takeover kind is `reclaimed`, grace is 30_000 not 30).

## After reading the builder report

My findings were written and fixed before reading it. Cross-check:

**Builder claims I could not find / did not verify:**

- The RED run itself (7 failed / 99 passed at base). I did not re-run it (that would require checking out the base). Sanity-checked instead: `isLeaseAlive`, `InboxRefusedError`, and `lapsedRecoveryWarning` are absent from the base tree, and base `client.ts` has no error-code plumbing — so every quoted RED failure signature is consistent with the base. Credible, unverified.
- Baseline counts 54 files / 548 tests — not checked by me (immaterial to the requirements).
- The claim that the R5 prompt-path test "passed pre-change by design" — plausible from the test's structure (it pins an existing fast path) but not independently re-run at base.

**Things I found that the builder's report misses:**

1. **The wire never forwards `now` into `inboxLease`** (observability-server.ts:505–513) — the liveness fence cannot be bypassed with a caller-supplied clock. The builder never states this; it is the property that makes R2's fence a real fence rather than an advisory check.
2. **Same-instant agreement of all three paths at the exact lapse boundary** (my P1a/P1b: at lease+grace−1 all admit, at lease+grace all three flip together). The builder pins `isLeaseAlive`'s arithmetic and cites pre-existing claim/renew boundary tests, but has no test that claim, renew and `inbox.lease` decide identically at one instant — the actual R1 hazard.
3. **`stop_hook_active: true` on a lapsed owner** acks the delivered record and never attempts lease or recovery (my P5). Untested by the builder; the guard ordering is what keeps the Stop injection loop from churning re-claims.
4. **The recovery's CAS-lost branch is exercised** (my P6) — the builder lists it under "Untested claims" as "argued safe from the CAS semantics, not exercised". It is exercisable, and behaves as argued: abandon, no injection, rival record intact, batch stays pending.
5. **Server echoes any string `.code`** — a Node system error in dispatch (e.g. `EACCES`) now rides the envelope as a code. Harmless today (only `owner_lapsed` is branched on) but a contract-hygiene suggestion the builder does not mention.
6. **The recovery-then-crash window consequence**: reclaim minted server-side + process death before the CAS write leaves file(stale) vs row(fresh) so the next prompt is rejected `lease_active` naming its own pane until the fresh lease lapses (≤5 min). Pre-existing risk class, self-healing, but the builder's "untested claims" list stops at the second-lease failure and doesn't note this state or its confusing self-referential warning.

**Builder claims I confirmed independently:** the 8-file scope with `packages/` untouched; exit 0 with 55/556; the R6 three-step Pi analysis (renew-first cadence, catch-all lease, `not_owner` pre-existing) matches my source read; the out-of-scope list is genuinely untouched; `resolveHerdrSessionName` in the recovery is indeed unasserted (I read the same gap; it degrades to an ExpectedHookError, exit 0).

My scratch probes remain at `test/integration/verify-item3-probes.test.ts` (untracked, 7 passing) — they cover builder gaps 2, 3, and 4 and could be folded into the suite or deleted at the orchestrator's discretion. Recommendation unchanged: **ACCEPT**.
