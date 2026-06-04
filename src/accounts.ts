import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants, type Stats } from 'node:fs';
import { homedir } from 'node:os';
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

export interface CodexPaths {
  readonly home: string;
  readonly accountsDir: string;
  readonly currentFile: string;
  readonly authFile: string;
}

export interface OperationOptions {
  readonly paths?: CodexPaths;
}

export interface ForceOptions extends OperationOptions {
  readonly force?: boolean;
}

export interface SpawnCodexOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
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

  await copyFilePrivate(paths.authFile, slot);
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

  const writeback = await writebackCurrentAccount({ paths });
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

export async function runCodex(
  codexArgs: readonly string[] = [],
  options: SpawnCodexOptions = {},
): Promise<number> {
  const command = options.command ?? 'codex';
  const args = [...(options.args ?? codexArgs)];

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: 'inherit',
      windowsHide: false,
      shell: process.platform === 'win32',
    });

    child.on('error', (error) => {
      reject(new CxError(`failed to run '${command}': ${error.message}`, 1));
    });
    child.on('exit', (code, signal) => {
      if (typeof code === 'number') {
        resolvePromise(code);
        return;
      }
      resolvePromise(signal ? signalExitCode(signal) : 1);
    });
  });
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
