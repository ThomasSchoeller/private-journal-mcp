import { describe, expect, it } from 'vitest';
import {
  PROJECT_SECTIONS,
  SECTION_KEYS,
  USER_SECTIONS,
  formatLocalDate,
  formatTitle,
  isSectionKey,
  orderedSections,
  plainExcerpt,
  renderBody,
  renderEntryMarkdown,
} from '../src/entry.js';

const TZ = 'Europe/Berlin';

describe('entry rendering', () => {
  it('renders sections in canonical order with their headings', () => {
    const body = renderBody({
      world_knowledge: 'Ravens can plan ahead.',
      reflections: 'A long day.',
      project_notes: 'The D1 batch API is atomic.',
    });

    expect(body).toBe(
      '## Reflections\n\nA long day.\n\n' +
        '## Project Notes\n\nThe D1 batch API is atomic.\n\n' +
        '## World Knowledge\n\nRavens can plan ahead.'
    );
  });

  it('numbers positions by rendered order, not by the canonical list', () => {
    expect(orderedSections({ world_knowledge: 'w', observations: 'o' })).toEqual([
      { section: 'observations', content: 'o', position: 0 },
      { section: 'world_knowledge', content: 'w', position: 1 },
    ]);
  });

  it('splits project notes from user sections', () => {
    expect(PROJECT_SECTIONS).toEqual(['project_notes']);
    expect(USER_SECTIONS).toEqual([
      'reflections',
      'observations',
      'user_context',
      'technical_insights',
      'world_knowledge',
    ]);
    expect([...PROJECT_SECTIONS, ...USER_SECTIONS].sort()).toEqual([...SECTION_KEYS].sort());
  });

  it('recognises section keys', () => {
    expect(isSectionKey('technical_insights')).toBe(true);
    expect(isSectionKey('Technical Insights')).toBe(false);
  });

  it('formats the title the way the local server does', () => {
    // 2025-05-31T12:30:45Z is 14:30:45 in Berlin (CEST). Modern ICU separates
    // the AM/PM marker with a narrow no-break space; the shape is what matters.
    const title = formatTitle(new Date('2025-05-31T12:30:45.000Z'), TZ);
    expect(title.replace(/\u202f/g, ' ')).toBe('2:30:45 PM - May 31, 2025');
  });

  it('derives local_date in the configured zone', () => {
    // 22:30 UTC on the 31st is already the 1st in Berlin.
    expect(formatLocalDate(new Date('2025-05-31T22:30:00.000Z'), TZ)).toBe('2025-06-01');
    expect(formatLocalDate(new Date('2025-05-31T22:30:00.000Z'), 'UTC')).toBe('2025-05-31');
  });

  it('regenerates frontmatter around the stored body', () => {
    const createdAt = Date.parse('2025-05-31T12:30:45.000Z');
    const markdown = renderEntryMarkdown({
      title: '2:30:45 PM - May 31, 2025',
      createdAt,
      body: '## Reflections\n\nA long day.',
    });

    expect(markdown).toBe(
      '---\n' +
        'title: "2:30:45 PM - May 31, 2025"\n' +
        'date: 2025-05-31T12:30:45.000Z\n' +
        `timestamp: ${createdAt}\n` +
        '---\n\n' +
        '## Reflections\n\nA long day.\n'
    );
  });

  it('builds excerpts without headings', () => {
    expect(plainExcerpt('## Reflections\n\nHello   there\n\n## Observations\n\nAgain')).toBe(
      'Hello there Again'
    );
    expect(plainExcerpt('x'.repeat(500))).toHaveLength(201);
  });
});
