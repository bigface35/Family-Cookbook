/* =========================================================
   Mise — Service Worker  (cookmise.app)
   Bump CACHE_VERSION with every deploy to push updates to all users.
   ========================================================= */
var CACHE_VERSION = 'v1';
var CACHE_NAME = 'mise-' + CACHE_VERSION;

var SHELL_FILES = [
  '/',
  '/index.html',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json'
];

/* ---- Install: cache shell, activate immediately ---- */
self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(SHELL_FILES);
    }).then(function(){
      return self.skipWaiting();
    })
  );
});

/* ---- Activate: delete old caches, claim open tabs ---- */
self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(key){
          return key.startsWith('mise-') && key !== CACHE_NAME;
        }).map(function(key){ return caches.delete(key); })
      );
    }).then(function(){ return self.clients.claim(); })
  );
});

/* ---- Fetch: network-first for HTML, cache-first for assets ---- */
self.addEventListener('fetch', function(event){
  var url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // Never intercept Firebase, Google, or API requests
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('anthropic.com') ||
      url.hostname.includes('themealdb.com') ||
      url.hostname.includes('thecocktaildb.com') ||
      url.hostname.includes('tiktok.com') ||
      url.hostname.includes('allorigins.win') ||
      url.hostname.includes('corsproxy.io') ||
      url.hostname.includes('nal.usda.gov')) {
    return;
  }

  var isHTML = (event.request.headers.get('Accept') || '').includes('text/html');

  if (isHTML) {
    // Network-first for HTML — always serve the freshest version
    event.respondWith(
      fetch(event.request).then(function(response){
        if (response && response.status === 200){
          caches.open(CACHE_NAME).then(function(cache){
            cache.put(event.request, response.clone());
          });
        }
        return response;
      }).catch(function(){
        return caches.match(event.request);
      })
    );
  } else {
    // Cache-first for icons, manifest, etc.
    event.respondWith(
      caches.match(event.request).then(function(cached){
        var fetchPromise = fetch(event.request).then(function(response){
          if (response && response.status === 200){
            caches.open(CACHE_NAME).then(function(cache){
              cache.put(event.request, response.clone());
            });
          }
          return response;
        }).catch(function(){ return cached; });
        return cached || fetchPromise;
      })
    );
  }
});
