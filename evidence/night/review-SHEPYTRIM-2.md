# Recheck: SHEPYTRIM F1 correction (row 15.363)

Reviewer: rev-shepytrim (Claude Opus). This is a directed recheck of my own finding F1 from `review-SHEPYTRIM.md` (branch `night/rev-shepytrim`, commit `8bfc71b`).
Candidate: `b60f207` on `night/shepytrim`; the previous candidate was `331bacc`. Review branch `review/rev-shepytrim-2`.

**ACCEPT.** F1 is fixed. When a Pi extension that is already loaded sends the old claim and lease fields, the built candidate daemon now accepts them, as the base daemon does. The fields are ignored, so they neither bring back demand delivery nor hide worker outcomes. The correction changes only `src/observability/schemas.ts` in production code, so no full suite was needed.

## F1 recheck
- **Diff:** `schemas.ts:188-193` adds `legacySourceKindsSchema`, with the old shape (a non-empty, unique list of `agent` and `profile-demand`). It is optional on `profileClaimInputSchema` (`:212`) and on `inboxLeaseInputSchema` (`:259`).
  - Both objects keep `additionalProperties: false`, so other unknown fields are still refused.
  - Nothing reads either field: `observability-server.ts` still passes only `leaseToken`, `maxBatch` and `profileId` to `inboxLease`, and the owner store never writes `acceptedSourceKinds`.
  - The comment says the fields last one release. Retiring them later is the builder's stated follow-up.
- **My built-daemon probe** (`compat.mjs`, old Pi claim first), candidate `b60f207` against base `7a7a3af`. Earlier, the candidate refused the old Pi claim and lease with `Invalid RPC params`. Now:
  - Old Pi claim: claimed. Old Pi lease: ok. Plain lease: ok.
  - A plain claim after that is `rejected` because the profile is already owned; base gives the same answer.
- **Opposite order** (`compat2.mjs`: plain claim, then the old Pi re-claim with the current token, then both lease shapes). Candidate and base both give: plain claim claimed, old Pi re-claim reclaimed, both leases ok.
  - The stored `accepted_source_kinds_json` stays `["agent"]` on the candidate; base writes both kinds.
  - The legacy demand obligation stays `pending` and is never leased. `inbox get` prints the same output as base.
- **Builder's new test** (`test/integration/profile-delivery.test.ts:1558`, one test):
  - Over real daemon RPC it sends both old shapes and a list holding only `profile-demand`; agent outcomes are still delivered one per lease.
  - It also checks that a wrong token is still refused, that an unrelated extra field is still refused, and that `daemon.info` no longer advertises `profile-demand-v1`.
  - Each assertion checks behaviour, not source text.
  - Not checked in this probe: a lease from the old Pi carrying a real agent outcome through the separate daemon process. The in-process RPC test covers that.
- **My earlier suggestion is also covered:** the existing malformed-lease test (`claude-hook.test.ts:2669`) now sends a row whose `sourceKind` is not `agent` on its second lease. It passed.

## Checks (all with `env -i`, a fresh HOME and TMPDIR, the three Claude variables absent, Node 24.18.0, under `shepy-full-suite.lock`, started only at 1-minute load under 30)
- **Targeted run of six files, 92 s at load 18** (`profile-delivery`, `claude-hook`, `observability-contracts`, `cli`, `shepy-pi-profile-renew`, `shepy-pi-wake`): 307 tests, 305 passed, 2 failed.
  - The two failures are 5-second timeouts in `claude-hook.test.ts`: "a Stop on a lapsed owner recovers exactly once…" and "an empty-lease turn carries the failure marker…". The correction does not touch either test.
  - Rerun on their own at load 9, both passed, in 443 ms and 260 ms. This matches the load-related timeouts from the first review on both base and candidate. The red result is kept on record, not erased.
- **Typecheck and lint:** root typecheck passed in 6 s; Biome passed in 3 s.

## Still open (unchanged from the first review)
- F2 (factory side): remove the bootstrap sentence "verify both accepted source kinds after takeover", and drop the flag from `settings.json` after the install. Owner: the factory seat.
- Not checked in a live Claude or Pi turn. Ray's check that the seat still wakes and still receives worker outcomes after the install remains open.
- This is a Shepy candidate, so no factory land file was written.

## Noticed beyond my task
None noticed.

Probe sources and logs: `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-rev-shepytrim/92934ac0-39f8-4ddb-97b0-a70e173f34a8/scratchpad` (`bin/compat.mjs`, `bin/compat2.mjs`, `logs/compat*-cb2.txt`, `logs/targeted.json`, `logs/iso.json`).
