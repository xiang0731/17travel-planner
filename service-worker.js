const CACHE_PREFIX = 'travel-planner-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v3.3.7`;
const APP_SHELL = Object.freeze([
    './',
    './index.html',
    './assets/css/styles.css?v=3.2.5',
    './assets/js/preload.js?v=2.0.0',
    './assets/js/security.js?v=2.0.0',
    './assets/js/client-security.js?v=2.0.0',
    './assets/js/planner-data.js?v=2.1.0',
    './assets/js/search-controller.js?v=2.2.0',
    './assets/js/route-optimizer.js?v=3.0.0',
    './assets/js/performance-pipeline.js?v=1.0.0',
    './assets/js/script.js?v=3.2.1'
]);
const CACHEABLE_PATHS = new Set([
    '/',
    '/index.html',
    '/assets/css/styles.css',
    '/assets/js/preload.js',
    '/assets/js/security.js',
    '/assets/js/client-security.js',
    '/assets/js/planner-data.js',
    '/assets/js/search-controller.js',
    '/assets/js/route-optimizer.js',
    '/assets/js/performance-pipeline.js',
    '/assets/js/script.js'
]);

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== self.location.origin) return;

    // Authentication, public deployment config and every BFF response are network-only.
    if (url.pathname.startsWith('/api/') || url.pathname === '/assets/js/public-config.js') return;

    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const response = await fetch(request, { cache: 'no-store' });
                if (response.ok) {
                    const cache = await caches.open(CACHE_NAME);
                    await cache.put('./index.html', response.clone());
                }
                return response;
            } catch (error) {
                return (await caches.match('./index.html')) || caches.match('./');
            }
        })());
        return;
    }

    if (!CACHEABLE_PATHS.has(url.pathname)) return;
    event.respondWith((async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (!response.ok) return response;
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
        return response;
    })());
});
