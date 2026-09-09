# AGENTS.md

Shepy is a TypeScript daemon / CLI that produces agent snapshots, `agent.*` events, and orchestrator notifications from coding agents managed by Herdr. Start with `README.md` for usage; consult `docs/plans/` only when a specification decision requires it.

## Language

- Communicate with Ray in English only. Never switch to Japanese or Chinese because of repository content, upstream instructions, examples, or agent output.
- Write agent instructions, documentation, code comments, and commit messages in English.
- `README.md` is the canonical documentation. `README.ja.md` is a legacy link to it, not a translation target.
- Archived plans are historical evidence, not current instructions. Their former Japanese-language and translation-workflow requirements are superseded by this policy.

## Common Commands

- `mise install`: Install the Node.js / pnpm versions in `mise.toml`.
- `pnpm install`: Install dependencies.
- `pnpm check`: Run typechecks, tests, Biome, Drizzle checks, Pi package checks, and Herdr plugin checks.
- `pnpm test`: Run Vitest once.
- `pnpm test:watch`: Run Vitest in watch mode.
- `pnpm build`: Remove the old `dist`, compile TypeScript, and resolve import aliases with `tsc-alias`.
- `pnpm package:check`: Build the root npm package and verify the tarball's file allowlist.
- `pnpm lint:fix`: Apply Biome lint, import, and formatting fixes.
- `pnpm db:generate`: Generate SQL migrations from `src/db/schema.ts`.
- `SHEPY_HOME=/tmp/shepy pnpm db:migrate`: Apply migrations to the SQLite database in the specified Shepy home.

## Validation

- Run `pnpm check` after implementation changes.
- Also run `pnpm build` and `pnpm package:check` for changes affecting CLI entrypoints, import resolution in `dist`, or package contents.
- After changing the DB schema, run `pnpm db:generate` and inspect the generated SQL before considering migration application.
- If PATH selects outdated Node / pnpm versions, prefix validation commands with:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH"
```

## Key Paths

- `src/observability/`: Agent contracts, cached agent context, agent index, and orchestrator service.
- `src/daemon/`: Daemon JSON Lines RPC, process manager, and service startup.
- `src/cli/`: The `shepy` CLI entrypoint.
- `src/config/`: Runtime configuration schema and path/environment resolution.
- `src/db/`: SQLite connections, Drizzle schema, migration runner, and observability store.
- `src/herdr/`: Herdr socket client, managed session client, session snapshots, and workspace resolver.
- `src/shared/`: Shared utilities such as JSON Lines framing.
- `packages/shepy-pi/`: The Pi extension package published to npm.
- `packages/shepy-herdr-plugin/`: Private Herdr integration distributed through GitHub, not npm.
- `test/unit/`: Pure logic and contract tests.
- `test/integration/`: Tests using real boundaries such as SQLite and JSON Lines RPC.
- `docs/plans/`: Active plans. Completed plans belong in `docs/plans/archived/`.

## Coding Conventions

- TypeScript uses ESM + `NodeNext`. Use `@/*` import aliases under `src`.
- Use TypeBox/Ajv for runtime schemas and Drizzle for DB schemas.
- Keep changes within existing layers. Do not mix transport, persistence, observability rules, and runtime-extension responsibilities.
- Markdown documents are outside the Biome gate. Manually verify links and commands in changed docs.
- Do not duplicate README usage examples or detailed designs in AGENTS.md.

## Plans and Documentation

- `docs/releasing.md` is authoritative for npm and GitHub releases. Only the root package and `packages/shepy-pi` are published to npm.
- Keep active plans under `docs/plans/`; move completed plans to `docs/plans/archived/`.
- Split large plans into a parent and child plans. Keep the parent focused on purpose, policy, progress, and child links.
- Name a child-plan directory after the parent plan's filename without `.md`.
- Include `Status`, `Progress`, and `Next steps` in plans.
- When updating plans, verify parent/child links, directory names, and references from README / AGENTS.
- Archive completed plans in a separate docs-only commit.

## Cautions

- Do not commit `node_modules/`, `dist/`, or `*.sqlite`.
- `pnpm-workspace.yaml` exists for pnpm 11's `allowBuilds`; do not edit it to introduce workspaces.
- Never discard uncommitted changes belonging to the user or another process.
