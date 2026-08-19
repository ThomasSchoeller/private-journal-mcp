import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { formatLocalDate, formatTitle, type Thoughts } from '../src/entry.js';
import { insertEntry, type Scope } from '../src/store.js';
import { ORIGIN, callTool, extractCsrf, login, mergeCookies } from './helpers.js';

const TZ = 'Europe/Berlin';

async function seed(
  thoughts: Thoughts,
  options: { scope?: Scope; project?: string | null; at?: number } = {}
): Promise<string> {
  const createdAt = options.at ?? Date.now();
  return insertEntry(env.DB, {
    createdAt,
    localDate: formatLocalDate(new Date(createdAt), TZ),
    scope: options.scope ?? 'user',
    project: options.project ?? null,
    title: formatTitle(new Date(createdAt), TZ),
    thoughts,
    clientLabel: 'laptop',
    createdTz: TZ,
  });
}

async function get(path: string, cookie: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie }, redirect: 'manual' });
}

describe('entry list', () => {
  it('groups entries by local date, newest first', async () => {
    const cookie = await login();
    const day = Date.parse('2025-05-31T12:00:00.000Z');
    await seed({ reflections: 'Older thought.' }, { at: day });
    await seed({ reflections: 'Newer thought.' }, { at: day + 60_000 });
    await seed({ reflections: 'Yesterday.' }, { at: day - 24 * 60 * 60 * 1000 });

    const html = await (await get('/', cookie)).text();
    expect(html).toContain('2025-05-31');
    expect(html).toContain('2025-05-30');
    expect(html.indexOf('Newer thought.')).toBeLessThan(html.indexOf('Older thought.'));
    expect(html.indexOf('2025-05-31')).toBeLessThan(html.indexOf('2025-05-30'));
  });

  it('says so when the journal is empty', async () => {
    const cookie = await login();
    expect(await (await get('/', cookie)).text()).toContain('No entries yet.');
  });

  it('filters by scope and offers the known projects', async () => {
    const cookie = await login();
    await seed({ project_notes: 'Project scoped.' }, { scope: 'project', project: 'alpha' });
    await seed({ reflections: 'User scoped.' });

    const all = await (await get('/', cookie)).text();
    expect(all).toContain('Project scoped.');
    expect(all).toContain('User scoped.');
    expect(all).toContain('<option value="alpha"');

    const userOnly = await (await get('/?type=user', cookie)).text();
    expect(userOnly).toContain('User scoped.');
    expect(userOnly).not.toContain('Project scoped.');

    const byProject = await (await get('/?project=alpha', cookie)).text();
    expect(byProject).toContain('Project scoped.');
    expect(byProject).not.toContain('User scoped.');
  });

  it('paginates with a cursor', async () => {
    const cookie = await login();
    const base = Date.parse('2025-05-31T12:00:00.000Z');
    for (let i = 0; i < 51; i++) {
      await seed({ reflections: `Entry number ${i}.` }, { at: base + i * 1000 });
    }

    const first = await get('/', cookie);
    const html = await first.text();
    expect(html).toContain('Entry number 50.');
    expect(html).not.toContain('Entry number 0.');

    const next = /href="(\/\?[^"]*cursor=[^"]+)"/.exec(html);
    expect(next).not.toBeNull();
    const second = await (await get(next![1].replace(/&amp;/g, '&'), cookie)).text();
    expect(second).toContain('Entry number 0.');
    expect(second).not.toContain('Entry number 50.');
  });

  it('sends a query typed in the list filter to the search page', async () => {
    const cookie = await login();
    const response = await get('/?q=sourdough&type=user', cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/search?q=sourdough&type=user');
  });
});

describe('entry detail', () => {
  it('renders the sections and the writing client', async () => {
    const cookie = await login();
    const id = await seed({
      reflections: 'A **bold** claim.',
      technical_insights: 'FTS5 needs triggers.',
    });

    const html = await (await get(`/entries/${id}`, cookie)).text();
    expect(html).toContain('<h2>Reflections</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<h2>Technical Insights</h2>');
    expect(html).toContain('via laptop');
  });

  it('escapes model-authored HTML instead of rendering it', async () => {
    const cookie = await login();
    const id = await seed({
      reflections: 'Tried <img src=x onerror="alert(1)"> and <script>alert(2)</script>.',
    });

    const html = await (await get(`/entries/${id}`, cookie)).text();
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;img src=x');
  });

  it('links to the neighbouring entries', async () => {
    const cookie = await login();
    const base = Date.parse('2025-05-31T12:00:00.000Z');
    const older = await seed({ reflections: 'Older.' }, { at: base });
    const middle = await seed({ reflections: 'Middle.' }, { at: base + 1000 });
    const newer = await seed({ reflections: 'Newer.' }, { at: base + 2000 });

    const html = await (await get(`/entries/${middle}`, cookie)).text();
    expect(html).toContain(`/entries/${newer}`);
    expect(html).toContain(`/entries/${older}`);
  });

  it('404s on an unknown entry', async () => {
    const cookie = await login();
    expect((await get('/entries/01ARZ3NDEKTSV4RRFFQ69G5FAV', cookie)).status).toBe(404);
  });
});

describe('search page', () => {
  it('highlights matched terms without trusting the database for markup', async () => {
    const cookie = await login();
    await seed({ world_knowledge: 'Sourdough <b>starters</b> are colonies of yeast.' });

    const html = await (await get('/search?q=sourdough', cookie)).text();
    expect(html).toContain('<mark>Sourdough</mark>');
    expect(html).not.toContain('<b>starters</b>');
    expect(html).toContain('&lt;b&gt;starters&lt;/b&gt;');
  });

  it('prompts for a query before searching', async () => {
    const cookie = await login();
    expect(await (await get('/search', cookie)).text()).toContain('Enter a query');
  });

  it('reports an empty result set', async () => {
    const cookie = await login();
    await seed({ reflections: 'Nothing relevant here.' });
    expect(await (await get('/search?q=helicopter', cookie)).text()).toContain(
      'No relevant entries found.'
    );
  });
});

describe('delete flow', () => {
  async function confirmPage(id: string, cookie: string) {
    const response = await get(`/entries/${id}/delete`, cookie);
    const html = await response.text();
    return {
      csrf: extractCsrf(html),
      cookie: mergeCookies(cookie, (response.headers.get('set-cookie') ?? '').split(';')[0]),
      html,
    };
  }

  it('asks for confirmation, then removes the entry and its search row', async () => {
    const sessionCookie = await login();
    const id = await seed({ reflections: 'Delete me, sourdough included.' });

    const confirm = await confirmPage(id, sessionCookie);
    expect(confirm.html).toContain('Delete this entry?');

    const response = await SELF.fetch(`${ORIGIN}/entries/${id}/delete`, {
      method: 'POST',
      headers: { cookie: confirm.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf_token: confirm.csrf }),
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');

    expect((await get(`/entries/${id}`, sessionCookie)).status).toBe(404);
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM entry_sections').first<{ n: number }>()
    ).toEqual({ n: 0 });
    expect((await callTool('search_journal', { query: 'sourdough' })).text).toBe(
      'No relevant entries found.'
    );
  });

  it('refuses a delete without a CSRF token', async () => {
    const cookie = await login();
    const id = await seed({ reflections: 'Still here.' });

    const response = await SELF.fetch(`${ORIGIN}/entries/${id}/delete`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
    });
    expect(response.status).toBe(403);
    expect((await get(`/entries/${id}`, cookie)).status).toBe(200);
  });

  it('refuses a delete whose CSRF token was not issued to this browser', async () => {
    const cookie = await login();
    const id = await seed({ reflections: 'Still here too.' });
    const confirm = await confirmPage(id, cookie);

    const response = await SELF.fetch(`${ORIGIN}/entries/${id}/delete`, {
      method: 'POST',
      // The session cookie, but not the CSRF cookie that pairs with the field.
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf_token: confirm.csrf }),
    });
    expect(response.status).toBe(403);
    expect((await get(`/entries/${id}`, cookie)).status).toBe(200);
  });

  it('404s when deleting something that is already gone', async () => {
    const cookie = await login();
    const id = await seed({ reflections: 'Gone in a moment.' });
    const confirm = await confirmPage(id, cookie);
    await env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();

    const response = await SELF.fetch(`${ORIGIN}/entries/${id}/delete`, {
      method: 'POST',
      headers: { cookie: confirm.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf_token: confirm.csrf }),
    });
    expect(response.status).toBe(404);
  });
});
