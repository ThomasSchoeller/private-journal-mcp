import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { base64UrlEncode, encodeJson, hmacSign } from '../src/auth/crypto.js';
import { issueAccessToken, origins } from '../src/auth/oauth.js';
import { LAPTOP_TOKEN, ORIGIN, login, mcpRequest, readJsonRpc } from './helpers.js';

const O = origins(`${ORIGIN}/mcp`);

/** Mints an access token with hand-chosen claims, signed with the real secret. */
async function craftAccessToken(claims: Record<string, unknown>, secret?: string): Promise<string> {
  const header = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  );
  const payload = encodeJson({
    iss: O.issuer,
    sub: 'laptop',
    aud: O.resource,
    scope: 'journal',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: 'test',
    ...claims,
  });
  const signature = await hmacSign(secret ?? env.SESSION_SECRET, `${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

describe('MCP bearer auth', () => {
  it('challenges an unauthenticated request with the metadata pointer', async () => {
    const response = await mcpRequest('tools/list', {}, { token: null });
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain(
      `resource_metadata="${O.issuer}/.well-known/oauth-protected-resource"`
    );
    expect(challenge).toContain('scope="journal"');
  });

  it('rejects a wrong token', async () => {
    expect((await mcpRequest('tools/list', {}, { token: 'not-the-token' })).status).toBe(401);
  });

  it('accepts a configured static token', async () => {
    expect((await mcpRequest('tools/list', {}, { token: LAPTOP_TOKEN })).status).toBe(200);
  });

  it('accepts an access token this server minted', async () => {
    const { token } = await issueAccessToken(env, { label: 'laptop', o: O });
    const message = await readJsonRpc(await mcpRequest('tools/list', {}, { token }));
    expect(message.error).toBeUndefined();
  });

  it('rejects an access token signed with another key', async () => {
    const token = await craftAccessToken({}, 'not-the-session-secret');
    expect((await mcpRequest('tools/list', {}, { token })).status).toBe(401);
  });

  it('rejects an expired access token', async () => {
    const token = await craftAccessToken({ exp: Math.floor(Date.now() / 1000) - 1 });
    expect((await mcpRequest('tools/list', {}, { token })).status).toBe(401);
  });

  it('rejects an access token minted for another resource', async () => {
    const token = await craftAccessToken({ aud: 'https://elsewhere.example.com/mcp' });
    expect((await mcpRequest('tools/list', {}, { token })).status).toBe(401);
  });

  it('rejects an access token issued by another server', async () => {
    const token = await craftAccessToken({ iss: 'https://elsewhere.example.com' });
    expect((await mcpRequest('tools/list', {}, { token })).status).toBe(401);
  });

  it('rejects an access token whose subject is no longer a configured token', async () => {
    const token = await craftAccessToken({ sub: 'revoked-laptop' });
    expect((await mcpRequest('tools/list', {}, { token })).status).toBe(401);
  });
});

describe('UI session', () => {
  it('sends anonymous visitors to the login page, remembering where they were', async () => {
    const response = await SELF.fetch(`${ORIGIN}/entries/01ARZ3NDEKTSV4RRFFQ69G5FAV`, {
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      '/login?next=%2Fentries%2F01ARZ3NDEKTSV4RRFFQ69G5FAV'
    );
  });

  it('issues a session for a valid token and lets it through', async () => {
    const cookie = await login();
    const response = await SELF.fetch(`${ORIGIN}/`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Private journal');
  });

  it('refuses a login without a CSRF token', async () => {
    const response = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: LAPTOP_TOKEN }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).not.toContain('__Host-journal=');
  });

  it('refuses a wrong token at the login form', async () => {
    const page = await SELF.fetch(`${ORIGIN}/login`);
    const setCookie = page.headers.get('set-cookie') ?? '';
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(await page.text())![1];

    const response = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      headers: {
        cookie: setCookie.split(';')[0],
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf_token: csrf, token: 'wrong' }),
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('not recognised');
  });

  it('rejects a forged session cookie', async () => {
    const payload = encodeJson({ label: 'laptop', exp: Math.floor(Date.now() / 1000) + 600 });
    const forged = `__Host-journal=${payload}.${base64UrlEncode(new Uint8Array(32))}`;
    const response = await SELF.fetch(`${ORIGIN}/`, {
      headers: { cookie: forged },
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login?next=%2F');
  });

  it('rejects an expired session cookie even when correctly signed', async () => {
    const payload = encodeJson({ label: 'laptop', exp: Math.floor(Date.now() / 1000) - 10 });
    const signature = await hmacSign(env.SESSION_SECRET, payload);
    const response = await SELF.fetch(`${ORIGIN}/`, {
      headers: { cookie: `__Host-journal=${payload}.${signature}` },
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
  });

  it('rejects a session whose token label no longer exists', async () => {
    const payload = encodeJson({ label: 'retired', exp: Math.floor(Date.now() / 1000) + 600 });
    const signature = await hmacSign(env.SESSION_SECRET, payload);
    const response = await SELF.fetch(`${ORIGIN}/`, {
      headers: { cookie: `__Host-journal=${payload}.${signature}` },
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
  });

  it('clears the session on logout', async () => {
    const cookie = await login();
    const response = await SELF.fetch(`${ORIGIN}/logout`, {
      method: 'POST',
      headers: { cookie },
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});

describe('hardening', () => {
  it('serves an unauthenticated liveness probe that leaks nothing', async () => {
    const response = await SELF.fetch(`${ORIGIN}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('sets the security headers on every response', async () => {
    const response = await SELF.fetch(`${ORIGIN}/login`);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('strict-transport-security')).toContain('max-age=');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('marks the session cookie HttpOnly, Secure and SameSite=Lax', async () => {
    const page = await SELF.fetch(`${ORIGIN}/login`);
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(await page.text())![1];
    const response = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      headers: {
        cookie: (page.headers.get('set-cookie') ?? '').split(';')[0],
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf_token: csrf, token: LAPTOP_TOKEN }),
      redirect: 'manual',
    });

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('__Host-journal=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });
});
