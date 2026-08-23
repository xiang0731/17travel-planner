(function (root, factory) {
    'use strict';

    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root === 'object') {
        Object.defineProperty(root, 'TravelPlannerPerformance', {
            configurable: false,
            enumerable: true,
            writable: false,
            value: Object.freeze(api)
        });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const ROUTE_ALGORITHM_VERSION = 'provider-route-result-v3';
    const ROUTE_COORDINATE_PRECISION = 5;
    const RETRYABLE_CODES = new Set([
        'BFF_NETWORK_ERROR',
        'BFF_TIMEOUT',
        'UPSTREAM_TIMEOUT',
        'UPSTREAM_UNAVAILABLE',
        'RATE_LIMITED'
    ]);
    const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
    const NON_RETRYABLE_CODES = new Set([
        'BFF_ABORTED',
        'INVALID_ARGUMENT',
        'PROVIDER_NOT_CONFIGURED',
        'PROVIDER_KEY_INVALID',
        'API_KEY_INVALID',
        'REQUEST_DENIED',
        'PROVIDER_QUOTA_EXCEEDED',
        'RESOURCE_EXHAUSTED',
        'CAPABILITY_UNAVAILABLE'
    ]);

    function abortError() {
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        error.code = 'BFF_ABORTED';
        return error;
    }

    function isRetryableError(error) {
        if (!error || error.name === 'AbortError') return false;
        const code = String(error.code || '');
        if (NON_RETRYABLE_CODES.has(code)) return false;
        return RETRYABLE_CODES.has(code) || RETRYABLE_STATUSES.has(Number(error.status));
    }

    function sleep(ms, signal) {
        if (signal?.aborted) return Promise.reject(abortError());
        return new Promise((resolve, reject) => {
            const finish = () => {
                signal?.removeEventListener?.('abort', onAbort);
                resolve();
            };
            const timer = setTimeout(finish, ms);
            const onAbort = () => {
                clearTimeout(timer);
                signal?.removeEventListener?.('abort', onAbort);
                reject(abortError());
            };
            signal?.addEventListener?.('abort', onAbort, { once: true });
        });
    }

    function normalizePoint(point, precision = ROUTE_COORDINATE_PRECISION) {
        const lat = Number(point?.lat);
        const lng = Number(point?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new TypeError('route point is invalid');
        return `${lat.toFixed(precision)},${lng.toFixed(precision)}`;
    }

    function createRouteResultCacheKey(input = {}) {
        const precision = Math.min(8, Math.max(3, Math.trunc(Number(input.coordinatePrecision) || ROUTE_COORDINATE_PRECISION)));
        const algorithmVersion = String(input.algorithmVersion || ROUTE_ALGORITHM_VERSION);
        const provider = String(input.provider || '').trim().toLowerCase();
        const travelMode = String(input.travelMode || 'DRIVING').trim().toUpperCase();
        return [
            'route-result',
            `provider=${provider}`,
            `mode=${travelMode}`,
            `precision=${precision}`,
            `algorithm=${algorithmVersion}`,
            `from=${normalizePoint(input.origin, precision)}`,
            `to=${normalizePoint(input.destination, precision)}`
        ].join('|');
    }

    class Semaphore {
        constructor(limit = 4) {
            this.limit = Math.max(1, Math.trunc(Number(limit) || 4));
            this.activeCount = 0;
            this.queue = [];
            this.maxObserved = 0;
        }

        acquire(signal) {
            if (signal?.aborted) return Promise.reject(abortError());
            if (this.activeCount < this.limit) {
                this.activeCount += 1;
                this.maxObserved = Math.max(this.maxObserved, this.activeCount);
                return Promise.resolve(this.release.bind(this));
            }
            return new Promise((resolve, reject) => {
                const entry = { resolve, reject, signal, onAbort: null };
                entry.onAbort = () => {
                    const index = this.queue.indexOf(entry);
                    if (index >= 0) this.queue.splice(index, 1);
                    reject(abortError());
                };
                signal?.addEventListener?.('abort', entry.onAbort, { once: true });
                this.queue.push(entry);
            });
        }

        release() {
            while (this.queue.length > 0) {
                const entry = this.queue.shift();
                entry.signal?.removeEventListener?.('abort', entry.onAbort);
                if (entry.signal?.aborted) {
                    entry.reject(abortError());
                    continue;
                }
                entry.resolve(this.release.bind(this));
                return;
            }
            this.activeCount = Math.max(0, this.activeCount - 1);
        }
    }

    class GenerationRegistry {
        constructor() {
            this.channels = new Map();
        }

        begin(channel) {
            const name = String(channel);
            const previous = this.channels.get(name);
            previous?.controller?.abort();
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            const token = Object.freeze({
                channel: name,
                generation: (previous?.generation || 0) + 1,
                controller,
                signal: controller?.signal
            });
            this.channels.set(name, token);
            return token;
        }

        current(channel) {
            return this.channels.get(String(channel)) || null;
        }

        isCurrent(token) {
            if (!token) return false;
            const current = this.channels.get(token.channel);
            return current?.generation === token.generation && token.signal?.aborted !== true;
        }

        invalidate(channel) {
            return this.begin(channel);
        }

        abortAll() {
            this.channels.forEach(token => token.controller?.abort());
            this.channels.clear();
        }
    }

    class RequestCoordinator {
        constructor(options = {}) {
            this.cache = options.cache instanceof Map ? options.cache : new Map();
            this.inFlight = new Map();
            this.cacheTtlMs = Math.max(0, Number(options.cacheTtlMs) || 10 * 60 * 1000);
            this.maxRetries = Math.min(4, Math.max(0, Math.trunc(Number(options.maxRetries) || 0)));
            this.baseDelayMs = Math.max(0, Number(options.baseDelayMs) || 120);
            this.now = typeof options.now === 'function' ? options.now : Date.now;
            this.random = typeof options.random === 'function' ? options.random : Math.random;
            this.semaphore = new Semaphore(options.maxConcurrency || 4);
            this.stats = {
                networkCalls: 0,
                cacheHits: 0,
                inFlightHits: 0,
                retries: 0
            };
        }

        getCached(key) {
            const cached = this.cache.get(key);
            if (!cached) return null;
            if ((this.now() - cached.timestamp) >= this.cacheTtlMs) {
                this.cache.delete(key);
                return null;
            }
            this.stats.cacheHits += 1;
            return cached.value;
        }

        request(key, task, options = {}) {
            const cached = this.getCached(key);
            if (cached !== null) return Promise.resolve(cached);

            const existing = this.inFlight.get(key);
            if (existing && existing.signal?.aborted !== true) {
                this.stats.inFlightHits += 1;
                return existing.promise;
            }
            if (existing) this.inFlight.delete(key);

            const signal = options.signal || null;
            const promise = this.run(task, signal, options)
                .then(value => {
                    if (signal?.aborted) throw abortError();
                    this.cache.set(key, { value, timestamp: this.now() });
                    return value;
                });
            this.inFlight.set(key, { promise, signal });
            promise.finally(() => {
                if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
            }).catch(() => {});
            return promise;
        }

        async run(task, signal, options) {
            const release = await this.semaphore.acquire(signal);
            const maxRetries = options.maxRetries === undefined
                ? this.maxRetries
                : Math.min(4, Math.max(0, Math.trunc(Number(options.maxRetries) || 0)));
            try {
                for (let attempt = 0; ; attempt += 1) {
                    if (signal?.aborted) throw abortError();
                    try {
                        this.stats.networkCalls += 1;
                        return await task({ signal, attempt });
                    } catch (error) {
                        if (attempt >= maxRetries || !isRetryableError(error)) throw error;
                        this.stats.retries += 1;
                        const exponential = this.baseDelayMs * (2 ** attempt);
                        const jitter = exponential * 0.2 * this.random();
                        await sleep(exponential + jitter, signal);
                    }
                }
            } finally {
                release();
            }
        }
    }

    class RouteResultProvider {
        constructor(options = {}) {
            if (typeof options.fetchRoute !== 'function') throw new TypeError('fetchRoute must be a function');
            this.fetchRoute = options.fetchRoute;
            this.coordinatePrecision = options.coordinatePrecision || ROUTE_COORDINATE_PRECISION;
            this.algorithmVersion = options.algorithmVersion || ROUTE_ALGORITHM_VERSION;
            this.coordinator = options.coordinator || new RequestCoordinator(options);
        }

        get(input = {}, options = {}) {
            const request = {
                provider: String(input.provider || '').toLowerCase(),
                travelMode: String(input.travelMode || 'DRIVING').toUpperCase(),
                origin: input.origin,
                destination: input.destination,
                coordinatePrecision: this.coordinatePrecision,
                algorithmVersion: this.algorithmVersion
            };
            const cacheKey = createRouteResultCacheKey(request);
            return this.coordinator.request(cacheKey, async ({ signal }) => {
                const raw = await this.fetchRoute(request, { signal });
                const distanceMeters = Number(raw?.distanceMeters);
                const durationSeconds = Number(raw?.durationSeconds);
                const coordinates = Array.isArray(raw?.coordinates) ? raw.coordinates : [];
                if (!Number.isFinite(distanceMeters) || distanceMeters < 0 ||
                    !Number.isFinite(durationSeconds) || durationSeconds < 0 || coordinates.length < 2) {
                    const error = new Error('Provider returned an invalid RouteResult');
                    error.code = 'INVALID_ROUTE_RESULT';
                    throw error;
                }
                return Object.freeze({
                    provider: request.provider,
                    travelMode: request.travelMode,
                    origin: Object.freeze({ lat: Number(request.origin.lat), lng: Number(request.origin.lng) }),
                    destination: Object.freeze({ lat: Number(request.destination.lat), lng: Number(request.destination.lng) }),
                    coordinates: Object.freeze(coordinates.map(point => Object.freeze([Number(point[0]), Number(point[1])]))),
                    distanceMeters,
                    durationSeconds,
                    source: 'provider',
                    cacheKey,
                    algorithmVersion: this.algorithmVersion
                });
            }, options);
        }
    }

    class SpatialGrid {
        constructor(cellSize = 96) {
            this.cellSize = Math.max(8, Number(cellSize) || 96);
            this.cells = new Map();
            this.comparisons = 0;
        }

        cellRange(rect) {
            return {
                minX: Math.floor(rect.left / this.cellSize),
                maxX: Math.floor(rect.right / this.cellSize),
                minY: Math.floor(rect.top / this.cellSize),
                maxY: Math.floor(rect.bottom / this.cellSize)
            };
        }

        keys(rect) {
            const range = this.cellRange(rect);
            const keys = [];
            for (let x = range.minX; x <= range.maxX; x += 1) {
                for (let y = range.minY; y <= range.maxY; y += 1) keys.push(`${x}:${y}`);
            }
            return keys;
        }

        insert(rect) {
            this.keys(rect).forEach(key => {
                const entries = this.cells.get(key) || [];
                entries.push(rect);
                this.cells.set(key, entries);
            });
        }

        intersects(rect, ignoreOwner = null) {
            const seen = new Set();
            for (const key of this.keys(rect)) {
                const entries = this.cells.get(key) || [];
                for (const candidate of entries) {
                    if (seen.has(candidate)) continue;
                    seen.add(candidate);
                    if (candidate.type === 'pin' && candidate.owner === ignoreOwner) continue;
                    this.comparisons += 1;
                    if (!(rect.right < candidate.left || rect.left > candidate.right ||
                        rect.bottom < candidate.top || rect.top > candidate.bottom)) return true;
                }
            }
            return false;
        }
    }

    function reconcileKeyedChildren(container, descriptors) {
        if (!container) return { created: 0, reused: 0, removed: 0, moved: 0 };
        const existing = new Map();
        Array.from(container.children || []).forEach(node => {
            const key = node.dataset?.renderKey;
            if (key) existing.set(key, node);
        });
        let cursor = container.firstChild;
        let created = 0;
        let reused = 0;
        let moved = 0;
        const retained = new Set();

        descriptors.forEach(descriptor => {
            const key = String(descriptor.key);
            const signature = String(descriptor.signature || '');
            let node = existing.get(key);
            if (!node || node.dataset?.renderSignature !== signature) {
                const replacedCursor = node === cursor;
                const replacement = descriptor.create();
                replacement.dataset.renderKey = key;
                replacement.dataset.renderSignature = signature;
                if (node?.parentNode === container) container.replaceChild(replacement, node);
                node = replacement;
                if (replacedCursor) cursor = node;
                created += 1;
            } else {
                reused += 1;
            }
            retained.add(node);
            if (node !== cursor) {
                container.insertBefore(node, cursor || null);
                moved += 1;
            }
            cursor = node.nextSibling;
        });

        let removed = 0;
        Array.from(container.children || []).forEach(node => {
            if (retained.has(node)) return;
            node.remove();
            removed += 1;
        });
        return { created, reused, removed, moved };
    }

    return {
        GenerationRegistry,
        RequestCoordinator,
        RouteResultProvider,
        ROUTE_ALGORITHM_VERSION,
        ROUTE_COORDINATE_PRECISION,
        Semaphore,
        SpatialGrid,
        abortError,
        createRouteResultCacheKey,
        isRetryableError,
        reconcileKeyedChildren
    };
});
