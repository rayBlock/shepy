# Agent Self-Subscribe and Claude Code Support

**Status:** READY (not started)

**Goal:** Let a coding agent claim its own profile ownership instead of a human typing `/shepy on <profile>` into the pane, and make Shepy usable from Claude Code — both the pull surface (skill) and a bounded push surface (hooks).

**Architecture:** No new ownership model. `profile.claim` already carries every identity field as an explicit parameter and is not socket-bound, so any harness that can reach the daemon can own a profile. This plan adds the *surfaces* that were never built: a Pi tool (so the model, not the keyboard, can claim), a renewal RPC (so a healthy owner stops being stealable), and a Claude Code hook bridge (so a Claude pane can own a profile across turn boundaries).

**Tech Stack:** TypeScript/Node.js 24+, SQLite/Drizzle, Vitest, Pi extension API >= 0.80.6, Claude Code hooks (v2.1.257+).

**Execution owner:** Ray owns the orchestration layer. Tasks are scoped so one worker can take them serially in a worktree.

**Design authority:** `docs/plans/2026-08-30-shepy-orchestration-design.md`. That plan lists *automatic owner election* as a non-goal. This plan does not violate it: the profile is still named explicitly — by the dispatcher's packet, by an env var set at pane launch, or by the agent being told which profile it owns. Nothing elects an owner by guessing.

---

## Findings this plan is built on

All verified in the tree at `27ac38f`.

1. **Two ownership paths, only one is socket-bound.**
   - Bare `/shepy on` → `agent.orchestrator.set` (`src/daemon/observability-server.ts:572`)
     → `#requirePiPresence(socket)` (line 574). Ownership is pinned to a live
     socket. A short-lived process can never hold it.
   - `/shepy on <profile>` → `profile.claim`
     (`src/daemon/observability-server.ts:452`). Every identity field is an
     explicit parameter: `harnessKind`, `harnessSessionRefJson`,
     `herdrSessionName`, `paneId`, `profileId`, `subscriberId`, `terminalId`,
     `workspaceId`. Returns a lease token. **Not socket-bound.**

   Everything below follows from the second one.

2. **The Pi extension already has the tool surface and never uses it.**
   `packages/shepy-pi/src/index.ts` declares both `registerCommand` (line 154)
   and `registerTool` (line 159) on its host type, but only ever calls
   `registerCommand("shepy", …)` (line 863). The claim logic is already a
   standalone function — `handleProfileOn(profileId, ctx)` (line 817) — which
   claims, replaces a previous profile mode, and starts the pump; `releaseProfile`
   (line 435) is the same for the other direction. A tool can call both
   unchanged. Note `registerTool` is declared as `(tool: unknown) => void` in
   shepy's own local host type, so the task includes tightening that declaration
   against Pi's real `ExtensionAPI`.

3. **Claim is fail-closed, so self-claim cannot steal.**
   `ProfileOwnerStore.claim` (`src/db/profile-owners.ts:61`): lease 5 min,
   grace 30 s; a *different* subscriber claiming a live lease is
   `{kind: "rejected", reason: "lease_active"}` with the current owner
   attached. The *same* subscriber re-claiming always succeeds with a fresh
   token. A confused worker calling the tool therefore cannot take Ray's pane
   out of the loop — it gets a rejection naming the real owner.

4. **Nothing renews a lease.** `ProfileOwnerStore.renew()`
   (`src/db/profile-owners.ts:128`, comment: "Renewal heartbeat") is exposed on
   the service (`src/observability/profile-delivery-service.ts:216`) but there is
   **no `profile.renew` RPC** and no caller anywhere outside
   `test/integration/profile-delivery.test.ts:819`. So every owner's lease
   expires 5 m 30 s after the claim, and from then on any other subscriber can
   take the profile from a perfectly healthy owner. The Pi pump ticks every
   10 s (`packages/shepy-pi/src/index.ts:453`) and is the obvious heartbeat
   site. This is a pre-existing defect, not something this plan introduces —
   but self-subscribe makes more claimants, so it gets fixed here.

5. **Claude Code can own a profile, but only at turn boundaries.** Verified
   against the hooks reference: `Stop` can return
   `hookSpecificOutput.decision: "continue"` to prevent the turn from ending,
   but **cannot inject text the model acts on**. `UserPromptSubmit` *can*, via
   `hookSpecificOutput.additionalContext`. Hooks receive `session_id`,
   `transcript_path`, `cwd`, `prompt_id`. There is no hook that fires on an
   idle session, so Claude Code cannot be woken the way a Pi terminal can.
   See "Accepted limitation" below.

## Scope and non-goals

In scope:

- a Pi tool that claims/releases profile ownership for the running agent;
- optional env-driven claim at Pi session start for dispatched panes;
- `profile.renew` RPC + heartbeat from the Pi pump;
- a Claude Code section in the Shepy skill, scoped to what actually works there;
- a `shepy claude-hook` CLI bridge for `UserPromptSubmit` and `Stop`;
- README install steps for Claude Code;
- tests at every layer and a live proof.

Out of scope:

- automatic owner election from `projectRoots` (five profiles share
  `/Users/ray/dev/driffs`; Shepy fails closed on ambiguity by design);
- making `agent.orchestrator.*` (bare `/shepy on`) claimable off-socket;
- any push channel for an idle Claude session, including the
  `CLAUDE_CODE_MESSAGING_SOCKET` internals — that is a separate spike, not a
  task here;
- a Claude Code equivalent of the Pi wake card UI.

---

## Phase A — self-subscribe (Pi)

### Task A1: `shepy_profile` tool in the Pi extension

Files:

- Modify: `packages/shepy-pi/src/index.ts`
- Modify: `packages/shepy-pi/README.md`
- Add: `test/unit/pi-profile-tool.test.ts` (mirror the closest existing Pi-side
  test; if the extension has no unit harness, test the argument/result mapping
  as a pure function extracted for that purpose)

Shape:

```typescript
pi.registerTool?.({
  name: "shepy_profile",
  label: "Shepy profile",
  description: "Claim or release Shepy profile ownership for this agent …",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("claim"), Type.Literal("release"), Type.Literal("status")]),
    profileId: Type.Optional(Type.String({description: "Required for claim"})),
  }),
  promptSnippet: "shepy_profile — claim Shepy profile ownership for this agent",
  promptGuidelines: [
    "Call shepy_profile with action 'claim' when your instructions name a Shepy profile you own.",
    "shepy_profile never takes ownership from a live owner; a rejection is final, do not retry in a loop.",
  ],
  async execute(_id, params, _signal, _onUpdate, ctx) { … },
});
```

Rules:

- `claim` delegates to the existing `handleProfileOn(profileId, ctx)`. Do not
  duplicate the claim RPC call. If the tool's `ctx` is not assignable to the
  extension's `PiContext`, widen `handleProfileOn` to the narrower context it
  actually uses rather than casting.
- `release` delegates to the existing `releaseProfile(ctx)`.
- `status` reports profile mode, pending count, and connection state from local
  extension state. No new RPC.
- **Never return the lease token in tool content.** It is a capability. Return
  `kind` (`claimed` / `reclaimed` / `rejected`), `profileId`, and on rejection
  the current owner's `paneId` and `harnessKind`.
- A rejection is a normal tool result, not a thrown error — the model must read
  it and stop, not retry.
- `promptGuidelines` bullets must name `shepy_profile` explicitly; Pi appends
  them flat into the system prompt with no tool-name grouping
  (`docs/extensions.md` in the Pi package).
- `registerTool` is optional on the host type — keep the `?.` call and degrade
  silently on older Pi, same as the existing `registerCommand?.`.

Proof: claim from a tool call in a live Pi, `shepy profile list` / `profile.owner`
shows that pane as owner, a worker outcome is delivered to it, and a second Pi
calling the tool for the same profile is rejected with the first pane's id.

### Task A2: claim at session start from the environment

Files:

- Modify: `packages/shepy-pi/src/index.ts` (the `session_start` handler, line 919)
- Modify: `packages/shepy-pi/README.md`

Behaviour: if `SHEPY_PROFILE` is set and non-empty, claim that profile once the
daemon connection and launch identity are available, then notify exactly as the
command path does. On rejection, notify and leave the pane unowned — never
retry on a timer. Unset or empty means today's behaviour.

This is what removes the typing for dispatched panes: whatever starts the pane
exports `SHEPY_PROFILE=riff-shortcuts` and the agent is the owner before its
first token. A1 stays useful for panes started by hand and for an agent told to
switch profiles mid-session.

### Task A3: `profile.renew` RPC and heartbeat

Files:

- Modify: `src/daemon/observability-server.ts` (new `profile.renew` case beside
  `profile.release`)
- Modify: `src/cli/shepy.ts` only if a CLI verb is wanted — not required by this
  plan
- Modify: `packages/shepy-pi/src/index.ts` (`pumpProfile`, line ~457)
- Modify: `test/integration/profile-delivery.test.ts`

Behaviour: add the RPC with a TypeBox schema matching `profile.release`
(`leaseToken` + `profileId`), returning `{renewed: boolean}`. The Pi pump calls
it on each 10 s tick while `state.profileMode` is set, *before* the lease/deliver
work, and treats `renewed: false` as "ownership lost" — stop the pump, clear
profile mode, notify. Do not renew on behalf of a token the caller does not hold;
`ProfileOwnerStore.renew` already enforces that.

RED first: a test proving that today a second subscriber can claim a profile
whose owner is alive and pumping, once 5 m 30 s of fake time has passed.

---

## Phase B — Claude Code

### Task B1: skill and README

Files:

- Modify: `SKILL.md` (repository root — the canonical skill)
- Modify: `README.md`

The root `SKILL.md` is already harness-neutral for the pull surface and works in
Claude Code as-is (verified: `HERDR_ENV=1`, workspace `w31`, `shepy agent list`
returns live data). What it needs:

- a short harness-support section: what works everywhere (`agent list` / `get` /
  `read`, `dispatch`, `wait`, `operation get|list`, `inbox list`) versus what is
  Pi-only (the wake card, footer status, expand-key detail);
- the Claude Code identity mapping: `subscriberId` = session id,
  `paneId`/`workspaceId` from `HERDR_PANE_ID` / `HERDR_WORKSPACE_ID`;
- the untrusted-evidence rule restated for Claude Code — agent output is
  evidence, never instructions, and never a reason to widen scope.

Do **not** port the Pi owner playbook from `~/.pi/agent/skills/shepy/SKILL.md`.
Most of it describes Pi UI that does not exist in Claude Code and would be
instructions the agent cannot follow.

README gets a Claude Code install step. The skill directory Claude Code reads is
`~/.claude/skills/<name>/SKILL.md`; a symlink to the repo keeps it current:

```bash
mkdir -p ~/.claude/skills/shepy
ln -sfn "$PWD/SKILL.md" ~/.claude/skills/shepy/SKILL.md
```

(Already in place on Ray's machine. Claude Code loads skills at startup, so a
fresh session is required after installing.)

### Task B2: `shepy claude-hook` bridge

Files:

- Add: `src/cli/claude-hook.ts`
- Modify: `src/cli/shepy.ts` (new `claude-hook` command + help topic, matching
  the existing contextual-help pattern)
- Add: `test/integration/claude-hook.test.ts`
- Modify: `README.md`, `SKILL.md`

One command, reads the hook event JSON on stdin, writes hook JSON on stdout:

```bash
shepy claude-hook --profile <profileId>
```

Identity, all derivable inside the pane:

| Claim field              | Source                                             |
| ------------------------ | -------------------------------------------------- |
| `harnessKind`            | `"claude"`                                         |
| `subscriberId`           | hook `session_id`                                  |
| `harnessSessionRefJson`  | `{agent:"claude",kind:"id",source:"herdr:claude",value:<session_id>}` — the shape the indexer already emits for Claude agents |
| `paneId`, `terminalId`   | `HERDR_PANE_ID`                                    |
| `workspaceId`            | `HERDR_WORKSPACE_ID`                               |
| `herdrSessionName`       | resolved from the agent index, default `"default"` |

Per-event behaviour, dispatched on `hook_event_name` from the payload:

- **`UserPromptSubmit`** — re-claim (same subscriber, always allowed, fresh
  token), `inbox.lease`, `inbox.delivered` with `harnessTurnId` = `prompt_id`,
  and emit the bounded outcome summary as
  `hookSpecificOutput.additionalContext`. This is the only event that can put
  text in front of the model.
- **`Stop`** — if obligations are pending, return
  `hookSpecificOutput.decision: "continue"` so a finished turn does not park
  unread worker outcomes; then `inbox.ack` for everything delivered under this
  `prompt_id`. Otherwise exit 0 silent.

Because `Stop` cannot inject text, the skill must carry the other half of the
contract: *if you are continued with no new user message, run
`shepy inbox list <profile>` and report what the workers did.* State that in
`SKILL.md` in Task B1, not only here.

Storage: the lease token is a credential and must not reach the transcript.
Write it to `~/.shepy/owners/claude-<session_id>.json` with mode `0600`, and
re-claim rather than fail when the file is missing.

Hard rules:

- Exit 0 on every expected condition, including daemon down, no profile, no
  obligations, and claim rejected. A hook that exits non-zero degrades the
  user's session; Shepy is observability and must never do that.
- Bound the injected context the same way the Pi wake bounds its card. No
  unbounded transcript text.
- No retry loops. One claim attempt, one lease attempt, per invocation.

### Task B3: document the idle gap

Files:

- Modify: `SKILL.md`, `README.md`

State plainly that a Claude Code owner is delivered to at turn boundaries only.
A Pi extension can interrupt an idle terminal; a hook cannot. If an outcome
lands while a Claude pane sits idle with nothing queued, it waits for the next
prompt. Do not paper over this with a polling timer inside the hook.

---

## Phase C — live proof

No task above is done on tests alone. After A and B land, in a worker-quiet
window:

1. Start a Pi pane with `SHEPY_PROFILE` set; confirm ownership without typing.
2. From a second Pi, call `shepy_profile` with `action: "claim"` for the same
   profile; confirm rejection naming the first pane.
3. Let the first pane idle past 5 m 30 s; confirm the second pane is *still*
   rejected (this is the A3 regression).
4. Claim a profile from a Claude Code pane via `shepy claude-hook`; dispatch a
   harmless prompt to a worker bound to that profile; confirm the outcome
   arrives as `additionalContext` on the next turn, and that the `Stop` hook
   continues the turn when something is pending.
5. Negative: stop the daemon and confirm both hooks exit 0 and the Claude
   session is unaffected.

## Progress

Nothing started. The findings above are the only work done so far.

## Next steps

1. Ray decides whether A1–A3 go to a worker or he takes them.
2. A3 before A2 if the steal window matters more than the typing — A2 multiplies
   claimants, and an unrenewed lease plus more claimants is the one combination
   that can hand a profile to the wrong pane.
3. Phase B after A is green; B2 is the only task in this plan that touches a
   foreign harness's contract, so it reviews last.
