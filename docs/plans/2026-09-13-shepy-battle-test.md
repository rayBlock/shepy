# Shepy battle test — pi agent + Claude agent

**Status:** READY TO RUN. Ongoing task, survives reboots. Nothing here has been
proven outside unit/integration tests.

**Goal:** Battle test self-subscribe and the Claude Code hook bridge with a real
pi agent and a real Claude agent. Evaluate. Fix or redesign what does not hold.

**What landed:** `docs/plans/2026-09-11-agent-self-subscribe-and-claude-code.md`
(35 commits, `85f2488..b469397`, `pnpm check` green at 51 files / 481 tests).
This document is its Phase C plus the adversarial cases the reviews raised that
only a live run can settle.

**Execution owner:** Ray runs the agents. Ops reads code, captures evidence, and
fixes.

---

## 0. Preconditions — verified 2026-09-13, re-verify after a reboot

```bash
shepy daemon status          # must say state: running
pi --version                 # must be >= 0.80.6 or registerTool is absent
```

If the daemon is stopped: `shepy daemon start`. A reboot is NOT required for any
of this; a daemon restart is, because the new RPCs and the startup lease
invalidation load at boot.

Already wired, nothing to install:

- `~/.npm-global/bin/shepy` → symlink into `/Users/ray/dev/shepy/dist/`, so the
  CLI runs this checkout. `shepy --help` lists `claude-hook` when it is current.
- `~/.pi/agent/settings.json` `packages` contains
  `"../../dev/shepy/packages/shepy-pi"`, so pi loads the extension from this
  checkout. No `pi install` needed.
- **pi loads extensions at session start.** Every test below needs a pane
  started *after* the code landed. A pane open from before tests nothing.

⚠ `@ryonakae/shepherd-pi` is still in `~/.pi/agent/npm` dependencies but is NOT
in the `packages` list, so it is not loaded. Leave it or remove it; it is not
part of this test.

### How to observe state — read this before running anything

Ownership is visible with the CLI (added 2026-09-13):

```bash
shepy profile owner <profileId>          # human: pane, workspace, lease countdown + local expiry
shepy profile owner <profileId> --json   # the public owner record, verbatim
```

The lease token never appears in this output. The lease reads as `valid`, in
reconnect grace, or `lapsed — claimable`; an unowned profile says so and exits 0.

Lapsed owner rows are **not** swept — a lease that lapsed is out-competed, not
removed — so expect stale rows from previous days. A row whose lease is past
means the profile is effectively unowned and claimable. (A startup sweep is
written and held on `ops/owner-sweep-held`; it is deliberately unlanded until
the long-Claude-turn lease semantics are settled, because sweeping a row that a
still-working Claude turn depends on would break its closing ack.)

Other observation points:

| What | How |
|---|---|
| obligations + states | `shepy inbox list <profileId> --json` |
| whether a profile can receive anything | `shepy profile show <profileId> --json` → read `resolutions[].kind` |
| agent index | `shepy agent list --all --json` |
| Claude owner records | `ls -la ~/.shepy/owners/` (mode must be `0600`) |
| daemon log | `~/.shepy/logs/shepy.log` |
| retry a dead-lettered obligation | `shepy inbox retry <obligationId>` |

**Trap found while writing this:** `riff-shortcuts`'s subscription is
`"kind":"unmatched"` — *"no agent in scope matches name timeline-shortcuts"*. A
profile whose subscription matches no live agent will never have a new outcome
projected to it, so it will look like delivery is broken when it is the binding
that is wrong. It does still hold one undelivered obligation from 2026-09-11,
which is useful for a delivery test but will not repeat.

Make a clean profile bound to a real worker pane instead:

```bash
shepy profile ensure battle --display-name "Battle test"
shepy profile subscribe battle --workspace <wsId> --pane <wsId>:<paneId>
shepy profile show battle --json     # resolutions[].kind must be "matched"
```

---

## 1. pi agent — self-subscribe

The point: ownership without a human typing `/shepy on <profile>`.

| # | Do | Expect | Pass? |
|---|---|---|---|
| P1 | Start a fresh pane: `SHEPY_PROFILE=battle pi` | Owns `battle` before its first token, one notification. DB row shows this pane. | |
| P2 | Fresh pane, no env. Tell the agent: "you own the shepy profile `battle`, claim it." | It calls the `shepy_profile` tool itself. No `/shepy on` typed. | |
| P3 | In the owning pane, `/shepy status` | Reports owner + pending count. | |
| P4 | From a *second* fresh pi pane, claim `battle` | **Rejected**, naming the first pane. Must NOT take over. | |
| P5 | After P4's rejection, watch the second agent for 30s | It does **not** retry in a loop. The tool's guidelines say a rejection is final. | |
| P6 | Leave the owner idle **past 5m30s**, then retry P4 | **Still rejected.** This is the renew heartbeat; before this work nothing renewed and the owner became stealable. | |
| P7 | Dispatch work to the worker pane `battle` is subscribed to, let it finish | The owning pi pane gets a wake card with the outcome. | |
| P8 | In the owning pane: `/shepy off`, then claim from the second pane | Succeeds — release is immediate, no lease wait. | |
| P9 | `SHEPY_PROFILE="" pi` and `SHEPY_PROFILE=nonexistent pi` | Empty = treated as unset, today's behaviour. Nonexistent = claims a ghost profile (known gap, see §4). | |

**Judgment calls only you can make:** is the claim notification clear? Is the
rejection message clear enough that the model stops rather than arguing with it?
Does the wake card read well, or is it noise?

---

## 2. Claude agent — the hook bridge

Nothing here has ever run against a real Claude Code session. Register the hook
yourself; I deliberately have not touched `~/.claude/settings.json`:

```json
{"hooks":{
  "UserPromptSubmit":[{"hooks":[{"type":"command","command":"shepy claude-hook --profile battle"}]}],
  "Stop":[{"hooks":[{"type":"command","command":"shepy claude-hook --profile battle"}]}]
}}
```

Both events are required. Stop is not optional — it is where mid-turn outcomes
are delivered, and dropping it delays every ack by a turn.

| # | Do | Expect | Pass? |
|---|---|---|---|
| C1 | Fresh Claude pane in Herdr, send any prompt | Claims `battle`. `~/.shepy/owners/claude-<session>-battle.json` exists at mode `0600`. | |
| C2 | Produce a worker outcome, then send a prompt | Outcome arrives as context on that turn, under the untrusted-evidence header. | |
| C3 | Produce an outcome *while Claude is mid-turn* | Stop injects it and the conversation continues so Claude can act on it. | |
| C4 | Interrupt a turn (Esc) after an outcome was delivered, then prompt again | The previous delivery is acked on the next prompt. Nothing re-delivers forever, nothing is lost. | |
| C5 | `shepy daemon stop`, then use Claude normally | Hooks exit 0. Session completely unaffected. **This is the one that must not fail** — Shepy must never degrade your editor. | |
| C6 | Register the hook in a pane **outside Herdr** | A `systemMessage` warning tells you the pane has no Herdr identity. Before this round it was silent forever. | |
| C7 | `--profile typo-nonexistent` | A `systemMessage` says the profile cannot receive anything. | |
| C8 | `chmod 0500 ~/.shepy/owners` then run a turn | A `systemMessage` warns about the storage failure and points at `shepy inbox list --state dead_letter`. Undo the chmod after. | |
| C9 | Own `battle` from a pi pane first, then try from Claude | Claude is refused with the distinct stale/other-owner line, and says which. | |
| C10 | Two profiles, one Claude session (two hook registrations) | Two separate owner files, neither clobbering the other. | |

---

## 3. Known limits — do NOT report these as bugs

- **A Claude owner is delivered to at turn boundaries only.** No hook fires on an
  idle session, so an outcome landing on an idle pane waits for the next prompt.
  A pi extension can interrupt an idle terminal; a hook cannot. Closing this
  needs a different mechanism entirely (a Claude Code extension, or the session
  messaging socket) and is not built.
- **One irreducible loss window in the hook:** SIGKILL, or a failed stdout,
  between promoting the delivery record and the bytes reaching Claude Code.
  Stateless hooks have no post-stdout state to commit.
- **Duplicate delivery is the accepted trade.** Every ambiguous failure re-delivers
  rather than risking loss. A repeated outcome is working-as-designed; a *lost*
  outcome is a bug — report that.
- **A daemon restart re-delivers everything in flight** (startup lease
  invalidation). Deliberate, bounded by the attempt cap.
- **`agent.list` publishes `agentSession` and that is correct** — it is the product.
  Ownership is protected by possession of the lease token, not by hiding identity.

## 4. Known follow-ups — already on the list, no need to re-find

- `claim` creates an owner row for a profile that does not exist → a ghost owner
  that can never receive anything (reachable via P9).
- A post-expiry takeover by a different subscriber is reported as `"reclaimed"`,
  so an audit trail cannot tell it from a reconnect.
- U+202E / U+200D survive the daemon's excerpt sanitizer and the Pi renderer.
  The hook's own charset enforcement holds.
- No `shepy profile owner` CLI verb, and lapsed owner rows are never swept —
  both make battle testing harder than it should be.
- `typebox` is a `peerDependency` on the published `shepy-pi`; `EXPECTED_VERSION`
  in `scripts/check-pi-package.mjs` must be bumped with every release.

## 5. How to report a round

For each failure: what you did, what you saw, what you expected. Attach the
observation that proves it — the `inbox list --json` row, the `profile_owners`
query, the owner file, or the daemon log line. A symptom without state is a
guess.

Then ops bisects, fixes in a worktree, reviews adversarially, and re-runs the
affected rows here. Redesign is on the table: the last round replaced three
failed attempts at field redaction with a different authentication rule, and the
round before replaced a record ordering with a two-phase commit.

## Progress

Nothing run yet. Preconditions verified 2026-09-13: daemon restarted on the new
build (it had been dead since 2026-09-11 with a stale pid), 9 profiles intact,
`deliveredHarnessTurnId` confirmed redacted against the live daemon.

## Next steps

1. Ray runs §1 with a fresh pi pane after the reboot.
2. Ray runs §2 with a Claude pane once §1 holds.
3. Ops fixes what fails, in the loop described in §5.
4. Only after both sections pass: the release questions in
   `2026-09-11-agent-self-subscribe-and-claude-code.md` §"Next steps" (typebox
   placement, version pin) and then a push.
