import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown } from '../src/ui/markdown.js';

describe('escapeHtml', () => {
  it('escapes every character that could start markup', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;'
    );
  });
});

describe('renderMarkdown', () => {
  it('never passes author HTML through', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\nplain <b>text</b>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders headings, lists and code blocks', () => {
    const html = renderMarkdown(
      '## Reflections\n\nA day.\n\n- one\n- two\n\n```ts\nconst x = 1 < 2;\n```'
    );
    expect(html).toContain('<h2>Reflections</h2>');
    expect(html).toContain('<p>A day.</p>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<pre><code class="language-ts">const x = 1 &lt; 2;</code></pre>');
  });

  it('keeps ordered and unordered lists apart', () => {
    const html = renderMarkdown('1. first\n2. second');
    expect(html).toBe('<ol><li>first</li><li>second</li></ol>');
  });

  it('renders inline emphasis and code spans', () => {
    const html = renderMarkdown('a **bold** and `code < here` and *em*');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code &lt; here</code>');
    expect(html).toContain('<em>em</em>');
  });

  it('does not mistake bare numbers for code-span placeholders', () => {
    expect(renderMarkdown('shipped in 2024 and 7 was fine')).toBe(
      '<p>shipped in 2024 and 7 was fine</p>'
    );
  });

  it('only links http, https and mailto targets', () => {
    const html = renderMarkdown('[ok](https://example.com) [no](javascript:alert(1))');
    expect(html).toContain('<a href="https://example.com" rel="noopener noreferrer">ok</a>');
    expect(html).not.toContain('javascript:alert(1)"');
    expect(html).toContain('[no](javascript:alert(1))');
  });

  it('renders blockquotes and rules', () => {
    const html = renderMarkdown('> quoted\n\n---');
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>');
    expect(html).toContain('<hr>');
  });
});
