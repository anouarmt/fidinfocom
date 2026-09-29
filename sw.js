/* FID INFO COM — service worker de l'application installée (Android / iPhone / PC).
   Stratégie « réseau d'abord » : chaque ouverture charge la dernière version publiée sur GitHub ;
   la copie locale ne sert qu'en cas de coupure internet. Les données (Supabase, Google) ne passent
   jamais par ce cache. */
const CACHE = "fidinfocom-app-v1";
const CORE = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // Supabase, Google, CDN : jamais en cache ici
  e.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res && res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((m) => m || (req.mode === "navigate" ? caches.match("./index.html") : undefined)))
  );
});
