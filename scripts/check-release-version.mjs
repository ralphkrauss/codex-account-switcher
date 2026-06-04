#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const eventName = process.env.GITHUB_EVENT_NAME ?? '';
const refType = process.env.GITHUB_REF_TYPE ?? '';
const refName = process.env.GITHUB_REF_NAME ?? '';
const expectedTag = `v${pkg.version}`;

if (eventName === 'workflow_dispatch') {
  console.log(`[release-version] manual dispatch for ${pkg.name}@${pkg.version}`);
  process.exit(0);
}

if (refType !== 'tag') {
  console.error(`[release-version] publish workflow must run from a tag or manual dispatch; got ${refType || 'unknown'} ${refName || ''}`.trim());
  process.exit(1);
}

if (refName !== expectedTag) {
  console.error(`[release-version] tag ${refName} does not match package.json version ${pkg.version}; expected ${expectedTag}`);
  process.exit(1);
}

console.log(`[release-version] ${pkg.name}@${pkg.version} matches ${refName}`);
