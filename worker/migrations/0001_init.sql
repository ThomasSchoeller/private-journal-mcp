-- Migration number: 0001 	 2026-08-18T00:00:00.000Z
-- Initial schema: journal entries, their sections, and the FTS5 index.

CREATE TABLE entries (
  id           TEXT PRIMARY KEY,     -- ULID: lexicographically sortable by creation time
  created_at   INTEGER NOT NULL,     -- unix epoch ms, UTC
  local_date   TEXT    NOT NULL,     -- 'YYYY-MM-DD' in JOURNAL_TZ, for day grouping
  scope        TEXT    NOT NULL,     -- 'project' | 'user'
  project      TEXT,                 -- slug; NULL when scope='user'
  title        TEXT    NOT NULL,     -- '2:30:45 PM - May 31, 2025'
  body         TEXT    NOT NULL,     -- rendered markdown, '## Section' blocks, no frontmatter
  client_label TEXT,                 -- which token wrote this
  created_tz   TEXT    NOT NULL      -- IANA tz used to derive local_date
);
CREATE INDEX idx_entries_created ON entries(created_at DESC);
CREATE INDEX idx_entries_scope   ON entries(scope, project, created_at DESC);

CREATE TABLE entry_sections (
  entry_id  TEXT    NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  section   TEXT    NOT NULL,
  position  INTEGER NOT NULL,
  content   TEXT    NOT NULL,
  PRIMARY KEY (entry_id, section)
);
CREATE INDEX idx_sections_section ON entry_sections(section);

CREATE VIRTUAL TABLE entries_fts USING fts5(
  body,
  content='entries',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;

CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO entries_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TABLE oauth_clients (
  client_id     TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,       -- JSON array
  client_name   TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource       TEXT,
  token_label    TEXT NOT NULL,
  expires_at     INTEGER NOT NULL    -- 60 s TTL, single use
);

CREATE TABLE oauth_refresh_tokens (
  token_hash  TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  token_label TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);
