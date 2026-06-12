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

## New personal device quick start

If your Codex profiles already exist in 1Password, a new machine should only need:

```bash
npm install -g @openai/codex @ralphkrauss/codex-account-switcher
op signin
cx 1password setup --vault <VAULT_NAME> --pull --use <PROFILE_NAME>
cx doctor
cx 1password status
```

Example:

```bash
cx 1password setup --vault Codex --pull --use gi
```

For a copy-pasteable prompt you can give another agent, plus macOS/Windows/Linux, bootstrap, headless EC2, and troubleshooting steps, see [`docs/AGENT_SETUP.md`](docs/AGENT_SETUP.md).

Agent safety rule: do not paste or print `auth.json`, `accounts/*.json`, OAuth tokens, refresh tokens, Google OAuth token/client-secret files, encryption keys, or 1Password concealed-field contents. Use `cx doctor`, `cx backend status`, `cx 1password status`, `cx sync status`, `cx limits --all --json`, and `cx ls` for verification instead.

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
cx login personal --force --device-auth
cx login work -- --with-api-key
cx use work
cx resume 019ea2b1-5d71-7d30-b625-f43158d13be8
cx resume --last
cx run work -- exec "fix the tests"
cx run --account work --timeout 1800 -- exec --json --output-last-message /tmp/final.md "fix the tests"
cx run --no-stdin -- exec "non-interactive prompt"
cx run -- --help
cx hermes use work
cx hermes status
cx hermes sync work
cx 1password setup --vault Private --pull --use work
cx backend setup gdrive oauth --client-secret ./client-secret.json --auth-url
cx backend setup gdrive oauth --auth-code '<redirect-url-or-code>'
cx backend status
cx limits --all --json
cx 1password status
cx sync push --all
cx sync pull --all
cx sync status work
cx rename work work-prod
cx rm work-prod
cx doctor
```

Backward-friendly shortcut:

```bash
cx work exec "fix the tests"
```

This switches to `work`, then launches `codex exec "fix the tests"`.

Resume Codex sessions the same way you normally would with `codex resume`, but through the active `cx` profile:

```bash
cx resume <session-id>
cx resume --last
cx resume <session-id> "follow up prompt"
```

Use the existing account-prefixed shortcut when you want to resume under a specific profile in one command:

```bash
cx work resume <session-id>
```

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
- `cx login <name>` forwards extra arguments to `codex login`, so headless flows such as `cx login personal --force --device-auth` work on remote machines; use `--force` when refreshing an existing saved profile.
- `cx run --account <name> -- ...` uses a per-invocation isolated `CODEX_HOME`; it does not swap shared `auth.json`, so concurrent orchestrated runs and interactive `cx use` calls cannot affect each other.
- `cx run` closes child stdin by default when `cx` itself is not attached to a TTY. Use `--no-stdin` to force that behavior, or `--stdin`/`--inherit-stdin` when you intentionally need to pass stdin through.
- `cx run --timeout <seconds> -- ...` terminates the child process group and exits `124` on timeout. Codex stderr that looks like quota/rate-limit exhaustion maps to exit `75`.
- `cx doctor`, `cx remote status`, and `cx sync status` never print token contents.

## Orchestrated non-interactive runs

For mission orchestrators or other fan-out runners, prefer the isolated form:

```bash
cx run --account <name> --timeout 1800 -- exec \
  -c model=gpt-5.1-codex-max \
  --cd <worktree> \
  --sandbox workspace-write \
  --json \
  --output-last-message <file> \
  "<prompt>"
```

This copies the selected account into a temporary per-run `CODEX_HOME`, launches Codex there, then writes any refreshed child auth back to `accounts/<name>.json` without changing the shared live `auth.json` or `.current-account`. Existing interactive commands such as `cx use personal` remain global/shared by design, but they cannot alter already-running isolated invocations.

Operational exit codes for callers:

- `0`: Codex completed successfully.
- `75`: stderr looked like quota/rate-limit exhaustion (`usage limit`, `rate limit`, `quota`, `429`, etc.).
- `124`: `--timeout` expired and `cx` terminated the child process group.
- Other non-zero: normal Codex/process failure.

## Hermes integration

`cx` can seed Hermes' existing `openai-codex` auth store from a saved cx account without changing or forking Hermes:

```bash
cx hermes use work                  # import ~/.codex/accounts/work.json into ~/.hermes/auth.json
cx hermes use work --profile team   # target ~/.hermes/profiles/team/auth.json
cx hermes use work --no-config      # import auth only; leave config.yaml untouched
cx hermes status                    # show auth/config state without printing token values
cx hermes sync work                 # copy refreshed Hermes tokens back to the cx account slot
```

`cx hermes use` writes `providers.openai-codex.tokens` and a `credential_pool.openai-codex` entry labelled `cx:<account>`. By default it also sets `model.provider: openai-codex` in Hermes' `config.yaml`. If 1Password remote sync is configured, `cx hermes use` auto-pulls the named account when the local slot is missing or safely behind remote.

`cx hermes sync` is the manual writeback path: if Hermes refreshes the token in `~/.hermes/auth.json`, this copies that refreshed pair back into `~/.codex/accounts/<account>.json`. If 1Password remote sync is configured, it also pushes the refreshed slot back to 1Password.

## Google Drive-backed profiles

`cx` can also use Google Drive as the remote profile backend. The default OAuth flow stores profile files in Drive `appDataFolder` so no folder choice is required; pass `--folder-id <id>` if you want a normal/shared folder instead.

Headless/devbox setup uses a paste-code OAuth flow:

```bash
cx backend setup gdrive oauth --client-secret ./client-secret.json --auth-url
# Open the printed URL, approve access, then paste the resulting redirect URL or code:
cx backend setup gdrive oauth --auth-code '<redirect-url-or-code>'
```

Optional client-side encryption is available without changing the sync workflow:

```bash
export CX_GDRIVE_ENCRYPTION_KEY='your-shared-passphrase'
cx backend setup gdrive oauth --client-secret ./client-secret.json --encryption env --auth-url
```

After setup, the existing sync commands are backend-neutral:

```bash
cx sync push work
cx sync pull work
cx sync status work
cx backend status
```

`cx limits <account>|--all [--json]` reports normalized Codex/ChatGPT usage windows for saved profiles. It uses Codex's internal ChatGPT usage endpoint on a best-effort basis, so treat it as operational telemetry rather than a stable public API.

## 1Password-backed profiles

`cx` can use 1Password as a native profile backend through the 1Password CLI (`op`). This is intended for moving Codex auth between machines without committing secrets to git or publishing them to npm.

Full setup documentation for personal devices and delegated agent setup is in [`docs/AGENT_SETUP.md`](docs/AGENT_SETUP.md). It includes a prompt you can give your agent, OS-specific installation notes, first-machine bootstrapping, headless/service-account setup, and troubleshooting.

Prerequisites:

- Install 1Password CLI v2 (`op`) on each machine.
- Sign in first with `op signin`, or set `OP_SERVICE_ACCOUNT_TOKEN` for non-interactive hosts such as EC2.
- Create or choose a vault where the items should live.

Easy setup on a new machine:

```bash
cx 1password setup --vault Private --pull --use work
```

That one command:

1. writes `~/.codex/remote.json` with the 1Password vault/prefix settings,
2. verifies that `op` can access the vault,
3. discovers remote `cx-*` profile items,
4. pulls missing profiles locally, and
5. selects the requested profile with `cx use`.

If you do not want to pull immediately:

```bash
cx 1password setup --vault Private
```

After setup, remote-backed profiles behave naturally:

```bash
cx use work              # auto-pulls work from 1Password when remote is newer or local is missing
cx run work -- exec ...  # auto-pulls before launching Codex, then auto-pushes refreshed auth after Codex exits
cx login work --force --device-auth # refreshes an existing profile and auto-pushes it to 1Password
cx 1password status      # local + remote profile presence and sync state, no token contents
```

The auto-sync layer is conservative:

- Remote-backed credentials are tracked with non-secret SHA-256 metadata.
- `cx` auto-pulls when the remote changed and the local copy is still at the last synced hash.
- `cx` auto-pushes after `cx save`, `cx login`, `cx run`, shortcut `cx <profile> ...`, and `cx hermes sync` when the local profile changed.
- If local and remote both changed, `cx` refuses to overwrite either side and asks for explicit conflict resolution.
- Set `CX_AUTO_SYNC=0` to temporarily disable magic sync while keeping explicit `cx sync ...` commands available.

The legacy lower-level commands are still available:

```bash
cx remote configure 1password --vault Private
cx remote configure 1password --vault Private --item-prefix codex-
cx remote status
```

Push local profiles to 1Password:

```bash
cx sync push work
cx sync push --all
```

Pull profiles onto another machine:

```bash
cx sync pull work
cx sync pull work --force
cx sync pull --all
cx sync pull --all --force
```

`pull --all` pulls every remote 1Password-backed profile that is not already local. Use `--force` to overwrite existing local profile slots.

Compare local and remote presence without printing auth JSON:

```bash
cx sync status
cx sync status work
cx sync status work --json
```

Remote sync is for named account slots only. `default` is reserved as the live Codex auth target: choose which named account should be active/default on a machine with `cx use <name>`, rather than syncing a separate `default` profile.

1Password storage details: `cx` shells out to `op` with argv arrays. Reads prefer `op item get <item> --vault <vault> --format json` and extract the concealed `auth_json` field safely for multiline JSON. Writes use a `Secure Note` item with a concealed field named `auth_json` via `op item create ... --category "Secure Note" ... auth_json[concealed]=<json>` and `op item edit ... auth_json[concealed]=<json>`. Status commands only report presence/configuration and never reveal field contents.

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
