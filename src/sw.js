/* Service worker: offline support + Android "Share to" target.
 * The VERSION, BASE and PRECACHE placeholders below are filled in by build.mjs.
 * Only same-origin GET requests are handled; ads and analytics always go to the network.
 */
const VERSION = '__VERSION__';
const BASE = '__BASE__';
const PRECACHE = __PRECACHE__;

const SHELL_CACHE = `itp-shell-${VERSION}`;
const RUNTIME_CACHE = 'itp-runtime-v1';
const SHARE_CACHE = 'itp-shared-files';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        PRECACHE.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((res) => (res.ok ? cache.put(url, res) : null))
            .catch(() => null)
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, RUNTIME_CACHE, SHARE_CACHE]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('itp-') && !keep.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

async function handleShareTarget(request) {
  const form = await request.formData();
  const files = form.getAll('images').filter((f) => f && typeof f === 'object' && f.size > 0);
  await caches.delete(SHARE_CACHE);
  const cache = await caches.open(SHARE_CACHE);
  await Promise.all(
    files.map((file, i) =>
      cache.put(
        `${BASE}/__shared/${i}`,
        new Response(file, {
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name || `shared-${i + 1}`),
            'X-Last-Modified': String(file.lastModified || Date.now()),
          },
        })
      )
    )
  );
  return Response.redirect(`${BASE}/?shared=${files.length}`, 303);
}

async function networkFirst(request) {
  const runtime = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) runtime.put(request, res.clone());
    return res;
  } catch {
    return (
      (await caches.match(request, { ignoreSearch: true })) ||
      (await caches.match(`${BASE}/`)) ||
      new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } })
    );
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) (await caches.open(RUNTIME_CACHE)).put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.method === 'POST' && url.pathname === `${BASE}/share-target/`) {
    event.respondWith(handleShareTarget(request));
    return;
  }
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
  } else if (url.pathname.startsWith(`${BASE}/assets/`) || /\.(png|svg|ico)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});
