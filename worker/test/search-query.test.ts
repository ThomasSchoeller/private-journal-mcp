import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  bm25ToScore,
  buildMatchQuery,
  snippetSegments,
  snippetToText,
} from '../src/search.js';

describe('buildMatchQuery', () => {
  it('turns a sentence into a disjunction of content words', () => {
    expect(buildMatchQuery('times I felt frustrated with TypeScript')).toBe(
      '"times" OR "felt" OR "frustrated" OR "typescript"'
    );
  });

  it('keeps quoted substrings as phrases', () => {
    expect(buildMatchQuery('notes about "rate limiting" and caching')).toBe(
      '"rate limiting" OR "notes" OR "caching"'
    );
  });

  it('strips FTS5 operator characters instead of letting them through', () => {
    expect(buildMatchQuery('D1: batch() NEAR^ writes -atomic')).toBe(
      '"d1" OR "batch" OR "near" OR "writes" OR "atomic"'
    );
  });

  it('drops duplicates so one repeated word cannot dominate', () => {
    expect(buildMatchQuery('cache cache caching')).toBe('"cache" OR "caching"');
  });

  it('returns null when only stopwords or noise remain', () => {
    expect(buildMatchQuery('the and of it')).toBeNull();
    expect(buildMatchQuery('   ***   ')).toBeNull();
    expect(buildMatchQuery('a b c')).toBeNull();
  });

  it('always emits balanced quoted terms, whatever the punctuation', () => {
    const queries = ['"say ""hi"" now"', 'un"balanced "quote', 'a"b', '"""', 'x" OR body:y'];
    for (const query of queries) {
      const match = buildMatchQuery(query);
      if (match === null) continue;
      // An odd number of segments means every quote is part of a pair.
      expect(match.split('"').length % 2).toBe(1);
    }
  });
});

describe('ranking', () => {
  it('maps bm25 onto a monotonic 0…1 score', () => {
    const better = bm25ToScore(-8);
    const worse = bm25ToScore(-1);
    expect(better).toBeGreaterThan(worse);
    expect(better).toBeLessThanOrEqual(1);
    expect(worse).toBeGreaterThan(0);
  });
});

describe('snippets', () => {
  const snippet = `a ${HIGHLIGHT_START}match${HIGHLIGHT_END} here`;

  it('renders highlights as bold for tool output', () => {
    expect(snippetToText(snippet)).toBe('a **match** here');
  });

  it('splits into runs the UI can escape itself', () => {
    expect(snippetSegments(snippet)).toEqual([
      { text: 'a ', highlight: false },
      { text: 'match', highlight: true },
      { text: ' here', highlight: false },
    ]);
  });

  it('survives an unterminated highlight', () => {
    expect(snippetSegments(`plain ${HIGHLIGHT_START}tail`)).toEqual([
      { text: 'plain ', highlight: false },
      { text: 'tail', highlight: true },
    ]);
  });
});
