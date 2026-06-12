import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CxError, validateAccountName, type CodexPaths } from './accounts.js';
import type {
  ConfigureRemoteResult,
  GoogleDriveRemoteConfig,
  GoogleDriveStorage,
  RemoteAuthMetadata,
  RemoteCliOptions,
  RemotePathOptions,
} from './remote.js';

export const GOOGLE_DRIVE_BACKEND = 'gdrive';
export const DEFAULT_GDRIVE_FILE_PREFIX = 'cx-';
export const GOOGLE_DRIVE_PENDING_VERSION = 1;
export const GOOGLE_DRIVE_TOKEN_VERSION = 1;
export const GOOGLE_DRIVE_DEFAULT_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const GOOGLE_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_DRIVE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_DRIVE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface StartGoogleDriveOAuthInput {
  readonly clientSecretFile: string;
  readonly folderId?: string;
  readonly filePrefix?: string;
  readonly encryption?: 'none' | 'env';
}

export interface StartGoogleDriveOAuthResult {
  readonly authUrl: string;
  readonly pendingFile: string;
  readonly state: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly storage: GoogleDriveStorage;
  readonly folderId: string | null;
  readonly tokenFile: string;
  readonly filePrefix: string;
  readonly encryption: 'none' | 'env';
}

export interface FinishGoogleDriveOAuthResult extends Omit<ConfigureRemoteResult, 'config'> {
  readonly config: GoogleDriveRemoteConfig;
  readonly tokenFile: string;
}

interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string | null;
  readonly redirectUri: string;
}

interface GoogleDrivePendingOAuth {
  readonly version: typeof GOOGLE_DRIVE_PENDING_VERSION;
  readonly clientSecretFile: string;
  readonly tokenFile: string;
  readonly storage: GoogleDriveStorage;
  readonly folderId?: string;
  readonly filePrefix: string;
  readonly encryption: 'none' | 'env';
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly createdAt: string;
}

interface GoogleDriveTokenFile {
  readonly version?: typeof GOOGLE_DRIVE_TOKEN_VERSION;
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly expiry_date?: number;
  readonly token_type?: string;
  readonly scope?: string;
  readonly [key: string]: unknown;
}

interface GoogleDriveFileEntry {
  readonly id: string;
  readonly name: string;
}

interface GoogleDriveStoredAccount {
  readonly version: 1;
  readonly account: string;
  readonly metadata: RemoteAuthMetadata;
  readonly authJson?: string;
  readonly encryptedAuthJson?: {
    readonly algorithm: 'aes-256-gcm';
    readonly key: 'CX_GDRIVE_ENCRYPTION_KEY';
    readonly iv: string;
    readonly ciphertext: string;
    readonly tag: string;
  };
}

interface GoogleDriveUploadResult {
  readonly operation: 'created' | 'updated';
  readonly metadata: RemoteAuthMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
  const temp = join(dirname(destination), `.cx-gdrive-${randomBytes(6).toString('hex')}.tmp`);
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

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Base64Url(value: string): string {
  return base64Url(createHash('sha256').update(value).digest());
}

function buildRemoteAuthMetadata(account: string, authJson: string): RemoteAuthMetadata {
  return {
    version: 1,
    account,
    authJsonSha256: sha256Hex(authJson),
    updatedAt: new Date().toISOString(),
    ...(process.env.CX_DEVICE_ID ? { deviceId: process.env.CX_DEVICE_ID } : {}),
  };
}

function parseAuthJsonString(raw: string, description: string): void {
  try {
    JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CxError(`${description} is not valid JSON: ${errorMessage(error)}`, 1);
  }
}

function defaultTokenFile(paths: CodexPaths): string {
  return join(paths.home, 'gdrive-token.json');
}

function pendingFile(paths: CodexPaths): string {
  return join(paths.home, 'gdrive-oauth-pending.json');
}

function remoteConfigFile(paths: CodexPaths): string {
  return join(paths.home, 'remote.json');
}

function normalizePrefix(value: string | undefined): string {
  if (value === undefined || value === '') {
    return DEFAULT_GDRIVE_FILE_PREFIX;
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new CxError('Google Drive file prefix must not contain path separators', 2);
  }
  return value;
}

function parseOAuthClient(raw: string, file: string): OAuthClient {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CxError(`Google OAuth client secret file '${file}' is not valid JSON: ${errorMessage(error)}`, 1);
  }
  if (!isRecord(parsed)) {
    throw new CxError(`Google OAuth client secret file '${file}' must be a JSON object`, 1);
  }
  const client = parsed.installed ?? parsed.web;
  if (!isRecord(client)) {
    throw new CxError(`Google OAuth client secret file '${file}' must contain an installed or web client`, 1);
  }
  const clientId = client.client_id;
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new CxError(`Google OAuth client secret file '${file}' is missing client_id`, 1);
  }
  const clientSecret = typeof client.client_secret === 'string' && client.client_secret.length > 0
    ? client.client_secret
    : null;
  const redirectUris = Array.isArray(client.redirect_uris)
    ? client.redirect_uris.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
  return {
    clientId,
    clientSecret,
    redirectUri: redirectUris[0] ?? 'http://localhost',
  };
}

async function readOAuthClient(clientSecretFile: string): Promise<OAuthClient> {
  const resolved = resolve(clientSecretFile);
  return parseOAuthClient(await readFile(resolved, 'utf8'), resolved);
}

function storageFromInput(input: StartGoogleDriveOAuthInput): { storage: GoogleDriveStorage; folderId?: string; scope: string } {
  if (input.folderId && input.folderId.trim().length > 0) {
    return { storage: 'folder', folderId: input.folderId.trim(), scope: GOOGLE_DRIVE_FILE_SCOPE };
  }
  return { storage: 'appDataFolder', scope: GOOGLE_DRIVE_DEFAULT_SCOPE };
}

function tokenUrl(env: NodeJS.ProcessEnv): string {
  return env.CX_GDRIVE_TOKEN_URL ?? GOOGLE_DRIVE_OAUTH_TOKEN_URL;
}

function apiBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.CX_GDRIVE_API_BASE_URL ?? 'https://www.googleapis.com').replace(/\/+$/u, '');
}

function parseCodeAndState(input: string): { code: string; state: string | null } {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new CxError('Google OAuth auth code is required', 2);
  }
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    if (!code) {
      throw new CxError('Google OAuth redirect URL did not contain a code parameter', 2);
    }
    return { code, state: url.searchParams.get('state') };
  } catch (error) {
    if (error instanceof CxError) {
      throw error;
    }
    return { code: trimmed, state: null };
  }
}

async function readPending(paths: CodexPaths): Promise<GoogleDrivePendingOAuth> {
  const file = pendingFile(paths);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new CxError(`no pending Google Drive OAuth flow found at ${file}; run 'cx backend setup gdrive oauth --client-secret <file> --auth-url' first`, 1);
    }
    throw new CxError(`pending Google Drive OAuth flow at ${file} could not be read: ${errorMessage(error)}`, 1);
  }
  if (!isRecord(parsed)
    || parsed.version !== GOOGLE_DRIVE_PENDING_VERSION
    || typeof parsed.clientSecretFile !== 'string'
    || typeof parsed.tokenFile !== 'string'
    || (parsed.storage !== 'appDataFolder' && parsed.storage !== 'folder')
    || typeof parsed.filePrefix !== 'string'
    || (parsed.encryption !== 'none' && parsed.encryption !== 'env')
    || typeof parsed.state !== 'string'
    || typeof parsed.codeVerifier !== 'string'
    || typeof parsed.redirectUri !== 'string'
    || typeof parsed.scope !== 'string'
    || typeof parsed.createdAt !== 'string') {
    throw new CxError(`pending Google Drive OAuth flow at ${file} is invalid`, 1);
  }
  return {
    version: GOOGLE_DRIVE_PENDING_VERSION,
    clientSecretFile: parsed.clientSecretFile,
    tokenFile: parsed.tokenFile,
    storage: parsed.storage,
    ...(typeof parsed.folderId === 'string' && parsed.folderId.length > 0 ? { folderId: parsed.folderId } : {}),
    filePrefix: parsed.filePrefix,
    encryption: parsed.encryption,
    state: parsed.state,
    codeVerifier: parsed.codeVerifier,
    redirectUri: parsed.redirectUri,
    scope: parsed.scope,
    createdAt: parsed.createdAt,
  };
}

export async function startGoogleDriveOAuth(
  input: StartGoogleDriveOAuthInput,
  options: RemotePathOptions & { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<StartGoogleDriveOAuthResult> {
  const paths = options.paths ?? (await import('./accounts.js')).getCodexPaths(options.env ?? process.env);
  const clientSecretFile = resolve(input.clientSecretFile);
  const client = await readOAuthClient(clientSecretFile);
  const storage = storageFromInput(input);
  const codeVerifier = base64Url(randomBytes(32));
  const state = base64Url(randomBytes(18));
  const tokenFile = defaultTokenFile(paths);
  const filePrefix = normalizePrefix(input.filePrefix);
  const encryption = input.encryption ?? 'none';

  const auth = new URL(GOOGLE_DRIVE_OAUTH_AUTH_URL);
  auth.searchParams.set('client_id', client.clientId);
  auth.searchParams.set('redirect_uri', client.redirectUri);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', storage.scope);
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('prompt', 'consent');
  auth.searchParams.set('code_challenge', sha256Base64Url(codeVerifier));
  auth.searchParams.set('code_challenge_method', 'S256');
  auth.searchParams.set('state', state);

  const pending: GoogleDrivePendingOAuth = {
    version: GOOGLE_DRIVE_PENDING_VERSION,
    clientSecretFile,
    tokenFile,
    storage: storage.storage,
    ...(storage.folderId ? { folderId: storage.folderId } : {}),
    filePrefix,
    encryption,
    state,
    codeVerifier,
    redirectUri: client.redirectUri,
    scope: storage.scope,
    createdAt: new Date().toISOString(),
  };
  await writeFilePrivate(pendingFile(paths), `${JSON.stringify(pending, null, 2)}\n`);
  return {
    authUrl: auth.toString(),
    pendingFile: pendingFile(paths),
    state,
    redirectUri: client.redirectUri,
    scope: storage.scope,
    storage: storage.storage,
    folderId: storage.folderId ?? null,
    tokenFile,
    filePrefix,
    encryption,
  };
}

async function fetchJson(url: string, init: RequestInit, action: string): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set('connection', 'close');
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  if (!response.ok) {
    throw new CxError(`${action} failed: HTTP ${response.status}; ${text.slice(0, 500)}`, 1);
  }
  try {
    return text.length > 0 ? JSON.parse(text) as unknown : {};
  } catch (error) {
    throw new CxError(`${action} returned invalid JSON: ${errorMessage(error)}`, 1);
  }
}

async function exchangeCodeForToken(pending: GoogleDrivePendingOAuth, code: string, env: NodeJS.ProcessEnv): Promise<GoogleDriveTokenFile> {
  const client = await readOAuthClient(pending.clientSecretFile);
  const body = new URLSearchParams();
  body.set('client_id', client.clientId);
  if (client.clientSecret) {
    body.set('client_secret', client.clientSecret);
  }
  body.set('code', code);
  body.set('code_verifier', pending.codeVerifier);
  body.set('grant_type', 'authorization_code');
  body.set('redirect_uri', pending.redirectUri);
  const parsed = await fetchJson(tokenUrl(env), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  }, 'exchanging Google Drive OAuth code');
  if (!isRecord(parsed) || typeof parsed.access_token !== 'string') {
    throw new CxError('Google OAuth token response did not contain access_token', 1);
  }
  const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
  return {
    version: GOOGLE_DRIVE_TOKEN_VERSION,
    ...parsed,
    expiry_date: Date.now() + (expiresIn * 1000),
  } as GoogleDriveTokenFile;
}

export async function finishGoogleDriveOAuth(
  codeOrRedirectUrl: string,
  options: RemotePathOptions & { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<FinishGoogleDriveOAuthResult> {
  const env = options.env ?? process.env;
  const paths = options.paths ?? (await import('./accounts.js')).getCodexPaths(env);
  const pending = await readPending(paths);
  const parsed = parseCodeAndState(codeOrRedirectUrl);
  if (parsed.state && parsed.state !== pending.state) {
    throw new CxError('Google OAuth state mismatch; restart the auth-url flow and paste the newest redirect URL', 1);
  }
  const token = await exchangeCodeForToken(pending, parsed.code, env);
  await writeFilePrivate(pending.tokenFile, `${JSON.stringify(token, null, 2)}\n`);
  await rm(pendingFile(paths), { force: true });

  const config: GoogleDriveRemoteConfig = {
    version: 1,
    backend: GOOGLE_DRIVE_BACKEND,
    storage: pending.storage,
    ...(pending.folderId ? { folderId: pending.folderId } : {}),
    tokenFile: pending.tokenFile,
    clientSecretFile: pending.clientSecretFile,
    filePrefix: pending.filePrefix,
    encryption: pending.encryption,
  };
  await writeFilePrivate(remoteConfigFile(paths), `${JSON.stringify(config, null, 2)}\n`);
  return { configPath: remoteConfigFile(paths), config, tokenFile: pending.tokenFile };
}

async function readToken(config: GoogleDriveRemoteConfig): Promise<GoogleDriveTokenFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(config.tokenFile, 'utf8')) as unknown;
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new CxError(`Google Drive token file not found at ${config.tokenFile}; run OAuth setup again`, 1);
    }
    throw error;
  }
  if (!isRecord(parsed)) {
    throw new CxError(`Google Drive token file at ${config.tokenFile} is invalid`, 1);
  }
  return parsed as GoogleDriveTokenFile;
}

async function refreshToken(config: GoogleDriveRemoteConfig, token: GoogleDriveTokenFile, env: NodeJS.ProcessEnv): Promise<GoogleDriveTokenFile> {
  if (!token.refresh_token) {
    throw new CxError(`Google Drive token at ${config.tokenFile} has no refresh_token; run OAuth setup again`, 1);
  }
  const client = await readOAuthClient(config.clientSecretFile);
  const body = new URLSearchParams();
  body.set('client_id', client.clientId);
  if (client.clientSecret) {
    body.set('client_secret', client.clientSecret);
  }
  body.set('refresh_token', token.refresh_token);
  body.set('grant_type', 'refresh_token');
  const parsed = await fetchJson(tokenUrl(env), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  }, 'refreshing Google Drive OAuth token');
  if (!isRecord(parsed) || typeof parsed.access_token !== 'string') {
    throw new CxError('Google OAuth refresh response did not contain access_token', 1);
  }
  const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
  const refreshed: GoogleDriveTokenFile = {
    ...token,
    ...parsed,
    refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : token.refresh_token,
    expiry_date: Date.now() + (expiresIn * 1000),
    version: GOOGLE_DRIVE_TOKEN_VERSION,
  };
  await writeFilePrivate(config.tokenFile, `${JSON.stringify(refreshed, null, 2)}\n`);
  return refreshed;
}

async function accessToken(config: GoogleDriveRemoteConfig, env: NodeJS.ProcessEnv): Promise<string> {
  const token = await readToken(config);
  if (typeof token.access_token === 'string' && (!token.expiry_date || token.expiry_date > Date.now() + 60_000)) {
    return token.access_token;
  }
  return (await refreshToken(config, token, env)).access_token ?? '';
}

function quoteDriveQuery(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'");
}

function fileName(config: GoogleDriveRemoteConfig, account: string): string {
  return `${config.filePrefix}${validateAccountName(account)}.json`;
}

function accountNameFromFileName(config: GoogleDriveRemoteConfig, name: string): string | null {
  if (!name.startsWith(config.filePrefix) || !name.endsWith('.json')) {
    return null;
  }
  const account = name.slice(config.filePrefix.length, -'.json'.length);
  try {
    const safeAccount = validateAccountName(account);
    return safeAccount === 'default' ? null : safeAccount;
  } catch {
    return null;
  }
}

function driveListParams(config: GoogleDriveRemoteConfig, name?: string): URLSearchParams {
  const params = new URLSearchParams();
  const clauses = ['trashed = false'];
  if (name) {
    clauses.push(`name = '${quoteDriveQuery(name)}'`);
  } else {
    clauses.push(`name contains '${quoteDriveQuery(config.filePrefix)}'`);
  }
  if (config.storage === 'folder') {
    clauses.push(`'${quoteDriveQuery(config.folderId ?? '')}' in parents`);
  } else {
    params.set('spaces', 'appDataFolder');
  }
  params.set('q', clauses.join(' and '));
  params.set('fields', 'files(id,name)');
  return params;
}

async function driveFetch(config: GoogleDriveRemoteConfig, env: NodeJS.ProcessEnv, path: string, init: RequestInit = {}, action = 'Google Drive request'): Promise<unknown> {
  const token = await accessToken(config, env);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return await fetchJson(`${apiBaseUrl(env)}${path}`, { ...init, headers }, action);
}

async function listFiles(config: GoogleDriveRemoteConfig, env: NodeJS.ProcessEnv, name?: string): Promise<GoogleDriveFileEntry[]> {
  const parsed = await driveFetch(config, env, `/drive/v3/files?${driveListParams(config, name).toString()}`, {}, 'listing Google Drive profile files');
  if (!isRecord(parsed) || !Array.isArray(parsed.files)) {
    throw new CxError('Google Drive file list response did not contain files[]', 1);
  }
  return parsed.files
    .map((entry): GoogleDriveFileEntry | null => {
      if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string') {
        return null;
      }
      return { id: entry.id, name: entry.name };
    })
    .filter((entry): entry is GoogleDriveFileEntry => entry !== null);
}

export async function listGoogleDriveAccountNames(config: GoogleDriveRemoteConfig, env: NodeJS.ProcessEnv): Promise<string[]> {
  return [...new Set((await listFiles(config, env))
    .map((entry) => accountNameFromFileName(config, entry.name))
    .filter((account): account is string => account !== null))]
    .sort((left, right) => left.localeCompare(right));
}

export async function googleDriveFileExists(config: GoogleDriveRemoteConfig, item: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return (await listFiles(config, env, item)).length > 0;
}

function encryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const key = env.CX_GDRIVE_ENCRYPTION_KEY;
  if (!key || key.length === 0) {
    throw new CxError('Google Drive backend encryption is enabled but CX_GDRIVE_ENCRYPTION_KEY is not set', 1);
  }
  return createHash('sha256').update(key).digest();
}

function encodeStoredAccount(config: GoogleDriveRemoteConfig, account: string, authJson: string, env: NodeJS.ProcessEnv): GoogleDriveStoredAccount {
  const metadata = buildRemoteAuthMetadata(account, authJson);
  if (config.encryption === 'env') {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(env), iv);
    const ciphertext = Buffer.concat([cipher.update(authJson, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      version: 1,
      account,
      metadata,
      encryptedAuthJson: {
        algorithm: 'aes-256-gcm',
        key: 'CX_GDRIVE_ENCRYPTION_KEY',
        iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: tag.toString('base64'),
      },
    };
  }
  return { version: 1, account, metadata, authJson };
}

function decodeStoredAccount(config: GoogleDriveRemoteConfig, body: string, item: string, env: NodeJS.ProcessEnv): { authJson: string; metadata: RemoteAuthMetadata | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (error) {
    throw new CxError(`Google Drive profile file '${item}' is not valid JSON: ${errorMessage(error)}`, 1);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.account !== 'string' || !isRecord(parsed.metadata)) {
    throw new CxError(`Google Drive profile file '${item}' has an invalid cx payload`, 1);
  }
  let authJson: string;
  if (typeof parsed.authJson === 'string') {
    authJson = parsed.authJson;
  } else if (isRecord(parsed.encryptedAuthJson)
    && parsed.encryptedAuthJson.algorithm === 'aes-256-gcm'
    && typeof parsed.encryptedAuthJson.iv === 'string'
    && typeof parsed.encryptedAuthJson.ciphertext === 'string'
    && typeof parsed.encryptedAuthJson.tag === 'string') {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(env), Buffer.from(parsed.encryptedAuthJson.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.encryptedAuthJson.tag, 'base64'));
    authJson = Buffer.concat([
      decipher.update(Buffer.from(parsed.encryptedAuthJson.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } else {
    throw new CxError(`Google Drive profile file '${item}' does not contain authJson or encryptedAuthJson`, 1);
  }
  parseAuthJsonString(authJson, `Google Drive profile file '${item}' authJson`);
  const metadata = parsed.metadata;
  const remoteMetadata: RemoteAuthMetadata | null = metadata.version === 1
    && metadata.account === parsed.account
    && typeof metadata.authJsonSha256 === 'string'
    && typeof metadata.updatedAt === 'string'
    ? {
      version: 1,
      account: parsed.account,
      authJsonSha256: metadata.authJsonSha256,
      updatedAt: metadata.updatedAt,
      ...(typeof metadata.deviceId === 'string' ? { deviceId: metadata.deviceId } : {}),
    }
    : null;
  return { authJson, metadata: remoteMetadata };
}

function multipartBody(metadata: Record<string, unknown>, media: string): { body: string; contentType: string } {
  const boundary = `cx-gdrive-${randomBytes(12).toString('hex')}`;
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    media,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

export async function upsertGoogleDriveAuthJson(
  config: GoogleDriveRemoteConfig,
  item: string,
  account: string,
  authJson: string,
  env: NodeJS.ProcessEnv,
): Promise<GoogleDriveUploadResult> {
  const stored = encodeStoredAccount(config, account, authJson, env);
  const media = `${JSON.stringify(stored, null, 2)}\n`;
  const parents = config.storage === 'appDataFolder' ? ['appDataFolder'] : [config.folderId ?? ''];
  const existing = (await listFiles(config, env, item))[0];
  const part = multipartBody({ name: item, parents }, media);
  if (existing) {
    await driveFetch(config, env, `/upload/drive/v3/files/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=id,name`, {
      method: 'PATCH',
      headers: { 'content-type': part.contentType },
      body: part.body,
    }, `updating Google Drive profile file '${item}'`);
    return { operation: 'updated', metadata: stored.metadata };
  }
  await driveFetch(config, env, '/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST',
    headers: { 'content-type': part.contentType },
    body: part.body,
  }, `creating Google Drive profile file '${item}'`);
  return { operation: 'created', metadata: stored.metadata };
}

export async function readGoogleDriveAccount(
  config: GoogleDriveRemoteConfig,
  item: string,
  env: NodeJS.ProcessEnv,
): Promise<{ authJson: string; metadata: RemoteAuthMetadata | null }> {
  const existing = (await listFiles(config, env, item))[0];
  if (!existing) {
    throw new CxError(`remote account file '${item}' was not found in Google Drive`, 1);
  }
  const token = await accessToken(config, env);
  const response = await fetch(`${apiBaseUrl(env)}/drive/v3/files/${encodeURIComponent(existing.id)}?alt=media`, {
    headers: { authorization: `Bearer ${token}`, connection: 'close' },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new CxError(`reading Google Drive profile file '${item}' failed: HTTP ${response.status}; ${body.slice(0, 500)}`, 1);
  }
  return decodeStoredAccount(config, body, item, env);
}

export function googleDriveItemName(config: GoogleDriveRemoteConfig, account: string): string {
  return fileName(config, account);
}
