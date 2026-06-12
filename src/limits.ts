import { readFile } from 'node:fs/promises';
import {
  CxError,
  accountPathForName,
  getCodexPaths,
  listAccountNames,
  validateAccountName,
  type CodexPaths,
} from './accounts.js';

export interface LimitsOptions {
  readonly paths?: CodexPaths;
  readonly env?: NodeJS.ProcessEnv;
}

export interface UsageWindow {
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly windowDurationSeconds: number | null;
  readonly resetAfterSeconds: number | null;
  readonly resetsAt: number | null;
}

export interface CreditsUsage {
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
  readonly balance: string | null;
}

export interface AccountLimits {
  readonly account: string;
  readonly email: string | null;
  readonly planType: string | null;
  readonly allowed: boolean | null;
  readonly limitReached: boolean | null;
  readonly primary: UsageWindow | null;
  readonly secondary: UsageWindow | null;
  readonly credits: CreditsUsage | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function endpointBase(env: NodeJS.ProcessEnv): string {
  return (env.CX_LIMITS_BASE_URL ?? 'https://chatgpt.com').replace(/\/+$/u, '');
}

function usageEndpoint(env: NodeJS.ProcessEnv): string {
  const base = endpointBase(env);
  return base.endsWith('/backend-api') ? `${base}/wham/usage` : `${base}/backend-api/wham/usage`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseWindow(value: unknown): UsageWindow | null {
  if (!isRecord(value)) {
    return null;
  }
  const usedPercent = numberOrNull(value.used_percent);
  if (usedPercent === null) {
    return null;
  }
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowDurationSeconds: numberOrNull(value.limit_window_seconds),
    resetAfterSeconds: numberOrNull(value.reset_after_seconds),
    resetsAt: numberOrNull(value.reset_at),
  };
}

function parseCredits(value: unknown): CreditsUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    hasCredits: value.has_credits === true,
    unlimited: value.unlimited === true,
    balance: typeof value.balance === 'string' ? value.balance : null,
  };
}

function tokenInfo(authJson: string, accountFile: string): { accessToken: string; accountId: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson) as unknown;
  } catch (error) {
    throw new CxError(`Codex account at ${accountFile} is not valid JSON: ${errorMessage(error)}`, 1);
  }
  if (!isRecord(parsed) || !isRecord(parsed.tokens) || typeof parsed.tokens.access_token !== 'string') {
    throw new CxError(`Codex account at ${accountFile} does not contain tokens.access_token`, 1);
  }
  return {
    accessToken: parsed.tokens.access_token,
    accountId: typeof parsed.tokens.account_id === 'string' ? parsed.tokens.account_id : null,
  };
}

export async function inspectAccountLimits(account: string, options: LimitsOptions = {}): Promise<AccountLimits> {
  const env = options.env ?? process.env;
  const paths = options.paths ?? getCodexPaths(env);
  const safeAccount = validateAccountName(account);
  const accountFile = accountPathForName(paths, safeAccount);
  const { accessToken, accountId } = tokenInfo(await readFile(accountFile, 'utf8'), accountFile);
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    'user-agent': 'codex-cli',
  };
  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId;
  }
  const response = await fetch(usageEndpoint(env), { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new CxError(`reading Codex usage limits for '${safeAccount}' failed: HTTP ${response.status}; ${text.slice(0, 500)}`, 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CxError(`Codex usage limits response for '${safeAccount}' was not valid JSON: ${errorMessage(error)}`, 1);
  }
  if (!isRecord(parsed)) {
    throw new CxError(`Codex usage limits response for '${safeAccount}' was not an object`, 1);
  }
  const rateLimit = isRecord(parsed.rate_limit) ? parsed.rate_limit : null;
  return {
    account: safeAccount,
    email: typeof parsed.email === 'string' ? parsed.email : null,
    planType: typeof parsed.plan_type === 'string' ? parsed.plan_type : null,
    allowed: rateLimit ? rateLimit.allowed === true : null,
    limitReached: rateLimit ? rateLimit.limit_reached === true : null,
    primary: rateLimit ? parseWindow(rateLimit.primary_window) : null,
    secondary: rateLimit ? parseWindow(rateLimit.secondary_window) : null,
    credits: parseCredits(parsed.credits),
  };
}

export async function inspectAllAccountLimits(options: LimitsOptions = {}): Promise<AccountLimits[]> {
  const env = options.env ?? process.env;
  const paths = options.paths ?? getCodexPaths(env);
  const accounts = (await listAccountNames(paths)).filter((name) => name !== 'default');
  const results: AccountLimits[] = [];
  for (const account of accounts) {
    results.push(await inspectAccountLimits(account, { paths, env }));
  }
  return results;
}
