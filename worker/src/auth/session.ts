// ABOUTME: Signed cookies for the web UI session and for CSRF double-submit
// ABOUTME: No server-side session storage — everything is carried in the cookie

import type { Env } from '../env.js';
import { hmacSign, hmacVerify, randomToken, signPayload, verifyPayload } from './crypto.js';

export const SESSION_COOKIE = '__Host-journal';
export const CSRF_COOKIE = '__Host-csrf';
export const CSRF_FIELD = 'csrf_token';

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const CSRF_TTL_SECONDS = 60 * 60;

interface SessionPayload {
  /** Token label, so revoking a token invalidates the sessions it opened. */
  label: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

export function parseCookies(header: string | null | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

export async function createSessionCookie(env: Env, label: string): Promise<string> {
  const payload: SessionPayload = {
    label,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const value = await signPayload(env.SESSION_SECRET, payload);
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Returns the label of a valid, unexpired session cookie. */
export async function readSessionLabel(
  env: Env,
  cookieHeader: string | null | undefined
): Promise<string | null> {
  const raw = parseCookies(cookieHeader).get(SESSION_COOKIE);
  if (!raw) return null;
  const payload = await verifyPayload<SessionPayload>(env.SESSION_SECRET, raw);
  if (!payload || typeof payload.label !== 'string' || typeof payload.exp !== 'number') {
    return null;
  }
  if (payload.exp * 1000 <= Date.now()) return null;
  return payload.label;
}

/**
 * A signed random value handed to a form and stored in a cookie. A request is
 * accepted only when both copies match and the signature checks out, so a
 * cross-site POST cannot supply the field.
 */
export async function issueCsrf(env: Env): Promise<{ token: string; cookie: string }> {
  const nonce = randomToken(24);
  const token = `${nonce}.${await hmacSign(env.SESSION_SECRET, `csrf:${nonce}`)}`;
  return {
    token,
    cookie: `${CSRF_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${CSRF_TTL_SECONDS}`,
  };
}

export async function verifyCsrf(
  env: Env,
  cookieHeader: string | null | undefined,
  submitted: unknown
): Promise<boolean> {
  if (typeof submitted !== 'string' || submitted.length === 0) return false;
  const cookie = parseCookies(cookieHeader).get(CSRF_COOKIE);
  if (!cookie || cookie !== submitted) return false;
  const separator = submitted.indexOf('.');
  if (separator <= 0) return false;
  const nonce = submitted.slice(0, separator);
  const signature = submitted.slice(separator + 1);
  return hmacVerify(env.SESSION_SECRET, `csrf:${nonce}`, signature);
}
