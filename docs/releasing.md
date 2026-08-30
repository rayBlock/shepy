# Releasing Shepy

Shepy is distributed **source-only** from the public GitHub repository
(`rayBlock/shepy`). Nothing is published to npm. Users install from the git
URL or a clone; updates are git pulls.

Shepy is a fork of [ryonakae/shepherd](https://github.com/ryonakae/shepherd)
(MIT). Keep the LICENSE attribution (Ryo Nakae's copyright line plus ours)
and the README fork note intact in every release.

| Artifact | Distribution |
| --- | --- |
| repository root | `npm install -g rayBlock/shepy` (git URL) or clone + `npm install -g .` |
| `packages/shepy-pi` | installed by Pi from the repo path (`pi install` pointing here) |
| `packages/shepy-herdr-plugin` | GitHub repository subdirectory installed by Herdr: `herdr plugin install rayBlock/shepy/packages/shepy-herdr-plugin --ref <tag> --yes` |

## Preconditions

Run releases from the repository root on `main`. Replace the version below
with the version being released.

```bash
export VERSION=0.6.0
export TAG="v$VERSION"
export PATH="/opt/homebrew/Cellar/node@24/24.19.0/bin:$PATH"

git fetch origin main
test "$(git branch --show-current)" = "main"
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
gh auth status
```

Node >= 24.18.0 is mandatory (`engines.node`). The full gate must pass under
it before anything ships:

```bash
pnpm check
pnpm build
pnpm smoke:install   # tarball -> isolated prefix -> bin runs
```

## Update versions

Keep these files synchronized:

- `package.json`
- `packages/shepy-pi/package.json`
- `packages/shepy-herdr-plugin/package.json`
- `packages/shepy-herdr-plugin/herdr-plugin.toml`

The README's Herdr plugin install command references the release tag; update
the `--ref` examples to the new tag.

## Cut the release

```bash
git add package.json packages/*/package.json packages/shepy-herdr-plugin/herdr-plugin.toml README.md README.ja.md
git commit -m "chore(release): $VERSION"
git tag -a "$TAG" -m "Shepy $VERSION"
git push origin main "$TAG"
gh release create "$TAG" --title "Shepy $VERSION" --notes-file <notes.md>
```

Release notes: summary of changes, install/upgrade commands (git URL),
attribution line for anything ported from upstream shepherd, and the
matching upstream version the fork tracked at that point.

## Consumer verification (per release)

1. **npm from git URL** (the primary install path):

   ```bash
   npm install -g "https://github.com/rayBlock/shepy.git#$TAG"
   shepy --version          # must print shepy $VERSION
   shepy daemon status      # valid JSON
   ```

2. **npm from a clone** (the documented fallback):

   ```bash
   git clone https://github.com/rayBlock/shepy && cd shepy
   npm install -g .
   shepy --version
   ```

3. **Bun** (manual, operator-run — `bun add --global <tarball>`): verify
   `shepy --version` and `shepy daemon status`. Bun is a consumer path, not
   the runtime authority; Node >= 24 remains the supported runtime.

4. **Herdr plugin**: `herdr plugin install
   rayBlock/shepy/packages/shepy-herdr-plugin --ref "$TAG" --yes`, then
   confirm it appears in `herdr plugin list` and renders agent rows.

5. **Pi extension**: install from the repo path and confirm `/shepy status`
   responds in a Pi pane inside Herdr.

## What we deliberately do NOT do

- No `npm publish` — for any package, ever. The npm names `shepy` /
  `shepy-pi` staying unpublished is intentional; do not squat them.
- No release automation workflows. CI validates pushes; releases are
  manual, small, and fully read back through the consumer checks above.
- No changelog gates. Keep `CHANGELOG.md` (if present) hand-maintained.

## Rollback

A git tag is the release. To withdraw a broken release: delete the GitHub
Release and tag (`git push origin :refs/tags/"$TAG"`), fix forward on main,
cut `$VERSION+1`. Installed consumers pin what they installed; the git URL
default tracks main.
