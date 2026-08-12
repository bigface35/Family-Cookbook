/* =========================================================
   Mise — Service Worker
   Bump CACHE_VERSION with every deploy to push updates to all users.
   ========================================================= */
var CACHE_VERSION = 'v5';
var CACHE_NAME = 'mise-' + CACHE_VERSION;

var SHELL_FILES = [
  '/Family-Cookbook/',
  '/Family-Cookbook/index.html',
  '/Family-Cookbook/icon-192.png',
  '/Family-Cookbook/icon-512.png',
  '/Family-Cookbook/manifest.json'
];

/* ---- Install: cache shell files, then activate immediately ---- */
self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(SHELL_FILES);
    }).then(function(){
      // Don't wait for existing tabs to close — take over right away.
      return self.skipWaiting();
    })
  );
});

/* ---- Activate: delete old caches, then claim all open tabs ---- */
self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(key){
          return key.startsWith('mise-') && key !== CACHE_NAME;
        }).map(function(key){
          return caches.delete(key);
        })
      );
    }).then(function(){
      // Take control of every open tab immediately.
      // The page listens for this and reloads to serve fresh content.
      return self.clients.claim();
    })
  );
});

/* ---- Fetch: network-first for HTML (always fresh), cache-first for assets ---- */
self.addEventListener('fetch', function(event){
  var url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;

  // Never intercept Firebase / Google requests
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('anthropic.com') ||
      url.hostname.includes('themealdb.com') ||
      url.hostname.includes('thecocktaildb.com') ||
      url.hostname.includes('allorigins.win') ||
      url.hostname.includes('corsproxy.io')) {
    return;
  }

  var isHTML = event.request.headers.get('Accept') &&
               event.request.headers.get('Accept').includes('text/html');

  if (isHTML){
    // Network-first for HTML: users always get the freshest index.html.
    event.respondWith(
      fetch(event.request).then(function(networkResponse){
        if (networkResponse && networkResponse.status === 200){
          caches.open(CACHE_NAME).then(function(cache){
            cache.put(event.request, networkResponse.clone());
          });
        }
        return networkResponse;
      }).catch(function(){
        return caches.match(event.request);
      })
    );
  } else {
    // Cache-first for images, icons, manifest etc.
    event.respondWith(
      caches.match(event.request).then(function(cached){
        var fetchPromise = fetch(event.request).then(function(networkResponse){
          if (networkResponse && networkResponse.status === 200){
            caches.open(CACHE_NAME).then(function(cache){
              cache.put(event.request, networkResponse.clone());
            });
          }
          return networkResponse;
        }).catch(function(){ return cached; });
        return cached || fetchPromise;
      })
    );
  }
});
