// ABOUTME: FTS5 query construction, ranking and snippet handling for journal search
// ABOUTME: Pure functions — the SQL that uses them lives in store.ts

/**
 * Words dropped from natural-language queries. Callers pass whole sentences
 * ("times I felt frustrated with TypeScript"), and leaving these in would let
 * ubiquitous words dominate the bm25 ranking.
 */
const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'between', 'both', 'but', 'by',
  'can', 'did', 'do', 'does', 'doing', 'during', 'each', 'few', 'for', 'from',
  'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him',
  'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'more',
  'most', 'my', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only',
  'or', 'other', 'our', 'out', 'over', 'own', 'same', 'she', 'should', 'so',
  'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until',
  'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while',
  'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your',
]);

/**
 * Snippet delimiters handed to FTS5 `snippet()`. Control characters, so they
 * cannot collide with model-authored entry text and never reach a response
 * un-rewritten.
 */
export const HIGHLIGHT_START = '\u0001';
export const HIGHLIGHT_END = '\u0002';

function quotePhrase(phrase: string): string {
  return `"${phrase.replace(/"/g, '""')}"`;
}

/**
 * Turns a natural-language query into an FTS5 MATCH expression.
 *
 * Quoted substrings survive as phrase queries; everything else is lowercased,
 * stripped of FTS5 operator characters, filtered against {@link STOPWORDS} and
 * joined with `OR`. The disjunction matters: an implicit AND would make any
 * sentence-shaped query match nothing.
 *
 * Returns `null` when nothing searchable is left, which callers treat as
 * "no results" rather than as a SQL error.
 */
export function buildMatchQuery(query: string): string | null {
  const phrases: string[] = [];
  const rest = query.replace(/"([^"]*)"/g, (_match, phrase: string) => {
    const cleaned = phrase.trim();
    if (cleaned.length > 0) phrases.push(cleaned.toLowerCase());
    return ' ';
  });

  const tokens = rest
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'_-]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^[-'_]+|[-'_]+$/g, ''))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));

  const terms = [...phrases, ...tokens];
  if (terms.length === 0) return null;

  return [...new Set(terms)].map(quotePhrase).join(' OR ');
}

/**
 * Maps bm25 (negative, lower is better) onto a monotonic 0…1 score so the
 * rendered `[Score: 0.812]` line keeps the meaning it has on the local server.
 */
export function bm25ToScore(rank: number): number {
  return 1 / (1 + Math.exp(rank));
}

/** Rewrites FTS5 snippet delimiters for plain-text (MCP tool) output. */
export function snippetToText(snippet: string): string {
  return snippet
    .split(HIGHLIGHT_START)
    .join('**')
    .split(HIGHLIGHT_END)
    .join('**')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits a snippet into plain and highlighted runs so the UI can escape each
 * run itself instead of trusting markup that came out of the database.
 */
export function snippetSegments(snippet: string): Array<{ text: string; highlight: boolean }> {
  const segments: Array<{ text: string; highlight: boolean }> = [];
  let rest = snippet;
  while (rest.length > 0) {
    const start = rest.indexOf(HIGHLIGHT_START);
    if (start === -1) {
      segments.push({ text: rest, highlight: false });
      break;
    }
    if (start > 0) segments.push({ text: rest.slice(0, start), highlight: false });
    const end = rest.indexOf(HIGHLIGHT_END, start + 1);
    if (end === -1) {
      segments.push({ text: rest.slice(start + 1), highlight: true });
      break;
    }
    segments.push({ text: rest.slice(start + 1, end), highlight: true });
    rest = rest.slice(end + 1);
  }
  return segments.filter((segment) => segment.text.length > 0);
}
