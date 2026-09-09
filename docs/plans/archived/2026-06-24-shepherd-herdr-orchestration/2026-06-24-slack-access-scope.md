# Slack Access Scope Plan

Date: 2026-06-24

Parent: [Shepherd Herdr Orchestration Plan](../2026-06-24-shepherd-herdr-orchestration.md)

## Status

Archived. Slack access scope MVP is implemented and tested.

## Progress

- **Done** — Team/channel/user allowlists and denial logging were implemented.
- **Done** — Slack config validation requires explicit allowed users.

## Next steps

- Keep this access policy as the baseline for Pi runtime Slack gateway work.

## Goal

Explicitly control access to Shepherd from Slack by team, channel, and user ID.

Shepherd is a control plane for agents and terminals in Herdr, not a bot open to an entire Slack workspace. The MVP targets Slack only, while leaving room to extend the same approach to Discord / Telegram through separate adapters later.

## Implementation status

Status as of 2026-06-24 latest `main`: MVP Slack access scope is implemented and covered by tests.

Implemented:

- Slack inbound access policy tests for team / channel / user AND semantics.
- unset allowlists remain unrestricted for that axis.
- bot, edit, delete, and non-message events are ignored before storage.
- `platforms.slack` without `allowed_users` emits a startup warning.
- denied Slack inbound events emit debug logs with reason and IDs, without message text.
- denied inbound events are not stored in the Shepherd DB.
- README Slack setup example includes `allowed_users` and `allowed_channels`, and uses env var names for tokens.

## Current State

`platforms.slack` has the following settings:

```yaml
platforms:
  slack:
    app_token_env: SLACK_APP_TOKEN
    bot_token_env: SLACK_BOT_TOKEN
    allowed_teams:
      - T123
    allowed_channels:
      - C123
    allowed_users:
      - U123
```

The implementation checks `teamId`, `channelId`, and `sourceUserId` with AND semantics for Slack inbound messages. An unset allowlist imposes no restriction on that axis. Startup warns when `allowed_users` is unset; denial debug logs include only the reason and IDs, never message text.

## Approach

Implement only Slack for the MVP.

Keep naming and responsibilities platform-neutral:

- Do not add Slack-specific columns to the core DB.
- The platform adapter normalizes external events and passes `platform`, `spaceId`, `threadId`, and `actor.sourceUserId` to the core.
- Treat Slack's `team_id` as binding metadata or platform metadata for policy evaluation.
- Use `allowed_channels` to restrict channel / thread entry points.
- Use `allowed_users` to restrict senders across DMs, channels, and threads.
- Use `allowed_teams` to enforce the Slack workspace boundary.

Do not copy Hermes Agent's complex admin tiers or pairing flows. Limit the Shepherd MVP to static YAML and `/reload-config`.

## Access Policy Semantics

Evaluate Slack inbound messages in this order:

1. Ignore events that cannot be normalized as Slack messages, the bot's own messages, edits, deletions, and similar events.
2. If `allowed_teams` is configured, reject messages whose `teamId` is not listed.
3. If `allowed_channels` is configured, reject channel/thread messages whose channel is not listed.
4. If `allowed_users` is configured, reject messages whose sender user ID is not listed.
5. Store only messages that pass every check in the Shepherd session and trigger a gateway turn.

An unset allowlist means "no restriction on this axis." For safe operation, however, configuration examples that enable Slack should treat `allowed_users` as required.

If stricter fail-closed behavior is introduced later, phase it in using one of these approaches to avoid an abrupt compatibility break:

- Allow an absent user allowlist only when `allow_all_users: true` is explicit.
- Warn at daemon startup when `allowed_users` is absent, then make it required at the next breaking-change boundary.

## Config Shape

Keep the existing shape for now:

```yaml
platforms:
  slack:
    app_token_env: SLACK_APP_TOKEN
    bot_token_env: SLACK_BOT_TOKEN
    allow_customize: true
    allowed_teams:
      - T1234567890
    allowed_channels:
      - C1234567890
    allowed_users:
      - U1234567890
```

Possible future extensions:

```yaml
platforms:
  slack:
    allow_all_users: false
    denied_channels:
      - C9999999999
```

Do not include `denied_channels` in the MVP. Consider it as an equivalent of Hermes's `allowed_channels` / `ignored_channels` only when allowlist/denylist precedence is needed.

## Delivery Scope

Outbound delivery follows existing session bindings. Only bindings created from Slack threads that passed inbound authorization become delivery targets, so ordinary gateway / TUI messages return to that thread.

Additional checks:

- A user message sent from the TUI to a Slack-bound session is delivered only to the authorized binding's thread.
- Decide separately whether narrowing `allowed_channels` should stop outbound delivery to existing bindings.

The MVP prioritizes inbound policy and does not retroactively disable outbound delivery for existing bindings. Add a separate delivery policy if `/reload-config` must also stop delivery to existing bindings.

## Observability

Do not reply to users when rejecting a Slack event. Avoid unnecessary information disclosure and channel noise.

Record the reason at debug level in the daemon log:

- `slack policy denied: team`
- `slack policy denied: channel`
- `slack policy denied: user`

Do not persist denied events in the event stream, so unauthorized users' message content never enters the DB.

## Future Adapter Compatibility

When adding Discord / Telegram, do not force Slack configuration names into a shared abstraction. Use each platform's natural IDs.

Expected shape:

```yaml
platforms:
  discord:
    bot_token_env: DISCORD_BOT_TOKEN
    allowed_guilds:
      - "123"
    allowed_channels:
      - "456"
    allowed_users:
      - "789"
    allowed_roles:
      - "999"

  telegram:
    bot_token_env: TELEGRAM_BOT_TOKEN
    allowed_chats:
      - "-100123"
    allowed_users:
      - "123456"
```

Limit the shared core contract to:

- Adapters normalize platform events.
- Adapters evaluate platform-specific policy before persisting inbound messages.
- The core treats only authorized messages as session events.
- DB bindings store `platform`, `spaceId`, `threadId`, and `metadata` in a platform-neutral form.

Do not bring Discord role authorization or Telegram groups / forum topics into the Slack MVP.

## Implementation Steps

1. [x] Lock the Slack access-policy contract with tests.
   - Matching team / channel / user messages are stored.
   - A mismatch on any allowlist prevents storage.
   - An unset allowlist does not restrict that axis.
   - Bot messages, edits, and deletions are not stored.

2. [x] Add startup validation / warnings.
   - Warn when `platforms.slack` is enabled without `allowed_users`.
   - If `allow_all_users` is introduced later, adjust the schema and warning in this step.

3. [x] Add denial-reason debug logs.
   - Never log message text.
   - Log only team/channel/user IDs and the denial reason.

4. [x] Update docs / example configuration.
   - Include `allowed_users` and `allowed_channels` in Slack setup examples.
   - Explicitly state that YAML contains only environment-variable names for tokens.

5. [x] Pass `pnpm check`.

## Non-goals

- Discord / Telegram adapter implementations.
- Hermes Agent's pairing flow.
- Role-based authorization.
- Slack workspace administration UI.
- DB storage of unauthorized inbound messages.
- Retroactive outbound-delivery blocking after configuration reload.

## Open Questions

- Should Slack configuration without `allowed_users` eventually be a hard error, or remain a warning?
- Should Shepherd explicitly exempt DMs from `allowed_channels`? The current implementation uses Slack channel IDs, so DMs can be restricted by listing their channel IDs; Hermes excludes DMs from the channel allowlist.
- Should the new policy also stop outbound delivery to existing Slack bindings after `/reload-config`?
