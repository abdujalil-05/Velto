import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// public/sw-logic.js is plain JS shared with the worker (importScripts) — load it via CJS.
const L = createRequire(import.meta.url)('../../../public/sw-logic.js') as {
  classify: (r: { method: string; url: string; mode?: string; headers?: Record<string, string | null> | Headers }, origin: string, base: string) => string;
  isCacheable: (k: string, r: { status: number; type?: string; redirected?: boolean; contentType?: string }) => boolean;
  navigationKey: (u: string) => string;
  rscKey: (u: string) => string;
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
    expect(L.classify(get('/api/v1/x?_rsc=abc', 'cors', { RSC: '1' }), O, '')).toBe('bypass');
    expect(L.classify(get('/_next/data/x.json?_rsc=1', 'cors', { RSC: '1' }), O, '')).toBe('bypass');
    expect(L.classify({ method: 'GET', url: 'https://api.example.com/uz?_rsc=a', mode: 'cors', headers: { RSC: '1' } }, O, '')).toBe('bypass');
    expect(L.classify({ ...get('/uz/queue?_rsc=a', 'cors', { RSC: '1' }), method: 'POST' }, O, '')).toBe('bypass');
    expect(L.classify({ ...get('/uz/x', 'navigate'), method: 'POST' }, O, '')).toBe('bypass');
    expect(L.classify({ method: 'GET', url: 'https://telegram.org/js/telegram-web-app.js', mode: 'no-cors' }, O, '')).toBe('bypass');
    expect(L.classify(get('/api/x.png'), O, '')).toBe('bypass');
  });

  it('treats RSC navigation and Link prefetch fetches as rsc (any _rsc hash); segment-cache fetches bypass', () => {
    expect(L.classify(get('/uz/queue?_rsc=abc', 'cors', { RSC: '1' }), O, '')).toBe('rsc');
    expect(L.classify(get('/velto/app/uz/order/new?_rsc=z9', 'cors', { RSC: '1', 'Next-Router-State-Tree': '%5B' }), O, '/velto/app')).toBe('rsc');
    expect(L.classify(get('/uz/queue?_rsc=abc', 'cors', { RSC: '1', 'Next-Router-Prefetch': '1' }), O, '')).toBe('rsc');
    expect(L.classify(get('/uz/queue?_rsc=abc', 'cors', { RSC: '1', 'Next-Router-Segment-Prefetch': '/x' }), O, '')).toBe('bypass');
    // real Headers object (as the worker passes it)
    expect(L.classify({ method: 'GET', url: O + '/uz/queue?_rsc=a', mode: 'cors', headers: new Headers({ RSC: '1' }) }, O, '')).toBe('rsc');
  });

  it('rscKey ignores _rsc and query, is per exact path and distinct from the HTML key', () => {
    expect(L.rscKey(O + '/uz/queue?_rsc=a')).toBe(L.rscKey(O + '/uz/queue?_rsc=b'));
    expect(L.rscKey(O + '/uz/queue')).not.toBe(L.rscKey(O + '/uz/route'));
    expect(L.rscKey(O + '/uz/queue')).not.toBe(L.navigationKey(O + '/uz/queue'));
    expect(L.rscKey(O + '/velto/app/uz/queue?_rsc=a')).toBe(O + '/velto/app/uz/queue?velto-rsc=1');
  });

  it('never stores redirected responses (html, rsc, static)', () => {
    expect(L.isCacheable('rsc', { status: 200, type: 'basic', redirected: true, contentType: 'text/x-component' })).toBe(false);
    expect(L.isCacheable('navigate', { status: 200, type: 'basic', redirected: true, contentType: 'text/html' })).toBe(false);
    expect(L.isCacheable('static', { status: 200, type: 'basic', redirected: true })).toBe(false);
  });

  it('only stores 200 flight payloads for rsc', () => {
    expect(L.isCacheable('rsc', { status: 200, type: 'basic', contentType: 'text/x-component' })).toBe(true);
    expect(L.isCacheable('rsc', { status: 200, type: 'basic', contentType: 'text/html' })).toBe(false);
    expect(L.isCacheable('rsc', { status: 200, type: 'basic', contentType: 'application/json' })).toBe(false);
    expect(L.isCacheable('rsc', { status: 307, type: 'basic', contentType: 'text/x-component' })).toBe(false);
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

describe('app shell warm-up (ADR-071)', () => {
  const W = createRequire(import.meta.url)('../../../public/sw-logic.js') as {
    coreRouteUrls: (o: string, b: string, l: string) => string[];
    extractAssetUrls: (html: string, o: string, b: string) => string[];
    CACHE_VERSION: string;
    navigationFallbacks: (u: string, b: string, l: string[]) => string[];
  };
  it('warms home, new order, new payment, queue, route and settings of the locale', () => {
    const urls = W.coreRouteUrls(O, '/velto/app', 'uz');
    expect(urls).toContain(`${O}/velto/app/uz`);
    expect(urls).toEqual(expect.arrayContaining([`${O}/velto/app/uz/report`, `${O}/velto/app/uz/route`, `${O}/velto/app/uz/settings`, `${O}/velto/app/uz/order/new`, `${O}/velto/app/uz/payment/new`, `${O}/velto/app/uz/queue`]));
  });
  it('extracts script/css/chunk URLs from tags and the flight payload, deduplicated, same origin only', () => {
    const html = '<script src="/velto/app/_next/static/chunks/main-abc.js"></script><link href="/velto/app/_next/static/css/x1.css"/>' +
      '<script>self.__next_f.push([1,"static/chunks/app/page-9f.js","static/chunks/main-abc.js"])</script>';
    const out = W.extractAssetUrls(html, O, '/velto/app');
    expect(out).toEqual([`${O}/velto/app/_next/static/chunks/main-abc.js`, `${O}/velto/app/_next/static/css/x1.css`, `${O}/velto/app/_next/static/chunks/app/page-9f.js`]);
  });
  it('bumps the cache version so older shells without the warmed routes are replaced', () => {
    expect(W.CACHE_VERSION).toBe('v3');
  });
  it('warms the param-agnostic /visit shell; id routes never fall back to another page (home HTML)', () => {
    expect(W.coreRouteUrls(O, '', 'ru')).toContain(`${O}/ru/visit`);
    expect(W.navigationFallbacks(`${O}/ru/visit?outletId=o1`, '', ['uz', 'ru', 'en'])).toContain(`${O}/ru/visit`);
    expect(W.navigationFallbacks(`${O}/ru/visit/o1`, '', ['uz', 'ru', 'en'])).toEqual([`${O}/ru/visit/o1`]);
    expect(W.navigationFallbacks(`${O}/ru/delivery/d1`, '', ['uz', 'ru', 'en'])).toEqual([`${O}/ru/delivery/d1`]);
  });
});
