import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { constants as fsConstants, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

export const AUTH_NON_EMPTY_BYTES = 100;
export const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;
export const CODEX_TIMEOUT_EXIT_CODE = 124;
export const CODEX_RATE_LIMIT_EXIT_CODE = 75;
export const PROFILE_LOCK_FILE = '.cx-profile.lock';
export const APP_SERVER_CONTROL_SOCKET = join('app-server-control', 'app-server-control.sock');

export interface CodexPaths {
  readonly home: string;
  readonly accountsDir: string;
  readonly currentFile: string;
  readonly authFile: string;
}

export interface OperationOptions {
  readonly paths?: CodexPaths;
  /** @deprecated Stable profile homes never write back from shared auth.json. */
  readonly skipWriteback?: boolean;
}

export interface ForceOptions extends OperationOptions {
  readonly force?: boolean;
}

export interface SpawnCodexOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stdin?: 'inherit' | 'ignore';
  readonly timeoutSeconds?: number;
}

export interface LoginAccountOptions extends ForceOptions, SpawnCodexOptions {
  readonly loginArgs?: readonly string[];
}

export interface AccountEntry {
  readonly name: string;
  readonly file: string;
  readonly home: string;
  readonly active: boolean;
}

export type CurrentMarker =
  | { readonly state: 'missing' }
  | { readonly state: 'valid'; readonly name: string }
  | { readonly state: 'invalid'; readonly raw: string; readonly reason: string };

export interface AccountList {
  readonly home: string;
  readonly accountsDir: string;
  readonly current: string | null;
  readonly currentMarker: CurrentMarker;
  readonly accounts: readonly AccountEntry[];
}

export interface WritebackResult {
  readonly performed: boolean;
  readonly reason?: string;
  readonly account?: string;
}

export interface RenameResult {
  readonly oldName: string;
  readonly newName: string;
  readonly overwrote: boolean;
  readonly currentUpdated: boolean;
}

export interface RemoveResult {
  readonly name: string;
  readonly wasActive: boolean;
}

export interface DoctorReport {
  readonly packageName: string;
  readonly version: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly codexHome: string;
  readonly accountsDir: string;
  readonly homeExists: boolean;
  readonly accountsDirExists: boolean;
  readonly authJson: {
    readonly exists: boolean;
    readonly size: number;
    readonly looksNonEmpty: boolean;
  };
  readonly current: {
    readonly state: CurrentMarker['state'];
    readonly name: string | null;
    readonly slotExists: boolean;
    readonly reason?: string;
  };
  readonly accounts: readonly string[];
  readonly profiles: readonly {
    readonly name: string;
    readonly home: string;
    readonly authFile: string;
    readonly authSize: number;
    readonly configFile: string;
    readonly fileCredentialStore: boolean;
    readonly appServerSocket: string;
    readonly appServerSocketExists: boolean;
  }[];
  readonly codexExecutable: string | null;
  readonly warnings: readonly string[];
}

export class CxError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CxError';
    this.exitCode = exitCode;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function authAccountId(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null || !('tokens' in parsed)) {
    return null;
  }
  const tokens = (parsed as { readonly tokens?: unknown }).tokens;
  if (typeof tokens !== 'object' || tokens === null || !('account_id' in tokens)) {
    return null;
  }
  const accountId = (tokens as { readonly account_id?: unknown }).account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
}

function parseAuthJsonForWriteback(raw: string): { parsed: unknown; accountId: string | null } {
  const parsed = JSON.parse(raw) as unknown;
  return { parsed, accountId: authAccountId(parsed) };
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

async function ensureCodexStoreDirs(paths: CodexPaths): Promise<void> {
  await ensurePrivateDir(paths.home);
  await ensurePrivateDir(paths.accountsDir);
}

async function copyFilePrivate(source: string, destination: string): Promise<void> {
  await writeFilePrivate(destination, await readFile(source));
}

async function writeFilePrivate(destination: string, contents: string | Uint8Array): Promise<void> {
  await ensurePrivateDir(dirname(destination));
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, destination);
    await chmodIfPossible(destination, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function getCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME;
  if (configured && configured.trim().length > 0) {
    return resolve(configured);
  }
  return join(homedir(), '.codex');
}

export function getCodexPaths(env: NodeJS.ProcessEnv = process.env): CodexPaths {
  const home = getCodexHome(env);
  return {
    home,
    accountsDir: join(home, 'accounts'),
    currentFile: join(home, '.current-account'),
    authFile: join(home, 'auth.json'),
  };
}

export function accountHomeForName(paths: CodexPaths, name: string): string {
  const safeName = validateAccountName(name);
  const accountsRoot = resolve(paths.accountsDir);
  const accountHome = resolve(accountsRoot, safeName);
  const relativePath = relative(accountsRoot, accountHome);

  if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new CxError('invalid account name: resolved outside accounts directory', 2);
  }
  return accountHome;
}

export function validateAccountName(name: string): string {
  if (name.length === 0) {
    throw new CxError('invalid account name: account name must not be empty', 2);
  }
  if (/^\.+$/u.test(name)) {
    throw new CxError('invalid account name: account name must not be only dots', 2);
  }
  if (!ACCOUNT_NAME_PATTERN.test(name)) {
    throw new CxError('invalid account name: use only letters, numbers, dot, underscore, and dash', 2);
  }
  return name;
}

export function accountPathForName(paths: CodexPaths, name: string): string {
  return join(accountHomeForName(paths, name), 'auth.json');
}

function legacyAccountPathForName(paths: CodexPaths, name: string): string {
  return join(paths.accountsDir, `${validateAccountName(name)}.json`);
}

function archivedLegacyAccountPathForName(paths: CodexPaths, name: string): string {
  return join(paths.accountsDir, '.legacy-v0.3', `${validateAccountName(name)}.json`);
}

function pinFileCredentialStore(config: string): string {
  const setting = 'cli_auth_credentials_store = "file"';
  if (/^\s*cli_auth_credentials_store\s*=/mu.test(config)) {
    return config.replace(/^\s*cli_auth_credentials_store\s*=.*$/gmu, setting);
  }
  return `${setting}\n${config}`;
}

async function ensureProfileConfig(paths: CodexPaths, name: string): Promise<void> {
  const profileConfig = join(accountHomeForName(paths, name), 'config.toml');
  if (await pathExists(profileConfig)) {
    const current = await readFile(profileConfig, 'utf8');
    const pinned = pinFileCredentialStore(current);
    if (pinned !== current) {
      await writeFilePrivate(profileConfig, pinned);
    }
    return;
  }
  let base = '';
  try {
    base = await readFile(join(paths.home, 'config.toml'), 'utf8');
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
  await writeFilePrivate(profileConfig, pinFileCredentialStore(base));
}

async function migrateLegacyAccount(paths: CodexPaths, name: string): Promise<boolean> {
  const destination = accountPathForName(paths, name);
  if (await pathExists(destination)) {
    await ensureProfileConfig(paths, name);
    return false;
  }
  const legacy = legacyAccountPathForName(paths, name);
  if (!(await pathExists(legacy))) {
    return false;
  }
  let source = legacy;
  const marker = await readCurrentMarker(paths);
  if (marker.state === 'valid' && marker.name === name && await authLooksNonEmpty(paths)) {
    try {
      const [legacyRaw, liveRaw] = await Promise.all([
        readFile(legacy, 'utf8'),
        readFile(paths.authFile, 'utf8'),
      ]);
      const legacyId = parseAuthJsonForWriteback(legacyRaw).accountId;
      const liveId = parseAuthJsonForWriteback(liveRaw).accountId;
      if (legacyId && liveId && legacyId === liveId) {
        source = paths.authFile;
      }
    } catch {
      // Preserve the known legacy slot when the live file cannot be verified.
    }
  }
  await ensurePrivateDir(accountHomeForName(paths, name));
  await copyFilePrivate(source, destination);
  await ensureProfileConfig(paths, name);
  const preferredArchive = archivedLegacyAccountPathForName(paths, name);
  await ensurePrivateDir(dirname(preferredArchive));
  const archive = await pathExists(preferredArchive)
    ? join(dirname(preferredArchive), `${name}.${Date.now()}.${randomBytes(4).toString('hex')}.json`)
    : preferredArchive;
  await rename(legacy, archive);
  await chmodIfPossible(archive, 0o600);
  return true;
}

async function ensureAccountAvailable(paths: CodexPaths, name: string): Promise<string> {
  const safeName = validateAccountName(name);
  await migrateLegacyAccount(paths, safeName);
  const accountFile = accountPathForName(paths, safeName);
  if (!(await pathExists(accountFile))) {
    throw new CxError(`no account '${safeName}'`, 1);
  }
  return accountFile;
}

export async function authFileExists(paths: CodexPaths = getCodexPaths()): Promise<boolean> {
  const stats = await statIfExists(paths.authFile);
  return stats?.isFile() ?? false;
}

export async function authLooksNonEmpty(paths: CodexPaths = getCodexPaths()): Promise<boolean> {
  const stats = await statIfExists(paths.authFile);
  return Boolean(stats?.isFile() && stats.size > AUTH_NON_EMPTY_BYTES);
}

export async function readCurrentMarker(paths: CodexPaths = getCodexPaths()): Promise<CurrentMarker> {
  let raw: string;
  try {
    raw = await readFile(paths.currentFile, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return { state: 'missing' };
    }
    throw error;
  }

  const marker = raw.trim();
  try {
    return { state: 'valid', name: validateAccountName(marker) };
  } catch (error) {
    return {
      state: 'invalid',
      raw: marker,
      reason: errorMessage(error),
    };
  }
}

async function writeCurrentMarker(paths: CodexPaths, name: string): Promise<void> {
  await writeFilePrivate(paths.currentFile, `${validateAccountName(name)}\n`);
}

async function clearCurrentMarker(paths: CodexPaths): Promise<void> {
  await rm(paths.currentFile, { force: true });
}

export async function listAccountNames(paths: CodexPaths = getCodexPaths()): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(paths.accountsDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      try {
        const candidate = validateAccountName(entry.name);
        if (await pathExists(accountPathForName(paths, candidate))) {
          names.add(candidate);
        }
      } catch {
        // Ignore directories that cannot be addressed safely.
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.json')) {
      const candidate = entry.name.slice(0, -'.json'.length);
      try {
        const safeName = validateAccountName(candidate);
        await migrateLegacyAccount(paths, safeName);
        names.add(safeName);
      } catch {
        // Ignore legacy or manually-created files that cannot be addressed safely.
      }
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export async function listAccounts(paths: CodexPaths = getCodexPaths()): Promise<AccountList> {
  const [names, currentMarker] = await Promise.all([
    listAccountNames(paths),
    readCurrentMarker(paths),
  ]);
  const nameSet = new Set(names);
  const current = currentMarker.state === 'valid' && nameSet.has(currentMarker.name)
    ? currentMarker.name
    : null;
  const accounts = names.map((name) => ({
    name,
    file: accountPathForName(paths, name),
    home: accountHomeForName(paths, name),
    active: name === current,
  }));

  return {
    home: paths.home,
    accountsDir: paths.accountsDir,
    current,
    currentMarker,
    accounts,
  };
}

/** @deprecated Stable profile homes do not use shared auth writeback. Retained for legacy migration. */
export async function writebackCurrentAccount(options: OperationOptions = {}): Promise<WritebackResult> {
  const paths = options.paths ?? getCodexPaths();
  const current = await readCurrentMarker(paths);

  if (current.state === 'missing') {
    return { performed: false, reason: 'no current account marker' };
  }
  if (current.state === 'invalid') {
    return { performed: false, reason: 'current account marker is invalid' };
  }

  const migrated = await migrateLegacyAccount(paths, current.name);
  if (migrated) {
    return { performed: true, reason: 'migrated legacy active credentials into the stable profile home', account: current.name };
  }
  if (!(await pathExists(accountPathForName(paths, current.name)))) {
    return { performed: false, reason: 'current account slot no longer exists', account: current.name };
  }
  return {
    performed: false,
    reason: 'stable profile homes do not write back from shared auth.json',
    account: current.name,
  };
}

/** @deprecated Copying a live OAuth file creates a second writer. Prefer loginAccount. */
export async function saveAccount(name: string, options: ForceOptions = {}): Promise<void> {
  const paths = options.paths ?? getCodexPaths();
  const safeName = validateAccountName(name);
  const destination = accountPathForName(paths, safeName);

  if (!(await authLooksNonEmpty(paths))) {
    throw new CxError(`no usable ${paths.authFile} found (run 'codex login' first)`, 1);
  }
  await withAccountLock(paths, safeName, async () => {
    if ((await pathExists(destination)) && options.force !== true) {
      throw new CxError(`account '${safeName}' already exists (use --force to overwrite)`, 1);
    }
    await ensureCodexStoreDirs(paths);
    await copyFilePrivate(paths.authFile, destination);
    await ensureProfileConfig(paths, safeName);
    await writeCurrentMarker(paths, safeName);
  });
}

export async function useAccount(name: string, options: OperationOptions = {}): Promise<WritebackResult> {
  const paths = options.paths ?? getCodexPaths();
  const safeName = validateAccountName(name);
  await ensureAccountAvailable(paths, safeName);
  await ensureProfileConfig(paths, safeName);
  await writeCurrentMarker(paths, safeName);
  return {
    performed: false,
    reason: 'selected stable profile without changing shared auth.json',
    account: safeName,
  };
}

export async function renameAccount(
  oldName: string,
  newName: string,
  options: ForceOptions = {},
): Promise<RenameResult> {
  const paths = options.paths ?? getCodexPaths();
  const safeOldName = validateAccountName(oldName);
  const safeNewName = validateAccountName(newName);

  if (safeOldName === safeNewName) {
    throw new CxError('old and new account names must differ', 2);
  }

  await ensureAccountAvailable(paths, safeOldName);
  const source = accountHomeForName(paths, safeOldName);
  const destination = accountHomeForName(paths, safeNewName);
  const destinationExists = await pathExists(accountPathForName(paths, safeNewName));
  if (destinationExists && options.force !== true) {
    throw new CxError(`account '${safeNewName}' already exists (use --force to overwrite)`, 1);
  }

  const releaseSource = await acquireProfileLock(source, safeOldName);
  let releaseDestination: (() => Promise<void>) | null = null;
  let completed = false;
  try {
    if (destinationExists) {
      releaseDestination = await acquireProfileLock(destination, safeNewName);
    }
    await ensurePrivateDir(paths.accountsDir);
    if (destinationExists) {
      await rm(destination, { recursive: true, force: true });
    }
    await rename(source, destination);
    await rm(join(destination, PROFILE_LOCK_FILE), { force: true });
    await chmodIfPossible(destination, 0o700);
    completed = true;
  } finally {
    if (!completed) {
      await releaseDestination?.().catch(() => undefined);
      await releaseSource().catch(() => undefined);
    }
  }

  const marker = await readCurrentMarker(paths);
  const currentUpdated = marker.state === 'valid' && marker.name === safeOldName;
  if (currentUpdated) {
    await writeCurrentMarker(paths, safeNewName);
  }

  return {
    oldName: safeOldName,
    newName: safeNewName,
    overwrote: destinationExists,
    currentUpdated,
  };
}

export async function removeAccount(name: string, options: OperationOptions = {}): Promise<RemoveResult> {
  const paths = options.paths ?? getCodexPaths();
  const safeName = validateAccountName(name);
  await ensureAccountAvailable(paths, safeName);
  const accountHome = accountHomeForName(paths, safeName);

  const marker = await readCurrentMarker(paths);
  const wasActive = marker.state === 'valid' && marker.name === safeName;

  const releaseLock = await acquireProfileLock(accountHome, safeName);
  let removed = false;
  try {
    await rm(accountHome, { recursive: true, force: false });
    removed = true;
  } finally {
    if (!removed) {
      await releaseLock().catch(() => undefined);
    }
  }
  if (wasActive) {
    await clearCurrentMarker(paths);
  }

  return { name: safeName, wasActive };
}

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') {
    return 130;
  }
  if (signal === 'SIGTERM') {
    return 143;
  }
  return 1;
}

function stderrLooksQuotaLimited(stderr: string): boolean {
  return /(?:usage limit|rate limit|quota|too many requests|\b429\b|limit reached)/iu.test(stderr);
}

function terminateChildProcessGroup(child: ReturnType<typeof spawn>): void {
  if (!child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } catch {
      child.kill('SIGTERM');
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function killChildProcessGroup(child: ReturnType<typeof spawn>): void {
  if (!child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

interface CodexSpawnSpec {
  readonly command: string;
  readonly args: string[];
  readonly windowsVerbatimArguments?: boolean;
}

function quoteWindowsShellPart(value: string): string {
  const escaped = value
    .replace(/(\\*)"/gu, '$1$1\\"')
    .replace(/\\+$/u, '$&$&')
    .replace(/([()%!^&|<>])/gu, '^$1');
  if (escaped.length === 0 || /[\s()[\]{}^=;!'+,`&|<>"]/u.test(value)) {
    return `"${escaped}"`;
  }
  return escaped;
}

function codexSpawnCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): CodexSpawnSpec {
  if (process.platform !== 'win32') {
    return { command, args: [...args] };
  }

  const commandPart = quoteWindowsShellPart(command);
  const commandLineBody = [commandPart, ...args.map(quoteWindowsShellPart)].join(' ');
  const commandLine = commandPart.startsWith('"') ? `"${commandLineBody}"` : commandLineBody;
  return {
    command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/v:off', '/c', commandLine],
    windowsVerbatimArguments: true,
  };
}

export async function runCodex(
  codexArgs: readonly string[] = [],
  options: SpawnCodexOptions = {},
): Promise<number> {
  const command = options.command ?? 'codex';
  const args = [...(options.args ?? codexArgs)];
  const env = options.env ?? process.env;
  const stdinMode = options.stdin ?? (process.stdin.isTTY ? 'inherit' : 'ignore');
  const timeoutSeconds = options.timeoutSeconds;
  const timeoutMs = timeoutSeconds === undefined ? undefined : Math.max(1, Math.floor(timeoutSeconds * 1000));
  const detached = timeoutMs !== undefined && process.platform !== 'win32';

  return await new Promise((resolvePromise, reject) => {
    let stderrTail = '';
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    const spawnSpec = codexSpawnCommand(command, args, env);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: options.cwd,
      env,
      stdio: [stdinMode, 'inherit', 'pipe'],
      windowsHide: false,
      windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
      detached,
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      process.stderr.write(text);
      stderrTail = `${stderrTail}${text}`.slice(-65_536);
    });

    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        process.stderr.write(`cx: codex timed out after ${timeoutSeconds} seconds; terminating process group\n`);
        terminateChildProcessGroup(child);
        killTimeout = setTimeout(() => killChildProcessGroup(child), 2_000);
      }, timeoutMs);
    }

    child.on('error', (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (killTimeout) {
        clearTimeout(killTimeout);
      }
      reject(new CxError(`failed to run '${command}': ${error.message}`, 1));
    });
    child.on('exit', (code, signal) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (killTimeout) {
        clearTimeout(killTimeout);
      }
      if (timedOut) {
        resolvePromise(CODEX_TIMEOUT_EXIT_CODE);
        return;
      }
      const exitCode = typeof code === 'number' ? code : (signal ? signalExitCode(signal) : 1);
      if (exitCode !== 0 && stderrLooksQuotaLimited(stderrTail)) {
        resolvePromise(CODEX_RATE_LIMIT_EXIT_CODE);
        return;
      }
      resolvePromise(exitCode);
    });
  });
}

export interface IsolatedRunResult {
  readonly exitCode: number;
  readonly account: string;
  readonly authUpdated: boolean;
}

interface ProfileLockPayload {
  readonly pid: number;
  readonly nonce: string;
  readonly acquiredAt: string;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    return code === 'EPERM';
  }
}

async function readProfileLock(lockFile: string): Promise<ProfileLockPayload | null> {
  try {
    const parsed = JSON.parse(await readFile(lockFile, 'utf8')) as Partial<ProfileLockPayload>;
    if (typeof parsed.pid === 'number'
      && typeof parsed.nonce === 'string'
      && typeof parsed.acquiredAt === 'string') {
      return { pid: parsed.pid, nonce: parsed.nonce, acquiredAt: parsed.acquiredAt };
    }
  } catch {
    // An unreadable lock is treated as stale and removed by the acquirer.
  }
  return null;
}

async function acquireProfileLock(profileHome: string, account: string): Promise<() => Promise<void>> {
  await ensurePrivateDir(profileHome);
  const lockFile = join(profileHome, PROFILE_LOCK_FILE);
  const payload: ProfileLockPayload = {
    pid: process.pid,
    nonce: randomBytes(12).toString('hex'),
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockFile, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(payload)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        const current = await readProfileLock(lockFile);
        if (current?.nonce === payload.nonce) {
          await rm(lockFile, { force: true });
        }
      };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code !== 'EEXIST') {
        throw error;
      }
      const existing = await readProfileLock(lockFile);
      if (existing && processIsAlive(existing.pid)) {
        throw new CxError(
          `account '${account}' is already in use by cx process ${existing.pid} since ${existing.acquiredAt}; use a separately logged-in worker profile for concurrent runs`,
          1,
        );
      }
      await rm(lockFile, { force: true });
    }
  }
  throw new CxError(`could not acquire the profile lock for account '${account}'`, 1);
}

export async function withAccountLock<T>(
  paths: CodexPaths,
  account: string,
  operation: () => Promise<T>,
): Promise<T> {
  const safeAccount = validateAccountName(account);
  const releaseLock = await acquireProfileLock(accountHomeForName(paths, safeAccount), safeAccount);
  try {
    return await operation();
  } finally {
    await releaseLock();
  }
}

export async function runCodexWithIsolatedAccount(
  name: string,
  codexArgs: readonly string[] = [],
  options: OperationOptions & SpawnCodexOptions = {},
): Promise<IsolatedRunResult> {
  const env = options.env ?? process.env;
  const { paths: _ignoredPaths, skipWriteback: _ignoredSkipWriteback, ...spawnOptions } = options;
  const paths = options.paths ?? getCodexPaths(env);
  const safeName = validateAccountName(name);
  const accountFile = await ensureAccountAvailable(paths, safeName);
  const profileHome = accountHomeForName(paths, safeName);
  const releaseLock = await acquireProfileLock(profileHome, safeName);
  try {
    await ensureProfileConfig(paths, safeName);
    const before = await readFile(accountFile, 'utf8');
    parseAuthJsonForWriteback(before);
    const profileEnv = { ...env, CODEX_HOME: profileHome };
    const exitCode = await runCodex(codexArgs, {
      ...spawnOptions,
      env: profileEnv,
    });
    const after = await readFile(accountFile, 'utf8');
    parseAuthJsonForWriteback(after);
    const authUpdated = after !== before;
    return { exitCode, account: safeName, authUpdated };
  } finally {
    await releaseLock();
  }
}

export async function loginAccount(
  name: string,
  options: LoginAccountOptions = {},
): Promise<WritebackResult> {
  const paths = options.paths ?? getCodexPaths(options.env ?? process.env);
  const env = options.env ?? process.env;
  const safeName = validateAccountName(name);
  const destination = accountPathForName(paths, safeName);
  const legacy = legacyAccountPathForName(paths, safeName);

  if (((await pathExists(destination)) || (await pathExists(legacy))) && options.force !== true) {
    throw new CxError(`account '${safeName}' already exists (use --force to overwrite)`, 1);
  }

  if (await pathExists(legacy)) {
    await migrateLegacyAccount(paths, safeName);
  }
  await ensurePrivateDir(accountHomeForName(paths, safeName));
  await ensureProfileConfig(paths, safeName);
  const appServerSocket = join(accountHomeForName(paths, safeName), APP_SERVER_CONTROL_SOCKET);
  if (await pathExists(appServerSocket)) {
    throw new CxError(
      `profile '${safeName}' has an app-server control socket at ${appServerSocket}; stop the Codex app-server using this profile before logging in, then remove the stale socket only after its process has stopped`,
      1,
    );
  }
  const releaseLock = await acquireProfileLock(accountHomeForName(paths, safeName), safeName);
  try {
    const { paths: _ignoredPaths, skipWriteback: _ignoredSkipWriteback, ...spawnOptions } = options;
    const loginExitCode = await runCodex([], {
      ...spawnOptions,
      env: { ...env, CODEX_HOME: accountHomeForName(paths, safeName) },
      args: ['login', ...(options.loginArgs ?? [])],
    });

    if (loginExitCode !== 0) {
      throw new CxError(`codex login exited with code ${loginExitCode}`, loginExitCode);
    }
    const stats = await statIfExists(destination);
    if (!stats?.isFile() || stats.size <= AUTH_NON_EMPTY_BYTES) {
      throw new CxError(`codex login did not leave a usable ${destination}`, 1);
    }
    parseAuthJsonForWriteback(await readFile(destination, 'utf8'));
    await writeCurrentMarker(paths, safeName);
    return {
      performed: false,
      reason: 'logged in directly to the stable profile home',
      account: safeName,
    };
  } finally {
    await releaseLock();
  }
}

export async function switchAndRunCodex(
  name: string,
  codexArgs: readonly string[] = [],
  options: OperationOptions & SpawnCodexOptions = {},
): Promise<number> {
  const paths = options.paths ?? getCodexPaths(options.env ?? process.env);
  await useAccount(name, { paths });
  return (await runCodexWithIsolatedAccount(name, codexArgs, options)).exitCode;
}

async function executableAccess(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEnvValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? '';
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

export async function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (hasPathSeparator(command)) {
    const absolute = resolve(command);
    return await executableAccess(absolute) ? absolute : null;
  }

  const extensions = process.platform === 'win32'
    ? ['', '.cmd', '.exe', '.bat']
    : [''];
  const pathEntries = pathEnvValue(env).split(delimiter).filter((entry) => entry.length > 0);

  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (await executableAccess(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export async function inspectDoctor(
  metadata: { readonly packageName: string; readonly version: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorReport> {
  const paths = getCodexPaths(env);
  // Legacy account discovery can migrate files, so observe directory state after it completes.
  const accountNames = await listAccountNames(paths);
  const [homeStats, accountsDirStats, authStats, marker, codexExecutable, remoteConfigStats] = await Promise.all([
    statIfExists(paths.home),
    statIfExists(paths.accountsDir),
    statIfExists(paths.authFile),
    readCurrentMarker(paths),
    resolveExecutable('codex', env),
    statIfExists(join(paths.home, 'remote.json')),
  ]);

  const profiles = await Promise.all(accountNames.map(async (name) => {
    const home = accountHomeForName(paths, name);
    const authFile = accountPathForName(paths, name);
    const configFile = join(home, 'config.toml');
    const appServerSocket = join(home, APP_SERVER_CONTROL_SOCKET);
    const [profileAuthStats, configText, appServerSocketStats] = await Promise.all([
      statIfExists(authFile),
      readFile(configFile, 'utf8').catch((error: unknown) => {
        if (isNotFoundError(error)) {
          return '';
        }
        throw error;
      }),
      statIfExists(appServerSocket),
    ]);
    return {
      name,
      home,
      authFile,
      authSize: profileAuthStats?.isFile() ? profileAuthStats.size : 0,
      configFile,
      fileCredentialStore: /^\s*cli_auth_credentials_store\s*=\s*["']file["']\s*$/mu.test(configText),
      appServerSocket,
      appServerSocketExists: appServerSocketStats !== null,
    };
  }));

  let slotExists = false;
  let currentName: string | null = null;
  let currentReason: string | undefined;
  if (marker.state === 'valid') {
    currentName = marker.name;
    slotExists = await pathExists(accountPathForName(paths, marker.name));
    if (!slotExists) {
      currentReason = 'current account slot is missing';
    }
  } else if (marker.state === 'invalid') {
    currentReason = marker.reason;
  }

  const authSize = authStats?.isFile() ? authStats.size : 0;
  const warnings: string[] = [];
  if (!authStats?.isFile() && accountNames.length === 0) {
    warnings.push('no named profiles or shared auth.json exist; run cx login <name> --device-auth.');
  } else if (authSize <= AUTH_NON_EMPTY_BYTES) {
    if (authStats?.isFile()) {
      warnings.push('shared auth.json exists but is too small to be treated as a usable legacy login.');
    }
  } else {
    warnings.push('shared root auth.json is a legacy fallback; named profiles do not read or update it.');
  }
  for (const profile of profiles) {
    if (profile.authSize <= AUTH_NON_EMPTY_BYTES) {
      warnings.push(`profile '${profile.name}' auth.json is too small to be a usable login.`);
    }
    if (!profile.fileCredentialStore) {
      warnings.push(`profile '${profile.name}' is not pinned to cli_auth_credentials_store = "file"; launching it through cx will repair this.`);
    }
    if (profile.appServerSocketExists) {
      warnings.push(`profile '${profile.name}' has a Codex app-server control socket; if /status shows the wrong account, stop that profile's app-server before logging in again.`);
    }
  }
  if (remoteConfigStats?.isFile()) {
    warnings.push('legacy remote credential sync is configured but push, pull, and automatic sync are disabled by default.');
  }
  if (marker.state === 'invalid') {
    warnings.push('current account marker is invalid; writeback will be skipped until it is fixed.');
  }
  if (marker.state === 'valid' && !slotExists) {
    warnings.push('current account marker points at a missing slot; writeback will not recreate it.');
  }
  if (!codexExecutable) {
    warnings.push('codex executable was not found on PATH.');
  }

  return {
    packageName: metadata.packageName,
    version: metadata.version,
    nodeVersion: process.version,
    platform: process.platform,
    codexHome: paths.home,
    accountsDir: paths.accountsDir,
    homeExists: Boolean(homeStats?.isDirectory()),
    accountsDirExists: Boolean(accountsDirStats?.isDirectory()),
    authJson: {
      exists: Boolean(authStats?.isFile()),
      size: authSize,
      looksNonEmpty: authSize > AUTH_NON_EMPTY_BYTES,
    },
    current: {
      state: marker.state,
      name: currentName,
      slotExists,
      ...(currentReason ? { reason: currentReason } : {}),
    },
    accounts: accountNames,
    profiles,
    codexExecutable,
    warnings,
  };
}
