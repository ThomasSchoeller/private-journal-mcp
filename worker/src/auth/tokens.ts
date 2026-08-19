// ABOUTME: The static journal token list and constant-time verification
// ABOUTME: Every authenticated request resolves to one of these labels

import type { Env } from '../env.js';
import { secretEquals } from './crypto.js';

export interface JournalToken {
  /** Recorded on writes as `entries.client_label`; revoking one leaves the rest alone. */
  label: string;
  token: string;
  /** Default project slug for `process_thoughts` calls from this client. */
  project?: string;
}

function isJournalToken(value: unknown): value is JournalToken {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.label === 'string' &&
    candidate.label.length > 0 &&
    typeof candidate.token === 'string' &&
    candidate.token.length > 0 &&
    (candidate.project === undefined || typeof candidate.project === 'string')
  );
}

/**
 * Reads `JOURNAL_TOKENS` (a JSON array) or the `JOURNAL_TOKEN` single-token
 * shorthand. A malformed `JOURNAL_TOKENS` yields an empty list rather than a
 * partially-trusted one, so a typo locks the server instead of opening it.
 */
export function parseTokens(env: Env): JournalToken[] {
  const tokens: JournalToken[] = [];

  if (env.JOURNAL_TOKENS) {
    try {
      const parsed: unknown = JSON.parse(env.JOURNAL_TOKENS);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isJournalToken(item)) tokens.push(item);
        }
      }
    } catch {
      return [];
    }
  }

  if (env.JOURNAL_TOKEN) {
    tokens.push({ label: 'default', token: env.JOURNAL_TOKEN });
  }

  return tokens;
}

/**
 * Resolves a presented secret to its token entry, comparing every candidate so
 * the work done does not depend on which entry matched.
 */
export async function verifyJournalToken(
  env: Env,
  presented: string | undefined | null
): Promise<JournalToken | null> {
  if (!presented) return null;
  let match: JournalToken | null = null;
  for (const candidate of parseTokens(env)) {
    if (await secretEquals(candidate.token, presented)) {
      match ??= candidate;
    }
  }
  return match;
}

/** Looks a label up without any secret comparison, for cookie/JWT subjects. */
export function tokenByLabel(env: Env, label: string): JournalToken | null {
  return parseTokens(env).find((token) => token.label === label) ?? null;
}

/** Extracts the credential from an `Authorization: Bearer …` header. */
export function bearerCredential(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
