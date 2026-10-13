import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// public/sw-logic.js is plain JS shared with the worker (importScripts) — load it via CJS.
const L = createRequire(import.meta.url)('../../../public/sw-logic.js') as {
  classify: (r: { method: string; url: string; mode?: string; headers?: Record<string, string | null> }, origin: string, base: string) => string;
  isCacheable: (k: string, r: { status: number; type?: string; contentType?: string }) => boolean;
  navigationKey: (u: string) => string;
  navigationFallbacks: (u: string, base: string, locales: string[]) => string[];
  staleCacheNames: (names: string[], current: string) => string[];
  CACHE_NAME: string;
  CACHE_PREFIX: string;
};
const O = 'https://app.test';
const get = (path: string, mode = 'cors', headers: Record<string, string | null> = {}) => ({ method: 'GET', url: O + path, mode, headers });

describe('service worker cache logic', () => {
  it('caches static assets cache-first and navigations network-first', () => {
    expect(L.classify(get('/velto/app/_next/static/chunks/a.js'), O, '/velto/app')).toBe('static');
    expect(L.classify(get('/icons/i.png'), O, '')).toBe('static');
    expect(L.classify(get('/uz/route', 'navigate'), O, '')).toBe('navigate');
  });

  it('never touches api, auth, next data, RSC, mutations or cross-origin requests', () => {
    expect(L.classify(get('/api/v1/sync/pull'), O, '')).toBe('bypass');
    expect(L.classify(get('/velto/app/auth/refresh'), O, '/velto/app')).toBe('bypass');
    expect(L.classify(get('/_next/data/x/uz.json'), O, '')).toBe('bypass');
    expect(L.classify(get('/uz?_rsc=abc', 'navigate'), O, '')).toBe('bypass');
    expect(L.classify(get('/uz', 'cors', { RSC: '1' }), O, '')).toBe('bypass');
    expect(L.classify({ ...get('/uz/x', 'navigate'), method: 'POST' }, O, '')).toBe('bypass');
    expect(L.classify({ method: 'GET', url: 'https://telegram.org/js/telegram-web-app.js', mode: 'no-cors' }, O, '')).toBe('bypass');
    expect(L.classify(get('/api/x.png'), O, '')).toBe('bypass');
  });

  it('only stores 200 HTML navigations and static 200s, never JSON/opaque/errors', () => {
    expect(L.isCacheable('navigate', { status: 200, type: 'basic', contentType: 'text/html; charset=utf-8' })).toBe(true);
    expect(L.isCacheable('navigate', { status: 200, type: 'basic', contentType: 'application/json' })).toBe(false);
    expect(L.isCacheable('static', { status: 200, type: 'basic' })).toBe(true);
    expect(L.isCacheable('static', { status: 200, type: 'opaque' })).toBe(false);
    expect(L.isCacheable('static', { status: 500, type: 'basic' })).toBe(false);
  });

  it('offline navigation falls back page -> locale home -> app root, query ignored', () => {
    expect(L.navigationKey(O + '/uz/route?x=1#h')).toBe(O + '/uz/route');
    expect(L.navigationFallbacks(O + '/velto/app/uz/route?x=1', '/velto/app', ['uz', 'ru', 'en'])).toEqual([
      O + '/velto/app/uz/route',
      O + '/velto/app/uz',
      O + '/velto/app/',
    ]);
  });

  it('removes only older velto-shell caches', () => {
    expect(L.staleCacheNames([L.CACHE_PREFIX + 'v0', L.CACHE_NAME, 'other'], L.CACHE_NAME)).toEqual([L.CACHE_PREFIX + 'v0']);
  });
});
