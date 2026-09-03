#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CxError,
  authFileExists,
  autoPullAccountForUse,
  autoPushAccountIfChanged,
  configureOnePasswordRemote,
  finishGoogleDriveOAuth,
  getCodexPaths,
  hermesProfileForAccount,
  inspectAccountLimits,
  inspectAllAccountLimits,
  inspectHermesStatus,
  inspectDoctor,
  inspectRemoteStatus,
  inspectSyncStatus,
  listAccounts,
  loginHermesAccount,
  loginAccount,
  readCurrentMarker,
  removeAccount,
  renameAccount,
  runCodex,
  runCodexWithIsolatedAccount,
  runHermesAccount,
  saveAccount,
  setupOnePasswordProfiles,
  startGoogleDriveOAuth,
  syncHermesAccount,
  syncPullAccount,
  syncPullAllAccounts,
  syncPushAccount,
  syncPushAllAccounts,
  useAccount,
  useHermesAccount,
  validateAccountName,
  type AccountList,
  type DoctorReport,
  type HermesStatus,
  type RemoteStatus,
  type SyncStatus,
} from './index.js';

const PACKAGE_NAME = '@ralphkrauss/codex-account-switcher';
const UNSAFE_PROFILE_IMPORT_ENV = 'CX_ALLOW_UNSAFE_PROFILE_IMPORT';
const SUBCOMMANDS = new Set([
  '1password',
  'backend',
  'doctor',
  'hermes',
  'help',
  'login',
  'ls',
  'limits',
  'rename',
  'resume',
  'remote',
  'rm',
  'run',
  'save',
  'sync',
  'use',
]);

interface CliIo {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

interface ParsedForceArgs {
  readonly force: boolean;
  readonly positionals: readonly string[];
}

interface ParsedLoginArgs {
  readonly force: boolean;
  readonly name: string;
  readonly loginArgs: readonly string[];
}

interface ParsedHermesArgs {
  readonly json: boolean;
  readonly noConfig: boolean;
  readonly profile?: string;
  readonly positionals: readonly string[];
}

interface ParsedJsonArgs {
  readonly json: boolean;
  readonly positionals: readonly string[];
}

interface ParsedRemoteConfigureArgs {
  readonly vault: string;
  readonly itemPrefix?: string;
}

interface ParsedOnePasswordSetupArgs extends ParsedRemoteConfigureArgs {
  readonly pull: boolean;
  readonly force: boolean;
  readonly use?: string;
}

interface ParsedGoogleDriveOAuthSetupArgs {
  readonly clientSecretFile?: string;
  readonly folderId?: string;
  readonly filePrefix?: string;
  readonly encryption?: 'none' | 'env';
  readonly authUrl: boolean;
  readonly authCode?: string;
}

interface ParsedRunArgs {
  readonly account: string | null;
  readonly isolatedAccount: string | null;
  readonly codexArgs: readonly string[];
  readonly stdin: 'inherit' | 'ignore' | undefined;
  readonly timeoutSeconds: number | undefined;
}

interface ParsedLimitsArgs {
  readonly json: boolean;
  readonly all: boolean;
  readonly account?: string;
}

function write(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text.endsWith('\n') ? text : `${text}\n`);
}

async function readPackageMetadata(): Promise<{ name: string; version: string }> {
  try {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      name: typeof packageJson.name === 'string' ? packageJson.name : PACKAGE_NAME,
      version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0',
    };
  } catch {
    return { name: PACKAGE_NAME, version: '0.0.0' };
  }
}

function helpText(metadata: { readonly name: string; readonly version: string }): string {
  return `cx ${metadata.version} — safe Codex CLI account switcher

Usage:
  cx ls
  cx use <name>
  cx login <name> [--force] [codex login args...]
  cx resume [codex resume args...]
  cx rename <old> <new> [--force]
  cx rm <name>
  cx run [name] [--no-stdin] [--timeout <seconds>] -- [codex args...]
  cx run --account <name> [--no-stdin] [--timeout <seconds>] -- [codex args...]
  cx hermes login <account> [--profile <name>]
  cx hermes run <account> [--profile <name>] -- [hermes args...]
  cx hermes status [account] [--profile <name>] [--json]
  cx backend status [--json]
  cx limits <account>|--all [--json]
  cx 1password status [--json]
  cx remote status [--json]
  cx sync status [account] [--json]
  cx save <name> [--force]                  (deprecated; disabled by default)
  cx sync push|pull ...                     (deprecated; disabled by default)
  cx doctor [--json]
  cx --help
  cx --version

Backward-friendly shortcuts:
  cx <account> [codex args...]   select <account>, then run its isolated Codex profile
  cx                             run the currently selected isolated profile

Data layout:
  Uses CODEX_HOME when set, otherwise ~/.codex.
  Accounts are stable Codex homes at CODEX_HOME/accounts/<name>/.
  Each profile owns its auth.json, config.toml, sessions, and refresh-token lineage.
  The active account marker is CODEX_HOME/.current-account.
  Legacy remote auth sync config is stored as CODEX_HOME/remote.json but credential
  push/pull is disabled by default because active OAuth files are device-local.

Account names may contain letters, numbers, dot, underscore, and dash only.`;
}

function hermesHelpText(): string {
  return `Usage:
  cx hermes login <account> [--profile <name>]
  cx hermes run <account> [--profile <name>] -- [hermes args...]
  cx hermes status [account] [--profile <name>] [--json]
  cx hermes use <account> ...     (deprecated and disabled)
  cx hermes sync <account> ...    (deprecated and disabled)

Commands:
  login    Run Hermes' native 'auth add openai-codex' flow. This creates a separate
           refresh-token lineage instead of copying the Codex credential.
  run      Run Hermes with the account's dedicated Hermes profile.
  status   Show Hermes auth/config state without printing token contents.
  use/sync Legacy token-copy bridge. Disabled unless CX_ALLOW_UNSAFE_HERMES_TOKEN_SHARE=1.

Paths:
  By default account <name> maps to Hermes profile cx-<name>.
  --profile <name> explicitly targets ~/.hermes/profiles/<name>.
  --profile default targets Hermes' canonical root home at ~/.hermes.`;
}

function remoteHelpText(): string {
  return `Usage:
  cx remote configure 1password --vault <vault> [--item-prefix <prefix>]
  cx remote status [--json]

Commands:
  configure  Store remote sync settings in CODEX_HOME/remote.json.
  status     Show configured backend/vault/prefix and whether the op CLI is available.

Notes:
  This is read-only audit/configuration support for legacy remote sync.
  Credential push/pull is deprecated and disabled by default. Token contents are never printed.`;
}

function backendHelpText(): string {
  return `Usage:
  cx backend status [--json]
  cx backend list
  cx backend setup 1password --vault <vault> [--item-prefix <prefix>]
  cx backend setup gdrive oauth --client-secret <file> [--folder-id <id>] [--file-prefix <prefix>] [--encryption env|none] --auth-url
  cx backend setup gdrive oauth --auth-code <code-or-redirect-url>

Commands:
  status  Show the configured legacy account backend.
  list    List supported backends.
  setup   Configure a deprecated recovery backend. Google Drive OAuth uses a paste-code flow:
          first run --auth-url, open the URL, then run --auth-code with the pasted redirect URL/code.`;
}

function limitsHelpText(): string {
  return `Usage:
  cx limits <account>|--all [--json]

Shows Codex/ChatGPT usage windows for stored accounts using Codex's internal usage endpoint.
This is best-effort and may change upstream.`;
}

function onePasswordHelpText(): string {
  return `Usage:
  cx 1password setup --vault <vault> [--item-prefix <prefix>] [--pull] [--force] [--use <account>]
  cx 1password status [--json]

Commands:
  setup   Configure legacy 1Password recovery. --pull requires the unsafe auth-sync override.
  status  Audit 1Password and local/remote profile presence without revealing tokens.

Examples:
  cx 1password status
  cx 1password setup --vault Private --item-prefix codex-`;
}

function syncHelpText(): string {
  return `Usage:
  cx sync push <account>|--all
  cx sync pull <account>|--all [--force]
  cx sync status [account] [--json]

Commands:
  push    DEPRECATED: credential sharing is disabled by default.
  pull    DEPRECATED: credential sharing is disabled by default.
  status  Compare local account-file presence with remote item presence without printing tokens.`;
}

function parseHermesArgs(
  command: string,
  args: readonly string[],
  allowed: { readonly json?: boolean; readonly noConfig?: boolean },
): ParsedHermesArgs {
  let json = false;
  let noConfig = false;
  let profile: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--profile') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new CxError(`usage: cx hermes ${command}`, 2);
      }
      profile = value;
      index += 1;
      continue;
    }
    if (arg === '--json') {
      if (allowed.json !== true) {
        throw new CxError(`unknown option '${arg}'`, 2);
      }
      json = true;
      continue;
    }
    if (arg === '--no-config') {
      if (allowed.noConfig !== true) {
        throw new CxError(`unknown option '${arg}'`, 2);
      }
      noConfig = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new CxError(`unknown option '${arg}'`, 2);
    }
    positionals.push(arg);
  }

  return { json, noConfig, ...(profile ? { profile } : {}), positionals };
}

function parseJsonArgs(args: readonly string[]): ParsedJsonArgs {
  let json = false;
  const positionals: string[] = [];
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new CxError(`unknown option '${arg}'`, 2);
    }
    positionals.push(arg);
  }
  return { json, positionals };
}

function parseRemoteConfigureArgs(args: readonly string[]): ParsedRemoteConfigureArgs {
  const [backend, ...rest] = args;
  if (backend !== '1password') {
    throw new CxError('usage: cx remote configure 1password --vault <vault> [--item-prefix <prefix>]', 2);
  }

  let vault: string | undefined;
  let itemPrefix: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? '';
    if (arg === '--vault') {
      const value = rest[index + 1];
      if (!value || value.startsWith('-')) {
        throw new CxError('usage: cx remote configure 1password --vault <vault> [--item-prefix <prefix>]', 2);
      }
      vault = value;
      index += 1;
      continue;
    }
    if (arg === '--item-prefix') {
      const value = rest[index + 1];
      if (!value || value.startsWith('-')) {
        throw new CxError('usage: cx remote configure 1password --vault <vault> [--item-prefix <prefix>]', 2);
      }
      itemPrefix = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new CxError(`unknown option '${arg}'`, 2);
    }
    throw new CxError('usage: cx remote configure 1password --vault <vault> [--item-prefix <prefix>]', 2);
  }

  if (!vault) {
    throw new CxError('usage: cx remote configure 1password --vault <vault> [--item-prefix <prefix>]', 2);
  }
  return { vault, ...(itemPrefix ? { itemPrefix } : {}) };
}

function parseOnePasswordSetupArgs(args: readonly string[]): ParsedOnePasswordSetupArgs {
  let vault: string | undefined;
  let itemPrefix: string | undefined;
  let pull = false;
  let force = false;
  let use: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--vault') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new CxError('usage: cx 1password setup --vault <vault> [--item-prefix <prefix>] [--pull] [--force] [--use <account>]', 2);
      }
      vault = value;
      index += 1;
      continue;
    }
    if (arg === '--item-prefix') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new CxError('usage: cx 1password setup --vault <vault> [--item-prefix <prefix>] [--pull] [--force] [--use <account>]', 2);
      }
      itemPrefix = value;
      index += 1;
      continue;
    }
    if (arg === '--pull') {
      pull = true;
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--use') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new CxError('usage: cx 1password setup --vault <vault> [--item-prefix <prefix>] [--pull] [--force] [--use <account>]', 2);
      }
      use = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new CxError(`unknown option '${arg}'`, 2);
    }
    throw new CxError('usage: cx 1password setup --vault <vault> [--item-prefix <prefix>] [--pull] [--force] [--use <account>]', 2);
  }

  if (!vault) {
    throw new CxError('usage: cx 1password setup --vault <vault> [--item-prefix <prefix>] [--pull] [--force] [--use <account>]', 2);
  }
  return { vault, pull, force, ...(itemPrefix ? { itemPrefix } : {}), ...(use ? { use } : {}) };
}

function parseGoogleDriveOAuthSetupArgs(args: readonly string[]): ParsedGoogleDriveOAuthSetupArgs {
  let clientSecretFile: string | undefined;
  let folderId: string | undefined;
  let filePrefix: string | undefined;
  let encryption: 'none' | 'env' | undefined;
  let authUrl = false;
  let authCode: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--auth-url') {
      authUrl = true;
      continue;
    }
    if (arg === '--client-secret' || arg === '--folder-id' || arg === '--file-prefix' || arg === '--encryption' || arg === '--auth-code') {
      const value = args[index + 1];
      if (!value || (arg !== '--auth-code' && value.startsWith('-'))) {
        throw new CxError('usage: cx backend setup gdrive oauth --client-secret <file> [--folder-id <id>] [--file-prefix <prefix>] [--encryption env|none] --auth-url OR --auth-code <code-or-redirect-url>', 2);
      }
      if (arg === '--client-secret') {
        clientSecretFile = value;
      } else if (arg === '--folder-id') {
        folderId = value;
      } else if (arg === '--file-prefix') {
        filePrefix = value;
      } else if (arg === '--encryption') {
        if (value !== 'none' && value !== 'env') {
          throw new CxError("--encryption must be 'none' or 'env'", 2);
        }
        encryption = value;
      } else {
        authCode = value;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new CxError(`unknown option '${arg}'`, 2);
    }
    throw new CxError('usage: cx backend setup gdrive oauth --client-secret <file> [--folder-id <id>] [--file-prefix <prefix>] [--encryption env|none] --auth-url OR --auth-code <code-or-redirect-url>', 2);
  }

  if (authUrl === Boolean(authCode)) {
    throw new CxError('choose exactly one of --auth-url or --auth-code <code-or-redirect-url>', 2);
  }
  if (authUrl && !clientSecretFile) {
    throw new CxError('usage: cx backend setup gdrive oauth --client-secret <file> [--folder-id <id>] [--file-prefix <prefix>] [--encryption env|none] --auth-url', 2);
  }
  return {
    ...(clientSecretFile ? { clientSecretFile } : {}),
    ...(folderId ? { folderId } : {}),
    ...(filePrefix ? { filePrefix } : {}),
    ...(encryption ? { encryption } : {}),
    authUrl,
    ...(authCode ? { authCode } : {}),
  };
}

function parseLimitsArgs(args: readonly string[]): ParsedLimitsArgs {
  let json = false;
  let all = false;
  let account: string | undefined;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--all') {
      all = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new CxError(`unknown option '${arg}'`, 2);
    }
    if (account) {
      throw new CxError('usage: cx limits <account>|--all [--json]', 2);
    }
    account = arg;
  }
  if (all === Boolean(account)) {
    throw new CxError('usage: cx limits <account>|--all [--json]', 2);
  }
  return { json, all, ...(account ? { account } : {}) };
}

function parseLoginArgs(args: readonly string[]): ParsedLoginArgs {
  let force = false;
  let name: string | null = null;
  const loginArgs: string[] = [];
  let afterSeparator = false;

  for (const arg of args) {
    if (afterSeparator) {
      loginArgs.push(arg);
      continue;
    }

    if (arg === '--') {
      afterSeparator = true;
      continue;
    }

    if (arg === '--force') {
      force = true;
      continue;
    }

    if (name === null) {
      name = arg;
      continue;
    }

    loginArgs.push(arg);
  }

  if (name === null || name.startsWith('-')) {
    throw new CxError('usage: cx login <name> [--force] [codex login args...]', 2);
  }

  return { force, name, loginArgs };
}

function parseForceArgs(args: readonly string[]): ParsedForceArgs {
  let force = false;
  const positionals: string[] = [];
  for (const arg of args) {
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new CxError(`unknown option '${arg}'`, 2);
    }
    positionals.push(arg);
  }
  return { force, positionals };
}

function requireArity(command: string, positionals: readonly string[], expected: number): void {
  if (positionals.length !== expected) {
    throw new CxError(`usage: cx ${command}`, 2);
  }
}

function formatAccounts(list: AccountList): string {
  const lines = [`Codex accounts (home: ${list.home}):`];
  if (list.accounts.length === 0) {
    lines.push('  (none yet — run: cx login <name> --device-auth)');
  } else {
    for (const account of list.accounts) {
      lines.push(account.active ? `  * ${account.name}  (active)` : `    ${account.name}`);
    }
  }

  if (list.currentMarker.state === 'invalid') {
    lines.push('warning: .current-account is invalid; no named profile can be selected until it is fixed.');
  } else if (list.currentMarker.state === 'valid' && list.current === null) {
    lines.push(`warning: current marker '${list.currentMarker.name}' has no matching stored account.`);
  }

  return lines.join('\n');
}

function formatDoctor(report: DoctorReport): string {
  const current = report.current.state === 'valid'
    ? `${report.current.name ?? '(none)'} (${report.current.slotExists ? 'slot ok' : 'slot missing'})`
    : report.current.state;
  const lines = [
    'Codex Account Switcher doctor',
    `package: ${report.packageName}@${report.version}`,
    `node: ${report.nodeVersion}`,
    `platform: ${report.platform}`,
    `codex home: ${report.codexHome}`,
    `home exists: ${report.homeExists ? 'yes' : 'no'}`,
    `accounts dir: ${report.accountsDir}`,
    `accounts dir exists: ${report.accountsDirExists ? 'yes' : 'no'}`,
    `accounts: ${report.accounts.length === 0 ? '(none)' : report.accounts.join(', ')}`,
    `current account: ${current}`,
    `shared auth.json: ${report.authJson.exists ? `${report.authJson.size} bytes (${report.authJson.looksNonEmpty ? 'legacy fallback present' : 'too small for legacy fallback'})` : 'missing (normal with named profiles)'}`,
    `codex executable: ${report.codexExecutable ?? 'not found'}`,
  ];

  for (const profile of report.profiles) {
    lines.push(`profile ${profile.name}: ${profile.home} (${profile.authSize} auth bytes, file credential store=${yesNo(profile.fileCredentialStore)}, app-server socket=${yesNo(profile.appServerSocketExists)})`);
  }

  if (report.current.reason) {
    lines.push(`current marker note: ${report.current.reason}`);
  }
  if (report.warnings.length > 0) {
    lines.push('warnings:');
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  return lines.join('\n');
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function formatHermesStatus(status: HermesStatus): string {
  const tokenBits = status.hasTokens
    ? `access=${yesNo(status.hasAccessToken)}, refresh=${yesNo(status.hasRefreshToken)}`
    : 'missing';
  const linked = status.linkedAccounts.length === 0
    ? '(none detected)'
    : status.linkedAccounts.join(', ');
  const lines = [
    'Hermes Codex integration status',
    `profile: ${status.profile ?? 'default'}`,
    `hermes home: ${status.hermesHome}`,
    `auth.json: ${status.authExists ? 'present' : 'missing'}`,
    `auth readable: ${yesNo(status.authReadable)}`,
    `openai-codex auth: ${status.openaiCodexAuthExists ? 'present' : 'missing'}`,
    `tokens: ${tokenBits}`,
    `access token expires: ${status.accessTokenExpiresAt ?? '(unknown)'}${status.accessTokenExpired === null ? '' : status.accessTokenExpired ? ' (expired; refresh token may renew it)' : ' (current)'}`,
    `last refresh: ${status.lastRefresh ?? '(unknown)'}`,
    `auth mode: ${status.authMode ?? '(unknown)'}`,
    `credential pool openai-codex entries: ${status.poolEntryCount}`,
    `linked cx account: ${linked}`,
    `configured provider: ${status.configuredProvider ?? '(not set)'}`,
    `config.yaml: ${status.configExists ? 'present' : 'missing'}`,
  ];

  if (status.authError) {
    lines.push(`auth warning: ${status.authError}`);
  }
  if (status.configError) {
    lines.push(`config warning: ${status.configError}`);
  }

  return lines.join('\n');
}

function formatRemoteStatus(status: RemoteStatus): string {
  const lines = [
    'Remote sync status',
    `config: ${status.configPath}`,
    `configured: ${yesNo(status.configured)}`,
    `backend: ${status.backend ?? '(not configured)'}`,
  ];
  if (status.backend === 'gdrive') {
    lines.push(
      `storage: ${status.storage ?? '(not configured)'}`,
      `folder id: ${status.folderId ?? '(appDataFolder)'}`,
      `file prefix: ${status.filePrefix ?? '(not configured)'}`,
      `token file: ${status.tokenFile ?? '(not configured)'}`,
      `encryption: ${status.encryption ?? '(not configured)'}`,
    );
  } else {
    lines.push(
      `vault: ${status.vault ?? '(not configured)'}`,
      `item prefix: ${status.itemPrefix ?? '(not configured)'}`,
      `op CLI: ${status.opAvailable ? `available (${status.opPath ?? 'op'})` : 'not found'}`,
    );
  }
  return lines.join('\n');
}

function remotePresenceText(status: SyncStatus['accounts'][number]): string {
  if (status.remote.presence === 'unknown') {
    return status.remote.error ? `unknown (${status.remote.error})` : 'unknown';
  }
  return status.remote.presence;
}

function formatSyncStatus(status: SyncStatus): string {
  const lines = [
    'Remote sync status',
    `config: ${status.configPath}`,
    `configured: ${yesNo(status.configured)}`,
    `backend: ${status.backend ?? '(not configured)'}`,
  ];
  if (status.backend === 'gdrive') {
    lines.push(
      `storage: ${status.storage ?? '(not configured)'}`,
      `folder id: ${status.folderId ?? '(appDataFolder)'}`,
      `file prefix: ${status.filePrefix ?? '(not configured)'}`,
      `encryption: ${status.encryption ?? '(not configured)'}`,
    );
  } else {
    lines.push(
      `vault: ${status.vault ?? '(not configured)'}`,
      `item prefix: ${status.itemPrefix ?? '(not configured)'}`,
      `op CLI: ${status.opAvailable ? `available (${status.opPath ?? 'op'})` : 'not found'}`,
    );
  }

  if (status.accounts.length === 0) {
    lines.push('accounts: (none)');
    return lines.join('\n');
  }

  lines.push('accounts:');
  for (const account of status.accounts) {
    lines.push(`  - ${account.account}: local=${account.local.exists ? 'present' : 'missing'}, remote=${remotePresenceText(account)}, sync=${account.sync.state}`);
    if (account.sync.error) {
      lines.push(`    sync error: ${account.sync.error}`);
    }
    lines.push(`    file: ${account.local.file}`);
    lines.push(`    item: ${account.item ?? '(unknown)'}`);
  }
  return lines.join('\n');
}

type CliAccountLimits = Awaited<ReturnType<typeof inspectAccountLimits>>;

function formatUsageWindow(window: CliAccountLimits['primary']): string {
  if (!window) {
    return '(unknown)';
  }
  const reset = window.resetAfterSeconds === null ? '' : `, resets in ${window.resetAfterSeconds}s`;
  return `${window.usedPercent}% used, ${window.remainingPercent}% remaining${reset}`;
}

function formatLimitsReport(entries: readonly CliAccountLimits[]): string {
  if (entries.length === 0) {
    return 'Codex usage limits: (no accounts)';
  }
  const blocks = entries.map((entry) => {
    const lines = [
      `Codex usage limits for ${entry.account}`,
      `email: ${entry.email ?? '(unknown)'}`,
      `plan: ${entry.planType ?? '(unknown)'}`,
      `allowed: ${entry.allowed === null ? '(unknown)' : yesNo(entry.allowed)}`,
      `limit reached: ${entry.limitReached === null ? '(unknown)' : yesNo(entry.limitReached)}`,
      `5h window: ${formatUsageWindow(entry.primary)}`,
      `weekly window: ${formatUsageWindow(entry.secondary)}`,
    ];
    if (entry.credits) {
      lines.push(`credits: ${entry.credits.unlimited ? 'unlimited' : entry.credits.balance ?? '(unknown)'}`);
    }
    return lines.join('\n');
  });
  return blocks.join('\n\n');
}

async function printList(io: CliIo, env: NodeJS.ProcessEnv): Promise<void> {
  write(io.stdout, formatAccounts(await listAccounts(getCodexPaths(env))));
}

async function autoPushNamed(name: string, env: NodeJS.ProcessEnv, io: CliIo): Promise<void> {
  const result = await autoPushAccountIfChanged(name, { env, paths: getCodexPaths(env) });
  if (result.action === 'pushed') {
    write(io.stdout, `auto-pushed profile '${result.account}'`);
  }
}

function displayBackendName(backend: string | undefined): string {
  if (backend === '1password') {
    return '1Password';
  }
  if (backend === 'gdrive') {
    return 'Google Drive';
  }
  return backend ?? 'remote';
}

async function useAccountWithRemoteFallback(name: string, env: NodeJS.ProcessEnv, io: CliIo): Promise<void> {
  const paths = getCodexPaths(env);
  if (env.CX_ALLOW_UNSAFE_AUTH_SYNC === '1') {
    const pull = await autoPullAccountForUse(name, { env, paths });
    if (pull.action === 'pulled') {
      write(io.stdout, `auto-pulled ${displayBackendName(pull.backend)}-backed profile '${pull.account}'`);
    }
  }
  await useAccount(name, { paths });
}

async function runNamedProfile(
  name: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { readonly stdin?: 'inherit' | 'ignore'; readonly timeoutSeconds?: number } = {},
): Promise<number> {
  const paths = getCodexPaths(env);
  if (env.CX_ALLOW_UNSAFE_AUTH_SYNC === '1') {
    await autoPullAccountForUse(name, { env, paths });
  }
  await useAccount(name, { paths });
  const result = await runCodexWithIsolatedAccount(name, args, {
    env,
    paths,
    stdin: options.stdin,
    timeoutSeconds: options.timeoutSeconds,
  });
  if (result.authUpdated && env.CX_ALLOW_UNSAFE_AUTH_SYNC === '1') {
    await autoPushAccountIfChanged(name, { env, paths });
  }
  return result.exitCode;
}

async function runCurrentProfile(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  options: { readonly stdin?: 'inherit' | 'ignore'; readonly timeoutSeconds?: number } = {},
): Promise<number> {
  const paths = getCodexPaths(env);
  const marker = await readCurrentMarker(paths);
  if (marker.state === 'valid') {
    return await runNamedProfile(marker.name, args, env, options);
  }
  if (await authFileExists(paths)) {
    write(io.stderr, "warning: no cx profile is selected; running shared CODEX_HOME/auth.json in deprecated compatibility mode. Run 'cx login <name>' first.");
    return await runCodex(args, { env, stdin: options.stdin, timeoutSeconds: options.timeoutSeconds });
  }
  throw new CxError("no cx profile is selected; run 'cx login <name> --device-auth'", 1);
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new CxError(`${option} must be a positive integer number of seconds`, 2);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CxError(`${option} must be a positive integer number of seconds`, 2);
  }
  return parsed;
}

function parseRunOptions(beforeSeparator: readonly string[]): Omit<ParsedRunArgs, 'codexArgs'> {
  let account: string | null = null;
  let isolatedAccount: string | null = null;
  let stdin: 'inherit' | 'ignore' | undefined;
  let timeoutSeconds: number | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < beforeSeparator.length; index += 1) {
    const arg = beforeSeparator[index] ?? '';
    if (arg === '--account') {
      const value = beforeSeparator[index + 1];
      if (!value || value.startsWith('-')) {
        throw new CxError('usage: cx run [name] [--account <name>] [--no-stdin|--stdin] [--timeout <seconds>] -- [codex args...]', 2);
      }
      isolatedAccount = value;
      index += 1;
      continue;
    }
    if (arg === '--no-stdin') {
      stdin = 'ignore';
      continue;
    }
    if (arg === '--stdin' || arg === '--inherit-stdin') {
      stdin = 'inherit';
      continue;
    }
    if (arg === '--timeout') {
      const value = beforeSeparator[index + 1];
      if (!value) {
        throw new CxError('usage: cx run [name] [--account <name>] [--no-stdin|--stdin] [--timeout <seconds>] -- [codex args...]', 2);
      }
      timeoutSeconds = parsePositiveInteger(value, '--timeout');
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new CxError(`unknown option '${arg}'`, 2);
    }
    positionals.push(arg);
  }

  if (positionals.length > 1 || (isolatedAccount && positionals.length > 0)) {
    throw new CxError('usage: cx run [name] [--account <name>] [--no-stdin|--stdin] [--timeout <seconds>] -- [codex args...]', 2);
  }
  account = positionals[0] ?? null;
  return { account, isolatedAccount, stdin, timeoutSeconds };
}

function parseRunArgs(args: readonly string[]): ParsedRunArgs {
  const separatorIndex = args.indexOf('--');
  if (separatorIndex >= 0) {
    const beforeSeparator = args.slice(0, separatorIndex);
    const parsed = parseRunOptions(beforeSeparator);
    return {
      ...parsed,
      codexArgs: args.slice(separatorIndex + 1),
    };
  }

  if (args.length === 0) {
    return { account: null, isolatedAccount: null, codexArgs: [], stdin: undefined, timeoutSeconds: undefined };
  }
  const [account, ...codexArgs] = args;
  if (!account || account.startsWith('-')) {
    throw new CxError("usage: cx run [name] -- [codex args...] (use '--' before codex flags)", 2);
  }
  return { account, isolatedAccount: null, codexArgs, stdin: undefined, timeoutSeconds: undefined };
}

async function handleHermesCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    write(io.stdout, hermesHelpText());
    return 0;
  }

  switch (command) {
    case 'login': {
      const parsed = parseHermesArgs('login <account> [--profile <name>]', rest, {});
      requireArity('hermes login <account> [--profile <name>]', parsed.positionals, 1);
      const account = parsed.positionals[0] ?? '';
      const result = await loginHermesAccount(account, {
        env,
        ...(parsed.profile ? { profile: parsed.profile } : {}),
      });
      write(io.stdout, `Hermes profile '${result.profile}' now has an independent openai-codex login for cx account '${result.account}'`);
      write(io.stdout, `hermes home: ${result.hermesHome}`);
      write(io.stdout, `auth.json: ${result.authFile}`);
      return 0;
    }

    case 'run': {
      const separator = rest.indexOf('--');
      const before = separator >= 0 ? rest.slice(0, separator) : rest;
      const hermesArgs = separator >= 0 ? rest.slice(separator + 1) : [];
      const parsed = parseHermesArgs('run <account> [--profile <name>] -- [hermes args...]', before, {});
      requireArity('hermes run <account> [--profile <name>] -- [hermes args...]', parsed.positionals, 1);
      const account = parsed.positionals[0] ?? '';
      const profile = parsed.profile ?? hermesProfileForAccount(account);
      write(io.stdout, `→ hermes profile '${profile}' for cx account '${account}'`);
      return await runHermesAccount(account, hermesArgs, { env, profile });
    }

    case 'use': {
      const parsed = parseHermesArgs('use <account> [--profile <name>] [--no-config]', rest, { noConfig: true });
      requireArity('hermes use <account> [--profile <name>] [--no-config]', parsed.positionals, 1);
      const account = parsed.positionals[0] ?? '';
      write(io.stderr, 'warning: cx hermes use is deprecated and copies a rotating refresh token; use cx hermes login instead');
      const result = await useHermesAccount(account, {
        env,
        ...(parsed.profile ? { profile: parsed.profile } : {}),
        updateConfig: !parsed.noConfig,
      });
      write(io.stdout, `Hermes openai-codex auth now uses cx account '${result.account}'`);
      write(io.stdout, `hermes home: ${result.hermesHome}`);
      write(io.stdout, `auth.json: ${result.hermesAuthFile}`);
      write(io.stdout, result.hermesConfigFile
        ? `config.yaml: ${result.hermesConfigFile} (model.provider=openai-codex)`
        : 'config.yaml: skipped (--no-config)');
      return 0;
    }

    case 'sync': {
      const parsed = parseHermesArgs('sync <account> [--profile <name>]', rest, {});
      requireArity('hermes sync <account> [--profile <name>]', parsed.positionals, 1);
      const account = parsed.positionals[0] ?? '';
      write(io.stderr, 'warning: cx hermes sync is deprecated and copies a rotating refresh token; use independent cx hermes login profiles instead');
      const result = await syncHermesAccount(account, {
        env,
        ...(parsed.profile ? { profile: parsed.profile } : {}),
      });
      write(io.stdout, `synced Hermes openai-codex tokens to cx account '${result.account}'`);
      write(io.stdout, `cx account file: ${result.codexAccountFile}`);
      write(io.stdout, `hermes home: ${result.hermesHome}`);
      return 0;
    }

    case 'status': {
      const parsed = parseHermesArgs('status [--profile <name>] [--json]', rest, { json: true });
      if (parsed.positionals.length > 1) {
        throw new CxError('usage: cx hermes status [account] [--profile <name>] [--json]', 2);
      }
      const account = parsed.positionals[0];
      const profile = parsed.profile ?? (account ? hermesProfileForAccount(account) : undefined);
      const status = await inspectHermesStatus({
        env,
        ...(profile ? { profile } : {}),
        ...(account ? { account } : {}),
      });
      write(io.stdout, parsed.json ? JSON.stringify(status, null, 2) : formatHermesStatus(status));
      return 0;
    }

    default:
      throw new CxError(`unknown hermes command '${command}'`, 2);
  }
}

async function handleBackendCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    write(io.stdout, backendHelpText());
    return 0;
  }

  switch (command) {
    case 'status': {
      const parsed = parseJsonArgs(rest);
      requireArity('backend status [--json]', parsed.positionals, 0);
      const status = await inspectRemoteStatus({ env, paths: getCodexPaths(env) });
      write(io.stdout, parsed.json ? JSON.stringify(status, null, 2) : formatRemoteStatus(status));
      return 0;
    }

    case 'list':
      requireArity('backend list', rest, 0);
      write(io.stdout, 'supported backends:');
      write(io.stdout, '  1password');
      write(io.stdout, '  gdrive');
      return 0;

    case 'setup': {
      const [backend, mode, ...setupRest] = rest;
      if (backend === '1password') {
        const parsed = parseRemoteConfigureArgs(['1password', ...(mode ? [mode, ...setupRest] : [])]);
        const result = await configureOnePasswordRemote(parsed, { paths: getCodexPaths(env) });
        write(io.stdout, 'configured remote backend: 1password');
        write(io.stdout, `config: ${result.configPath}`);
        write(io.stdout, `vault: ${result.config.vault}`);
        write(io.stdout, `item prefix: ${result.config.itemPrefix}`);
        return 0;
      }
      if (backend !== 'gdrive' || mode !== 'oauth') {
        throw new CxError('usage: cx backend setup 1password --vault <vault> [--item-prefix <prefix>] OR cx backend setup gdrive oauth --client-secret <file> --auth-url OR --auth-code <code-or-redirect-url>', 2);
      }
      const parsed = parseGoogleDriveOAuthSetupArgs(setupRest);
      if (parsed.authUrl) {
        if (!parsed.clientSecretFile) {
          throw new CxError('usage: cx backend setup gdrive oauth --client-secret <file> [--folder-id <id>] [--file-prefix <prefix>] [--encryption env|none] --auth-url', 2);
        }
        const result = await startGoogleDriveOAuth({
          clientSecretFile: parsed.clientSecretFile,
          ...(parsed.folderId ? { folderId: parsed.folderId } : {}),
          ...(parsed.filePrefix ? { filePrefix: parsed.filePrefix } : {}),
          ...(parsed.encryption ? { encryption: parsed.encryption } : {}),
        }, { env, paths: getCodexPaths(env) });
        write(io.stdout, 'Google Drive authorization URL:');
        write(io.stdout, result.authUrl);
        write(io.stdout, '');
        write(io.stdout, `pending file: ${result.pendingFile}`);
        write(io.stdout, `storage: ${result.storage}`);
        write(io.stdout, `file prefix: ${result.filePrefix}`);
        write(io.stdout, `encryption: ${result.encryption}`);
        write(io.stdout, "After authorizing, run: cx backend setup gdrive oauth --auth-code '<redirect-url-or-code>'");
        return 0;
      }
      if (!parsed.authCode) {
        throw new CxError('usage: cx backend setup gdrive oauth --auth-code <code-or-redirect-url>', 2);
      }
      const result = await finishGoogleDriveOAuth(parsed.authCode, { env, paths: getCodexPaths(env) });
      write(io.stdout, 'configured Google Drive-backed Codex profiles');
      write(io.stdout, `config: ${result.configPath}`);
      write(io.stdout, `token file: ${result.tokenFile}`);
      write(io.stdout, `storage: ${result.config.storage}`);
      write(io.stdout, `file prefix: ${result.config.filePrefix}`);
      write(io.stdout, `encryption: ${result.config.encryption}`);
      return 0;
    }

    default:
      throw new CxError(`unknown backend command '${command}'`, 2);
  }
}

async function handleLimitsCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    write(io.stdout, limitsHelpText());
    return 0;
  }
  const parsed = parseLimitsArgs(args);
  const paths = getCodexPaths(env);
  const results = parsed.all
    ? await inspectAllAccountLimits({ env, paths })
    : [await inspectAccountLimits(parsed.account ?? '', { env, paths })];
  write(io.stdout, parsed.json ? JSON.stringify(results, null, 2) : formatLimitsReport(results));
  return 0;
}

async function handleRemoteCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    write(io.stdout, remoteHelpText());
    return 0;
  }

  switch (command) {
    case 'configure': {
      const parsed = parseRemoteConfigureArgs(rest);
      const result = await configureOnePasswordRemote(parsed, { paths: getCodexPaths(env) });
      write(io.stdout, 'configured remote backend: 1password');
      write(io.stdout, `config: ${result.configPath}`);
      write(io.stdout, `vault: ${result.config.vault}`);
      write(io.stdout, `item prefix: ${result.config.itemPrefix}`);
      return 0;
    }

    case 'status': {
      const parsed = parseJsonArgs(rest);
      requireArity('remote status [--json]', parsed.positionals, 0);
      const status = await inspectRemoteStatus({ env, paths: getCodexPaths(env) });
      write(io.stdout, parsed.json ? JSON.stringify(status, null, 2) : formatRemoteStatus(status));
      return 0;
    }

    default:
      throw new CxError(`unknown remote command '${command}'`, 2);
  }
}

async function handleOnePasswordCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    write(io.stdout, onePasswordHelpText());
    return 0;
  }

  switch (command) {
    case 'setup': {
      const parsed = parseOnePasswordSetupArgs(rest);
      const result = await setupOnePasswordProfiles(parsed, { env, paths: getCodexPaths(env) });
      write(io.stdout, 'configured 1Password-backed Codex profiles');
      write(io.stdout, `config: ${result.configPath}`);
      write(io.stdout, `vault: ${result.vault}`);
      write(io.stdout, `item prefix: ${result.itemPrefix}`);
      write(io.stdout, `remote profiles: ${result.remoteAccounts.length > 0 ? result.remoteAccounts.join(', ') : '(none)'}`);
      if (parsed.pull) {
        write(io.stdout, `pulled profiles: ${result.pulledAccounts.length > 0 ? result.pulledAccounts.join(', ') : '(none)'}`);
      }
      if (result.usedAccount) {
        write(io.stdout, `active codex account: ${result.usedAccount}`);
      }
      return 0;
    }

    case 'status': {
      const parsed = parseJsonArgs(rest);
      requireArity('1password status [--json]', parsed.positionals, 0);
      const status = await inspectSyncStatus(undefined, { env, paths: getCodexPaths(env) });
      write(io.stdout, parsed.json ? JSON.stringify(status, null, 2) : formatSyncStatus(status));
      return 0;
    }

    default:
      throw new CxError(`unknown 1password command '${command}'`, 2);
  }
}

async function handleSyncCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    write(io.stdout, syncHelpText());
    return 0;
  }

  switch (command) {
    case 'push': {
      write(io.stderr, 'warning: cx sync push is deprecated; credential sharing is enabled only for one-time recovery');
      requireArity('sync push <account>|--all', rest, 1);
      if (rest[0] === '--all') {
        const results = await syncPushAllAccounts({ env, paths: getCodexPaths(env) });
        write(io.stdout, `pushed profiles: ${results.length > 0 ? results.map((entry) => entry.account).join(', ') : '(none)'}`);
        return 0;
      }
      const account = rest[0] ?? '';
      const result = await syncPushAccount(account, { env, paths: getCodexPaths(env) });
      write(io.stdout, `pushed account '${result.account}' to ${displayBackendName(result.backend)} item '${result.item}'`);
      if (result.vault) {
        write(io.stdout, `vault: ${result.vault}`);
      }
      write(io.stdout, `operation: ${result.operation}`);
      return 0;
    }

    case 'pull': {
      write(io.stderr, 'warning: cx sync pull is deprecated; credential sharing is enabled only for one-time recovery');
      let force = false;
      const positionals: string[] = [];
      for (const arg of rest) {
        if (arg === '--force') {
          force = true;
          continue;
        }
        if (arg !== '--all' && arg.startsWith('--')) {
          throw new CxError(`unknown option '${arg}'`, 2);
        }
        positionals.push(arg);
      }
      requireArity('sync pull <account>|--all [--force]', positionals, 1);
      if (positionals[0] === '--all') {
        const results = await syncPullAllAccounts({
          env,
          paths: getCodexPaths(env),
          force,
        });
        write(io.stdout, `pulled profiles: ${results.length > 0 ? results.map((entry) => entry.account).join(', ') : '(none)'}`);
        return 0;
      }
      const account = positionals[0] ?? '';
      const result = await syncPullAccount(account, {
        env,
        paths: getCodexPaths(env),
        force,
      });
      write(io.stdout, `pulled ${displayBackendName(result.backend)} item '${result.item}' into account '${result.account}'`);
      write(io.stdout, `account file: ${result.accountFile}`);
      write(io.stdout, `overwrote local account: ${yesNo(result.overwritten)}`);
      return 0;
    }

    case 'status': {
      const parsed = parseJsonArgs(rest);
      if (parsed.positionals.length > 1) {
        throw new CxError('usage: cx sync status [account] [--json]', 2);
      }
      const status = await inspectSyncStatus(parsed.positionals[0], { env, paths: getCodexPaths(env) });
      write(io.stdout, parsed.json ? JSON.stringify(status, null, 2) : formatSyncStatus(status));
      return 0;
    }

    default:
      throw new CxError(`unknown sync command '${command}'`, 2);
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const metadata = await readPackageMetadata();
  const [first, ...rest] = argv;

  if (first === '--help' || first === '-h' || first === 'help') {
    write(io.stdout, helpText(metadata));
    return 0;
  }

  if (first === '--version' || first === '-v') {
    write(io.stdout, metadata.version);
    return 0;
  }

  if (!first) {
    const paths = getCodexPaths(env);
    const marker = await readCurrentMarker(paths);
    if (marker.state === 'valid' || await authFileExists(paths)) {
      return await runCurrentProfile([], env, io);
    }

    write(io.stdout, helpText(metadata));
    write(io.stdout, '');
    write(io.stdout, `No named profile or legacy shared auth.json was found under ${paths.home}.`);
    write(io.stdout, 'Use cx login <name> --device-auth to create a profile locally.');
    write(io.stdout, '');
    write(io.stdout, formatAccounts(await listAccounts(paths)));
    return 0;
  }

  if (!SUBCOMMANDS.has(first)) {
    if (first.startsWith('-')) {
      throw new CxError(`unknown option '${first}'`, 2);
    }

    validateAccountName(first);
    await useAccountWithRemoteFallback(first, env, io);
    write(io.stdout, `→ codex on '${first}'`);
    return await runNamedProfile(first, rest, env);
  }

  switch (first) {
    case 'ls': {
      if (rest.length > 0) {
        throw new CxError('usage: cx ls', 2);
      }
      await printList(io, env);
      return 0;
    }

    case 'save': {
      const parsed = parseForceArgs(rest);
      requireArity('save <name> [--force]', parsed.positionals, 1);
      const name = parsed.positionals[0] ?? '';
      if (env[UNSAFE_PROFILE_IMPORT_ENV] !== '1') {
        throw new CxError(
          `cx save is deprecated because copying a live auth.json creates two writers for one refresh token; use 'cx login ${name} --device-auth'. For a one-time ownership transfer only, set ${UNSAFE_PROFILE_IMPORT_ENV}=1 and stop every process using the source credential`,
          1,
        );
      }
      write(io.stderr, `warning: importing shared auth.json into '${name}' using unsafe one-time compatibility mode`);
      await saveAccount(name, { force: parsed.force, paths: getCodexPaths(env) });
      write(io.stdout, `saved current login as '${name}'`);
      if (env.CX_ALLOW_UNSAFE_AUTH_SYNC === '1') {
        await autoPushNamed(name, env, io);
      }
      return 0;
    }

    case 'use': {
      requireArity('use <name>', rest, 1);
      const name = rest[0] ?? '';
      await useAccountWithRemoteFallback(name, env, io);
      write(io.stdout, `active codex account: ${name}`);
      return 0;
    }

    case 'login': {
      const parsed = parseLoginArgs(rest);
      await loginAccount(parsed.name, {
        force: parsed.force,
        loginArgs: parsed.loginArgs,
        env,
        paths: getCodexPaths(env),
      });
      write(io.stdout, `logged in and saved as '${parsed.name}'`);
      if (env.CX_ALLOW_UNSAFE_AUTH_SYNC === '1') {
        await autoPushNamed(parsed.name, env, io);
      }
      return 0;
    }

    case 'resume': {
      return await runCurrentProfile(['resume', ...rest], env, io);
    }

    case 'rename': {
      const parsed = parseForceArgs(rest);
      requireArity('rename <old> <new> [--force]', parsed.positionals, 2);
      const oldName = parsed.positionals[0] ?? '';
      const newName = parsed.positionals[1] ?? '';
      await renameAccount(oldName, newName, { force: parsed.force, paths: getCodexPaths(env) });
      write(io.stdout, `renamed '${oldName}' -> '${newName}'`);
      return 0;
    }

    case 'rm': {
      requireArity('rm <name>', rest, 1);
      const name = rest[0] ?? '';
      const result = await removeAccount(name, { paths: getCodexPaths(env) });
      write(io.stdout, `removed '${name}'`);
      if (result.wasActive) {
        write(io.stderr, `warning: '${name}' was selected; choose or log in another profile before running cx again.`);
      }
      return 0;
    }

    case 'run': {
      const parsed = parseRunArgs(rest);
      const runOptions = { stdin: parsed.stdin, timeoutSeconds: parsed.timeoutSeconds };
      if (parsed.isolatedAccount) {
        write(io.stdout, `→ codex on '${parsed.isolatedAccount}'`);
        return await runNamedProfile(parsed.isolatedAccount, parsed.codexArgs, env, runOptions);
      }
      if (parsed.account) {
        write(io.stdout, `→ codex on '${parsed.account}'`);
        return await runNamedProfile(parsed.account, parsed.codexArgs, env, runOptions);
      }
      return await runCurrentProfile(parsed.codexArgs, env, io, runOptions);
    }

    case 'doctor': {
      const json = rest.length === 1 && rest[0] === '--json';
      if (rest.length > (json ? 1 : 0)) {
        throw new CxError('usage: cx doctor [--json]', 2);
      }
      const report = await inspectDoctor({ packageName: metadata.name, version: metadata.version }, env);
      write(io.stdout, json ? JSON.stringify(report, null, 2) : formatDoctor(report));
      return 0;
    }

    case 'hermes':
      return await handleHermesCommand(rest, env, io);

    case 'backend':
      return await handleBackendCommand(rest, env, io);

    case 'limits':
      return await handleLimitsCommand(rest, env, io);

    case '1password':
      return await handleOnePasswordCommand(rest, env, io);

    case 'remote':
      return await handleRemoteCommand(rest, env, io);

    case 'sync':
      return await handleSyncCommand(rest, env, io);

    default:
      throw new CxError(`unknown command '${first}'`, 2);
  }
}

function isEntrypoint(): boolean {
  const invokedPath = process.argv[1];
  if (!invokedPath) {
    return false;
  }

  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(invokedPath).href;
  }
}

if (isEntrypoint()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (error instanceof CxError) {
      write(process.stderr, error.message);
      process.exitCode = error.exitCode;
    } else if (error instanceof Error) {
      write(process.stderr, error.message);
      process.exitCode = 1;
    } else {
      write(process.stderr, String(error));
      process.exitCode = 1;
    }
  }
}
