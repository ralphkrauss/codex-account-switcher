# Security Policy

This package manages copies of Codex `auth.json` files. Treat all account JSON files as secrets.

## Supported versions

The latest published version receives fixes.

## Reporting vulnerabilities

Email Ralph Krauss at ralph@krauss.be. Do not open public issues containing credentials or exploit details.

## Handling secrets

- Never paste `auth.json` contents in issues, PRs, logs, or screenshots.
- `cx doctor` reports sizes and paths only; it should not print token contents.
- Stored account files are created with `0600` permissions on POSIX where supported.
