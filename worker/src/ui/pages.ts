// ABOUTME: The journal UI's views — list, entry, search, delete confirmation, login, consent
// ABOUTME: Every value that came from storage or a request passes through escapeHtml first

import { SECTION_HEADINGS, formatTitle, type SectionKey } from '../entry.js';
import { snippetSegments } from '../search.js';
import { CSRF_FIELD } from '../auth/session.js';
import type { EntryRecord, EntrySummary, ScopeFilter, SearchHit } from '../store.js';
import { page, queryString } from './layout.js';
import { escapeHtml, renderMarkdown } from './markdown.js';

export interface Filters {
  type: ScopeFilter;
  project?: string;
  q?: string;
}

function csrfField(token: string): string {
  return `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(token)}">`;
}

function sectionLabels(sections: SectionKey[]): string {
  return sections.map((section) => SECTION_HEADINGS[section]).join(', ');
}

function scopeLabel(entry: { scope: string; project: string | null }): string {
  return entry.project ? `${entry.scope} · ${entry.project}` : entry.scope;
}

function filterControls(filters: Filters, projects: string[], action: string): string {
  const options = (values: Array<[string, string]>, selected: string) =>
    values
      .map(
        ([value, label]) =>
          `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`
      )
      .join('');

  return `<form class="filters" method="get" action="${action}">
    <input type="search" name="q" placeholder="Search entries" value="${escapeHtml(filters.q ?? '')}">
    <select name="type" aria-label="Scope">${options(
      [
        ['both', 'All scopes'],
        ['user', 'User'],
        ['project', 'Project'],
      ],
      filters.type
    )}</select>
    <select name="project" aria-label="Project">${options(
      [['', 'All projects'], ...projects.map((project): [string, string] => [project, project])],
      filters.project ?? ''
    )}</select>
    <button type="submit">Go</button>
  </form>`;
}

function summaryCard(entry: EntrySummary, excerptHtml: string): string {
  return `<article class="card">
    <h3><a href="/entries/${escapeHtml(entry.id)}">${escapeHtml(entry.title)}</a></h3>
    <p class="meta"><span>${escapeHtml(scopeLabel(entry))}</span><span>${escapeHtml(
      sectionLabels(entry.sections)
    )}</span></p>
    <p class="excerpt">${excerptHtml}</p>
  </article>`;
}

export function listPage(options: {
  entries: EntrySummary[];
  filters: Filters;
  projects: string[];
  nextHref: string | null;
}): string {
  const groups: Array<{ day: string; entries: EntrySummary[] }> = [];
  for (const entry of options.entries) {
    const last = groups[groups.length - 1];
    if (last && last.day === entry.localDate) last.entries.push(entry);
    else groups.push({ day: entry.localDate, entries: [entry] });
  }

  const body =
    groups.length === 0
      ? '<p class="empty">No entries yet.</p>'
      : groups
          .map(
            (group) =>
              `<h2 class="day">${escapeHtml(group.day)}</h2>` +
              group.entries
                .map((entry) => summaryCard(entry, escapeHtml(entry.excerpt)))
                .join('')
          )
          .join('');

  const pager = options.nextHref
    ? `<div class="pager"><span></span><a href="${escapeHtml(options.nextHref)}">Older →</a></div>`
    : '';

  return page(
    { title: 'Private journal' },
    `${filterControls(options.filters, options.projects, '/')}${body}${pager}`
  );
}

export function searchPage(options: {
  hits: SearchHit[];
  filters: Filters;
  projects: string[];
}): string {
  const query = options.filters.q ?? '';
  const body =
    query.trim().length === 0
      ? '<p class="empty">Enter a query to search your entries.</p>'
      : options.hits.length === 0
        ? '<p class="empty">No relevant entries found.</p>'
        : options.hits
            .map((hit) =>
              summaryCard(
                hit,
                snippetSegments(hit.snippet)
                  .map((segment) =>
                    segment.highlight
                      ? `<mark>${escapeHtml(segment.text)}</mark>`
                      : escapeHtml(segment.text)
                  )
                  .join('')
              )
            )
            .join('');

  const heading =
    query.trim().length > 0
      ? `<h2 class="day">${options.hits.length} result${options.hits.length === 1 ? '' : 's'} for “${escapeHtml(query)}”</h2>`
      : '';

  return page(
    { title: query ? `Search — ${query}` : 'Search' },
    `${filterControls(options.filters, options.projects, '/search')}${heading}${body}`
  );
}

export function entryPage(options: {
  entry: EntryRecord;
  timeZone: string;
  newer: string | null;
  older: string | null;
}): string {
  const { entry } = options;
  const pager = `<div class="pager">
    ${options.newer ? `<a href="/entries/${escapeHtml(options.newer)}">← Newer</a>` : '<span></span>'}
    ${options.older ? `<a href="/entries/${escapeHtml(options.older)}">Older →</a>` : '<span></span>'}
  </div>`;

  return page(
    { title: entry.title },
    `<h2>${escapeHtml(entry.title)}</h2>
     <p class="meta">
       <span>${escapeHtml(formatTitle(new Date(entry.createdAt), options.timeZone))}</span>
       <span>${escapeHtml(scopeLabel(entry))}</span>
       ${entry.clientLabel ? `<span>via ${escapeHtml(entry.clientLabel)}</span>` : ''}
     </p>
     <div class="entry-body">${renderMarkdown(entry.body)}</div>
     <form class="inline" method="get" action="/entries/${escapeHtml(entry.id)}/delete">
       <button type="submit" class="danger">Delete entry</button>
     </form>
     ${pager}`
  );
}

export function deleteConfirmPage(options: { entry: EntryRecord; csrf: string }): string {
  const { entry } = options;
  return page(
    { title: `Delete ${entry.title}` },
    `<h2>Delete this entry?</h2>
     <article class="card">
       <h3>${escapeHtml(entry.title)}</h3>
       <p class="meta"><span>${escapeHtml(scopeLabel(entry))}</span><span>${escapeHtml(
         sectionLabels(entry.sections)
       )}</span></p>
     </article>
     <p>This cannot be undone.</p>
     <form method="post" action="/entries/${escapeHtml(entry.id)}/delete">
       ${csrfField(options.csrf)}
       <button type="submit" class="danger">Delete permanently</button>
       <a href="/entries/${escapeHtml(entry.id)}">Cancel</a>
     </form>`
  );
}

export function loginPage(options: { csrf: string; error?: string; next?: string }): string {
  return page(
    { title: 'Sign in', bare: true },
    `<div class="login">
       <h2>Private journal</h2>
       ${options.error ? `<p class="notice">${escapeHtml(options.error)}</p>` : ''}
       <form method="post" action="/login${queryString({ next: options.next })}">
         ${csrfField(options.csrf)}
         <label for="token">Journal token</label>
         <input id="token" name="token" type="password" autocomplete="current-password" required>
         <button type="submit">Sign in</button>
       </form>
     </div>`
  );
}

/**
 * The OAuth consent screen. It is the login form with the authorization request
 * carried through as hidden fields, so "logging in" and "granting access" are
 * the same act: entering the journal token.
 */
export function consentPage(options: {
  csrf: string;
  clientName: string;
  params: Record<string, string>;
  error?: string;
}): string {
  const hidden = Object.entries(options.params)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join('');

  return page(
    { title: 'Authorize access', bare: true },
    `<div class="login">
       <h2>Authorize access</h2>
       <p><strong>${escapeHtml(options.clientName)}</strong> is asking to read and write your journal.</p>
       ${options.error ? `<p class="notice">${escapeHtml(options.error)}</p>` : ''}
       <form method="post" action="/oauth/authorize">
         ${csrfField(options.csrf)}
         ${hidden}
         <label for="token">Journal token</label>
         <input id="token" name="token" type="password" autocomplete="current-password" required>
         <button type="submit">Allow</button>
       </form>
     </div>`
  );
}

export function errorPage(status: number, message: string): string {
  return page({ title: `${status}` }, `<h2>${status}</h2><p class="notice">${escapeHtml(message)}</p>`);
}
