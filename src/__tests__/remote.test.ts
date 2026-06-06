import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import {
  accountPathForName,
  configureOnePasswordRemote,
  getCodexPaths,
  getRemoteConfigPath,
  inspectRemoteStatus,
  inspectSyncStatus,
  setupOnePasswordProfiles,
  readRemoteConfig,
  syncPullAllAccounts,
  syncPullAccount,
  syncPushAllAccounts,
  syncPushAccount,
  useAccount,
} from '../index.js';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

const FAKE_OP_SCRIPT = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const storeFile = process.env.OP_FAKE_STORE;
if (!storeFile) {
  console.error('OP_FAKE_STORE is required');
  process.exit(99);
}

function emptyStore() {
  return { vaults: {}, calls: [] };
}

function load() {
  if (!existsSync(storeFile)) {
    return emptyStore();
  }
  return JSON.parse(readFileSync(storeFile, 'utf8'));
}

function save(store) {
  writeFileSync(storeFile, JSON.stringify(store, null, 2) + '\\n');
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function authAssignment(args) {
  return args.find((arg) => arg.startsWith('auth_json[concealed]='));
}

function vaultItems(store, vault) {
  store.vaults[vault] ??= {};
  return store.vaults[vault];
}

const args = process.argv.slice(2);
const store = load();
store.calls.push(args);

function fail(message, code = 1) {
  save(store);
  console.error(message);
  process.exit(code);
}

if (args[0] === 'vault' && args[1] === 'get') {
  const vault = args[2];
  if (!vault) {
    fail('missing vault');
  }
  vaultItems(store, vault);
  save(store);
  process.stdout.write(JSON.stringify({ id: vault, name: vault }));
  process.exit(0);
}

if (args[0] !== 'item') {
  fail('unsupported command');
}

const action = args[1];
if (action === 'list') {
  const vault = option(args, '--vault');
  if (!vault) {
    fail('missing vault');
  }
  const items = vaultItems(store, vault);
  save(store);
  process.stdout.write(JSON.stringify(Object.keys(items).sort().map((title) => ({ title, vault }))));
  process.exit(0);
}

if (action === 'get') {
  const title = args[2];
  const vault = option(args, '--vault');
  if (!title || !vault) {
    fail('missing item title or vault');
  }
  const item = vaultItems(store, vault)[title];
  if (!item) {
    fail('item ' + title + ' not found');
  }
  if (args.includes('--format')) {
    save(store);
    process.stdout.write(JSON.stringify({ title, vault, fields: [{ label: 'auth_json', type: 'CONCEALED', value: item.auth_json }] }));
    process.exit(0);
  }
  if (args.includes('--fields')) {
    if (typeof item.auth_json !== 'string') {
      fail('field auth_json not found');
    }
    save(store);
    process.stdout.write(item.auth_json + '\\n');
    process.exit(0);
  }
  fail('unsupported get shape');
}

if (action === 'create') {
  const vault = option(args, '--vault');
  const title = option(args, '--title');
  const assignment = authAssignment(args);
  if (!vault || !title || !assignment) {
    fail('missing create arguments');
  }
  const items = vaultItems(store, vault);
  if (items[title]) {
    fail('item ' + title + ' already exists');
  }
  items[title] = { auth_json: assignment.slice('auth_json[concealed]='.length) };
  save(store);
  process.stdout.write(JSON.stringify({ title, vault }));
  process.exit(0);
}

if (action === 'edit') {
  const title = args[2];
  const vault = option(args, '--vault');
  const assignment = authAssignment(args);
  if (!vault || !title || !assignment) {
    fail('missing edit arguments');
  }
  const items = vaultItems(store, vault);
  if (!items[title]) {
    fail('item ' + title + ' not found');
  }
  items[title].auth_json = assignment.slice('auth_json[concealed]='.length);
  save(store);
  process.stdout.write(JSON.stringify({ title, vault }));
  process.exit(0);
}

fail('unsupported item action');
`;

interface RemoteSandbox {
  readonly root: string;
  readonly codexHome: string;
  readonly bin: string;
  readonly storeFile: string;
  readonly env: NodeJS.ProcessEnv;
  readonly paths: ReturnType<typeof getCodexPaths>;
}

async function makeSandbox(t: TestContext): Promise<RemoteSandbox> {
  const root = await mkdtemp(join(tmpdir(), 'cx-remote-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const codexHome = join(root, 'codex');
  const bin = join(root, 'bin');
  const storeFile = join(root, 'op-store.json');
  await mkdir(bin, { recursive: true });
  await writeFakeOp(bin);
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    OP_FAKE_STORE: storeFile,
    PATH: [bin, process.env.PATH ?? ''].join(delimiter),
  };
  return {
    root,
    codexHome,
    bin,
    storeFile,
    env,
    paths: getCodexPaths(env),
  };
}

async function writeFakeOp(bin: string): Promise<void> {
  const scriptPath = join(bin, 'fake-op.mjs');
  await writeFile(scriptPath, FAKE_OP_SCRIPT);
  if (process.platform === 'win32') {
    await writeFile(join(bin, 'op.cmd'), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return;
  }
  const opPath = join(bin, 'op');
  await writeFile(opPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`);
  await chmod(opPath, 0o755);
}

async function readStore(storeFile: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(storeFile, 'utf8')) as Record<string, any>;
}

function storedAuthJson(store: Record<string, any>, vault: string, item: string): string {
  return store.vaults[vault][item].auth_json as string;
}

function runCli(args: readonly string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env,
    encoding: 'utf8',
  });
}

async function writeAccount(paths: ReturnType<typeof getCodexPaths>, account: string, authJson: string): Promise<string> {
  await mkdir(paths.accountsDir, { recursive: true });
  const accountFile = accountPathForName(paths, account);
  await writeFile(accountFile, authJson);
  return accountFile;
}

test('1Password remote config uses CODEX_HOME/remote.json with a private default prefix', async (t) => {
  const sandbox = await makeSandbox(t);

  const configured = await configureOnePasswordRemote({ vault: 'Engineering' }, { paths: sandbox.paths });
  assert.equal(configured.configPath, getRemoteConfigPath(sandbox.paths));
  assert.deepEqual(configured.config, {
    version: 1,
    backend: '1password',
    vault: 'Engineering',
    itemPrefix: 'cx-',
  });
  assert.deepEqual(await readRemoteConfig({ paths: sandbox.paths }), configured.config);

  const configRaw = await readFile(configured.configPath, 'utf8');
  assert.doesNotMatch(configRaw, /access_token|refresh_token|auth_json|token-secret/u);
  if (process.platform !== 'win32') {
    assert.equal((await stat(configured.configPath)).mode & 0o777, 0o600);
  }

  const status = await inspectRemoteStatus({ paths: sandbox.paths, env: sandbox.env });
  assert.equal(status.configured, true);
  assert.equal(status.backend, '1password');
  assert.equal(status.vault, 'Engineering');
  assert.equal(status.itemPrefix, 'cx-');
  assert.equal(status.opAvailable, true);

  const custom = await configureOnePasswordRemote({ vault: 'Team', itemPrefix: 'codex-' }, { paths: sandbox.paths });
  assert.equal(custom.config.itemPrefix, 'codex-');
  assert.deepEqual(await readRemoteConfig({ paths: sandbox.paths }), custom.config);

  await writeFile(getRemoteConfigPath(sandbox.paths), '{"version":1,"backend":"s3","vault":"Team","itemPrefix":"cx-"}\n');
  await assert.rejects(() => readRemoteConfig({ paths: sandbox.paths }), /unsupported remote backend/u);
});

test('sync push creates and edits 1Password auth_json, and pull writes local accounts with force protection', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev', itemPrefix: 'cx-' }, { paths: sandbox.paths });

  const firstAuth = `${JSON.stringify({
    tokens: {
      access_token: 'fake-access-token-1',
      refresh_token: 'fake-refresh-token-1',
    },
    account: 'work',
  }, null, 2)}\n`;
  const accountFile = await writeAccount(sandbox.paths, 'work', firstAuth);

  const created = await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });
  assert.equal(created.operation, 'created');
  assert.equal(created.item, 'cx-work');
  assert.equal(storedAuthJson(await readStore(sandbox.storeFile), 'Dev', 'cx-work'), firstAuth);

  const secondAuth = `${JSON.stringify({
    tokens: {
      access_token: 'fake-access-token-2',
      refresh_token: 'fake-refresh-token-2',
    },
    account: 'work',
    refreshed: true,
  }, null, 2)}\n`;
  await writeFile(accountFile, secondAuth);

  const updated = await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });
  assert.equal(updated.operation, 'updated');
  const storeAfterUpdate = await readStore(sandbox.storeFile);
  assert.equal(storedAuthJson(storeAfterUpdate, 'Dev', 'cx-work'), secondAuth);
  assert.ok(storeAfterUpdate.calls.some((call: string[]) => call[0] === 'item' && call[1] === 'create'));
  const createCall = storeAfterUpdate.calls.find((call: string[]) => call[0] === 'item' && call[1] === 'create') as string[] | undefined;
  assert.equal(createCall?.[createCall.indexOf('--category') + 1], 'Secure Note');
  assert.ok(storeAfterUpdate.calls.some((call: string[]) => call[0] === 'item' && call[1] === 'edit'));

  await rm(accountFile);
  const pulled = await syncPullAccount('work', { paths: sandbox.paths, env: sandbox.env });
  assert.equal(pulled.overwritten, false);
  assert.equal(await readFile(accountFile, 'utf8'), secondAuth);

  await assert.rejects(
    () => syncPullAccount('work', { paths: sandbox.paths, env: sandbox.env }),
    /already exists/u,
  );
  const forced = await syncPullAccount('work', { paths: sandbox.paths, env: sandbox.env, force: true });
  assert.equal(forced.overwritten, true);
  assert.equal(await readFile(accountFile, 'utf8'), secondAuth);
});

test('sync push writes back refreshed live auth for the active account before uploading', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev', itemPrefix: 'cx-' }, { paths: sandbox.paths });
  const staleAuth = `${JSON.stringify({ account: 'work', token: 'stale', filler: 'x'.repeat(200) })}\n`;
  const refreshedAuth = `${JSON.stringify({ account: 'work', token: 'refreshed', filler: 'x'.repeat(200) })}\n`;
  await writeAccount(sandbox.paths, 'work', staleAuth);
  await useAccount('work', { paths: sandbox.paths });
  await writeFile(sandbox.paths.authFile, refreshedAuth);

  await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });

  const store = await readStore(sandbox.storeFile);
  assert.deepEqual(JSON.parse(storedAuthJson(store, 'Dev', 'cx-work')) as unknown, JSON.parse(refreshedAuth) as unknown);
  assert.equal(await readFile(accountPathForName(sandbox.paths, 'work'), 'utf8'), refreshedAuth);
});

test('sync push of an inactive account does not write back or corrupt the active slot', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev', itemPrefix: 'cx-' }, { paths: sandbox.paths });
  const giAuth = `${JSON.stringify({ account: 'gi', token: 'saved-gi', filler: 'x'.repeat(200) })}\n`;
  const personalAuth = `${JSON.stringify({ account: 'personal', token: 'saved-personal', filler: 'x'.repeat(200) })}\n`;
  const directLoginAuth = `${JSON.stringify({ account: 'personal', token: 'direct-login', filler: 'x'.repeat(200) })}\n`;
  await writeAccount(sandbox.paths, 'gi', giAuth);
  await writeAccount(sandbox.paths, 'personal', personalAuth);
  await useAccount('gi', { paths: sandbox.paths });
  await writeFile(sandbox.paths.authFile, directLoginAuth);

  await syncPushAccount('personal', { paths: sandbox.paths, env: sandbox.env });

  const store = await readStore(sandbox.storeFile);
  assert.deepEqual(JSON.parse(storedAuthJson(store, 'Dev', 'cx-personal')) as unknown, JSON.parse(personalAuth) as unknown);
  assert.equal(await readFile(accountPathForName(sandbox.paths, 'gi'), 'utf8'), giAuth);
});

test('remote sync ignores reserved default slot and rejects explicit default sync', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev', itemPrefix: 'cx-' }, { paths: sandbox.paths });
  await writeAccount(sandbox.paths, 'default', `${JSON.stringify({ account: 'default' })}
`);
  await writeAccount(sandbox.paths, 'work', `${JSON.stringify({ account: 'work' })}
`);

  const status = await inspectSyncStatus(undefined, { paths: sandbox.paths, env: sandbox.env });
  assert.deepEqual(status.accounts.map((entry) => entry.account), ['work']);

  await assert.rejects(
    () => syncPushAccount('default', { paths: sandbox.paths, env: sandbox.env }),
    /reserved for the live Codex auth/u,
  );
  await assert.rejects(
    () => syncPullAccount('default', { paths: sandbox.paths, env: sandbox.env }),
    /reserved for the live Codex auth/u,
  );
  await assert.rejects(
    () => inspectSyncStatus('default', { paths: sandbox.paths, env: sandbox.env }),
    /reserved for the live Codex auth/u,
  );
});

test('sync status and bulk pull treat 1Password items as native remote-backed profiles', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev', itemPrefix: 'cx-' }, { paths: sandbox.paths });

  await writeAccount(sandbox.paths, 'local-only', `${JSON.stringify({ account: 'local-only' })}\n`);
  await writeAccount(sandbox.paths, 'default', `${JSON.stringify({ account: 'default' })}\n`);
  await writeAccount(sandbox.paths, 'remote-work', `${JSON.stringify({ account: 'remote-work', source: 'seed' })}\n`);
  await syncPushAccount('remote-work', { paths: sandbox.paths, env: sandbox.env });
  await writeAccount(sandbox.paths, 'remote-personal', `${JSON.stringify({ account: 'remote-personal', source: 'seed' })}\n`);
  await syncPushAccount('remote-personal', { paths: sandbox.paths, env: sandbox.env });
  await rm(accountPathForName(sandbox.paths, 'remote-work'));
  await rm(accountPathForName(sandbox.paths, 'remote-personal'));

  const status = await inspectSyncStatus(undefined, { paths: sandbox.paths, env: sandbox.env });
  assert.deepEqual(status.accounts.map((entry) => entry.account), ['local-only', 'remote-personal', 'remote-work']);
  assert.equal(status.accounts.find((entry) => entry.account === 'remote-work')?.local.exists, false);
  assert.equal(status.accounts.find((entry) => entry.account === 'remote-work')?.remote.presence, 'present');

  const pulled = await syncPullAllAccounts({ paths: sandbox.paths, env: sandbox.env });
  assert.deepEqual(pulled.map((entry) => entry.account), ['remote-personal', 'remote-work']);
  assert.match(await readFile(accountPathForName(sandbox.paths, 'remote-work'), 'utf8'), /remote-work/u);
  assert.match(await readFile(accountPathForName(sandbox.paths, 'remote-personal'), 'utf8'), /remote-personal/u);
});

test('bulk push and 1Password setup configure, pull, and select a profile without scripts', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev', itemPrefix: 'cx-' }, { paths: sandbox.paths });
  await writeAccount(sandbox.paths, 'gi', `${JSON.stringify({ account: 'gi', source: 'local' })}\n`);
  await writeAccount(sandbox.paths, 'personal', `${JSON.stringify({ account: 'personal', source: 'local' })}\n`);

  const pushed = await syncPushAllAccounts({ paths: sandbox.paths, env: sandbox.env });
  assert.deepEqual(pushed.map((entry) => entry.account), ['gi', 'personal']);

  const freshRoot = await mkdtemp(join(tmpdir(), 'cx-remote-fresh-'));
  t.after(async () => {
    await rm(freshRoot, { recursive: true, force: true });
  });
  const freshEnv = { ...sandbox.env, CODEX_HOME: join(freshRoot, 'codex') };
  const freshPaths = getCodexPaths(freshEnv);

  const setup = await setupOnePasswordProfiles({
    vault: 'Dev',
    pull: true,
    use: 'gi',
  }, { paths: freshPaths, env: freshEnv });

  assert.equal(setup.remoteConfigured, true);
  assert.equal(setup.opAvailable, true);
  assert.deepEqual(setup.remoteAccounts, ['gi', 'personal']);
  assert.deepEqual(setup.pulledAccounts, ['gi', 'personal']);
  assert.equal(setup.usedAccount, 'gi');
  assert.equal((await readFile(join(freshPaths.home, '.current-account'), 'utf8')).trim(), 'gi');
});

test('CLI 1Password setup and --all sync make remote-backed profiles native on a fresh machine', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev', itemPrefix: 'cx-' }, { paths: sandbox.paths });
  await writeAccount(sandbox.paths, 'gi', `${JSON.stringify({ account: 'gi', source: 'local' })}\n`);
  await writeAccount(sandbox.paths, 'personal', `${JSON.stringify({ account: 'personal', source: 'local' })}\n`);

  const pushed = runCli(['sync', 'push', '--all'], sandbox.env);
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.match(pushed.stdout, /pushed profiles: gi, personal/u);

  const freshRoot = await mkdtemp(join(tmpdir(), 'cx-cli-1password-'));
  t.after(async () => {
    await rm(freshRoot, { recursive: true, force: true });
  });
  const freshEnv = { ...sandbox.env, CODEX_HOME: join(freshRoot, 'codex') };
  const freshPaths = getCodexPaths(freshEnv);

  const setup = runCli(['1password', 'setup', '--vault', 'Dev', '--pull', '--use', 'gi'], freshEnv);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /configured 1Password-backed Codex profiles/u);
  assert.match(setup.stdout, /remote profiles: gi, personal/u);
  assert.match(setup.stdout, /pulled profiles: gi, personal/u);
  assert.equal((await readFile(join(freshPaths.home, '.current-account'), 'utf8')).trim(), 'gi');

  await rm(accountPathForName(freshPaths, 'personal'));
  const useRemoteOnly = runCli(['use', 'personal'], freshEnv);
  assert.equal(useRemoteOnly.status, 0, useRemoteOnly.stderr);
  assert.match(useRemoteOnly.stdout, /pulled 1Password-backed profile 'personal'/u);
  assert.equal((await readFile(join(freshPaths.home, '.current-account'), 'utf8')).trim(), 'personal');
});

test('CLI remote and sync status do not print auth JSON contents', async (t) => {
  const sandbox = await makeSandbox(t);
  const secret = 'DO_NOT_PRINT_FAKE_AUTH_SECRET';
  const authJson = `${JSON.stringify({
    tokens: {
      access_token: secret,
      refresh_token: `${secret}_refresh`,
    },
    metadata: 'safe-to-store-but-not-print',
  }, null, 2)}\n`;
  await writeAccount(sandbox.paths, 'work', authJson);

  const configured = runCli(['remote', 'configure', '1password', '--vault', 'Dev'], sandbox.env);
  assert.equal(configured.status, 0, configured.stderr);
  assert.doesNotMatch(configured.stdout + configured.stderr, new RegExp(secret, 'u'));

  const pushed = runCli(['sync', 'push', 'work'], sandbox.env);
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.doesNotMatch(pushed.stdout + pushed.stderr, new RegExp(secret, 'u'));

  const remoteText = runCli(['remote', 'status'], sandbox.env);
  assert.equal(remoteText.status, 0, remoteText.stderr);
  assert.match(remoteText.stdout, /backend: 1password/u);
  assert.match(remoteText.stdout, /op CLI: available/u);
  assert.doesNotMatch(remoteText.stdout + remoteText.stderr, new RegExp(secret, 'u'));

  const syncText = runCli(['sync', 'status', 'work'], sandbox.env);
  assert.equal(syncText.status, 0, syncText.stderr);
  assert.match(syncText.stdout, /remote=present/u);
  assert.doesNotMatch(syncText.stdout + syncText.stderr, new RegExp(secret, 'u'));

  const syncJson = runCli(['sync', 'status', 'work', '--json'], sandbox.env);
  assert.equal(syncJson.status, 0, syncJson.stderr);
  assert.doesNotMatch(syncJson.stdout + syncJson.stderr, new RegExp(secret, 'u'));
  const parsed = JSON.parse(syncJson.stdout) as { accounts: Array<{ remote: { presence: string } }> };
  assert.equal(parsed.accounts[0]?.remote.presence, 'present');

  const functionStatus = await inspectSyncStatus('work', { paths: sandbox.paths, env: sandbox.env });
  assert.equal(JSON.stringify(functionStatus).includes(secret), false);
});
