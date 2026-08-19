// ABOUTME: D1 data access for journal entries — the only module that writes SQL
// ABOUTME: Keeps the tool handlers and the UI free of storage details

import {
  isSectionKey,
  orderedSections,
  plainExcerpt,
  renderBody,
  type SectionKey,
  type Thoughts,
} from './entry.js';
import { HIGHLIGHT_END, HIGHLIGHT_START } from './search.js';

export type Scope = 'project' | 'user';
export type ScopeFilter = Scope | 'both';

export interface EntryRecord {
  id: string;
  createdAt: number;
  localDate: string;
  scope: Scope;
  project: string | null;
  title: string;
  body: string;
  clientLabel: string | null;
  createdTz: string;
  sections: SectionKey[];
}

export interface EntrySummary {
  id: string;
  createdAt: number;
  localDate: string;
  scope: Scope;
  project: string | null;
  title: string;
  sections: SectionKey[];
  excerpt: string;
}

export interface SearchHit extends EntrySummary {
  score: number;
  /** Raw FTS5 snippet, still carrying the highlight delimiters. */
  snippet: string;
}

export interface Cursor {
  createdAt: number;
  id: string;
}

interface EntryRow {
  id: string;
  created_at: number;
  local_date: string;
  scope: string;
  project: string | null;
  title: string;
  body: string;
  client_label: string | null;
  created_tz: string;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID: 48-bit timestamp plus 80 bits of randomness, Crockford base32. Ids sort
 * lexicographically by creation time, which keeps `(created_at, id)` cursors
 * total-ordered even for entries written in the same millisecond.
 */
export function newUlid(now: number = Date.now()): string {
  let time = '';
  let remaining = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = '';
  for (let i = 0; i < 16; i++) {
    random += CROCKFORD[bytes[i] % 32];
  }
  return time + random;
}

/** `true` for strings shaped like an id this store hands out. */
export function looksLikeEntryId(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

function toScope(value: string): Scope {
  return value === 'project' ? 'project' : 'user';
}

function scopeConditions(
  scope: ScopeFilter | undefined,
  project: string | undefined,
  column: string,
  bindings: unknown[]
): string[] {
  const conditions: string[] = [];
  if (scope === 'project' || scope === 'user') {
    conditions.push(`${column}.scope = ?`);
    bindings.push(scope);
  }
  if (project !== undefined) {
    conditions.push(`${column}.project = ?`);
    bindings.push(project);
  }
  return conditions;
}

async function sectionsByEntry(
  db: D1Database,
  ids: string[]
): Promise<Map<string, SectionKey[]>> {
  const byEntry = new Map<string, SectionKey[]>();
  if (ids.length === 0) return byEntry;

  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT entry_id, section FROM entry_sections
        WHERE entry_id IN (${placeholders})
        ORDER BY entry_id, position`
    )
    .bind(...ids)
    .all<{ entry_id: string; section: string }>();

  for (const row of results ?? []) {
    if (!isSectionKey(row.section)) continue;
    const existing = byEntry.get(row.entry_id);
    if (existing) existing.push(row.section);
    else byEntry.set(row.entry_id, [row.section]);
  }
  return byEntry;
}

export interface InsertEntryInput {
  createdAt: number;
  localDate: string;
  scope: Scope;
  project: string | null;
  title: string;
  thoughts: Thoughts;
  clientLabel: string | null;
  createdTz: string;
}

/** Writes one entry plus its sections. Returns the new entry id. */
export async function insertEntry(db: D1Database, input: InsertEntryInput): Promise<string> {
  const id = newUlid(input.createdAt);
  const body = renderBody(input.thoughts);
  const sections = orderedSections(input.thoughts);

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO entries
           (id, created_at, local_date, scope, project, title, body, client_label, created_tz)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.createdAt,
        input.localDate,
        input.scope,
        input.project,
        input.title,
        body,
        input.clientLabel,
        input.createdTz
      ),
  ];

  const sectionStatement = db.prepare(
    `INSERT INTO entry_sections (entry_id, section, position, content) VALUES (?, ?, ?, ?)`
  );
  for (const section of sections) {
    statements.push(
      sectionStatement.bind(id, section.section, section.position, section.content)
    );
  }

  await db.batch(statements);
  return id;
}

export async function getEntry(db: D1Database, id: string): Promise<EntryRecord | null> {
  const row = await db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first<EntryRow>();
  if (!row) return null;
  const sections = await sectionsByEntry(db, [row.id]);
  return {
    id: row.id,
    createdAt: row.created_at,
    localDate: row.local_date,
    scope: toScope(row.scope),
    project: row.project,
    title: row.title,
    body: row.body,
    clientLabel: row.client_label,
    createdTz: row.created_tz,
    sections: sections.get(row.id) ?? [],
  };
}

/** The entry immediately before / after `id` in reverse-chronological order. */
export async function adjacentEntries(
  db: D1Database,
  entry: Pick<EntryRecord, 'id' | 'createdAt'>
): Promise<{ newer: string | null; older: string | null }> {
  const newer = await db
    .prepare(
      `SELECT id FROM entries
        WHERE created_at > ? OR (created_at = ? AND id > ?)
        ORDER BY created_at ASC, id ASC LIMIT 1`
    )
    .bind(entry.createdAt, entry.createdAt, entry.id)
    .first<{ id: string }>();
  const older = await db
    .prepare(
      `SELECT id FROM entries
        WHERE created_at < ? OR (created_at = ? AND id < ?)
        ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .bind(entry.createdAt, entry.createdAt, entry.id)
    .first<{ id: string }>();
  return { newer: newer?.id ?? null, older: older?.id ?? null };
}

export interface ListOptions {
  scope?: ScopeFilter;
  project?: string;
  /** Only entries at or after this epoch-ms instant. */
  since?: number;
  limit: number;
  /** Continue strictly older than this position. */
  cursor?: Cursor;
}

export interface ListResult {
  entries: EntrySummary[];
  nextCursor: Cursor | null;
}

export async function listEntries(db: D1Database, options: ListOptions): Promise<ListResult> {
  const bindings: unknown[] = [];
  const conditions = scopeConditions(options.scope, options.project, 'entries', bindings);

  if (options.since !== undefined) {
    conditions.push('created_at >= ?');
    bindings.push(options.since);
  }
  if (options.cursor) {
    conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
    bindings.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { results } = await db
    .prepare(
      `SELECT * FROM entries ${where} ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .bind(...bindings, options.limit + 1)
    .all<EntryRow>();

  const rows = results ?? [];
  const page = rows.slice(0, options.limit);
  const sections = await sectionsByEntry(
    db,
    page.map((row) => row.id)
  );

  return {
    entries: page.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      localDate: row.local_date,
      scope: toScope(row.scope),
      project: row.project,
      title: row.title,
      sections: sections.get(row.id) ?? [],
      excerpt: plainExcerpt(row.body),
    })),
    nextCursor:
      rows.length > options.limit && page.length > 0
        ? { createdAt: page[page.length - 1].created_at, id: page[page.length - 1].id }
        : null,
  };
}

/** Same as {@link listEntries} but keeps the full body, for `read_recent_entries`. */
export async function readEntries(
  db: D1Database,
  options: Omit<ListOptions, 'cursor'>
): Promise<EntryRecord[]> {
  const bindings: unknown[] = [];
  const conditions = scopeConditions(options.scope, options.project, 'entries', bindings);
  if (options.since !== undefined) {
    conditions.push('created_at >= ?');
    bindings.push(options.since);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { results } = await db
    .prepare(`SELECT * FROM entries ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...bindings, options.limit)
    .all<EntryRow>();

  const rows = results ?? [];
  const sections = await sectionsByEntry(
    db,
    rows.map((row) => row.id)
  );
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    localDate: row.local_date,
    scope: toScope(row.scope),
    project: row.project,
    title: row.title,
    body: row.body,
    clientLabel: row.client_label,
    createdTz: row.created_tz,
    sections: sections.get(row.id) ?? [],
  }));
}

export interface SearchOptions {
  /** An FTS5 MATCH expression, as produced by `buildMatchQuery`. */
  match: string;
  scope?: ScopeFilter;
  project?: string;
  sections?: SectionKey[];
  since?: number;
  limit: number;
}

interface SearchRow extends EntryRow {
  rank: number;
  snippet: string;
}

export async function searchEntries(
  db: D1Database,
  options: SearchOptions
): Promise<SearchHit[]> {
  const bindings: unknown[] = [HIGHLIGHT_START, HIGHLIGHT_END, options.match];
  const conditions = scopeConditions(options.scope, options.project, 'e', bindings);

  if (options.since !== undefined) {
    conditions.push('e.created_at >= ?');
    bindings.push(options.since);
  }
  if (options.sections && options.sections.length > 0) {
    const placeholders = options.sections.map(() => '?').join(', ');
    conditions.push(
      `EXISTS (SELECT 1 FROM entry_sections s
                WHERE s.entry_id = e.id AND s.section IN (${placeholders}))`
    );
    bindings.push(...options.sections);
  }

  const extra = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '';
  const { results } = await db
    .prepare(
      `SELECT e.*, bm25(entries_fts) AS rank,
              snippet(entries_fts, 0, ?, ?, '…', 24) AS snippet
         FROM entries_fts
         JOIN entries e ON e.rowid = entries_fts.rowid
        WHERE entries_fts MATCH ?${extra}
        ORDER BY rank ASC
        LIMIT ?`
    )
    .bind(...bindings, options.limit)
    .all<SearchRow>();

  const rows = results ?? [];
  const sections = await sectionsByEntry(
    db,
    rows.map((row) => row.id)
  );

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    localDate: row.local_date,
    scope: toScope(row.scope),
    project: row.project,
    title: row.title,
    sections: sections.get(row.id) ?? [],
    excerpt: plainExcerpt(row.body),
    snippet: row.snippet,
    score: row.rank,
  }));
}

/** Removes an entry, its sections and its FTS row. Returns whether it existed. */
export async function deleteEntry(db: D1Database, id: string): Promise<boolean> {
  const [, entryResult] = await db.batch([
    db.prepare(`DELETE FROM entry_sections WHERE entry_id = ?`).bind(id),
    db.prepare(`DELETE FROM entries WHERE id = ?`).bind(id),
  ]);
  return (entryResult.meta?.changes ?? 0) > 0;
}

/** Distinct project slugs seen so far, for the UI's filter control. */
export async function listProjects(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT project FROM entries WHERE project IS NOT NULL ORDER BY project ASC`
    )
    .all<{ project: string }>();
  return (results ?? []).map((row) => row.project);
}
