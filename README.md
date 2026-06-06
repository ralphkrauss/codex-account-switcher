# Codex Account Switcher

`cx` is a small, installable CLI for switching native Codex CLI ChatGPT/OAuth accounts by swapping Codex's `auth.json` safely.

It keeps package code out of `~/.codex`; only account data lives there.

## Install

```bash
npm install -g @ralphkrauss/codex-account-switcher
```

Or try without installing:

```bash
npx -y @ralphkrauss/codex-account-switcher --help
```

Requires Node.js 22+ and the native Codex CLI on `PATH`.

## Data layout

`cx` uses `CODEX_HOME` when set, otherwise `~/.codex`:

```text
~/.codex/auth.json                  # Codex's live auth file
~/.codex/accounts/<name>.json       # saved account slots
~/.codex/.current-account           # active account marker
~/.codex/remote.json                # optional remote sync backend config
```

On POSIX, newly-created directories are `0700` and credential copies are `0600` where supported.

## Usage

```bash
cx ls
cx save personal
cx save personal --force
cx login work
cx login personal --device-auth
cx login work -- --with-api-key
cx use work
cx run work -- exec "fix the tests"
cx run -- --help
cx hermes use work
cx hermes status
cx hermes sync work
cx remote configure 1password --vault Private
cx remote status
cx sync push work
cx sync status work
cx sync pull work --force
cx rename work work-prod
cx rm work-prod
cx doctor
```

Backward-friendly shortcut:

```bash
cx work exec "fix the tests"
```

This switches to `work`, then launches `codex exec "fix the tests"`.

`cx` with no args launches `codex` if a live `auth.json` exists. If not, it prints setup guidance.

## Account names

Names must contain only:

```text
A-Z a-z 0-9 . _ -
```

Empty names, dot-only names, slashes, backslashes, spaces, unicode, and path traversal are rejected.

## Behavior notes

- Before switching or logging in, `cx` writes the live `auth.json` back to the current saved slot if it is valid and still exists. This preserves token refreshes.
- Writeback never recreates a deleted active slot.
- `cx rm <active>` removes the saved slot and clears `.current-account`; it leaves live `auth.json` untouched until you switch or login.
- `cx save` and `cx rename` refuse overwrites unless `--force` is passed.
- `cx login <name>` forwards extra arguments to `codex login`, so headless flows such as `cx login personal --device-auth` work on remote machines.
- `cx doctor`, `cx remote status`, and `cx sync status` never print token contents.

## Hermes integration

`cx` can seed Hermes' existing `openai-codex` auth store from a saved cx account without changing or forking Hermes:

```bash
cx hermes use work                  # import ~/.codex/accounts/work.json into ~/.hermes/auth.json
cx hermes use work --profile team   # target ~/.hermes/profiles/team/auth.json
cx hermes use work --no-config      # import auth only; leave config.yaml untouched
cx hermes status                    # show auth/config state without printing token values
cx hermes sync work                 # copy refreshed Hermes tokens back to the cx account slot
```

`cx hermes use` writes `providers.openai-codex.tokens` and a `credential_pool.openai-codex` entry labelled `cx:<account>`. By default it also sets `model.provider: openai-codex` in Hermes' `config.yaml`.

`cx hermes sync` is the manual writeback path for phase 1: if Hermes refreshes the token in `~/.hermes/auth.json`, this copies that refreshed pair back into `~/.codex/accounts/<account>.json`.

## 1Password remote sync

`cx` can sync saved account slots through 1Password using the 1Password CLI (`op`) as the remote backend. This is intended for moving Codex auth between machines without committing secrets to git or publishing them to npm.

Prerequisites:

- Install 1Password CLI v2 (`op`) on each machine.
- Sign in first with `op signin`, or set `OP_SERVICE_ACCOUNT_TOKEN` for non-interactive hosts such as EC2.
- Create or choose a vault where the items should live.

Configure once per `CODEX_HOME`:

```bash
cx remote configure 1password --vault Private
cx remote configure 1password --vault Private --item-prefix codex-
```

The config is written to `~/.codex/remote.json` (or `CODEX_HOME/remote.json`) with mode `0600` where supported. It stores only backend settings such as backend, vault, and item prefix; it does not store token contents.

Check configuration and CLI availability:

```bash
cx remote status
cx remote status --json
```

Push a local account to 1Password:

```bash
cx sync push work
```

This reads `~/.codex/accounts/work.json` and upserts it into item `<prefix>work` in the configured vault. The default prefix is `cx-`, so the default item title is `cx-work`.

Pull an account onto another machine:

```bash
cx sync pull work
cx sync pull work --force
```

`pull` refuses to overwrite an existing local `~/.codex/accounts/work.json` unless `--force` is passed.

Compare local and remote presence without printing auth JSON:

```bash
cx sync status
cx sync status work
cx sync status work --json
```

1Password storage details: `cx` shells out to `op` with argv arrays. Reads use `op item get <item> --vault <vault> --fields label=auth_json --reveal`. Writes use a `Secure Note` item with a concealed field named `auth_json` via `op item create ... --category "Secure Note" ... auth_json[concealed]=<json>` and `op item edit ... auth_json[concealed]=<json>`. Status commands only report presence/configuration and never reveal field contents.

## Migrating from the prototype shell function

If you previously had `/home/ubuntu/.codex/codex-acct.sh` sourced from `.bashrc`:

1. Install this package globally.
2. Remove the marked `.bashrc` block that sources `~/.codex/codex-acct.sh`.
3. Delete only the old script:

```bash
rm -f ~/.codex/codex-acct.sh
```

Keep these files/directories:

```text
~/.codex/auth.json
~/.codex/accounts/
~/.codex/.current-account
```

They are the data this package uses.

## Uninstall

```bash
npm uninstall -g @ralphkrauss/codex-account-switcher
```

This removes the CLI only. It does not remove your Codex credentials.

To remove stored account slots too:

```bash
rm -rf ~/.codex/accounts ~/.codex/.current-account
```

Do not delete `~/.codex/auth.json` unless you want to log Codex out.
