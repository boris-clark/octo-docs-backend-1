import { defineConfig } from 'vitest/config'

/**
 * Real-MySQL PPT relay integration suite config (XIN-1740).
 *
 * Runs ONLY the suites under test/integration/**, which drive the production
 * `DbPptRelayStore` against a live MySQL 8 (see test/integration/README.md).
 * Invoked via `npm run test:integration`, which also sets `PPT_MYSQL_IT=1`; the
 * suites additionally self-skip when that flag is absent, so this config is safe
 * to run even without a database (it simply reports skipped tests).
 *
 * Sequential (single fork, no file/test parallelism) so the concurrent-race
 * tests own the database deterministically and `beforeEach` truncation is not
 * interleaved across files.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    globals: false,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
