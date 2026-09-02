import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  accountPathForName,
  getCodexPaths,
  inspectDoctor,
  listAccounts,
  loginAccount,
  removeAccount,
  renameAccount,
  saveAccount,
  useAccount,
  writebackCurrentAccount,
} from '../index.js';

function authPayload(label: string, accountId?: string): string {
  const tokens = accountId ? { account_id: accountId, access_token: `access-${label}`, refresh_token: `refresh-${label}` } : undefined;
  return `${JSON.stringify({ label, ...(tokens ? { tokens } : {}), filler: 'x'.repeat(180) })}\n`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function makeHome(t: TestContext): Promise<ReturnType<typeof getCodexPaths>> {
  const home = await mkdtemp(join(tmpdir(), 'cx-accounts-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  return getCodexPaths({ CODEX_HOME: home });
}

test('save creates stable profile homes and use never swaps shared auth.json', async (t) => {
  const paths = await makeHome(t);
  await mkdir(paths.home, { recursive: true });

  await writeFile(paths.authFile, authPayload('work-initial', 'work-id'));
  await saveAccount('work', { paths });

  await writeFile(paths.authFile, authPayload('personal-initial', 'personal-id'));
  await saveAccount('personal', { paths });
  await writeFile(paths.authFile, authPayload('personal-refreshed', 'personal-id'));

  const writeback = await useAccount('work', { paths });
  assert.deepEqual(writeback, {
    performed: false,
    reason: 'selected stable profile without changing shared auth.json',
    account: 'work',
  });
  assert.match(await readFile(accountPathForName(paths, 'personal'), 'utf8'), /personal-initial/);
  assert.match(await readFile(paths.authFile, 'utf8'), /personal-refreshed/);
  assert.match(await readFile(join(paths.accountsDir, 'work', 'config.toml'), 'utf8'), /cli_auth_credentials_store = "file"/u);

  const list = await listAccounts(paths);
  assert.deepEqual(list.accounts.map((account) => account.name), ['personal', 'work']);
  assert.equal(list.current, 'work');
  assert.deepEqual(list.accounts.map((account) => account.active), [false, true]);

  if (process.platform !== 'win32') {
    assert.equal((await stat(paths.accountsDir)).mode & 0o777, 0o700);
    assert.equal((await stat(accountPathForName(paths, 'work'))).mode & 0o777, 0o600);
  }
});

test('legacy migration preserves the refreshed live auth for the active matching account', async (t) => {
  const paths = await makeHome(t);
  await mkdir(paths.accountsDir, { recursive: true });
  await writeFile(join(paths.accountsDir, 'gi.json'), authPayload('gi-initial', 'gi-id'));
  await writeFile(paths.currentFile, 'gi\n');
  await writeFile(paths.authFile, authPayload('gi-refreshed', 'gi-id'));

  const list = await listAccounts(paths);
  assert.deepEqual(list.accounts.map((entry) => entry.name), ['gi']);
  assert.match(await readFile(accountPathForName(paths, 'gi'), 'utf8'), /gi-refreshed/u);
  assert.equal(await exists(join(paths.accountsDir, 'gi.json')), false);
  assert.match(await readFile(join(paths.accountsDir, '.legacy-v0.3', 'gi.json'), 'utf8'), /gi-initial/u);
});

test('legacy migration refuses a shared auth file from a different account id', async (t) => {
  const paths = await makeHome(t);
  await mkdir(paths.accountsDir, { recursive: true });
  await writeFile(join(paths.accountsDir, 'gi.json'), authPayload('gi-initial', 'gi-id'));
  await writeFile(paths.currentFile, 'gi\n');
  await writeFile(paths.authFile, authPayload('personal-live', 'personal-id'));

  await listAccounts(paths);
  assert.match(await readFile(accountPathForName(paths, 'gi'), 'utf8'), /gi-initial/u);
  assert.doesNotMatch(await readFile(accountPathForName(paths, 'gi'), 'utf8'), /personal-live/u);
});

test('save refuses to overwrite unless --force semantics are requested', async (t) => {
  const paths = await makeHome(t);
  await mkdir(paths.home, { recursive: true });
  await writeFile(paths.authFile, authPayload('first'));
  await saveAccount('work', { paths });

  await writeFile(paths.authFile, authPayload('second'));
  await assert.rejects(() => saveAccount('work', { paths }), /already exists/);
  assert.match(await readFile(accountPathForName(paths, 'work'), 'utf8'), /first/);

  await saveAccount('work', { paths, force: true });
  assert.match(await readFile(accountPathForName(paths, 'work'), 'utf8'), /second/);
});

test('writeback skips a missing active slot instead of recreating it', async (t) => {
  const paths = await makeHome(t);
  await mkdir(paths.home, { recursive: true });
  await writeFile(paths.authFile, authPayload('other'));
  await saveAccount('other', { paths });

  await writeFile(paths.currentFile, 'ghost\n');
  await writeFile(paths.authFile, authPayload('ghost-refreshed'));

  const writeback = await writebackCurrentAccount({ paths });
  assert.equal(writeback.performed, false);
  assert.equal(writeback.account, 'ghost');
  assert.equal(writeback.reason, 'current account slot no longer exists');
  assert.equal(await exists(accountPathForName(paths, 'ghost')), false);
  await useAccount('other', { paths });
});

test('rename refuses collisions, force-overwrites, and updates active marker', async (t) => {
  const paths = await makeHome(t);
  await mkdir(paths.home, { recursive: true });

  await writeFile(paths.authFile, authPayload('old'));
  await saveAccount('old', { paths });
  await writeFile(paths.authFile, authPayload('dest'));
  await saveAccount('dest', { paths });
  await useAccount('old', { paths });

  await assert.rejects(() => renameAccount('old', 'dest', { paths }), /already exists/);
  const result = await renameAccount('old', 'dest', { paths, force: true });
  assert.deepEqual(result, {
    oldName: 'old',
    newName: 'dest',
    overwrote: true,
    currentUpdated: true,
  });
  assert.equal(await exists(accountPathForName(paths, 'old')), false);
  assert.match(await readFile(accountPathForName(paths, 'dest'), 'utf8'), /old/);
  assert.equal((await readFile(paths.currentFile, 'utf8')).trim(), 'dest');
});

test('rm of active account clears marker and leaves live auth untouched', async (t) => {
  const paths = await makeHome(t);
  await mkdir(paths.home, { recursive: true });
  await writeFile(paths.authFile, authPayload('active'));
  await saveAccount('active', { paths });
  const liveBefore = await readFile(paths.authFile, 'utf8');

  const result = await removeAccount('active', { paths });
  assert.deepEqual(result, { name: 'active', wasActive: true });
  assert.equal(await exists(accountPathForName(paths, 'active')), false);
  assert.equal(await exists(paths.currentFile), false);
  assert.equal(await readFile(paths.authFile, 'utf8'), liveBefore);

  const writeback = await writebackCurrentAccount({ paths });
  assert.equal(writeback.performed, false);
  assert.equal(await exists(accountPathForName(paths, 'active')), false);
});

test('login runs codex login, saves resulting auth, and honors destination collisions', async (t) => {
  const paths = await makeHome(t);
  await mkdir(paths.home, { recursive: true });
  const fakeCodex = join(paths.home, process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex');
  const loginJson = JSON.stringify({ label: 'logged-in', filler: 'x'.repeat(180) });
  const fakeCodexScript = process.platform === 'win32'
    ? `@echo off\r\nif "%1"=="login" (\r\n  if not exist "%CODEX_HOME%" mkdir "%CODEX_HOME%"\r\n  > "%CODEX_HOME%\\auth.json" echo ${loginJson}\r\n  exit /b 0\r\n)\r\nexit /b 42\r\n`
    : `#!/bin/sh\nset -eu\nif [ "${'$'}1" = "login" ]; then\n  mkdir -p "${'$'}CODEX_HOME"\n  printf '%s\\n' '${loginJson}' > "${'$'}CODEX_HOME/auth.json"\n  exit 0\nfi\nexit 42\n`;
  await writeFile(fakeCodex, fakeCodexScript);
  await chmod(fakeCodex, 0o755);

  await loginAccount('fresh', {
    paths,
    command: fakeCodex,
    env: { ...process.env, CODEX_HOME: paths.home },
  });
  assert.match(await readFile(accountPathForName(paths, 'fresh'), 'utf8'), /logged-in/);
  assert.equal((await readFile(paths.currentFile, 'utf8')).trim(), 'fresh');

  await assert.rejects(() => loginAccount('fresh', {
    paths,
    command: fakeCodex,
    env: { ...process.env, CODEX_HOME: paths.home },
  }), /already exists/);

  const socketDir = join(paths.accountsDir, 'fresh', 'app-server-control');
  await mkdir(socketDir, { recursive: true });
  await writeFile(join(socketDir, 'app-server-control.sock'), 'stale socket marker');
  await assert.rejects(() => loginAccount('fresh', {
    paths,
    force: true,
    command: fakeCodex,
    env: { ...process.env, CODEX_HOME: paths.home },
  }), /stop the Codex app-server .* before logging in/u);
  const doctor = await inspectDoctor(
    { packageName: 'test', version: '0.0.0' },
    { ...process.env, CODEX_HOME: paths.home },
  );
  assert.equal(doctor.profiles.find((profile) => profile.name === 'fresh')?.appServerSocketExists, true);
  assert.ok(doctor.warnings.some((warning) => /app-server control socket/u.test(warning)));
});
