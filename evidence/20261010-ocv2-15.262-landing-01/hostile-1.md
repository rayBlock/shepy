# HOSTILE review — 15.262 OPENCODE-V2-HISTORY (flash lens)

- Candidate: b63d40f `Bind OpenCode history by exact ID across V1 and V2 stores` (HEAD of spawn/opencode-v2, clean tree, no push)
- Reviewer identity: provider=qwen-cloud model=deepseek-v4-flash-0731 thinking=high (receipt 486e5d63...)
- Row spec (queue 15.262 c07e61c3...): bounded adapter — paired V1/V2 fixtures, exact provided-ID parity, honest refusal without native identity, V1 preserved, fail-closed storage. No live migration/daemon.
- Baseline from the build report: 66 files / 736 tests green at b63d40f.

## Fresh verification run (TMPDIR=/private/tmp/ocv2/htmp2, mkdir'ed fresh)

- `tsc --noEmit -p tsconfig.json` → exit 0, no errors.
- Paired/related suites (5 changed test files): 47/47 passed (opencode-v2-history, agent-history-discovery, agent-history-readers, agent-history-service, observability-rpc).
- Full Vitest suite (regression net over the whole repo): 66 files / 736 tests passed, 17s.
- 25 adversarial probes (mine, script hostile-1-probe.mjs sha256 15bdf913…) + 1 V2-unparseable-JSON probe (hostile-1-probe2.mjs sha256 5d505135…): all PASS, log /private/tmp/ocv2/out/hostile-1-probes.log sha256 e94a6aa8…

## Heart BY NUMBER

**(1) Paired V1/V2 fixtures — SURVIVES.** Committed fixtures construct V1-only / V2-only / mixed stores in-test; discovery+reader resolve the same logical message under both schemas. Duplicate-ID V2 preference is implemented in BOTH layers (discovery probes `session_v2` before `session`; reader returns V2 when the exact id is in `session_v2`) and my probe P1 put the SAME id in both tables with distinguishable content — discovery resolved the dup id and the reader returned the V2 payload (`hello-v2`), never V1 (`hello-v1`). Gap: the committed suite itself does not assert same-id-in-both-tables; behavior is covered only by my external probe. Not fatal; recording as a coverage note.

**(2) Exact provided-ID discovery/reader parity — SURVIVES.** Discovery and reader both probe both families by the exact id with no ordering/scope divergence; P2 (V2-only store) and P3 (transition store, id only in V1) resolve in discovery and read the same message in the reader; absent id → discovery null AND reader rejects "exact session not found" (P2). OPENCODE_SESSION_ID path (`agentSession.kind === "id"`, source opencode-sqlite) flows to `discoverOpenCodeSession` for V1 and V2 alike.

**(3) No exact identity = honest refusal; cwd-latest never a pinned live session — SURVIVES.** The `session`-by-`directory` `time_updated desc` fallback query is gone from src (grep confirms no surviving `directory = ?` / `time_updated desc` for opencode anywhere in src/agent-history). `if (agent === "opencode") return null;` and `discoverOpenCodeSession` requires a non-empty sessionId (P7: empty id → null, service null). The old discovery test was renamed to "refuses OpenCode cwd-latest and resolves only an exact V1 ID", the integration RPC expectation flipped from cwd-latest `oc_1` to `{ historyRef: null, messages: [] }` with comments naming the pre-ruling behavior.

**(4) V1 support preserved — SURVIVES.** Full fresh serialized suite 66/736 green; the untouched V1 reader tests (message/part text+tool, roles, limits) still pass; my P3 reads V1 content from a mixed V1+V2 transition store. Existing expectations changed only where the old contract WAS the defect (cwd-latest, silent-empty on unreadable schema), each with a comment naming the pre-ruling behavior.

**(5) Fail-closed malformed/missing store — SURVIVES.** Missing db file → discovery null; non-sqlite garbage file → reader rejects ("file is not a database") and discovery null (P6); V2 unsupported shape → reader rejects "unsupported V2 message shape" (committed test + P8). One nuance probed honestly (probe2): *unparseable* V2 JSON rejects out of the reader with the raw JSON SyntaxError, not the nicer "malformed V2 message" label (that label only fires for parsed-but-non-object data); service still fail-closes both read and compact to historyRef null / 0 messages. Cosmetic label inconsistency, not a correctness failure.

**(6) Service hint-bypass fix — SURVIVES.** `hintAllowed` no longer returns true for `!agentSession`: any cached opencode-sqlite hint is refused on both the read and compact paths (P4: stale cwd hint → historyRef null, messages 0, count 0). A `discovered_file`-kind hint is rejected even when its value equals a real stored id (P5 — kind must be `agent_session`), and an `agent_session` hint still validates by exact re-probe (P4: matching id true, absent id false). Committed service test asserts 2 discoveries and zero reader invocations for the stale-hint attempt.

**(7) V2 JSON decode honestly labeled — SURVIVES.** Source comment in opencode-reader.ts: "V2 JSON shape is fixture-validated only; live session_message shape remains UNKNOWN until a readable live V2 store is available…". Build report names the fixture-only boundary and the follow-up owner (compare with a readable live V2 store before claiming live-shape support). The fixture shape (`role`, `parts[]`, `session_message.session_id`, `time_created`) is also tolerant of string `content` (P8 passes) without pretending live-shape knowledge.

## Hostile intent check

I attacked the candidate from outside its own tests (external probles, not committed): dup-id preference, transition store, empty id, stale cached hint through the real service on both paths, discovered_file-kind usurpation, garbage/missing store, unparseable and unsupported V2 payloads. No path converted an unknown into silent-empty history, and no path let a cached cwd hint defeat refusal. No new stores, no migration, no daemon — source-packet-bounded as specified.

## Limitations

- V2 live-shape remains UNKNOWN by explicit label (bounded adapter); no live opencode 2.x DB was available to me either — follow-up owner remains the named party in build-1.md.
- Committed suite does not assert duplicate-ID-in-both-tables; my probe covers it, adding it to the committed suite would harden the regression net (recommendation, not a blocker).
- Error-label polish for unparseable V2 JSON (raw SyntaxError vs "malformed V2 message") is cosmetic.

## VERDICT: SURVIVES

- Candidate: b63d40f (spawn/opencode-v2, HEAD, clean, unpushed)
- Scope: 7 brief points, fresh tsc, 5 related suites, full 736-test suite, 26 external adversarial probes
- Evidence: /private/tmp/ocv2/out/hostile-1-probes.log (e94a6aa8…), probes 15bdf913… / 5d505135…; ran at commit b63d40f only
- Disposition: LANDED-eligible after 15.261 gating per queue; landing may proceed on the reviewer lane
- Limitations: see above (V2 live-shape UNKNOWN, dup-id committed-test gap, error-label cosmetics)
- Unresolved owner / next consumer: live-V2-shape verification follow-up named in build-1.md remains open for whoever lands this row