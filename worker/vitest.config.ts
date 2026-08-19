import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const CLIENT_REDIRECT_URI = 'https://client.example.com/callback';

/**
 * Stand-in for the host serving Client ID Metadata Documents, so the OAuth
 * tests exercise the real fetch path while staying entirely offline.
 */
const CLIENT_METADATA: Record<string, unknown> = {
  '/journal-client.json': {
    client_id: 'https://apps.example.com/journal-client.json',
    client_name: 'Metadata client',
    redirect_uris: [CLIENT_REDIRECT_URI],
  },
  '/mismatched.json': {
    client_id: 'https://apps.example.com/something-else.json',
    redirect_uris: [CLIENT_REDIRECT_URI],
  },
};

const TEST_TOKENS = [
  { label: 'laptop', token: 'laptop-secret', project: 'private-journal-mcp' },
  { label: 'web', token: 'web-secret' },
];

const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          SESSION_SECRET: 'test-session-secret',
          JOURNAL_TOKENS: JSON.stringify(TEST_TOKENS),
          JOURNAL_TZ: 'Europe/Berlin',
        },
        outboundService(request) {
          const url = new URL(request.url);
          const document =
            url.origin === 'https://apps.example.com' ? CLIENT_METADATA[url.pathname] : undefined;
          if (!document) return new Response('No outbound network in tests', { status: 403 });
          return Response.json(document);
        },
      },
    }),
  ],
  test: {
    // `test-node/` runs in Node against the root package; see vitest.node.config.ts.
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
