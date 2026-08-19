// ABOUTME: Minimal OAuth 2.1 authorization + resource server, so URL-discovery clients can connect
// ABOUTME: Consent is granted from an already signed-in browser session, never by typing the token

import { Hono } from 'hono';
import type { AppEnv, Env } from '../env.js';
import { queryString } from '../ui/layout.js';
import { consentPage } from '../ui/pages.js';
import {
  base64UrlEncode,
  decodeJson,
  deriveSecret,
  encodeJson,
  hmacSign,
  hmacVerify,
  randomToken,
  sha256,
  sha256Hex,
} from './crypto.js';
import { issueCsrf, readSessionLabel, verifyCsrf } from './session.js';
import { tokenByLabel } from './tokens.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_SECONDS = 60;
const CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Registrations are free to make, so the table is kept to a bounded size. */
const CLIENT_METER_THRESHOLD = 50;
const CLIENT_MAX_ROWS = 200;
export const JOURNAL_SCOPE = 'journal';

/** Client ID Metadata Documents are fetched from a URL a stranger chose. */
const CIMD_TIMEOUT_MS = 5_000;
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_CACHE_TTL_MS = 5 * 60 * 1000;
const CIMD_CACHE_MAX_ENTRIES = 64;

export interface Origins {
  /** `https://host` — this server as an OAuth issuer. */
  issuer: string;
  /** `https://host/mcp` — the canonical resource identifier tokens are bound to. */
  resource: string;
}

/**
 * This server's own identity. `PUBLIC_ORIGIN` wins when set, so the issuer and
 * the audience tokens are bound to stay put even if a request arrives carrying
 * some other `Host`.
 */
export function origins(env: Env, requestUrl: string): Origins {
  const configured = env.PUBLIC_ORIGIN?.trim();
  let issuer: string;
  if (configured) {
    try {
      issuer = new URL(configured).origin;
    } catch {
      issuer = new URL(requestUrl).origin;
    }
  } else {
    issuer = new URL(requestUrl).origin;
  }
  return { issuer, resource: `${issuer}/mcp` };
}

/** Subkey OAuth access tokens are signed with. */
function accessTokenKey(env: Env): Promise<string> {
  return deriveSecret(env.SESSION_SECRET, 'oauth-access');
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/**
 * Redirect targets this server is willing to send an authorization code to:
 * `https://` anywhere, plain `http://` only on the loopback interface (RFC 8252
 * native apps), and reverse-DNS custom schemes such as `com.example.app:/cb`.
 * Everything else — `javascript:`, `data:`, `file:`, plain `http://` on a real
 * host — is refused.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return parsed.hostname.length > 0;
  if (parsed.protocol === 'http:') return LOOPBACK_HOSTS.has(parsed.hostname);
  // A custom scheme has to look like a reversed domain name, which no
  // browser-executable scheme does.
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/.test(parsed.protocol);
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
  const signature = await hmacSign(await accessTokenKey(env), `${header}.${payload}`);
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
  if (!(await hmacVerify(await accessTokenKey(env), `${header}.${payload}`, signature))) {
    return null;
  }

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
 * Reads at most `limit` bytes of a response body. A metadata document is a few
 * hundred bytes; anything larger is a host trying to tie up the isolate.
 */
async function readCapped(response: Response, limit: number): Promise<string | null> {
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Fetches a Client ID Metadata Document. The URL comes from an unauthenticated
 * request, so this is a deliberately narrow outbound call: one hop, a short
 * deadline and a hard size cap.
 */
async function fetchClientMetadata(clientId: string): Promise<ClientRecord | null> {
  let response: Response;
  try {
    response = await fetch(clientId, {
      headers: { accept: 'application/json' },
      // 'manual' rather than 'error': a redirect then surfaces as a non-ok
      // response instead of an exception, and either way it is not followed.
      redirect: 'manual',
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const body = await readCapped(response, CIMD_MAX_BYTES);
  if (body === null) return null;

  let document: Record<string, unknown> | null;
  try {
    document = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!document || typeof document !== 'object') return null;

  const redirectUris = Array.isArray(document.redirect_uris)
    ? document.redirect_uris.filter(
        (uri): uri is string => typeof uri === 'string' && isAllowedRedirectUri(uri)
      )
    : [];
  if (document.client_id !== clientId || redirectUris.length === 0) return null;

  return {
    clientId,
    redirectUris,
    clientName: typeof document.client_name === 'string' ? document.client_name : clientId,
  };
}

/** Keeps the metadata cache from growing with every URL a stranger names. */
function cacheClientMetadata(clientId: string, record: ClientRecord): void {
  cimdCache.delete(clientId);
  while (cimdCache.size >= CIMD_CACHE_MAX_ENTRIES) {
    const oldest = cimdCache.keys().next();
    if (oldest.done) break;
    cimdCache.delete(oldest.value);
  }
  cimdCache.set(clientId, { record, expires: Date.now() + CIMD_CACHE_TTL_MS });
}

/**
 * Resolves a `client_id` through either mechanism the MCP authorization spec
 * allows: an `https://` id is a Client ID Metadata Document, anything else must
 * have been registered through {@link registerClient}.
 */
export async function resolveClient(env: Env, clientId: string): Promise<ClientRecord | null> {
  if (clientId.startsWith('https://')) {
    const cached = cimdCache.get(clientId);
    if (cached && cached.expires > Date.now()) return cached.record;

    const record = await fetchClientMetadata(clientId);
    if (!record) return null;
    cacheClientMetadata(clientId, record);
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

/**
 * Expired grant state, plus registered clients nothing has used. Revoked
 * refresh tokens are kept until they expire on their own: their row is what
 * lets a replay be recognised as a replay rather than as an unknown token.
 */
async function purgeExpired(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?`).bind(now),
    env.DB.prepare(`DELETE FROM oauth_refresh_tokens WHERE expires_at < ?`).bind(now),
    env.DB
      .prepare(
        `DELETE FROM oauth_clients
          WHERE created_at < ?
            AND client_id NOT IN (SELECT client_id FROM oauth_refresh_tokens)`
      )
      .bind(now - CLIENT_TTL_MS),
  ]);
}

async function countClients(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM oauth_clients`).first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

/**
 * Keeps `oauth_clients` bounded no matter how many registrations arrive. The
 * oldest clients go first, and only ones nothing holds a refresh token for —
 * a working integration is never evicted out from under its user.
 */
async function evictSurplusClients(env: Env): Promise<void> {
  const registered = await countClients(env);
  const surplus = registered - CLIENT_MAX_ROWS;
  if (surplus <= 0) return;
  await env.DB.prepare(
    `DELETE FROM oauth_clients
      WHERE client_id IN (
        SELECT client_id FROM oauth_clients
         WHERE client_id NOT IN (SELECT client_id FROM oauth_refresh_tokens)
         ORDER BY created_at ASC
         LIMIT ?
      )`
  )
    .bind(surplus)
    .run();
}

function oauthError(status: number, code: string, description: string): Response {
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

let warnedAboutLimiter = false;

/**
 * Charges one attempt against the per-IP budget. Callers only charge failures
 * (and registrations once the client table looks abused), so a working client
 * is never throttled while a guessing one runs out quickly. Without the binding
 * nothing is metered — the deployment stays up, and says so once.
 */
export async function chargeFailure(env: Env, request: Request, kind: string): Promise<boolean> {
  if (!env.LOGIN_LIMITER) {
    if (!warnedAboutLimiter) {
      warnedAboutLimiter = true;
      console.warn(
        'No LOGIN_LIMITER binding: failed credential attempts are not being throttled. ' +
          'Add the ratelimits entry from wrangler.jsonc.'
      );
    }
    return true;
  }
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

  // Consent is only ever granted by a browser that already signed in. Nobody
  // is asked to type the journal token into a page a stranger linked them to.
  const label = await readSessionLabel(c.env, c.req.header('cookie'));
  if (!label || !tokenByLabel(c.env, label)) {
    return c.redirect(`/login${queryString({ next: url.pathname + url.search })}`, 303);
  }

  const params: Record<string, string> = {};
  for (const name of CARRIED_PARAMS) {
    const value = url.searchParams.get(name);
    if (value !== null) params[name] = value;
  }

  const csrf = await issueCsrf(c.env);
  return c.html(
    consentPage({
      csrf: csrf.token,
      clientName: client.clientName,
      redirectUri,
      params,
    }),
    200,
    { 'set-cookie': csrf.cookie }
  );
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

  const label = await readSessionLabel(c.env, c.req.header('cookie'));
  const token = label ? tokenByLabel(c.env, label) : null;
  if (!token) {
    return oauthError(401, 'access_denied', 'Sign in before granting access');
  }

  const code = randomToken(32);
  const o = origins(c.env, c.req.url);
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
  const o = origins(c.env, c.req.url);
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

    const spend = async (description: string) => {
      if (!(await chargeFailure(c.env, c.req.raw, 'token'))) {
        return oauthError(429, 'too_many_requests', 'Too many attempts. Try again shortly.');
      }
      return oauthError(400, 'invalid_grant', description);
    };

    if (!row || row.expires_at < Date.now() || row.client_id !== clientId) {
      return spend('Refresh token is invalid or expired');
    }
    if (row.revoked === 1) {
      // Someone replayed a token that was already rotated away. Either the
      // client or a thief holds a copy, and there is no telling which, so the
      // whole chain issued to this client goes.
      await c.env.DB.prepare(
        `UPDATE oauth_refresh_tokens SET revoked = 1 WHERE client_id = ? AND token_label = ?`
      )
        .bind(row.client_id, row.token_label)
        .run();
      return spend('Refresh token was already used; this authorization has been revoked');
    }

    // Rotation: the presented token is spent, but its row stays until it
    // expires so a later replay is still recognisable.
    await c.env.DB.prepare(`UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_hash = ?`)
      .bind(hash)
      .run();
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
  // Registration is unauthenticated by protocol design. Ordinary use adds a
  // handful of clients and is never throttled; once the table looks like
  // someone is filling it, further registrations are metered per IP.
  await purgeExpired(c.env);
  const registered = await countClients(c.env);
  if (registered >= CLIENT_METER_THRESHOLD && !(await chargeFailure(c.env, c.req.raw, 'register'))) {
    return oauthError(429, 'too_many_requests', 'Too many registrations. Try again shortly.');
  }

  const metadata = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!metadata) return oauthError(400, 'invalid_client_metadata', 'Body must be JSON');

  const redirectUris = Array.isArray(metadata.redirect_uris)
    ? metadata.redirect_uris.filter((uri): uri is string => typeof uri === 'string')
    : [];
  if (redirectUris.length === 0) {
    return oauthError(400, 'invalid_redirect_uri', 'At least one redirect_uri is required');
  }
  for (const uri of redirectUris) {
    if (!isAllowedRedirectUri(uri)) {
      return oauthError(400, 'invalid_redirect_uri', `Unsupported redirect_uri: ${uri}`);
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
  await evictSurplusClients(c.env);

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
