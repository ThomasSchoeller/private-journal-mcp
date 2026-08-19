# Private Journal MCP Server

A comprehensive MCP (Model Context Protocol) server that provides Claude with private journaling and semantic search capabilities for processing thoughts, reflections, and insights.

## Features

### Journaling
- **Multi-section journaling**: Separate categories for reflections, observations, project notes, user context, technical insights, and world knowledge
- **Dual storage**: Project notes stay with projects, personal thoughts in user home directory
- **Timestamped entries**: Each entry automatically dated with microsecond precision
- **YAML frontmatter**: Structured metadata for each entry

### Search & Discovery
- **Semantic search**: Natural language queries using local AI embeddings
- **Vector similarity**: Find conceptually related entries, not just keyword matches
- **Local AI processing**: Uses @xenova/transformers - no external API calls required
- **Automatic indexing**: Embeddings generated for all entries on startup and ongoing

### Privacy & Performance
- **Completely private**: All processing happens locally, no data leaves your machine
- **Fast operation**: Optimized file structure and in-memory similarity calculations
- **Robust fallbacks**: Intelligent path resolution across platforms

## Installation

This server is run directly from GitHub using `npx` - no installation required.

## MCP Configuration

#### Claude Code (One-liner)
```bash
claude mcp add-json private-journal '{"type":"stdio","command":"npx","args":["github:obra/private-journal-mcp"]}' -s user
```

#### Manual Configuration
Add to your MCP settings (e.g., Claude Desktop configuration):

```json
{
  "mcpServers": {
    "private-journal": {
      "command": "npx",
      "args": ["github:obra/private-journal-mcp"]
    }
  }
}
```

The server will automatically find a suitable location for the journal files.

### Configuration

#### `PRIVATE_JOURNAL_PATH` environment variable

Set `PRIVATE_JOURNAL_PATH` to override all journal storage to a single directory. This is useful for containerized deployments where the default home directory resolution doesn't apply:

```json
{
  "mcpServers": {
    "private-journal": {
      "command": "npx",
      "args": ["github:obra/private-journal-mcp"],
      "env": {
        "PRIVATE_JOURNAL_PATH": "/data/journals"
      }
    }
  }
}
```

When set, both project and user journals are written to the specified path, bypassing all fallback resolution logic.

#### `--journal-path` CLI argument

You can also set the project journal path via CLI argument:

```bash
npx github:obra/private-journal-mcp --journal-path /path/to/journals
```

This only overrides the project journal path. The user journal path still resolves via `PRIVATE_JOURNAL_PATH` or the default home directory logic.

## MCP Tools

The server provides comprehensive journaling and search capabilities:

### `process_thoughts`
Multi-section private journaling with these optional categories:
- **reflections**: Integrated thinking — what you noticed, felt, understood, or processed
- **observations**: Short, discrete noticings — one or two sentences each
- **project_notes**: Technical insights specific to current project  
- **user_context**: Notes about collaborating with humans
- **technical_insights**: General software engineering learnings
- **world_knowledge**: Domain knowledge and interesting discoveries

### `search_journal`
Semantic search across all journal entries:
- **query** (required): Natural language search query
- **limit**: Maximum results (default: 10)
- **type**: Search scope - 'project', 'user', or 'both' (default: 'both')
- **sections**: Filter by specific categories

### `read_journal_entry`
Read full content of specific entries:
- **path** (required): File path from search results

### `list_recent_entries`
Browse recent entries chronologically:
- **limit**: Maximum entries (default: 10)
- **type**: Entry scope - 'project', 'user', or 'both' (default: 'both')
- **days**: Days back to search (default: 30)

## File Structure

### Project Journal (per project)
```
.private-journal/
├── 2025-05-31/
│   ├── 14-30-45-123456.md          # Project notes entry
│   ├── 14-30-45-123456.embedding   # Search index
│   └── ...
```

### User Journal (global)
```
~/.private-journal/
├── 2025-05-31/
│   ├── 14-32-15-789012.md          # Personal thoughts entry
│   ├── 14-32-15-789012.embedding   # Search index
│   └── ...
```

### Entry Format
Each markdown file contains YAML frontmatter and structured sections:

```markdown
---
title: "2:30:45 PM - May 31, 2025"
date: 2025-05-31T14:30:45.123Z
timestamp: 1717160645123
---

## Reflections

I'm excited about this new search feature...

## Technical Insights

Vector embeddings provide semantic understanding...
```

## Remote deployment (Cloudflare Workers)

The server can also run as a **remote MCP server** on Cloudflare Workers, storing entries in D1 so
one journal is shared across every machine and agent session that holds a token. The same Worker
serves a small web UI for browsing, searching and deleting entries.

```bash
cd worker && npm install
npx wrangler d1 create private-journal        # paste the id into wrangler.jsonc
npx wrangler d1 migrations apply private-journal --remote
npx wrangler secret put JOURNAL_TOKENS
npx wrangler secret put SESSION_SECRET
npm run deploy
```

```bash
claude mcp add --transport http journal https://<worker>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

The tools are identical to the local ones, with two differences that follow from there being no
filesystem: `read_journal_entry` takes the entry id from a search or list result rather than a path,
and search is keyword-based (SQLite FTS5) rather than semantic. `process_thoughts` gains an optional
`project` argument, since a Worker has no working directory to infer the project scope from.

This is additive: the local stdio server is unchanged and keeps using the filesystem. See
[`worker/README.md`](worker/README.md) for the full runbook and
[`docs/cloudflare-worker-spec.md`](docs/cloudflare-worker-spec.md) for the design.

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm test
```

### Development Mode

```bash
npm run dev
```

### Improving Claude's Performance

To help Claude learn and improve over time, consider adding journal usage guidance to your `~/.claude/CLAUDE.md` file:

```markdown
## Learning and Memory Management

- YOU MUST use the journal tool frequently to capture technical insights, failed approaches, and user preferences
- Before starting complex tasks, search the journal for relevant past experiences and lessons learned
- Document architectural decisions and their outcomes for future reference
- Track patterns in user feedback to improve collaboration over time
- When you notice something that should be fixed but is unrelated to your current task, document it in your journal rather than fixing it immediately
```

This enables Claude to build persistent memory across conversations, leading to better engineering decisions and collaboration patterns.

## Author

Jesse Vincent <jesse@fsck.com>

Read more about the motivation and design in the [blog post](https://blog.fsck.com/2025/05/28/dear-diary-the-user-asked-me-if-im-alive/).

## License

MIT