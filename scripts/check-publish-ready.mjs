#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const licenseText = await readFile(new URL('../LICENSE.md', import.meta.url), 'utf8');

const failures = [];

if (packageJson.license === 'UNLICENSED') {
  failures.push('package.json still has "license": "UNLICENSED". Choose a public license before publishing.');
}

if (licenseText.includes('License Not Selected')) {
  failures.push('LICENSE.md is still the placeholder file. Replace it with the selected license text before publishing.');
}

if (packageJson.private === true) {
  failures.push('package.json has private=true. Remove it before publishing.');
}

if (!String(packageJson.repository?.url ?? '').startsWith('git+https://github.com/')) {
  failures.push('package.json repository.url should use git+https://github.com/... for npm trusted publishing.');
}

if (!packageJson.types) {
  failures.push('package.json is missing a top-level "types" entry.');
}

if (!packageJson.bin?.cx) {
  failures.push('package.json is missing the cx bin entry.');
}

if (packageJson.publishConfig?.access !== 'public') {
  failures.push('package.json publishConfig.access should be "public" for the scoped public package.');
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[publish-ready] ${failure}`);
  }
  process.exit(1);
}

console.log('[publish-ready] package metadata is ready for publish');
