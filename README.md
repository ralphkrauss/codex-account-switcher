# Codex Account Switcher

`cx` runs each named Codex account from its own stable `CODEX_HOME`. It is designed for people who use several ChatGPT/Codex accounts on one device and want the same profile names on other devices without sharing rotating OAuth credentials.

Version 0.4 no longer switches accounts by copying `auth.json`. Every profile owns its credential file, configuration, sessions, app-server state, and refresh-token lineage.

## Why this model

Codex automatically refreshes ChatGPT OAuth credentials and writes the rotated bundle back to `auth.json`. OpenAI's operational guidance says to use one `auth.json` per machine or serialized workflow stream and not share it across concurrent jobs or multiple machines. See [Codex authentication](https://developers.openai.com/codex/auth/) and [CI/CD authentication guidance](https://learn.chatgpt.com/docs/auth/ci-cd-auth).

That makes a copied credential a single-writer state file, not a portable account password. Two devices, two apps, or two concurrent processes that refresh copies of the same token can invalidate one another. `cx` therefore isolates writers and asks Codex and Hermes to authenticate independently.

## Install

```bash
npm install -g @openai/codex @ralphkrauss/codex-account-switcher
```

Requires Node.js 22+ and the native Codex CLI on `PATH`.

## Quick start

Create each profile locally:

```bash
cx login personal --device-auth
cx login gi --device-auth
cx login beta --device-auth
cx ls
```

Run the TUI or a non-interactive command:

```bash
cx personal
cx run gi -- exec "review the current changes"
cx use beta
cx                         # runs the selected beta profile
cx resume --last
```

On another device, install `cx` and run the same `cx login <name> --device-auth` commands there. Reusing the names is fine; copying the files is not.

## Data layout

`cx` uses `CODEX_HOME` when set, otherwise `~/.codex`:

```text
~/.codex/
├── .current-account
├── accounts/
│   ├── personal/
│   │   ├── auth.json
│   │   ├── config.toml
│   │   ├── sessions/
│   │   └── app-server-control/
│   ├── gi/
│   │   ├── auth.json
│   │   └── config.toml
│   └── beta/
│       ├── auth.json
│       └── config.toml
└── auth.json                    # optional deprecated shared/root login
```

Each profile config is pinned to:

```toml
cli_auth_credentials_store = "file"
```

This is necessary because Codex can otherwise choose the OS keyring, which is not scoped by `CODEX_HOME`. Newly created credential files use private permissions where the platform supports them, and writes are atomic.

## Commands

```bash
cx ls
cx login <name> [--force] [codex login args...]
cx use <name>
cx <name> [codex args...]
cx run [name] [--no-stdin] [--timeout <seconds>] -- [codex args...]
cx run --account <name> [--no-stdin] [--timeout <seconds>] -- [codex args...]
cx resume [codex resume args...]
cx rename <old> <new> [--force]
cx rm <name>
cx limits <name>|--all [--json]
cx doctor [--json]

cx hermes login <account> [--profile <name>]
cx hermes run <account> [--profile <name>] -- [hermes args...]
cx hermes status [account] [--profile <name>] [--json]
```

Account names may contain letters, numbers, `.`, `_`, and `-` only.

## Writer safety and concurrency

`cx` holds an exclusive lock for the full lifetime of Codex or Hermes when that process can use a profile's Codex state. A second writer to the same profile exits with an actionable error.

Different profiles can run concurrently:

```bash
cx run gi-worker-1 -- exec "task one"
cx run gi-worker-2 -- exec "task two"
```

Create worker profiles with separate logins, even if they sign in to the same ChatGPT account:

```bash
cx login gi-worker-1 --device-auth
cx login gi-worker-2 --device-auth
```

Do not clone `gi` into the worker profiles. Separate logins create separate credential ownership; copied files recreate the refresh race.

For orchestrators, `--no-stdin`, `--timeout`, and the exit codes are useful:

- `0`: Codex completed successfully.
- `75`: Codex stderr looked like quota or rate-limit exhaustion.
- `124`: the timeout expired and `cx` terminated the child process group.
- Other non-zero values: normal Codex/process failure.

## Hermes integration

Hermes intentionally keeps its `openai-codex` OAuth session separate from Codex. Its own documentation says the two sessions should not share OAuth state because either client may refresh and clobber the other. See the [Hermes Codex runtime guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/codex-app-server-runtime.md).

Authenticate Hermes independently for the corresponding cx account:

```bash
cx hermes login gi
cx hermes status gi
cx hermes run gi -- chat
```

By default, account `gi` maps to Hermes profile `cx-gi`. `cx hermes login gi` runs Hermes's native flow:

```text
hermes --profile cx-gi auth add openai-codex
```

Hermes reserves the profile ID `default` for its canonical root home at `~/.hermes`; it is not a named profile under `~/.hermes/profiles/`. To use an existing primary/default Hermes installation, pass it explicitly:

```bash
cx hermes login gi --profile default
cx hermes status gi --profile default
cx hermes run gi --profile default -- chat
```

Complete that login as the same ChatGPT account/workspace used by the cx profile. When token claims expose an account ID, `cx` rejects a detected mismatch.

`cx hermes run gi` supplies both:

- Hermes profile `~/.hermes/profiles/cx-gi`
- Codex profile `~/.codex/accounts/gi` as `CODEX_HOME`

This matters if Hermes uses its Codex app-server runtime: the runtime consumes Codex's session, while Hermes's direct `openai-codex` provider consumes Hermes's independent session.

`cx hermes status` reports token presence and the access-token expiry when it can derive one. It does not contact the provider, so only an actual Hermes request can prove that a refresh token is accepted.

## Upgrading from 0.3

Stop Codex, Hermes, and any Codex app-server processes using these profiles, then upgrade:

```bash
npm install -g @ralphkrauss/codex-account-switcher@latest
cx ls
cx doctor
```

The first `cx ls`, `cx use`, or run migrates legacy files automatically:

```text
accounts/gi.json       -> accounts/gi/auth.json
accounts/personal.json -> accounts/personal/auth.json
```

Original flat files are archived under `accounts/.legacy-v0.3/`. If the active legacy slot and shared `auth.json` contain the same explicit Codex account ID, migration keeps the live file so a newer locally refreshed token is not lost.

Legacy sessions remain in the old root home because `cx` cannot prove which account owns each session. New sessions are profile-scoped. Move a known session only after making a backup and verifying its account; do not link one writable sessions directory into several profiles.

After migration:

1. Run `cx doctor` and confirm each profile says `file credential store=yes`.
2. Test each profile with `cx run <name> -- --version` or a small request.
3. On every other device, log in locally instead of pulling a credential copy.
4. For every Hermes profile, run `cx hermes login <name>` once.

## Deprecated credential-copy features

These commands remain recognizable for migration and emergency recovery, but are disabled by default:

- `cx save`: copied the shared/root `auth.json` into a named profile.
- `cx sync push` / `cx sync pull`: copied active OAuth state through 1Password or Google Drive.
- automatic remote pull/push (formerly “magic sync”).
- `cx hermes use` / `cx hermes sync`: copied one rotating token family between Codex and Hermes.

Read-only backend and sync status commands remain available so existing installations can be audited without revealing tokens.

Break-glass environment variables exist for a one-time ownership transfer only:

```bash
CX_ALLOW_UNSAFE_PROFILE_IMPORT=1 cx save <name>
CX_ALLOW_UNSAFE_AUTH_SYNC=1 cx sync pull <name> --force
CX_ALLOW_UNSAFE_HERMES_TOKEN_SHARE=1 cx hermes use <name>
```

Do not export these permanently. Before using one, stop every process and device that could use the source credential. After transferring it, retire the source copy.

## Troubleshooting

### Refresh token reused, invalidated, revoked, or expired

Stop every Codex/Hermes process using the affected profile and authenticate that profile again:

```bash
cx login gi --force --device-auth
```

If this keeps happening, look for a raw `codex` invocation, IDE/desktop app, old remote copy, or another device using the same credential. `cx` cannot repair a refresh-token family that another writer has already rotated or revoked.

### Login blocked by an app-server socket

`cx login --force` refuses to replace a profile credential while that profile has an app-server control socket. Find and stop the matching process first:

```bash
ps aux | grep '[c]odex app-server'
kill <PID>
rm -f ~/.codex/accounts/<name>/app-server-control/app-server-control.sock
cx login <name> --force --device-auth
```

Remove the socket only after its process has stopped. `cx doctor` reports profile-scoped app-server sockets. A daemon in the old shared/root `~/.codex` does not affect named v0.4 profiles because they use different `CODEX_HOME` directories.

### Hermes shows the wrong account

Use one Hermes profile per cx account and reauthenticate it independently:

```bash
cx hermes login gi --profile cx-gi
cx hermes status gi --profile cx-gi
```

The deprecated multi-account token-copy bridge is disabled. Its recovery writeback also fails closed when credential ownership is ambiguous.

If `hermes auth add openai-codex` succeeds but Hermes later reports a missing provider access token, upgrade Hermes and check [Hermes issue #32730](https://github.com/NousResearch/hermes-agent/issues/32730). Some Hermes versions have a split between their credential pool and legacy provider state. Do not work around that upstream bug by copying Codex's credential into Hermes.

### Secret handling

Treat every `auth.json` like a password. Do not commit it, paste it into chat/issues, include it in logs, or store it as a public artifact. Safe diagnostics include:

```bash
cx doctor
cx ls
cx limits --all --json
cx hermes status gi --json
cx sync status
```

## Development

```bash
pnpm install
pnpm verify
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [PUBLISHING.md](PUBLISHING.md), and [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE.md](LICENSE.md).
