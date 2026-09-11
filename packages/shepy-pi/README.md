# shepy-pi

Pi >= 0.80.6 extension for Shepy agent history and automatic agent-update wake.

This package contains the runtime extension only. The Agent Skill remains at the repository root.

Install the Shepy CLI and Pi package, then start the daemon:

```bash
npm install --global shepy
pi install npm:shepy-pi
shepy daemon start
```

When Pi runs inside Herdr, this extension connects to the Shepy daemon and registers its exact Pi session path as presence identity. It does not send per-turn tool-result or final-message telemetry.

Enter these commands in Pi, not in a shell:

```text
/shepy on
/shepy
/shepy status
/shepy off
```

`on` enables both cached agent context and automatic agent-update wake for this Pi. It makes this terminal the sole owner in its current Herdr session/workspace and replaces any existing owner. Only the owner receives cached context, pending counts, updates, and wake. Context excludes the owner Pi and includes other Pi terminals. A normal prompt uses the local cached snapshot without daemon RPC or history reads, so context can be temporarily absent after startup, reconnect, or scope movement until a snapshot arrives.

`off` disables both context and wake for this Pi while keeping the daemon connection available for a later claim. It does not release another Pi's ownership. Bare `/shepy` and `/shepy status` report whether the current Pi is on.

Profile ownership (`/shepy on <profileId>`) has a second claim surface: the `shepy_profile` tool, callable by the model. `action: "claim"` with a `profileId` performs the same claim as the command, under the same fail-closed rules — a claim never takes a profile from a live owner. A rejection names the current owner's pane and harness, arrives as a normal tool result, and is final; the model must read it and stop, not retry. `action: "release"` releases this pane's ownership, and `action: "status"` reports profile mode, pending count, and daemon connection from local extension state. Tool results never contain the lease token, which is a capability held by the extension, not by the model. Older Pi hosts without tool support degrade to the command path.

A dispatched pane can own its profile without anyone typing: when `SHEPY_PROFILE` is set and non-empty at session start, the extension claims that profile as soon as the daemon connection and launch identity are available, notifying exactly like `/shepy on <profileId>`. A rejected claim notifies and leaves the pane unowned; it is never retried on a timer — the only later attempts are the next presence registration after a reconnect, or an explicit claim. Whitespace-only values behave like an unset variable. Whatever launches the pane exports `SHEPY_PROFILE=<profileId>` and the agent is the owner before its first token.

An agent outcome starts one visible Shepy turn. If a normal user run is active, wake waits for it to settle. The themed card shows up to three outcomes with agent identity, completion state, and pane ID. A named agent appears as `reviewer · Codex`; an unnamed agent appears as `Codex`. Pi's expand key reveals every bounded final response. Agent output is untrusted evidence, so Pi continues only the existing user request and does not create unrelated work.

Only the active Pi displays `◆ Shepy` in the footer. Pending outcomes add `· N agent updates` until Pi produces a final assistant response, settles, and acknowledges every event included in that turn. A previously active Pi displays `◇ Shepy · reconnecting` during transport recovery.

With no owner, outcomes are not delivered, and outcomes created during that ownerless period are not replayed by a later claim. The daemon persists ownership across brief reconnects and Pi session replacement. Reloads, reconnects, and direct owner replacement preserve unacknowledged outcomes. Ownership follows the same Herdr terminal when its pane moves to another workspace. Disconnection alone never clears ownership: while the owner is away, its lease (renewed by the pump heartbeat) simply runs out after 5 minutes plus a 30-second reconnect grace. If another pane claims during that window, its claim is rejected and nothing moves at expiry — the rival pane must claim again once the lease and grace have lapsed. If nobody contests it, the expired lease still belongs to the returning pane, but it can no longer be renewed — the returning owner's heartbeat fails closed, and the next claim by any pane takes the profile immediately.
