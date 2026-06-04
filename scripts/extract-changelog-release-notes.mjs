#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function fail(message) {
  console.error(`[release-notes] ${message}`);
  process.exit(1);
}

async function readPackageVersion() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const version = String(pkg.version ?? '').trim();
  if (!version) {
    fail('package.json does not contain a version');
  }
  return version;
}

function versionHeadingCandidates(version) {
  const normalized = version.startsWith('v') ? version.slice(1) : version;
  return new Set([
    normalized,
    `v${normalized}`,
    `[${normalized}]`,
    `[v${normalized}]`,
  ]);
}

function extractReleaseNotes(changelog, version) {
  const candidates = versionHeadingCandidates(version);
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  let start = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const headingMatch = /^##\s+(.+?)\s*$/.exec(lines[index] ?? '');
    if (!headingMatch) {
      continue;
    }

    const headingTitle = headingMatch[1]?.split(/\s+-\s+/u)[0]?.trim() ?? '';
    if (candidates.has(headingTitle)) {
      start = index;
      break;
    }
  }

  if (start === -1) {
    fail(`Could not find a CHANGELOG.md section for version ${version}`);
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] ?? '')) {
      end = index;
      break;
    }
  }

  const notes = lines.slice(start + 1, end).join('\n').trim();
  if (!notes) {
    fail(`CHANGELOG.md section for version ${version} is empty`);
  }

  return `${notes}\n`;
}

const version = process.argv[2] ? String(process.argv[2]).trim() : await readPackageVersion();
const changelogPath = process.argv[3]
  ? resolve(process.argv[3])
  : new URL('../CHANGELOG.md', import.meta.url);
const changelog = await readFile(changelogPath, 'utf8');

process.stdout.write(extractReleaseNotes(changelog, version));
