import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  HERMES_CODEX_BASE_URL,
  accountPathForName,
  getCodexPaths,
  getHermesPaths,
  inspectHermesStatus,
  syncHermesAccount,
  useHermesAccount,
} from '../index.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function makeSandbox(t: TestContext): Promise<{
  root: string;
  codexHome: string;
  hermesHome: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(join(tmpdir(), 'cx-hermes-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const codexHome = join(root, 'codex');
  const hermesHome = join(root, 'hermes');
  return {
    root,
    codexHome,
    hermesHome,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: codexHome,
      HERMES_HOME: hermesHome,
    },
  };
}

async function writeCodexAccount(env: NodeJS.ProcessEnv, account: string, tokens: Record<string, unknown>): Promise<string> {
  const paths = getCodexPaths(env);
  await mkdir(paths.accountsDir, { recursive: true });
  const accountFile = accountPathForName(paths, account);
  await writeFile(accountFile, `${JSON.stringify({ tokens, preserved: 'codex-metadata' }, null, 2)}\n`);
  return accountFile;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

test('useHermesAccount imports a cx account into Hermes auth and config', async (t) => {
  const sandbox = await makeSandbox(t);
  await writeCodexAccount(sandbox.env, 'gi', {
    access_token: 'cx-access',
    refresh_token: 'cx-refresh',
    scope: 'openid offline_access',
  });
  await mkdir(sandbox.hermesHome, { recursive: true });
  await writeFile(join(sandbox.hermesHome, 'auth.json'), `${JSON.stringify({
    version: 1,
    providers: { other: { untouched: true } },
    credential_pool: {
      'openai-codex': [
        {
          id: 'other-id',
          label: 'manual-other',
          source: 'manual:device_code',
          access_token: 'other-access',
          refresh_token: 'other-refresh',
          priority: 0,
        },
        {
          id: 'old-cx-id',
          label: 'cx:gi',
          source: 'manual:cx:gi',
          access_token: 'stale-access',
          refresh_token: 'stale-refresh',
          priority: 4,
          request_count: 7,
          last_status: 'dead',
          last_error_reason: 'token_invalidated',
        },
      ],
    },
  }, null, 2)}\n`);
  await writeFile(join(sandbox.hermesHome, 'config.yaml'), [
    'model:',
    '  default: gpt-5.5',
    '  provider: openrouter',
    '  api_key: stale-key',
    '  api_mode: chat_completions',
    'other: kept',
    '',
  ].join('\n'));

  const result = await useHermesAccount('gi', { env: sandbox.env });
  assert.equal(result.account, 'gi');
  assert.equal(result.hermesHome, sandbox.hermesHome);

  const auth = await readJson(join(sandbox.hermesHome, 'auth.json'));
  const providers = auth.providers as Record<string, unknown>;
  assert.deepEqual(providers.other, { untouched: true });
  const codexProvider = providers['openai-codex'] as Record<string, unknown>;
  assert.equal(codexProvider.auth_mode, 'chatgpt');
  assert.deepEqual(codexProvider.tokens, {
    access_token: 'cx-access',
    refresh_token: 'cx-refresh',
    scope: 'openid offline_access',
  });

  const pool = auth.credential_pool as Record<string, unknown[]>;
  const entries = pool['openai-codex'] as Record<string, unknown>[];
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.label, 'manual-other');
  const cxEntry = entries[1] as Record<string, unknown>;
  assert.equal(cxEntry.id, 'old-cx-id');
  assert.equal(cxEntry.label, 'cx:gi');
  assert.equal(cxEntry.source, 'manual:cx:gi');
  assert.equal(cxEntry.access_token, 'cx-access');
  assert.equal(cxEntry.refresh_token, 'cx-refresh');
  assert.equal(cxEntry.base_url, HERMES_CODEX_BASE_URL);
  assert.equal(cxEntry.priority, 4);
  assert.equal(cxEntry.request_count, 7);
  assert.equal(cxEntry.last_status, null);
  assert.equal(cxEntry.last_error_reason, null);

  const config = await readFile(join(sandbox.hermesHome, 'config.yaml'), 'utf8');
  assert.match(config, /model:\n/);
  assert.match(config, /  default: gpt-5\.5\n/);
  assert.match(config, /  provider: openai-codex\n/);
  assert.match(config, /  base_url: https:\/\/chatgpt\.com\/backend-api\/codex\n/);
  assert.doesNotMatch(config, /api_key:/);
  assert.doesNotMatch(config, /api_mode:/);
  assert.match(config, /other: kept/);

  const status = await inspectHermesStatus({ env: sandbox.env });
  assert.equal(status.openaiCodexAuthExists, true);
  assert.equal(status.hasAccessToken, true);
  assert.equal(status.hasRefreshToken, true);
  assert.equal(status.linkedAccount, 'gi');
  assert.equal(status.configuredProvider, 'openai-codex');

  if (process.platform !== 'win32') {
    assert.equal((await stat(join(sandbox.hermesHome, 'auth.json'))).mode & 0o777, 0o600);
  }
});

test('syncHermesAccount writes refreshed Hermes tokens back to the cx slot', async (t) => {
  const sandbox = await makeSandbox(t);
  const accountFile = await writeCodexAccount(sandbox.env, 'gi', {
    access_token: 'cx-access',
    refresh_token: 'cx-refresh',
  });

  await useHermesAccount('gi', { env: sandbox.env, updateConfig: false });
  const authFile = join(sandbox.hermesHome, 'auth.json');
  const auth = await readJson(authFile);
  const providers = auth.providers as Record<string, Record<string, unknown>>;
  providers['openai-codex'] = {
    ...providers['openai-codex'],
    tokens: {
      access_token: 'hermes-access-refreshed',
      refresh_token: 'hermes-refresh-refreshed',
      extra_token_field: 'preserved',
    },
  };
  await writeFile(authFile, `${JSON.stringify(auth, null, 2)}\n`);

  const result = await syncHermesAccount('gi', { env: sandbox.env });
  assert.equal(result.codexAccountFile, accountFile);

  const account = await readJson(accountFile);
  assert.equal(account.preserved, 'codex-metadata');
  assert.deepEqual(account.tokens, {
    access_token: 'hermes-access-refreshed',
    refresh_token: 'hermes-refresh-refreshed',
    extra_token_field: 'preserved',
  });
});

test('Hermes profile targeting ignores HERMES_HOME and can skip config writes', async (t) => {
  const sandbox = await makeSandbox(t);
  await writeCodexAccount(sandbox.env, 'work', {
    access_token: 'work-access',
    refresh_token: 'work-refresh',
  });

  const result = await useHermesAccount('work', {
    env: sandbox.env,
    profile: 'team',
    updateConfig: false,
  });
  const profilePaths = getHermesPaths({ env: sandbox.env, profile: 'team' });
  assert.equal(result.hermesHome, join(sandbox.root, '.hermes', 'profiles', 'team'));
  assert.equal(result.hermesAuthFile, profilePaths.authFile);
  assert.equal(result.hermesConfigFile, null);
  assert.equal(await exists(profilePaths.authFile), true);
  assert.equal(await exists(profilePaths.configFile), false);
  assert.equal(await exists(join(sandbox.hermesHome, 'auth.json')), false);

  const status = await inspectHermesStatus({ env: sandbox.env, profile: 'team' });
  assert.equal(status.profile, 'team');
  assert.deepEqual(status.linkedAccounts, ['work']);
});
