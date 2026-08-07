import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Unit tests run offline (no MySQL/Redis). The real-MySQL relay integration
    // suite under test/integration/** requires a live MySQL 8 and is EXCLUDED
    // from the default run — it has its own config (vitest.integration.config.ts)
    // and is invoked via `npm run test:integration` (see test/integration/README.md).
    exclude: [...configDefaults.exclude, 'test/integration/**'],
    globals: false,
  },
})
