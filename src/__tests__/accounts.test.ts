import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  accountPathForName,
  getCodexPaths,
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

test('save, list, and use preserve refreshed auth with writeback', async (t) => {
  const paths = await makeHome(t);
  await mkdir(paths.home, { recursive: true });

  await writeFile(paths.authFile, authPayload('work-initial', 'work-id'));
  await saveAccount('work', { paths });

  await writeFile(paths.authFile, authPayload('personal-initial', 'personal-id'));
  await saveAccount('personal', { paths });
  await writeFile(paths.authFile, authPayload('personal-refreshed', 'personal-id'));

  const writeback = await useAccount('work', { paths });
  assert.deepEqual(writeback, { performed: true, account: 'personal' });
  assert.match(await readFile(accountPathForName(paths, 'personal'), 'utf8'), /personal-refreshed/);
  assert.match(await readFile(paths.authFile, 'utf8'), /work-initial/);

  const list = await listAccounts(paths);
  assert.deepEqual(list.accounts.map((account) => account.name), ['personal', 'work']);
  assert.equal(list.current, 'work');
  assert.deepEqual(list.accounts.map((account) => account.active), [false, true]);

  if (process.platform !== 'win32') {
    assert.equal((await stat(paths.accountsDir)).mode & 0o777, 0o700);
    assert.equal((await stat(accountPathForName(paths, 'work'))).mode & 0o777, 0o600);
  }
});

test('writeback refuses to overwrite the current slot with a different Codex account_id', async (t) => {
  const paths = await makeHome(t);
  await mkdir(paths.home, { recursive: true });

  await writeFile(paths.authFile, authPayload('gi-initial', 'gi-id'));
  await saveAccount('gi', { paths });
  const giBefore = await readFile(accountPathForName(paths, 'gi'), 'utf8');

  await writeFile(paths.authFile, authPayload('personal-initial', 'personal-id'));
  await saveAccount('personal', { paths });
  await useAccount('gi', { paths });

  // Simulates a raw `codex login` or other out-of-band auth mutation while
  // .current-account still says `gi`. The next switch must not save that
  // different OAuth account into gi.json.
  await writeFile(paths.authFile, authPayload('personal-raw-login', 'personal-id'));

  const writeback = await useAccount('personal', { paths });
  assert.deepEqual(writeback, {
    performed: false,
    reason: 'live auth.json account_id does not match current account slot',
    account: 'gi',
  });
  assert.equal(await readFile(accountPathForName(paths, 'gi'), 'utf8'), giBefore);
  assert.match(await readFile(paths.authFile, 'utf8'), /personal-initial/);
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

  const writeback = await useAccount('other', { paths });
  assert.equal(writeback.performed, false);
  assert.equal(writeback.account, 'ghost');
  assert.equal(writeback.reason, 'current account slot no longer exists');
  assert.equal(await exists(accountPathForName(paths, 'ghost')), false);
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
});
