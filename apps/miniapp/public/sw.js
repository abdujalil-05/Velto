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
  var ok = L.isCacheable(kind, { status: res.status, type: res.type, contentType: res.headers.get('content-type') });
  if (!ok) return;
  caches.open(L.CACHE_NAME).then(function (c) { return c.put(key, copy); }).catch(function () {});
}

function cacheFirst(request) {
  return caches.match(request).then(function (hit) {
    if (hit) return hit;
    return fetch(request).then(function (res) { put('static', request, request, res); return res; });
  });
}

function networkFirstNavigation(request) {
  var key = L.navigationKey(request.url);
  var timeout = new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, NAV_TIMEOUT_MS); });
  return Promise.race([fetch(request), timeout])
    .then(function (res) { put('navigate', request, key, res); return res; })
    .catch(function () {
      var keys = L.navigationFallbacks(request.url, BASE_PATH, LOCALES);
      return keys.reduce(function (p, k) {
        return p.then(function (hit) { return hit || caches.match(k); });
      }, Promise.resolve(undefined)).then(function (hit) { return hit || Response.error(); });
    });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  var kind = L.classify({ method: req.method, url: req.url, mode: req.mode, headers: { RSC: req.headers.get('RSC') } }, self.location.origin, BASE_PATH);
  if (kind === 'static') event.respondWith(cacheFirst(req));
  else if (kind === 'navigate') event.respondWith(networkFirstNavigation(req));
});
