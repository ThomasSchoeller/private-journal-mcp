# Spec: Remote Journal on Cloudflare Workers

Status: **Draft for review** — sections marked **[OPEN]** need a decision before implementation starts.
Scope: add a Cloudflare Worker deployment of this MCP server that stores entries in a Cloudflare
database and serves a small web UI, authenticated with a static token.

## 1. Goals

1. Run the private journal as a **remote MCP server** on Cloudflare Workers, speaking the current
   MCP standard (protocol revision `2026-07-28`, Streamable HTTP transport).
2. Persist entries in a **Cloudflare database** (D1) instead of the local filesystem, so journals are
   shared across every machine/agent session that has the token.
3. Serve a **minimal web UI** from the same Worker to browse, read and search entries.
4. Authenticate both surfaces with a **static bearer token** — no OAuth provider, no user accounts.
5. Keep the existing local stdio server working unchanged.

### Non-goals

- Multi-user accounts, roles, sharing, or per-entry ACLs.
- Real-time collaboration / websockets.
- Replacing the local file-based mode.
- Rich editor UI. The UI is primarily a reader.

## 2. Background: what exists today

| File | Responsibility |
| --- | --- |
| `src/index.ts` | CLI entry, path resolution, starts the server |
| `src/server.ts` | MCP server over stdio, 5 tools |
| `src/journal.ts` | Writes `YYYY-MM-DD/HH-MM-SS-µµµµµµ.md` with YAML frontmatter |
| `src/embeddings.ts` | `@xenova/transformers` (all-MiniLM-L6-v2, 384 dims), `.embedding` sidecar files |
| `src/search.ts` | Loads every `.embedding` into memory, cosine similarity, excerpts |
| `src/paths.ts` | CWD → HOME → temp fallback, `PRIVATE_JOURNAL_PATH` override |

Tools exposed today: `process_thoughts`, `search_journal`, `read_journal_entry`,
`list_recent_entries`, `read_recent_entries`.

Two storage scopes exist and are derived from the **filesystem**:

- **project** — `.private-journal/` next to the code. Receives only `project_notes`.
- **user** — `~/.private-journal/`. Receives `reflections`, `observations`, `user_context`,
  `technical_insights`, `world_knowledge`.

Constraints this creates for a Worker port:

- `@xenova/transformers` cannot run on Workers (native ONNX runtime, filesystem cache). Semantic
  search must be re-implemented with Workers AI + Vectorize, or dropped.
- There is no CWD on a Worker, so the project/user split can no longer be inferred from the
  environment. It has to be carried in the protocol. See §7.
- The current SDK dependency (`@modelcontextprotocol/sdk@^0.4.0`) predates Streamable HTTP. The
  Worker will use `@modelcontextprotocol/server@2.0.0` — the local server can be migrated later.

## 3. High-level architecture

```
                    Authorization: Bearer <token>
Claude Code / Desktop ──────────────► POST /mcp   ┐
                                                  │
Browser ──── cookie (HMAC session) ──► GET  /     ├── Cloudflare Worker (Hono)
                                        /entries/:id                │
                                        /search                     │
                                                                    ├─► D1  (entries, sections, FTS5)
                                                                    ├─► Vectorize (optional, §6)
                                                                    └─► Workers AI (optional, §6)
```

One Worker, one D1 database, one domain. The MCP endpoint and the UI share the same auth secret and
the same storage layer; only the presentation differs.

### Proposed repo layout

```
worker/
  wrangler.jsonc
  package.json            # own deps: hono, @modelcontextprotocol/server, agents
  migrations/0001_init.sql
  src/
    index.ts              # Hono app, routing, auth middleware
    mcp.ts                # MCP server definition + tool handlers
    store.ts              # D1 data access (the only place that writes SQL)
    search.ts             # FTS5 + optional vector search, rank fusion
    entry.ts              # section names, markdown rendering, excerpt (mirrors src/journal.ts)
    ui/                   # server-rendered HTML, inline CSS
  test/                   # vitest + @cloudflare/vitest-pool-workers
scripts/
  import-local-journal.ts # one-off migration of existing .private-journal dirs
```

The root package (local stdio server) stays as it is. `worker/entry.ts` re-implements the ~60 lines
of pure formatting logic rather than importing Node-flavoured modules; a parity test asserts the
Worker renders byte-identical markdown to `JournalManager.formatThoughts`. **[OPEN — Q2]** the
alternative is converting the repo to npm workspaces with a shared, dependency-free `core` package.

## 4. Data model (D1)

```sql
CREATE TABLE entries (
  id           TEXT PRIMARY KEY,     -- ULID: sortable by creation time
  created_at   INTEGER NOT NULL,     -- unix epoch ms, UTC
  local_date   TEXT    NOT NULL,     -- 'YYYY-MM-DD' in JOURNAL_TZ, for day grouping
  scope        TEXT    NOT NULL,     -- 'project' | 'user'
  project      TEXT,                 -- slug; NULL when scope='user'
  title        TEXT    NOT NULL,     -- '2:30:45 PM - May 31, 2025', as today
  body         TEXT    NOT NULL,     -- rendered markdown, '## Section' blocks, no frontmatter
  client_label TEXT,                 -- which token wrote this
  created_tz   TEXT    NOT NULL      -- IANA tz used to derive local_date
);
CREATE INDEX idx_entries_created  ON entries(created_at DESC);
CREATE INDEX idx_entries_scope    ON entries(scope, project, created_at DESC);

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
  content='entries', content_rowid='rowid'
);  -- kept in sync by AFTER INSERT/UPDATE/DELETE triggers
```

Notes:

- **Sections are stored both ways**: normalised in `entry_sections` (for section filters, which the
  current `search_journal` supports) and rendered into `entries.body` (what gets returned to the
  model and displayed). Rendering stays the single source of truth for display.
- Frontmatter is *not* stored; it is regenerated on read so the MCP output matches the local server.
- 2 MB row limit and 500 MB DB (free) / 10 GB (paid) are far beyond realistic journal volume.
- `id` is a ULID, not a path. See §7 for the `read_journal_entry` compatibility story.

## 5. MCP surface

Endpoint: `POST /mcp` (Streamable HTTP, stateless — no Durable Objects, no SSE endpoint).
Built with `createMcpHandler` from `agents/mcp/server` + `McpServer` from
`@modelcontextprotocol/server@2.0.0`, which covers protocol revision `2026-07-28` (including
`server/discover` and `_meta`-based version negotiation) and remains backward compatible with the
older `initialize` handshake revisions.

Tool names, descriptions and argument shapes stay **identical** to the local server, so no prompt or
CLAUDE.md guidance has to change:

| Tool | Change on the Worker |
| --- | --- |
| `process_thoughts` | Adds optional `project` argument (§7). Writes 1–2 rows instead of 1–2 files. |
| `search_journal` | Same args (`query`, `limit`, `type`, `sections`). Backend per §6. |
| `read_journal_entry` | `path` now accepts an entry id or `journal://entry/<id>`; legacy filesystem paths are rejected with a clear error. |
| `list_recent_entries` | Same args. SQL `ORDER BY created_at DESC`. |
| `read_recent_entries` | Same args. |

Output text formatting is preserved verbatim (score, date, sections, path, excerpt lines), except
that `Path:` becomes `Id:`. **[OPEN]** if strict text compatibility matters more than clarity, keep
the `Path:` label with the id as its value.

Errors follow MCP tool-error conventions; auth failures are HTTP-level (§8), not tool errors.

## 6. Search **[OPEN — Q1, the biggest decision]**

The local implementation is semantic-only (MiniLM embeddings, in-memory cosine). On Workers there
are three viable shapes:

**A. Keyword only — D1 FTS5.**
`entries_fts MATCH ?` with `bm25()` ranking and `snippet()` for excerpts. Zero extra bindings, zero
extra cost, sub-10 ms, deterministic and testable. Loses conceptual matching: a query like
*"times I felt frustrated with TypeScript"* only hits entries containing those literal words.

**B. Semantic only — Workers AI + Vectorize.**
Embed on write with `@cf/baai/bge-m3` (multilingual, matters if entries are ever German) or
`@cf/baai/bge-base-en-v1.5` (768 dims, English). Store vectors in a Vectorize index with
`{scope, project, created_at, sections}` metadata for filtering; D1 stays the content store.
Vectorize has a free tier (5 M stored / 30 M queried dimensions per month); Workers AI inference is
billed in neurons with a small daily free allowance. Closest to today's behaviour, adds two bindings
and a write-path dependency (embedding failure must not lose the entry — write to D1 first, embed in
`ctx.waitUntil`, reconcile missing vectors on a cron).

**C. Hybrid (recommended).**
Run A and B in parallel, fuse with reciprocal rank fusion. Semantic recall plus exact-term
precision, and the server degrades to A automatically when the Vectorize/AI bindings are absent —
which also keeps local `wrangler dev` and CI fast and offline.

Recommendation: **C**, implemented as A first, with the vector path behind a binding check so it can
land in a second pass.

Section filters (`sections: ['reflections']`) apply as a SQL join in A and as metadata filters in B.
`type: 'project' | 'user' | 'both'` maps to the `scope` column in both.

## 7. Project / user scoping **[OPEN — Q3]**

The split has to come from somewhere now that there is no CWD. Options:

1. **Explicit argument.** `process_thoughts` and the read tools take an optional `project` string.
   Claude passes the repo name. Simple, transparent, but relies on the model to pass it consistently
   — mitigated by documenting it in CLAUDE.md.
2. **Per-token default.** Each token is configured with a project slug; `project_notes` written with
   that token always land in that project. Zero model burden, but needs a token per project.
3. **Flat.** Drop the project/user distinction; everything is one stream, `type` is ignored (or
   becomes a stored label only).

Recommendation: **1 with 2 as a fallback default** — an explicit `project` argument wins, otherwise
the token's configured default, otherwise `scope='user'`. This keeps single-token setups trivial and
still supports per-repo separation.

## 8. Authentication

**Token store.** Secret `JOURNAL_TOKENS` holds a JSON array, so multiple clients can be issued
distinct tokens and revoked individually without touching the others:

```json
[{ "label": "laptop", "token": "…", "project": "private-journal-mcp" },
 { "label": "web",    "token": "…" }]
```

A single-token setup can instead set `JOURNAL_TOKEN=<token>`. Comparison is constant-time
(`crypto.subtle.timingSafeEqual` over SHA-256 digests) to avoid leaking the token via timing.

**MCP.** `Authorization: Bearer <token>` on every request. Missing/invalid → `401` with
`WWW-Authenticate: Bearer`. Note that MCP's authorization spec is *optional* for servers but,
when implemented over HTTP, it expects OAuth 2.1 with RFC 9728 resource metadata. A static bearer
token deviates from that: it works with any client that can set a header (Claude Code
`claude mcp add --transport http … --header "Authorization: Bearer …"`, `mcp-remote`, curl), but the
one-click "add a connector" flows that rely on OAuth discovery will not complete. **[OPEN — Q4]**

**UI.** `GET /login` renders a single password field; the submitted value is checked against the
same token list. On success the Worker sets `__Host-journal=<payload>.<hmac>` — HttpOnly, Secure,
SameSite=Lax, signed with `SESSION_SECRET`, 30-day expiry, carrying the token label so a revoked
token invalidates its sessions. `POST /logout` clears it. No session storage needed.

**Hardening.** HSTS; `Content-Security-Policy: default-src 'self'; script-src 'none'` (the UI needs
no JavaScript); CSRF token on the login and any mutating form; `X-Content-Type-Options: nosniff`;
`Cache-Control: no-store` on every authenticated response; rate limit failed logins per IP via the
Rate Limiting binding.

## 9. Web UI

Server-rendered HTML, no build step, no client JavaScript, inline CSS with
`prefers-color-scheme` support. Markdown is rendered server-side with raw HTML disabled and the
source escaped first, since entry bodies are model-authored text.

| Route | Content |
| --- | --- |
| `GET /` | Reverse-chronological entries grouped by `local_date`; scope/project filter; search box; cursor pagination on `(created_at, id)` |
| `GET /entries/:id` | Full entry: title, timestamp, scope/project, rendered sections, prev/next links |
| `GET /search?q=&type=&sections=` | Same ranking as `search_journal`, with highlighted excerpts |
| `GET /login`, `POST /login`, `POST /logout` | Auth |
| `GET /healthz` | Unauthenticated liveness probe, no data |

**[OPEN — Q5]** whether the UI is read-only or also allows deleting/editing entries.

## 10. Configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `JOURNAL_TOKENS` / `JOURNAL_TOKEN` | secret | Auth (§8) |
| `SESSION_SECRET` | secret | Cookie HMAC key |
| `JOURNAL_TZ` | var | IANA tz for `local_date` and display. Default `Europe/Berlin` |
| `DB` | D1 binding | Storage |
| `VECTORIZE` | Vectorize binding | Optional; enables semantic search |
| `AI` | Workers AI binding | Optional; embedding generation |

`wrangler.jsonc` with `compatibility_date` pinned to the current date and `nodejs_compat` enabled.

## 11. Migration of existing entries

`scripts/import-local-journal.ts` walks a local `.private-journal` directory, parses frontmatter and
`## Section` headings, and POSTs batches to an authenticated `POST /admin/import` endpoint that is
idempotent on a content hash, so re-running it is safe. Embeddings in `.embedding` sidecars are
*not* imported — dimensions and model differ; vectors are regenerated server-side. **[OPEN — Q6]**

## 12. Testing

- `vitest` + `@cloudflare/vitest-pool-workers` runs the Worker against local Miniflare D1, applying
  the same migrations as production.
- Coverage: auth (valid/invalid/missing token, cookie forgery), the full MCP tool surface over real
  HTTP requests to `/mcp`, scope routing of sections, FTS5 ranking, UI rendering and escaping.
- A parity test asserting Worker markdown output matches the local `JournalManager` rendering.
- Existing Jest suite for the root package is untouched.

## 13. Delivery plan

1. Scaffold `worker/`, wrangler config, D1 migration, store layer, tests. — no behaviour yet
2. MCP endpoint with all five tools + bearer auth. Usable from Claude Code at this point.
3. Web UI: login, list, detail, keyword search.
4. Semantic search: Workers AI embeddings, Vectorize index, hybrid fusion, backfill cron.
5. Import script, README/CLAUDE.md documentation, deploy notes.

Steps 1–3 are the minimum viable deployment; 4 and 5 are independently shippable.

## 14. Open questions

| # | Question | Proposed default |
| --- | --- | --- |
| Q1 | Search backend: FTS5, Vectorize, or hybrid? (§6) | Hybrid, FTS5 first |
| Q2 | Repo layout: self-contained `worker/` or npm workspaces with shared core? (§3) | Self-contained `worker/` |
| Q3 | Project scoping: explicit argument, per-token, or flat? (§7) | Argument + per-token default |
| Q4 | Static token only, or also an OAuth shim for one-click connectors? (§8) | Static token only |
| Q5 | UI read-only, or with delete/edit? (§9) | Read-only + delete |
| Q6 | Import existing local journal entries? (§11) | Yes, one-off script |
| Q7 | Conventions from the existing `tools` repo (wrangler style, CI deploy, naming, custom domain) | Unknown — needs input |
| Q8 | Does the local stdio server stay file-based, or gain a `--remote` mode pointing at the Worker? | Stays file-based |
