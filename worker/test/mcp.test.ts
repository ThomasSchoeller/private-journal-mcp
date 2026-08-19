import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  LAPTOP_TOKEN,
  MODERN_PROTOCOL_VERSION,
  ORIGIN,
  WEB_TOKEN,
  callTool,
  mcpRequest,
  readJsonRpc,
} from './helpers.js';

const TOOL_NAMES = [
  'process_thoughts',
  'search_journal',
  'read_journal_entry',
  'list_recent_entries',
  'read_recent_entries',
];

/** Pulls the `Path:` values out of a search or list result. */
function idsFrom(text: string): string[] {
  return [...text.matchAll(/^\s*Path: (\S+)$/gm)].map((match) => match[1]);
}

describe('protocol', () => {
  it('lists exactly the tools the local server exposes', async () => {
    const message = await readJsonRpc(await mcpRequest('tools/list'));
    const tools = message.result?.tools as Array<{ name: string; description: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools.find((tool) => tool.name === 'search_journal')?.description).toBe(
      'Search through your private journal entries using natural language queries. Returns semantically similar entries ranked by relevance.'
    );
  });

  it('answers server/discover on the modern revision', async () => {
    const response = await mcpRequest('server/discover');
    expect(response.status).toBe(200);
    const message = await readJsonRpc(response);
    expect(message.error).toBeUndefined();
    expect(message.result).toBeDefined();
  });

  it('still serves a legacy initialize handshake', async () => {
    const response = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${LAPTOP_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'legacy-client', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(200);
    const message = await readJsonRpc(response);
    expect(message.error).toBeUndefined();
    expect((message.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      'private-journal-mcp'
    );
    expect((message.result as { protocolVersion: string }).protocolVersion).not.toBe(
      MODERN_PROTOCOL_VERSION
    );
  });
});

describe('process_thoughts', () => {
  it('records thoughts and reports success', async () => {
    const result = await callTool('process_thoughts', { reflections: 'A quiet afternoon.' });
    expect(result.isError).toBe(false);
    expect(result.text).toBe('Thoughts recorded successfully.');
  });

  it('rejects a call with no sections', async () => {
    const result = await callTool('process_thoughts', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('At least one thought category');
  });

  it("files project notes under the token's default project", async () => {
    await callTool('process_thoughts', {
      project_notes: 'D1 batch is atomic.',
      reflections: 'Learned something.',
    });

    const projectOnly = await callTool('list_recent_entries', { type: 'project' });
    expect(projectOnly.text).toContain('(project/private-journal-mcp)');
    expect(projectOnly.text).toContain('Sections: Project Notes');

    const userOnly = await callTool('list_recent_entries', { type: 'user' });
    expect(userOnly.text).toContain('Sections: Reflections');
    expect(userOnly.text).not.toContain('Project Notes');
  });

  it('lets an explicit project argument win over the token default', async () => {
    await callTool('process_thoughts', {
      project_notes: 'Notes for another repo.',
      project: 'other-repo',
    });

    const listed = await callTool('list_recent_entries', { type: 'project' });
    expect(listed.text).toContain('(project/other-repo)');
  });

  it('files project notes as user-scoped when no project is known', async () => {
    await callTool(
      'process_thoughts',
      { project_notes: 'No project configured here.' },
      { token: WEB_TOKEN }
    );

    const projectOnly = await callTool('list_recent_entries', { type: 'project' });
    expect(projectOnly.text).toContain('No entries found');

    const userOnly = await callTool('list_recent_entries', { type: 'user' });
    expect(userOnly.text).toContain('Sections: Project Notes');
  });

  it('always keeps the non-project sections user-scoped', async () => {
    await callTool('process_thoughts', {
      user_context: 'They prefer terse answers.',
      technical_insights: 'FTS5 external content tables need triggers.',
      world_knowledge: 'Ravens plan ahead.',
      observations: 'This keeps coming up.',
      project: 'some-repo',
    });

    const projectOnly = await callTool('list_recent_entries', { type: 'project' });
    expect(projectOnly.text).toContain('No entries found');

    const userOnly = await callTool('list_recent_entries', { type: 'user' });
    expect(userOnly.text).toContain(
      'Sections: Observations, User Context, Technical Insights, World Knowledge'
    );
  });
});

describe('read_journal_entry', () => {
  it('returns the full markdown, frontmatter and all', async () => {
    await callTool('process_thoughts', { reflections: 'Frontmatter comes back on read.' });
    const listed = await callTool('list_recent_entries', {});
    const [id] = idsFrom(listed.text);

    const entry = await callTool('read_journal_entry', { path: id });
    expect(entry.isError).toBe(false);
    expect(entry.text).toMatch(/^---\ntitle: "/);
    expect(entry.text).toContain('## Reflections\n\nFrontmatter comes back on read.');
  });

  it('accepts the journal:// URI form', async () => {
    await callTool('process_thoughts', { reflections: 'Reachable by URI.' });
    const [id] = idsFrom((await callTool('list_recent_entries', {})).text);

    const entry = await callTool('read_journal_entry', { path: `journal://entry/${id}` });
    expect(entry.text).toContain('Reachable by URI.');
  });

  it('names the id form when handed a filesystem path', async () => {
    const result = await callTool('read_journal_entry', {
      path: '/home/user/.private-journal/2025-05-31/14-30-45-123456.md',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not a journal entry id');
    expect(result.text).toContain('journal://entry/');
  });

  it('reports a missing entry', async () => {
    const result = await callTool('read_journal_entry', {
      path: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Entry not found');
  });
});

describe('search_journal', () => {
  async function seed(): Promise<void> {
    await callTool('process_thoughts', {
      reflections: 'I felt frustrated with TypeScript generics again today.',
    });
    await callTool('process_thoughts', {
      technical_insights: 'SQLite FTS5 external content tables stay in sync through triggers.',
    });
    await callTool('process_thoughts', {
      world_knowledge: 'Sourdough starters are colonies of yeast and lactobacilli.',
    });
  }

  it('finds entries by natural-language query and scores them', async () => {
    await seed();
    const result = await callTool('search_journal', {
      query: 'times I felt frustrated with TypeScript',
    });

    expect(result.text).toMatch(/^Found \d+ relevant entries:/);
    expect(result.text).toMatch(/\[Score: 0\.\d{3}\]/);
    expect(result.text).toContain('frustrated');
    expect(result.text.indexOf('frustrated')).toBeLessThan(
      result.text.indexOf('Sourdough') === -1 ? Number.MAX_SAFE_INTEGER : result.text.indexOf('Sourdough')
    );
  });

  it('highlights matched terms in the excerpt', async () => {
    await seed();
    const result = await callTool('search_journal', { query: 'sourdough' });
    expect(result.text).toContain('**Sourdough**');
  });

  it('filters by section, accepting keys or headings', async () => {
    await seed();
    const byKey = await callTool('search_journal', {
      query: 'triggers frustrated sourdough',
      sections: ['technical_insights'],
    });
    expect(byKey.text).toContain('Technical Insights');
    expect(byKey.text).not.toContain('Reflections');

    const byHeading = await callTool('search_journal', {
      query: 'triggers frustrated sourdough',
      sections: ['Technical Insights'],
    });
    expect(byHeading.text).toContain('Technical Insights');
  });

  it('filters by scope and project', async () => {
    await callTool('process_thoughts', { project_notes: 'Migration ordering matters.' });
    await callTool('process_thoughts', { reflections: 'Migration ordering was confusing.' });

    const project = await callTool('search_journal', { query: 'migration', type: 'project' });
    expect(idsFrom(project.text)).toHaveLength(1);
    expect(project.text).toContain('(project/private-journal-mcp)');

    const scoped = await callTool('search_journal', {
      query: 'migration',
      project: 'private-journal-mcp',
    });
    expect(idsFrom(scoped.text)).toHaveLength(1);

    const both = await callTool('search_journal', { query: 'migration' });
    expect(idsFrom(both.text)).toHaveLength(2);
  });

  it('honours the limit', async () => {
    await seed();
    const result = await callTool('search_journal', {
      query: 'frustrated triggers sourdough',
      limit: 1,
    });
    expect(idsFrom(result.text)).toHaveLength(1);
  });

  it('says so plainly when nothing matches', async () => {
    await seed();
    expect((await callTool('search_journal', { query: 'helicopter' })).text).toBe(
      'No relevant entries found.'
    );
    expect((await callTool('search_journal', { query: 'the and of' })).text).toBe(
      'No relevant entries found.'
    );
  });

  it('hands back ids that read_journal_entry accepts verbatim', async () => {
    await seed();
    const search = await callTool('search_journal', { query: 'sourdough' });
    const [id] = idsFrom(search.text);
    const entry = await callTool('read_journal_entry', { path: id });
    expect(entry.isError).toBe(false);
    expect(entry.text).toContain('Sourdough');
  });
});

describe('list_recent_entries and read_recent_entries', () => {
  it('lists newest first', async () => {
    await callTool('process_thoughts', { reflections: 'First entry.' });
    await callTool('process_thoughts', { reflections: 'Second entry.' });

    const listed = await callTool('list_recent_entries', {});
    expect(listed.text).toMatch(/^Recent entries \(last 30 days\):/);
    expect(listed.text.indexOf('Second entry.')).toBeLessThan(listed.text.indexOf('First entry.'));
  });

  it('reports an empty window rather than failing', async () => {
    await callTool('process_thoughts', { reflections: 'Today.' });
    const listed = await callTool('list_recent_entries', { days: 0 });
    expect(listed.text).toBe('No entries found in the last 0 days.');
  });

  it('reads full entries with their frontmatter', async () => {
    await callTool('process_thoughts', { reflections: 'Full text please.' });
    const read = await callTool('read_recent_entries', { limit: 5 });
    expect(read.text).toContain('--- Entry 1 (');
    expect(read.text).toContain('## Reflections\n\nFull text please.');
    expect(read.text).toContain('timestamp: ');
  });

  it('says so when there is nothing to read', async () => {
    expect((await callTool('read_recent_entries', {})).text).toBe('No recent entries found.');
  });
});
