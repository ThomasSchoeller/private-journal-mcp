// ABOUTME: Applies the production D1 migrations to the Miniflare database before each test file
// ABOUTME: Keeps the test schema identical to what `wrangler d1 migrations apply` produces

import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Each test starts from an empty journal; the schema is applied once per file.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM entry_sections'),
    env.DB.prepare('DELETE FROM entries'),
    env.DB.prepare('DELETE FROM oauth_codes'),
    env.DB.prepare('DELETE FROM oauth_refresh_tokens'),
    env.DB.prepare('DELETE FROM oauth_clients'),
  ]);
});
