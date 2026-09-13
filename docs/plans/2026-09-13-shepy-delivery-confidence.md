# Shepy — delivery confidence and code in order

**Status:** ACTIVE. Supersedes the ad-hoc "Group 1–4" fix list. Ray 2026-09-13:
*"we adapt shepy how we need it and code in order and nice. Not some bloated AI
slop. proper code that works for our needs and is clean. also refactoring yes."*

**Goal:** Make delivery trustworthy and the code clean, in that order. A worker
outcome must provably reach its owner or be provably still pending — never
silently acked, never silently stranded.

**Origin:** An independent review by `openai-codex/gpt-6-astra`
(`/tmp/astra-proposal.md`, 97 kB) was dispatched specifically to disagree with
ops' fix list. It did, on five points, and three of its findings were verified
against the code by ops before this plan was written. Its central correction:
the previous list was housekeeping-led while real, already-supported failure
mechanisms were unaddressed.

---

## What ops had wrong

Recorded because the errors are instructive, not for penance.

| Claim | Reality |
|---|---|
| The 20-outcome render/ack mismatch was fixed by the budget change | **Still live.** `claude-hook.ts:578` records every leased id; the formatter renders only what fits. Lease 20 → render 2 → ack 20. The truncation note points at an inbox where those rows are now `acked`. Reviewers reading diffs missed it; a probe found it |
| `WAKE_POLICY` had drifted between the hook and the Pi extension | **Byte-identical** in this checkout. Carried forward from a round-2 finding that round 3 had already fixed |
| Nothing enforces `EXPECTED_VERSION` | **False.** `scripts/check-pi-package.mjs:51` compares it to the packed version and `pnpm check` runs it. A lone manifest bump fails |
| `typebox` should move from peer to dependency | **Dropped** (Ray, 2026-09-13). `docs/releasing.md:3,100` says source-only and "No `npm publish` — for any package, ever", so the premise of an npm consumer was wrong. The real defect is that README, AGENTS and the package checks all describe npm publication |
| The hook's charset enforcement holds | **Only for identity fields.** The outcome schema accepts arbitrary excerpt text and `outcomeLine` passes it through; a probe retained U+202E and U+200D in hook output |
| Sweeping lapsed owner rows is harmless cleanup | **Not harmless, not a prerequisite.** It changes Claude `Stop` after a long turn, changes claimed/reclaimed reporting, and destroys last-owner evidence |

## Order of work

Each numbered item is a packet with its own worktree, adversarial review, and
landing gate. **Serial where files touch** — most of these share
`src/observability/profile-delivery-service.ts`.

### 1. Selection and delivery must agree about ambiguity — *highest value, small*

`ProfileService.resolveSubscriptions` resolves a selector against the full
session/workspace candidate set. `ProfileDeliveryService.projectAgentEvent`
calls `resolveAgentSelector(selector, [agent])` — a **single-element array**, so
it can never see a second match. Probed: two Pi agents with identical cwd and a
`runtimeKindPlusCwd` selector; the full resolver said `ambiguous`, and
projecting one agent's completion still created an obligation.

This defeats the project's own stated contract — *"Profile resolution is always
fail-closed: zero matches / ambiguity / unstable-target / target-lost are
distinct named failures; no first-match"* (`AGENTS.md` lineage). The inspection
surface is honest; the delivery path is not.

Fix: one scoped resolver used by both, whose unique result must equal the event's
agent. Cover duplicate kind+cwd, duplicate names, pane movement, replacement.

### 2. Represented set must equal acknowledged set — *highest value, small–medium*

`LEASE_MAX_BATCH = 20`; `formatHookContext` clips whole outcomes to the
6,000-char budget; `handlePromptSubmit` / `handleStop` persist and later ack
**every** leased id. Probed: twenty 2,000-char excerpts rendered two outcomes and
"18 more", then acked all twenty.

Fix: the formatter returns the ids it actually represented. Either fit a bounded
per-id summary for every delivered row, or lease a smaller batch and return the
omitted rows **without burning failure attempts** — the five-attempt cap
dead-letters, so naive nacking trades silent loss for silent retirement. The
render budget, the batch size and the attempt cap are one design, not three.

Also needed so the truncation hint is not a dead end: `inbox get <id>` for the
immutable excerpt, and cursor pagination (`inbox list` defaults to the newest 50).

### 3. One admission rule for lease expiry — *high, medium*

`ProfileOwnerStore.renew` rejects a lease past grace. `ProfileDeliveryService.inboxLease`
checks token equality **only, not time** — probed: an owner expiring at t=0 was
still admitted at t=1,000,000. Pi renews every 10 s; Claude claims only on prompt
submission and never renews during a long turn.

So: a long Claude turn can outlive its lease, after which another harness may
legitimately take the profile — and a lapsed-row sweeper would make that Claude's
closing `Stop` fail even with no contention. Decide one rule, then add an explicit
long-turn recovery/reclaim path for the hook. Pin both the contention and the
no-contention cases **before** tightening expiry anywhere.

### 4. Durability begins too late — *high, medium*

`AgentIndexService.#appendStatusEvents` commits events; the daemon later projects
them via `onAgentEvent`. A crash between the two leaves an event with no
obligation and nothing replays it — and `#appendStatusEvents` returns early for
unchanged status, so a refresh is not a general repair.

Fix: commit event and projection atomically, or add a transactional
outbox/checkpoint with idempotent replay. Replay must use the
subscription-at-event-time, not today's roster applied to old history.

### 5. A silent owner must be explainable — *high, small first slice*

There is no single answer to "why did this outcome not reach its owner". Add
read-only `profile diagnose` and `inbox explain` / `inbox get`, joining binding
resolution, owner freshness, delivery capability, queue age and counts, attempts,
the event snapshot and the last transition. Report the **running daemon's**
build and boot id, not the CLI's on-disk version.

Known wrong signals to fix while here: the hook checks *enabled* subscriptions
rather than *matched* resolutions; Pi's `pendingCount` is the leased batch size,
not queue depth; `retire` writes `acked` with no durable reason, so an operator
discard is indistinguishable from a delivery.

### 6. Owner-file persistence is not a cross-process CAS — *high, medium*

`writeOwnerFileIfUnchanged` does read → check → write; two hook processes can
both pass the check before either writes, and `writeOwnerFile` truncates in
place, so a crash after truncate destroys the token and ack record. Also
`ownerFilePath` maps distinct profile ids (`a:b`, `a_b`) onto one filename.

Fix: serialized per-(session, profile) access, atomic replace, bounded lock
behaviour, collision-free key. Test with real separate processes. Never hold a
lock across an unbounded RPC.

### 7. Connected is not responsive — *high, small–medium*

`ReconnectingDaemonClient.request` is unbounded, so an open non-answering socket
leaves Pi requests pending forever. `pumpProfile` awaits renew *before* the
in-flight gate, so ticks accumulate. Claude has several sequential 5 s deadlines
but no total hook deadline. And repeated busy nacks or startup invalidations burn
the same five-attempt budget that dead-letters real work — so harness-busy and
daemon-recovery must be distinguishable from delivery failure.

### 8. Worker disappearance is silent — *high, small first slice*

`NOTIFIABLE_EVENT_TYPES` excludes `unknown` and documents the gap. Add a
semantic lost/stale notification with debounce and recovery, separate from
successful completion, and carry packet/operation identity into outcome
snapshots so an outcome can be correlated with what was dispatched. Keep packet
acceptance in the lead's ledger; **do not build a scheduler into Shepy.**

### 9. Refactor once the invariants have tests — *real debt, not urgent*

Ray has authorised refactoring. Do it after 1–8, because a mechanical move
before behaviour is pinned buys nothing. Target shape — note the destination is
**not** the daemon, which must never learn Claude rendering policy:

- CLI keeps stdin/stdout/exit-code behaviour only;
- a hook application service owns the orchestration transitions;
- an adapter owns credential I/O;
- a presentation module owns pure budgeted formatting, shared with the Pi
  extension so `WAKE_POLICY` cannot drift again.

### 10. Smaller, real items

- Reject a claim for a nonexistent profile in `ProfileDeliveryService.claim`
  (today it creates a ghost owner that can never receive anything).
- Retain ownership-transition history so a post-expiry takeover is
  distinguishable from a reconnect. Changing the response word without
  retaining the transition does not create an audit trail.
- Apply one tested display policy across harnesses: **escape or isolate** bidi
  controls rather than deleting them. driffs ships Arabic; blanket stripping of
  bidi marks and ZWJ would corrupt legitimate text and emoji.
- Reconcile the release documents (source-only vs npm publication) before any
  release work.
- The two pre-existing biome warnings in `test/integration/operation-wait-rpc.test.ts`.

## The trust boundary, stated honestly

The owner lease token protects **lease consumption**. It does not authorise
`profile.subscribe`, `inbox.retire` or `operation.dispatch` — those have no
ownership check in `ObservabilityRpcServer`, and same-user agents are not
OS-isolated from each other. Either explicitly trust local CLI clients and bound
what worker packets are allowed to call, or add scoped management capabilities.
Do not claim that lease-token secrecy makes every daemon mutation
owner-authorized.

## Not being built

Automatic owner election. Multi-owner reaction. A message broker. A dashboard
before CLI diagnostics. Universal Unicode stripping. Any dependency on an
undocumented Claude messaging socket. A scheduler inside Shepy.

**The idle-Claude gap is reclassified:** acceptable as an adapter limitation,
**unacceptable as a claim of unattended orchestration.** A worker often finishes
just after the lead dispatched and stopped, and `handleStop` injects only once
per continuation chain, so a result arriving during the follow-up also waits. Use
a Pi lead where idle wake is required until an explicitly armed, task-correlated
wake mechanism is verified in the real Claude harness.

## Progress

- **Observability surface LANDED** `dc96fef`: `shepy profile owner` (renders
  valid / in-grace / `lapsed — claimable`, never prints a token), `retire` added
  to `inbox --help` — it was the only parse-but-not-listed verb in the whole CLI
  — and a derived help census (`COMMAND_GROUP_VERBS` / `TOP_LEVEL_COMMANDS` are
  now the source of truth the parsers read, so help and parser cannot diverge).
- **Item 1 (selector ambiguity) LANDED** `27d1158`: both paths now resolve through
  `src/observability/profile-selector-scope.ts`. RED was real — an ambiguous
  selector projected 2 obligations (`expected 2 to be +0`). Ops mutation-tested
  the identity gate: removing it fails *"a unique match naming worker-a never
  projects worker-b's event"*. Also established that two live agents CAN share a
  `name` (the only unique indexes are `(session, pane)` and `(session, terminal)`),
  so the duplicate-name case is real, and removed a duplicated `recordToRow` plus
  a redundant second `agents.list()` in the inspection path.
- Item 6 (owner-file CAS) in flight on `ops/owner-file-cas`.
- The lapsed-row sweep stays **held** on `ops/owner-sweep-held` — the review
  condition is to display lapsed state and preserve transition history, not to GC
  yet. `shepy profile owner` now covers the display half.
- Nothing else started.

## Next steps

1. Land `ops/observability-surface` minus the sweep, after review.
2. Item 1 (selector ambiguity) — serial, it shares files with the above.
3. Items 2 and 3 together: the render/ack contract and the admission rule
   interact through the attempt budget.
4. Amend `2026-09-13-shepy-battle-test.md` per the review: capability and
   running-build identification, cross-harness contention during a long Claude
   turn, a 21+ outcome overload row, failure-between-durable-stages rows, and
   binding/disappearance rows. Run destructive experiments against an isolated
   `SHEPY_HOME`, never the daemon serving Ray's panes.
