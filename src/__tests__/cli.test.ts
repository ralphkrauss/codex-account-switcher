import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));

function authPayload(label: string): string {
  return `${JSON.stringify({ label, filler: 'x'.repeat(180) })}\n`;
}

async function makeHome(t: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'cx-cli-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

function runCli(args: readonly string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env,
    encoding: 'utf8',
  });
}

async function runCliWithOpenStdin(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 3_000): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`cx timed out; stdout=${stdout}; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function writeFakeCodex(path: string): Promise<void> {
  await writeNodeFakeCodex(path, `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(process.env.CODEX_ARGS_FILE, args.join('\\n') + (args.length ? '\\n' : ''));
`);
}

async function readNormalized(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
}

test('cx --help prints usage', async (t) => {
  const home = await makeHome(t);
  const result = runCli(['--help'], { ...process.env, CODEX_HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /cx save <name>/);
});

test('cx entrypoint runs when invoked through a package-bin symlink', async (t) => {
  const home = await makeHome(t);
  const bin = join(home, 'bin');
  const link = join(bin, process.platform === 'win32' ? 'cx.js' : 'cx');
  await mkdir(bin, { recursive: true });
  await symlink(cliPath, link);

  const result = spawnSync(process.execPath, [link, '--help'], {
    env: { ...process.env, CODEX_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});

test('cx --version prints package version', async (t) => {
  const home = await makeHome(t);
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version: string };
  const result = runCli(['--version'], { ...process.env, CODEX_HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageJson.version);
});

test('cx doctor and doctor --json are safe on an empty CODEX_HOME', async (t) => {
  const home = await makeHome(t);
  const text = runCli(['doctor'], { ...process.env, CODEX_HOME: home });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Codex Account Switcher doctor/);
  assert.match(text.stdout, /auth\.json: missing/);
  assert.doesNotMatch(text.stdout, /filler/);

  const json = runCli(['doctor', '--json'], { ...process.env, CODEX_HOME: home });
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout) as { codexHome: string; authJson: { exists: boolean } };
  assert.equal(report.codexHome, home);
  assert.equal(report.authJson.exists, false);
});

test('cx with no auth shows help and account guidance instead of launching codex', async (t) => {
  const home = await makeHome(t);
  const result = runCli([], { ...process.env, CODEX_HOME: home, PATH: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No live auth\.json found/);
  assert.match(result.stdout, /cx use <name>/);
});

test('backward cx <account> switches then launches codex with remaining args', async (t) => {
  const home = await makeHome(t);
  const bin = join(home, 'bin');
  const argsFile = join(home, 'codex-args.txt');
  const fakeCodex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await mkdir(join(home, 'accounts'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(home, 'accounts', 'work.json'), authPayload('work-account'));
  await writeFakeCodex(fakeCodex);

  const result = runCli(['work', 'exec', 'hello'], {
    ...process.env,
    CODEX_HOME: home,
    CODEX_ARGS_FILE: argsFile,
    PATH: [bin, process.env.PATH ?? ''].join(delimiter),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /→ codex on 'work'/);
  assert.equal(await readNormalized(argsFile), 'exec\nhello\n');
  assert.match(await readFile(join(home, 'auth.json'), 'utf8'), /work-account/);
  assert.equal((await readFile(join(home, '.current-account'), 'utf8')).trim(), 'work');
});

test('cx run -- uses the current auth and passes codex args after the separator', async (t) => {
  const home = await makeHome(t);
  const bin = join(home, 'bin');
  const argsFile = join(home, 'codex-args.txt');
  const fakeCodex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await mkdir(bin, { recursive: true });
  await writeFile(join(home, 'auth.json'), authPayload('current-live'));
  await writeFakeCodex(fakeCodex);

  const result = runCli(['run', '--', 'exec', 'prompt'], {
    ...process.env,
    CODEX_HOME: home,
    CODEX_ARGS_FILE: argsFile,
    PATH: [bin, process.env.PATH ?? ''].join(delimiter),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readNormalized(argsFile), 'exec\nprompt\n');
});

test('cx resume forwards to codex resume with the current auth', async (t) => {
  const home = await makeHome(t);
  const bin = join(home, 'bin');
  const argsFile = join(home, 'codex-resume-args.txt');
  const fakeCodex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await mkdir(bin, { recursive: true });
  await writeFile(join(home, 'auth.json'), authPayload('current-live'));
  await writeFakeCodex(fakeCodex);

  const result = runCli(['resume', '019ea2b1-5d71-7d30-b625-f43158d13be8', 'follow up'], {
    ...process.env,
    CODEX_HOME: home,
    CODEX_ARGS_FILE: argsFile,
    PATH: [bin, process.env.PATH ?? ''].join(delimiter),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readNormalized(argsFile), 'resume\n019ea2b1-5d71-7d30-b625-f43158d13be8\nfollow up\n');
});

test('cx resume forwards Codex resume flags without requiring -- separator', async (t) => {
  const home = await makeHome(t);
  const bin = join(home, 'bin');
  const argsFile = join(home, 'codex-resume-last-args.txt');
  const fakeCodex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await mkdir(bin, { recursive: true });
  await writeFile(join(home, 'auth.json'), authPayload('current-live'));
  await writeFakeCodex(fakeCodex);

  const result = runCli(['resume', '--last', '--include-non-interactive'], {
    ...process.env,
    CODEX_HOME: home,
    CODEX_ARGS_FILE: argsFile,
    PATH: [bin, process.env.PATH ?? ''].join(delimiter),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readNormalized(argsFile), 'resume\n--last\n--include-non-interactive\n');
});

test('cx login forwards Codex login flags such as --device-auth', async (t) => {
  const home = await makeHome(t);
  const bin = join(home, 'bin');
  const argsFile = join(home, 'codex-login-args.txt');
  const fakeCodex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await mkdir(bin, { recursive: true });

  const loginJson = JSON.stringify({ label: 'device-login', filler: 'x'.repeat(180) });
  await writeNodeFakeCodex(fakeCodex, `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(process.env.CODEX_ARGS_FILE, args.join('\\n') + (args.length ? '\\n' : ''));
if (args[0] === 'login') {
  writeFileSync(process.env.CODEX_HOME + '/auth.json', ${JSON.stringify(`${loginJson}\n`)});
  process.exit(0);
}
process.exit(42);
`);

  const result = runCli(['login', 'personal', '--device-auth'], {
    ...process.env,
    CODEX_HOME: home,
    CODEX_ARGS_FILE: argsFile,
    PATH: [bin, process.env.PATH ?? ''].join(delimiter),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readNormalized(argsFile), 'login\n--device-auth\n');
  assert.match(await readFile(join(home, 'accounts', 'personal.json'), 'utf8'), /device-login/);
  assert.equal((await readFile(join(home, '.current-account'), 'utf8')).trim(), 'personal');
});

async function writeNodeFakeCodex(bin: string, script: string): Promise<void> {
  const scriptFile = `${bin}.mjs`;
  await writeFile(scriptFile, script);
  const wrapper = process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${scriptFile}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${scriptFile}' "${'$'}@"\n`;
  await writeFile(bin, wrapper);
  await chmod(bin, 0o755);
}

test('cx run --account uses an isolated CODEX_HOME and does not mutate shared auth state', async (t) => {
  const home = await makeHome(t);
  const bin = join(home, 'bin');
  const argsFile = join(home, 'isolated-args.txt');
  const childHomeFile = join(home, 'child-codex-home.txt');
  const childAuthFile = join(home, 'child-auth-copy.json');
  const fakeCodex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await mkdir(join(home, 'accounts'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(home, 'auth.json'), authPayload('shared-live'));
  await writeFile(join(home, '.current-account'), 'personal\n');
  await writeFile(join(home, 'accounts', 'work.json'), authPayload('work-account'));
  await writeFile(join(home, 'accounts', 'personal.json'), authPayload('personal-account'));
  await writeNodeFakeCodex(fakeCodex, `
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.CODEX_ARGS_FILE, process.argv.slice(2).join('\\n') + '\\n');
writeFileSync(process.env.CHILD_CODEX_HOME_FILE, process.env.CODEX_HOME + '\\n');
writeFileSync(process.env.CHILD_AUTH_COPY_FILE, readFileSync(process.env.CODEX_HOME + '/auth.json', 'utf8'));
writeFileSync(process.env.CODEX_HOME + '/auth.json', JSON.stringify({ label: 'work-refreshed', filler: 'x'.repeat(180) }) + '\\n');
`);

  const result = runCli(['run', '--account', 'work', '--', 'exec', 'prompt'], {
    ...process.env,
    CODEX_HOME: home,
    CODEX_ARGS_FILE: argsFile,
    CHILD_CODEX_HOME_FILE: childHomeFile,
    CHILD_AUTH_COPY_FILE: childAuthFile,
    PATH: [bin, process.env.PATH ?? ''].join(delimiter),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readNormalized(argsFile), 'exec\nprompt\n');
  const childHome = (await readFile(childHomeFile, 'utf8')).trim();
  assert.notEqual(childHome, home);
  assert.match(await readFile(childAuthFile, 'utf8'), /work-account/);
  assert.match(await readFile(join(home, 'auth.json'), 'utf8'), /shared-live/);
  assert.equal((await readFile(join(home, '.current-account'), 'utf8')).trim(), 'personal');
  assert.match(await readFile(join(home, 'accounts', 'work.json'), 'utf8'), /work-refreshed/);
});

test('cx run closes child stdin by default when cx stdin is not a TTY', async (t) => {
  const home = await makeHome(t);
  const bin = join(home, 'bin');
  const marker = join(home, 'stdin-marker.txt');
  const fakeCodex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await mkdir(bin, { recursive: true });
  await writeFile(join(home, 'auth.json'), authPayload('current-live'));
  await writeNodeFakeCodex(fakeCodex, `
import { writeFileSync } from 'node:fs';
process.stdin.resume();
process.stdin.on('end', () => { writeFileSync(process.env.STDIN_MARKER, 'closed'); process.exit(0); });
setTimeout(() => { writeFileSync(process.env.STDIN_MARKER, 'still-open'); process.exit(70); }, 600);
`);

  const result = await runCliWithOpenStdin(['run', '--', 'exec', 'prompt'], {
    ...process.env,
    CODEX_HOME: home,
    STDIN_MARKER: marker,
    PATH: [bin, process.env.PATH ?? ''].join(delimiter),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(marker, 'utf8'), 'closed');
});

test('cx run --no-stdin explicitly closes child stdin', async (t) => {
  const home = await makeHome(t);
  const bin = join(home, 'bin');
  const marker = join(home, 'no-stdin-marker.txt');
  const fakeCodex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await mkdir(bin, { recursive: true });
  await writeFile(join(home, 'auth.json'), authPayload('current-live'));
  await writeNodeFakeCodex(fakeCodex, `
import { writeFileSync } from 'node:fs';
process.stdin.resume();
process.stdin.on('end', () => { writeFileSync(process.env.STDIN_MARKER, 'closed'); process.exit(0); });
setTimeout(() => { writeFileSync(process.env.STDIN_MARKER, 'still-open'); process.exit(70); }, 600);
`);

  const result = await runCliWithOpenStdin(['run', '--no-stdin', '--', 'exec', 'prompt'], {
    ...process.env,
    CODEX_HOME: home,
    STDIN_MARKER: marker,
    PATH: [bin, process.env.PATH ?? ''].join(delimiter),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(marker, 'utf8'), 'closed');
});

test('cx run --timeout kills the child process group and exits 124', async (t) => {
  if (process.platform === 'win32') {
    t.skip('process-group timeout semantics are POSIX-only in this regression test');
    return;
  }
  const home = await makeHome(t);
  const bin = join(home, 'bin');
  const marker = join(home, 'timeout-survivor.txt');
  const fakeCodex = join(bin, 'codex');
  await mkdir(bin, { recursive: true });
  await writeFile(join(home, 'auth.json'), authPayload('current-live'));
  await writeNodeFakeCodex(fakeCodex, `
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync(process.env.TIMEOUT_MARKER, 'survived'), 1600)"], { env: process.env, stdio: 'ignore' });
setInterval(() => {}, 10_000);
`);

  const result = runCli(['run', '--timeout', '1', '--', 'exec', 'prompt'], {
    ...process.env,
    CODEX_HOME: home,
    TIMEOUT_MARKER: marker,
    PATH: [bin, process.env.PATH ?? ''].join(delimiter),
  });

  assert.equal(result.status, 124, result.stderr);
  await delay(2_000);
  assert.equal(existsSync(marker), false, 'child process survived timeout process-group kill');
});

test('cx run maps Codex rate-limit failures to a distinct exit code', async (t) => {
  const home = await makeHome(t);
  const bin = join(home, 'bin');
  const fakeCodex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await mkdir(bin, { recursive: true });
  await writeFile(join(home, 'auth.json'), authPayload('current-live'));
  await writeNodeFakeCodex(fakeCodex, `
process.stderr.write('usage limit reached: retry later\\n');
process.exit(1);
`);

  const result = runCli(['run', '--', 'exec', 'prompt'], {
    ...process.env,
    CODEX_HOME: home,
    PATH: [bin, process.env.PATH ?? ''].join(delimiter),
  });

  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /usage limit reached/u);
});
