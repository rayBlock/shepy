# Shepy Harness Integration

**Status:** Investigation complete; Codex implementation not started.

**Goal:** Bring Shepy to Pi-level feature parity across supported harnesses, beginning with standalone Codex outside Herdr. Preserve Herdr as the source of worker lifecycle and pane state where workers are Herdr-managed.

**Progress:** The repository, current ownership and delivery path, history readers, existing Codex hook installation, and current official Codex hooks and App Server documentation have been inspected. Ray selected Pi feature parity and clarified that the current Codex session is outside Herdr.

**Next steps:** Run the Codex identity and App Server feasibility spikes in the child plan. Implement only after the exact session, profile ownership, delivery, acknowledgment, and wake path pass their proof gates.

## Current state

Shepy is not missing a whole daemon or program. The daemon already watches Herdr sessions, indexes agent snapshots, caches bounded session history, records lifecycle events, projects durable delivery obligations, exposes profile leases and inbox RPC, and provides a CLI. There are history readers for Codex, Claude Code, Gemini CLI, OpenCode, Pi, and Hermes.

History reading does not equal a live harness integration. Pi is the only native long-running harness integration with a visible pending state, cached context, owner lease renewal, outcome presentation, and automatic idle wake. Claude Code has a short-lived hook bridge at `UserPromptSubmit` and `Stop`, but cannot wake an idle Claude session. Codex has a history reader and Shepy can be invoked by CLI; there is no Codex owner or delivery bridge.

The current owner contract is not harness-neutral in practice. `profile.claim` requires Herdr session, pane, and terminal fields. The Claude bridge explicitly refuses to run without Herdr pane and workspace identity. Pi also registers Herdr presence. Therefore this repository cannot currently represent a standalone Codex owner honestly. Do not fill those fields with fabricated Herdr IDs.

Worker discovery and outcome projection currently come from Herdr snapshots and events. The first standalone Codex integration should own a profile outside Herdr while receiving outcomes for workers that Shepy already observes through Herdr. This plan does not make Shepy a standalone worker-process monitor or a replacement for Herdr.

The current Codex user hook file also contains a Herdr `SessionStart` hook. Any Codex setup must preserve it and compose with existing hooks. Codex hook configuration supports layered matching sources; installation must not replace the user’s existing configuration wholesale.

This Codex session is outside Herdr: `HERDR_ENV` is unset. The installed Herdr CLI is version 0.9.3, but there is no Herdr source checkout in the inspected project root. I did not query or control the live Herdr server. The Herdr feature inventory below is based on the installed CLI’s help, Shepy’s source, and current Herdr documentation.

## What Herdr offers

Herdr is the runtime host and control plane for agent processes inside its persistent terminal sessions. It provides:

- Persistent sessions, workspaces, tabs, and real terminal panes, with local and remote/machine workflows.
- Agent startup for the installed kinds; version 0.9.3 lists Pi, Claude Code, Codex, Gemini, Cursor, Devin, Antigravity CLI, Cline, OMP, Mistral Code, OpenCode, Copilot, Kimi, Kiro, Droid, Amp, Grok, Hermes, Kilo, Qoder, Qwen, Letta, Maki, and Muse.
- Agent recognition and semantic `working`, `blocked`, `done`, `idle`, and `unknown` state, using screen detection or agent-reported lifecycle authority.
- Pane-level prompt, key input, output reads, focus, naming, layout, and process control; agent-level prompt, wait, start, attach, and state inspection.
- A socket API for snapshots, subscriptions, wait-for-output/state changes, session identity reports, integration management, plugins, and display metadata.
- Native session identity and optional resume commands so supported agents can reopen after a Herdr server restart. Reporting state, session identity, and a resume command are separate capabilities.

Shepy currently consumes Herdr session listing, snapshots, and the pane agent-status event. It refreshes working panes every 10 seconds and performs a full session rescan every 60 seconds. Its Herdr transport uses `agent.prompt` and `agent.wait`. Its Herdr plugin is narrower still: it renders a read-only table from Shepy's `agent.list`; it is not a lifecycle reporter or a two-way owner bridge.

One critical semantic limit: Herdr's `agent.prompt --wait` and `agent.wait` observe target lifecycle state, not a durable per-prompt turn receipt. If the agent is already working, the completion of that existing active turn can satisfy the wait. Shepy stores an operation ID and checks the target identity, but a target match alone must not be described as proof that a particular submitted prompt completed. Where the harness exposes a native turn ID, adapters should persist and wait on that ID. Where it does not, report target-level settlement with that limitation.

Herdr does not provide Shepy’s cross-agent profile model, durable owner leases, scoped subscriptions, cached structured transcript context, or inbox delivery/acknowledgment. Shepy does not provide Herdr’s process host, terminal transport, workspace layout, or pane lifecycle. Keep these responsibilities separate.

## Flexible integration model

Avoid one universal hook that pretends all harnesses have the same lifecycle or wake ability. Split the integration across three roles:

1. **Host adapter:** where the process runs and how it is located or controlled. Herdr is one host adapter. Standalone Codex is another environment with no Herdr pane. A session can have no host location or a Herdr location; do not infer one from cwd.
2. **Harness adapter:** the agent’s stable session identity, lifecycle callbacks, history/context access, prompt injection, wake, and native receipt support. Each harness implements only what its official interface supports.
3. **Shepy core:** profiles and subscriptions, bounded context, event normalization, durable outcomes, lease/receipt state, diagnosis, and capability reporting.

Each adapter should advertise capabilities independently: `session_identity`, `status_events`, `history_read`, `context_injection`, `idle_wake`, `busy_queue`, `turn_receipt`, `session_restore`, and `visible_status`. A feature matrix is the product contract. Unsupported capabilities stay explicitly unavailable; an adapter must never emulate a strong receipt with a generic idle status or claim an idle wake through a prompt-boundary hook.

The eventual common lifecycle envelope should preserve source and native identity: harness kind, native session id, optional host location, optional native turn id, status/outcome kind, timestamp, and idempotency key. Profile routing and durable receipt logic consume this envelope. Raw terminal output remains a separate Herdr-only surface; structured history remains a harness reader surface.

Implement this in stages. First make owner identity independent of Herdr location while keeping worker subscriptions/events Herdr-backed. Then prove standalone Codex. Only after that should Shepy accept direct lifecycle reports from non-Herdr workers, which requires generalizing current subscriptions and event scope beyond `(Herdr session, workspace)`.

## Target: Pi feature parity in Codex terms

Parity is the same user-visible capability set, expressed through Codex’s native surfaces:

| Capability | Pi today | Codex target |
|---|---|---|
| Profile ownership | Explicit claim and renewed lease | Explicit claim for the exact Codex session, renewable across turns and process restarts |
| Session context | Cached current-workspace context | Bounded context injected at session start, prompt submit, or compaction continuation |
| Pending state | Footer and pending count | Clear Codex-visible status message and a `shepy` status/diagnose command; do not invent a fake persistent footer |
| Outcome detail | Wake card and expand view | Bounded outcome injected into a Shepy-triggered Codex turn, with exact event IDs and a CLI path for full bounded detail |
| Idle delivery | Pi can start a visible turn | Codex must start a turn on the already-owned session through a proven supported API; hooks alone do not qualify |
| Busy delivery | Waits for the user turn to settle | Queue while active; do not steer or continue a user’s active turn unless explicitly designed and verified |
| Acknowledgment | Only after a settled visible response | Ack only after Codex confirms the Shepy-triggered turn completed and its response is persisted; otherwise redeliver |

If the App Server cannot safely address the already-open Codex session, boundary-only delivery is useful but does not satisfy the requested parity. Record that limitation and stop before presenting it as complete.

## Cross-harness sequence

1. Make the profile owner identity independent of Herdr location. Keep the lease token private and retain proof-of-possession, expiry, renewal, and one-owner rules. Represent host location as an explicit optional capability; never pretend a standalone session has a pane or workspace.
2. Build and prove Codex identity and delivery first, following [the Codex child plan](2026-10-09-harness-integration/codex.md).
3. Publish an authoritative capability matrix after the Codex live proof. Correct README and skill claims: distinguish history-reader support, CLI pull access, turn-boundary hooks, and full live ownership/wake. Include Hermes history support and remove the stale “read-only” statement where CLI dispatch, inbox, and operation verbs are described.
4. Reuse the neutral owner and delivery contracts for Claude Code, OpenCode, and Hermes. Pi remains the reference implementation. Do not promise another harness until its own lifecycle, session identity, idle wake, and receipt semantics have passed live proof.

## Harness capability inventory

The table records the current repository investigation and official harness entry points. A lifecycle API existing in a harness is not evidence that Shepy can safely attach to a running session.

| Harness | Shepy support found | Native integration surface | Main missing proof |
|---|---|---|---|
| Pi | Full live owner integration, cached context, visible pending state, wake and receipt | In-process extension lifecycle and tools | Reference behavior; keep its tests green while generalizing the contract |
| Codex | History reader only; no Shepy owner bridge | Hooks in `~/.codex/hooks.json` or config, plus App Server | Standalone claim identity, active-session attachment, safe idle wake, delivery receipt |
| Claude Code | History reader and Shepy hook bridge | `UserPromptSubmit` and `Stop` hooks | Current bridge requires Herdr identity; idle wake remains unavailable through hooks |
| OpenCode | History reader only | Plugin lifecycle events and server API | Stable session ownership, same-session async wake, final-turn acknowledgment |
| Hermes | Exact-ID read-only state database reader only | Configured lifecycle shell hooks | Installed-version event contract, exact session identity, reliable wake and acknowledgment |
| Gemini CLI | History reader only | Not assessed in this Codex-first investigation | Later harness-specific inventory |

Herdr’s own runtime supports more agent kinds than this first Shepy integration wave. That does not mean every kind has a native Shepy history reader or a full Shepy bridge. Herdr detection, a Herdr integration, a Shepy history reader, and a Shepy owner adapter are distinct support levels.

Official references: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude Code hooks](https://code.claude.com/docs/en/hooks), [OpenCode plugins](https://docs.opencode.ai/docs/plugins/), [OpenCode server](https://docs.opencode.ai/docs/server/), [Pi extensions](https://pi.dev/docs/latest/extensions), [Hermes hooks](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md).

Herdr references: [agent automation](https://herdr.dev/docs/agent-automation/), [agents and detection](https://herdr.dev/docs/agents/), [socket API](https://herdr.dev/docs/socket-api/), and [add Herdr support to an agent](https://herdr.dev/docs/add-herdr-support/).

## Documentation decision

Yes, documentation needs a cross-harness capability map and a boundary explanation. Existing README detail is substantial for Pi and Claude, but it mixes harness history reading with live bridges, says Shepy is read-only despite dispatch and inbox mutation commands, omits Hermes from its supported-history sentence, and leaves old orchestration plans with proposed CLI work marked approved even though portions have since landed. After Codex behavior is verified, document each capability by evidence level and tested version. Preserve current user edits in README and skills while making that later documentation update.

## Non-goals

- Replacing Herdr’s process, pane, terminal, or worker lifecycle management.
- Treating an arbitrary session ID or cwd as proof of ownership.
- Acknowledging an outcome because it was leased or because a hook ran.
- Claiming idle wake based only on `UserPromptSubmit`, `Stop`, or a CLI poll.
- Changing another harness’s configuration without preserving its existing hooks and user settings.
- Claiming full compatibility from history-reader tests alone.

## ENGINE ADDENDUM (2026-10-09, through plan custody; the idle-wake proof + interface facts)
PROVEN (see factory-driffs recovery dir codex-transport-proof.json): codex queue --thread <exactUUID> wakes the original open TUI, same PID/thread, nonce-visible, no resume/fork, daemon untouched. This is the transport primitive for codex wake delivery.
INTERFACE (actual, as-observed): the queue CLI addresses threads by exact UUID; the woken TUI completes native turns; host location (w3P pane) is SEPARATE from owner identity — standalone codex has no pane/workspace IDs and the owner contract MUST NOT fabricate them; native session + turn receipts are the codex-side truth.
CODE NEEDED (smallest next bounded packet — "CODEX-NEUTRAL-OWNER-ADAPTER"): one adapter in shepy-pi that maps a codex thread-UUID to an owner outcome WITHOUT herdr pane fields (owner contract gains a codex-shape: native session + nonce turn receipts as the wake evidence); tests in a temporary SHEPY_HOME with fixture threads; legacy Pi behavior byte-preserved. NOT STARTED — prevention slices + landing wrappers finish first (Codex directive).
PROOF REMAINING: busy queueing (wake while a turn runs); interrupted-delivery recovery; harness-neutral shepy owner (the adapter itself); consumption-ack across harnesses. SOURCE OWNS: this plan + child codex.md own the architecture; shepy repo owns the adapter code when the packet fires; factory catalog owns the model-name record (alias fixed: raw codex id = gpt-6-luna).
