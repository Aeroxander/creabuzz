/**
 * The app's service worker: it shows the short alerts the server sends when the app is closed (below), and it keeps the shell (the page, its scripts, styles, fonts and icons) so the app opens
 * from the home screen without a network, and caches nothing else. Every read and write to the server (WebSocket,
 * /api, /query, /info, media) goes straight to the network, never to a cache: what a person sees is never stale.
 *
 * Bounded: one cache, emptied of older versions on activation, and trimmed to MAX_ASSETS files.
 */
const CACHE = "creaton-shell-v2";
const SHELL = [
  "/",
  "/assets/manifest.webmanifest",
  "/assets/icons/icon-192.png",
  "/assets/icons/mark.svg",
];
const MAX_ASSETS = 60;
/** A built file's name ends in a content hash (`index-BX3aPc-r.js`); the manifest and icons do not. */
const HASHED = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

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
  if (!response.ok || response.type !== "basic" || response.redirected) return;
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
          // Only the app's own page becomes the offline shell: never a server file opened as a page (an image, a
          // markdown or JSON file), and never a redirect, which a browser refuses to show for a page load.
          const type = response.headers.get("content-type") ?? "";
          if (type.startsWith("text/html"))
            event.waitUntil(keep(new Request("/"), response.clone()));
          return response;
        })
        .catch(() => caches.match("/").then((hit) => hit ?? Response.error())),
    );
    return;
  }

  if (!url.pathname.startsWith("/assets/")) return;

  // The manifest and the icons keep their names between versions: the network first, so an update reaches the
  // installed app; the kept copy when offline.
  if (!HASHED.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          event.waitUntil(keep(request, response.clone()));
          return response;
        })
        .catch(() =>
          caches.match(request).then((hit) => hit ?? Response.error()),
        ),
    );
    return;
  }

  // The built files: a content hash in their names, so a kept copy is always right.
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
});

/*
 * Alerts away from the app. The server sends a short encrypted message {"v":1,"k":"planned"|"taken"|"ended","r":"<project link>"}:
 * a kind and the project's link, never an amount, a name or a date. This file turns it into one of three fixed sentences, so
 * nothing it shows can be anything else. A message of any other shape is dropped without showing anything. The same sentences
 * and kinds are in the app (`src/features/alerts/push/push-words.ts`); a test holds the two together.
 */
const PUSH_TITLE = "News about a project you back";
const PUSH_WORDS = {
  planned:
    "A task was planned on a project you back. You can take your money out first.",
  taken: "A task was started on a project you back.",
  ended: "A task ended on a project you back.",
};
/** A project's link: its id, then the first 16 hex characters of its founder (the part of /p/<link> after /p/). */
const PROJECT_LINK = /^[A-Za-z0-9._~-]{1,120}-[0-9a-f]{16}$/;

/** What a message says, or null when it is not the one shape this file shows. */
function readPush(data) {
  let message;
  try {
    message = data ? data.json() : null;
  } catch (_error) {
    return null;
  }
  if (!message || typeof message !== "object" || Array.isArray(message))
    return null;
  const kind = message.k;
  if (message.v !== 1 || typeof kind !== "string") return null;
  if (!Object.hasOwn(PUSH_WORDS, kind)) return null;
  const link = message.r;
  if (typeof link !== "string" || !PROJECT_LINK.test(link)) return null;
  return { kind, link };
}

self.addEventListener("push", (event) => {
  const push = readPush(event.data);
  if (!push) return;
  event.waitUntil(
    self.registration.showNotification(PUSH_TITLE, {
      body: PUSH_WORDS[push.kind],
      icon: "/assets/icons/icon-192.png",
      // One alert of a kind for a project at a time: a newer one replaces one the person has not looked at.
      tag: `${push.kind}:${push.link}`,
      data: { url: `/p/${push.link}` },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const wanted = event.notification.data?.url;
  // Only the app's own project pages: anything else opens Home.
  const url =
    typeof wanted === "string" &&
    wanted.startsWith("/p/") &&
    !wanted.includes("//")
      ? wanted
      : "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        const open = windows.find((w) =>
          w.url.startsWith(self.location.origin),
        );
        if (open) {
          return open
            .focus()
            .then((focused) => (focused || open).navigate(url))
            .catch(() => self.clients.openWindow(url));
        }
        return self.clients.openWindow(url);
      }),
  );
});
