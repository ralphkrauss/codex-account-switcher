# Agent setup guide for Codex account profiles

This guide is written so Ralph can ask an agent on a new personal device to install and configure `cx` without handing the agent raw Codex tokens.

`cx` is the `@ralphkrauss/codex-account-switcher` CLI. It stores local Codex profile slots under Codex's normal data directory and can sync named profiles through 1Password using the 1Password CLI (`op`).

## Copy-paste prompt for an agent

Use this prompt on a new device:

```text
Set up Codex account switching on this machine using @ralphkrauss/codex-account-switcher.

Rules:
- Do not ask me to paste Codex auth JSON, OAuth tokens, refresh tokens, or 1Password secrets into chat.
- Do not print ~/.codex/auth.json, ~/.codex/accounts/*.json, or 1Password field contents.
- It is OK to ask me to complete browser/device-login prompts or run a local 1Password unlock/sign-in step.
- Prefer using 1Password-backed profiles with `cx 1password setup`.

Tasks:
1. Check whether Node.js 22+, npm, Codex CLI, cx, and 1Password CLI (`op`) are installed.
2. Install or upgrade what is missing:
   - Codex CLI: `npm install -g @openai/codex`
   - cx: `npm install -g @ralphkrauss/codex-account-switcher`
3. Make sure `op` is signed in/unlocked. If not, tell me the exact local command to run, such as `op signin`.
4. Configure 1Password-backed Codex profiles:
   `cx 1password setup --vault <VAULT_NAME> --pull --use <PROFILE_NAME>`
5. Verify setup with safe commands only:
   - `cx doctor`
   - `cx 1password status`
   - `cx ls`
   - `cx run <PROFILE_NAME> -- --version`
6. If a requested profile exists in 1Password but is not local, rely on `cx use <PROFILE_NAME>` or `cx run <PROFILE_NAME> -- ...` to auto-pull it.
7. If a profile's Codex session has ended, run `cx login <PROFILE_NAME> --device-auth`, ask me to complete the browser/device flow, then run `cx sync push <PROFILE_NAME>`.

Use `<VAULT_NAME>` for the 1Password vault that contains the `cx-*` items and `<PROFILE_NAME>` for the profile I want active, for example `gi` or `personal`.
```

## What the setup should produce

After setup, these files may exist:

```text
~/.codex/auth.json                  # Codex's active/live auth file
~/.codex/accounts/<profile>.json    # local named profile copies
~/.codex/.current-account           # active profile marker
~/.codex/remote.json                # 1Password sync config
```

The package code itself is installed by npm. Credential data stays under `~/.codex` and, if enabled, in 1Password secure-note items.

## New personal device: normal interactive flow

1. Install prerequisites.

   macOS with Homebrew:

   ```bash
   brew install node@22 1password-cli
   npm install -g @openai/codex @ralphkrauss/codex-account-switcher
   ```

   Windows with PowerShell/winget:

   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install AgileBits.1Password.CLI
   npm install -g @openai/codex @ralphkrauss/codex-account-switcher
   ```

   Linux example:

   ```bash
   node --version   # must be v22+
   npm install -g @openai/codex @ralphkrauss/codex-account-switcher
   ```

2. Sign in to 1Password CLI locally.

   ```bash
   op signin
   op vault list
   ```

3. Configure and pull the remote profiles.

   ```bash
   cx 1password setup --vault <VAULT_NAME> --pull --use <PROFILE_NAME>
   ```

   Example:

   ```bash
   cx 1password setup --vault Codex --pull --use gi
   ```

4. Verify without exposing secrets.

   ```bash
   cx doctor
   cx 1password status
   cx ls
   cx run gi -- --version
   ```

5. Switch naturally after that.

   ```bash
   cx use gi
   cx use personal
   cx run gi -- exec "summarize this repo"
   ```

## First machine / bootstrapping profiles into 1Password

If 1Password does not have any `cx-*` items yet, bootstrap from a machine where Codex is already logged in.

1. Save or create named local profiles.

   If the current `~/.codex/auth.json` is the account you want to call `gi`:

   ```bash
   cx save gi
   ```

   If you need to log in a new account:

   ```bash
   cx login personal --device-auth
   ```

2. Configure the vault.

   ```bash
   cx 1password setup --vault <VAULT_NAME>
   ```

3. Push named profiles.

   ```bash
   cx sync push gi
   cx sync push personal
   # or push all local named profiles except reserved default:
   cx sync push --all
   ```

4. Confirm presence only, not token contents.

   ```bash
   cx sync status
   ```

## Headless hosts and EC2

For a non-interactive Linux host, prefer a 1Password service account scoped only to the dedicated Codex vault.

1. Create a 1Password service account with access only to the Codex profile vault.
2. Store the token in a local env file with private permissions. Do this outside chat; do not paste the token to the agent.

   ```bash
   mkdir -p ~/.config/1password
   install -m 600 /dev/null ~/.config/1password/op.env
   $EDITOR ~/.config/1password/op.env
   ```

   File contents:

   ```bash
   export OP_SERVICE_ACCOUNT_TOKEN="..."
   ```

3. Source it before running `cx` commands.

   ```bash
   set -a
   . ~/.config/1password/op.env
   set +a
   op vault list
   cx 1password setup --vault <VAULT_NAME> --pull --use <PROFILE_NAME>
   ```

If the shell is non-interactive, make sure the env file is sourced before any early `return` in shell startup files, or source it explicitly in the command that runs the agent.

## Day-to-day commands

List local profiles:

```bash
cx ls
```

Switch active profile:

```bash
cx use gi
```

Run Codex under a profile:

```bash
cx run gi -- exec "fix the failing tests"
```

Login or refresh a profile, then push the refreshed token to 1Password:

```bash
cx login personal --device-auth
cx sync push personal
```

Pull a new remote profile:

```bash
cx sync pull personal
```

Pull every missing remote profile:

```bash
cx sync pull --all
```

Show local/remote presence without secrets:

```bash
cx 1password status
cx sync status
```

## Important rules

- Sync named profiles such as `gi` and `personal`; do not sync `default`.
- `default` is reserved for Codex's live `auth.json` target on each machine.
- `cx use <profile>` chooses which named profile is active on that machine.
- Do not copy `auth.json` through chat, git, shared folders, or plain text notes.
- Do not run a fresh `cx login <profile>` on a secondary machine unless you intentionally want to rotate/replace that OAuth session. Pulling from 1Password is safer for shared profiles.
- If Codex says a session has ended, run `cx login <profile> --device-auth` and then `cx sync push <profile>`.

## Troubleshooting

### `cx: command not found`

Check npm's global bin directory:

```bash
npm bin -g
npm prefix -g
```

Make sure the global bin directory is on `PATH`, then reinstall:

```bash
npm install -g @ralphkrauss/codex-account-switcher
```

### Node is too old

`cx` requires Node.js 22+:

```bash
node --version
```

Upgrade Node, then reinstall the global packages.

### `op` cannot access the vault

Verify the CLI can see the vault:

```bash
op vault list
op item list --vault <VAULT_NAME>
```

If that fails, sign in/unlock 1Password locally or fix the service-account token/vault permissions.

### Remote profile is shown but not local

Use either:

```bash
cx sync pull <PROFILE_NAME>
```

or just switch/run it; `cx` will auto-pull from the configured 1Password backend:

```bash
cx use <PROFILE_NAME>
cx run <PROFILE_NAME> -- --version
```

### Local profile exists but should be replaced by 1Password

Use force deliberately:

```bash
cx sync pull <PROFILE_NAME> --force
```

### Need to migrate from the old shell script

Keep credential data, remove only the sourced script/hook:

```bash
npm install -g @ralphkrauss/codex-account-switcher
rm -f ~/.codex/codex-acct.sh
```

Then remove the marked `.bashrc` block that sourced `~/.codex/codex-acct.sh`.

Do not delete:

```text
~/.codex/auth.json
~/.codex/accounts/
~/.codex/.current-account
```
