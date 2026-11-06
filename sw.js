// Offline support. Pages load fresh from the network when online (so updates show
// straight away) and fall back to the saved copy when offline.
const CACHE = "grindboard-v13";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const save = res => { if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return res; };
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request.url, {cache: "no-store", credentials: "same-origin"}).then(save).catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(save)));
});

// Phone notifications sent by the Grindboard server
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = {body: e.data && e.data.text()}; }
  e.waitUntil(self.registration.showNotification(d.title || "Grindboard", {body: d.body || "Time for your next task.", icon: "icon-192.png", badge: "icon-192.png", tag: d.tag || undefined, data: {url: d.url || "./"}}));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type: "window", includeUncontrolled: true}).then(list => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow(e.notification.data && e.notification.data.url || "./");
  }));
});
