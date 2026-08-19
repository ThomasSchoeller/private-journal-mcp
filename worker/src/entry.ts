// ABOUTME: Pure entry-shaping logic — section names, titles, markdown rendering, excerpts
// ABOUTME: Mirrors src/journal.ts byte for byte; kept dependency-free so it runs on Workers

export const SECTION_KEYS = [
  'reflections',
  'observations',
  'project_notes',
  'user_context',
  'technical_insights',
  'world_knowledge',
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

/** Heading rendered for each section, matching the local stdio server. */
export const SECTION_HEADINGS: Record<SectionKey, string> = {
  reflections: 'Reflections',
  observations: 'Observations',
  project_notes: 'Project Notes',
  user_context: 'User Context',
  technical_insights: 'Technical Insights',
  world_knowledge: 'World Knowledge',
};

/** The only section that can live in the `project` scope. */
export const PROJECT_SECTIONS: readonly SectionKey[] = ['project_notes'];

/** Sections that always live in the `user` scope. */
export const USER_SECTIONS: readonly SectionKey[] = SECTION_KEYS.filter(
  (key) => !PROJECT_SECTIONS.includes(key)
);

export type Thoughts = Partial<Record<SectionKey, string>>;

export function isSectionKey(value: string): value is SectionKey {
  return (SECTION_KEYS as readonly string[]).includes(value);
}

/**
 * Sections in canonical order, skipping empty ones. `position` is the index in
 * the rendered body, not in SECTION_KEYS, so it survives a reordering of the
 * canonical list.
 */
export function orderedSections(
  thoughts: Thoughts
): Array<{ section: SectionKey; content: string; position: number }> {
  const result: Array<{ section: SectionKey; content: string; position: number }> = [];
  for (const key of SECTION_KEYS) {
    const content = thoughts[key];
    if (content) {
      result.push({ section: key, content, position: result.length });
    }
  }
  return result;
}

/** The `## Heading` blocks of an entry — what is stored in `entries.body`. */
export function renderBody(thoughts: Thoughts): string {
  return orderedSections(thoughts)
    .map(({ section, content }) => `## ${SECTION_HEADINGS[section]}\n\n${content}`)
    .join('\n\n');
}

/** `2:30:45 PM - May 31, 2025`, as produced by JournalManager. */
export function formatTitle(timestamp: Date, timeZone: string): string {
  const timeDisplay = timestamp.toLocaleTimeString('en-US', {
    hour12: true,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZone,
  });
  const dateDisplay = timestamp.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone,
  });
  return `${timeDisplay} - ${dateDisplay}`;
}

/** `YYYY-MM-DD` in the given zone, used to group entries by day. */
export function formatLocalDate(timestamp: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).formatToParts(timestamp);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The full markdown document a reader gets back: YAML frontmatter plus the
 * stored body. Frontmatter is regenerated rather than stored so MCP output
 * stays identical to the file the local server would have written.
 */
export function renderEntryMarkdown(entry: {
  title: string;
  createdAt: number;
  body: string;
}): string {
  return `---
title: "${entry.title}"
date: ${new Date(entry.createdAt).toISOString()}
timestamp: ${entry.createdAt}
---

${entry.body}
`;
}

/** Convenience wrapper used by the parity test: thoughts straight to markdown. */
export function renderThoughtsMarkdown(
  thoughts: Thoughts,
  timestamp: Date,
  timeZone: string
): string {
  return renderEntryMarkdown({
    title: formatTitle(timestamp, timeZone),
    createdAt: timestamp.getTime(),
    body: renderBody(thoughts),
  });
}

/** Fallback excerpt for entries FTS did not produce a snippet for. */
export function plainExcerpt(body: string, maxLength = 200): string {
  const text = body
    .replace(/^##\s+.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}…`;
}
