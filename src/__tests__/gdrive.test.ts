import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import {
  accountPathForName,
  finishGoogleDriveOAuth,
  getCodexPaths,
  getRemoteConfigPath,
  inspectRemoteStatus,
  inspectSyncStatus,
  readRemoteConfig,
  startGoogleDriveOAuth,
  syncPullAccount,
  syncPushAccount,
} from '../index.js';
import { main } from '../cli.js';

interface GDriveSandbox {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly paths: ReturnType<typeof getCodexPaths>;
  readonly server: FakeGoogleServer;
  readonly clientSecretFile: string;
}

interface FakeGoogleServer {
  readonly baseUrl: string;
  readonly tokenUrl: string;
  readonly files: Map<string, { id: string; name: string; body: string }>;
  readonly requests: Array<{ method: string; url: string; authorization: string | null; body: string }>;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, value: unknown, status = 200): void {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  });
  res.end(body);
}

function extractMultipartJson(body: string): { metadata: Record<string, unknown>; media: string } {
  const matches = [...body.matchAll(/\r?\n\r?\n([\s\S]*?)(?=\r?\n--)/gu)].map((match) => match[1]?.trim() ?? '');
  assert.ok(matches.length >= 2, `expected multipart metadata+media, got ${body}`);
  return {
    metadata: JSON.parse(matches[0] ?? '{}') as Record<string, unknown>,
    media: matches[1] ?? '',
  };
}

async function startFakeGoogleServer(t: TestContext): Promise<FakeGoogleServer> {
  const files = new Map<string, { id: string; name: string; body: string }>();
  const requests: FakeGoogleServer['requests'] = [];
  let nextId = 1;
  let server: Server;

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readBody(req);
    requests.push({
      method: req.method ?? 'GET',
      url: url.pathname + url.search,
      authorization: req.headers.authorization ?? null,
      body,
    });

    if (url.pathname === '/token' && req.method === 'POST') {
      assert.match(body, /grant_type=authorization_code/u);
      assert.match(body, /code=auth-code/u);
      return sendJson(res, {
        access_token: 'fake-google-access',
        refresh_token: 'fake-google-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'https://www.googleapis.com/auth/drive.appdata',
      });
    }

    if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
      return sendJson(res, {
        files: [...files.values()].map((file) => ({ id: file.id, name: file.name })),
      });
    }

    if (url.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
      const parsed = extractMultipartJson(body);
      const name = String(parsed.metadata.name ?? 'missing-name');
      const id = `file-${nextId++}`;
      files.set(name, { id, name, body: parsed.media });
      return sendJson(res, { id, name });
    }

    const updateMatch = /^\/upload\/drive\/v3\/files\/([^/]+)$/u.exec(url.pathname);
    if (updateMatch && req.method === 'PATCH') {
      const id = updateMatch[1] ?? '';
      const existing = [...files.values()].find((file) => file.id === id);
      assert.ok(existing, `expected existing file for ${id}`);
      const parsed = extractMultipartJson(body);
      existing.body = parsed.media;
      return sendJson(res, { id: existing.id, name: existing.name });
    }

    const readMatch = /^\/drive\/v3\/files\/([^/]+)$/u.exec(url.pathname);
    if (readMatch && req.method === 'GET' && url.searchParams.get('alt') === 'media') {
      const id = readMatch[1] ?? '';
      const existing = [...files.values()].find((file) => file.id === id);
      if (!existing) {
        return sendJson(res, { error: 'not found' }, 404);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(existing.body);
      return;
    }

    return sendJson(res, { error: `unexpected ${req.method} ${url.pathname}` }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  function closeServer(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 100);
      server.close(() => done());
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
    });
  }
  t.after(closeServer);

  return {
    baseUrl,
    tokenUrl: `${baseUrl}/token`,
    files,
    requests,
    close: closeServer,
  };
}

async function makeSandbox(t: TestContext): Promise<GDriveSandbox> {
  const root = await mkdtemp(join(tmpdir(), 'cx-gdrive-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const server = await startFakeGoogleServer(t);
  const clientSecretFile = join(root, 'client-secret.json');
  await writeFile(clientSecretFile, `${JSON.stringify({
    installed: {
      client_id: 'fake-google-client-id',
      client_secret: 'fake-google-client-secret',
      redirect_uris: ['http://localhost'],
    },
  }, null, 2)}\n`);
  const env = {
    ...process.env,
    CODEX_HOME: join(root, 'codex'),
    CX_GDRIVE_TOKEN_URL: server.tokenUrl,
    CX_GDRIVE_API_BASE_URL: server.baseUrl,
  };
  return { root, env, paths: getCodexPaths(env), server, clientSecretFile };
}

class CaptureStream extends Writable {
  readonly chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    callback();
  }

  text(): string {
    return this.chunks.join('');
  }
}

async function runCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ status: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const status = await main(args, env, { stdout, stderr });
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}

async function writeAccount(paths: ReturnType<typeof getCodexPaths>, account: string, authJson: string): Promise<string> {
  await mkdir(paths.accountsDir, { recursive: true });
  const accountFile = accountPathForName(paths, account);
  await writeFile(accountFile, authJson);
  return accountFile;
}

test('Google Drive OAuth paste-code setup writes private config/token files and syncs profiles', async (t) => {
  const sandbox = await makeSandbox(t);

  const start = await startGoogleDriveOAuth({ clientSecretFile: sandbox.clientSecretFile }, { paths: sandbox.paths, env: sandbox.env });
  assert.match(start.authUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/u);
  assert.match(start.authUrl, /code_challenge=/u);
  assert.match(start.authUrl, /https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fdrive\.appdata/u);
  assert.equal(start.storage, 'appDataFolder');
  assert.equal(start.folderId, null);
  assert.equal(start.encryption, 'none');
  if (process.platform !== 'win32') {
    assert.equal((await stat(start.pendingFile)).mode & 0o777, 0o600);
  }

  const configured = await finishGoogleDriveOAuth(`http://localhost/?code=auth-code&state=${start.state}`, { paths: sandbox.paths, env: sandbox.env });
  assert.equal(configured.config.backend, 'gdrive');
  assert.equal(configured.config.storage, 'appDataFolder');
  assert.equal(configured.config.filePrefix, 'cx-');
  assert.deepEqual(await readRemoteConfig({ paths: sandbox.paths }), configured.config);
  const configRaw = await readFile(getRemoteConfigPath(sandbox.paths), 'utf8');
  assert.doesNotMatch(configRaw, /fake-google-access|fake-google-refresh|fake-google-client-secret/u);
  if (process.platform !== 'win32') {
    assert.equal((await stat(configured.configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(configured.config.tokenFile)).mode & 0o777, 0o600);
  }

  const firstAuth = `${JSON.stringify({ tokens: { access_token: 'codex-access-1', refresh_token: 'codex-refresh-1' }, account: 'work' }, null, 2)}\n`;
  const accountFile = await writeAccount(sandbox.paths, 'work', firstAuth);
  const pushed = await syncPushAccount('work', { paths: sandbox.paths, env: sandbox.env });
  assert.equal(pushed.backend, 'gdrive');
  assert.equal(pushed.item, 'cx-work.json');
  assert.equal(pushed.operation, 'created');
  assert.ok(sandbox.server.files.get('cx-work.json')?.body.includes('codex-access-1'));

  await rm(accountFile);
  const pulled = await syncPullAccount('work', { paths: sandbox.paths, env: sandbox.env });
  assert.equal(pulled.backend, 'gdrive');
  assert.equal(pulled.overwritten, false);
  assert.equal(await readFile(accountFile, 'utf8'), firstAuth);

  const status = await inspectSyncStatus('work', { paths: sandbox.paths, env: sandbox.env });
  assert.equal(status.backend, 'gdrive');
  assert.equal(status.opAvailable, false);
  assert.equal(status.accounts[0]?.remote.presence, 'present');
});

test('Google Drive env encryption keeps remote file bodies free of Codex token strings', async (t) => {
  const sandbox = await makeSandbox(t);
  const env = { ...sandbox.env, CX_GDRIVE_ENCRYPTION_KEY: 'shared-test-key' };
  const start = await startGoogleDriveOAuth({ clientSecretFile: sandbox.clientSecretFile, encryption: 'env' }, { paths: sandbox.paths, env });
  await finishGoogleDriveOAuth(`http://localhost/?code=auth-code&state=${start.state}`, { paths: sandbox.paths, env });

  const authJson = `${JSON.stringify({ tokens: { access_token: 'VERY_SECRET_CODEX_ACCESS', refresh_token: 'VERY_SECRET_CODEX_REFRESH' }, account: 'work' }, null, 2)}\n`;
  const accountFile = await writeAccount(sandbox.paths, 'work', authJson);
  await syncPushAccount('work', { paths: sandbox.paths, env });

  const remoteBody = sandbox.server.files.get('cx-work.json')?.body ?? '';
  assert.doesNotMatch(remoteBody, /VERY_SECRET_CODEX_ACCESS|VERY_SECRET_CODEX_REFRESH/u);
  assert.match(remoteBody, /encryptedAuthJson/u);

  await rm(accountFile);
  await syncPullAccount('work', { paths: sandbox.paths, env });
  assert.equal(await readFile(accountFile, 'utf8'), authJson);
});

test('CLI backend setup gdrive oauth supports auth-url and auth-code paste flow', async (t) => {
  const sandbox = await makeSandbox(t);

  const authUrl = await runCli(['backend', 'setup', 'gdrive', 'oauth', '--client-secret', sandbox.clientSecretFile, '--auth-url'], sandbox.env);
  assert.equal(authUrl.status, 0, authUrl.stderr);
  assert.match(authUrl.stdout, /Google Drive authorization URL:/u);
  const state = /state=([^&\s]+)/u.exec(authUrl.stdout)?.[1];
  assert.ok(state, authUrl.stdout);

  const authCode = await runCli(['backend', 'setup', 'gdrive', 'oauth', '--auth-code', `http://localhost/?code=auth-code&state=${state}`], sandbox.env);
  assert.equal(authCode.status, 0, authCode.stderr);
  assert.match(authCode.stdout, /configured Google Drive-backed Codex profiles/u);
  const config = await readRemoteConfig({ paths: sandbox.paths });
  assert.equal(config?.backend, 'gdrive');
});
