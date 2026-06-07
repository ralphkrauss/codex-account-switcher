# Changelog

## 0.2.4 - 2026-06-07

### Changed

- `cx hermes use <account>` now participates in remote-backed profile setup: when 1Password sync is configured, missing or safely remote-newer account slots auto-pull before seeding the requested Hermes profile.
- `cx hermes sync <account>` now pushes the refreshed cx account slot back to 1Password when remote sync is configured, keeping Hermes refreshes shareable across machines.

### Fixed

- Added CLI regression coverage proving Hermes integration can target a second Hermes profile without writing to the default/current Hermes home.

## 0.2.3 - 2026-06-06

### Fixed

- Refuse automatic writeback when live `auth.json` has a different Codex `tokens.account_id` than the current profile slot, preventing out-of-band `codex login` or manual auth changes from making two profiles point at the same ChatGPT account.

## 0.2.2 - 2026-06-06

### Fixed

- Use private 1Password JSON templates for `auth_json` and sync metadata writes instead of passing secrets/multiline JSON as command arguments; this avoids Windows `.cmd` argument truncation and keeps credentials out of process listings.

## 0.2.1 - 2026-06-06

### Fixed

- Run Windows `.cmd`/`.bat` 1Password CLI shims through a shell so fake/test and npm-installed command shims work on Windows smoke jobs.

## 0.2.0 - 2026-06-06

### Added

- Add magic sync for remote-backed Codex profiles: `cx use`, `cx run`, shortcut `cx <profile> ...`, `cx save`, and `cx login` now automatically pull/push through the configured remote backend when safe.
- Add non-secret sync metadata and SHA-256 state tracking so auto-sync can detect `in-sync`, `remote-newer`, `local-newer`, `diverged`, and `unknown` states without printing auth JSON.
- Add `CX_AUTO_SYNC=0` / `CX_MAGIC_SYNC=0` / `CX_NO_MAGIC_SYNC=1` opt-outs for debugging or manual sync workflows.

### Changed

- `cx sync status` now reports sync state in addition to local/remote presence.
- Legacy 1Password items without metadata remain pullable and are upgraded with metadata on the next push.

### Fixed

- Auto-sync refuses to overwrite diverged local and remote credentials; users must resolve conflicts with explicit sync commands.
- Implicit magic sync skips the reserved local `default` account so backwards-compatible local `cx save/use default` workflows are not broken by remote config.
- Active-profile auto-pull now writes back refreshed live auth first, so unsaved local refreshes become conflicts instead of being overwritten by remote changes.
- Remote metadata hashes are verified against the actual remote `auth_json`; stale or mismatched metadata is treated conservatively instead of trusted for auto-sync decisions.
- Auto-push reports diverged local/remote credentials instead of silently skipping after `cx save`, `cx login`, or post-run writeback.
- Auto-push no longer recreates a previously synced remote item that was deleted; explicit `cx sync push <profile>` is required for deliberate recreation.

## 0.1.8 - 2026-06-06

### Fixed

- Fix `cx sync push <inactive-account>` so it no longer writes the live `auth.json` back to a different active marker or fails with `unexpected writeback account ...`.
- Fix `cx sync push --all` when a current account marker exists by only writing refreshed live auth back for the profile currently being pushed.

## 0.1.7 - 2026-06-06

### Added

- Add `docs/AGENT_SETUP.md`, a copy-pasteable agent setup guide for installing Codex, `cx`, and 1Password-backed profiles on personal devices without exposing auth secrets.
- Expand the README with quick-start setup steps, agent-safe verification commands, bootstrap/push guidance, and troubleshooting links.

## 0.1.6 - 2026-06-06

### Added

- Add native `cx 1password setup` for one-command 1Password-backed profile setup, vault verification, optional bulk pull, and optional account selection.
- Add `cx 1password status` as a friendly status alias for local/remote profile presence.
- Add `cx sync push --all` and `cx sync pull --all` for bulk profile syncing.
- Treat remote-only 1Password items as first-class profiles in `cx sync status`.

### Changed

- `cx use <account>`, `cx run <account> -- ...`, and the backward-compatible `cx <account> ...` form now auto-pull a missing local profile from configured 1Password sync before switching.

## 0.1.5 - 2026-06-06

### Fixed

- Read multiline concealed `auth_json` values from 1Password item JSON so `cx sync pull` round-trips pretty-printed Codex auth files.
- Write back the active live `auth.json` before `cx sync push <account>` so refreshed Codex tokens are uploaded.

## 0.1.4 - 2026-06-06

### Changed

- Treat `default` as the live Codex auth target rather than a syncable remote account; remote sync now covers named account slots only.

## 0.1.3 - 2026-06-06

### Fixed

- Use 1Password CLI's accepted `Secure Note` category label when creating remote sync items.

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
