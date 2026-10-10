# ROW 15.262 final closeout

Recorded UTC: 2026-10-10T00:36:48Z. This supplements, and does not edit, the original `receipt.md`.

- **Merge:** `8850339da79da2b6a01f091d23dfb7667868842d`; approved rebased candidate `471516dbbc9a896e0659cc79f98a91088a306642` is its second parent.
- **Evidence commit:** `22594646ca33f805e091128674602373d8bb5361`.
- **Real hook:** the attempt during the canonical partial purge failed EXIT=1 (`hook-attempt-before-restore.log`). After canonical repair/isolation proof, the real hook passed EXIT=0: tsc, full Vitest 746/746, Biome with one retained unused-import warning, format, and Drizzle check (`hook-success-after-restore.log`). Raw records and hashes are included alongside this receipt; no hook bypass was used.
- **Queue CAS:** row 15.262 set `done` with merge SHA `8850339...`; receipt path is `receipt.md`. Raw CLI output `queue-cas.log`, EXIT=0.
- **Exact landing remote:** the authorized `shepy -> origin/shepy` push advanced `beb71fd` to `22594646ca33f805e091128674602373d8bb5361`, EXIT=0; post-push `ls-remote` matched that SHA. Raw output `landing-push.log`. This records the packet landing ref before this supplemental closeout record.
- **Resources:** candidate `spawn/opencode-v2` worktree and branch were closed after verification. Local tag `ocv2-original` still points to original `b63d40f4d5fda2a67bbd9d1858728f5679a4ede1`. No daemon activation or live DB migration; no agent-factory commit/push. The docs-restore ticket remains under engine authority.

Documentation-only follow-up; no source rebuild, dependency install, daemon, or database action was performed for this receipt.
