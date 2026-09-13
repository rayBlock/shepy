# RUN-20260913-03 — Represented set equals acknowledged set (plan item 2)

Third run under the vault orchestration program. Serial after item 3
(RUN-20260913-02), which landed at `2dea955`.

## Registration (before dispatch)

- **Experiment:** EXP-01 repeat on a medium task with a design fixed by the
  lead up front (D1–D5 in the packet). Verifier packet asks for BOTH
  mutation testing and free probes, since RUN-01 showed mutations only
  happen when asked and RUN-02 showed probes happen unprompted.
- **Task class:** medium correctness fix across hook, store, service, RPC
  and CLI.
- **Outcome:** the Claude hook delivers and acks only the obligations it
  actually represented in the injected context; the rest return to pending
  without burning a delivery attempt. `inbox get` and a list cursor make
  the truncation hints usable.
- **Non-goals:** `LEASE_MAX_BATCH` value, Pi extension (renders every row
  unbudgeted, so it has no such gap), `WAKE_POLICY` text, item 3 logic,
  retire/retry semantics, `MAX_DELIVERY_ATTEMPTS`.
- **Defect, verified by ops:** `claude-hook.ts` leases 20, records all ids
  in the owner file, calls `inbox.delivered` with all ids, renders only the
  outcomes that fit 6 000 chars / 120 lines, then the next hook run acks
  every recorded id. With 2 000-char excerpts: lease 20 → render 2 → ack 20.
- **Design (ops):** formatter returns `{context, representedIds,
  deferredIds}`; full lines → one-line stubs → deferred; new `inbox.defer`
  (leased→pending, attempt refunded, `deferred_over_budget`); `inbox.get`
  RPC + CLI verb; `inbox list --before/--limit`.
- **Base:** `shepy` at `2dea955` (item 3 landed). Gate at `2dea955`: exit 0,
  55 / 561.
- **Work surface:** `~/dev/shepy-wt/item2`, branch
  `pilot/item2-represented-equals-acked`.
- **Mutation scope:** `src/cli/claude-hook.ts`, `src/db/delivery-obligations.ts`,
  `src/observability/profile-delivery-service.ts`, `src/observability/schemas.ts`,
  `src/daemon/observability-server.ts`, `src/cli/shepy.ts`, tests.
- **Roles:** lead = this Claude session (`w31:p1`), supervised. Builder
  `builder-item2`, verifier `verifier-item2`, both Pi `zai/glm-5.3-flash`,
  fresh panes. Revision, if any, to a fresh builder.
- **Limits:** 150 min builder, 90 min verifier; one of each; no children.
- **Stop conditions:** as RUN-01/02; any change to Pi or to item 3's
  admission logic is a scope violation.
- **Evidence:** this file + `/tmp/run-20260913-03/`, copied at acceptance.

## Execution and lineage

- 10:45Z — worktree `~/dev/shepy-wt/item2` at `2dea955`, installed
  `--ignore-scripts`. Pane `w31:pZ` (split right of `w31:p1`, no focus),
  `builder-item2` on Pi `zai/glm-5.3-flash`; packet
  `/tmp/run-20260913-03/builder.packet.md` submitted from file; `working`
  within 4 s; one bare wait armed. Verifier packet pre-written with both a
  mutation pass and a probe pass required.

## Results

_(appended at acceptance)_

## Experience and retirement

_(appended at retirement)_

## Interpretation

_(appended at synthesis)_
