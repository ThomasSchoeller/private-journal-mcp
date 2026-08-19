// ABOUTME: Asserts the Worker renders a journal entry byte for byte like the local server
// ABOUTME: Runs in Node so it can drive the real JournalManager against a temp directory

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderThoughtsMarkdown } from '../src/entry.js';

// The local server generates embeddings on write; that machinery is irrelevant
// here and would pull the transformers runtime into the test.
vi.mock('../../src/embeddings.js', () => ({
  EmbeddingService: {
    getInstance: () => ({
      extractSearchableText: () => ({ text: '', sections: [] }),
      generateEmbedding: async () => [],
      saveEmbedding: async () => {},
    }),
  },
}));

const TZ = 'Europe/Berlin';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-parity-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Writes through JournalManager and returns the single file it produced. */
async function writeLocally(thoughts: Record<string, string>): Promise<{
  content: string;
  timestamp: Date;
}> {
  const { JournalManager } = await import('../../src/journal.js');
  const projectPath = path.join(root, 'project');
  const userPath = path.join(root, 'user');
  const manager = new JournalManager(projectPath, userPath);

  const before = Date.now();
  await manager.writeThoughts(thoughts);

  const base = thoughts.project_notes && Object.keys(thoughts).length === 1 ? projectPath : userPath;
  const days = await fs.readdir(base);
  const files = await fs.readdir(path.join(base, days[0]));
  const content = await fs.readFile(path.join(base, days[0], files[0]), 'utf8');

  const timestamp = new Date(Number(/^timestamp: (\d+)$/m.exec(content)![1]));
  expect(timestamp.getTime()).toBeGreaterThanOrEqual(before - 1000);
  return { content, timestamp };
}

describe('markdown parity with the local server', () => {
  it('matches for a single section', async () => {
    const thoughts = { reflections: 'A quiet afternoon, and a long one.' };
    const { content, timestamp } = await writeLocally(thoughts);
    expect(renderThoughtsMarkdown(thoughts, timestamp, TZ)).toBe(content);
  });

  it('matches for every section at once, in canonical order', async () => {
    const thoughts = {
      reflections: 'Reflecting.',
      observations: 'Noticing.',
      project_notes: 'Project detail.',
      user_context: 'They prefer terse answers.',
      technical_insights: 'FTS5 needs triggers.',
      world_knowledge: 'Ravens plan ahead.',
    };
    // The local server splits project notes out; compare the user-side file
    // against the same subset the Worker would store as one user entry.
    const { content, timestamp } = await writeLocally(thoughts);
    const { project_notes: _projectNotes, ...userThoughts } = thoughts;
    expect(renderThoughtsMarkdown(userThoughts, timestamp, TZ)).toBe(content);
  });

  it('matches for a project-notes-only entry', async () => {
    const thoughts = { project_notes: 'The D1 batch API is atomic.' };
    const { content, timestamp } = await writeLocally(thoughts);
    expect(renderThoughtsMarkdown(thoughts, timestamp, TZ)).toBe(content);
  });

  it('matches when the content contains markdown and blank lines', async () => {
    const thoughts = {
      reflections: '## Not a section\n\n- one\n- two\n\n```ts\nconst x = 1;\n```',
    };
    const { content, timestamp } = await writeLocally(thoughts);
    expect(renderThoughtsMarkdown(thoughts, timestamp, TZ)).toBe(content);
  });
});
