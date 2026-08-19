import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { pkceChallenge, randomToken } from '../src/auth/crypto.js';
import { LAPTOP_TOKEN, ORIGIN, extractCsrf, mcpRequest } from './helpers.js';

const REDIRECT_URI = 'https://client.example.com/callback';

interface Authorized {
  code: string;
  state: string | null;
  iss: string | null;
}

async function registerClient(): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test client',
      redirect_uris: [REDIRECT_URI],
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

/** Walks the consent screen the way a browser would. */
async function authorize(options: {
  clientId: string;
  challenge: string;
  state?: string;
  token?: string;
  resource?: string;
  redirectUri?: string;
}): Promise<{ response: Response; authorized: Authorized | null }> {
  const query = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri ?? REDIRECT_URI,
    response_type: 'code',
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
  });
  if (options.state) query.set('state', options.state);
  if (options.resource) query.set('resource', options.resource);

  const page = await SELF.fetch(`${ORIGIN}/oauth/authorize?${query}`);
  if (!page.ok) return { response: page, authorized: null };

  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
  const html = await page.text();
  const form = new URLSearchParams(query);
  form.set('csrf_token', extractCsrf(html));
  form.set('token', options.token ?? LAPTOP_TOKEN);

  const response = await SELF.fetch(`${ORIGIN}/oauth/authorize`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });

  if (response.status !== 302) return { response, authorized: null };
  const location = new URL(response.headers.get('location')!);
  return {
    response,
    authorized: {
      code: location.searchParams.get('code')!,
      state: location.searchParams.get('state'),
      iss: location.searchParams.get('iss'),
    },
  };
}

async function exchange(body: Record<string, string>): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

describe('discovery metadata', () => {
  it('advertises the protected resource', async () => {
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
      scopes_supported: ['journal'],
    });
  });

  it('serves the resource metadata under the endpoint path too', async () => {
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    expect(((await response.json()) as { resource: string }).resource).toBe(`${ORIGIN}/mcp`);
  });

  it('advertises the authorization server', async () => {
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(await response.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      authorization_response_iss_parameter_supported: true,
    });
  });
});

describe('dynamic client registration', () => {
  it('registers a client with its redirect URIs', async () => {
    const response = await SELF.fetch(`${ORIGIN}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test', redirect_uris: [REDIRECT_URI] }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
    });
  });

  it('rejects a registration without redirect URIs', async () => {
    const response = await SELF.fetch(`${ORIGIN}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });
});

describe('authorization code flow', () => {
  it('runs end to end and yields a token that works on /mcp', async () => {
    const clientId = await registerClient();
    const verifier = randomToken(32);
    const { authorized } = await authorize({
      clientId,
      challenge: await pkceChallenge(verifier),
      state: 'xyz',
      resource: `${ORIGIN}/mcp`,
    });

    expect(authorized).not.toBeNull();
    expect(authorized!.state).toBe('xyz');
    expect(authorized!.iss).toBe(ORIGIN);

    const tokenResponse = await exchange({
      grant_type: 'authorization_code',
      code: authorized!.code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get('cache-control')).toBe('no-store');

    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      scope: string;
    };
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.scope).toBe('journal');

    const mcp = await mcpRequest('tools/list', {}, { token: tokens.access_token });
    expect(mcp.status).toBe(200);
  });

  it('refuses to issue a code for the wrong journal token', async () => {
    const clientId = await registerClient();
    const { response, authorized } = await authorize({
      clientId,
      challenge: await pkceChallenge(randomToken(32)),
      token: 'wrong-token',
    });
    expect(authorized).toBeNull();
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('not recognised');
  });

  it('refuses a consent POST without a CSRF token', async () => {
    const clientId = await registerClient();
    const response = await SELF.fetch(`${ORIGIN}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: await pkceChallenge(randomToken(32)),
        token: LAPTOP_TOKEN,
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_request');
  });

  it('rejects an unregistered redirect_uri', async () => {
    const clientId = await registerClient();
    const { response } = await authorize({
      clientId,
      challenge: await pkceChallenge(randomToken(32)),
      redirectUri: 'https://attacker.example.com/callback',
    });
    expect(response.status).toBe(400);
  });

  it('requires PKCE with S256', async () => {
    const clientId = await registerClient();
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
    });
    const response = await SELF.fetch(`${ORIGIN}/oauth/authorize?${query}`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('PKCE');
  });

  it('rejects a mismatched PKCE verifier', async () => {
    const clientId = await registerClient();
    const { authorized } = await authorize({
      clientId,
      challenge: await pkceChallenge(randomToken(32)),
    });

    const response = await exchange({
      grant_type: 'authorization_code',
      code: authorized!.code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: randomToken(32),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('spends a code on first use', async () => {
    const clientId = await registerClient();
    const verifier = randomToken(32);
    const { authorized } = await authorize({ clientId, challenge: await pkceChallenge(verifier) });
    const body = {
      grant_type: 'authorization_code',
      code: authorized!.code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    };

    expect((await exchange(body)).status).toBe(200);
    const replay = await exchange(body);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects a code presented by another client', async () => {
    const clientId = await registerClient();
    const otherClientId = await registerClient();
    const verifier = randomToken(32);
    const { authorized } = await authorize({ clientId, challenge: await pkceChallenge(verifier) });

    const response = await exchange({
      grant_type: 'authorization_code',
      code: authorized!.code,
      client_id: otherClientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(response.status).toBe(400);
  });

  it('rejects a resource indicator this server does not serve', async () => {
    const clientId = await registerClient();
    const verifier = randomToken(32);
    const { authorized } = await authorize({
      clientId,
      challenge: await pkceChallenge(verifier),
      resource: 'https://elsewhere.example.com/mcp',
    });

    const response = await exchange({
      grant_type: 'authorization_code',
      code: authorized!.code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_target');
  });

  it('rejects an unsupported grant type', async () => {
    const response = await exchange({ grant_type: 'password' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('unsupported_grant_type');
  });
});

describe('refresh tokens', () => {
  async function firstTokens(clientId: string): Promise<{ access_token: string; refresh_token: string }> {
    const verifier = randomToken(32);
    const { authorized } = await authorize({ clientId, challenge: await pkceChallenge(verifier) });
    const response = await exchange({
      grant_type: 'authorization_code',
      code: authorized!.code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    return (await response.json()) as { access_token: string; refresh_token: string };
  }

  it('rotates on every use and invalidates the spent token', async () => {
    const clientId = await registerClient();
    const tokens = await firstTokens(clientId);

    const refreshed = await exchange({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { refresh_token: string; access_token: string };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);

    const replay = await exchange({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(replay.status).toBe(400);

    expect((await mcpRequest('tools/list', {}, { token: next.access_token })).status).toBe(200);
  });

  it('rejects a refresh token presented by another client', async () => {
    const clientId = await registerClient();
    const otherClientId = await registerClient();
    const tokens = await firstTokens(clientId);

    const response = await exchange({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: otherClientId,
    });
    expect(response.status).toBe(400);
  });
});

// The metadata host is served by the test outbound service (see vitest.config.ts).
describe('client ID metadata documents', () => {
  it('accepts an https client_id and validates its redirect URIs', async () => {
    const clientId = 'https://apps.example.com/journal-client.json';
    const verifier = randomToken(32);
    const { authorized } = await authorize({ clientId, challenge: await pkceChallenge(verifier) });
    expect(authorized).not.toBeNull();

    const response = await exchange({
      grant_type: 'authorization_code',
      code: authorized!.code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(response.status).toBe(200);
  });

  it('refuses an https client_id whose document cannot be fetched', async () => {
    const query = new URLSearchParams({
      client_id: 'https://unknown.example.com/client.json',
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: await pkceChallenge(randomToken(32)),
      code_challenge_method: 'S256',
    });
    const response = await SELF.fetch(`${ORIGIN}/oauth/authorize?${query}`);
    expect(response.status).toBe(400);
  });

  it('rejects a metadata document whose client_id does not match', async () => {
    const clientId = 'https://apps.example.com/mismatched.json';
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: await pkceChallenge(randomToken(32)),
      code_challenge_method: 'S256',
    });
    const response = await SELF.fetch(`${ORIGIN}/oauth/authorize?${query}`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_client');
  });
});
