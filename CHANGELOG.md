# Changelog

## 0.1.1 - 2026-06-04

### Added

- `cx login <name>` now forwards Codex login arguments such as `--device-auth` for headless/remote authentication.

### Changed

- Documented device-auth and separator-based login examples.

## 0.1.1-beta.0 - 2026-06-04

### Changed

- Test prerelease for npm Trusted Publishing from GitHub Actions.

## 0.1.0 - 2026-06-04

### Added

- Initial installable `cx` CLI package for Codex account switching.
- Safe account storage under `CODEX_HOME/accounts` with POSIX private permissions where supported.
- Commands for listing, saving, using, logging in, renaming, removing, running Codex, and diagnostics.
- Strict account-name validation and path traversal protection.
- Writeback safeguards so deleted active slots are not recreated.
- npm Trusted Publishing workflow, CI, tests, and package verification scripts.
