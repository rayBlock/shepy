# Review: SHEPYGREEN — rev-shgreen (GLM)

**ACCEPT.** The three test-only fixes keep guarding what they guarded: every brief-mandated mutant attack goes red at exactly the guarded tests, the two Codex fixtures match the producer shape the untouched suite already pins, and no production file, test or timeout changed. Scope: test-fix commit `9583898` plus report commit `09c52bb`, base `7aa8adb`, files `test/unit/agent-history-readers.test.ts`, `test/integration/observability-rpc.test.ts`, `test/integration/notice-correctness.test.ts`. This accepts the fix quality only; the builder's open three-green-suite requirement stays with the seat.

## Findings

1. **INFO** `test/integration/notice-correctness.test.ts:618` — P5 "a flushed next-user record cannot deliver the previous settled text" timed out at 5000 ms in 1 of my 5 trio runs (load 12-16; other suites running). Consequence: one more instance of the load-sensitive 5000 ms class, in an unchanged test body; passes alone in 603 ms and in the other 4 runs. **Not in the builder's timeout catalog** — the later timing row should add it. Reproduction: run the three files under load ~15; not deterministic.
2. **INFO** Full-suite reds under `lockf -k /private/tmp/shepy-full-suite.lock` (load 25.6→18.7): `notice-correctness.test.ts:513` snapshot rollback and `profile-subscribe.test.ts:310` daemon-boundary, both 5000 ms timeouts, both already in the builder's catalog (R2, R3). No assertion failure in any repaired cause.

## Attacks (scratch copies under `/private/tmp/rev-shgreen`, named once)

- **cwd-only discovery re-enabled** (deleted the `if (!input.agentSession) return null;` refusal, `src/agent-history/discovery.ts:48`, restored the pre-`2a0bade` ranking): exactly 2 tests red — both new no-id negatives fail on their own assertion (`historyRef: null` expected, `discovered_file` ref returned): readers "is registered in the default agent history service" and rpc "reads additional runtime histories through agent.read". The negatives guard the refusal.
- **Settle wait moved inside `#enqueueSessionOperation`** (`src/observability/agent-index-service.ts:684` → inside the queue callback): 15 reds, led by all three "one real delayed re-read repairs … without blocking another pane" cases timing out — the held slow-pane wait deadlocks the fast pane. The gate proves queue independence, not scheduler latency.
- **Serial waits** (`Promise.all` over pendingStatuses → sequential `for…of`): the five-pane test times out at its all-five-waiting barrier; serial waits can never reach it. "five-agent startup" also red.

## Checks (wall times; `env -i`, fresh mode-0700 HOME/TMPDIR, Node 24.18.0 first on PATH, CLAUDE* absent)

- Three files, 5 runs (brief asked 3): 4× `52 passed` green (11-21 s); 1 run red = finding 1 (29 s).
- `tsc --noEmit -p tsconfig.json` exit 0 (4.7 s); Biome `check .` and `format .` exit 0 (5.4 s).
- Full suite under lockf: 1141 passed, 2 failed (both cataloged), 82 s.
- Mutant runs red as above (1.1 s / 81 s / 19.8 s).
- Producer shape: `session_meta.payload.id` is what `CodexHistoryReader.matchesSession` verifies (`src/agent-history/codex-reader.ts`) and what untouched fixtures already model (`agent-history-discovery.test.ts:59`, row-15.309-S3 "mirror real Codex rollouts" fixtures); the rpc positive asserts `historyRef.value === codexSessionId`, so the id-bound path, not a path-equality shortcut, is exercised. Gemini `sessionId` matches `scanGeminiRoot`'s exact-ID read.

## Census and limits

- No production file changed (`git show --name-only` both commits: tests + report only); no test deleted or added — identical title census 16/9/18 per file; no timeout raised (no `timeout` string in any test hunk; `vitest.config.ts` untouched). Removed wall-clock assertions in the watch and P6 tests are covered by their surviving publication-order assertions; the startup and fresh tests now assert zero retry sleeps, which is strictly stronger than sub-400 ms.
- Limits: single machine, shared load 12-26; I did not re-run the builder's full `pnpm check` gates (typecheck, lint, both named files and full suite cover the review question); the builder's scratch and its frozen patch hashes were not re-derived.
- Next owner: the Shepy seat — suite-green acceptance and the load-sensitive timeout class (now including P5, finding 1) belong to the later row the builder named.

**Noticed beyond my task**: none noticed beyond finding 1.

rev-shgreen done: evidence/night/review-SHEPYGREEN.md
