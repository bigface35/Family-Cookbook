/* =========================================================
   Minear Family Recipes — Service Worker
   Cache-first for the app shell; network-first for Firebase.
   Update CACHE_VERSION when deploying changes to bust the cache.
   ========================================================= */
var CACHE_VERSION = 'v1';
var CACHE_NAME = 'minear-recipes-' + CACHE_VERSION;

/* Files to cache for offline app-shell use */
var SHELL_FILES = [
  '/',
  '/index.html'
];

/* ---- Install: pre-cache the app shell ---- */
self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(SHELL_FILES);
    }).then(function(){
      return self.skipWaiting();
    })
  );
});

/* ---- Activate: remove old caches ---- */
self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(key){
          return key.startsWith('minear-recipes-') && key !== CACHE_NAME;
        }).map(function(key){
          return caches.delete(key);
        })
      );
    }).then(function(){
      return self.clients.claim();
    })
  );
});

/* ---- Fetch: cache-first for app shell, network-first for everything else ---- */
self.addEventListener('fetch', function(event){
  var url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip Firebase API requests (Firestore, Auth) — they handle their own caching
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('firestore.googleapis.com') ||
      url.hostname.includes('identitytoolkit.googleapis.com') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    return; // let Firebase + Google Fonts handle themselves
  }

  // For our own app files: cache-first, then network, update cache in background
  event.respondWith(
    caches.match(event.request).then(function(cached){
      var fetchPromise = fetch(event.request).then(function(networkResponse){
        if (networkResponse && networkResponse.status === 200){
          var responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(function(cache){
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      }).catch(function(){
        return cached; // offline fallback to whatever is cached
      });
      return cached || fetchPromise;
    })
  );
});

/* ---- Handle ?tab= shortcuts from the manifest ---- */
self.addEventListener('message', function(event){
  if (event.data && event.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
  }
});
