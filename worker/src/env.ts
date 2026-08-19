// ABOUTME: Worker bindings, secrets and vars, plus the derived per-request context
// ABOUTME: Single source of truth for what wrangler.jsonc has to provide

import type { JournalToken } from './auth/tokens.js';

export interface Env {
  /** D1 database holding entries, sections and OAuth state. */
  DB: D1Database;
  /** JSON array of `{ label, token, project? }`. */
  JOURNAL_TOKENS?: string;
  /** Single-token shorthand; label defaults to `default`. */
  JOURNAL_TOKEN?: string;
  /** HMAC key for session cookies, CSRF tokens and OAuth access tokens. */
  SESSION_SECRET: string;
  /** IANA timezone for `local_date` and rendered titles. */
  JOURNAL_TZ?: string;
  /** Optional rate limiting binding; failed logins and token exchanges use it. */
  LOGIN_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
}

/** Variables Hono carries between middleware and handlers. */
export interface Variables {
  /** The token this request authenticated as. */
  token: JournalToken;
}

export type AppEnv = { Bindings: Env; Variables: Variables };

export const DEFAULT_TIMEZONE = 'Europe/Berlin';

export function journalTimeZone(env: Env): string {
  return env.JOURNAL_TZ && env.JOURNAL_TZ.length > 0 ? env.JOURNAL_TZ : DEFAULT_TIMEZONE;
}
