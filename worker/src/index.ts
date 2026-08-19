// ABOUTME: Worker entry point — routing, security headers and the auth gates
// ABOUTME: One Hono app serves the MCP endpoint, the OAuth layer and the web UI

import { createMcpHandler, type AuthInfo, type McpHttpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import {
  JOURNAL_SCOPE,
  authorizationServerMetadata,
  bearerChallenge,
  chargeFailure,
  oauthApp,
  origins,
  protectedResourceMetadata,
  verifyAccessToken,
} from './auth/oauth.js';
import {
  clearSessionCookie,
  createSessionCookie,
  issueCsrf,
  readSessionLabel,
  verifyCsrf,
} from './auth/session.js';
import { bearerCredential, tokenByLabel, verifyJournalToken, type JournalToken } from './auth/tokens.js';
import { journalTimeZone, type AppEnv, type Env } from './env.js';
import { createJournalServer, type McpContext } from './mcp.js';
import { buildMatchQuery } from './search.js';
import {
  adjacentEntries,
  deleteEntry,
  getEntry,
  listEntries,
  listProjects,
  looksLikeEntryId,
  searchEntries,
  type Cursor,
} from './store.js';
import { queryString } from './ui/layout.js';
import {
  deleteConfirmPage,
  entryPage,
  errorPage,
  listPage,
  loginPage,
  searchPage,
  type Filters,
} from './ui/pages.js';

const PAGE_SIZE = 50;

const app = new Hono<AppEnv>();

/**
 * The UI ships no JavaScript, which is what lets `script-src` be `'none'`
 * outright. Inline styles are the one exception the stylesheet needs.
 */
app.use('*', async (c, next) => {
  await next();
  const headers = c.res.headers;
  headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
  headers.set(
    'content-security-policy',
    "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  if (new URL(c.req.url).pathname !== '/healthz') {
    headers.set('cache-control', 'no-store');
  }
});

app.get('/healthz', (c) => c.text('ok'));

// ---------------------------------------------------------------- MCP endpoint

let handler: McpHttpHandler | undefined;

function mcpHandler(): McpHttpHandler {
  handler ??= createMcpHandler((ctx) => {
    const context = (ctx.authInfo?.extra as { journal?: McpContext } | undefined)?.journal;
    if (!context) throw new Error('Unauthenticated MCP request');
    return createJournalServer(context);
  });
  return handler;
}

/** Static bearer token first, then an OAuth access token minted by this server. */
async function authenticateBearer(
  env: Env,
  request: Request
): Promise<{ token: JournalToken; credential: string } | null> {
  const credential = bearerCredential(request.headers.get('authorization'));
  if (!credential) return null;

  const direct = await verifyJournalToken(env, credential);
  if (direct) return { token: direct, credential };

  const label = await verifyAccessToken(env, credential, origins(request.url));
  if (!label) return null;
  const token = tokenByLabel(env, label);
  return token ? { token, credential } : null;
}

app.all('/mcp', async (c) => {
  const o = origins(c.req.url);
  const authenticated = await authenticateBearer(c.env, c.req.raw);
  if (!authenticated) {
    return c.json({ error: 'invalid_token', error_description: 'A journal token is required' }, 401, {
      'www-authenticate': bearerChallenge(o),
    });
  }

  const authInfo: AuthInfo = {
    token: authenticated.credential,
    clientId: authenticated.token.label,
    scopes: [JOURNAL_SCOPE],
    resource: new URL(o.resource),
    extra: { journal: { env: c.env, token: authenticated.token } satisfies McpContext },
  };
  return mcpHandler().fetch(c.req.raw, { authInfo });
});

// ------------------------------------------------------------- OAuth discovery

app.get('/.well-known/oauth-protected-resource', (c) =>
  c.json(protectedResourceMetadata(origins(c.req.url)))
);
app.get('/.well-known/oauth-protected-resource/mcp', (c) =>
  c.json(protectedResourceMetadata(origins(c.req.url)))
);
app.get('/.well-known/oauth-authorization-server', (c) =>
  c.json(authorizationServerMetadata(origins(c.req.url)))
);

app.route('/oauth', oauthApp);

// --------------------------------------------------------------------- UI auth

app.get('/login', async (c) => {
  const csrf = await issueCsrf(c.env);
  return c.html(loginPage({ csrf: csrf.token, next: c.req.query('next') }), 200, {
    'set-cookie': csrf.cookie,
  });
});

app.post('/login', async (c) => {
  const form = await c.req.formData();
  const next = c.req.query('next');
  const fail = async (status: 400 | 401 | 429, message: string) => {
    const csrf = await issueCsrf(c.env);
    return c.html(loginPage({ csrf: csrf.token, error: message, next }), status, {
      'set-cookie': csrf.cookie,
    });
  };

  if (!(await verifyCsrf(c.env, c.req.header('cookie'), form.get('csrf_token')))) {
    return fail(400, 'Your session expired. Please try again.');
  }

  const submitted = form.get('token');
  const token = await verifyJournalToken(c.env, typeof submitted === 'string' ? submitted : null);
  if (!token) {
    return (await chargeFailure(c.env, c.req.raw, 'login'))
      ? fail(401, 'That token was not recognised.')
      : fail(429, 'Too many attempts. Try again shortly.');
  }

  const destination = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  c.header('set-cookie', await createSessionCookie(c.env, token.label));
  return c.redirect(destination, 303);
});

app.post('/logout', (c) => {
  c.header('set-cookie', clearSessionCookie());
  return c.redirect('/login', 303);
});

/** Everything below this point needs a valid session cookie. */
app.use('*', async (c, next) => {
  const label = await readSessionLabel(c.env, c.req.header('cookie'));
  const token = label ? tokenByLabel(c.env, label) : null;
  if (!token) {
    const url = new URL(c.req.url);
    c.header('set-cookie', clearSessionCookie());
    return c.redirect(`/login${queryString({ next: url.pathname + url.search })}`, 303);
  }
  c.set('token', token);
  await next();
});

// -------------------------------------------------------------------- UI pages

function readFilters(url: URL): Filters {
  const type = url.searchParams.get('type');
  return {
    type: type === 'project' || type === 'user' ? type : 'both',
    project: url.searchParams.get('project') || undefined,
    q: url.searchParams.get('q') || undefined,
  };
}

function parseCursor(value: string | null): Cursor | undefined {
  if (!value) return undefined;
  const separator = value.indexOf('.');
  if (separator <= 0) return undefined;
  const createdAt = Number(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (!Number.isFinite(createdAt) || !looksLikeEntryId(id)) return undefined;
  return { createdAt, id };
}

app.get('/', async (c) => {
  const url = new URL(c.req.url);
  const filters = readFilters(url);
  if (filters.q) {
    return c.redirect(
      `/search${queryString({ q: filters.q, type: filters.type, project: filters.project })}`,
      303
    );
  }

  const [{ entries, nextCursor }, projects] = await Promise.all([
    listEntries(c.env.DB, {
      scope: filters.type,
      project: filters.project,
      limit: PAGE_SIZE,
      cursor: parseCursor(url.searchParams.get('cursor')),
    }),
    listProjects(c.env.DB),
  ]);

  const nextHref = nextCursor
    ? `/${queryString({
        type: filters.type === 'both' ? undefined : filters.type,
        project: filters.project,
        cursor: `${nextCursor.createdAt}.${nextCursor.id}`,
      })}`
    : null;

  return c.html(listPage({ entries, filters, projects, nextHref }));
});

app.get('/search', async (c) => {
  const url = new URL(c.req.url);
  const filters = readFilters(url);
  const projects = await listProjects(c.env.DB);
  const match = filters.q ? buildMatchQuery(filters.q) : null;

  const hits = match
    ? await searchEntries(c.env.DB, {
        match,
        scope: filters.type,
        project: filters.project,
        limit: PAGE_SIZE,
      })
    : [];

  return c.html(searchPage({ hits, filters, projects }));
});

app.get('/entries/:id', async (c) => {
  const entry = await getEntry(c.env.DB, c.req.param('id'));
  if (!entry) return c.html(errorPage(404, 'No such entry.'), 404);
  const { newer, older } = await adjacentEntries(c.env.DB, entry);
  return c.html(entryPage({ entry, timeZone: journalTimeZone(c.env), newer, older }));
});

app.get('/entries/:id/delete', async (c) => {
  const entry = await getEntry(c.env.DB, c.req.param('id'));
  if (!entry) return c.html(errorPage(404, 'No such entry.'), 404);
  const csrf = await issueCsrf(c.env);
  return c.html(deleteConfirmPage({ entry, csrf: csrf.token }), 200, {
    'set-cookie': csrf.cookie,
  });
});

app.post('/entries/:id/delete', async (c) => {
  const form = await c.req.formData();
  if (!(await verifyCsrf(c.env, c.req.header('cookie'), form.get('csrf_token')))) {
    return c.html(errorPage(403, 'Invalid or missing CSRF token.'), 403);
  }
  const removed = await deleteEntry(c.env.DB, c.req.param('id'));
  if (!removed) return c.html(errorPage(404, 'No such entry.'), 404);
  return c.redirect('/', 303);
});

app.notFound((c) => c.html(errorPage(404, 'Not found.'), 404));

app.onError((error, c) => {
  console.error('Unhandled request error', error);
  const accepts = c.req.header('accept') ?? '';
  if (accepts.includes('application/json') || new URL(c.req.url).pathname === '/mcp') {
    return c.json({ error: 'server_error', error_description: 'Internal error' }, 500);
  }
  return c.html(errorPage(500, 'Something went wrong.'), 500);
});

export default app;
export type { Env };
