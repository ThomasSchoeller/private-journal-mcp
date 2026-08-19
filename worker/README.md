# Remote journal on Cloudflare Workers

A deployment of the private journal MCP server that stores entries in **D1** instead of the local
filesystem, so one journal is shared across every machine and agent session that holds a token. The
same Worker serves a small read-and-delete web UI.

The local stdio server in `../src` is untouched and keeps working exactly as before; this directory
is self-contained, with its own `package.json` and dependencies.

Design and rationale: [`../docs/cloudflare-worker-spec.md`](../docs/cloudflare-worker-spec.md).

## What it serves

| Surface | Route | Auth |
| --- | --- | --- |
| MCP (Streamable HTTP, stateless) | `POST /mcp` | `Authorization: Bearer <journal token>`, or an OAuth access token |
| OAuth 2.1 metadata + endpoints | `/.well-known/oauth-*`, `/oauth/*` | public / PKCE |
| Web UI | `/`, `/entries/:id`, `/search` | signed session cookie |
| Liveness | `/healthz` | none |

The five tools are byte-identical in name, description and arguments to the local server —
`process_thoughts`, `search_journal`, `read_journal_entry`, `list_recent_entries`,
`read_recent_entries` — so no prompt or `CLAUDE.md` guidance has to change. Two differences follow
from there being no filesystem:

- `read_journal_entry` takes the entry id from the `Path:` line of a search or list result (or
  `journal://entry/<id>`). A filesystem-looking path gets an error that names the id form.
- Search is **keyword** search (SQLite FTS5 with Porter stemming), not the local semantic search.
  Natural-language queries are lowercased, stripped of stopwords and turned into an `OR`
  disjunction, ranked with `bm25()` and excerpted with `snippet()`.

## Deploying

Requires a Cloudflare account and `npx wrangler login`.

```bash
cd worker
npm install

# 1. Create the database, then paste the printed id into wrangler.jsonc.
npx wrangler d1 create private-journal

# 2. Create the schema.
npx wrangler d1 migrations apply private-journal --remote

# 3. Secrets. Both are read from stdin; nothing is stored in wrangler.jsonc.
#    A JSON array of clients:
#      [{"label":"laptop","token":"…","project":"private-journal-mcp"},
#       {"label":"web","token":"…"}]
#    or set JOURNAL_TOKEN instead for a single-token setup.
npx wrangler secret put JOURNAL_TOKENS
npx wrangler secret put SESSION_SECRET      # long random string, see below

# 4. Ship it.
npm run deploy
```

Generate secrets with `openssl rand -base64 32`. Both are checked at request time: a journal token
shorter than 24 characters is **ignored** (with a warning in `wrangler tail`, since a weak token is
the whole credential), and a `SESSION_SECRET` shorter than that makes the Worker answer `503` rather
than sign anything with it.

Deployment is manual and the Worker lives at its `*.workers.dev` hostname. A custom domain only
needs a `routes` entry in `wrangler.jsonc`; the OAuth metadata is derived from the request origin,
so it follows the new hostname on its own. Serving the same Worker under several hostnames is the
case for setting `PUBLIC_ORIGIN`, which pins the issuer and the token audience to one of them.

## Connecting a client

Claude Code, with a static token:

```bash
claude mcp add --transport http journal https://<worker>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

Clients that discover a server by URL use the OAuth layer instead: they read
`/.well-known/oauth-protected-resource`, register (or present an `https://` client-id metadata
document), and send the user to `/oauth/authorize`. Consent requires an existing browser session —
an anonymous visitor is sent to `/login` first — so the journal token is only ever typed into a page
the user navigated to themselves, never into one a client linked them to. The consent screen names
the host the authorization code would be sent to. Access tokens are HMAC-signed, last an hour and
are bound to this server's canonical resource URI; refresh tokens are opaque, stored hashed, and
rotated on every use, and replaying a rotated one revokes the whole chain.

The web UI uses the same tokens: open the Worker in a browser and enter one at `/login`.

## Configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `JOURNAL_TOKENS` | secret | JSON array of `{ label, token, project? }` |
| `JOURNAL_TOKEN` | secret | single-token shorthand; label defaults to `default` |
| `SESSION_SECRET` | secret | HMAC root key; session cookies, CSRF tokens and access tokens each sign under their own derived subkey |
| `PUBLIC_ORIGIN` | var (optional) | canonical `https://host`; pins the OAuth issuer and audience instead of deriving them from the request |
| `JOURNAL_TZ` | var | IANA zone for `local_date` and rendered titles (default `Europe/Berlin`) |
| `DB` | D1 binding | storage |
| `LOGIN_LIMITER` | rate limit binding | per-IP budget for *failed* credential attempts — the login form, bearer tokens on `/mcp`, token exchanges, and client registration once many clients exist |

`entries.client_label` records which token wrote an entry, so a single client can be revoked by
removing it from `JOURNAL_TOKENS` without disturbing the others — that also invalidates any web
sessions and access tokens issued to it.

Without the `LOGIN_LIMITER` binding nothing is throttled; the Worker logs a warning once and keeps
serving, so a deployment that drops the binding stays usable but louder. Changing `SESSION_SECRET`
invalidates every session cookie and access token at once, which is the fastest way to sign
everything out.

### Project scoping

There is no working directory on a Worker, so the project/user split travels in the protocol:

| Input | Where `project_notes` land |
| --- | --- |
| `process_thoughts` called with `project` | `scope='project'`, `project=<slug>` |
| no argument, token has a `project` | that slug |
| neither | `scope='user'` |

Every other section is always user-scoped. `search_journal`, `list_recent_entries` and
`read_recent_entries` keep their `type` argument (`project` | `user` | `both`) and additionally
accept `project` to narrow to one slug.

## Development

```bash
npm run dev              # local Worker against a local D1
npm run migrate:local    # apply migrations to the local database
npm test                 # Worker tests (Miniflare) + the Node parity test
npm run typecheck
```

`npm test` runs two suites: `test/` under `@cloudflare/vitest-pool-workers` against a local
Miniflare D1 with the production migrations applied, and `test-node/` in Node, which drives the real
`JournalManager` from the root package and asserts the Worker renders entry markdown byte for byte
the same way. Everything runs offline — there is no embedding model and no network call in the test
path.

## What this deployment does not do

- No semantic search (see above). The store and search layers are split so a vector backend could be
  added behind one module later.
- No migration of existing local journals: the Worker starts empty, and existing `.private-journal`
  directories stay readable through the stdio server. There is no bulk-write surface at all.
- No editing through the UI — the journal stays a model-authored record. Entries can be read and
  deleted.
- No multi-user accounts, roles or per-entry sharing. Labels are not a boundary: every configured
  token can read, search and delete **every** entry, including ones written under another label or
  another project slug. `project` is a filing default, not an access control.
