import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import {
  accountPathForName,
  configureOnePasswordRemote,
  getCodexPaths,
  syncPushAccount,
  useAccount,
} from '../index.js';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
const METADATA_FIELD = 'cx_metadata';

const FAKE_OP_SCRIPT = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const storeFile = process.env.OP_FAKE_STORE;
if (!storeFile) { console.error('OP_FAKE_STORE is required'); process.exit(99); }
function emptyStore() { return { vaults: {}, calls: [] }; }
function load() { return existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, 'utf8')) : emptyStore(); }
function save(store) { writeFileSync(storeFile, JSON.stringify(store, null, 2) + '\\n'); }
function option(args, name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function templatePath(args) { return option(args, '--template') ?? args.find((arg) => arg.startsWith('--template='))?.slice('--template='.length); }
function fieldsFromTemplate(path) { if (!path) return null; const template = JSON.parse(readFileSync(path, 'utf8')); const fields = {}; for (const field of Array.isArray(template.fields) ? template.fields : []) if (typeof field.label === 'string' && typeof field.value === 'string') fields[field.label] = field.value; return { title: typeof template.title === 'string' ? template.title : undefined, fields }; }
function assignment(arg) { const match = /^([^=\\[]+)(?:\\[[^\\]]+\\])?=([\\s\\S]*)$/u.exec(arg); return match ? { label: match[1], value: match[2] } : null; }
function assignments(args) { return args.map(assignment).filter(Boolean); }
function requestedField(args) { const raw = option(args, '--fields'); return raw?.startsWith('label=') ? raw.slice('label='.length) : raw; }
function vaultItems(store, vault) { store.vaults[vault] ??= {}; return store.vaults[vault]; }
function fieldsFor(item) { return Object.keys(item).sort().map((label) => ({ label, type: label === 'auth_json' ? 'CONCEALED' : 'STRING', value: item[label] })); }
const args = process.argv.slice(2);
const store = load();
store.calls.push(args);
function fail(message, code = 1) { save(store); console.error(message); process.exit(code); }
if (args[0] === 'vault' && args[1] === 'get') { const vault = args[2]; if (!vault) fail('missing vault'); vaultItems(store, vault); save(store); process.stdout.write(JSON.stringify({ id: vault, name: vault })); process.exit(0); }
if (args[0] !== 'item') fail('unsupported command');
const action = args[1];
if (action === 'list') { const vault = option(args, '--vault'); if (!vault) fail('missing vault'); const items = vaultItems(store, vault); save(store); process.stdout.write(JSON.stringify(Object.keys(items).sort().map((title) => ({ title, vault })))); process.exit(0); }
if (action === 'get') {
  const title = args[2]; const vault = option(args, '--vault'); if (!title || !vault) fail('missing item title or vault');
  const item = vaultItems(store, vault)[title]; if (!item) fail('item ' + title + ' not found');
  if (args.includes('--format')) { save(store); process.stdout.write(JSON.stringify({ title, vault, fields: fieldsFor(item) })); process.exit(0); }
  const field = requestedField(args); if (field) { if (typeof item[field] !== 'string') fail('field ' + field + ' not found'); save(store); process.stdout.write(item[field] + '\\n'); process.exit(0); }
  fail('unsupported get shape');
}
if (action === 'create' || action === 'edit') {
  const vault = option(args, '--vault'); const template = fieldsFromTemplate(templatePath(args)); const title = action === 'create' ? (option(args, '--title') ?? template?.title) : args[2]; const fields = template ? Object.entries(template.fields).map(([label, value]) => ({ label, value })) : assignments(args);
  if (!vault || !title || fields.length === 0) fail('missing arguments');
  const items = vaultItems(store, vault);
  if (action === 'create') { if (items[title]) fail('item ' + title + ' already exists'); items[title] = {}; }
  if (action === 'edit' && !items[title]) fail('item ' + title + ' not found');
  for (const field of fields) items[title][field.label] = field.value;
  save(store); process.stdout.write(JSON.stringify({ title, vault })); process.exit(0);
}
fail('unsupported item action');
`;

const FAKE_CODEX_SCRIPT = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
function writeText(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
if (process.env.CODEX_ARGS_FILE) writeText(process.env.CODEX_ARGS_FILE, args.join('\\n') + (args.length ? '\\n' : ''));
const home = process.env.CODEX_HOME;
const authFile = home ? join(home, 'auth.json') : null;
if (process.env.CODEX_AUTH_SNAPSHOT_FILE) writeText(process.env.CODEX_AUTH_SNAPSHOT_FILE, authFile && existsSync(authFile) ? readFileSync(authFile, 'utf8') : '');
function writeAuth(value) { if (!home || !authFile) { console.error('CODEX_HOME is required'); process.exit(98); } mkdirSync(home, { recursive: true }); writeFileSync(authFile, value); }
if (args[0] === 'login' && process.env.CODEX_FAKE_LOGIN_AUTH_JSON) writeAuth(process.env.CODEX_FAKE_LOGIN_AUTH_JSON);
if (args[0] !== 'login' && process.env.CODEX_FAKE_AUTH_JSON_AFTER_RUN) writeAuth(process.env.CODEX_FAKE_AUTH_JSON_AFTER_RUN);
process.exit(Number(process.env.CODEX_FAKE_EXIT_CODE ?? '0'));
`;

interface Sandbox {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly storeFile: string;
  readonly paths: ReturnType<typeof getCodexPaths>;
}

async function makeSandbox(t: TestContext): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'cx-auto-sync-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const bin = join(root, 'bin');
  const codexHome = join(root, 'codex');
  const storeFile = join(root, 'op-store.json');
  await mkdir(bin, { recursive: true });
  await writeNodeCommand(bin, 'op', FAKE_OP_SCRIPT);
  await writeNodeCommand(bin, 'codex', FAKE_CODEX_SCRIPT);
  const env = { ...process.env, CODEX_HOME: codexHome, OP_FAKE_STORE: storeFile, PATH: [bin, process.env.PATH ?? ''].join(delimiter) };
  return { root, env, storeFile, paths: getCodexPaths(env) };
}

async function writeNodeCommand(bin: string, name: string, script: string): Promise<void> {
  const scriptPath = join(bin, `fake-${name}.mjs`);
  await writeFile(scriptPath, script);
  if (process.platform === 'win32') {
    await writeFile(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return;
  }
  const commandPath = join(bin, name);
  await writeFile(commandPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`);
  await chmod(commandPath, 0o755);
}

function runCli(args: readonly string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8' });
}

function authPayload(label: string): string {
  return `${JSON.stringify({ label, tokens: { access_token: `fake-access-${label}`, refresh_token: `fake-refresh-${label}` }, filler: 'x'.repeat(180) }, null, 2)}\n`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeAccount(paths: ReturnType<typeof getCodexPaths>, account: string, authJson: string): Promise<string> {
  await mkdir(paths.accountsDir, { recursive: true });
  const file = accountPathForName(paths, account);
  await writeFile(file, authJson);
  return file;
}

async function readStore(storeFile: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(storeFile, 'utf8')) as Record<string, any>;
}

async function writeStore(storeFile: string, store: Record<string, any>): Promise<void> {
  await writeFile(storeFile, `${JSON.stringify(store, null, 2)}\n`);
}

function item(store: Record<string, any>, title: string): Record<string, any> {
  return store.vaults.Dev[title] as Record<string, any>;
}

function storedAuthJson(store: Record<string, any>, title: string): string {
  return item(store, title).auth_json as string;
}

function storedMetadata(store: Record<string, any>, title: string): Record<string, any> {
  return JSON.parse(item(store, title)[METADATA_FIELD] as string) as Record<string, any>;
}

async function seedRemote(sandbox: Sandbox, account: string, authJson: string, metadata = true): Promise<void> {
  const store = await readStore(sandbox.storeFile).catch(() => ({ vaults: {}, calls: [] }));
  store.vaults ??= {};
  store.vaults.Dev ??= {};
  store.calls ??= [];
  store.vaults.Dev[`cx-${account}`] = { auth_json: authJson };
  if (metadata) {
    store.vaults.Dev[`cx-${account}`][METADATA_FIELD] = JSON.stringify({ version: 1, account, authJsonSha256: sha256Hex(authJson), updatedAt: '2026-01-01T00:00:00.000Z' });
  }
  await writeStore(sandbox.storeFile, store);
}

async function assertLocalSyncHash(paths: ReturnType<typeof getCodexPaths>, account: string, authJson: string): Promise<void> {
  const metadata = JSON.parse(await readFile(join(paths.accountsDir, '.sync', `${account}.json`), 'utf8')) as Record<string, any>;
  assert.equal(metadata.version, 1);
  assert.equal(metadata.backend, '1password');
  assert.equal(metadata.account, account);
  assert.equal(metadata.remoteAuthJsonSha256, sha256Hex(authJson));
  assert.equal(metadata.lastSyncedAuthJsonSha256, sha256Hex(authJson));
}

test('sync push writes backend-neutral hash metadata locally and in 1Password', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev' }, { paths: sandbox.paths });
  const authJson = authPayload('work-v1');
  await writeAccount(sandbox.paths, 'work', authJson);

  await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });

  const store = await readStore(sandbox.storeFile);
  assert.equal(storedAuthJson(store, 'cx-work'), authJson);
  const metadata = storedMetadata(store, 'cx-work');
  assert.equal(metadata.version, 1);
  assert.equal(metadata.account, 'work');
  assert.equal(metadata.authJsonSha256, sha256Hex(authJson));
  assert.doesNotMatch(JSON.stringify(metadata), /fake-access|fake-refresh|work-v1/u);
  await assertLocalSyncHash(sandbox.paths, 'work', authJson);
});

test('cx use auto-pulls remote-newer auth only when local copy is unchanged since last sync', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev' }, { paths: sandbox.paths });
  const baseline = authPayload('baseline');
  const remoteNewer = authPayload('remote-newer');
  await writeAccount(sandbox.paths, 'work', baseline);
  await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });
  await seedRemote(sandbox, 'work', remoteNewer);

  const result = runCli(['use', 'work'], sandbox.env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /auto-pulled .*profile 'work'/u);
  assert.equal(await readFile(accountPathForName(sandbox.paths, 'work'), 'utf8'), remoteNewer);
  assert.equal(await readFile(sandbox.paths.authFile, 'utf8'), remoteNewer);
  await assertLocalSyncHash(sandbox.paths, 'work', remoteNewer);
});

test('cx run auto-pulls before launch and auto-pushes refreshed active auth after exit', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev' }, { paths: sandbox.paths });
  const baseline = authPayload('run-baseline');
  const remoteNewer = authPayload('run-remote-newer');
  const refreshed = authPayload('run-refreshed');
  const snapshotFile = join(sandbox.root, 'auth-before-codex.txt');
  await writeAccount(sandbox.paths, 'work', baseline);
  await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });
  await seedRemote(sandbox, 'work', remoteNewer);

  const result = runCli(['run', 'work', '--', 'exec', 'prompt'], {
    ...sandbox.env,
    CODEX_AUTH_SNAPSHOT_FILE: snapshotFile,
    CODEX_FAKE_AUTH_JSON_AFTER_RUN: refreshed,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(snapshotFile, 'utf8'), remoteNewer);
  assert.equal(await readFile(accountPathForName(sandbox.paths, 'work'), 'utf8'), refreshed);
  const store = await readStore(sandbox.storeFile);
  assert.equal(storedAuthJson(store, 'cx-work'), refreshed);
  await assertLocalSyncHash(sandbox.paths, 'work', refreshed);
});

test('cx use of the already-active profile does not reverse an auto-pulled remote refresh', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev' }, { paths: sandbox.paths });
  const baseline = authPayload('active-baseline');
  const remoteNewer = authPayload('active-remote-newer');

  await writeAccount(sandbox.paths, 'work', baseline);
  await useAccount('work', { paths: sandbox.paths });
  await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });
  await seedRemote(sandbox, 'work', remoteNewer);

  const result = runCli(['use', 'work'], sandbox.env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /auto-pulled 1Password-backed profile 'work'/u);
  assert.doesNotMatch(result.stdout, /auto-pushed profile 'work'/u);
  assert.equal(await readFile(sandbox.paths.authFile, 'utf8'), remoteNewer);
  assert.equal(await readFile(accountPathForName(sandbox.paths, 'work'), 'utf8'), remoteNewer);
  assert.equal(storedAuthJson(await readStore(sandbox.storeFile), 'cx-work'), remoteNewer);
  await assertLocalSyncHash(sandbox.paths, 'work', remoteNewer);
});

test('cx run without an account auto-pulls the active profile before launching codex', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev' }, { paths: sandbox.paths });
  const baseline = authPayload('current-baseline');
  const remoteNewer = authPayload('current-remote-newer');
  const snapshotFile = join(sandbox.root, 'current-before-codex.txt');

  await writeAccount(sandbox.paths, 'work', baseline);
  await useAccount('work', { paths: sandbox.paths });
  await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });
  await seedRemote(sandbox, 'work', remoteNewer);

  const result = runCli(['run', '--', 'exec', 'prompt'], {
    ...sandbox.env,
    CODEX_AUTH_SNAPSHOT_FILE: snapshotFile,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(snapshotFile, 'utf8'), remoteNewer);
  assert.equal(await readFile(sandbox.paths.authFile, 'utf8'), remoteNewer);
  assert.equal(storedAuthJson(await readStore(sandbox.storeFile), 'cx-work'), remoteNewer);
});

test('post-run auto-push refuses unknown legacy remote state instead of overwriting it', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev' }, { paths: sandbox.paths });
  const localAuth = authPayload('legacy-local');
  const remoteLegacy = authPayload('legacy-remote-untouched');
  const refreshedLocal = authPayload('legacy-local-refreshed');

  await writeAccount(sandbox.paths, 'work', localAuth);
  await useAccount('work', { paths: sandbox.paths });
  await seedRemote(sandbox, 'work', remoteLegacy, false);

  const result = runCli(['run', '--', 'exec', 'prompt'], {
    ...sandbox.env,
    CODEX_FAKE_AUTH_JSON_AFTER_RUN: refreshedLocal,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /auto-pushed profile 'work'/u);
  assert.equal(await readFile(sandbox.paths.authFile, 'utf8'), refreshedLocal);
  assert.equal(await readFile(accountPathForName(sandbox.paths, 'work'), 'utf8'), refreshedLocal);
  assert.equal(storedAuthJson(await readStore(sandbox.storeFile), 'cx-work'), remoteLegacy);
});

test('implicit magic sync skips reserved default so local default operations remain backwards-compatible', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev' }, { paths: sandbox.paths });
  const authJson = authPayload('default-local');
  await mkdir(sandbox.paths.home, { recursive: true });
  await writeFile(sandbox.paths.authFile, authJson);

  const result = runCli(['save', 'default'], sandbox.env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /saved current login as 'default'/u);
  assert.doesNotMatch(result.stdout, /auto-pushed/u);
  assert.equal(await readFile(accountPathForName(sandbox.paths, 'default'), 'utf8'), authJson);
});

test('active auto-pull detects unsaved local refresh instead of overwriting it with remote changes', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev' }, { paths: sandbox.paths });
  const baseline = authPayload('unsaved-baseline');
  const localRefresh = authPayload('unsaved-local-refresh');
  const remoteRefresh = authPayload('unsaved-remote-refresh');
  await writeAccount(sandbox.paths, 'work', baseline);
  await useAccount('work', { paths: sandbox.paths });
  await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });
  await seedRemote(sandbox, 'work', remoteRefresh);
  await writeFile(sandbox.paths.authFile, localRefresh);

  const result = runCli(['run', '--', 'exec', 'prompt'], sandbox.env);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sync conflict|diverged/u);
  assert.equal(await readFile(sandbox.paths.authFile, 'utf8'), localRefresh);
  assert.equal(await readFile(accountPathForName(sandbox.paths, 'work'), 'utf8'), localRefresh);
  assert.equal(storedAuthJson(await readStore(sandbox.storeFile), 'cx-work'), remoteRefresh);
});

test('auto-push does not recreate a previously synced remote item that was deleted', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev' }, { paths: sandbox.paths });
  const baseline = authPayload('deleted-remote-baseline');
  const changed = authPayload('deleted-remote-local-change');
  await writeAccount(sandbox.paths, 'work', baseline);
  await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });
  const store = await readStore(sandbox.storeFile);
  delete store.vaults.Dev['cx-work'];
  await writeStore(sandbox.storeFile, store);
  await mkdir(sandbox.paths.home, { recursive: true });
  await writeFile(sandbox.paths.authFile, changed);
  await writeFile(accountPathForName(sandbox.paths, 'work'), changed);

  const result = runCli(['save', 'work', '--force'], sandbox.env);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /auto-pushed/u);
  assert.equal((await readStore(sandbox.storeFile)).vaults.Dev['cx-work'], undefined);
});

test('auto-sync treats remote metadata hash mismatches as unknown and never overwrites that remote item', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev' }, { paths: sandbox.paths });
  const baseline = authPayload('metadata-baseline');
  const remoteChanged = authPayload('metadata-remote-with-stale-hash');
  await writeAccount(sandbox.paths, 'work', baseline);
  await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });
  const store = await readStore(sandbox.storeFile);
  store.vaults.Dev['cx-work'].auth_json = remoteChanged;
  await writeStore(sandbox.storeFile, store);

  const result = runCli(['use', 'work'], sandbox.env);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /auto-pulled|auto-pushed/u);
  assert.equal(await readFile(accountPathForName(sandbox.paths, 'work'), 'utf8'), baseline);
  assert.equal(storedAuthJson(await readStore(sandbox.storeFile), 'cx-work'), remoteChanged);
});

test('auto-push reports divergence instead of silently skipping after save or login writes local changes', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev' }, { paths: sandbox.paths });
  const baseline = authPayload('push-conflict-baseline');
  const localChanged = authPayload('push-conflict-local');
  const remoteChanged = authPayload('push-conflict-remote');
  await writeAccount(sandbox.paths, 'work', baseline);
  await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });
  await seedRemote(sandbox, 'work', remoteChanged);
  await mkdir(sandbox.paths.home, { recursive: true });
  await writeFile(sandbox.paths.authFile, localChanged);

  const result = runCli(['save', 'work', '--force'], sandbox.env);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sync conflict|diverged/u);
  assert.equal(await readFile(accountPathForName(sandbox.paths, 'work'), 'utf8'), localChanged);
  assert.equal(storedAuthJson(await readStore(sandbox.storeFile), 'cx-work'), remoteChanged);
});

test('auto-sync reports divergence instead of overwriting local or remote credentials', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev' }, { paths: sandbox.paths });
  const baseline = authPayload('conflict-baseline');
  const localChanged = authPayload('conflict-local');
  const remoteChanged = authPayload('conflict-remote');
  const accountFile = await writeAccount(sandbox.paths, 'work', baseline);
  await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });
  await seedRemote(sandbox, 'work', remoteChanged);
  await writeFile(accountFile, localChanged);

  const result = runCli(['use', 'work'], sandbox.env);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sync conflict|diverged|would overwrite/u);
  assert.equal(await readFile(accountFile, 'utf8'), localChanged);
  assert.equal(storedAuthJson(await readStore(sandbox.storeFile), 'cx-work'), remoteChanged);
});

test('CX_AUTO_SYNC=0 keeps legacy explicit sync behavior available but disables magic pull and push', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev' }, { paths: sandbox.paths });
  const baseline = authPayload('optout-baseline');
  const remoteNewer = authPayload('optout-remote');
  const refreshed = authPayload('optout-refreshed');
  await writeAccount(sandbox.paths, 'work', baseline);
  await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });
  await seedRemote(sandbox, 'work', remoteNewer);

  const used = runCli(['use', 'work'], { ...sandbox.env, CX_AUTO_SYNC: '0' });
  assert.equal(used.status, 0, used.stderr);
  assert.doesNotMatch(used.stdout, /auto-pulled/u);
  assert.equal(await readFile(sandbox.paths.authFile, 'utf8'), baseline);

  const ran = runCli(['run', '--', 'exec'], { ...sandbox.env, CX_AUTO_SYNC: '0', CODEX_FAKE_AUTH_JSON_AFTER_RUN: refreshed });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(storedAuthJson(await readStore(sandbox.storeFile), 'cx-work'), remoteNewer);

  const explicit = runCli(['sync', 'pull', 'work', '--force'], { ...sandbox.env, CX_AUTO_SYNC: '0' });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(await readFile(accountPathForName(sandbox.paths, 'work'), 'utf8'), remoteNewer);
});

test('legacy remote items without metadata remain pullable and are upgraded on push', async (t) => {
  const sandbox = await makeSandbox(t);
  await configureOnePasswordRemote({ vault: 'Dev' }, { paths: sandbox.paths });
  const legacy = authPayload('legacy');
  const changed = authPayload('legacy-changed');
  await seedRemote(sandbox, 'legacy', legacy, false);

  const pull = runCli(['sync', 'pull', 'legacy'], sandbox.env);
  assert.equal(pull.status, 0, pull.stderr);
  assert.equal(await readFile(accountPathForName(sandbox.paths, 'legacy'), 'utf8'), legacy);
  await assertLocalSyncHash(sandbox.paths, 'legacy', legacy);

  await writeFile(accountPathForName(sandbox.paths, 'legacy'), changed);
  const push = runCli(['sync', 'push', 'legacy'], sandbox.env);
  assert.equal(push.status, 0, push.stderr);
  assert.equal(storedAuthJson(await readStore(sandbox.storeFile), 'cx-legacy'), changed);
  await assertLocalSyncHash(sandbox.paths, 'legacy', changed);
});
