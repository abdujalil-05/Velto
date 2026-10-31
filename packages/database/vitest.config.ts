import { defineConfig } from 'vitest/config';

// Guard runs before any test file (and thus before any PrismaClient) touches Postgres.
export default defineConfig({
  test: { setupFiles: ['../../scripts/assert-test-db.mjs'] },
});
