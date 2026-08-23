(function (root, factory) {
    'use strict';

    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root === 'object') {
        Object.defineProperty(root, 'TravelPlannerSearch', {
            configurable: false,
            enumerable: true,
            writable: false,
            value: Object.freeze(api)
        });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SEARCH_STATES = Object.freeze([
        'idle',
        'loading',
        'success',
        'empty',
        'configuration-required',
        'error',
        'demo'
    ]);
    const SEARCH_STATE_SET = new Set(SEARCH_STATES);

    function normalizeQuery(value) {
        return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
    }

    function normalizeLocationBias(value) {
        if (!value || typeof value !== 'object') return null;
        const lat = Number(value.lat);
        const lng = Number(value.lng);
        const radiusMeters = Math.round(Number(value.radiusMeters) || 0);
        if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
            !Number.isFinite(lng) || lng < -180 || lng > 180 ||
            radiusMeters < 1 || radiusMeters > 50000) return null;
        return {
            lat: Number(lat.toFixed(6)),
            lng: Number(lng.toFixed(6)),
            radiusMeters
        };
    }

    function normalizeContext(input = {}) {
        return {
            provider: String(input.provider || '').trim().toLowerCase(),
            query: String(input.query ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' '),
            language: String(input.language || '').trim().toLowerCase(),
            region: String(input.region || '').trim().toUpperCase(),
            locationBias: normalizeLocationBias(input.locationBias)
        };
    }

    function createSearchCacheKey(input = {}) {
        const context = normalizeContext(input);
        return JSON.stringify([
            'place-search-v2',
            'coordinate-precision=6',
            'algorithm=provider-place-search-v2',
            context.provider,
            normalizeQuery(context.query),
            context.region,
            context.language,
            context.locationBias
        ]);
    }

    function searchErrorKind(error) {
        const code = String(error?.code || 'UNKNOWN');
        if (code === 'PROVIDER_NOT_CONFIGURED') return 'configuration';
        if (['CAPABILITY_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'PROVIDER_FORBIDDEN'].includes(code)) return 'unsupported';
        if (['PROVIDER_KEY_INVALID', 'API_KEY_INVALID', 'REQUEST_DENIED'].includes(code)) return 'key';
        if (['PROVIDER_QUOTA_EXCEEDED', 'RATE_LIMITED', 'RESOURCE_EXHAUSTED'].includes(code)) return 'quota';
        if (['BFF_TIMEOUT', 'UPSTREAM_TIMEOUT'].includes(code)) return 'timeout';
        if (['BFF_NETWORK_ERROR', 'UPSTREAM_UNAVAILABLE'].includes(code)) return 'network';
        if (code === 'BFF_ABORTED' || error?.name === 'AbortError') return 'aborted';
        return 'unknown';
    }

    function isRetryableSearchError(error) {
        const code = String(error?.code || '');
        const status = Number(error?.status);
        if (['BFF_ABORTED', 'INVALID_ARGUMENT', 'PROVIDER_NOT_CONFIGURED', 'PROVIDER_KEY_INVALID',
            'API_KEY_INVALID', 'REQUEST_DENIED', 'PROVIDER_QUOTA_EXCEEDED', 'RESOURCE_EXHAUSTED',
            'CAPABILITY_UNAVAILABLE'].includes(code)) return false;
        return ['BFF_NETWORK_ERROR', 'BFF_TIMEOUT', 'UPSTREAM_TIMEOUT', 'UPSTREAM_UNAVAILABLE', 'RATE_LIMITED']
            .includes(code) || [408, 425, 429, 500, 502, 503, 504].includes(status);
    }

    function waitForRetry(ms, signal) {
        if (signal?.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                clearTimeout(timer);
                signal?.removeEventListener?.('abort', onAbort);
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener?.('abort', onAbort);
                resolve();
            }, ms);
            signal?.addEventListener?.('abort', onAbort, { once: true });
        });
    }

    class SearchController {
        constructor(options = {}) {
            if (typeof options.search !== 'function') throw new TypeError('search must be a function');
            if (typeof options.onStateChange !== 'function') throw new TypeError('onStateChange must be a function');
            this.search = options.search;
            this.onStateChange = options.onStateChange;
            this.demoSearch = typeof options.demoSearch === 'function' ? options.demoSearch : () => [];
            this.unconfiguredBehavior = options.unconfiguredBehavior === 'demo' ? 'demo' : 'configuration-required';
            this.debounceMs = Math.max(0, Number(options.debounceMs) || 500);
            this.cacheTtlMs = Math.max(0, Number(options.cacheTtlMs) || 10 * 60 * 1000);
            this.cache = options.cache instanceof Map ? options.cache : new Map();
            this.now = typeof options.now === 'function' ? options.now : Date.now;
            this.setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
            this.clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
            this.maxRetries = Math.min(3, Math.max(0, Math.trunc(Number(options.maxRetries) || 0)));
            this.retryBaseDelayMs = Math.max(0, Number(options.retryBaseDelayMs) || 120);
            this.generation = 0;
            this.pendingTimer = null;
            this.pendingContext = null;
            this.active = null;
            this.state = Object.freeze({ status: 'idle', results: [] });
        }

        setState(status, details = {}) {
            if (!SEARCH_STATE_SET.has(status)) throw new TypeError(`Unknown search state: ${status}`);
            const results = Array.isArray(details.results) ? details.results : [];
            this.state = Object.freeze({ status, ...details, results });
            this.onStateChange(this.state);
            return this.state;
        }

        schedule(input) {
            const context = normalizeContext(input);
            this.cancelDebounce();
            if (normalizeQuery(context.query).length < 2) {
                this.invalidateActive();
                this.setState('idle', { query: context.query, results: [] });
                return;
            }

            const signature = createSearchCacheKey(context);
            if (this.active && this.active.signature !== signature) {
                this.invalidateActive();
                this.setState('idle', { context, query: context.query, results: [] });
            }
            this.pendingContext = context;
            this.pendingTimer = this.setTimer(() => {
                this.pendingTimer = null;
                const pending = this.pendingContext;
                this.pendingContext = null;
                void this.execute(pending);
            }, this.debounceMs);
        }

        submit(input) {
            this.cancelDebounce();
            const context = normalizeContext(input);
            if (!normalizeQuery(context.query)) {
                this.reset();
                return Promise.resolve(this.state);
            }
            return this.execute(context);
        }

        cancelDebounce() {
            if (this.pendingTimer !== null) this.clearTimer(this.pendingTimer);
            this.pendingTimer = null;
            this.pendingContext = null;
        }

        invalidateActive() {
            this.generation += 1;
            if (this.active?.controller) this.active.controller.abort();
            this.active = null;
        }

        reset() {
            this.cancelDebounce();
            this.invalidateActive();
            return this.setState('idle', { results: [] });
        }

        contextChanged() {
            return this.reset();
        }

        getCached(signature) {
            const cached = this.cache.get(signature);
            if (!cached) return null;
            if ((this.now() - cached.timestamp) >= this.cacheTtlMs) {
                this.cache.delete(signature);
                return null;
            }
            return Array.isArray(cached.results) ? cached.results : null;
        }

        async execute(input) {
            const context = normalizeContext(input);
            const signature = createSearchCacheKey(context);
            if (this.active?.signature === signature) return this.active.promise;

            this.invalidateActive();
            const generation = this.generation;
            const cached = this.getCached(signature);
            if (cached !== null) {
                return this.setState(cached.length ? 'success' : 'empty', {
                    context,
                    results: cached,
                    source: 'cache'
                });
            }

            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            this.setState('loading', { context, results: [] });
            const promise = this.runRequest(context, signature, generation, controller);
            this.active = { signature, generation, controller, promise };
            return promise;
        }

        async runRequest(context, signature, generation, controller) {
            try {
                const results = await this.searchWithRetry(context, controller?.signal);
                if (generation !== this.generation) return this.state;
                const safeResults = Array.isArray(results) ? results : [];
                this.cache.set(signature, { results: safeResults, timestamp: this.now() });
                return this.setState(safeResults.length ? 'success' : 'empty', {
                    context,
                    results: safeResults,
                    source: 'network'
                });
            } catch (error) {
                if (generation !== this.generation) return this.state;
                const kind = searchErrorKind(error);
                if (kind === 'aborted') return this.state;
                if (kind === 'configuration' && this.unconfiguredBehavior === 'demo') {
                    const results = await Promise.resolve(this.demoSearch(context));
                    if (generation !== this.generation) return this.state;
                    return this.setState('demo', { context, results: Array.isArray(results) ? results : [], reason: kind });
                }
                if (kind === 'configuration' || kind === 'unsupported') {
                    return this.setState('configuration-required', { context, results: [], reason: kind, error });
                }
                return this.setState('error', { context, results: [], reason: kind, error });
            } finally {
                if (this.active?.generation === generation) this.active = null;
            }
        }

        async searchWithRetry(context, signal) {
            for (let attempt = 0; ; attempt += 1) {
                try {
                    return await this.search(context, { signal, attempt });
                } catch (error) {
                    if (attempt >= this.maxRetries || !isRetryableSearchError(error) || signal?.aborted) throw error;
                    await waitForRetry(this.retryBaseDelayMs * (2 ** attempt), signal);
                }
            }
        }
    }

    return {
        SEARCH_STATES,
        SearchController,
        createSearchCacheKey,
        normalizeContext,
        normalizeLocationBias,
        normalizeQuery,
        searchErrorKind,
        isRetryableSearchError
    };
});
