import { defineConfig, type Plugin } from 'vitest/config';

/**
 * The root package is ESM TypeScript: its relative imports carry the `.js`
 * extension the compiled output will have. Map them back to the sources so the
 * parity test can import `JournalManager` directly.
 */
const resolveTsExtension: Plugin = {
  name: 'resolve-ts-extension',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
    return this.resolve(source.replace(/\.js$/, '.ts'), importer, { ...options, skipSelf: true });
  },
};

export default defineConfig({
  plugins: [resolveTsExtension],
  test: {
    environment: 'node',
    include: ['test-node/**/*.test.ts'],
    // JournalManager renders titles in the process timezone; the Worker renders
    // them in JOURNAL_TZ. Pinning both to one zone is what makes them comparable.
    env: { TZ: 'Europe/Berlin' },
  },
});
