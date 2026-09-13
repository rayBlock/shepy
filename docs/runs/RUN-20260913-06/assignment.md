# PORTFOLIO-MC01 — Manager context visibility, first bounded engineering slice

## Authority, outcome and ownership

Ray explicitly told the portfolio coordinator to dispatch work now, after approving context/manager-continuity improvements as the next foundation priority. He selected Astra for portfolio coordination/dispatch, Fable as the architectural/review companion, and Flash for bounded research/build/check work. This is the concrete delegated scope from that conversation, not blanket authority to execute the backlog.

**To:** existing Shepy lead, Claude/Fable in w31:p1 (session 9556fa64-6b40-4b06-a310-924ee16741f0).
**From:** interim portfolio coordinator, Pi/Astra wP:p70, profile portfolio-ray-local.
**Assignment:** make Shepy expose truthful, source-linked context/compaction information for the current Pi and Claude lead sessions, with a minimal read-only v1 implementation and independent checks. Do not build the scheduler or automatically compact anyone.

You own this engineering run, worktree, child dispatch and candidate acceptance recommendation. Portfolio owns cross-program acceptance and expanded scope. Allocate the next available Shepy run ID, register ONE owning run record before any child dispatch, and report its path to portfolio. Preserve all existing run IDs. Copy this exact assignment into that run's supporting evidence before retiring its temporary source; do not create another mandatory task log.

This is a supervised engineering pilot. Use the current run-lead and agent-research-operations skills, proportionately. No automatic Orchi activation is needed or authorized by this packet.

## Original intent

The factory must support persistent concurrent work over coming weeks. A manager losing its context must not lose the user's goals, active workers, existing waits, pending decisions or accepted candidate identities. Observing context pressure and compaction boundaries is the first slice; testing complete manager continuity is the next, not something to claim from a percentage display.

Keep managerial/model roles experimental. Do not prescribe permanent headcounts, a global utilization threshold or a fixed C-suite. Shared-method promotion remains Ray-approved initially; this assignment does not make your existing run-local conventions universal factory policy.

The future factory/task ledger/dashboard is a SEPARATE reusable project, not a scheduler inside Shepy. Shepy owns observation and supported operation/delivery APIs. Pi/Claude own compaction. Portfolio/workstream leads own policy and acceptance. Existing Driffs runtime and typography work retain their owners; no worker/pane takeover.

## Use what is already known — no broad new inventory

Read /Users/ray/dev/.vault/wiki/agent-portfolio-coordination.md sections 1, 3 and 9, plus the relevant source instructions. Source observations already made by portfolio:

- Shepy `src/observability/contracts.ts` has no typed context-health fields/events.
- `src/agent-history/pi-reader.ts` ignores non-message entries, including `type: compaction`.
- `src/agent-history/claude-reader.ts` does not project compact-boundary metadata as context health.
- Installed Pi `dist/core/extensions/types.d.ts` exposes `ctx.getContextUsage()` (estimated tokens/window/percent; tokens/percent may be null after compaction) and before/success/failure compaction hooks. These are primitives, not existing Shepy telemetry.
- Pi docs: auto threshold is contextWindow minus reserveTokens, default reserve 16384, not a universal percentage. Inspected settings lack a compaction override, but disk settings alone do not prove effective runtime policy.
- Four identified sessions already have real compaction metadata: portfolio Pi and typography Pi each two compaction entries; each Claude lead one manual compact boundary. The Shepy Claude session compacted at 12:24:20.511Z while RUN-04/05 were in flight and later completed them. This is observational evidence, not a controlled recovery proof.
- Never infer present occupancy from lifetime token totals, cache-read totals accumulated across calls, or a compaction preTokens count. Old usage is timestamped evidence, not current measured state.
- Source metadata may contain stale branch/session data; session identity and source freshness must be explicit.

Read current Shepy code and installed harness interfaces to confirm. When facts above are already established, spend research on the unresolved adapter/contract choices, not repeating the entire project inventory.

## Required v1 behavior

1. **Truthful observation contract.** Expose through the existing read-only agent inspection surface a small context-health projection: source/session identity; observation timestamp; model/window/usage only where actually supported; measurement kind (measured/estimated/last-reported/unavailable); and last supported compaction boundary. Null/unknown is a valid result, never manufactured 0% or healthy.
2. **Pi and Claude evidence.** Parse/observe each harness using supported source boundaries. Preserve compaction identity, timestamp, trigger when available, before/after usage when actually recorded, and success/failure only where the source proves it. Missing lifecycle phases stay unknown. Do not treat historical tool-output shortening as session compaction.
3. **Freshness and continuity boundaries.** A model switch, new session, compaction or branch change must not silently retain an old reading as current. If live context-window/threshold values cannot be obtained without new harness configuration, v1 reports unavailable and names that limitation. Do not edit global configuration or install a hook merely to fill every field.
4. **No new manager policy.** No `/compact` calls, session interruption, auto-restart, new scheduling, owner takeover or new authorization from a telemetry field. No extra per-tool-call wake storm. Existing status/delivery behavior must remain unchanged in this slice.
5. **Bounded, reusable implementation.** Reuse current reader/cache/inspection seams. Keep source parsing, observation contract and presentation separate. Avoid repeatedly reading entire large histories solely for this feature if an existing fingerprint/cache can serve it. Do not turn this into a private transcript export or a second task/event database.
6. **Independent evidence.** Synthetic deterministic metadata fixtures cover known/unknown values, post-compaction uncertainty, missing/malformed fields, session/model changes, misleading totals, branch/source freshness and unchanged legacy inspection. Test claims at their actual API boundary. Use no real private transcript contents in committed fixtures. Verifier must challenge false-current/false-zero and incorrect-compaction claims with named negative cases. No credit for test counts without requirements.

## Execution stages — proceed within this scope, escalate genuine design expansion

A. Use at most one Flash researcher for unresolved source-contract questions if needed. Have it return a small actionable delta and counterexamples, not another master plan. You independently check its decisive references and choose the minimal design before a builder starts. If you can resolve the small remaining questions directly, skip the researcher and record why.
B. Register a bounded design in the same run record. Implement the additive read-only v1 in an exclusively owned worktree using a Flash builder. Do not widen scope because an optional field is unavailable.
C. Freeze candidate. Use a fresh Flash verifier with original requirements and independent initial findings before the builder's narrative. You independently adjudicate the critical false-current/false-zero/branch-boundary cases. One corrective cycle is allowed.
D. Return a source-linked result, candidate, actual tests, remaining unavailable fields and the next controlled continuity experiment. A source-limited honest v1 can be accepted within scope; no full manager-recovery or unattended qualification claim.

If there is a genuine architectural decision requiring a new data store, active harness instrumentation/configuration or a larger rollout, stop that branch and return the smallest decision-ready proposal. Do not spend the whole run trying to evade the read-only-source boundary.

## Resources and permissions for this pilot (not permanent factory defaults)

- Existing Fable lead; Pi `zai/glm-5.3-flash` for children, verify actual model/reasoning configuration. No silent provider/model fallback.
- At most one active child at a time; at most researcher + builder + verifier, plus one correction worker if needed. No child descendants. Your existing run-lead tools supervise your own children.
- Overall working envelope: up to 150 minutes for this assignment; source/design investigation at most 30 minutes within that total. Stop earlier on no-progress or unsupported authority. These are supervised caps, not a claim of a verified watchdog.
- Existing configured model inference for this scoped work is authorized by Ray's dispatch instruction. Record measured provider usage, configured cost versus actual billing/unknown, and premium lead/coordination effort. No billing-setting changes, external paid APIs, render/GPU work or new subscriptions.
- Use an isolated owned Shepy worktree and a named branch, not shared root edits while building. Frozen-lockfile dependency installation in that new worktree is permitted only if required by the existing run-lead procedure; no dependency/version changes, global installs or install scripts. Stop if safe setup cannot be achieved.
- Local source/tests/docs and pathspec commits in your owned work surface are permitted. After independent verification and your source-backed acceptance, land through the existing safe Shepy working-branch procedure if the tree is exclusively safe to integrate; never include foreign WIP. No push, deployment, daemon restart, shared live DB migration or global Pi/Claude settings changes. If a migration is actually required, return it for review without applying to the shared home.
- Current shared daemon is already restarted: PID 53303, bootId 4ba22e4c-b313-4b18-b75d-7acbcfe1279c, buildStamp 2026-09-13T12:41:47.820Z, version 0.5.0. Do not restart again.

## Repaired wait qualification on useful work

Dispatch your new child through supported Shepy operations and arm ONE native `shepy wait <operationId> --json` in your harness background mechanism. This is the first useful new run on the repaired daemon. Record exact operation, target identity, returned lifecycle and durable settlement, separately from candidate acceptance. If the wait fails/returns unknown, preserve the failure; inspect once and use only the documented scoped fallback. No repeated polling or blind re-dispatch. Do not repair unrelated delivery defects inside this packet.

Portfolio already subscribes to your exact lead session. Your normal `PORTFOLIO UPDATE` should identify the new owning run, actual next step and later results. Do not prompt portfolio directly or add reciprocal subscriptions. A setup response before you finish is progress, not completion; portfolio will not mistake your idle status for accepted work.

## Recording and final result

Use existing recording definitions, not a new form. Preserve exact prompts/reports and candidate/source identities. Count attempts/revisions/fresh versus directed reviews, real checks/negative controls, requirement misses, wait/delivery outcomes, source timestamps, scope limitations, costs and unplanned interventions. Preserve failed attempts and unknown values. This is an observational engineering run, not proof Fable/Astra/Flash is an optimal topology.

End the final accepted/blocked result with `PORTFOLIO-MC01 COMPLETE` or `PORTFOLIO-MC01 BLOCKED`, and the next safe action. Do not label the earlier registration/dispatch acknowledgment complete.
