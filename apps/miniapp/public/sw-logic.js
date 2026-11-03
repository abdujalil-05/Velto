/*
 * Pure routing/caching decisions for the hand-written service worker (sw.js).
 * Plain JS (no build step, no dependencies) so the same file is loaded by the
 * worker via importScripts AND required by vitest (sw-logic.test.ts).
 *
 * Scope: ONLY the app shell (HTML navigations), static assets and the
 * full-tree RSC payloads of the core routes pre-warmed by WARM_SHELL (so
 * client-side navigation works offline without a document reload, ADR-071).
 * API calls, auth endpoints, /_next/data, live (partial) RSC responses and any
 * authenticated JSON are never cached — business data lives solely in the
 * encrypted Dexie store.
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
  var CACHE_VERSION = 'v3';
  var CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
  var NO_CACHE_PREFIXES = ['/api', '/auth', '/_next/data'];
  var ASSET_EXT = /\.(?:png|svg|ico|webp|jpg|jpeg|woff2?|css|js)$/i;

  function stripBase(pathname, basePath) {
    if (basePath && pathname.indexOf(basePath) === 0) return pathname.slice(basePath.length) || '/';
    return pathname;
  }

  function hdr(req, name) {
    var h = req.headers;
    if (!h) return null;
    if (typeof h.get === 'function') return h.get(name);
    return h[name] !== undefined ? h[name] : (h[name.toLowerCase()] !== undefined ? h[name.toLowerCase()] : null);
  }

  /** @returns {'static'|'navigate'|'rsc'|'bypass'} 'rsc' = a App Router navigation/prefetch fetch (network first, offline falls back to the warmed full-tree payload of the SAME path). */
  function classify(req, origin, basePath) {
    if (req.method !== 'GET') return 'bypass';
    var u = new URL(req.url);
    if (u.origin !== origin) return 'bypass';
    var path = stripBase(u.pathname, basePath || '');
    for (var i = 0; i < NO_CACHE_PREFIXES.length; i++) {
      var p = NO_CACHE_PREFIXES[i];
      if (path === p || path.indexOf(p + '/') === 0) return 'bypass';
    }
    if (u.searchParams.has('_rsc') || hdr(req, 'RSC')) {
      // Segment-cache fetches address individual segments: never answered from the full-tree cache. Link prefetches ARE served (offline they
      // would otherwise fail and make Next fall back to a document load, dropping the in-memory UK).
      if (hdr(req, 'Next-Router-Segment-Prefetch')) return 'bypass';
      if (path.indexOf('/_next/') === 0) return 'bypass';
      return 'rsc';
    }
    if (path.indexOf('/_next/static/') === 0 || path.indexOf('/icons/') === 0 || path === '/favicon.ico') return 'static';
    if (req.mode === 'navigate') return 'navigate';
    if (ASSET_EXT.test(path) && path.indexOf('/_next/') !== 0) return 'static';
    return 'bypass';
  }

  /** Only successful, same-origin, non-opaque responses; navigations must be HTML (never authenticated JSON). */
  function isCacheable(kind, res) {
    if (!res || res.status !== 200 || res.type === 'opaque' || res.type === 'error') return false;
    if (res.redirected) return false; // a redirect (e.g. to a login page) must never be stored under another path's key
    if (kind === 'navigate') return /text\/html/i.test(res.contentType || '');
    if (kind === 'rsc') return !res.redirected && /text\/x-component/i.test(res.contentType || '');
    return kind === 'static';
  }

  /** Cache key for a navigation: no query/hash so `/uz?x=1` and `/uz` share one entry. */
  function navigationKey(url) {
    var u = new URL(url);
    return u.origin + u.pathname;
  }

  /** Cache key for the full-tree RSC payload of a path: ignores `_rsc` hash and every query; distinct from the HTML key. Per exact path, never shared between routes. */
  function rscKey(url) {
    var u = new URL(url);
    return u.origin + u.pathname + '?velto-rsc=1';
  }

  /** Ordered cache keys tried when a navigation fails offline: exact page, locale home, app root. */
  function navigationFallbacks(url, basePath, locales) {
    var u = new URL(url);
    var rel = stripBase(u.pathname, basePath || '');
    var seg = rel.split('/')[1];
    var out = [u.origin + u.pathname];
    // Dynamic id routes: never answer with another page's HTML (home would hydrate as a wrong screen).
    if (/^\/[a-z]{2}\/(?:delivery|visit)\/[^/]+/.test(rel)) return out;
    if (seg && (locales || []).indexOf(seg) !== -1) out.push(u.origin + (basePath || '') + '/' + seg);
    out.push(u.origin + (basePath || '') + '/');
    return out.filter(function (k, i) { return out.indexOf(k) === i; });
  }

  function staleCacheNames(names, current) {
    return names.filter(function (n) { return n.indexOf(CACHE_PREFIX) === 0 && n !== current; });
  }

  /** Core offline routes pre-warmed on Offline Unlock enroll (ADR-071): home, new order, visit entry, new payment, queue, route, settings, report. /visit is a param-agnostic shell (outlet id read from ?outletId= at runtime). /delivery/[id] is dynamic and courier-only (online): not warmed, never answered with another id's HTML. */
  var CORE_ROUTES = ['', '/order/new', '/payment/new', '/queue', '/route', '/settings', '/report', '/visit'];
  function coreRouteUrls(origin, basePath, locale) {
    return CORE_ROUTES.map(function (r) { return origin + (basePath || '') + '/' + locale + r; });
  }

  /** Same-origin Next static asset URLs referenced by a page's HTML (script/link tags and chunk paths inside the flight payload). */
  function extractAssetUrls(html, origin, basePath) {
    var out = [];
    var seen = {};
    var re = /(?:\/_next\/)?static\/(?:chunks|css|media)\/[A-Za-z0-9_\-./~%\[\]()@]+?\.(?:js|css|woff2?)/g;
    var m;
    while ((m = re.exec(html || '')) !== null) {
      var rel = m[0].indexOf('/_next/') === 0 ? m[0] : '/_next/' + m[0];
      var url = origin + (basePath || '') + rel;
      if (!seen[url]) { seen[url] = true; out.push(url); }
    }
    return out;
  }

  return {
    coreRouteUrls: coreRouteUrls, extractAssetUrls: extractAssetUrls, CORE_ROUTES: CORE_ROUTES,
    CACHE_PREFIX: CACHE_PREFIX, CACHE_VERSION: CACHE_VERSION, CACHE_NAME: CACHE_NAME,
    classify: classify, isCacheable: isCacheable, navigationKey: navigationKey, rscKey: rscKey,
    navigationFallbacks: navigationFallbacks, staleCacheNames: staleCacheNames,
  };
});
