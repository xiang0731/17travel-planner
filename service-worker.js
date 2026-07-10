const CACHE_PREFIX = 'travel-planner-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v1.15.0`;
const APP_SHELL = [
    './',
    './index.html',
    './styles.css?v=1.15.0',
    './script.js?v=1.15.0'
];

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
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const response = await fetch(request);
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

    if (request.destination !== 'script' && request.destination !== 'style') return;

    event.respondWith((async () => {
        const cached = await caches.match(request);
        if (cached) {
            event.waitUntil(
                fetch(request)
                    .then(async response => {
                        if (response.ok) {
                            const cache = await caches.open(CACHE_NAME);
                            await cache.put(request, response.clone());
                        }
                    })
                    .catch(() => undefined)
            );
            return cached;
        }

        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
        }
        return response;
    })());
});
