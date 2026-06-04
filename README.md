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
- `cx doctor` never prints token contents.

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
