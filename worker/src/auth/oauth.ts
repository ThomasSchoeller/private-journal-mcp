// ABOUTME: Minimal OAuth 2.1 authorization + resource server, so URL-discovery clients can connect
// ABOUTME: "Logging in" means entering the same journal token the bearer flow uses

import { Hono } from 'hono';
import type { AppEnv, Env } from '../env.js';
import { consentPage } from '../ui/pages.js';
import {
  base64UrlEncode,
  decodeJson,
  encodeJson,
  hmacSign,
  hmacVerify,
  randomToken,
  sha256,
  sha256Hex,
} from './crypto.js';
import { issueCsrf, verifyCsrf } from './session.js';
import { verifyJournalToken } from './tokens.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_SECONDS = 60;
export const JOURNAL_SCOPE = 'journal';

export interface Origins {
  /** `https://host` — this server as an OAuth issuer. */
  issuer: string;
  /** `https://host/mcp` — the canonical resource identifier tokens are bound to. */
  resource: string;
}

export function origins(requestUrl: string): Origins {
  const url = new URL(requestUrl);
  return { issuer: url.origin, resource: `${url.origin}/mcp` };
}

export function protectedResourceMetadata(o: Origins) {
  return {
    resource: o.resource,
    authorization_servers: [o.issuer],
    scopes_supported: [JOURNAL_SCOPE],
    bearer_methods_supported: ['header'],
  };
}

export function authorizationServerMetadata(o: Origins) {
  return {
    issuer: o.issuer,
    authorization_endpoint: `${o.issuer}/oauth/authorize`,
    token_endpoint: `${o.issuer}/oauth/token`,
    registration_endpoint: `${o.issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [JOURNAL_SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

/** The `WWW-Authenticate` challenge that points clients at the metadata document. */
export function bearerChallenge(o: Origins): string {
  return `Bearer resource_metadata="${o.issuer}/.well-known/oauth-protected-resource", scope="${JOURNAL_SCOPE}"`;
}

interface AccessTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  scope: string;
  exp: number;
  iat: number;
  jti: string;
}

export async function issueAccessToken(
  env: Env,
  options: { label: string; o: Origins; resource?: string | null }
): Promise<{ token: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = {
    iss: options.o.issuer,
    sub: options.label,
    aud: options.resource ?? options.o.resource,
    scope: JOURNAL_SCOPE,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    jti: randomToken(12),
  };
  const header = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  );
  const payload = encodeJson(claims);
  const signature = await hmacSign(env.SESSION_SECRET, `${header}.${payload}`);
  return { token: `${header}.${payload}.${signature}`, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * Verifies a self-contained access token. The audience check is mandatory: a
 * token minted for another resource is rejected rather than honoured here.
 */
export async function verifyAccessToken(
  env: Env,
  token: string,
  o: Origins
): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!(await hmacVerify(env.SESSION_SECRET, `${header}.${payload}`, signature))) return null;

  const claims = decodeJson<AccessTokenClaims>(payload);
  if (!claims || typeof claims.sub !== 'string') return null;
  if (claims.iss !== o.issuer) return null;
  if (claims.aud !== o.resource) return null;
  if (claims.scope !== JOURNAL_SCOPE) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
  return claims.sub;
}

interface ClientRecord {
  clientId: string;
  redirectUris: string[];
  clientName: string;
}

const cimdCache = new Map<string, { record: ClientRecord; expires: number }>();

/**
 * Resolves a `client_id` through either mechanism the MCP authorization spec
 * allows: an `https://` id is a Client ID Metadata Document, anything else must
 * have been registered through {@link registerClient}.
 */
export async function resolveClient(env: Env, clientId: string): Promise<ClientRecord | null> {
  if (clientId.startsWith('https://')) {
    const cached = cimdCache.get(clientId);
    if (cached && cached.expires > Date.now()) return cached.record;

    let response: Response;
    try {
      response = await fetch(clientId, { headers: { accept: 'application/json' } });
    } catch {
      return null;
    }
    if (!response.ok) return null;

    const document = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!document) return null;
    const redirectUris = Array.isArray(document.redirect_uris)
      ? document.redirect_uris.filter((uri): uri is string => typeof uri === 'string')
      : [];
    if (document.client_id !== clientId || redirectUris.length === 0) return null;

    const record: ClientRecord = {
      clientId,
      redirectUris,
      clientName: typeof document.client_name === 'string' ? document.client_name : clientId,
    };
    cimdCache.set(clientId, { record, expires: Date.now() + 5 * 60 * 1000 });
    return record;
  }

  const row = await env.DB.prepare(
    `SELECT client_id, redirect_uris, client_name FROM oauth_clients WHERE client_id = ?`
  )
    .bind(clientId)
    .first<{ client_id: string; redirect_uris: string; client_name: string | null }>();
  if (!row) return null;

  const redirectUris = decodeUris(row.redirect_uris);
  if (redirectUris.length === 0) return null;
  return {
    clientId: row.client_id,
    redirectUris,
    clientName: row.client_name ?? row.client_id,
  };
}

function decodeUris(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((uri): uri is string => typeof uri === 'string') : [];
  } catch {
    return [];
  }
}

async function purgeExpired(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?`).bind(now),
    env.DB.prepare(`DELETE FROM oauth_refresh_tokens WHERE expires_at < ? OR revoked = 1`).bind(now),
  ]);
}

function oauthError(status: number, code: string, description: string): Response {
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Charges one failed attempt against the per-IP budget. Only failures count, so
 * a working client is never throttled while a guessing one runs out quickly.
 */
export async function chargeFailure(env: Env, request: Request, kind: string): Promise<boolean> {
  if (!env.LOGIN_LIMITER) return true;
  const key = `${kind}:${request.headers.get('cf-connecting-ip') ?? 'unknown'}`;
  const { success } = await env.LOGIN_LIMITER.limit({ key });
  return success;
}

/** Authorization-request parameters carried through the consent form. */
const CARRIED_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'state',
  'scope',
  'code_challenge',
  'code_challenge_method',
  'resource',
] as const;

export const oauthApp = new Hono<AppEnv>();

oauthApp.get('/authorize', async (c) => {
  const url = new URL(c.req.url);
  const clientId = url.searchParams.get('client_id');
  if (!clientId) return oauthError(400, 'invalid_request', 'client_id is required');

  const client = await resolveClient(c.env, clientId);
  if (!client) return oauthError(400, 'invalid_client', 'Unknown client_id');

  const redirectUri = url.searchParams.get('redirect_uri');
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return oauthError(400, 'invalid_request', 'redirect_uri is not registered for this client');
  }
  if (url.searchParams.get('response_type') !== 'code') {
    return oauthError(400, 'unsupported_response_type', 'Only the code response type is supported');
  }
  if (url.searchParams.get('code_challenge_method') !== 'S256') {
    return oauthError(400, 'invalid_request', 'PKCE with S256 is required');
  }
  if (!url.searchParams.get('code_challenge')) {
    return oauthError(400, 'invalid_request', 'code_challenge is required');
  }

  const params: Record<string, string> = {};
  for (const name of CARRIED_PARAMS) {
    const value = url.searchParams.get(name);
    if (value !== null) params[name] = value;
  }

  const csrf = await issueCsrf(c.env);
  return c.html(consentPage({ csrf: csrf.token, clientName: client.clientName, params }), 200, {
    'set-cookie': csrf.cookie,
  });
});

oauthApp.post('/authorize', async (c) => {
  const form = await c.req.formData();
  const value = (name: string) => {
    const entry = form.get(name);
    return typeof entry === 'string' ? entry : null;
  };

  if (!(await verifyCsrf(c.env, c.req.header('cookie'), form.get('csrf_token')))) {
    return oauthError(400, 'invalid_request', 'Invalid or missing CSRF token');
  }

  const clientId = value('client_id');
  const redirectUri = value('redirect_uri');
  const codeChallenge = value('code_challenge');
  if (!clientId || !redirectUri || !codeChallenge) {
    return oauthError(400, 'invalid_request', 'Missing authorization request parameters');
  }

  const client = await resolveClient(c.env, clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) {
    return oauthError(400, 'invalid_client', 'Unknown client or redirect_uri');
  }

  const token = await verifyJournalToken(c.env, value('token'));
  if (!token) {
    if (!(await chargeFailure(c.env, c.req.raw, 'authorize'))) {
      return oauthError(429, 'too_many_requests', 'Too many attempts. Try again shortly.');
    }
    const csrf = await issueCsrf(c.env);
    const params: Record<string, string> = {};
    for (const name of CARRIED_PARAMS) {
      const carried = value(name);
      if (carried !== null) params[name] = carried;
    }
    return c.html(
      consentPage({
        csrf: csrf.token,
        clientName: client.clientName,
        params,
        error: 'That token was not recognised.',
      }),
      401,
      { 'set-cookie': csrf.cookie }
    );
  }

  const code = randomToken(32);
  const o = origins(c.req.url);
  await purgeExpired(c.env);
  await c.env.DB.prepare(
    `INSERT INTO oauth_codes
       (code_hash, client_id, redirect_uri, code_challenge, resource, token_label, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      await sha256Hex(code),
      clientId,
      redirectUri,
      codeChallenge,
      value('resource'),
      token.label,
      Date.now() + CODE_TTL_SECONDS * 1000
    )
    .run();

  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  target.searchParams.set('iss', o.issuer);
  const state = value('state');
  if (state !== null) target.searchParams.set('state', state);
  return c.redirect(target.toString(), 302);
});

oauthApp.post('/token', async (c) => {
  const form = await c.req.formData();
  const value = (name: string) => {
    const entry = form.get(name);
    return typeof entry === 'string' ? entry : null;
  };
  const o = origins(c.req.url);
  const grantType = value('grant_type');

  if (grantType === 'authorization_code') {
    const code = value('code');
    const clientId = value('client_id');
    const redirectUri = value('redirect_uri');
    const verifier = value('code_verifier');
    if (!code || !clientId || !redirectUri || !verifier) {
      return oauthError(400, 'invalid_request', 'Missing authorization_code grant parameters');
    }

    const hash = await sha256Hex(code);
    const row = await c.env.DB.prepare(`SELECT * FROM oauth_codes WHERE code_hash = ?`)
      .bind(hash)
      .first<{
        code_hash: string;
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        resource: string | null;
        token_label: string;
        expires_at: number;
      }>();
    // Single use: the row goes whether or not the rest of the checks pass.
    await c.env.DB.prepare(`DELETE FROM oauth_codes WHERE code_hash = ?`).bind(hash).run();

    const badGrant = async (description: string) => {
      if (!(await chargeFailure(c.env, c.req.raw, 'token'))) {
        return oauthError(429, 'too_many_requests', 'Too many attempts. Try again shortly.');
      }
      return oauthError(400, 'invalid_grant', description);
    };

    if (!row || row.expires_at < Date.now()) {
      return badGrant('Authorization code is invalid or expired');
    }
    if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
      return badGrant('Authorization code was issued to another client');
    }
    if (base64UrlEncode(await sha256(verifier)) !== row.code_challenge) {
      return badGrant('PKCE verification failed');
    }
    if (row.resource && row.resource !== o.resource) {
      return oauthError(400, 'invalid_target', 'Requested resource is not served here');
    }

    return tokenResponse(c.env, o, clientId, row.token_label);
  }

  if (grantType === 'refresh_token') {
    const refreshToken = value('refresh_token');
    const clientId = value('client_id');
    if (!refreshToken || !clientId) {
      return oauthError(400, 'invalid_request', 'Missing refresh_token grant parameters');
    }

    const hash = await sha256Hex(refreshToken);
    const row = await c.env.DB.prepare(`SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?`)
      .bind(hash)
      .first<{
        token_hash: string;
        client_id: string;
        token_label: string;
        expires_at: number;
        revoked: number;
      }>();
    // Rotation: the presented token is spent even if this exchange fails.
    await c.env.DB.prepare(`DELETE FROM oauth_refresh_tokens WHERE token_hash = ?`)
      .bind(hash)
      .run();

    if (!row || row.revoked === 1 || row.expires_at < Date.now() || row.client_id !== clientId) {
      if (!(await chargeFailure(c.env, c.req.raw, 'token'))) {
        return oauthError(429, 'too_many_requests', 'Too many attempts. Try again shortly.');
      }
      return oauthError(400, 'invalid_grant', 'Refresh token is invalid or expired');
    }
    return tokenResponse(c.env, o, clientId, row.token_label);
  }

  return oauthError(400, 'unsupported_grant_type', 'Unsupported grant_type');
});

async function tokenResponse(
  env: Env,
  o: Origins,
  clientId: string,
  label: string
): Promise<Response> {
  const access = await issueAccessToken(env, { label, o });
  const refreshToken = randomToken(32);
  await purgeExpired(env);
  await env.DB.prepare(
    `INSERT INTO oauth_refresh_tokens (token_hash, client_id, token_label, expires_at)
     VALUES (?, ?, ?, ?)`
  )
    .bind(
      await sha256Hex(refreshToken),
      clientId,
      label,
      Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000
    )
    .run();

  return new Response(
    JSON.stringify({
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: access.expiresIn,
      refresh_token: refreshToken,
      scope: JOURNAL_SCOPE,
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
  );
}

oauthApp.post('/register', async (c) => {
  const metadata = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!metadata) return oauthError(400, 'invalid_client_metadata', 'Body must be JSON');

  const redirectUris = Array.isArray(metadata.redirect_uris)
    ? metadata.redirect_uris.filter((uri): uri is string => typeof uri === 'string')
    : [];
  if (redirectUris.length === 0) {
    return oauthError(400, 'invalid_redirect_uri', 'At least one redirect_uri is required');
  }
  for (const uri of redirectUris) {
    try {
      const parsed = new URL(uri);
      const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (parsed.protocol !== 'https:' && !loopback && !parsed.protocol.includes('.')) {
        return oauthError(400, 'invalid_redirect_uri', `Unsupported redirect_uri: ${uri}`);
      }
    } catch {
      return oauthError(400, 'invalid_redirect_uri', `Malformed redirect_uri: ${uri}`);
    }
  }

  const clientId = randomToken(16);
  const clientName = typeof metadata.client_name === 'string' ? metadata.client_name : null;
  await c.env.DB.prepare(
    `INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at)
     VALUES (?, ?, ?, ?)`
  )
    .bind(clientId, JSON.stringify(redirectUris), clientName, Date.now())
    .run();

  return new Response(
    JSON.stringify({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      client_name: clientName ?? undefined,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    { status: 201, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
  );
});
