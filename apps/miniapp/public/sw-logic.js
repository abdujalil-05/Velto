/*
 * Pure routing/caching decisions for the hand-written service worker (sw.js).
 * Plain JS (no build step, no dependencies) so the same file is loaded by the
 * worker via importScripts AND required by vitest (sw-logic.test.ts).
 *
 * Scope: ONLY the app shell (HTML navigations) and static assets. API calls,
 * auth endpoints, RSC/data fetches and any authenticated JSON are never
 * cached — business data lives solely in the encrypted Dexie store.
 *
 * Caveat (ADR-010 / TZ 8.1): Telegram's iOS WebView may restrict or evict
 * service workers and IndexedDB. This is a best-effort cold-start aid, NOT a
 * promise of full offline operation; the first launch always needs internet.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VeltoSwLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var CACHE_PREFIX = 'velto-shell-';
  var CACHE_VERSION = 'v1';
  var CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
  var NO_CACHE_PREFIXES = ['/api', '/auth', '/_next/data'];
  var ASSET_EXT = /\.(?:png|svg|ico|webp|jpg|jpeg|woff2?|css|js)$/i;

  function stripBase(pathname, basePath) {
    if (basePath && pathname.indexOf(basePath) === 0) return pathname.slice(basePath.length) || '/';
    return pathname;
  }

  /** @returns {'static'|'navigate'|'bypass'} */
  function classify(req, origin, basePath) {
    if (req.method !== 'GET') return 'bypass';
    var u = new URL(req.url);
    if (u.origin !== origin) return 'bypass';
    var path = stripBase(u.pathname, basePath || '');
    for (var i = 0; i < NO_CACHE_PREFIXES.length; i++) {
      var p = NO_CACHE_PREFIXES[i];
      if (path === p || path.indexOf(p + '/') === 0) return 'bypass';
    }
    if (u.searchParams.has('_rsc') || (req.headers && req.headers.RSC)) return 'bypass';
    if (path.indexOf('/_next/static/') === 0 || path.indexOf('/icons/') === 0 || path === '/favicon.ico') return 'static';
    if (req.mode === 'navigate') return 'navigate';
    if (ASSET_EXT.test(path) && path.indexOf('/_next/') !== 0) return 'static';
    return 'bypass';
  }

  /** Only successful, same-origin, non-opaque responses; navigations must be HTML (never authenticated JSON). */
  function isCacheable(kind, res) {
    if (!res || res.status !== 200 || res.type === 'opaque' || res.type === 'error') return false;
    if (kind === 'navigate') return /text\/html/i.test(res.contentType || '');
    return kind === 'static';
  }

  /** Cache key for a navigation: no query/hash so `/uz?x=1` and `/uz` share one entry. */
  function navigationKey(url) {
    var u = new URL(url);
    return u.origin + u.pathname;
  }

  /** Ordered cache keys tried when a navigation fails offline: exact page, locale home, app root. */
  function navigationFallbacks(url, basePath, locales) {
    var u = new URL(url);
    var rel = stripBase(u.pathname, basePath || '');
    var seg = rel.split('/')[1];
    var out = [u.origin + u.pathname];
    if (seg && (locales || []).indexOf(seg) !== -1) out.push(u.origin + (basePath || '') + '/' + seg);
    out.push(u.origin + (basePath || '') + '/');
    return out.filter(function (k, i) { return out.indexOf(k) === i; });
  }

  function staleCacheNames(names, current) {
    return names.filter(function (n) { return n.indexOf(CACHE_PREFIX) === 0 && n !== current; });
  }

  return {
    CACHE_PREFIX: CACHE_PREFIX, CACHE_VERSION: CACHE_VERSION, CACHE_NAME: CACHE_NAME,
    classify: classify, isCacheable: isCacheable, navigationKey: navigationKey,
    navigationFallbacks: navigationFallbacks, staleCacheNames: staleCacheNames,
  };
});
