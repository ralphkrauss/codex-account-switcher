import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  accountPathForName,
  getCodexPaths,
  saveAccount,
  validateAccountName,
} from '../index.js';

function authPayload(label: string): string {
  return `${JSON.stringify({ label, filler: 'x'.repeat(180) })}\n`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('validateAccountName accepts the intended portable account-name alphabet', () => {
  for (const name of ['work', 'work.prod', 'prod_1', 'team-alpha', 'A.B_9-z']) {
    assert.equal(validateAccountName(name), name);
  }
});

test('validateAccountName rejects empty, dot-only, slash, traversal, whitespace, and unicode names', () => {
  for (const name of ['', '.', '..', '...', '../escaped', '..\\escaped', 'space name', 'name/json', 'emoji🙂']) {
    assert.throws(() => validateAccountName(name), /invalid account name/);
  }
});

test('accountPathForName stays inside accounts for valid names', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cx-validation-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const paths = getCodexPaths({ CODEX_HOME: home });

  const accountPath = accountPathForName(paths, 'prod.v1-a_b');
  assert.equal(dirname(accountPath), paths.accountsDir);
  assert.equal(accountPath, join(paths.accountsDir, 'prod.v1-a_b.json'));
});

test('path traversal names never write outside accounts', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cx-traversal-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const paths = getCodexPaths({ CODEX_HOME: home });
  await mkdir(paths.home, { recursive: true });
  await writeFile(paths.authFile, authPayload('live'));

  await assert.rejects(() => saveAccount('../escaped', { paths }), /invalid account name/);
  assert.equal(await exists(join(paths.home, 'escaped.json')), false);
  assert.equal(await exists(join(paths.accountsDir, '..', 'escaped.json')), false);
});
