# Spec: Remote Journal on Cloudflare Workers

Status: **Agreed** — all blocking design questions are decided (§14). Ready to implement.
Scope: add a Cloudflare Worker deployment of this MCP server that stores entries in D1 and serves a
small web UI, authenticated with a token.

## 1. Goals

1. Run the private journal as a **remote MCP server** on Cloudflare Workers, speaking the current
   MCP standard (protocol revision `2026-07-28`, Streamable HTTP transport).
2. Persist entries in **D1** instead of the local filesystem, so journals are shared across every
   machine and agent session that has the token.
3. Serve a **minimal web UI** from the same Worker to browse, read, search and delete entries.
4. Authenticate both surfaces with a **token**, with a spec-conformant OAuth layer on top so
   one-click connector flows work.
5. Keep the existing local stdio server working unchanged.

### Non-goals

- Multi-user accounts, roles, sharing, per-entry ACLs.
- Semantic/vector search on the Worker (see §6).
- Migrating existing local journal entries (see §11).
- A rich editor. The UI is a reader with a delete button.

## 2. Background: what exists today

| File | Responsibility |
| --- | --- |
| `src/index.ts` | CLI entry, path resolution, starts the server |
| `src/server.ts` | MCP server over stdio, 5 tools |
| `src/journal.ts` | Writes `YYYY-MM-DD/HH-MM-SS-µµµµµµ.md` with YAML frontmatter |
| `src/embeddings.ts` | `@xenova/transformers` (all-MiniLM-L6-v2, 384 dims), `.embedding` sidecars |
| `src/search.ts` | Loads every `.embedding` into memory, cosine similarity, excerpts |
| `src/paths.ts` | CWD → HOME → temp fallback, `PRIVATE_JOURNAL_PATH` override |

Tools exposed today: `process_thoughts`, `search_journal`, `read_journal_entry`,
`list_recent_entries`, `read_recent_entries`.

Two storage scopes exist, derived from the **filesystem**:

- **project** — `.private-journal/` next to the code. Receives only `project_notes`.
- **user** — `~/.private-journal/`. Receives `reflections`, `observations`, `user_context`,
  `technical_insights`, `world_knowledge`.

Constraints this creates for a Worker port:

- `@xenova/transformers` cannot run on Workers (native ONNX runtime, filesystem model cache).
- There is no CWD on a Worker, so the project/user split can no longer be inferred from the
  environment; it has to be carried in the protocol. See §7.
- `@modelcontextprotocol/sdk@^0.4.0` predates Streamable HTTP. The Worker uses
  `@modelcontextprotocol/server@2.0.0`; the local server keeps its old SDK for now.

## 3. Architecture

```
Claude Code / Desktop ──── Bearer token ────► POST /mcp        ┐
Connector clients ──────── OAuth 2.1 ───────► /oauth/*         │
Browser ────────────────── session cookie ──► /, /entries/:id  ├─ Worker (Hono)
                                              /search          │
                                                               └─► D1
```

One Worker, one D1 database, one `*.workers.dev` hostname. MCP endpoint, OAuth endpoints and UI
share the same secret material and the same storage layer; only the presentation differs. No
Durable Objects, no KV, no Vectorize, no Workers AI — D1 is the only stateful binding.

### Repo layout

```
worker/
  wrangler.jsonc
  package.json            # own deps: hono, @modelcontextprotocol/server, agents
  migrations/
    0001_init.sql
  src/
    index.ts              # Hono app, routing, security headers
    mcp.ts                # MCP server definition + tool handlers
    auth/
      tokens.ts           # static token list, constant-time compare
      oauth.ts            # authorization server (§8.2)
      session.ts          # signed cookie for the UI
    store.ts              # D1 data access — the only place that writes SQL
    search.ts             # FTS5 query building and ranking
    entry.ts              # section names, markdown rendering, excerpts
    ui/                   # server-rendered HTML, inline CSS
  test/                   # vitest + @cloudflare/vitest-pool-workers
```

The root package is untouched: no workspace conversion, no changes to `src/`, `tests/`,
`jest.config.cjs` or the root `package.json`. `worker/src/entry.ts` re-implements the pure
formatting logic from `src/journal.ts` rather than importing Node-flavoured modules; a parity test
(§12) asserts both render byte-identical markdown, so the duplication cannot drift silently.

## 4. Data model (D1)

```sql
CREATE TABLE entries (
  id           TEXT PRIMARY KEY,     -- ULID: lexicographically sortable by creation time
  created_at   INTEGER NOT NULL,     -- unix epoch ms, UTC
  local_date   TEXT    NOT NULL,     -- 'YYYY-MM-DD' in JOURNAL_TZ, for day grouping
  scope        TEXT    NOT NULL,     -- 'project' | 'user'
  project      TEXT,                 -- slug; NULL when scope='user'
  title        TEXT    NOT NULL,     -- '2:30:45 PM - May 31, 2025', as today
  body         TEXT    NOT NULL,     -- rendered markdown, '## Section' blocks, no frontmatter
  client_label TEXT,                 -- which token wrote this
  created_tz   TEXT    NOT NULL      -- IANA tz used to derive local_date
);
CREATE INDEX idx_entries_created ON entries(created_at DESC);
CREATE INDEX idx_entries_scope   ON entries(scope, project, created_at DESC);

CREATE TABLE entry_sections (
  entry_id  TEXT    NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  section   TEXT    NOT NULL,        -- 'reflections' | 'observations' | ...
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
-- kept in sync by AFTER INSERT / UPDATE / DELETE triggers on entries
```

Notes:

- **Sections are stored twice on purpose**: normalised in `entry_sections` (so the existing
  `sections` filter of `search_journal` keeps working as a SQL join) and rendered into
  `entries.body` (what the model reads and the UI displays).
- Frontmatter is not stored; it is regenerated on read so MCP output matches the local server.
- `porter unicode61 remove_diacritics 2` gives English stemming and accent-insensitive matching.
- Row limit (2 MB) and database size (500 MB free / 10 GB paid) are far beyond realistic volume.
- `id` is a ULID, not a path. See §5 for the `read_journal_entry` compatibility story.

Additional tables for OAuth state are defined in §8.2.

## 5. MCP surface

Endpoint: `POST /mcp` — Streamable HTTP, **stateless** (no session id, no SSE endpoint, no Durable
Objects). Built with `createMcpHandler` from `agents/mcp/server` plus `McpServer` from
`@modelcontextprotocol/server@2.0.0`, which implements revision `2026-07-28` (including
`server/discover` and `_meta`-based version negotiation) and stays backward compatible with the
older `initialize`-handshake revisions.

Tool names, descriptions and argument shapes stay **identical** to the local server, so no prompt or
CLAUDE.md guidance has to change:

| Tool | Change on the Worker |
| --- | --- |
| `process_thoughts` | Adds optional `project` argument (§7). Writes 1–2 rows instead of 1–2 files. |
| `search_journal` | Same args (`query`, `limit`, `type`, `sections`). Keyword backend, §6. |
| `read_journal_entry` | `path` accepts an entry id or `journal://entry/<id>`; a filesystem-looking path returns a clear error naming the id form. |
| `list_recent_entries` | Same args. `ORDER BY created_at DESC` with a `days` cutoff. |
| `read_recent_entries` | Same args. |

Result text keeps the current line structure (score, date, sections, path, excerpt) so output stays
familiar; the `Path:` label keeps its name and carries the entry id as its value, which means a
model that pipes a search result straight into `read_journal_entry` keeps working verbatim.

Errors follow MCP tool-error conventions. Auth failures are HTTP-level (§8), never tool errors.

## 6. Search — D1 FTS5 (keyword)

Semantic search is **not** ported. The Worker runs SQLite full-text search only: no Vectorize
index, no Workers AI binding, no embedding step in the write path, no per-query inference cost, and
a test suite that runs fully offline against local Miniflare.

Query handling — the important part, because callers pass natural language:

1. Normalise the query: strip FTS5 operator characters, lowercase, split on whitespace.
2. Drop stopwords and single-character tokens.
3. Build a disjunction — `term1 OR term2 OR …` — so a sentence-shaped query does not degrade into
   an AND that matches nothing. Quoted substrings in the input are preserved as phrase queries.
4. Rank with `bm25(entries_fts)`, apply scope/section/date filters as SQL, and take the top `limit`.
5. Excerpts come from `snippet(entries_fts, …)`, which highlights matched terms — replacing the
   hand-rolled sliding-window excerpt logic in `src/search.ts`.

`bm25()` returns negative values where lower is better. The tool output maps them onto a `0…1`
score (`1 / (1 + exp(bm25))`, monotonic) so the rendered `[Score: 0.812]` line stays meaningful and
comparable within a result set.

Accepted trade-off: conceptual queries such as *"times I felt frustrated with TypeScript"* only
match entries containing those words. §13 keeps a vector backend as a clearly separable later step —
the store and search layers are split so it can be added without touching the tool handlers.

## 7. Project / user scoping

`process_thoughts` gains an optional `project` argument (a slug, e.g. the repo name). Routing:

| Input | Result |
| --- | --- |
| `project` argument present | `project_notes` → `scope='project'`, `project=<slug>` |
| absent, token has a configured `project` | that slug is used |
| absent, token has none | `project_notes` are stored with `scope='user'` |
| all other sections | always `scope='user'`, `project=NULL` |

`search_journal` / `list_recent_entries` / `read_recent_entries` keep their `type` argument
(`project` | `user` | `both`) mapping onto the `scope` column, and additionally accept `project` to
narrow to one project. This keeps single-token setups trivial while still supporting per-repo
separation, and the README documents passing `project` so the model does it consistently.

## 8. Authentication

Two ways in, one identity model. Every request ultimately resolves to a **token label**, which is
recorded on writes (`entries.client_label`) and lets a single client be revoked without disturbing
the others.

### 8.1 Static tokens

Secret `JOURNAL_TOKENS` holds a JSON array:

```json
[{ "label": "laptop", "token": "…", "project": "private-journal-mcp" },
 { "label": "web",    "token": "…" }]
```

A single-token setup may instead set `JOURNAL_TOKEN=<token>` (label defaults to `default`).
Comparison is constant-time: SHA-256 both sides, compare digests with `crypto.subtle.timingSafeEqual`.

`POST /mcp` accepts `Authorization: Bearer <token>` with a static token directly. This is what
Claude Code uses:

```bash
claude mcp add --transport http journal https://<worker>/mcp \
  --header "Authorization: Bearer <token>"
```

Missing or invalid credentials → `401` with
`WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource", scope="journal"`.

### 8.2 OAuth 2.1 layer

MCP's authorization spec is optional for servers, but clients that discover servers by URL (the
one-click "add a connector" flows) expect an OAuth 2.1 resource server. The Worker therefore acts as
**both** resource server and a minimal authorization server, where "logging in" means entering the
same journal token.

Endpoints:

| Route | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource` and `…/mcp` | RFC 9728 metadata: `resource` = canonical `https://<host>/mcp`, `authorization_servers` = `["https://<host>"]`, `scopes_supported` = `["journal"]` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata: `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `authorization_response_iss_parameter_supported: true` |
| `GET /oauth/authorize` | Renders the token prompt (same page as the UI login) |
| `POST /oauth/authorize` | Validates the token, issues an authorization code bound to `client_id`, `redirect_uri`, `resource` and the PKCE `code_challenge`; redirects with `code` and `iss` (RFC 9207) |
| `POST /oauth/token` | `authorization_code` (PKCE `S256` required) and `refresh_token` grants |
| `POST /oauth/register` | Minimal RFC 7591 dynamic client registration, for clients that need it |

Client identification supports both mechanisms the spec allows: an `https://` URL `client_id` is
treated as a Client ID Metadata Document (fetched, cached, `redirect_uris` validated against it),
and `POST /oauth/register` covers older clients that only speak DCR.

Tokens:

- **Access token** — HMAC-signed, self-contained (`sub` = token label, `aud` = canonical resource
  URI, `scope` = `journal`, `exp` = 1 h), signed with `SESSION_SECRET`. Validation is a signature
  and claims check with no database round-trip. The audience check is mandatory: a token whose
  `aud` is not this server's canonical URI is rejected, and tokens are never forwarded anywhere.
- **Refresh token** — opaque, stored hashed in D1, rotated on every use, 30-day idle expiry.

```sql
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL,
  client_name TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL, resource TEXT, token_label TEXT NOT NULL,
  expires_at INTEGER NOT NULL          -- 60 s TTL, single use
);
CREATE TABLE oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, token_label TEXT NOT NULL,
  expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
```

Expired codes and refresh tokens are deleted opportunistically on write, so no cron is needed.

### 8.3 UI session

`GET /login` renders a single password field; the value is checked against the same token list. On
success the Worker sets `__Host-journal=<payload>.<hmac>` — HttpOnly, Secure, SameSite=Lax, signed
with `SESSION_SECRET`, 30-day expiry, carrying the token label so revoking a token invalidates its
sessions. `POST /logout` clears it. No server-side session storage.

### 8.4 Hardening

HSTS; `Content-Security-Policy: default-src 'self'; script-src 'none'` (the UI ships no
JavaScript); CSRF token on the login, OAuth consent and delete forms; `X-Content-Type-Options:
nosniff`; `Referrer-Policy: no-referrer`; `Cache-Control: no-store` on every authenticated
response; per-IP rate limiting on failed logins and token exchanges via the Rate Limiting binding.

## 9. Web UI

Server-rendered HTML, no build step, no client JavaScript, inline CSS with `prefers-color-scheme`
support. Markdown is rendered server-side with raw HTML disabled and the source escaped first, since
entry bodies are model-authored text.

| Route | Content |
| --- | --- |
| `GET /` | Reverse-chronological entries grouped by `local_date`; scope/project filter; search box; cursor pagination on `(created_at, id)` |
| `GET /entries/:id` | Full entry: title, timestamp, scope/project, rendered sections, prev/next links, delete button |
| `POST /entries/:id/delete` | CSRF-protected, confirmation page first; cascades to `entry_sections` and the FTS index |
| `GET /search?q=&type=&sections=` | Same ranking as `search_journal`, with highlighted snippets |
| `GET /login`, `POST /login`, `POST /logout` | Auth (§8.3) |
| `GET /healthz` | Unauthenticated liveness probe, exposes no data |

Entries are not editable through the UI — the journal stays a model-authored record.

## 10. Configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `JOURNAL_TOKENS` / `JOURNAL_TOKEN` | secret | Auth (§8.1) |
| `SESSION_SECRET` | secret | HMAC key for cookies and access tokens |
| `JOURNAL_TZ` | var | IANA tz for `local_date` and display. Default `Europe/Berlin` |
| `DB` | D1 binding | Storage |

`wrangler.jsonc` with a pinned `compatibility_date` and `nodejs_compat`. Deployment is manual:

```bash
cd worker
npx wrangler d1 create private-journal      # once; id goes into wrangler.jsonc
npx wrangler d1 migrations apply private-journal --remote
npx wrangler secret put JOURNAL_TOKENS
npx wrangler secret put SESSION_SECRET
npm run deploy
```

No CI deploy workflow, no custom domain — the Worker is reachable at its `*.workers.dev` hostname.
Both are additive later; a custom domain only needs a `routes` entry plus re-issuing the OAuth
metadata under the new origin.

## 11. Migration

None. The Worker starts empty; existing local `.private-journal` directories stay where they are and
remain readable through the unchanged stdio server. No import endpoint, no parser, no admin routes —
which also means the Worker exposes no bulk-write surface at all.

## 12. Testing

- `vitest` + `@cloudflare/vitest-pool-workers` against local Miniflare D1, applying the production
  migrations.
- Coverage:
  - auth: valid/invalid/missing static token, forged and expired cookies, forged access tokens,
    wrong-audience tokens, PKCE mismatch, code replay, refresh rotation;
  - the full MCP tool surface driven as real HTTP requests against `/mcp`, including
    `server/discover` and a legacy `initialize` handshake;
  - section routing (which sections land in which scope), `project` resolution precedence (§7);
  - FTS5: natural-language query building, stopword handling, ranking order, section/scope filters;
  - UI: rendering, HTML escaping of entry content, delete flow with and without CSRF token.
- A parity test asserting Worker markdown output matches `JournalManager`'s rendering byte for byte.
- The root Jest suite is untouched and keeps running as before.

## 13. Delivery plan

1. Scaffold `worker/`, wrangler config, D1 migration, store layer, tests.
2. MCP endpoint with all five tools + static bearer auth. Usable from Claude Code at this point.
3. FTS5 search: query builder, ranking, snippets, filters.
4. Web UI: login, list, detail, search, delete.
5. OAuth 2.1 layer: metadata documents, authorize/token/register, PKCE, refresh rotation.
6. README and CLAUDE.md documentation, deploy runbook.

Steps 1–4 are the minimum viable deployment; step 5 is independently shippable and only affects
clients that discover the server by URL.

A later, optional step 7 would add semantic search back (Workers AI embeddings + Vectorize, hybrid
rank fusion with the FTS5 results). The store/search split in §3 keeps that behind one module.

## 14. Decisions

| # | Question | Decision |
| --- | --- | --- |
| Q1 | Search backend | **D1 FTS5 only.** No Vectorize, no Workers AI (§6) |
| Q2 | Repo layout | **Self-contained `worker/`**, root package untouched (§3) |
| Q3 | Project scoping | **`project` argument, falling back to the token's default** (§7) |
| Q4 | Auth | **Token plus a minimal OAuth 2.1 shim** (§8.2) |
| Q5 | UI scope | **Read + delete**, no editing (§9) |
| Q6 | Import existing entries | **No.** Green field (§11) |
| Q7 | Deployment | **Manual `wrangler deploy`**, `*.workers.dev`, no CI workflow (§10) |
| Q8 | Conventions | **Current Cloudflare defaults** — wrangler.jsonc, Hono, vitest workers pool |
| Q9 | Local stdio server | **Unchanged**, stays file-based; no `--remote` mode |

Assumptions taken without asking, cheap to change: `JOURNAL_TZ` defaults to `Europe/Berlin`; entry
ids are ULIDs; access tokens live 1 h and refresh tokens 30 days; the UI paginates 50 entries a page.
