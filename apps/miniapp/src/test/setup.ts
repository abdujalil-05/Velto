import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

// jsdom's `window.crypto` implements getRandomValues but not `.subtle`
// (Web Crypto's SubtleCrypto isn't part of jsdom) — crypto.ts (10.2's
// AES-GCM local-DB encryption) needs `.subtle`, so swap in Node's real
// implementation, which has both.
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
});

// Node's own experimental `globalThis.localStorage` accessor shadows
// jsdom's real Storage implementation in vitest's jsdom environment (its
// global-copy allowlist predates Node shipping a built-in `localStorage`,
// so it defers to whatever's already on `global` under that name) —
// point the global at jsdom's actual instance instead.
const jsdomWindow = (globalThis as unknown as { jsdom?: { window: Window } }).jsdom?.window;
if (jsdomWindow?.localStorage) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: jsdomWindow.localStorage,
    configurable: true,
  });
}
