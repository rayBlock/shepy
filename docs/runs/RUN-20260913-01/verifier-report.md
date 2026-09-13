# Verifier report — RUN-20260913-01 / task 10a

## Candidate checked

- sha: **6291a60** (`fix(delivery): reject a claim on a nonexistent profile`), detached worktree `~/dev/shepy-wt/verify-10a`, base 0072155. Worktree clean except one untracked scratch test I added (`test/integration/verifier-probes.test.ts`).
- `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` → **EXIT:0**, **Test Files 54 passed (54)**, **Tests 545 passed (545)**, Duration 8.04s. Full log: /tmp/run-20260913-01/check.log.

## Requirement table

| Req | Proof | Ran myself | Verdict |
|---|---|---|---|
| R1 typed rejection, no throw, check lives in the service | `ProfileDeliveryService.claim` (src/observability/profile-delivery-service.ts:217-227) checks `this.#profiles.getProfile(...)` (returns `undefined`, cannot throw) and returns `{ kind: "rejected", reason: "profile_not_found" }`; `ClaimResult` union extended in src/db/profile-owners.ts. Test: "the service rejects the claim without creating a ghost owner" (test/integration/profile-delivery.test.ts:2164) asserts the exact shape. Mutation (a) removes the check → claim succeeds instead. | YES (test run + both mutations a/b) | PASS |
| R2 no owner row, `owner(id)` undefined | Same test asserts `profile_owners` count 0 before and after plus `delivery.owner("ghost")` undefined; RPC test asserts count 0 and `profile.owner` → `{ owner: null }`. Mutation (b) (rejection returned but store claim still runs) fails both tests at `expected 1 to be +0`. | YES (test run + mutation b) | PASS |
| R3 rejection reaches RPC callers unchanged; Pi extension + claude-hook render the reason, not lease-expiry text | RPC: test "over RPC the rejection reaches the caller unchanged" (asserts exact wire shape through the real `ObservabilityRpcServer`; response has no schema that could rewrite it — server returns `{ result: delivery.claim(...) }` verbatim) plus my own live-socket probe (probe 5). Pi extension: code read of both branches (`handleProfileOn` notify + `formatShepyProfileToolText`), **no test coverage — mutation (c) survived, see below**. Claude hook: pre-existing test "a profile that does not exist exits 0 and says so in a systemMessage" (test/integration/claude-hook.test.ts:630) drives the real hook against a real fixture daemon and is load-bearing for the new branch (mutation c2 fails it). | YES (RPC test, probe 5, mutation c, mutation c2, claude-hook suite) | PASS (behavior correct; Pi-side coverage gap → finding) |
| R4 claim / re-claim / lease_active unchanged | `ProfileOwnerStore.claim` body untouched (type union only gained a variant). The 545-test run includes the lease lifecycle suites in profile-delivery.test.ts ("owner replacement: active lease rejects a different subscriber, expired allows it", "a token superseded by a re-claim can no longer lease", renew-boundary tests) and the claude-hook lease_active test — all green. | YES (full `pnpm check`) | PASS |
| R5 `pnpm check` exits 0 | See "Candidate checked". | YES | PASS |

## Mutation results

| Mutation | Result |
|---|---|
| a. remove existence check (pass-through) | **FAILED (2 tests)**: `the service rejects the claim without creating a ghost owner` and `over RPC the rejection reaches the caller unchanged` — both `AssertionError: expected { kind: 'claimed', …(2) } to deeply equal { kind: 'rejected', …(1) }`. |
| b. return rejection but still call store claim (ghost row, correct-looking result) | **FAILED (2 tests)**: same two names, both at `AssertionError: expected 1 to be +0` — R2 is genuinely pinned, not implied by R1. |
| c. Pi extension renders lease_active text for profile_not_found (both branches reverted: `handleProfileOn` notify + `formatShepyProfileToolText`) | **NO TEST FAILED** — `pi-profile-tool.test.ts`, `shepy-pi-extension.test.ts`, `shepy-pi-env-claim.test.ts`, `shepy-pi-profile-renew.test.ts`: 86 passed / 0 failed with the rendering reverted. R3's Pi-side rendering is untested. |
| (extra, mine) c2. disable claude-hook's `profile_not_found` branch | **FAILED (1 test)**: `a profile that does not exist exits 0 and says so in a systemMessage` — hook fell through to the lease-active warning ("owned by pane unknown (unknown)") instead of "does not exist". |

All mutations reverted with `git checkout --`; tree re-verified green (2 new tests + 47 claude-hook tests pass at pristine candidate).

## Probe results (step 4)

Scratch file: `test/integration/verifier-probes.test.ts` (untracked; run `pnpm vitest run test/integration/verifier-probes.test.ts`). 5/5 pass.

1. **Whitespace profileId `" "`**: passes the RPC schema (`profileId: Type.String({ minLength: 1 })` rejects only `""`; `""` → `Invalid RPC params` error — confirmed over a live socket in probe 5) and gets the typed `{ kind: "rejected", reason: "profile_not_found" }` with no row. Correct, no ghost.
2. **Existing profile with zero subscriptions** ("bare"): still claims (`kind: "claimed"`, truthy lease token, 1 row). The existence gate does not over-reach.
3. **Profile deleted after a successful claim** (reported, not fixed — pre-existing hole): the stale owner row survives and `delivery.owner("gone")` keeps serving it; re-claim is rejected `profile_not_found` **without** cleaning the orphaned owner row; and `renew`/`release` with the still-held token **both return `true`** — an owner can renew a lease on a deleted profile indefinitely. This is the seam the fix opens up; behavior at base was equally stale (claim would have re-minted the ghost), so not a regression, but it is now more visible.
4. **Re-claim with `currentLeaseToken` on a nonexistent profile**: fabricated token on a never-existing profile → `profile_not_found`, no row; token held from before a delete → `profile_not_found` too — the existence gate runs before the proof-of-possession fast path. Sensible (nothing can be re-claimed on a profile the daemon never heard of).

## Findings by severity

- **Blocker**: none.
- **Should-fix**: Pi extension `profile_not_found` rendering (notify text + `formatShepyProfileToolText`) has zero test coverage — mutation (c) survived 86 passing tests. The claude-hook equivalent is pinned end-to-end, so the asymmetry is real, not an oversight in my method. Repro: apply mutation c (delete the two `profile_not_found` branches in packages/shepy-pi/src/index.ts), run `pnpm vitest run test/unit/pi-profile-tool.test.ts test/unit/shepy-pi-extension.test.ts test/unit/shepy-pi-env-claim.test.ts test/unit/shepy-pi-profile-renew.test.ts` → all pass.
- **Suggestion**: add a service-level test for the deleted-profile seam (probe 3) and for `" "` (probe 1) — both currently only pinned by my scratch file, which will not ship.
- **Suggestion**: `renew`/`release` succeeding against a deleted profile's stale owner row (probe 3) is worth a tracked issue even though out of scope here.

## What I could not check and why

- Live daemons / real Pi or Claude sessions: forbidden by the packet (no daemon start/stop), and unnecessary — the RPC surface is covered by the real-server fixtures above.
- `git show 6291a60` provenance beyond the diff (e.g. whether commit message claims match): not required by the packet; the diff itself is fully accounted for.
- Behavior of `shepy profile claim` CLI surfaces other than the two named consumers: grep found none — `profile.claim` senders are exactly the Pi extension, claude-hook, and the test client.

## Scope check (step 7)

`git diff 0072155..6291a60 --stat`: exactly the five permitted files — `src/observability/profile-delivery-service.ts`, `src/db/profile-owners.ts`, `src/cli/claude-hook.ts`, `packages/shepy-pi/src/index.ts`, `test/integration/profile-delivery.test.ts`. **No scope creep.**

Consumer audit (step 6): `grep -rn "lease_active|kind !== \"claimed\"|profile.claim" src packages test` — consumers are: claude-hook (updated, pinned by test), Pi extension (updated, unpinned — finding above), `ObservabilityRpcServer` (verbatim pass-through, need not branch), `ProfileOwnerStore`/`ClaimResult` (the type itself), and pre-existing unit tests faking `lease_active` responses (unaffected — the field is additive/optional).

## Recommendation

**ACCEPT** — all five requirements verified by tests I ran and mutations that fail for the right reason; the only real gap (untested Pi-side rendering) does not affect behavior and is a follow-up, not a gate.

## Time spent

~15 minutes wall clock.

## After reading the builder report

- **Builder claim I contradicted:** "claude-hook `profile_not_found` path end-to-end: … no test drives a `profile_not_found` rejection through the fake-daemon hook harness." False. `test/integration/claude-hook.test.ts:630` — `a profile that does not exist exits 0 and says so in a systemMessage` — drives the real hook through a real fixture daemon against a nonexistent profile and asserts the "does not exist" systemMessage; my mutation c2 (branch disabled) fails it verbatim (`expected 'shepy: profile ghost is owned by pane unknown (unknown); this pane will not receive worker outcomes' to contain 'does not exist'`). Nuance: the test predates the candidate (present at 0072155, where it passed via the hook's `profile.show` fallback path) — but at the candidate it is load-bearing for the new branch. The builder under-claimed its own coverage.
- **Builder claims I confirmed from my own evidence:** `pnpm check` EXIT 0 / 54 / 545 (matches); the RED assertion text matches my mutation (a) output verbatim; the call-site dispositions in their table are accurate (I re-derived each hit independently); and the "3 warnings" Biome note is real — `Found 3 warnings.` appears in my own check log line 78.
- **Finding the builder half-disclosed, now proven:** "no test asserts the new string specifically" for the Pi tool text. Stronger: mutation (c) — both Pi rendering branches fully reverted — leaves 86 Pi-side tests green. The R3 Pi rendering is entirely unpinned. The builder disclosed the gap but never measured it; the claude-hook side they called untested is the tested one — the asymmetry is inverted in their report.
- **What the builder missed:** the deleted-profile-with-live-owner seam. Their report covers the write-side race and the missing FK, but not the read/state side I probed: after `deleteProfile`, the orphaned owner row keeps being served by `profile.owner`, re-claim returns `profile_not_found` without cleaning it, and `renew`/`release` with the held token still return `true` (probe 3). Same theme as their FK follow-up, but concrete observable behavior, worth a tracked issue. Also missing: whitespace (`" "`) and empty (`""`) profileId probes — both behave correctly (typed rejection / `Invalid RPC params`), pinned by my scratch tests.
- **Builder's race caution, sharpened:** `getProfile` + `owners.claim` are two synchronous statements with no `await` between them, so within the single-threaded daemon they are atomic; the race exists only cross-process against the same SQLite file, and there is no profile-delete RPC — so I agree it is practically unobservable, though unproven.
- Their "baseline 54 / 543 + 2 new tests" arithmetic I could not independently verify without checking out the base; it is consistent with what I measured (54 / 545 with the 2 new tests included).

Final verdict unchanged: **ACCEPT** (should-fix: add a Pi-side rendering test; suggested follow-up: deleted-profile owner-row cleanup/renew fencing).
