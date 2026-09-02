# Agent setup guide for safe Codex profiles

This guide is written so an agent can install and configure `cx` on a new device without handling raw OAuth credentials.

## Copy-paste prompt

```text
Set up Codex account profiles on this machine using @ralphkrauss/codex-account-switcher.

Safety rules:
- Never ask me to paste or print auth.json, access tokens, refresh tokens, ID tokens, or credential-manager contents.
- Do not copy a Codex or Hermes credential from another device or another profile.
- It is okay to ask me to complete a browser or device-code sign-in locally.
- Use the same friendly profile names I use elsewhere, but create new local login sessions.

Tasks:
1. Check Node.js 22+, npm, the Codex CLI, cx, and (if requested) Hermes.
2. Install or upgrade Codex and cx:
   npm install -g @openai/codex @ralphkrauss/codex-account-switcher
3. For every requested Codex profile, run:
   cx login <PROFILE_NAME> --device-auth
   Ask me to complete the local sign-in as the intended account.
4. Verify safely:
   cx ls
   cx doctor
   cx run <PROFILE_NAME> -- --version
5. If Hermes is requested, create its independent login:
   cx hermes login <PROFILE_NAME>
   cx hermes status <PROFILE_NAME>
6. Do not enable CX_ALLOW_UNSAFE_PROFILE_IMPORT,
   CX_ALLOW_UNSAFE_AUTH_SYNC, or CX_ALLOW_UNSAFE_HERMES_TOKEN_SHARE.
7. Report profile names and safe status fields only. Never report token values.
```

## Expected layout

```text
~/.codex/accounts/<profile>/auth.json
~/.codex/accounts/<profile>/config.toml
~/.codex/accounts/<profile>/sessions/
~/.codex/.current-account

~/.hermes/profiles/cx-<profile>/auth.json       # if Hermes is configured
```

Every Codex profile is a stable `CODEX_HOME`, and every Hermes profile owns a separate OAuth session. The same profile name on two devices does not mean the credential file is shared.

## Interactive setup

Install prerequisites:

```bash
npm install -g @openai/codex @ralphkrauss/codex-account-switcher
node --version
codex --version
cx --version
```

Create profiles:

```bash
cx login personal --device-auth
cx login gi --device-auth
cx login beta --device-auth
```

Verify:

```bash
cx ls
cx doctor
cx run personal -- --version
cx run gi -- --version
cx run beta -- --version
```

Use them:

```bash
cx personal
cx run gi -- exec "review this repository"
cx use beta
cx resume --last
```

## Hermes setup

Hermes must authenticate independently. Do not seed it from the Codex `auth.json`.

```bash
cx hermes login personal
cx hermes login gi
cx hermes login beta

cx hermes status personal
cx hermes run personal -- chat
```

The default mapping is `personal` to Hermes profile `cx-personal`. When `cx hermes run personal` starts Hermes, it also sets `CODEX_HOME` to `~/.codex/accounts/personal`. This keeps Hermes's optional Codex app-server runtime aligned with the requested account while Hermes's direct provider continues using its independent OAuth session.

If Hermes reports a missing provider token after a successful native login, upgrade Hermes and consult [Hermes issue #32730](https://github.com/NousResearch/hermes-agent/issues/32730). Do not fix the upstream pool/provider split by importing Codex credentials.

## Headless hosts

Prefer device-code login on the target host:

```bash
cx login worker --device-auth
```

Open the displayed link on a trusted browser, sign in as the requested account, and enter the one-time code. If device login is unavailable, use SSH callback forwarding as described in the [Codex authentication guide](https://developers.openai.com/codex/auth/).

For CI/CD, API keys are the recommended default. If ChatGPT-managed authentication is required, follow OpenAI's [advanced CI/CD guidance](https://learn.chatgpt.com/docs/auth/ci-cd-auth): one persistent `auth.json` per runner or serialized workflow stream, with the refreshed file preserved between runs. Never use one credential concurrently on multiple machines.

## Concurrent workers

One profile permits one writer. `cx` blocks a second Codex or Hermes process that could mutate the same profile.

For parallel jobs, create independently authenticated workers:

```bash
cx login gi-worker-1 --device-auth
cx login gi-worker-2 --device-auth

cx run gi-worker-1 --timeout 1800 -- exec "task one"
cx run gi-worker-2 --timeout 1800 -- exec "task two"
```

Never create workers by copying an existing `auth.json`.

## Upgrade from cx 0.3

1. Stop Codex, Hermes, and Codex app-server processes.
2. Upgrade cx.
3. Trigger and inspect local migration.

```bash
npm install -g @ralphkrauss/codex-account-switcher@latest
cx ls
cx doctor
```

Legacy `~/.codex/accounts/<name>.json` files move into `~/.codex/accounts/<name>/auth.json`, with originals archived under `.legacy-v0.3`.

Do not continue the old 1Password/Google Drive pull workflow on another device. Log in each profile locally instead. Recreate Hermes credentials with `cx hermes login <name>`.

## Recovery

If a profile reports `refresh_token_reused`, `refresh_token_invalidated`, a revoked token, or repeated 401 responses:

1. Stop all processes using that profile.
2. Check for an app-server process/socket with `cx doctor`.
3. Reauthenticate only the affected local profile.

```bash
cx login <PROFILE_NAME> --force --device-auth
```

If login reports an app-server socket, stop its process before removing the socket:

```bash
ps aux | grep '[c]odex app-server'
kill <PID>
rm -f ~/.codex/accounts/<PROFILE_NAME>/app-server-control/app-server-control.sock
```

Then retry the login. Do not restore an older remote copy afterward.

## Deprecated features

The following credential-copy paths are disabled by default in cx 0.4:

- `cx save`
- `cx sync push` and `cx sync pull`
- automatic remote credential sync
- `cx hermes use` and `cx hermes sync`

Existing backend/status commands remain useful for auditing old installations. The unsafe override environment variables are intentionally excluded from normal setup; they are for controlled one-time recovery only.

## Safe reporting

Agents may report:

- installed versions;
- profile names;
- paths to profile homes;
- whether credential/config files exist;
- file sizes and permission modes;
- `cx doctor`, `cx ls`, limits, sync presence, and Hermes status fields.

Agents must not report:

- any token value or token fragment;
- raw `auth.json` or Hermes credential-store contents;
- concealed 1Password values;
- Google OAuth secrets or encryption keys.
