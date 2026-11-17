/**
 * The app's service worker: it keeps the shell (the page, its scripts, styles, fonts and icons) so the app opens
 * from the home screen without a network, and caches nothing else. Every read and write to the server (WebSocket,
 * /api, /query, /info, media) goes straight to the network, never to a cache: what a person sees is never stale.
 *
 * Bounded: one cache, emptied of older versions on activation, and trimmed to MAX_ASSETS files.
 */
const CACHE = "creaton-shell-v1";
const SHELL = [
  "/",
  "/assets/manifest.webmanifest",
  "/assets/icons/icon-192.png",
  "/assets/icons/mark.svg",
];
const MAX_ASSETS = 60;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  const extra = keys.length - MAX_ASSETS;
  for (let i = 0; i < extra; i += 1) await cache.delete(keys[i]);
}

async function keep(request, response) {
  if (!response.ok || response.type !== "basic") return;
  const cache = await caches.open(CACHE);
  await cache.put(request, response);
  await trim(cache);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // A page: the network first, so a new version shows at once; the kept shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          event.waitUntil(keep(new Request("/"), response.clone()));
          return response;
        })
        .catch(() => caches.match("/").then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // The shell's own files: built with a content hash in their names, so a kept copy is always right.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            event.waitUntil(keep(request, response.clone()));
            return response;
          }),
      ),
    );
  }
});
