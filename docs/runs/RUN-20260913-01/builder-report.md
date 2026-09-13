# Builder report — RUN-20260913-01 / task 10a / attempt 1

## Candidate

- **sha:** `6291a60` (`6291a6027f2e09b00c2394ab8b876f2c564f9e79`)
- **branch:** `pilot/10a-ghost-owner` (base `0072155`, worktree `~/dev/shepy-wt/pilot-10a`)
- **`git diff --name-only 0072155..HEAD`:**
  ```
  packages/shepy-pi/src/index.ts
  src/cli/claude-hook.ts
  src/db/profile-owners.ts
  src/observability/profile-delivery-service.ts
  test/integration/profile-delivery.test.ts
  ```

## RED evidence

Verbatim failing assertions from step 2 (before any implementation change):

```
 FAIL  test/integration/profile-delivery.test.ts > profile.claim on a nonexistent profile > the service rejects the claim without creating a ghost owner
AssertionError: expected { kind: 'claimed', …(2) } to deeply equal { kind: 'rejected', …(1) }

- Expected
+ Received

  {
-   "kind": "rejected",
-   "reason": "profile_not_found",
+   "kind": "claimed",
```

```
 FAIL  test/integration/profile-delivery.test.ts > profile.claim on a nonexistent profile > over RPC the rejection reaches the caller unchanged
AssertionError: expected { kind: 'claimed', …(2) } to deeply equal { kind: 'rejected', …(1) }
```

The received object was a full `claimed` result including a minted `leaseToken` and the ghost
`owner` row (`profileId: "ghost"`) — the defect reproduced exactly as described.

## GREEN evidence

`perl -e 'alarm shift; exec @ARGV' 900 pnpm check` → **EXIT=0**. Last ~15 lines:

```
> shepy@0.5.0 prepack
> pnpm build

$ pnpm clean:dist && tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json
$ node scripts/clean-dist.mjs
$ node scripts/ensure-bin-executable.mjs
shepy@0.5.0: 257 files
$ pnpm --dir packages/shepy-pi typecheck && node scripts/check-pi-package.mjs
$ tsc --noEmit -p tsconfig.json
shepy-pi@0.5.0: 7 files
$ pnpm --dir packages/shepy-herdr-plugin typecheck && pnpm --dir packages/shepy-herdr-plugin package:check
$ tsc -p tsconfig.json
$ node check-package.mjs
```

**Test Files 54 passed (54) / Tests 545 passed (545)** — baseline 54 / 543 + 2 new tests.

Note: biome emits 3 warnings under `pnpm check`; verified present at base `0072155` too (stash +
re-run) — pre-existing, untouched.

## Call sites

`grep -rn 'lease_active\|kind !== "claimed"\|profile.claim' src packages test` — every hit, with
disposition. Call-site hits grouped by file; pure-`profile.claim`-string and test hits noted.

| Location | Hit | Disposition |
|---|---|---|
| `src/observability/profile-delivery-service.ts:226` | `this.#owners.claim(input)` | **MUTATED** — the service now checks `#profiles.getProfile(profileId)` first and returns `{ kind: "rejected", reason: "profile_not_found" }` without touching the owners table (R1/R2). |
| `src/db/profile-owners.ts:76` (+136) | `ClaimResult` union / store rejection | **MUTATED (type only)** — union extended with `{ kind: "rejected"; reason: "profile_not_found" }` (no `owner` field). The store itself never returns it; per R1 the existence check lives in the service, the store stays a plain owners table. |
| `src/daemon/observability-server.ts:465` (`profile.claim`) | `return { result: this.#requireDelivery().claim(input) }` | **NO CHANGE — verified, not assumed.** Pure passthrough: `profileClaimInputSchema` only requires `profileId: minLength 1` (so `"ghost"` reaches the service), and the returned `ClaimResult` is JSON-serialized as-is. RPC test proves the rejection arrives unchanged. |
| `src/cli/claude-hook.ts:426-436` (~400-440 claim block) | `result.kind !== "claimed" && …` / `result.kind === "rejected"` | **MUTATED** — added `reason?: string` to the wire type; new branch for `reason === "profile_not_found"` pushes an honest warning (`profile … does not exist on this daemon — nothing can be claimed or delivered; check the profile id`) and throws `profile claim rejected (profile_not_found)`. The `lease_active` path (`claimRejectionWarning`, self-recovering wording) is byte-identical to before. |
| `packages/shepy-pi/src/index.ts:948` (`handleProfileOn`, ~925-960) | `result.kind !== "claimed" && …` | **MUTATED** — the old message hard-coded "the active owner's lease must expire first" for ANY rejection. Now: `profile_not_found` → `Shepy profile claim rejected (profile_not_found) — no profile <id> exists on this daemon; check the profile id`; all other rejections keep the lease-expiry wording (now prefixed with the actual reason: `(${result.reason ?? result.kind ?? "unknown"})`). `ShepyProfileClaimResult.rejected` gained optional `reason`, propagated to the tool surface. |
| `packages/shepy-pi/src/index.ts:1370` (`formatShepyProfileToolText`) | `case "rejected":` | **MUTATED** — `profile_not_found` renders "no such profile exists on this daemon; check the profile id, try the corrected id once; do not retry the same id in a loop" instead of the false "an active owner holds it". `lease_active` text unchanged. |
| `packages/shepy-pi/src/index.ts:1052` | tool `promptGuidelines`: "A shepy_profile claim rejection names the current owner…" | **NO CHANGE** — static model guidance about the (dominant) live-owner rejection; the formatted result it summarizes is now honest per-reason. Flagging here for transparency. |
| `src/cli/claude-hook.ts:75,390,400,408` / `src/db/profile-owners.ts` other hits / `packages/shepy-pi/src/index.ts:925,955,1050,1091,1334` | comments, schema-probe, unrelated claim strings | **NO CHANGE** — comments or code paths whose behaviour is unchanged (stale-token lease_active flow is deliberately untouched per R4). |
| `src/observability/agent-orchestrator-service.ts:35`, `src/daemon/observability-server.ts:260,586` | `.claim(` hits | **NO CHANGE** — different feature (orchestrator scope claims), not profile ownership. |
| `test/unit/pi-profile-tool.test.ts:325-369` | mocks `profile.claim` rejected `lease_active` | **NO CHANGE** — exercises the untouched lease_active path; still green (asserts owner named + "do not retry"). |
| `test/unit/shepy-pi-env-claim.test.ts:147-236` | mocks `profile.claim` / `lease_active` | **NO CHANGE** — asserts ≥1 notification containing "claim rejected"; new messages still contain it. Green. |
| `test/unit/shepy-pi-profile-renew.test.ts`, `test/unit/shepy-pi-extension.test.ts` (many) | mocks `profile.claim` claimed/rejected | **NO CHANGE** — mock the untouched success/lease_active shapes. Green. |
| `test/integration/claude-hook.test.ts:566,707-769,1020` | hook claim capture / lease_active comment | **NO CHANGE** — exercises the lease_active path; green. |
| `test/integration/profile-delivery.test.ts` (~30 hits) | existing claim/lease_active RPC assertions | **NO CHANGE to existing tests** — all still green. **ADDED** `describe("profile.claim on a nonexistent profile")` with the two RED→GREEN tests. |
| `test/integration/observability-rpc.test.ts` | no `profile.claim` hits | Per packet instruction: it does NOT exercise `profile.claim`, so the RPC-level case (R3) lives in `profile-delivery.test.ts` next to the existing RPC claim suite. |

## Untested claims

- **Concurrent-claim race:** the existence check and the upsert are two statements, not one
  transaction. If a profile were deleted between `getProfile` and `owners.claim`, a ghost could
  still be minted. I believe this is unobservable in practice (profiles are created by the same
  daemon process; there is no profile.delete RPC path racing here), but it is not proven.
- **`profile.claim` schema rejection shape:** I verified passthrough for a *valid-schema, unknown
  id*. I did not test the daemon's error envelope for schema-invalid claims; unchanged code.
- **Pi tool text width/UX:** the new `profile_not_found` tool text is unit-tested only insofar as
  the full suite stays green (no test asserts the new string specifically); the two new integration
  tests assert daemon behaviour, not downstream renderings.
- **claude-hook `profile_not_found` path end-to-end:** the hook change is typechecked and the
  hook's existing suite is green, but no test drives a `profile_not_found` rejection through the
  fake-daemon hook harness (the packet did not require it; the branch mirrors the tested
  `rejected` branch shape).
- **Live-daemon behaviour:** everything is proven against `rpcFixture` (real server + real SQLite);
  nothing was run against the live daemon at `~/.shepy` (out of scope per packet).

## Limitations / follow-ups

- **The defect's root is schema-level:** `profile_owners.profile_id` has no FK to
  `orchestrator_profiles`, so any writer that bypasses the service can still mint ghosts (and any
  ghost rows already in live DBs are not swept — both explicitly out of scope). A follow-up
  migration adding the FK (after a one-off ghost-row cleanup) would make the invariant durable at
  the storage layer; the service check then becomes defence-in-depth.
- **`ClaimResult` narrowing ergonomics:** the union now has two `rejected` members discriminated by
  `reason`. Callers over the wire (hook, Pi) parse untyped JSON with `reason?: string`, so an
  unknown future reason degrades to the lease-expiry wording there. A shared wire-level schema for
  `ClaimResult` would close that, but is beyond this task's scope.
- **Pi prompt guideline** ("a claim rejection names the current owner") is now imprecise for the
  `profile_not_found` case; wording could be updated in a docs-pass.

## Time spent

~35 minutes wall clock (orient + read: ~10, RED: ~5, implementation + call sites: ~10, check/fix
cycles: ~5, review + commit + report: ~5).

## Revision 1

- **New sha:** `b19804c` (on `pilot/10a-ghost-owner`, on top of `6291a60`; NOT amended)
- **Files changed:** `test/unit/pi-profile-tool.test.ts`, `test/integration/profile-delivery.test.ts` — tests only, zero source/package changes needed to make it testable.
- **Mutation-c proof (verbatim failing test names, both branches reverted):**
  ```
  FAIL  test/unit/pi-profile-tool.test.ts > shepy_profile tool result text > a profile_not_found rejection names the misconfiguration, never a live owner
  AssertionError: expected 'Shepy profile driffs was not claimed …' to contain 'no such profile'

  FAIL  test/unit/pi-profile-tool.test.ts > shepy_profile tool execute() boundary > a profile_not_found claim rejection reports the reason through notify and text
  AssertionError: expected [ [ …(2) ] ] to deep equally contain [ StringContaining{…}, 'error' ]

  Test Files  1 failed (1)
        Tests  2 failed | 12 passed (14)
  ```
  Coverage of the two branches individually: the formatter revert is caught by the first test (and
  the text assertions of the second); the `handleProfileOn` notify revert is caught by the second
  test's notify assertions (`profile_not_found` must appear, "lease must expire" must not). The
  mutation was applied, tests run, then the source restored via `git checkout --` (verified green
  14/14 afterwards; working tree contained only the two test files).
- **Whitespace probe promoted** into `test/integration/profile-delivery.test.ts` as
  `a whitespace-only profileId survives the RPC schema and is still a typed rejection`: over the
  real RPC socket, `profileId: " "` passes `profileClaimInputSchema` (minLength 1), reaches the
  service, and returns exactly `{ kind: "rejected", reason: "profile_not_found" }` with
  `profile_owners` still empty. Adapted from the verifier probe, whitespace case only; the
  deleted-profile seam remains a tracked follow-up, not built here.
- **GREEN:** `perl -e 'alarm shift; exec @ARGV' 900 pnpm check` → EXIT=0.
  **Test Files 54 passed (54) / Tests 548 passed (548)** — 543 baseline + 2 (attempt 1) + 3 (revision).
- **Time spent:** ~10 minutes wall clock (tests ~4, mutation-c apply/run/restore ~3, check+commit+report ~3).
