// ABOUTME: Page shell and inline stylesheet for the server-rendered journal UI
// ABOUTME: No client JavaScript ships, which is what lets the CSP forbid scripts outright

import { escapeHtml } from './markdown.js';

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf8;
  --panel: #ffffff;
  --text: #1d1c1a;
  --muted: #6b6862;
  --line: #e4e0d8;
  --accent: #6b4f2a;
  --mark: #fbe6a2;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16151a;
    --panel: #1e1d23;
    --text: #eceaf2;
    --muted: #9b98a6;
    --line: #32303a;
    --accent: #d3b98c;
    --mark: #5a4a1c;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
a { color: var(--accent); }
header.site {
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
header.site .inner, main { max-width: 46rem; margin: 0 auto; padding: 1rem 1.25rem; }
header.site .inner { display: flex; gap: 1rem; align-items: baseline; justify-content: space-between; }
header.site h1 { font-size: 1.05rem; margin: 0; letter-spacing: 0.01em; }
header.site nav { display: flex; gap: 0.75rem; align-items: baseline; }
form.inline { display: inline; }
button, input[type="submit"] {
  font: inherit;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  border-radius: 0.4rem;
  padding: 0.35rem 0.75rem;
  cursor: pointer;
}
button.danger { border-color: #a4402f; color: #a4402f; }
input[type="text"], input[type="password"], input[type="search"], select {
  font: inherit;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--line);
  border-radius: 0.4rem;
  background: var(--panel);
  color: var(--text);
}
.filters { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0 0 1.5rem; }
.filters input[type="search"] { flex: 1 1 14rem; }
h2.day {
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 2rem 0 0.75rem;
}
article.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 0.6rem;
  padding: 0.9rem 1rem;
  margin-bottom: 0.75rem;
}
article.card h3 { margin: 0 0 0.35rem; font-size: 1rem; }
article.card h3 a { text-decoration: none; }
.meta { color: var(--muted); font-size: 0.82rem; display: flex; flex-wrap: wrap; gap: 0.5rem; }
.excerpt { margin: 0.5rem 0 0; color: var(--muted); font-size: 0.92rem; }
mark { background: var(--mark); color: inherit; padding: 0 0.1em; border-radius: 0.15em; }
.entry-body { margin-top: 1.5rem; }
.entry-body h2 {
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 1.75rem 0 0.5rem;
}
.entry-body pre {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 0.4rem;
  padding: 0.75rem;
  overflow-x: auto;
}
.entry-body code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
.entry-body blockquote {
  margin: 0.75rem 0;
  padding-left: 0.9rem;
  border-left: 3px solid var(--line);
  color: var(--muted);
}
.pager { display: flex; justify-content: space-between; margin: 2rem 0; }
.notice { border: 1px solid var(--line); border-left: 3px solid #a4402f; padding: 0.6rem 0.8rem; border-radius: 0.4rem; }
.empty { color: var(--muted); font-style: italic; }
.login { max-width: 22rem; margin: 4rem auto; }
.login label { display: block; margin-bottom: 0.4rem; font-size: 0.9rem; color: var(--muted); }
.login input { width: 100%; margin-bottom: 0.9rem; }
footer.site { color: var(--muted); font-size: 0.8rem; text-align: center; padding: 2rem 1rem; }
`;

export interface LayoutOptions {
  title: string;
  /** Rendered without the site header — used for login and OAuth consent. */
  bare?: boolean;
}

export function page(options: LayoutOptions, body: string): string {
  const header = options.bare
    ? ''
    : `<header class="site"><div class="inner">
         <h1><a href="/">Private journal</a></h1>
         <nav>
           <a href="/search">Search</a>
           <form class="inline" method="post" action="/logout"><button type="submit">Log out</button></form>
         </nav>
       </div></header>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(options.title)}</title>
<style>${STYLES}</style>
</head>
<body>
${header}
<main>
${body}
</main>
<footer class="site">private-journal-mcp</footer>
</body>
</html>`;
}

export function queryString(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered.length > 0 ? `?${rendered}` : '';
}
