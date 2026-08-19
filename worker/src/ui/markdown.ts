// ABOUTME: Minimal, escape-first markdown renderer for model-authored entry bodies
// ABOUTME: Raw HTML is never passed through — every character is escaped before markup is added

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SAFE_SCHEME = /^(https?:\/\/|mailto:)/i;

/**
 * Inline markup, applied to already-escaped text. Code spans win over emphasis,
 * matching how the source reads, and link targets are restricted to http(s) and
 * mailto so an entry cannot smuggle a `javascript:` URL into the page.
 */
function renderInline(escaped: string): string {
  const codeSpans: string[] = [];
  let text = escaped.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return `<code-span-${codeSpans.length - 1}>`;
  });

  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (match, label: string, href: string) =>
      SAFE_SCHEME.test(href) ? `<a href="${href}" rel="noopener noreferrer">${label}</a>` : match
  );
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<em>$2</em>');

  return text.replace(/<code-span-(\d+)>/g, (_match, index: string) => codeSpans[Number(index)]);
}

function flushParagraph(lines: string[], out: string[]): void {
  if (lines.length === 0) return;
  out.push(`<p>${renderInline(escapeHtml(lines.join('\n'))).replace(/\n/g, '<br>')}</p>`);
  lines.length = 0;
}

function flushList(items: string[], ordered: boolean, out: string[]): void {
  if (items.length === 0) return;
  const tag = ordered ? 'ol' : 'ul';
  out.push(
    `<${tag}>${items.map((item) => `<li>${renderInline(escapeHtml(item))}</li>`).join('')}</${tag}>`
  );
  items.length = 0;
}

/** Renders a markdown document to HTML. The output contains no author markup. */
export function renderMarkdown(source: string): string {
  const out: string[] = [];
  const paragraph: string[] = [];
  const listItems: string[] = [];
  let listOrdered = false;
  let quoteLines: string[] = [];

  const flushQuote = () => {
    if (quoteLines.length === 0) return;
    out.push(`<blockquote>${renderMarkdown(quoteLines.join('\n'))}</blockquote>`);
    quoteLines = [];
  };
  const flushAll = () => {
    flushParagraph(paragraph, out);
    flushList(listItems, listOrdered, out);
    flushQuote();
  };

  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      flushAll();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : '';
      out.push(`<pre><code${language}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (line.trim().length === 0) {
      flushAll();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph(paragraph, out);
      flushList(listItems, listOrdered, out);
      quoteLines.push(quote[1]);
      continue;
    }
    flushQuote();

    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph(paragraph, out);
      const isOrdered = ordered !== null;
      if (listItems.length > 0 && listOrdered !== isOrdered) {
        flushList(listItems, listOrdered, out);
      }
      listOrdered = isOrdered;
      listItems.push((unordered ?? ordered)![1]);
      continue;
    }

    flushList(listItems, listOrdered, out);
    paragraph.push(line);
  }

  flushAll();
  return out.join('\n');
}
