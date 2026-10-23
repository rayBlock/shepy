# Review SHEPYQUIET (row 15.415, Shepy) — rev-quiet-glm

**ACCEPT** — candidate `46810b776f755a3e8e17e36f0f02d3780e912888` (branch `night/shepyquiet`, base `b576f26`), scope: silent departure of settled workers, truthful wake labels, unchanged delivery otherwise. Read the full diff and builder report first; attacked through real index refresh, delivery projection, inbox lease and real socket frames in detached clones (`/private/tmp/factory/rev-quiet-glm/`, mode 0700, `env -i`, fresh HOME/TMPDIR, Node 24.18.0 first on PATH, no Claude env).

## Findings

No defects in the target behaviours. Every attack held:

- Settled close (done/idle/blocked × pane.closed and pane.exited-into-shell) creates no obligation, no wake, no leased outcome; the `agent.gone` audit row is still recorded once with `from` = the settled status (`src/observability/agent-index-service.ts:328-336` departure attribution, `src/observability/profile-delivery-service.ts:332-343` suppression). Verified with my own probes plus the candidate's 6-case table.
- Order variations: done left unconsumed then close (done obligation survives, lease shows only done); daemon restart between done and close (durable, still silent); two workers one settled one working (settled silent, working gone exactly once); wake-service restart mid-sequence (no re-send; unfinished gone still wakes once as `gone without finishing`).
- Wake text: `2 finished: builder, helper`, `1 gone without finishing: vanisher`, mixed batch `2 finished: …; 1 blocked: …; 1 gone without finishing: …; 1 tool failed: …`; sanitization, 240-char cap, owner-self exclusion and attempt fencing unchanged (`src/daemon/claude-idle-wake-service.ts:110-143`).
- Delivery otherwise unchanged: done/blocked/tool.failed projection, Pi inbox lease, subscription removal on departure, `NOTIFIABLE_EVENT_TYPES` membership — only the gone guard and the label grouping changed in delivery.

Notes (no action required): [cosmetic] `count` counts obligations while `names` is a deduped set, so two same-name obligations render `2 finished: builder`; [pre-existing] the 240-char cap can cut later groups of a very large mixed batch; [documented tradeoff, README ¶] a subscription created after a worker's settled event gets no departure notice at all; [pre-existing] a done pending history-retry at daemon restart is lost in memory, so a close then attributes `from=working` and says `gone without finishing` — honest to the durable record.

Tests (R04): +1 six-case parameterized guard (status × departure kind, both real axes), +1 mixed-wake guard, 7 existing tests updated to the new contract; three recovery tests now commit fixture status with the event as production does. No pinning of internals; count is proportionate.

## Checks (all in `env -i` with fresh mode-0700 HOME/TMPDIR, Node 24.18.0)

| Check | Result | Wall |
| --- | --- | --- |
| Focused `agent-lifecycle` + `claude-hook` on candidate | 193 passed | 24.5 s |
| Same two files on base `b576f26` (candidate tests) | 14 failed / 179 passed — red proof | 26 s |
| My 3 independent probes on candidate | 3 passed | 0.8 s |
| My 3 probes on base | 3 failed at the target behaviours | 0.2 s |
| `tsc --noEmit -p tsconfig.json` | Passed | 3.5 s |
| Biome `check .` + `format .` | Passed, 167 files | 0.3 s |
| Full Vitest suite via `lockf -k /private/tmp/shepy-full-suite.lock` | 1,187 passed / 76 files | 64.3 s |

Full-suite disclosure (R06): two earlier runs failed only on my harness — a symlinked external `node_modules` (`run-tests.test.ts` refuses an out-of-repo vitest entry) and a reused TMPDIR (EEXIST on the socket-length probe's directory); after copying real `node_modules` into the clone and using a fresh TMPDIR, the same suite passed with identical counts (1,187/76) to the builder's. No candidate test was edited.

## Cost, limitations, next owner

No new polling, schema or retained data; grouping is O(pending obligations) per wake. Full suite: 19.6 s user, 11.4 s sys, ~1 m wall under the lock. Probes ran on fixture histories of a few events; long-history batching not re-measured (builder's numbers stand, not re-verified). Live daemon, profiles and Herdr untouched; no live-use grant — integration and live acceptance stay with the seat. Land-review artifact written: `/Users/ray/.factory/land/review-15.415.json`.

**Noticed beyond my task**: none beyond the builder's `scripts/run-tests.mjs` socket-suffix budget note (owner: test-runner seat).

Disposition: ACCEPT
