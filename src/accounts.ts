import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants, type Stats } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import {
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

export interface CodexPaths {
  readonly home: string;
  readonly accountsDir: string;
  readonly currentFile: string;
  readonly authFile: string;
}

export interface OperationOptions {
  readonly paths?: CodexPaths;
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
  await ensurePrivateDir(dirname(destination));
  await copyFile(source, destination);
  await chmodIfPossible(destination, 0o600);
}

async function writeFilePrivate(destination: string, contents: string): Promise<void> {
  await ensurePrivateDir(dirname(destination));
  await writeFile(destination, contents, { mode: 0o600 });
  await chmodIfPossible(destination, 0o600);
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
  const safeName = validateAccountName(name);
  const accountsRoot = resolve(paths.accountsDir);
  const accountFile = resolve(accountsRoot, `${safeName}.json`);
  const relativePath = relative(accountsRoot, accountFile);

  if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new CxError('invalid account name: resolved outside accounts directory', 2);
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

  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const candidate = entry.name.slice(0, -'.json'.length);
    try {
      names.push(validateAccountName(candidate));
    } catch {
      // Ignore legacy or manually-created files that cannot be addressed safely.
    }
  }
  return names.sort((left, right) => left.localeCompare(right));
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

export async function writebackCurrentAccount(options: OperationOptions = {}): Promise<WritebackResult> {
  const paths = options.paths ?? getCodexPaths();
  const current = await readCurrentMarker(paths);

  if (current.state === 'missing') {
    return { performed: false, reason: 'no current account marker' };
  }
  if (current.state === 'invalid') {
    return { performed: false, reason: 'current account marker is invalid' };
  }

  const slot = accountPathForName(paths, current.name);
  if (!(await pathExists(slot))) {
    return { performed: false, reason: 'current account slot no longer exists', account: current.name };
  }
  if (!(await authLooksNonEmpty(paths))) {
    return { performed: false, reason: 'live auth.json is missing or too small', account: current.name };
  }

  let liveAuthJson: string;
  let liveAccountId: string | null;
  try {
    liveAuthJson = await readFile(paths.authFile, 'utf8');
    liveAccountId = parseAuthJsonForWriteback(liveAuthJson).accountId;
  } catch {
    return { performed: false, reason: 'live auth.json is not valid JSON', account: current.name };
  }

  if (liveAccountId) {
    try {
      const slotAuthJson = await readFile(slot, 'utf8');
      const slotAccountId = parseAuthJsonForWriteback(slotAuthJson).accountId;
      if (slotAccountId && slotAccountId !== liveAccountId) {
        return { performed: false, reason: 'live auth.json account_id does not match current account slot', account: current.name };
      }
    } catch {
      return { performed: false, reason: 'current account slot is not valid JSON', account: current.name };
    }
  }

  await writeFilePrivate(slot, liveAuthJson);
  return { performed: true, account: current.name };
}

export async function saveAccount(name: string, options: ForceOptions = {}): Promise<void> {
  const paths = options.paths ?? getCodexPaths();
  const safeName = validateAccountName(name);
  const destination = accountPathForName(paths, safeName);

  if (!(await authLooksNonEmpty(paths))) {
    throw new CxError(`no usable ${paths.authFile} found (run 'codex login' first)`, 1);
  }
  if ((await pathExists(destination)) && options.force !== true) {
    throw new CxError(`account '${safeName}' already exists (use --force to overwrite)`, 1);
  }

  await ensureCodexStoreDirs(paths);
  await copyFilePrivate(paths.authFile, destination);
  await writeCurrentMarker(paths, safeName);
}

export async function useAccount(name: string, options: OperationOptions = {}): Promise<WritebackResult> {
  const paths = options.paths ?? getCodexPaths();
  const safeName = validateAccountName(name);
  const source = accountPathForName(paths, safeName);

  if (!(await pathExists(source))) {
    throw new CxError(`no account '${safeName}'`, 1);
  }

  const writeback = options.skipWriteback === true
    ? { performed: false, reason: 'writeback skipped by caller' }
    : await writebackCurrentAccount({ paths });
  await copyFilePrivate(source, paths.authFile);
  await writeCurrentMarker(paths, safeName);
  return writeback;
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

  const source = accountPathForName(paths, safeOldName);
  const destination = accountPathForName(paths, safeNewName);
  const destinationExists = await pathExists(destination);

  if (!(await pathExists(source))) {
    throw new CxError(`no account '${safeOldName}'`, 1);
  }
  if (destinationExists && options.force !== true) {
    throw new CxError(`account '${safeNewName}' already exists (use --force to overwrite)`, 1);
  }

  await ensurePrivateDir(paths.accountsDir);
  if (destinationExists) {
    await rm(destination, { force: true });
  }
  await rename(source, destination);
  await chmodIfPossible(destination, 0o600);

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
  const accountFile = accountPathForName(paths, safeName);

  if (!(await pathExists(accountFile))) {
    throw new CxError(`no account '${safeName}'`, 1);
  }

  const marker = await readCurrentMarker(paths);
  const wasActive = marker.state === 'valid' && marker.name === safeName;

  await rm(accountFile, { force: false });
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: [stdinMode, 'inherit', 'pipe'],
      windowsHide: false,
      shell: process.platform === 'win32',
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

async function copyOptionalFilePrivate(source: string, destination: string): Promise<void> {
  if (await pathExists(source)) {
    await copyFilePrivate(source, destination);
  }
}

async function copyIsolatedAuthBack(accountFile: string, isolatedPaths: CodexPaths): Promise<boolean> {
  if (!(await authLooksNonEmpty(isolatedPaths))) {
    return false;
  }
  const original = await readFile(accountFile, 'utf8');
  const updated = await readFile(isolatedPaths.authFile, 'utf8');
  let originalAccountId: string | null = null;
  const updatedAccountId = parseAuthJsonForWriteback(updated).accountId;
  try {
    originalAccountId = parseAuthJsonForWriteback(original).accountId;
  } catch {
    // Older saved fixtures/formats may not be parseable for account_id checks;
    // still require the isolated child auth to be valid JSON before writeback.
  }
  if (originalAccountId && updatedAccountId && originalAccountId !== updatedAccountId) {
    throw new CxError('isolated codex run produced auth.json for a different account_id; refusing to update account slot', 1);
  }
  if (updated === original) {
    return false;
  }
  await writeFilePrivate(accountFile, updated);
  return true;
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
  const accountFile = accountPathForName(paths, safeName);
  if (!(await pathExists(accountFile))) {
    throw new CxError(`no account '${safeName}'`, 1);
  }

  const current = await readCurrentMarker(paths);
  if (current.state === 'valid' && current.name === safeName && options.skipWriteback !== true) {
    await writebackCurrentAccount({ paths });
  }

  const isolatedHome = await mkdtemp(join(tmpdir(), `cx-run-${safeName}-`));
  const isolatedEnv = { ...env, CODEX_HOME: isolatedHome };
  const isolatedPaths = getCodexPaths(isolatedEnv);
  try {
    await ensurePrivateDir(isolatedHome);
    await copyFilePrivate(accountFile, isolatedPaths.authFile);
    await copyOptionalFilePrivate(join(paths.home, 'config.toml'), join(isolatedHome, 'config.toml'));
    const exitCode = await runCodex(codexArgs, {
      ...spawnOptions,
      env: isolatedEnv,
    });
    const authUpdated = await copyIsolatedAuthBack(accountFile, isolatedPaths);
    return { exitCode, account: safeName, authUpdated };
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

export async function loginAccount(
  name: string,
  options: LoginAccountOptions = {},
): Promise<WritebackResult> {
  const paths = options.paths ?? getCodexPaths(options.env ?? process.env);
  const safeName = validateAccountName(name);
  const destination = accountPathForName(paths, safeName);

  if ((await pathExists(destination)) && options.force !== true) {
    throw new CxError(`account '${safeName}' already exists (use --force to overwrite)`, 1);
  }

  const writeback = await writebackCurrentAccount({ paths });
  const loginExitCode = await runCodex([], {
    ...options,
    args: ['login', ...(options.loginArgs ?? [])],
  });

  if (loginExitCode !== 0) {
    throw new CxError(`codex login exited with code ${loginExitCode}`, loginExitCode);
  }
  if (!(await authLooksNonEmpty(paths))) {
    throw new CxError(`codex login did not leave a usable ${paths.authFile}`, 1);
  }

  await ensureCodexStoreDirs(paths);
  await copyFilePrivate(paths.authFile, destination);
  await writeCurrentMarker(paths, safeName);
  return writeback;
}

export async function switchAndRunCodex(
  name: string,
  codexArgs: readonly string[] = [],
  options: OperationOptions & SpawnCodexOptions = {},
): Promise<number> {
  const paths = options.paths ?? getCodexPaths(options.env ?? process.env);
  await useAccount(name, { paths });
  return await runCodex(codexArgs, options);
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
  const [homeStats, accountsDirStats, authStats, marker, accountNames, codexExecutable] = await Promise.all([
    statIfExists(paths.home),
    statIfExists(paths.accountsDir),
    statIfExists(paths.authFile),
    readCurrentMarker(paths),
    listAccountNames(paths),
    resolveExecutable('codex', env),
  ]);

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
  if (!authStats?.isFile()) {
    warnings.push('auth.json is missing; run codex login or cx use <name> before launching Codex.');
  } else if (authSize <= AUTH_NON_EMPTY_BYTES) {
    warnings.push('auth.json exists but is too small to be treated as a usable login for save/writeback.');
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
    codexExecutable,
    warnings,
  };
}
