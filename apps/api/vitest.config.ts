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
  },
  plugins: [swc.vite()],
});
