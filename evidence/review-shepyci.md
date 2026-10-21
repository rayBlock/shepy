# SHEPYCI review: fix/shepyci (48439c3 test fix, 5fc0ba8 report)

Reviewer: rev-shepyci (independent), worktree detached at candidate 5fc0ba8. Brief: `evidence/20261021-day/brief-SHEPYCI.md` in agent-factory.

## VERDICT: ACCEPT

## 1. The CI failure is real, and the fix removes the false failure without hiding anything

Confirmed the actual failing CI run read-only: `gh run view 39469067925 -R rayBlock/shepy --log-failed` shows `AssertionError: expected 4721738 not to be 4721738` at `claude-hook.test.ts:3336`, test "the owner file is replaced by rename, never truncated in place", 1 failed of 73 files — exactly what the report claims.

Verified the root cause in source, not just in the report:

- `writeOwnerRecordAtomic` (`src/cli/owner-file.ts:292`) is a correct atomic writer: fresh O_EXCL 0600 temp file, write, fchmod, fsync, `renameSync` over the target. It never opens the target in place.
- One hook run writes the record more than once (the leased transition and the delivered transition each go through the rename path). So during the second run: rename #1 frees the old inode (`before.ino`), then temp file #2 is created — and Linux (ext4/tmpfs) can hand the just-freed inode number straight to the next created file. A *correct* writer then fails `after.ino !== before.ino`. APFS does not reuse inode numbers this way, which is why macOS never failed.

The fix is the textbook-correct one: hard-link the old owner file before the second run. The link keeps the old inode allocated (nlink ≥ 2), so no later temp file can ever land on that number. The check now fails only for a writer that genuinely truncates in place.

## 2. The assertion still proves what it claimed — and proves more

- The original `after.ino !== before.ino` assertion is kept, now deterministic: a rename-based writer always passes (old inode pinned, cannot be reused), an in-place writer still fails it.
- Two new assertions strengthen the test: the pinned link still resolves to the old inode, and the pinned bytes are byte-identical after the run. That is a check the old test could not make: any in-place write to the old inode would be visible through the hard link.
- No tests skipped, no timeouts raised, no lint weakened. The inline comment in the test documents the Linux inode-reuse mechanism accurately.

## 3. The other changed file is justified

`test/integration/claude-profile-demand-validation.test.ts` is a source-pairing integrity gate: the fixture refuses to run unless each pinned file's SHA-256 matches. The commit updates exactly one pin — the hash of `claude-hook.test.ts`, which the same commit necessarily changed. I recomputed it: `shasum -a 256 test/integration/claude-hook.test.ts` = `532a625f181ddcfcf1129167a6eb76ff7010a8de3de533b3d8f428b954b8b32c`, exactly the new pinned value. Prior fix commits e229eeb and f3e0635 followed the same pin-bump pattern when touching pinned files. No other pins were altered.

## 4. Side-effect check on the `.pinned` link

- Fixture cleanup removes whole temp dirs recursively (`rmSync(dir, {force, recursive})`), so the link does not leak between tests.
- No production code enumerates the owners directory (`readdirSync` appears only in tests), and the leftover-temp check (`.endsWith(".tmp")`) is unaffected by a `.pinned` sibling.

## 5. Validation run in this worktree (Node 24, macOS)

| Command | Result |
|---|---|
| `PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm install --frozen-lockfile` | exit 0, 3.8s |
| `pnpm check` | exit 0 (typechecks, tests, Biome, Drizzle, Pi package, Herdr plugin) |
| `pnpm build` | exit 0, stamped `5fc0ba8` |
| `pnpm vitest run test/integration/claude-hook.test.ts -t "replaced by rename"` | 1 passed |

## Caveats (non-blocking)

- I did not re-run the builder's Linux Docker reproduction on this macOS host; the CI log, the source-level mechanism (multiple renames per run plus Linux inode reuse), and the failing/passing CI history make the diagnosis convincing. The decisive proof is the next pushed GitHub run, which the report itself flags as not yet verified.
- The report honestly lists 40 `pnpm audit` advisories (brace-expansion among them) as untouched-but-listed, consistent with the brief's "update only if you touch it anyway" rule. Nothing in the fixed path touches them.
- One earlier local Linux run tripped a different timing-sensitive test ("canonical live milliseconds"); the report discloses it. Worth watching on the next CI run, but it is not this fix's concern.

Fix is test-only, no source change, cause addressed rather than check weakened. Accept.
