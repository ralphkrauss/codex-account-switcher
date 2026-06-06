import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  readCurrentMarker,
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
export const REMOTE_METADATA_FIELD = 'cx_metadata';
export const LOCAL_SYNC_METADATA_VERSION = 1;

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

export type SyncState = 'in-sync' | 'local-newer' | 'remote-newer' | 'diverged' | 'unknown';

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
  readonly sync: {
    readonly state: SyncState;
    readonly error: string | null;
  };
}

export interface RemoteAuthMetadata {
  readonly version: 1;
  readonly account: string;
  readonly authJsonSha256: string;
  readonly updatedAt: string;
  readonly deviceId?: string;
}

export interface LocalSyncMetadata {
  readonly version: typeof LOCAL_SYNC_METADATA_VERSION;
  readonly backend: RemoteBackend;
  readonly account: string;
  readonly vault?: string;
  readonly item?: string;
  readonly remoteAuthJsonSha256: string;
  readonly lastSyncedAuthJsonSha256: string;
  readonly lastSyncedAt: string;
  readonly deviceId: string;
}

export interface AutoSyncResult {
  readonly action: 'pulled' | 'pushed' | 'skipped';
  readonly account: string;
  readonly reason?: string;
  readonly item?: string;
  readonly backend?: RemoteBackend;
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

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function metadataAssignment(metadata: RemoteAuthMetadata): string {
  return `${REMOTE_METADATA_FIELD}=${JSON.stringify(metadata)}`;
}

function buildRemoteAuthMetadata(account: string, authJson: string): RemoteAuthMetadata {
  return {
    version: 1,
    account,
    authJsonSha256: sha256Hex(authJson),
    updatedAt: new Date().toISOString(),
    deviceId: getLocalDeviceId(),
  };
}

function getLocalDeviceId(): string {
  const key = 'CX_DEVICE_ID';
  const existing = process.env[key];
  if (existing && existing.trim().length > 0) {
    return existing.trim();
  }
  return randomUUID();
}

function getLocalSyncMetadataPath(paths: CodexPaths, account: string): string {
  return join(paths.accountsDir, '.sync', `${validateAccountName(account)}.json`);
}

async function readLocalSyncMetadata(paths: CodexPaths, account: string): Promise<LocalSyncMetadata | null> {
  let raw: string;
  try {
    raw = await readFile(getLocalSyncMetadataPath(paths, account), 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)
      || parsed.version !== LOCAL_SYNC_METADATA_VERSION
      || parsed.backend !== ONEPASSWORD_BACKEND
      || parsed.account !== account
      || typeof parsed.remoteAuthJsonSha256 !== 'string'
      || typeof parsed.lastSyncedAuthJsonSha256 !== 'string'
      || typeof parsed.lastSyncedAt !== 'string'
      || typeof parsed.deviceId !== 'string') {
      return null;
    }
    return {
      version: LOCAL_SYNC_METADATA_VERSION,
      backend: ONEPASSWORD_BACKEND,
      account,
      ...(typeof parsed.vault === 'string' ? { vault: parsed.vault } : {}),
      ...(typeof parsed.item === 'string' ? { item: parsed.item } : {}),
      remoteAuthJsonSha256: parsed.remoteAuthJsonSha256,
      lastSyncedAuthJsonSha256: parsed.lastSyncedAuthJsonSha256,
      lastSyncedAt: parsed.lastSyncedAt,
      deviceId: parsed.deviceId,
    };
  } catch {
    return null;
  }
}

async function writeLocalSyncMetadata(
  paths: CodexPaths,
  config: RemoteConfig,
  account: string,
  authJson: string,
  remoteMetadata?: RemoteAuthMetadata | null,
): Promise<void> {
  const hash = sha256Hex(authJson);
  const metadata: LocalSyncMetadata = {
    version: LOCAL_SYNC_METADATA_VERSION,
    backend: config.backend,
    account,
    vault: config.vault,
    item: itemTitle(config, account),
    remoteAuthJsonSha256: remoteMetadata?.authJsonSha256 ?? hash,
    lastSyncedAuthJsonSha256: hash,
    lastSyncedAt: new Date().toISOString(),
    deviceId: getLocalDeviceId(),
  };
  await writeFilePrivate(getLocalSyncMetadataPath(paths, account), `${JSON.stringify(metadata, null, 2)}\n`);
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
  account: string,
  authJson: string,
  env: NodeJS.ProcessEnv,
): Promise<{ operation: 'created' | 'updated'; metadata: RemoteAuthMetadata }> {
  const metadata = buildRemoteAuthMetadata(account, authJson);
  if (await onePasswordItemExists(config, item, env)) {
    await runOp([
      'item',
      'edit',
      item,
      '--vault',
      config.vault,
      authFieldAssignment(authJson),
      metadataAssignment(metadata),
    ], env, `updating 1Password item '${item}'`, { sensitive: true });
    return { operation: 'updated', metadata };
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
    metadataAssignment(metadata),
  ], env, `creating 1Password item '${item}'`, { sensitive: true });
  return { operation: 'created', metadata };
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

function parseRemoteAuthMetadata(value: unknown): RemoteAuthMetadata | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)
      || parsed.version !== 1
      || typeof parsed.account !== 'string'
      || typeof parsed.authJsonSha256 !== 'string'
      || typeof parsed.updatedAt !== 'string') {
      return null;
    }
    return {
      version: 1,
      account: parsed.account,
      authJsonSha256: parsed.authJsonSha256,
      updatedAt: parsed.updatedAt,
      ...(typeof parsed.deviceId === 'string' ? { deviceId: parsed.deviceId } : {}),
    };
  } catch {
    return null;
  }
}

function decodeAuthJsonFieldFromItemJson(stdout: string, item: string): string {
  return decodeOnePasswordAccountFromItemJson(stdout, item).authJson;
}

function decodeOnePasswordAccountFromItemJson(stdout: string, item: string): { authJson: string; metadata: RemoteAuthMetadata | null } {
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

  const metadataField = parsed.fields.find((candidate: unknown): candidate is Record<string, unknown> => (
    isRecord(candidate) && candidate.label === REMOTE_METADATA_FIELD
  ));
  return {
    authJson: field.value,
    metadata: parseRemoteAuthMetadata(metadataField?.value),
  };
}

async function readOnePasswordAuthJson(
  config: RemoteConfig,
  item: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return (await readOnePasswordAccount(config, item, env)).authJson;
}

async function readOnePasswordAccount(
  config: RemoteConfig,
  item: string,
  env: NodeJS.ProcessEnv,
): Promise<{ authJson: string; metadata: RemoteAuthMetadata | null }> {
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
      return decodeOnePasswordAccountFromItemJson(jsonResult.stdout, item);
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
    return { authJson: decodeAuthJsonField(fieldResult.stdout, item), metadata: null };
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

async function writebackCurrentAccountIfSyncTarget(
  targetAccount: string,
  paths: CodexPaths,
): Promise<void> {
  const current = await readCurrentMarker(paths);
  if (current.state === 'valid' && current.name !== targetAccount) {
    return;
  }
  await writebackCurrentAccount({ paths });
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
  await writebackCurrentAccountIfSyncTarget(safeAccount, paths);
  const local = await readLocalAccountAuthJson(safeAccount, paths);
  const item = itemTitle(config, local.account);
  const upload = await upsertOnePasswordAuthJson(config, item, local.account, local.authJson, env);
  await writeLocalSyncMetadata(paths, config, local.account, local.authJson, upload.metadata);

  return {
    account: local.account,
    accountFile: local.accountFile,
    backend: config.backend,
    vault: config.vault,
    item,
    operation: upload.operation,
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
  const remote = await readOnePasswordAccount(config, item, env);
  const verifiedMetadata = remote.metadata
    && remote.metadata.account === safeAccount
    && remote.metadata.authJsonSha256 === sha256Hex(remote.authJson)
    ? remote.metadata
    : null;
  const local = await writeLocalAccountAuthJson(safeAccount, remote.authJson, paths, options.force === true);
  await writeLocalSyncMetadata(paths, config, safeAccount, remote.authJson, verifiedMetadata);

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

function autoSyncDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.CX_AUTO_SYNC === '0' || env.CX_MAGIC_SYNC === '0' || env.CX_NO_MAGIC_SYNC === '1';
}

async function readLocalAuthHash(account: string, paths: CodexPaths): Promise<string | null> {
  try {
    const raw = await readFile(accountPathForName(paths, account), 'utf8');
    parseAuthJsonString(raw, `Codex account '${account}'`);
    return sha256Hex(raw);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function readRemoteAccountMetadata(
  account: string,
  config: RemoteConfig,
  env: NodeJS.ProcessEnv,
): Promise<{ metadata: RemoteAuthMetadata | null; authJson?: string }> {
  const item = itemTitle(config, account);
  const remote = await readOnePasswordAccount(config, item, env);
  const actualHash = sha256Hex(remote.authJson);
  const metadata = remote.metadata
    && remote.metadata.account === account
    && remote.metadata.authJsonSha256 === actualHash
    ? remote.metadata
    : null;
  return { metadata, authJson: remote.authJson };
}

function classifyHashes(
  localHash: string | null,
  localMetadata: LocalSyncMetadata | null,
  remoteMetadata: RemoteAuthMetadata | null,
): SyncState {
  if (!remoteMetadata || !localHash || !localMetadata) {
    return 'unknown';
  }
  if (localHash === remoteMetadata.authJsonSha256) {
    return 'in-sync';
  }
  const localChangedSinceSync = localHash !== localMetadata.lastSyncedAuthJsonSha256;
  const remoteChangedSinceSync = remoteMetadata.authJsonSha256 !== localMetadata.remoteAuthJsonSha256
    || remoteMetadata.authJsonSha256 !== localMetadata.lastSyncedAuthJsonSha256;
  if (!localChangedSinceSync && remoteChangedSinceSync) {
    return 'remote-newer';
  }
  if (localChangedSinceSync && !remoteChangedSinceSync) {
    return 'local-newer';
  }
  if (localChangedSinceSync && remoteChangedSinceSync) {
    return 'diverged';
  }
  return 'unknown';
}

async function inspectAccountSyncState(
  account: string,
  config: RemoteConfig | null,
  env: NodeJS.ProcessEnv,
  paths: CodexPaths,
): Promise<{ state: SyncState; error: string | null }> {
  if (!config) {
    return { state: 'unknown', error: 'remote backend is not configured' };
  }
  try {
    const [localHash, localMetadata, remote] = await Promise.all([
      readLocalAuthHash(account, paths),
      readLocalSyncMetadata(paths, account),
      readRemoteAccountMetadata(account, config, env),
    ]);
    return { state: classifyHashes(localHash, localMetadata, remote.metadata), error: null };
  } catch (error) {
    return { state: 'unknown', error: errorMessage(error) };
  }
}

export async function autoPullAccountForUse(
  account: string,
  options: RemoteCliOptions = {},
): Promise<AutoSyncResult> {
  const env = options.env ?? process.env;
  const paths = remotePaths(options);
  const safeAccount = validateAccountName(account);
  if (safeAccount === 'default') {
    return { action: 'skipped', account: safeAccount, reason: 'reserved default account' };
  }
  if (autoSyncDisabled(env)) {
    return { action: 'skipped', account: safeAccount, reason: 'auto sync disabled' };
  }
  const config = await readRemoteConfig({ paths });
  if (!config) {
    return { action: 'skipped', account: safeAccount, reason: 'remote backend is not configured' };
  }

  const item = itemTitle(config, safeAccount);
  const accountFile = accountPathForName(paths, safeAccount);
  const localExists = await pathExists(accountFile);
  if (!localExists) {
    const pulled = await syncPullAccount(safeAccount, { env, paths });
    return { action: 'pulled', account: pulled.account, item: pulled.item, backend: pulled.backend, reason: 'local account missing' };
  }

  const localHash = await readLocalAuthHash(safeAccount, paths);
  const localMetadata = await readLocalSyncMetadata(paths, safeAccount);
  const remote = await readRemoteAccountMetadata(safeAccount, config, env).catch((error: unknown) => ({
    metadata: null,
    error: errorMessage(error),
  }));
  if ('error' in remote) {
    return { action: 'skipped', account: safeAccount, item, backend: config.backend, reason: `remote unavailable: ${remote.error}` };
  }
  const state = classifyHashes(localHash, localMetadata, remote.metadata);
  if (state === 'remote-newer') {
    const pulled = await syncPullAccount(safeAccount, { env, paths, force: true });
    return { action: 'pulled', account: pulled.account, item: pulled.item, backend: pulled.backend, reason: 'remote newer' };
  }
  if (state === 'diverged') {
    throw new CxError(`sync conflict for '${safeAccount}': local and remote credentials diverged; use 'cx sync status ${safeAccount}', then resolve with explicit 'cx sync pull ${safeAccount} --force' or 'cx sync push ${safeAccount}'`, 1);
  }
  return { action: 'skipped', account: safeAccount, item, backend: config.backend, reason: state };
}

export async function autoPushAccountIfChanged(
  account: string,
  options: RemoteCliOptions = {},
): Promise<AutoSyncResult> {
  const env = options.env ?? process.env;
  const paths = remotePaths(options);
  const safeAccount = validateAccountName(account);
  if (safeAccount === 'default') {
    return { action: 'skipped', account: safeAccount, reason: 'reserved default account' };
  }
  if (autoSyncDisabled(env)) {
    return { action: 'skipped', account: safeAccount, reason: 'auto sync disabled' };
  }
  const config = await readRemoteConfig({ paths });
  if (!config) {
    return { action: 'skipped', account: safeAccount, reason: 'remote backend is not configured' };
  }
  const localHash = await readLocalAuthHash(safeAccount, paths);
  if (!localHash) {
    return { action: 'skipped', account: safeAccount, reason: 'local account missing' };
  }
  const localMetadata = await readLocalSyncMetadata(paths, safeAccount);
  const remote = await readRemoteAccountMetadata(safeAccount, config, env).then(
    (value) => ({ ...value, missing: false, unavailable: null as string | null }),
    (error: unknown) => {
      const message = errorMessage(error);
      if (message.includes('was not found')) {
        return { metadata: null, missing: true, unavailable: null as string | null };
      }
      return { metadata: null, missing: false, unavailable: message };
    },
  );
  if (remote.unavailable) {
    return { action: 'skipped', account: safeAccount, item: itemTitle(config, safeAccount), backend: config.backend, reason: `remote unavailable: ${remote.unavailable}` };
  }
  if (remote.missing) {
    if (localMetadata) {
      return { action: 'skipped', account: safeAccount, item: itemTitle(config, safeAccount), backend: config.backend, reason: 'remote missing after previous sync' };
    }
    const pushed = await syncPushAccount(safeAccount, { env, paths });
    return { action: 'pushed', account: pushed.account, item: pushed.item, backend: pushed.backend, reason: 'remote missing' };
  }
  const state = classifyHashes(localHash, localMetadata, remote.metadata);
  if (state === 'in-sync') {
    return { action: 'skipped', account: safeAccount, item: itemTitle(config, safeAccount), backend: config.backend, reason: 'in-sync' };
  }
  if (state === 'diverged') {
    throw new CxError(`sync conflict for '${safeAccount}': local and remote credentials diverged; use 'cx sync status ${safeAccount}', then resolve with explicit 'cx sync pull ${safeAccount} --force' or 'cx sync push ${safeAccount}'`, 1);
  }
  if (state !== 'local-newer') {
    return { action: 'skipped', account: safeAccount, item: itemTitle(config, safeAccount), backend: config.backend, reason: state };
  }
  const pushed = await syncPushAccount(safeAccount, { env, paths });
  return { action: 'pushed', account: pushed.account, item: pushed.item, backend: pushed.backend, reason: state };
}

export async function writebackAndAutoPushCurrentAccount(
  options: RemoteCliOptions = {},
): Promise<AutoSyncResult | null> {
  const paths = remotePaths(options);
  const writeback = await writebackCurrentAccount({ paths });
  if (!writeback.performed || !writeback.account) {
    return null;
  }
  return await autoPushAccountIfChanged(writeback.account, options);
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

    const sync = await inspectAccountSyncState(accountName, config, env, paths);

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
      sync,
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
