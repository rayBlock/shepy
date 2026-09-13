# RUN-20260913-02 / plan item 3 (lease admission) — BUILDER report (attempt 1)

## Candidate

- Branch `pilot/item3-lease-admission`, base `9f49898`.
- Commits:
  - `efe6c6a` — fix(delivery): one lease-liveness rule for claim, renew and inbox.lease
  - `8b5fa09` — fix(claude-hook): recover a lapsed owner on Stop by proof of possession
- `git diff --name-only 9f49898..HEAD`:
  - `src/db/profile-owners.ts`
  - `src/observability/profile-delivery-service.ts`
  - `src/daemon/client.ts`
  - `src/daemon/observability-server.ts`
  - `src/cli/claude-hook.ts`
  - `test/integration/profile-delivery.test.ts`
  - `test/integration/claude-hook.test.ts`
  - `test/unit/claude-hook-lapsed-recovery-warning.test.ts` (new)

## RED evidence (verbatim, captured before implementation)

Run: `pnpm vitest run test/integration/profile-delivery.test.ts test/integration/claude-hook.test.ts test/unit/claude-hook-lapsed-recovery-warning.test.ts`
→ `Test Files 3 failed (3) / Tests 7 failed | 99 passed (106)` (full log: `/tmp/red-run.log`).

Excerpts, verbatim:

```
 FAIL  test/integration/claude-hook.test.ts > claude-hook Stop > a Stop on a lapsed owner recovers exactly once by proof of possession: re-claims, persists the new token, delivers
AssertionError: expected [] to have a length of 1 but got +0
 ❯ test/integration/claude-hook.test.ts:1104:20
    1104|     expect(claims).toHaveLength(1);

 FAIL  test/integration/claude-hook.test.ts > claude-hook Stop > a rival claiming during the lapse wins the Stop recovery race: the warning names the rival and nothing is injected
AssertionError: expected +0 to be 1 // Object.is equality
 ❯ test/integration/claude-hook.test.ts:1178:28
    1178|     expect(recoveryClaims).toBe(1);

 FAIL  test/integration/profile-delivery.test.ts > lease admission — one liveness rule for claim, renew and inbox.lease > isLeaseAlive is the exact claim boundary: alive strictly before lease + grace
TypeError: isLeaseAlive is not a function
 ❯ test/integration/profile-delivery.test.ts:1134:12

 FAIL  test/integration/profile-delivery.test.ts > lease admission — one liveness rule for claim, renew and inbox.lease > inbox.lease refuses the owner's own token with owner_lapsed once the lease lapsed past grace
AssertionError: The instanceof assertion needs a constructor but undefined was given.
 ❯ test/integration/profile-delivery.test.ts:1170:21
    1170|     expect(refused).toBeInstanceOf(InboxRefusedError);

 FAIL  test/integration/profile-delivery.test.ts > lease admission — one liveness rule for claim, renew and inbox.lease > a rival's rotated token is not_owner even when the lease it superseded lapsed
AssertionError: The instanceof assertion needs a constructor but undefined was given.

 FAIL  test/integration/profile-delivery.test.ts > lease admission — one liveness rule for claim, renew and inbox.lease > inbox.lease refusals carry a machine-readable code on the wire
AssertionError: expected undefined to be 'not_owner' // Object.is equality
 ❯ test/integration/profile-delivery.test.ts:1236:30

 FAIL  test/unit/claude-hook-lapsed-recovery-warning.test.ts > claude-hook lapsed-recovery contention warning > names the rival pane and harness, stays inside the systemMessage budget, one line
TypeError: lapsedRecoveryWarning is not a function
```

The 8th new test (R5, "a lapsed owner reclaims on the next prompt by proof of possession and is
delivered") passed pre-change **by design**: it is a regression pin for the fast-path re-claim that
R5 requires to keep working, not a defect RED. Verified it runs (`1 passed | 49 skipped` under `-t`).

Lapse injection method (R6 asked to say which): **direct sqlite update** of
`profile_owners.lease_expires_at` (`lease_expires_at = 0, last_seen_at = 0`) in the fixture's
database — the same injection the existing superseded-token tests use; service-level tests use the
fixture's injected `now`.

## GREEN evidence

`perl -e 'alarm shift; exec @ARGV' 900 pnpm check` → **exit 0**. Tail of the run
(`/tmp/final-check.log`):

```
$ pnpm typecheck && pnpm test && pnpm lint && pnpm format:check && pnpm db:check && pnpm package:check && pnpm pi-package:check && pnpm herdr-plugin:check
$ tsc --noEmit -p tsconfig.json
...
 Test Files  55 passed (55)
      Tests  556 passed (556)
   Duration  6.60s (transform 4.94s, setup 0ms, import 7.38s, tests 20.26s, environment 2ms)
$ pnpm clean:dist && tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json
...
shepy-pi@0.5.0: 7 files
$ pnpm --dir packages/shepy-herdr-plugin typecheck && pnpm --dir packages/shepy-herdr-plugin package:check
$ tsc -p tsconfig.json
$ node check-package.mjs
```

Counts: **55 files / 556 tests** (baseline 54 / 548 → +1 file, +8 tests).

## Requirement table

| Req | What | Test name(s) |
|---|---|---|
| R1 | One predicate used by claim, renew, inboxLease | `isLeaseAlive is the exact claim boundary: alive strictly before lease + grace` (profile-delivery.test.ts); boundary equivalence for claim/renew already pinned by the renew-boundary tests (`renew and claim agree just inside the expiry boundary`, `renew never resurrects a lease that lapsed uncontested past lease + grace`) which now run through the shared predicate |
| R2 | Distinguishable refusal + wire `code` | `inbox.lease refuses the owner's own token with owner_lapsed once the lease lapsed past grace`, `a rival's rotated token is not_owner even when the lease it superseded lapsed`, `inbox.lease refusals carry a machine-readable code on the wire` (all profile-delivery.test.ts). `not_owner` prose kept verbatim (existing tests `the A2-1-adjacent attack…`, `a token superseded by a re-claim can no longer lease` still match `/not the active owner/`) |
| R3 | Stop recovery, no contention | `a Stop on a lapsed owner recovers exactly once by proof of possession: re-claims, persists the new token, delivers` (claude-hook.test.ts Stop describe) |
| R4 | Stop recovery, contention | `a rival claiming during the lapse wins the Stop recovery race: the warning names the rival and nothing is injected` (claude-hook.test.ts Stop describe); warning wording+budget: `names the rival pane and harness, stays inside the systemMessage budget, one line` (test/unit/claude-hook-lapsed-recovery-warning.test.ts) |
| R5 | UserPromptSubmit unchanged, lapsed reclaim works | New pin: `a lapsed owner reclaims on the next prompt by proof of possession and is delivered` (claude-hook.test.ts, gated `runIf(schemaAcceptsCurrentLeaseToken)`). No pre-existing dedicated test existed — the closest is the SIGKILL crash-recovery test (`a SIGKILL between the temp write and the rename leaves the old record readable, never a partial`), which covers lapsed+prompt→delivered but bundled in crash machinery and without asserting the proof-of-possession re-claim, so it did not satisfy R5's "prove" wording |
| R6 | RED before implementation, plan order | Hook REDs (R3/R4) and service REDs (R1/R2) captured verbatim above, then implemented; no admission change was committed before the pinning tests existed |
| R7 | `pnpm check` exit 0 | Yes — 55 files / 556 tests; `package:check` + `pi-package:check` + `herdr-plugin:check` all inside the same `pnpm check` run |

## Pi extension check (no change, and why)

Read `pumpProfile`/`pumpProfileOwned` (packages/shepy-pi/src/index.ts ~504–743). The pump:

1. Renews FIRST on every 10 s tick, before any work gate. `renewed:false` is final — the tick stops
   the timer, clears profile mode, notifies once. Since `renew` fails closed on a lapsed lease (same
   predicate now), a Pi owner whose lease died is detected by the renew within one tick and never
   reaches `inbox.lease` in a lapsed state through the normal path.
2. Even in the interleaving where `profile.renew` throws transiently and the tick falls through to
   `inbox.lease`, an `owner_lapsed` refusal lands in `pumpProfileOwned`'s existing catch (treated as
   transient); the next tick's renew then answers `renewed:false` and cleans up. Cost: one extra
   10 s tick, no stranded rows, no incorrect delivery — the refusal happens BEFORE any rows are
   leased.
3. `not_owner` refusals (superseded token) were already possible pre-change and take the same path.

Also grepped all other `inbox.lease` callers: only the daemon dispatch, the Claude hook, and the Pi
extension. The shepy CLI has no lease caller. No change made to packages/shepy-pi.

## Untested claims

- `herdrSessionName` resolution inside the Stop recovery (`resolveHerdrSessionName`) is not asserted
  anywhere; the recovery claim succeeds regardless of the resolved name.
- The Stop recovery's empty second lease (recovered but nothing pending → silent null, token
  persisted) is not directly tested.
- The recovery's CAS-lost branch (concurrent writer wins between claim and persist → abandon) is
  untested; argued safe from the CAS semantics, not exercised.
- Per-request 5 s deadlines around the two extra recovery RPCs are untested (hard to test quickly;
  the deadline wrapper is shared with all existing calls).
- Stop with a superseded token (`not_owner` on lease) staying a silent no-op is pre-existing
  behavior I did not pin; my change rethrows non-`owner_lapsed` refusals unchanged.
- "Exactly one attempt" under partial failure (e.g. recovery claim succeeds but the second lease
  fails) is untested — the second lease failure surfaces as ordinary transient trouble by design.
- The Pi extension analysis above is reasoning over the source, not a new test (existing
  shepy-pi-profile-renew tests cover the `renewed:false` loss path).

## Limitations / follow-ups

- Commit `efe6c6a` alone (delivery rule without the hook recovery) leaves three pre-existing
  claude-hook clock-simulation tests red, because their inboxLease `now` patches race past a freshly
  claimed 5-minute lease once admission judges liveness at the injected `now`. The branch tip is
  green; the coupling is the one the packet itself calls out ("ship TOGETHER").
- Those three tests now bump the owner row's lease ahead of the simulated clock
  (`keepOwnerLeaseAheadOfSimulatedNow`) — the scenarios are living owners with failing delivery
  handoffs, and admission must see them as alive at the simulated instant. Worth a look during
  review whether a cleaner simulation seam is wanted.
- `requireHerdrIdentity` now runs on the Stop recovery path; a Stop with missing Herdr env that
  reaches recovery would surface the standard missing-env warning (unreachable in practice: a prior
  claim required the same env).
- Out-of-scope items untouched as instructed: lapsed-row sweep (held branch), Pi renew cadence,
  `pendingCount`, `formatHookContext`, ack id set, `LEASE_MAX_BATCH`, render budgets.

## Time spent

Wall clock: ~21 minutes (start 12:37:31Z, finish ~12:58Z), including the RED phase, a mid-flight
retry caused by a misread fixture (`socketPath`) and the two-layer clock fix, the full `pnpm check`,
self-review, two commits, and this report.

## Revision 1 (fresh builder)

**Shas** (branch `pilot/item3-lease-admission`, on top of candidate 8b5fa09):
- `da79fed` — `test(delivery,claude-hook): pin same-instant lapse agreement, stop_hook_active and contested recovery`
- `2dea955` — `fix(daemon): only refusal errors carry a wire code` (amended once, minutes after creation, to fold in a 3-line biome reflow of a commit-1 test line that lint:fix landed after da79fed was cut; candidate commits 9f49898/efe6c6a/8b5fa09 untouched. Final tree is byte-identical to the one `pnpm check` validated: working tree clean at HEAD.)

**Files changed**
- `test/integration/profile-delivery.test.ts` — +3 tests in the "lease admission" describe (same-instant agreement; stale-token-stays-not_owner after rival lapse; wire-code EACCES/owner_lapsed contract)
- `test/integration/claude-hook.test.ts` — +2 tests in the "claude-hook Stop" describe (stop_hook_active on lapsed owner; contested recovery CAS)
- `src/observability/rpc-refused-error.ts` — new, 22 lines: `RpcRefusedError extends Error { readonly code: string }`
- `src/observability/profile-delivery-service.ts` — `InboxRefusedError extends RpcRefusedError` (override narrowing kept)
- `src/daemon/observability-server.ts` — error envelope serialises `code` only for `instanceof RpcRefusedError`

**Probes promoted, and every assertion deviation**
- P1a/P1b → ONE test ("claim, renew and inbox.lease flip together at exactly lease + grace"). Deviation: the probes used two separate tests/fixtures; the packet asked for one test, and a naive single-fixture merge FAILS — `renew` is a heartbeat (successful renew re-arms `lease_expires_at = now + DEFAULT_LEASE_MS`), so renewing at `lapse − 1 ms` pushes the boundary away (my first draft hit exactly this: `renew` returned true at the old lapse instant). Kept one test with a fresh, unextended claim per side of the boundary; comment documents the heartbeat hazard. All probe assertions kept (inboxLease admits / renew true / rival `lease_active` at `lapse − 1`; renew false / `owner_lapsed` / rival `reclaimed` at the exact instant).
- P2 → promoted verbatim in substance: `not_owner` after the rival's own lease also lapses, plus tokenless third claim succeeds (`reclaimed`). Added the existing suite's `message` prose assertion? No — kept probe assertions only; prose is already pinned by the neighbouring shipped test.
- P5 → promoted into the Stop describe: exit 0, stdout "", `inbox.ack` present, `inbox.lease`/`profile.claim` absent. Added one strengthening assertion the probe implied: the mid-turn outcome stays `pending` (1 row).
- P6 → promoted into the Stop describe: exit 0, stdout "", rival record + stale token stay on disk, batch stays `pending` (1) with nothing `leased` (0). Deviations: (a) completed the assertion the probe left dangling as dead code (`fixture.delivery.owners?.get?.(...)`) — now asserts the server row DOES hold the reclaimed fresh token (`owners.get("driffs").leaseToken !== staleToken`), pinning that only the file CAS lost the race; (b) dropped a stray `void row` no-op.
- P3/P4 → skipped as instructed; confirmed already shipped: P3's chain is pinned by "a Stop on a lapsed owner recovers exactly once by proof of possession…" (claude-hook) plus the renew fail-closed coverage in the `profile.renew` describe; P4 by "isLeaseAlive is the exact claim boundary…" (lease admission describe).

**RED evidence (EACCES envelope test, before the server change)**
```
FAIL … > only deliberate refusals carry a wire code; a system error's code never rides the envelope
AssertionError: expected 'EACCES' to be undefined
  ❯ test/integration/profile-delivery.test.ts:1358:33
Tests  1 failed | 57 skipped (58)
```
After the `instanceof RpcRefusedError` gate: GREEN (same file 58/58; owner_lapsed half still carries its code).

**GREEN counts** — `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` → **exit 0**; Vitest **55 files / 561 tests passed** (candidate baseline 55/556; +5 new tests). typecheck, biome lint+format, drizzle db:check, root package build/tarball check, shepy-pi and shepy-herdr-plugin checks all green inside the same gate. Two mid-flight failures were fixed before the final gate: TS4114 (missing `override` on the narrowed `code` redeclare) and two biome format reflows (auto-fixed via `pnpm lint:fix`).

**Wall clock (UTC)**: start ~10:35Z, finish ~10:44Z — under 10 minutes.
