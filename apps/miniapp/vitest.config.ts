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
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
