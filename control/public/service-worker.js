/**
 * Service worker of the J5 control panel. It keeps the application shell available without a
 * network, as when the computer is associated with the access point of a node (ADR 0002):
 *
 * - the page goes to the network first, with a short deadline, and falls back to the cached copy;
 * - the files under assets/ have hashed names and never change, so they come from the cache first;
 * - the other files of the shell (manifest and icons) come from the cache and are refreshed later.
 *
 * WebSocket connections and requests to other origins never pass through it.
 */

const CACHE_NAME = "j5-control-panel-shell-1";
const SCOPE_URL = new URL(self.registration.scope);
const PAGE_URL = new URL("./", SCOPE_URL).href;
const STATIC_PATHS = [
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
];
/** Without an answer from the network within this time, the cached page is used. */
const PAGE_NETWORK_DEADLINE_MILLISECONDS = 3000;

function isInScope(url) {
  return url.origin === SCOPE_URL.origin && url.pathname.startsWith(SCOPE_URL.pathname);
}

function isHashedAsset(url) {
  return url.pathname.startsWith(new URL("assets/", SCOPE_URL).pathname);
}

/** Scripts, stylesheets and other files the page references, inside the scope. */
function referencedUrls(html, pageUrl) {
  const urls = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = new URL(match[1], pageUrl);
    if (isInScope(url)) {
      urls.add(url.href);
    }
  }
  return [...urls];
}

/** Stores the page and every file it needs; removes hashed files no page references any more. */
async function storeShell(cache, pageResponse) {
  const html = await pageResponse.clone().text();
  await cache.put(PAGE_URL, pageResponse);
  const needed = new Set([
    ...referencedUrls(html, PAGE_URL),
    ...STATIC_PATHS.map((path) => new URL(path, SCOPE_URL).href),
  ]);
  for (const url of needed) {
    if ((await cache.match(url)) === undefined) {
      try {
        await cache.add(url);
      } catch {
        // A missing file must not prevent the rest of the shell from being stored.
      }
    }
  }
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (isHashedAsset(url) && !needed.has(url.href)) {
      await cache.delete(request);
    }
  }
}

async function fetchWithDeadline(request, milliseconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function respondToPage(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetchWithDeadline(request, PAGE_NETWORK_DEADLINE_MILLISECONDS);
    if (response.ok) {
      await storeShell(cache, response.clone());
    }
    return response;
  } catch {
    return (await cache.match(PAGE_URL)) ?? Response.error();
  }
}

async function respondFromCacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached !== undefined) {
    return cached;
  }
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}

async function respondAndRefresh(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request);
  const refresh = fetch(event.request)
    .then(async (response) => {
      if (response.ok) {
        await cache.put(event.request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);
  if (cached !== undefined) {
    event.waitUntil(refresh);
    return cached;
  }
  return (await refresh) ?? Response.error();
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const response = await fetch(PAGE_URL, { cache: "no-cache" });
      if (response.ok) {
        await storeShell(cache, response);
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== CACHE_NAME) {
          await caches.delete(name);
        }
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (!isInScope(url)) {
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(respondToPage(request));
  } else if (isHashedAsset(url)) {
    event.respondWith(respondFromCacheFirst(request));
  } else {
    event.respondWith(respondAndRefresh(event));
  }
});
