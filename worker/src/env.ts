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
  /** HMAC root key; session cookies, CSRF tokens and OAuth access tokens each derive a subkey from it. */
  SESSION_SECRET: string;
  /**
   * Canonical `https://host` this deployment is reached under. Pinning it keeps
   * the OAuth issuer and audience from following an unexpected `Host` header.
   * Unset means "derive from the request", which is fine for a single hostname.
   */
  PUBLIC_ORIGIN?: string;
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

/**
 * Shortest credential this server will honour. Journal tokens and the session
 * secret are bearer credentials with no second factor behind them, so a short
 * one is refused outright rather than quietly accepted — `openssl rand -base64 32`
 * is what the README asks for.
 */
export const MIN_SECRET_LENGTH = 24;

/** `true` when `SESSION_SECRET` is present and long enough to sign with. */
export function hasUsableSessionSecret(env: Env): boolean {
  return typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET.length >= MIN_SECRET_LENGTH;
}

export function journalTimeZone(env: Env): string {
  return env.JOURNAL_TZ && env.JOURNAL_TZ.length > 0 ? env.JOURNAL_TZ : DEFAULT_TIMEZONE;
}
