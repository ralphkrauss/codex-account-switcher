import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CxError,
  accountPathForName,
  getCodexPaths,
  listAccountNames,
  resolveExecutable,
  useAccount,
  validateAccountName,
  writebackCurrentAccount,
  type CodexPaths,
} from './accounts.js';

export const REMOTE_CONFIG_VERSION = 1;
export const DEFAULT_ONEPASSWORD_ITEM_PREFIX = 'cx-';
export const ONEPASSWORD_BACKEND = '1password';
export const ONEPASSWORD_AUTH_FIELD = 'auth_json';

export type RemoteBackend = typeof ONEPASSWORD_BACKEND;
export type RemotePresence = 'present' | 'missing' | 'unknown';

export interface OnePasswordRemoteConfig {
  readonly version: typeof REMOTE_CONFIG_VERSION;
  readonly backend: typeof ONEPASSWORD_BACKEND;
  readonly vault: string;
  readonly itemPrefix: string;
}

export type RemoteConfig = OnePasswordRemoteConfig;

export interface ConfigureOnePasswordRemoteInput {
  readonly vault: string;
  readonly itemPrefix?: string;
}

export interface RemotePathOptions {
  readonly paths?: CodexPaths;
}

export interface RemoteCliOptions extends RemotePathOptions {
  readonly env?: NodeJS.ProcessEnv;
}

export interface RemoteForceOptions extends RemoteCliOptions {
  readonly force?: boolean;
}

export interface ConfigureRemoteResult {
  readonly configPath: string;
  readonly config: RemoteConfig;
}

export interface RemoteStatus {
  readonly configPath: string;
  readonly configured: boolean;
  readonly backend: RemoteBackend | null;
  readonly vault: string | null;
  readonly itemPrefix: string | null;
  readonly opAvailable: boolean;
  readonly opPath: string | null;
}

export interface SyncPushResult {
  readonly account: string;
  readonly accountFile: string;
  readonly backend: RemoteBackend;
  readonly vault: string;
  readonly item: string;
  readonly operation: 'created' | 'updated';
}

export interface SyncPullResult {
  readonly account: string;
  readonly accountFile: string;
  readonly backend: RemoteBackend;
  readonly vault: string;
  readonly item: string;
  readonly overwritten: boolean;
}

export interface SyncStatusAccount {
  readonly account: string;
  readonly item: string | null;
  readonly local: {
    readonly exists: boolean;
    readonly file: string;
  };
  readonly remote: {
    readonly presence: RemotePresence;
    readonly error: string | null;
  };
}

export interface SyncStatus {
  readonly configPath: string;
  readonly configured: boolean;
  readonly backend: RemoteBackend | null;
  readonly vault: string | null;
  readonly itemPrefix: string | null;
  readonly opAvailable: boolean;
  readonly opPath: string | null;
  readonly accounts: readonly SyncStatusAccount[];
}

export interface SetupOnePasswordProfilesInput extends ConfigureOnePasswordRemoteInput {
  readonly pull?: boolean;
  readonly force?: boolean;
  readonly use?: string;
}

export interface SetupOnePasswordProfilesResult {
  readonly configPath: string;
  readonly remoteConfigured: boolean;
  readonly opAvailable: boolean;
  readonly vault: string;
  readonly itemPrefix: string;
  readonly remoteAccounts: readonly string[];
  readonly pulledAccounts: readonly string[];
  readonly usedAccount: string | null;
}

interface OpResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface OpFailureOptions {
  readonly sensitive?: boolean;
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function chmodIfPossible(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }

  try {
    await chmod(path, mode);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EINVAL' || code === 'EPERM') {
      return;
    }
    throw error;
  }
}

async function ensurePrivateDir(path: string): Promise<void> {
  const existed = await pathExists(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!existed) {
    await chmodIfPossible(path, 0o700);
  }
}

async function writeFilePrivate(destination: string, contents: string): Promise<void> {
  await ensurePrivateDir(dirname(destination));
  const temp = join(dirname(destination), `.cx-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, contents, { mode: 0o600 });
    await chmodIfPossible(temp, 0o600);
    await rename(temp, destination);
    await chmodIfPossible(destination, 0o600);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function remotePaths(options: RemotePathOptions & { readonly env?: NodeJS.ProcessEnv } = {}): CodexPaths {
  return options.paths ?? getCodexPaths(options.env ?? process.env);
}

export function getRemoteConfigPath(paths: CodexPaths = getCodexPaths()): string {
  return join(paths.home, 'remote.json');
}

function nonEmptyConfigString(value: unknown, label: string, exitCode = 1): string {
  if (typeof value !== 'string') {
    throw new CxError(`${label} must be a string`, exitCode);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CxError(`${label} must not be empty`, exitCode);
  }
  if (/[\r\n]/u.test(trimmed)) {
    throw new CxError(`${label} must not contain line breaks`, exitCode);
  }
  return trimmed;
}

function normalizeItemPrefix(value: unknown, exitCode = 1): string {
  if (value === undefined || value === null) {
    return DEFAULT_ONEPASSWORD_ITEM_PREFIX;
  }
  return nonEmptyConfigString(value, '1Password item prefix', exitCode);
}

function parseRemoteConfig(parsed: unknown, configPath: string): RemoteConfig {
  if (!isRecord(parsed)) {
    throw new CxError(`remote config at ${configPath} must be a JSON object`, 1);
  }
  if (parsed.version !== REMOTE_CONFIG_VERSION) {
    throw new CxError(`unsupported remote config version at ${configPath}`, 1);
  }
  if (parsed.backend !== ONEPASSWORD_BACKEND) {
    throw new CxError(`unsupported remote backend in ${configPath}`, 1);
  }

  return {
    version: REMOTE_CONFIG_VERSION,
    backend: ONEPASSWORD_BACKEND,
    vault: nonEmptyConfigString(parsed.vault, '1Password vault'),
    itemPrefix: normalizeItemPrefix(parsed.itemPrefix),
  };
}

export async function readRemoteConfig(options: RemotePathOptions = {}): Promise<RemoteConfig | null> {
  const paths = remotePaths(options);
  const configPath = getRemoteConfigPath(paths);
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  try {
    return parseRemoteConfig(JSON.parse(raw) as unknown, configPath);
  } catch (error) {
    if (error instanceof CxError) {
      throw error;
    }
    throw new CxError(`failed to parse remote config at ${configPath}: ${errorMessage(error)}`, 1);
  }
}

async function requireRemoteConfig(options: RemotePathOptions = {}): Promise<RemoteConfig> {
  const paths = remotePaths(options);
  const config = await readRemoteConfig({ paths });
  if (!config) {
    throw new CxError(`remote backend is not configured (run: cx remote configure 1password --vault <vault>)`, 1);
  }
  return config;
}

export async function configureOnePasswordRemote(
  input: ConfigureOnePasswordRemoteInput,
  options: RemotePathOptions = {},
): Promise<ConfigureRemoteResult> {
  const paths = remotePaths(options);
  const configPath = getRemoteConfigPath(paths);
  const config: RemoteConfig = {
    version: REMOTE_CONFIG_VERSION,
    backend: ONEPASSWORD_BACKEND,
    vault: nonEmptyConfigString(input.vault, '1Password vault', 2),
    itemPrefix: normalizeItemPrefix(input.itemPrefix, 2),
  };

  await writeFilePrivate(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, config };
}

export async function inspectRemoteStatus(options: RemoteCliOptions = {}): Promise<RemoteStatus> {
  const paths = remotePaths(options);
  const config = await readRemoteConfig({ paths });
  const opPath = await resolveExecutable('op', options.env ?? process.env);
  return {
    configPath: getRemoteConfigPath(paths),
    configured: config !== null,
    backend: config?.backend ?? null,
    vault: config?.vault ?? null,
    itemPrefix: config?.itemPrefix ?? null,
    opAvailable: opPath !== null,
    opPath,
  };
}

function missingOpError(): CxError {
  return new CxError(
    "1Password CLI ('op') was not found on PATH. Install 1Password CLI v2 and sign in with 'op signin' or set OP_SERVICE_ACCOUNT_TOKEN.",
    1,
  );
}

async function resolveOp(env: NodeJS.ProcessEnv): Promise<string> {
  const opPath = await resolveExecutable('op', env);
  if (!opPath) {
    throw missingOpError();
  }
  return opPath;
}

function summarizeOutput(stdout: string, stderr: string): string {
  const combined = [stderr, stdout]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n')
    .replace(/auth_json(?:\[[^\]]+\])?=[\s\S]*/giu, 'auth_json=[redacted]')
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ');

  if (combined.length > 500) {
    return `${combined.slice(0, 500)}…`;
  }
  return combined;
}

function opAuthHint(): string {
  return "Make sure 'op' is signed in (run 'op signin') or OP_SERVICE_ACCOUNT_TOKEN is set.";
}

function opFailureMessage(action: string, result: OpResult, options: OpFailureOptions = {}): string {
  const output = options.sensitive === true
    ? summarizeOutput('', result.stderr)
    : summarizeOutput(result.stdout, result.stderr);
  const detail = output ? `: ${output}` : ` (exit code ${result.exitCode})`;
  return `1Password CLI command failed while ${action}${detail}. ${opAuthHint()}`;
}

function throwOpFailure(action: string, result: OpResult, options: OpFailureOptions = {}): never {
  throw new CxError(opFailureMessage(action, result, options), 1);
}

async function runOpRaw(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<OpResult> {
  const opPath = await resolveOp(env);
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(opPath, [...args], {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (isNotFoundError(error)) {
        reject(missingOpError());
        return;
      }
      reject(new CxError(`failed to run 1Password CLI ('op'): ${error.message}`, 1));
    });
    child.on('close', (code) => {
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function runOp(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  action: string,
  options: OpFailureOptions = {},
): Promise<OpResult> {
  const result = await runOpRaw(args, env);
  if (result.exitCode !== 0) {
    throwOpFailure(action, result, options);
  }
  return result;
}

function looksLikeMissingItem(result: OpResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`;
  return /(?:not found|could not be found|does not exist|doesn't exist|isn't an item|is not an item|no item)/iu.test(text);
}

function looksLikeMissingField(result: OpResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`;
  return /(?:field.*not found|no field|does not have.*field|doesn't have.*field|unknown field)/iu.test(text);
}

function itemTitle(config: RemoteConfig, account: string): string {
  return `${config.itemPrefix}${account}`;
}

function accountNameFromItemTitle(config: RemoteConfig, title: string): string | null {
  if (!title.startsWith(config.itemPrefix)) {
    return null;
  }
  const account = title.slice(config.itemPrefix.length);
  try {
    const safeAccount = validateAccountName(account);
    return safeAccount === 'default' ? null : safeAccount;
  } catch {
    return null;
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function parseOnePasswordItemTitles(stdout: string, action: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new CxError(`1Password item list JSON could not be parsed while ${action}: ${errorMessage(error)}`, 1);
  }
  if (!Array.isArray(parsed)) {
    throw new CxError(`1Password item list did not return an array while ${action}`, 1);
  }
  return parsed
    .map((item) => (isRecord(item) && typeof item.title === 'string' ? item.title : null))
    .filter((title): title is string => title !== null);
}

async function listOnePasswordAccountNames(
  config: RemoteConfig,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const result = await runOp([
    'item',
    'list',
    '--vault',
    config.vault,
    '--format',
    'json',
  ], env, `listing 1Password items in vault '${config.vault}'`);

  return sortedUnique(
    parseOnePasswordItemTitles(result.stdout, `listing 1Password items in vault '${config.vault}'`)
      .map((title) => accountNameFromItemTitle(config, title))
      .filter((account): account is string => account !== null),
  );
}

async function verifyOnePasswordVault(config: RemoteConfig, env: NodeJS.ProcessEnv): Promise<void> {
  await runOp([
    'vault',
    'get',
    config.vault,
    '--format',
    'json',
  ], env, `checking 1Password vault '${config.vault}'`);
}

function validateRemoteSyncAccountName(account: string): string {
  const safeAccount = validateAccountName(account);
  if (safeAccount === 'default') {
    throw new CxError(
      "account 'default' is reserved for the live Codex auth; sync a named account and choose the active default with 'cx use <name>'",
      2,
    );
  }
  return safeAccount;
}

async function listRemoteSyncAccountNames(paths: CodexPaths): Promise<string[]> {
  return (await listAccountNames(paths)).filter((name) => name !== 'default');
}

async function onePasswordItemExists(
  config: RemoteConfig,
  item: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const result = await runOpRaw([
    'item',
    'get',
    item,
    '--vault',
    config.vault,
    '--format',
    'json',
  ], env);

  if (result.exitCode === 0) {
    return true;
  }
  if (looksLikeMissingItem(result)) {
    return false;
  }
  throwOpFailure(`checking 1Password item '${item}'`, result);
}

function authFieldAssignment(authJson: string): string {
  return `${ONEPASSWORD_AUTH_FIELD}[concealed]=${authJson}`;
}

async function upsertOnePasswordAuthJson(
  config: RemoteConfig,
  item: string,
  authJson: string,
  env: NodeJS.ProcessEnv,
): Promise<'created' | 'updated'> {
  if (await onePasswordItemExists(config, item, env)) {
    await runOp([
      'item',
      'edit',
      item,
      '--vault',
      config.vault,
      authFieldAssignment(authJson),
    ], env, `updating 1Password item '${item}'`, { sensitive: true });
    return 'updated';
  }

  await runOp([
    'item',
    'create',
    '--vault',
    config.vault,
    '--category',
    'Secure Note',
    '--title',
    item,
    authFieldAssignment(authJson),
  ], env, `creating 1Password item '${item}'`, { sensitive: true });
  return 'created';
}

function stripOneTrailingLineEnding(value: string): string {
  if (value.endsWith('\r\n')) {
    return value.slice(0, -2);
  }
  if (value.endsWith('\n')) {
    return value.slice(0, -1);
  }
  return value;
}

function parseAuthJsonString(raw: string, description: string): void {
  try {
    JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CxError(`${description} is not valid JSON: ${errorMessage(error)}`, 1);
  }
}

function decodeAuthJsonField(stdout: string, item: string): string {
  const withoutOpLineEnding = stripOneTrailingLineEnding(stdout);
  try {
    parseAuthJsonString(withoutOpLineEnding, `auth_json field in 1Password item '${item}'`);
    return withoutOpLineEnding;
  } catch {
    parseAuthJsonString(stdout, `auth_json field in 1Password item '${item}'`);
    return stdout;
  }
}

function decodeAuthJsonFieldFromItemJson(stdout: string, item: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new CxError(`1Password item '${item}' JSON could not be parsed: ${errorMessage(error)}`, 1);
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.fields)) {
    throw new CxError(`1Password item '${item}' does not contain fields metadata`, 1);
  }

  const field = parsed.fields.find((candidate: unknown): candidate is Record<string, unknown> => (
    isRecord(candidate) && candidate.label === ONEPASSWORD_AUTH_FIELD
  ));
  if (!field) {
    throw new CxError(`1Password item '${item}' does not contain a revealable '${ONEPASSWORD_AUTH_FIELD}' field`, 1);
  }
  if (typeof field.value !== 'string') {
    throw new CxError(`1Password item '${item}' field '${ONEPASSWORD_AUTH_FIELD}' did not contain a string value`, 1);
  }

  parseAuthJsonString(field.value, `auth_json field in 1Password item '${item}'`);
  return field.value;
}

async function readOnePasswordAuthJson(
  config: RemoteConfig,
  item: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const jsonResult = await runOpRaw([
    'item',
    'get',
    item,
    '--vault',
    config.vault,
    '--format',
    'json',
  ], env);

  if (jsonResult.exitCode === 0) {
    try {
      return decodeAuthJsonFieldFromItemJson(jsonResult.stdout, item);
    } catch (error) {
      if (!errorMessage(error).includes(`'${ONEPASSWORD_AUTH_FIELD}'`)) {
        throw error;
      }
      // Fall through to the field-specific command for older op/item shapes.
    }
  } else {
    if (looksLikeMissingItem(jsonResult)) {
      throw new CxError(`remote account item '${item}' was not found in 1Password vault '${config.vault}'`, 1);
    }
    throwOpFailure(`reading 1Password item '${item}'`, jsonResult);
  }

  const fieldResult = await runOpRaw([
    'item',
    'get',
    item,
    '--vault',
    config.vault,
    '--fields',
    `label=${ONEPASSWORD_AUTH_FIELD}`,
    '--reveal',
  ], env);

  if (fieldResult.exitCode === 0) {
    return decodeAuthJsonField(fieldResult.stdout, item);
  }
  if (looksLikeMissingField(fieldResult)) {
    throw new CxError(`1Password item '${item}' does not contain a revealable '${ONEPASSWORD_AUTH_FIELD}' field`, 1);
  }
  if (looksLikeMissingItem(fieldResult)) {
    throw new CxError(`remote account item '${item}' was not found in 1Password vault '${config.vault}'`, 1);
  }
  throwOpFailure(`reading '${ONEPASSWORD_AUTH_FIELD}' from 1Password item '${item}'`, fieldResult);
}

async function readLocalAccountAuthJson(
  account: string,
  paths: CodexPaths,
): Promise<{ account: string; accountFile: string; authJson: string }> {
  const safeAccount = validateRemoteSyncAccountName(account);
  const accountFile = accountPathForName(paths, safeAccount);
  let authJson: string;
  try {
    authJson = await readFile(accountFile, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new CxError(`no account '${safeAccount}'`, 1);
    }
    throw error;
  }

  parseAuthJsonString(authJson, `Codex account '${safeAccount}' at ${accountFile}`);
  return { account: safeAccount, accountFile, authJson };
}

async function writeLocalAccountAuthJson(
  account: string,
  authJson: string,
  paths: CodexPaths,
  force: boolean,
): Promise<{ account: string; accountFile: string; overwritten: boolean }> {
  const safeAccount = validateAccountName(account);
  const accountFile = accountPathForName(paths, safeAccount);
  const overwritten = await pathExists(accountFile);
  if (overwritten && !force) {
    throw new CxError(`account '${safeAccount}' already exists (use --force to overwrite)`, 1);
  }

  parseAuthJsonString(authJson, `remote account '${safeAccount}'`);
  await writeFilePrivate(accountFile, authJson);
  return { account: safeAccount, accountFile, overwritten };
}

export async function syncPushAccount(
  account: string,
  options: RemoteCliOptions = {},
): Promise<SyncPushResult> {
  const env = options.env ?? process.env;
  const paths = remotePaths(options);
  const config = await requireRemoteConfig({ paths });
  const safeAccount = validateRemoteSyncAccountName(account);
  const writeback = await writebackCurrentAccount({ paths });
  if (writeback.performed === true && writeback.account !== safeAccount) {
    throw new CxError(`unexpected writeback account '${writeback.account}' while syncing '${safeAccount}'`, 1);
  }
  const local = await readLocalAccountAuthJson(safeAccount, paths);
  const item = itemTitle(config, local.account);
  const operation = await upsertOnePasswordAuthJson(config, item, local.authJson, env);

  return {
    account: local.account,
    accountFile: local.accountFile,
    backend: config.backend,
    vault: config.vault,
    item,
    operation,
  };
}

export async function syncPullAccount(
  account: string,
  options: RemoteForceOptions = {},
): Promise<SyncPullResult> {
  const env = options.env ?? process.env;
  const paths = remotePaths(options);
  const config = await requireRemoteConfig({ paths });
  const safeAccount = validateRemoteSyncAccountName(account);
  const item = itemTitle(config, safeAccount);
  const authJson = await readOnePasswordAuthJson(config, item, env);
  const local = await writeLocalAccountAuthJson(safeAccount, authJson, paths, options.force === true);

  return {
    account: local.account,
    accountFile: local.accountFile,
    backend: config.backend,
    vault: config.vault,
    item,
    overwritten: local.overwritten,
  };
}

export async function listRemoteAccountNames(options: RemoteCliOptions = {}): Promise<string[]> {
  const env = options.env ?? process.env;
  const paths = remotePaths(options);
  const config = await requireRemoteConfig({ paths });
  return await listOnePasswordAccountNames(config, env);
}

export async function syncPullAllAccounts(options: RemoteForceOptions = {}): Promise<SyncPullResult[]> {
  const paths = remotePaths(options);
  const accounts = await listRemoteAccountNames(options);
  const results: SyncPullResult[] = [];
  for (const account of accounts) {
    const accountFile = accountPathForName(paths, account);
    if (options.force !== true && await pathExists(accountFile)) {
      continue;
    }
    results.push(await syncPullAccount(account, options));
  }
  return results;
}

export async function syncPushAllAccounts(options: RemoteCliOptions = {}): Promise<SyncPushResult[]> {
  const paths = remotePaths(options);
  const accounts = await listRemoteSyncAccountNames(paths);
  const results: SyncPushResult[] = [];
  for (const account of accounts) {
    results.push(await syncPushAccount(account, options));
  }
  return results;
}

export async function setupOnePasswordProfiles(
  input: SetupOnePasswordProfilesInput,
  options: RemoteCliOptions = {},
): Promise<SetupOnePasswordProfilesResult> {
  const env = options.env ?? process.env;
  const paths = remotePaths(options);
  const configured = await configureOnePasswordRemote(input, { paths });
  await verifyOnePasswordVault(configured.config, env);
  const remoteAccounts = await listOnePasswordAccountNames(configured.config, env);
  const pulled = input.pull === true
    ? await syncPullAllAccounts({ paths, env, force: input.force })
    : [];
  let usedAccount: string | null = null;

  if (input.use) {
    const account = validateRemoteSyncAccountName(input.use);
    const accountFile = accountPathForName(paths, account);
    if (!await pathExists(accountFile)) {
      await syncPullAccount(account, { paths, env, force: input.force });
    }
    await useAccount(account, { paths });
    usedAccount = account;
  }

  return {
    configPath: configured.configPath,
    remoteConfigured: true,
    opAvailable: true,
    vault: configured.config.vault,
    itemPrefix: configured.config.itemPrefix,
    remoteAccounts,
    pulledAccounts: pulled.map((entry) => entry.account),
    usedAccount,
  };
}

export async function inspectSyncStatus(
  account?: string,
  options: RemoteCliOptions = {},
): Promise<SyncStatus> {
  const env = options.env ?? process.env;
  const paths = remotePaths(options);
  const config = await readRemoteConfig({ paths });
  const opPath = await resolveExecutable('op', env);
  let accounts = account ? [validateRemoteSyncAccountName(account)] : await listRemoteSyncAccountNames(paths);
  const statuses: SyncStatusAccount[] = [];

  if (!account && config && opPath) {
    try {
      accounts = sortedUnique([...accounts, ...await listOnePasswordAccountNames(config, env)]);
    } catch {
      // Keep local status useful; per-account remote errors are reported below.
    }
  }

  for (const accountName of accounts) {
    const accountFile = accountPathForName(paths, accountName);
    let presence: RemotePresence = 'unknown';
    let remoteError: string | null = null;
    const remoteItem = config ? itemTitle(config, accountName) : null;

    if (!config) {
      remoteError = 'remote backend is not configured';
    } else if (!opPath) {
      remoteError = missingOpError().message;
    } else {
      try {
        presence = await onePasswordItemExists(config, remoteItem ?? '', env) ? 'present' : 'missing';
      } catch (error) {
        remoteError = errorMessage(error);
      }
    }

    statuses.push({
      account: accountName,
      item: remoteItem,
      local: {
        exists: await pathExists(accountFile),
        file: accountFile,
      },
      remote: {
        presence,
        error: remoteError,
      },
    });
  }

  return {
    configPath: getRemoteConfigPath(paths),
    configured: config !== null,
    backend: config?.backend ?? null,
    vault: config?.vault ?? null,
    itemPrefix: config?.itemPrefix ?? null,
    opAvailable: opPath !== null,
    opPath,
    accounts: statuses,
  };
}
