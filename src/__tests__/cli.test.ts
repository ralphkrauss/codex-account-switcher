import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
  const fakeCodex = join(bin, 'codex');
  await mkdir(join(home, 'accounts'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(home, 'accounts', 'work.json'), authPayload('work-account'));
  await writeFile(fakeCodex, `#!/bin/sh\nprintf '%s\\n' "${'$'}@" > "${'$'}CODEX_ARGS_FILE"\n`);
  await chmod(fakeCodex, 0o755);

  const result = runCli(['work', 'exec', 'hello'], {
    ...process.env,
    CODEX_HOME: home,
    CODEX_ARGS_FILE: argsFile,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /→ codex on 'work'/);
  assert.equal(await readFile(argsFile, 'utf8'), 'exec\nhello\n');
  assert.match(await readFile(join(home, 'auth.json'), 'utf8'), /work-account/);
  assert.equal((await readFile(join(home, '.current-account'), 'utf8')).trim(), 'work');
});

test('cx run -- uses the current auth and passes codex args after the separator', async (t) => {
  const home = await makeHome(t);
  const bin = join(home, 'bin');
  const argsFile = join(home, 'codex-args.txt');
  const fakeCodex = join(bin, 'codex');
  await mkdir(bin, { recursive: true });
  await writeFile(join(home, 'auth.json'), authPayload('current-live'));
  await writeFile(fakeCodex, `#!/bin/sh\nprintf '%s\\n' "${'$'}@" > "${'$'}CODEX_ARGS_FILE"\n`);
  await chmod(fakeCodex, 0o755);

  const result = runCli(['run', '--', 'exec', 'prompt'], {
    ...process.env,
    CODEX_HOME: home,
    CODEX_ARGS_FILE: argsFile,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(argsFile, 'utf8'), 'exec\nprompt\n');
});
