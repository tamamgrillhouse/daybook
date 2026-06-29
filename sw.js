var CACHE = 'cashbox-pages-7bd6ff4e28';
var SHELL = ['./','./index.html','./connect.html','./manifest.webmanifest',
  './css/cashbox-mobile.css','./js/cashbox-app.js','./js/cashbox-sync.js','./js/cashbox-lock.js','./js/confirm.js',
  './icons/icon-192.png','./icons/icon-512.png','./icons/apple-touch-icon.png'];
self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){
    return Promise.all(SHELL.map(function(u){ return c.add(u).catch(function(){}); }));
  }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.map(function(k){ if(k!==CACHE){ return caches.delete(k); } }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e){
  if(e.request.method!=='GET'){ return; }
  var url = new URL(e.request.url);
  if(url.origin !== self.location.origin){ return; }            // GitHub API κ.λπ. → δίκτυο
  if(e.request.mode==='navigate'){                              // άνοιγμα app → δίκτυο, αλλιώς cache
    e.respondWith(fetch(e.request).catch(function(){
      return caches.match(e.request).then(function(m){ return m || caches.match('./index.html'); });
    }));
    return;
  }
  e.respondWith(caches.match(e.request).then(function(m){       // assets → cache-first
    return m || fetch(e.request).then(function(resp){
      var cp = resp.clone(); caches.open(CACHE).then(function(c){ c.put(e.request, cp); });
      return resp;
    });
  }));
});
