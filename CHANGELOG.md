# Changelog

## 0.3.2 - 2026-07-08

### Fixed

- Preserve Codex arguments containing spaces on Windows when launching npm `.cmd` shims such as `codex.cmd`, including `cx resume <session> "follow up"` prompts.

## 0.3.1 - 2026-07-08

### Fixed

- Update live `auth.json` when `cx sync pull <active-account> --force` pulls the currently active profile, preventing stale live credentials from being written back over freshly pulled remote credentials on the next `cx use` or `cx <account>` invocation.

## 0.3.0 - 2026-06-12

### Added

- Add a Google Drive remote backend for saved Codex profiles. `cx backend setup gdrive oauth --client-secret <file> --auth-url` prints a browser authorization URL, and `cx backend setup gdrive oauth --auth-code <redirect-url-or-code>` completes the paste-code flow on headless/devbox machines.
- Store Google Drive profiles in Drive `appDataFolder` by default, with optional `--folder-id <id>` for normal/shared folders and optional `CX_GDRIVE_ENCRYPTION_KEY` client-side encryption for remote file bodies.
- Add backend-neutral `cx backend status`, `cx backend list`, and `cx backend setup ...` commands while keeping existing 1Password setup and `cx sync ...` workflows backward-compatible.
- Add `cx limits <account>|--all [--json]` for best-effort Codex/ChatGPT usage-window telemetry. JSON mode is designed for orchestrators to choose an account before fan-out, and output avoids printing account tokens.
- Add production-safe `cx run --account <name> -- ...` isolation. Each invocation copies the selected account into a temporary per-run `CODEX_HOME`, launches Codex there, then writes refreshed child auth back to `accounts/<name>.json` when safe, without changing shared `auth.json` or `.current-account`.
- Add non-interactive run controls for orchestrators: `cx run` now closes child stdin by default when `cx` is not attached to a TTY, `--no-stdin` forces closed stdin, and `--stdin` / `--inherit-stdin` opt back in when stdin passthrough is intentional.
- Add `cx run --timeout <seconds> -- ...`; on expiry, `cx` terminates the child process group and exits `124`.

### Changed

- Existing interactive and backward-compatible commands keep their old behavior: `cx run <name> -- ...` still switches shared state before launch, `cx run -- ...` still uses the current account, and `cx ls` / `cx use <name>` behavior is unchanged.
- Package docs now include an orchestrator launch recipe using `cx run --account <name> --timeout <seconds> -- exec ...`, plus the branchable operational exit codes.

### Fixed

- Prevent non-interactive Codex runs from hanging their caller after Codex has finished but is still waiting for extra stdin.
- Prevent an interactive `cx use <name>` on the same machine from swapping the shared `auth.json` underneath a live orchestrated `cx run --account <name>` invocation.
- Map Codex stderr that looks like quota/rate-limit exhaustion (`usage limit`, `rate limit`, `quota`, `429`, etc.) to exit code `75`, so callers can branch without grepping stderr.

## 0.2.6 - 2026-06-08

### Added

- Add `cx resume [codex resume args...]` as a first-class passthrough for `codex resume`, including session IDs, prompts, and Codex resume flags such as `--last` and `--include-non-interactive`.

## 0.2.5 - 2026-06-07

### Fixed

- `cx` now loads `~/.config/1password/op.env` itself when `OP_SERVICE_ACCOUNT_TOKEN` is not already in the shell, so 1Password sync commands do not fall back to an interactive vault unlock prompt on fresh or existing terminals.
- 1Password sync now discovers `op` from `CX_OP_PATH` and common Homebrew install locations (`/opt/homebrew/bin/op`, `/usr/local/bin/op`) even when the user's `PATH` does not include Homebrew.

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
