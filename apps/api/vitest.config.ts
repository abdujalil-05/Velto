import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS's official Vitest recipe (https://docs.nestjs.com/recipes/swc#vitest):
// esbuild (Vitest's default transform) doesn't emit the design:paramtypes
// decorator metadata Nest's DI container needs to resolve constructor
// parameters by type. Every *other* test in this app sidesteps that by
// `new`-ing services directly instead of going through Nest's container —
// only test/order-flow.e2e.test.ts (Test.createTestingModule) actually
// needs it.
export default defineConfig({
  test: {
    root: './',
    // DB-heavy integration suites (real Postgres + RLS, lock-order/race tests)
    // contend for the same DB when all files run in parallel; the 5s default
    // flakes under full-suite load while the tests pass alone.
    testTimeout: 30_000,
    // e2e files boot the whole Nest AppModule (Redis/BullMQ, argon2, ~60s total
    // collect time) in beforeAll; under CPU starvation that exceeds 30s.
    hookTimeout: 90_000,
    // Cap parallel files: 8 forks each booting AppModule + Postgres + Redis
    // oversubscribe an 8-core box (load avg >> cores) and cause timeouts.
    pool: 'forks',
    poolOptions: { forks: { maxForks: Number(process.env.VITEST_MAX_FORKS ?? 4), minForks: 1 } },
  },
  plugins: [swc.vite()],
});
