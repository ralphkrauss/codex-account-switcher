# Changelog

## 0.1.2 - 2026-06-06

### Added

- `cx hermes use <account>` imports a saved Codex account into Hermes' `openai-codex` auth/config without forking Hermes.
- `cx hermes sync <account>` copies refreshed Hermes Codex tokens back into the selected `cx` account slot.
- `cx hermes status` reports Hermes Codex auth/config state without revealing token contents.
- `cx remote configure 1password` configures a 1Password CLI (`op`) remote backend for account sync.
- `cx sync push`, `cx sync pull`, and `cx sync status` sync saved account slots through 1Password secure-note items with a concealed `auth_json` field.

### Changed

- Documented Hermes bridging and 1Password remote sync workflows.
- Expanded test coverage for Hermes auth bridging and 1Password sync using fake local credentials/`op` fixtures.

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
