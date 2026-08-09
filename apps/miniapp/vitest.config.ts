import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // jsdom disables the Storage API on an opaque origin (its default
    // `about:blank`) — crypto.ts's device key lives in localStorage, so it
    // needs a real-looking origin to be usable at all.
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    setupFiles: ['./src/test/setup.ts'],
  },
  // tsconfig.json sets `jsx: "preserve"` (Next.js compiles JSX itself), which
  // makes esbuild fall back to the classic `React.createElement` runtime and
  // throw "React is not defined" in any component test — the app's own source
  // never imports React because Next.js uses the automatic runtime. Match that
  // here so component files render under vitest unchanged.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
