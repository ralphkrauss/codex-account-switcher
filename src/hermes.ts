import { randomBytes } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  CxError,
  accountPathForName,
  getCodexPaths,
  validateAccountName,
} from './accounts.js';

export const HERMES_OPENAI_CODEX_PROVIDER = 'openai-codex';
export const HERMES_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

const AUTH_STORE_VERSION = 1;
const ERROR_MARKER_KEYS = [
  'last_status',
  'last_status_at',
  'last_error_code',
  'last_error_reason',
  'last_error_message',
  'last_error_reset_at',
] as const;
const POOL_TOKEN_EXTRA_KEYS = [
  'token_type',
  'scope',
  'client_id',
  'expires_in',
  'expires_at',
  'expires_at_ms',
] as const;

export interface HermesPaths {
  readonly home: string;
  readonly authFile: string;
  readonly configFile: string;
  readonly profile: string | null;
}

export interface HermesProfileOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly profile?: string | null;
}

export interface HermesUseOptions extends HermesProfileOptions {
  readonly updateConfig?: boolean;
}

export interface HermesUseResult {
  readonly account: string;
  readonly codexAccountFile: string;
  readonly hermesHome: string;
  readonly hermesAuthFile: string;
  readonly hermesConfigFile: string | null;
  readonly profile: string | null;
}

export interface HermesSyncResult {
  readonly account: string;
  readonly codexAccountFile: string;
  readonly hermesHome: string;
  readonly hermesAuthFile: string;
  readonly profile: string | null;
}

export interface HermesStatus {
  readonly hermesHome: string;
  readonly authFile: string;
  readonly configFile: string;
  readonly profile: string | null;
  readonly authExists: boolean;
  readonly authReadable: boolean;
  readonly authError: string | null;
  readonly openaiCodexAuthExists: boolean;
  readonly hasTokens: boolean;
  readonly hasAccessToken: boolean;
  readonly hasRefreshToken: boolean;
  readonly lastRefresh: string | null;
  readonly authMode: string | null;
  readonly linkedAccount: string | null;
  readonly linkedAccounts: readonly string[];
  readonly poolEntryCount: number;
  readonly configuredProvider: string | null;
  readonly configExists: boolean;
  readonly configReadable: boolean;
  readonly configError: string | null;
}

type JsonObject = Record<string, unknown>;

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

async function statIfExists(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
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

async function readJsonObject(path: string, description: string): Promise<JsonObject> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new CxError(`${description} not found at ${path}`, 1);
    }
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new CxError(`${description} at ${path} must be a JSON object`, 1);
    }
    return parsed;
  } catch (error) {
    if (error instanceof CxError) {
      throw error;
    }
    throw new CxError(`failed to parse ${description} at ${path}: ${errorMessage(error)}`, 1);
  }
}

async function readHermesAuthStore(authFile: string): Promise<JsonObject> {
  if (!(await pathExists(authFile))) {
    return { version: AUTH_STORE_VERSION, providers: {} };
  }
  const store = await readJsonObject(authFile, 'Hermes auth.json');
  if (!isRecord(store.providers)) {
    store.providers = {};
  }
  return store;
}

async function writeJsonPrivate(destination: string, payload: JsonObject): Promise<void> {
  await writeFilePrivate(destination, `${JSON.stringify(payload, null, 2)}\n`);
}

function userHomeFromEnv(env: NodeJS.ProcessEnv): string {
  const configured = env.HOME ?? env.USERPROFILE;
  if (configured && configured.trim().length > 0) {
    return resolve(configured);
  }
  return homedir();
}

function validateHermesProfileName(name: string): string {
  try {
    return validateAccountName(name);
  } catch (error) {
    if (error instanceof CxError) {
      throw new CxError(error.message.replace('account name', 'Hermes profile name'), error.exitCode);
    }
    throw error;
  }
}

export function getHermesPaths(options: HermesProfileOptions = {}): HermesPaths {
  const env = options.env ?? process.env;
  const rawProfile = options.profile;
  let profile: string | null = null;
  let home: string;

  if (rawProfile !== undefined && rawProfile !== null) {
    const trimmedProfile = rawProfile.trim();
    if (!trimmedProfile) {
      throw new CxError('Hermes profile name cannot be empty', 2);
    }
    profile = validateHermesProfileName(trimmedProfile);
    home = join(userHomeFromEnv(env), '.hermes', 'profiles', profile);
  } else {
    const configured = env.HERMES_HOME;
    home = configured && configured.trim().length > 0
      ? resolve(configured)
      : join(userHomeFromEnv(env), '.hermes');
  }

  return {
    home,
    authFile: join(home, 'auth.json'),
    configFile: join(home, 'config.yaml'),
    profile,
  };
}

function accountTokensFromPayload(payload: JsonObject, account: string): JsonObject {
  const nestedTokens = payload.tokens;
  const tokens = isRecord(nestedTokens)
    ? nestedTokens
    : (stringValue(payload.access_token) && stringValue(payload.refresh_token) ? payload : null);

  if (!tokens) {
    throw new CxError(`account '${account}' does not contain Codex OAuth tokens`, 1);
  }

  const accessToken = stringValue(tokens.access_token);
  const refreshToken = stringValue(tokens.refresh_token);
  if (!accessToken) {
    throw new CxError(`account '${account}' is missing tokens.access_token`, 1);
  }
  if (!refreshToken) {
    throw new CxError(`account '${account}' is missing tokens.refresh_token`, 1);
  }

  return {
    ...tokens,
    access_token: accessToken,
    refresh_token: refreshToken,
  };
}

async function readCodexAccountPayload(
  account: string,
  env: NodeJS.ProcessEnv,
): Promise<{ account: string; accountFile: string; payload: JsonObject }> {
  const safeAccount = validateAccountName(account);
  const codexPaths = getCodexPaths(env);
  const accountFile = accountPathForName(codexPaths, safeAccount);
  if (!(await pathExists(accountFile))) {
    throw new CxError(`no account '${safeAccount}'`, 1);
  }

  return {
    account: safeAccount,
    accountFile,
    payload: await readJsonObject(accountFile, `Codex account '${safeAccount}'`),
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

function randomCredentialId(): string {
  return randomBytes(3).toString('hex');
}

function numericValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nextPoolPriority(entries: readonly unknown[]): number {
  let max = -1;
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const priority = numericValue(entry.priority);
    if (priority !== null && priority > max) {
      max = priority;
    }
  }
  return max + 1;
}

function buildCxPoolEntry(
  account: string,
  tokens: JsonObject,
  lastRefresh: string,
  entries: readonly unknown[],
  priorEntry: JsonObject | null,
): JsonObject {
  const entry: JsonObject = {
    id: stringValue(priorEntry?.id) || randomCredentialId(),
    label: `cx:${account}`,
    auth_type: 'oauth',
    priority: numericValue(priorEntry?.priority) ?? nextPoolPriority(entries),
    source: `manual:cx:${account}`,
    access_token: stringValue(tokens.access_token),
    refresh_token: stringValue(tokens.refresh_token),
    base_url: HERMES_CODEX_BASE_URL,
    last_refresh: lastRefresh,
    request_count: numericValue(priorEntry?.request_count) ?? 0,
  };

  for (const key of POOL_TOKEN_EXTRA_KEYS) {
    if (tokens[key] !== undefined && tokens[key] !== null) {
      entry[key] = tokens[key];
    }
  }
  for (const key of ERROR_MARKER_KEYS) {
    entry[key] = null;
  }

  return entry;
}

function upsertCxPoolEntry(entries: readonly unknown[], account: string, tokens: JsonObject, lastRefresh: string): JsonObject[] {
  const label = `cx:${account}`;
  const source = `manual:cx:${account}`;
  const kept: JsonObject[] = [];
  let insertIndex = -1;
  let priorEntry: JsonObject | null = null;

  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const isSameAccount = entry.label === label || entry.source === source;
    if (isSameAccount) {
      if (insertIndex === -1) {
        insertIndex = kept.length;
        priorEntry = entry;
      }
      continue;
    }
    kept.push(entry);
  }

  const nextEntry = buildCxPoolEntry(account, tokens, lastRefresh, entries, priorEntry);
  if (insertIndex === -1 || insertIndex >= kept.length) {
    kept.push(nextEntry);
  } else {
    kept.splice(insertIndex, 0, nextEntry);
  }
  return kept;
}

function ensureObjectProperty(parent: JsonObject, key: string): JsonObject {
  const existing = parent[key];
  if (isRecord(existing)) {
    return existing;
  }
  const next: JsonObject = {};
  parent[key] = next;
  return next;
}

function stripYamlComment(value: string): string {
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') {
      return value.slice(0, index);
    }
  }
  return value;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = stripYamlComment(value).trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function isTopLevelModelLine(line: string): RegExpExecArray | null {
  if (/^\s/u.test(line) || /^\s*(?:#|$)/u.test(line)) {
    return null;
  }
  return /^model\s*:\s*(.*)$/u.exec(line);
}

function isIndentedOrBlank(line: string): boolean {
  return /^\s/u.test(line) || /^\s*$/u.test(line);
}

function isFlowMapping(value: string): boolean {
  const scalar = unquoteYamlScalar(value);
  return scalar.startsWith('{') && scalar.endsWith('}');
}

function replacementModelHeader(rawValue: string, provider: string): string[] {
  const scalarValue = unquoteYamlScalar(rawValue);
  const replacement = ['model:'];
  if (scalarValue && scalarValue !== '{}' && scalarValue !== 'null' && !isFlowMapping(rawValue)) {
    replacement.push(`  default: ${scalarValue}`);
  }
  replacement.push(`  provider: ${provider}`);
  replacement.push(`  base_url: ${HERMES_CODEX_BASE_URL}`);
  return replacement;
}

function updateHermesConfigProviderText(text: string, provider: string): string {
  const normalized = text.replaceAll('\r\n', '\n');
  const lines = normalized.length > 0 ? normalized.split('\n') : [];
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  for (let index = 0; index < lines.length; index += 1) {
    const match = isTopLevelModelLine(lines[index] ?? '');
    if (!match) {
      continue;
    }

    const rawValue = match[1] ?? '';
    if (unquoteYamlScalar(rawValue)) {
      lines.splice(index, 1, ...replacementModelHeader(rawValue, provider));
      return `${lines.join('\n')}\n`;
    }

    let end = index + 1;
    while (end < lines.length && isIndentedOrBlank(lines[end] ?? '')) {
      end += 1;
    }

    let providerSeen = false;
    let baseUrlSeen = false;
    const replacement: string[] = [];
    for (let inner = index + 1; inner < end; inner += 1) {
      const line = lines[inner] ?? '';
      const childMatch = /^(\s*)(provider|base_url|api_key|api_mode)\s*:/u.exec(line);
      if (!childMatch) {
        replacement.push(line);
        continue;
      }

      const indent = childMatch[1] && childMatch[1].length > 0 ? childMatch[1] : '  ';
      const key = childMatch[2];
      if (key === 'provider') {
        if (!providerSeen) {
          replacement.push(`${indent}provider: ${provider}`);
          providerSeen = true;
        }
      } else if (key === 'base_url') {
        if (!baseUrlSeen) {
          replacement.push(`${indent}base_url: ${HERMES_CODEX_BASE_URL}`);
          baseUrlSeen = true;
        }
      }
      // Drop api_key/api_mode and duplicate provider/base_url entries to avoid stale provider-specific config.
    }

    if (!providerSeen) {
      replacement.push(`  provider: ${provider}`);
    }
    if (!baseUrlSeen) {
      replacement.push(`  base_url: ${HERMES_CODEX_BASE_URL}`);
    }

    lines.splice(index + 1, end - index - 1, ...replacement);
    return `${lines.join('\n')}\n`;
  }

  if (lines.length > 0 && (lines[lines.length - 1] ?? '').trim().length > 0) {
    lines.push('');
  }
  lines.push('model:', `  provider: ${provider}`, `  base_url: ${HERMES_CODEX_BASE_URL}`);
  return `${lines.join('\n')}\n`;
}

async function updateHermesConfigProvider(configFile: string): Promise<void> {
  let current = '';
  try {
    current = await readFile(configFile, 'utf8');
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
  await writeFilePrivate(configFile, updateHermesConfigProviderText(current, HERMES_OPENAI_CODEX_PROVIDER));
}

function flowMappingValueForKey(rawValue: string, key: string): string | null {
  const scalar = stripYamlComment(rawValue).trim();
  if (!scalar.startsWith('{') || !scalar.endsWith('}')) {
    return null;
  }
  const inner = scalar.slice(1, -1);
  const match = new RegExp(`(?:^|,)\\s*${key}\\s*:\\s*([^,}]+)`, 'u').exec(inner);
  return match ? unquoteYamlScalar(match[1] ?? '') || null : null;
}

async function readHermesConfiguredProvider(configFile: string): Promise<{
  exists: boolean;
  readable: boolean;
  provider: string | null;
  error: string | null;
}> {
  let text: string;
  try {
    text = await readFile(configFile, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return { exists: false, readable: false, provider: null, error: null };
    }
    return { exists: true, readable: false, provider: null, error: errorMessage(error) };
  }

  const lines = text.replaceAll('\r\n', '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const modelMatch = isTopLevelModelLine(lines[index] ?? '');
    if (!modelMatch) {
      continue;
    }

    const inlineProvider = flowMappingValueForKey(modelMatch[1] ?? '', 'provider');
    if (inlineProvider) {
      return { exists: true, readable: true, provider: inlineProvider, error: null };
    }

    let end = index + 1;
    while (end < lines.length && isIndentedOrBlank(lines[end] ?? '')) {
      end += 1;
    }
    for (let inner = index + 1; inner < end; inner += 1) {
      const providerMatch = /^\s*provider\s*:\s*(.*)$/u.exec(lines[inner] ?? '');
      if (providerMatch) {
        const provider = unquoteYamlScalar(providerMatch[1] ?? '');
        return { exists: true, readable: true, provider: provider || null, error: null };
      }
    }
    return { exists: true, readable: true, provider: null, error: null };
  }

  return { exists: true, readable: true, provider: null, error: null };
}

function providerStateFromStore(store: JsonObject): JsonObject | null {
  const providers = store.providers;
  if (!isRecord(providers)) {
    return null;
  }
  const state = providers[HERMES_OPENAI_CODEX_PROVIDER];
  return isRecord(state) ? state : null;
}

function tokensFromProviderState(state: JsonObject | null): JsonObject | null {
  if (!state) {
    return null;
  }
  return isRecord(state.tokens) ? state.tokens : null;
}

function openaiCodexPoolEntries(store: JsonObject): JsonObject[] {
  const pool = store.credential_pool;
  if (!isRecord(pool)) {
    return [];
  }
  const entries = pool[HERMES_OPENAI_CODEX_PROVIDER];
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.filter(isRecord);
}

function accountFromCxPoolEntry(entry: JsonObject): string | null {
  const label = stringValue(entry.label);
  if (label.startsWith('cx:')) {
    return label.slice('cx:'.length).trim() || null;
  }
  const source = stringValue(entry.source);
  if (source.startsWith('manual:cx:')) {
    return source.slice('manual:cx:'.length).trim() || null;
  }
  return null;
}

function linkedAccountsFromPool(entries: readonly JsonObject[]): string[] {
  const accounts: string[] = [];
  for (const entry of entries) {
    const account = accountFromCxPoolEntry(entry);
    if (account && !accounts.includes(account)) {
      accounts.push(account);
    }
  }
  return accounts;
}

export async function useHermesAccount(account: string, options: HermesUseOptions = {}): Promise<HermesUseResult> {
  const env = options.env ?? process.env;
  const accountData = await readCodexAccountPayload(account, env);
  const tokens = accountTokensFromPayload(accountData.payload, accountData.account);
  const hermesPaths = getHermesPaths(options);
  const lastRefresh = isoNow();

  const store = await readHermesAuthStore(hermesPaths.authFile);
  store.version = AUTH_STORE_VERSION;
  store.updated_at = lastRefresh;

  const providers = ensureObjectProperty(store, 'providers');
  const currentState = isRecord(providers[HERMES_OPENAI_CODEX_PROVIDER])
    ? { ...(providers[HERMES_OPENAI_CODEX_PROVIDER] as JsonObject) }
    : {};
  providers[HERMES_OPENAI_CODEX_PROVIDER] = {
    ...currentState,
    tokens,
    last_refresh: lastRefresh,
    auth_mode: 'chatgpt',
  };
  store.active_provider = HERMES_OPENAI_CODEX_PROVIDER;

  const pool = ensureObjectProperty(store, 'credential_pool');
  const currentEntries = Array.isArray(pool[HERMES_OPENAI_CODEX_PROVIDER])
    ? pool[HERMES_OPENAI_CODEX_PROVIDER]
    : [];
  pool[HERMES_OPENAI_CODEX_PROVIDER] = upsertCxPoolEntry(
    currentEntries,
    accountData.account,
    tokens,
    lastRefresh,
  );

  await writeJsonPrivate(hermesPaths.authFile, store);
  let hermesConfigFile: string | null = null;
  if (options.updateConfig !== false) {
    await updateHermesConfigProvider(hermesPaths.configFile);
    hermesConfigFile = hermesPaths.configFile;
  }

  return {
    account: accountData.account,
    codexAccountFile: accountData.accountFile,
    hermesHome: hermesPaths.home,
    hermesAuthFile: hermesPaths.authFile,
    hermesConfigFile,
    profile: hermesPaths.profile,
  };
}

export async function syncHermesAccount(account: string, options: HermesProfileOptions = {}): Promise<HermesSyncResult> {
  const env = options.env ?? process.env;
  const accountData = await readCodexAccountPayload(account, env);
  const hermesPaths = getHermesPaths(options);
  const store = await readHermesAuthStore(hermesPaths.authFile);
  const providerState = providerStateFromStore(store);
  const tokens = tokensFromProviderState(providerState);
  if (!tokens) {
    throw new CxError(`Hermes ${HERMES_OPENAI_CODEX_PROVIDER} tokens not found at ${hermesPaths.authFile}`, 1);
  }

  const accessToken = stringValue(tokens.access_token);
  const refreshToken = stringValue(tokens.refresh_token);
  if (!accessToken) {
    throw new CxError(`Hermes ${HERMES_OPENAI_CODEX_PROVIDER} tokens are missing access_token`, 1);
  }
  if (!refreshToken) {
    throw new CxError(`Hermes ${HERMES_OPENAI_CODEX_PROVIDER} tokens are missing refresh_token`, 1);
  }

  await writeJsonPrivate(accountData.accountFile, {
    ...accountData.payload,
    tokens: {
      ...tokens,
      access_token: accessToken,
      refresh_token: refreshToken,
    },
  });

  return {
    account: accountData.account,
    codexAccountFile: accountData.accountFile,
    hermesHome: hermesPaths.home,
    hermesAuthFile: hermesPaths.authFile,
    profile: hermesPaths.profile,
  };
}

export async function inspectHermesStatus(options: HermesProfileOptions = {}): Promise<HermesStatus> {
  const hermesPaths = getHermesPaths(options);
  const authStats = await statIfExists(hermesPaths.authFile);
  const authExists = Boolean(authStats?.isFile());
  let authReadable = false;
  let authError: string | null = null;
  let store: JsonObject = { version: AUTH_STORE_VERSION, providers: {} };

  if (authExists) {
    try {
      store = await readHermesAuthStore(hermesPaths.authFile);
      authReadable = true;
    } catch (error) {
      authError = errorMessage(error);
    }
  }

  const providerState = authReadable ? providerStateFromStore(store) : null;
  const tokens = tokensFromProviderState(providerState);
  const poolEntries = authReadable ? openaiCodexPoolEntries(store) : [];
  const linkedAccounts = linkedAccountsFromPool(poolEntries);
  const config = await readHermesConfiguredProvider(hermesPaths.configFile);

  return {
    hermesHome: hermesPaths.home,
    authFile: hermesPaths.authFile,
    configFile: hermesPaths.configFile,
    profile: hermesPaths.profile,
    authExists,
    authReadable,
    authError,
    openaiCodexAuthExists: providerState !== null,
    hasTokens: tokens !== null,
    hasAccessToken: Boolean(tokens && stringValue(tokens.access_token)),
    hasRefreshToken: Boolean(tokens && stringValue(tokens.refresh_token)),
    lastRefresh: typeof providerState?.last_refresh === 'string' ? providerState.last_refresh : null,
    authMode: typeof providerState?.auth_mode === 'string' ? providerState.auth_mode : null,
    linkedAccount: linkedAccounts[0] ?? null,
    linkedAccounts,
    poolEntryCount: poolEntries.length,
    configuredProvider: config.provider,
    configExists: config.exists,
    configReadable: config.readable,
    configError: config.error,
  };
}
