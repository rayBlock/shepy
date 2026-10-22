# Review: SHEPYTRIM (row 15.363), remove Shepy's unused profile-demand feature

Reviewer: rev-shepytrim (Claude Opus), adversarial, blinded to the builder's conclusions until after the diff was read.
Candidate: code `e3d8e38`, report `331bacc`, base `7a7a3af`. Review branch `night/rev-shepytrim`.

**ACCEPT WITH FIXES.** The live Claude hooks are safe. On both base and candidate, the exact factory hook line gives byte-identical stdout for prompt, Stop and SessionEnd, and exits 0. The database is untouched, and the suite shows no new failure. One fix is needed before the install: if a Pi session is already running with the old extension when the daemon restarts, the new daemon refuses its claim and lease requests (F1).

## Findings

**F1, medium, defect: an old Pi extension already loaded is refused by the new daemon.** `src/observability/schemas.ts:204` (`profileClaimInputSchema`) and `:248-254` (`inboxLeaseInputSchema`) dropped `acceptedSourceKinds` and `sourceKinds` but keep `additionalProperties: false`. Today's live daemon advertises `profile-demand-v1`, so every Pi that claims through the base extension sets `demandCapable` and sends both fields on each lease and each lapse re-claim (base `packages/shepy-pi/src/index.ts:546,717`). Against the candidate daemon both calls answer `Invalid RPC params`; the base daemon accepts them. The Pi pump treats that error as transient (`// transient daemon error: the timer retries`). Its renew call has no such field, so the pane keeps ownership while every 10 s lease fails, and worker outcomes stop silently. A Pi that claimed from `SHEPY_PROFILE` recovers on reconnect, because `claimFromEnvironment` re-probes `daemon.info`. A Pi that claimed through `/shepy on` or the `shepy_profile` tool stays stuck until it reloads.
Reproduction: `scratchpad/bin/compat.mjs <root> <base-root>` against each built daemon. Base: claim ok, lease ok. Candidate: `oldPiClaim` and `oldPiLease` give `Invalid RPC params`; the plain claim and lease are ok.
Fix (recommended): accept both fields as optional and ignored for one release, the same way the CLI flag is handled. The other option is an install step that restarts every Pi holding a profile after the daemon restart.
Not checked: which live Pi sessions hold a profile today (the live daemon was not touched).

**F2, low, factory follow-up (not candidate code).** `/Users/ray/dev/agent-factory/.claude/engine-coordinator-bootstrap.md:31` tells the seat to "verify both accepted source kinds after takeover". After the install, `shepy profile owner` no longer prints `acceptedSourceKinds`, so that check cannot pass. The builder's handoff names only removing the flag. The seat should drop that sentence too.

**Brief and acceptance-check corrections (no defect).** The factory hook line has no `--profile`. It is `shepy claude-hook --profile-demand` with `SHEPY_PROFILE`, and it runs on SessionEnd, Stop and UserPromptSubmit (`agent-factory/.claude/settings.json:19,30,45`). I probed that exact form. The driffs seat's hooks (`factory-driffs/.claude/settings.local.json:27,38`) do not pass the flag at all.

**Suggestion.** The hook still refuses a lease row whose `sourceKind` is not `agent` (`src/cli/claude-hook.ts:1182`), but every test of that path was deleted with the demand tests. One existing malformed-lease test could carry that row shape. This is optional.

## Checks (all run with `env -i`, a fresh HOME and TMPDIR, the three Claude variables absent, and Node 24.18.0)
- **Live hook form, real built daemons:** I seeded two worker outcomes, then ran prompt, Stop, prompt and SessionEnd with `SHEPY_PROFILE=engine-coordinator`, with and without the flag, on base and candidate. All four runs give the same stdout hashes: both outcomes are injected on the first prompt and the owner is released at SessionEnd. Only the candidate run with the flag adds one stderr line per event. A new hook against the old daemon gives the same result.
- **Parser:** the flag alone, repeated, or before or after `--profile` gives exit 0 and one note. `--profile-demandx`, `--bogus` and `--profile-demand=1` exit 1 with the usage error, as on base. Without a daemon, stdout is empty for all three events.
- **Database:** the diff leaves `drizzle/`, `schema.ts`, `apply-migrations.ts`, `migrate.ts` and `sqlite-migrations.test.ts` unchanged. On a migrated database seeded with one demand event and one demand obligation, the candidate daemon starts. `inbox list` and `inbox get` print the same output as base (`event: UNKNOWN`). The row is never leased, and both rows are unchanged afterwards. The idle-wake filter (`claude-idle-wake-service.ts:93`) still skips rows with no agent event.
- **References:** a grep of src, packages (Pi and Herdr plugin), scripts, README, README.ja, docs and skills finds only the kept schema and migration paths and the flag shim with its test. In the factory `tools/` and `.claude`, only `settings.json`, the bootstrap note and an archive-path fixture match.
- **Typecheck and lint (candidate):** root 8 s, Pi 4 s, Herdr plugin under 1 s, Biome 2 s; all pass.
- **Full suite, back to back under the factory gate lock** (2,777 s lock wait; load average 17 to 33):
  - Base: 1,285 tests, 44 failed, 122 s. Of these, 37 are demand-validation tests (removed by the candidate), 2 are the known Codex fixtures, and 5 are timeouts or timing misses.
  - Candidate: 1,142 tests, 11 failed, 126 s. Of these, 2 are the same Codex fixtures and 9 are timeouts or timing misses that base passed.
  - Paired reruns of the four files involved (base, candidate, base, candidate) under `shepy-full-suite.lock`, load 7 to 15: base failed 3 and 3, candidate 1 and 2, all different tests. All 9 candidate-only failures passed in both candidate reruns.
  - Base also missed `notice-correctness` timing limits (502 ms against 450). The builder's timing finding is pre-existing load flakiness, not new.
- **Tests:** the candidate adds one test, `test/unit/cli.test.ts`, the flag test. It checks real parse results, a single stderr note and refusal of unknown flags. Its last assertion (`not.toContain("--profile-demand")` on the help text) pins wording, which is acceptable. The deleted tests are all demand cases; no agent-only case was lost apart from the suggestion above.
- **Cost:** no runtime state is added, and the hook makes one fewer `daemon.info` probe per event (builder's measurement; I did not re-time it).

## Limitations and next owner
- Not checked in a live Claude or Pi turn. I did not confirm that Claude Code never shows the stderr note to the model; that is documented behaviour for exit 0. Ray's live wake check stays open after the install.
- Next owner: the builder fixes F1 or the seat adopts the Pi-restart install step, then a recheck of the two schemas. The factory seat handles F2 when it removes the flag.

## Noticed beyond my task
- The acceptance check quotes hook lines (`settings.json` 21 and 36, with `--profile engine-coordinator`) that do not match the current file. Future briefs should quote the file as it is. Owner: the seat.

Probe sources and logs: `/private/tmp/claude-501/-Users-ray-dev-shepy-wt-night-rev-shepytrim/92934ac0-39f8-4ddb-97b0-a70e173f34a8/scratchpad` (`bin/`, `logs/`).
