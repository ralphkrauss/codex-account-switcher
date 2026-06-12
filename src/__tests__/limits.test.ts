import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import {
  accountPathForName,
  getCodexPaths,
  inspectAccountLimits,
  inspectAllAccountLimits,
} from '../index.js';
import { main } from '../cli.js';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function startLimitsServer(t: TestContext): Promise<{ baseUrl: string; requests: Array<{ url: string; authorization: string | null; accountId: string | null }> }> {
  const requests: Array<{ url: string; authorization: string | null; accountId: string | null }> = [];
  const server = createServer(async (req, res: ServerResponse) => {
    await readBody(req);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      url: url.pathname + url.search,
      authorization: req.headers.authorization ?? null,
      accountId: typeof req.headers['chatgpt-account-id'] === 'string' ? req.headers['chatgpt-account-id'] : null,
    });
    if (url.pathname !== '/backend-api/wham/usage') {
      const notFound = '{"error":"not found"}\n';
      res.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(notFound), connection: 'close' });
      res.end(notFound);
      return;
    }
    const responseBody = `${JSON.stringify({
      email: 'work@example.test',
      plan_type: 'pro',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18000,
          reset_after_seconds: 3600,
          reset_at: 1781180161,
        },
        secondary_window: {
          used_percent: 75,
          limit_window_seconds: 604800,
          reset_after_seconds: 7200,
          reset_at: 1781800000,
        },
      },
      credits: {
        has_credits: true,
        unlimited: false,
        balance: '12.34',
      },
    })}\n`;
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(responseBody), connection: 'close' });
    res.end(responseBody);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
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
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function makeSandbox(t: TestContext): Promise<{ env: NodeJS.ProcessEnv; paths: ReturnType<typeof getCodexPaths>; server: Awaited<ReturnType<typeof startLimitsServer>> }> {
  const root = await mkdtemp(join(tmpdir(), 'cx-limits-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const server = await startLimitsServer(t);
  const env = {
    ...process.env,
    CODEX_HOME: join(root, 'codex'),
    CX_LIMITS_BASE_URL: server.baseUrl,
  };
  return { env, paths: getCodexPaths(env), server };
}

async function writeAccount(paths: ReturnType<typeof getCodexPaths>, account: string, auth: Record<string, unknown>): Promise<void> {
  await mkdir(paths.accountsDir, { recursive: true });
  await writeFile(accountPathForName(paths, account), `${JSON.stringify(auth, null, 2)}\n`);
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

test('inspectAccountLimits reads Codex usage windows from ChatGPT backend without exposing tokens', async (t) => {
  const sandbox = await makeSandbox(t);
  await writeAccount(sandbox.paths, 'work', {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'fake-codex-access-token',
      refresh_token: 'fake-codex-refresh-token',
      account_id: 'acct-work',
    },
  });

  const limits = await inspectAccountLimits('work', { paths: sandbox.paths, env: sandbox.env });
  assert.equal(limits.account, 'work');
  assert.equal(limits.email, 'work@example.test');
  assert.equal(limits.planType, 'pro');
  assert.equal(limits.primary?.usedPercent, 25);
  assert.equal(limits.primary?.remainingPercent, 75);
  assert.equal(limits.secondary?.usedPercent, 75);
  assert.equal(limits.credits?.balance, '12.34');
  assert.equal(JSON.stringify(limits).includes('fake-codex-access-token'), false);
  assert.equal(sandbox.server.requests[0]?.authorization, 'Bearer fake-codex-access-token');
  assert.equal(sandbox.server.requests[0]?.accountId, 'acct-work');
});

test('CLI limits --all --json emits machine-readable account usage without token strings', async (t) => {
  const sandbox = await makeSandbox(t);
  await writeAccount(sandbox.paths, 'alpha', {
    tokens: { access_token: 'alpha-access-token', account_id: 'acct-alpha' },
  });
  await writeAccount(sandbox.paths, 'beta', {
    tokens: { access_token: 'beta-access-token', account_id: 'acct-beta' },
  });

  const all = await inspectAllAccountLimits({ paths: sandbox.paths, env: sandbox.env });
  assert.deepEqual(all.map((entry) => entry.account), ['alpha', 'beta']);

  const result = await runCli(['limits', '--all', '--json'], sandbox.env);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /alpha-access-token|beta-access-token/u);
  const parsed = JSON.parse(result.stdout) as Array<{ account: string; primary?: { remainingPercent: number } }>;
  assert.deepEqual(parsed.map((entry) => entry.account), ['alpha', 'beta']);
  assert.equal(parsed[0]?.primary?.remainingPercent, 75);
});
