# Publishing and Release Process

This package is published publicly as:

```text
@ralphkrauss/codex-account-switcher
```

The repository uses npm Trusted Publishing. GitHub Actions publishes from git tags; no long-lived `NPM_TOKEN` is required for the normal release flow.

## Mental model

- `latest` is the stable npm dist-tag.
- `next` is the prerelease npm dist-tag.
- Stable versions look like `0.1.0` and publish to `latest`.
- Prerelease versions look like `0.1.1-beta.0` and publish to `next`.
- `npm version ...` updates `package.json`, updates `pnpm-lock.yaml`, creates a git commit, and creates a matching git tag.
- The `Publish npm` GitHub workflow runs when a `v*.*.*` tag is pushed.
- Release notes are extracted from the matching `CHANGELOG.md` section.

## One-time npm setup

The first public publish of a scoped package may need to be done manually so the package exists on npm. After that, configure Trusted Publishing on npm:

- Package: `@ralphkrauss/codex-account-switcher`
- Repository owner: `ralphkrauss`
- Repository name: `codex-account-switcher`
- Workflow filename: `publish-npm.yml`
- Environment: leave empty

The workflow has `id-token: write`, which npm uses for OIDC trusted publishing.

## Verification before any release

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` builds, tests, checks publish readiness, resolves the npm dist-tag, audits production dependencies, and runs `npm pack --dry-run`.

Before tagging, ensure `CHANGELOG.md` has a non-empty section for the exact version, for example:

```text
## 0.1.0 - 2026-06-04
```

## Beta/test release

```bash
node scripts/extract-changelog-release-notes.mjs <next-beta-version> >/tmp/release-notes.md
pnpm verify
npm version prerelease --preid beta
git push origin main --follow-tags
```

Test the beta:

```bash
npm view @ralphkrauss/codex-account-switcher@next version
npx -y @ralphkrauss/codex-account-switcher@next doctor
```

## Stable release

```bash
node scripts/extract-changelog-release-notes.mjs <next-stable-version> >/tmp/release-notes.md
pnpm verify
npm version patch
git push origin main --follow-tags
```

For minor or major releases:

```bash
npm version minor
npm version major
```

Then push with:

```bash
git push origin main --follow-tags
```

## What the GitHub Action checks

1. Installs dependencies with the lockfile.
2. Checks the git tag matches `package.json`.
3. Runs `pnpm verify`.
4. Chooses npm dist-tag: prerelease => `next`, stable => `latest`.
5. Skips publishing if the exact package version already exists.
6. Publishes with `npm publish --access public --provenance --tag <tag>`.
7. Extracts release notes from `CHANGELOG.md`.
8. Creates or updates the GitHub Release for the same tag.

## Installed-package smoke test

```bash
package_file="$(npm pack --silent | tail -n 1)"
temp_dir="$(mktemp -d)"
cd "$temp_dir"
npm init -y >/dev/null
npm install "/path/to/codex-account-switcher/$package_file"
CODEX_HOME="$temp_dir/codex-home" ./node_modules/.bin/cx --help
CODEX_HOME="$temp_dir/codex-home" ./node_modules/.bin/cx doctor
```

## Inspecting npm state

```bash
npm view @ralphkrauss/codex-account-switcher version
npm view @ralphkrauss/codex-account-switcher versions --json
npm dist-tag ls @ralphkrauss/codex-account-switcher
npm view @ralphkrauss/codex-account-switcher@next version
```
