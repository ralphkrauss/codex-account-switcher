# Contributing

## Local setup

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

## Development rules

- Use Node.js 22+.
- Keep credential contents out of logs, tests, docs, and fixtures.
- Write tests for behavior changes before implementation.
- Prefer small, dependency-light TypeScript.
- Run `pnpm verify` before opening a PR or tagging a release.

## Release readiness

Releases are tag-driven through GitHub Actions. See `PUBLISHING.md`.
