/* Velto Mini App service worker — hand-written, zero dependencies. See sw-logic.js for scope and the ADR-010 caveat. */
importScripts('sw-logic.js');

var L = self.VeltoSwLogic;
var LOCALES = ['uz', 'ru', 'en'];
var NAV_TIMEOUT_MS = 4000;
var BASE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, '');

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(L.staleCacheNames(names, L.CACHE_NAME).map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); }),
  );
});

function put(kind, request, key, res) {
  var copy = res.clone();
  var ok = L.isCacheable(kind, { status: res.status, type: res.type, redirected: res.redirected, contentType: res.headers.get('content-type') });
  if (!ok) return;
  caches.open(L.CACHE_NAME).then(function (c) { return c.put(key, copy); }).catch(function () {});
}

function cacheFirst(request) {
  return caches.match(request).then(function (hit) {
    if (hit) return hit;
    return fetch(request).then(function (res) { put('static', request, request, res); return res; });
  });
}

/* fetch with a hard deadline: the request is aborted and the timer cleared on every outcome. */
function fetchWithDeadline(request) {
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, NAV_TIMEOUT_MS);
  return fetch(request, { signal: ctl.signal }).then(
    function (res) { clearTimeout(timer); return res; },
    function (e) { clearTimeout(timer); throw e; },
  );
}

function networkFirstNavigation(request) {
  var key = L.navigationKey(request.url);
  return fetchWithDeadline(request)
    .then(function (res) { put('navigate', request, key, res); return res; })
    .catch(function () {
      var keys = L.navigationFallbacks(request.url, BASE_PATH, LOCALES);
      return keys.reduce(function (p, k) {
        return p.then(function (hit) { return hit || caches.match(k); });
      }, Promise.resolve(undefined)).then(function (hit) { return hit || Response.error(); });
    });
}

/* Client-side navigation (RSC fetch): network first; the live (partial) response is never cached. Offline/slow -> the full-tree payload of the exact same path warmed earlier (Next applies a root render), else a network error (Next then does a hard navigation, served by the HTML cache). */
function networkFirstRsc(request) {
  return fetchWithDeadline(request).catch(function () {
    return caches.match(L.rscKey(request.url), { ignoreVary: true }).then(function (hit) { return hit || Response.error(); });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  var kind = L.classify({ method: req.method, url: req.url, mode: req.mode, headers: req.headers }, self.location.origin, BASE_PATH);
  if (kind === 'static') event.respondWith(cacheFirst(req));
  else if (kind === 'navigate') event.respondWith(networkFirstNavigation(req));
  else if (kind === 'rsc') event.respondWith(networkFirstRsc(req));
});

/* ADR-071: the page asks (after Offline Unlock enroll / authenticated start) to pre-warm the core routes and the chunks they reference,
   so a cold start while offline finds the unlock screen, home, order, payment and queue in the cache. Best effort, never blocks. */
function warm(locale) {
  var urls = L.coreRouteUrls(self.location.origin, BASE_PATH, locale);
  return Promise.all(urls.map(warmRsc).concat(urls.map(function (u) {
    return fetch(u, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) return;
      var copy = res.clone();
      var isHtml = L.isCacheable('navigate', { status: res.status, type: res.type, redirected: res.redirected, contentType: res.headers.get('content-type') });
      return res.text().then(function (html) {
        var p = isHtml ? caches.open(L.CACHE_NAME).then(function (c) { return c.put(L.navigationKey(u), copy); }) : Promise.resolve();
        var assets = L.extractAssetUrls(html, self.location.origin, BASE_PATH);
        return p.then(function () {
          return Promise.all(assets.map(function (a) {
            return caches.match(a).then(function (hit) {
              if (hit) return;
              return fetch(a).then(function (r) {
                if (L.isCacheable('static', { status: r.status, type: r.type, redirected: r.redirected, contentType: '' })) return caches.open(L.CACHE_NAME).then(function (c) { return c.put(a, r); });
              });
            });
          }));
        });
      });
    }).catch(function () {});
  })));
}

/* Full-tree RSC payload (RSC header, no Next-Router-State-Tree => the server renders from the root). Contains no user data, same as the HTML. */
function warmRsc(u) {
  return fetch(u, { credentials: 'same-origin', headers: { RSC: '1' } }).then(function (res) {
    if (!L.isCacheable('rsc', { status: res.status, type: res.type, redirected: res.redirected, contentType: res.headers.get('content-type') })) return;
    var copy = res.clone();
    return res.text().then(function (txt) {
      return caches.open(L.CACHE_NAME).then(function (c) { return c.put(L.rscKey(u), copy); }).then(function () {
        return Promise.all(L.extractAssetUrls(txt, self.location.origin, BASE_PATH).map(function (a) {
          return caches.match(a).then(function (hit) {
            if (hit) return;
            return fetch(a).then(function (r) {
              if (L.isCacheable('static', { status: r.status, type: r.type, redirected: r.redirected, contentType: '' })) return caches.open(L.CACHE_NAME).then(function (c) { return c.put(a, r); });
            });
          });
        }));
      });
    });
  }).catch(function () {});
}

self.addEventListener('message', function (event) {
  var d = event.data;
  if (d && d.type === 'WARM_SHELL' && LOCALES.indexOf(d.locale) !== -1) event.waitUntil(warm(d.locale));
});
