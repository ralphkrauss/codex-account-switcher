#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CxError,
  authFileExists,
  getCodexPaths,
  inspectHermesStatus,
  inspectDoctor,
  listAccounts,
  loginAccount,
  removeAccount,
  renameAccount,
  runCodex,
  saveAccount,
  syncHermesAccount,
  useAccount,
  useHermesAccount,
  validateAccountName,
  type AccountList,
  type DoctorReport,
  type HermesStatus,
} from './index.js';

const PACKAGE_NAME = '@ralphkrauss/codex-account-switcher';
const SUBCOMMANDS = new Set([
  'doctor',
  'hermes',
  'help',
  'login',
  'ls',
  'rename',
  'rm',
  'run',
  'save',
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
  cx save <name> [--force]
  cx use <name>
  cx login <name> [--force] [codex login args...]
  cx rename <old> <new> [--force]
  cx rm <name>
  cx run [name] -- [codex args...]
  cx hermes use <account> [--profile <name>] [--no-config]
  cx hermes sync <account> [--profile <name>]
  cx hermes status [--profile <name>] [--json]
  cx doctor [--json]
  cx --help
  cx --version

Backward-friendly shortcuts:
  cx <account> [codex args...]   switch to <account>, then run codex
  cx                             run codex with the current auth.json when present

Data layout:
  Uses CODEX_HOME when set, otherwise ~/.codex.
  Accounts are stored as CODEX_HOME/accounts/<name>.json.
  The active account marker is CODEX_HOME/.current-account.

Account names may contain letters, numbers, dot, underscore, and dash only.`;
}

function hermesHelpText(): string {
  return `Usage:
  cx hermes use <account> [--profile <name>] [--no-config]
  cx hermes sync <account> [--profile <name>]
  cx hermes status [--profile <name>] [--json]

Commands:
  use      Import CODEX_HOME/accounts/<account>.json into Hermes openai-codex auth.
           Also sets model.provider=openai-codex unless --no-config is passed.
  sync     Copy Hermes openai-codex tokens back to the cx account slot.
  status   Show the selected Hermes home, auth/config state, and linked cx account.

Paths:
  Default Hermes home uses HERMES_HOME when set, otherwise ~/.hermes.
  --profile <name> explicitly targets ~/.hermes/profiles/<name>.`;
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
    lines.push('  (none yet — run: cx save <name> to register the current login, or cx login <name>)');
  } else {
    for (const account of list.accounts) {
      lines.push(account.active ? `  * ${account.name}  (active)` : `    ${account.name}`);
    }
  }

  if (list.currentMarker.state === 'invalid') {
    lines.push('warning: .current-account is invalid; writeback will be skipped until fixed.');
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
    `auth.json: ${report.authJson.exists ? `${report.authJson.size} bytes (${report.authJson.looksNonEmpty ? 'usable for save/writeback' : 'too small for save/writeback'})` : 'missing'}`,
    `codex executable: ${report.codexExecutable ?? 'not found'}`,
  ];

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

async function printList(io: CliIo, env: NodeJS.ProcessEnv): Promise<void> {
  write(io.stdout, formatAccounts(await listAccounts(getCodexPaths(env))));
}

function parseRunArgs(args: readonly string[]): { account: string | null; codexArgs: readonly string[] } {
  const separatorIndex = args.indexOf('--');
  if (separatorIndex >= 0) {
    const beforeSeparator = args.slice(0, separatorIndex);
    if (beforeSeparator.length > 1) {
      throw new CxError('usage: cx run [name] -- [codex args...]', 2);
    }
    return {
      account: beforeSeparator[0] ?? null,
      codexArgs: args.slice(separatorIndex + 1),
    };
  }

  if (args.length === 0) {
    return { account: null, codexArgs: [] };
  }
  const [account, ...codexArgs] = args;
  if (!account || account.startsWith('-')) {
    throw new CxError("usage: cx run [name] -- [codex args...] (use '--' before codex flags)", 2);
  }
  return { account, codexArgs };
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
    case 'use': {
      const parsed = parseHermesArgs('use <account> [--profile <name>] [--no-config]', rest, { noConfig: true });
      requireArity('hermes use <account> [--profile <name>] [--no-config]', parsed.positionals, 1);
      const account = parsed.positionals[0] ?? '';
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
      requireArity('hermes status [--profile <name>] [--json]', parsed.positionals, 0);
      const status = await inspectHermesStatus({
        env,
        ...(parsed.profile ? { profile: parsed.profile } : {}),
      });
      write(io.stdout, parsed.json ? JSON.stringify(status, null, 2) : formatHermesStatus(status));
      return 0;
    }

    default:
      throw new CxError(`unknown hermes command '${command}'`, 2);
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
    if (await authFileExists(paths)) {
      return await runCodex([], { env });
    }

    write(io.stdout, helpText(metadata));
    write(io.stdout, '');
    write(io.stdout, `No live auth.json found at ${paths.authFile}.`);
    write(io.stdout, 'Use cx ls, cx use <name>, cx save <name>, or cx login <name>.');
    write(io.stdout, '');
    write(io.stdout, formatAccounts(await listAccounts(paths)));
    return 0;
  }

  if (!SUBCOMMANDS.has(first)) {
    if (first.startsWith('-')) {
      throw new CxError(`unknown option '${first}'`, 2);
    }

    validateAccountName(first);
    await useAccount(first, { paths: getCodexPaths(env) });
    write(io.stdout, `→ codex on '${first}'`);
    return await runCodex(rest, { env });
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
      await saveAccount(name, { force: parsed.force, paths: getCodexPaths(env) });
      write(io.stdout, `saved current login as '${name}'`);
      return 0;
    }

    case 'use': {
      requireArity('use <name>', rest, 1);
      const name = rest[0] ?? '';
      await useAccount(name, { paths: getCodexPaths(env) });
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
      return 0;
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
        write(io.stderr, `warning: '${name}' was active; live auth.json was left in place until you switch or login.`);
      }
      return 0;
    }

    case 'run': {
      const parsed = parseRunArgs(rest);
      if (parsed.account) {
        await useAccount(parsed.account, { paths: getCodexPaths(env) });
        write(io.stdout, `→ codex on '${parsed.account}'`);
      }
      return await runCodex(parsed.codexArgs, { env });
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
