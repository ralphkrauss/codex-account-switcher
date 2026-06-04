#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const version = String(pkg.version ?? '');
const semver = /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const match = semver.exec(version);

if (!match) {
  console.error(`[publish-tag] package.json version is not valid semver: ${version}`);
  process.exit(1);
}

const tag = match.groups?.prerelease ? 'next' : 'latest';
console.log(`tag=${tag}`);
console.error(`[publish-tag] ${pkg.name}@${version} will publish with npm dist-tag ${tag}`);
