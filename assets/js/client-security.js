(function (root, factory) {
    'use strict';

    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        Object.defineProperty(root, 'TravelPlannerClientSecurity', {
            configurable: false,
            enumerable: true,
            writable: false,
            value: Object.freeze(api)
        });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const PROVIDERS = Object.freeze(['gaode', 'google', 'tianditu', 'azure']);
    const TRAVEL_MODES = Object.freeze(['DRIVING', 'WALKING', 'BICYCLING', 'TRANSIT']);
    const BFF_BASE_PATH = '/api/v1';
    const STORAGE_RECORDS = Object.freeze(['travelPlannerData', 'travelSchemes']);
    const LEGACY_SECRET_RECORDS = Object.freeze([
        'apiKeys',
        'googleApiKey',
        'gaodeApiKey',
        'bingApiKey',
        'tiandituApiKey',
        'azureMapsApiKey'
    ]);
    const SENSITIVE_FIELD_NAMES = new Set([
        'apikey', 'apikeys', 'api_key', 'api_keys',
        'sdkpublickeys', 'byok', 'byokkeys',
        'googleapikey', 'gaodeapikey', 'bingapikey', 'tiandituapikey', 'azuremapsapikey',
        'serverkey', 'webservicekey', 'secret', 'clientsecret',
        'key', 'tk', 'token', 'access_token', 'refreshtoken', 'refresh_token',
        'authorization', 'cookie', 'password', 'credential', 'signature',
        'url', 'uri', 'endpoint', 'headers', 'requesturl', 'fullurl'
    ]);

    function normalizedFieldName(value) {
        return String(value ?? '').replace(/[-\s]/g, '').toLowerCase();
    }

    function isSensitiveFieldName(name) {
        return SENSITIVE_FIELD_NAMES.has(normalizedFieldName(name));
    }

    function stripSensitiveFields(value, seen = new WeakSet()) {
        if (Array.isArray(value)) {
            return value.map(item => stripSensitiveFields(item, seen));
        }
        if (!value || typeof value !== 'object') return value;
        if (seen.has(value)) return null;
        seen.add(value);

        const result = {};
        Object.entries(value).forEach(([key, child]) => {
            if (!isSensitiveFieldName(key)) {
                result[key] = stripSensitiveFields(child, seen);
            }
        });
        return result;
    }

    function safeSettings(candidate = {}) {
        const stored = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
            ? candidate
            : {};
        const preferences = stored.preferences && typeof stored.preferences === 'object'
            ? stored.preferences
            : {};
        const selectedMapApi = PROVIDERS.includes(stored.selectedMapApi) ? stored.selectedMapApi : 'gaode';
        const navigationApps = ['amap', 'google', 'bing', 'tianditu'];

        return {
            navigationApp: navigationApps.includes(stored.navigationApp) ? stored.navigationApp : 'amap',
            selectedMapApi,
            advancedByokEnabled: stored.advancedByokEnabled === true,
            preferences: {
                openInNewTab: preferences.openInNewTab !== false,
                showNavigationHint: preferences.showNavigationHint !== false,
                showShowInMapButton: preferences.showShowInMapButton !== false,
                showNavigateToButton: preferences.showNavigateToButton !== false
            }
        };
    }

    function sanitizePersistedRecord(value) {
        const sanitized = stripSensitiveFields(value);
        if (!sanitized || typeof sanitized !== 'object') return sanitized;

        if (sanitized.settings !== undefined) {
            sanitized.settings = safeSettings(sanitized.settings);
        }
        if (sanitized.currentData && typeof sanitized.currentData === 'object' && sanitized.currentData.settings !== undefined) {
            sanitized.currentData.settings = safeSettings(sanitized.currentData.settings);
        }
        if (Array.isArray(sanitized.schemes)) {
            sanitized.schemes = sanitized.schemes.map(scheme => {
                if (scheme && typeof scheme === 'object' && scheme.settings !== undefined) {
                    delete scheme.settings;
                }
                return scheme;
            });
        }
        return sanitized;
    }

    function persistedPlace(value) {
        const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const place = {
            id: ['string', 'number'].includes(typeof source.id) ? source.id : '',
            name: String(source.name ?? '').slice(0, 1000),
            address: String(source.address ?? '').slice(0, 2000),
            lat: Number.isFinite(source.lat) ? source.lat : null,
            lng: Number.isFinite(source.lng) ? source.lng : null,
            customName: source.customName == null ? null : String(source.customName).slice(0, 100),
            notes: source.notes == null ? null : String(source.notes).slice(0, 500),
            isPending: source.isPending === true,
            isBlank: source.isBlank === true
        };
        if (PROVIDERS.includes(source.source) || source.source === 'manual') place.source = source.source;
        return place;
    }

    function persistedRouteSegments(value) {
        if (!Array.isArray(value)) return [];
        return value.slice(0, 5000).filter(entry => Array.isArray(entry) && entry.length === 2).map(entry => {
            const source = entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1]) ? entry[1] : {};
            return [String(entry[0] ?? '').slice(0, 500), {
                mapProvider: ['amap', ...PROVIDERS].includes(source.mapProvider) ? source.mapProvider : 'amap',
                travelMode: TRAVEL_MODES.includes(source.travelMode) ? source.travelMode : 'DRIVING'
            }];
        });
    }

    function persistedScheme(value) {
        const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        return {
            id: ['string', 'number'].includes(typeof source.id) ? source.id : '',
            uuid: source.uuid == null ? '' : String(source.uuid).slice(0, 300),
            name: String(source.name ?? '').slice(0, 100),
            travelList: Array.isArray(source.travelList) ? source.travelList.slice(0, 5000).map(persistedPlace) : [],
            routeSegments: persistedRouteSegments(source.routeSegments),
            placesCount: Array.isArray(source.travelList) ? Math.min(5000, source.travelList.length) : 0,
            createdAt: String(source.createdAt ?? '').slice(0, 64),
            modifiedAt: String(source.modifiedAt ?? '').slice(0, 64),
            schemaVersion: source.schemaVersion === 4 ? 4 : 3,
            version: String(source.version ?? '3.0').slice(0, 16)
        };
    }

    function persistedApplicationRecord(value) {
        const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        return {
            travelList: Array.isArray(source.travelList) ? source.travelList.slice(0, 5000).map(persistedPlace) : [],
            routeSegments: persistedRouteSegments(source.routeSegments),
            settings: safeSettings(source.settings),
            currentSchemeId: ['string', 'number'].includes(typeof source.currentSchemeId) ? source.currentSchemeId : null,
            currentSchemeName: source.currentSchemeName == null ? null : String(source.currentSchemeName).slice(0, 100),
            hasUnsavedChanges: source.hasUnsavedChanges === true,
            dataSchemaVersion: source.dataSchemaVersion === 4 ? 4 : 3,
            lastSaved: String(source.lastSaved ?? '').slice(0, 64)
        };
    }

    function migrateLegacyStorage(storage) {
        const report = { migrated: [], removed: [] };
        if (!storage || typeof storage.getItem !== 'function') return report;

        STORAGE_RECORDS.forEach(storageKey => {
            const raw = storage.getItem(storageKey);
            if (!raw) return;
            try {
                const parsed = JSON.parse(raw);
                const cleaned = storageKey === 'travelPlannerData'
                    ? persistedApplicationRecord(parsed)
                    : (Array.isArray(parsed) ? parsed.slice(0, 1000).map(persistedScheme) : []);
                const next = JSON.stringify(cleaned);
                if (next !== raw) {
                    storage.setItem(storageKey, next);
                    report.migrated.push(storageKey);
                }
            } catch (error) {
                // Existing recovery behavior owns malformed application data.
            }
        });

        LEGACY_SECRET_RECORDS.forEach(storageKey => {
            if (storage.getItem(storageKey) !== null) {
                storage.removeItem(storageKey);
                report.removed.push(storageKey);
            }
        });
        return report;
    }

    function containsSensitiveField(value, seen = new WeakSet()) {
        if (!value || typeof value !== 'object') return false;
        if (seen.has(value)) return false;
        seen.add(value);
        if (Array.isArray(value)) return value.some(item => containsSensitiveField(item, seen));
        return Object.entries(value).some(([key, child]) =>
            isSensitiveFieldName(key) || containsSensitiveField(child, seen));
    }

    function finiteCoordinate(value, min, max, field) {
        const number = Number(value);
        if (!Number.isFinite(number) || number < min || number > max) {
            throw new TypeError(`${field} is invalid`);
        }
        return number;
    }

    function point(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new TypeError('point is invalid');
        }
        return {
            lat: finiteCoordinate(value.lat, -90, 90, 'lat'),
            lng: finiteCoordinate(value.lng, -180, 180, 'lng')
        };
    }

    function provider(value) {
        const normalized = String(value ?? '').toLowerCase();
        if (!PROVIDERS.includes(normalized)) throw new TypeError('provider is not allowed');
        return normalized;
    }

    function travelMode(value) {
        const normalized = String(value ?? 'DRIVING').toUpperCase();
        if (!TRAVEL_MODES.includes(normalized)) throw new TypeError('travelMode is not allowed');
        return normalized;
    }

    function limitedText(value, field, min, max) {
        const normalized = String(value ?? '').trim();
        if (normalized.length < min || normalized.length > max) {
            throw new TypeError(`${field} length is invalid`);
        }
        return normalized;
    }

    function createSessionId() {
        if (typeof crypto === 'object' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
            const random = Math.floor(Math.random() * 16);
            const value = character === 'x' ? random : ((random & 0x3) | 0x8);
            return value.toString(16);
        });
    }

    class BffError extends Error {
        constructor(message, status = 0, code = 'BFF_REQUEST_FAILED', requestId = '') {
            super(message);
            this.name = 'BffError';
            this.status = status;
            this.code = code;
            this.requestId = requestId;
        }
    }

    class BffClient {
        constructor(options = {}) {
            this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
            this.timeoutMs = Math.min(15000, Math.max(1000, Number(options.timeoutMs) || 8000));
            const sessionStore = options.sessionStorage || (typeof sessionStorage === 'object' ? sessionStorage : null);
            const storedSessionId = sessionStore && sessionStore.getItem('travelPlannerAnonymousSession');
            this.sessionId = options.sessionId || storedSessionId || createSessionId();
            if (sessionStore && !storedSessionId) {
                sessionStore.setItem('travelPlannerAnonymousSession', this.sessionId);
            }
            this.sessionReady = false;
            this.sessionPromise = null;
            if (!this.fetchImpl) throw new TypeError('fetch is unavailable');
        }

        async ensureSession() {
            if (this.sessionReady) return;
            if (!this.sessionPromise) {
                this.sessionPromise = this.post('session', { sessionId: this.sessionId }, 'application/json', true)
                    .then(() => { this.sessionReady = true; })
                    .catch(error => {
                        this.sessionPromise = null;
                        throw error;
                    });
            }
            return this.sessionPromise;
        }

        async post(endpoint, payload, accept = 'application/json', skipSessionBootstrap = false, options = {}) {
            const allowedEndpoints = new Set(['session', 'places/search', 'routes', 'route-matrix', 'static-maps']);
            if (!allowedEndpoints.has(endpoint)) throw new TypeError('BFF endpoint is not allowed');
            if (!skipSessionBootstrap) await this.ensureSession();

            const externalSignal = options && typeof options === 'object' ? options.signal : null;
            if (externalSignal?.aborted) throw new BffError('请求已取消', 0, 'BFF_ABORTED');
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            let timedOut = false;
            const abortFromCaller = () => controller?.abort();
            externalSignal?.addEventListener?.('abort', abortFromCaller, { once: true });
            const timeoutId = controller ? setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, this.timeoutMs) : null;
            let response;
            try {
                response = await this.fetchImpl(`${BFF_BASE_PATH}/${endpoint}`, {
                    method: 'POST',
                    credentials: 'same-origin',
                    cache: 'no-store',
                    redirect: 'error',
                    referrerPolicy: 'same-origin',
                    headers: {
                        'Accept': accept,
                        'Content-Type': 'application/json',
                        'X-Requested-With': '17TravelPlanner',
                        'X-Anonymous-Session': this.sessionId
                    },
                    body: JSON.stringify(payload),
                    signal: controller ? controller.signal : undefined
                });
            } catch (error) {
                const wasAborted = error && error.name === 'AbortError';
                const code = wasAborted
                    ? (timedOut ? 'BFF_TIMEOUT' : 'BFF_ABORTED')
                    : 'BFF_NETWORK_ERROR';
                const message = code === 'BFF_TIMEOUT'
                    ? '请求超时'
                    : (code === 'BFF_ABORTED' ? '请求已取消' : '地图服务暂时不可用');
                throw new BffError(message, 0, code);
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
                externalSignal?.removeEventListener?.('abort', abortFromCaller);
            }

            const requestId = response.headers && response.headers.get
                ? (response.headers.get('X-Request-Id') || '')
                : '';
            if (!response.ok) {
                let problem = {};
                try { problem = await response.json(); } catch (error) { /* no response body */ }
                throw new BffError(
                    String(problem.message || problem.title || '地图服务请求失败'),
                    response.status,
                    String(problem.code || 'BFF_REQUEST_FAILED'),
                    requestId
                );
            }
            if (accept === 'image/png') return response.blob();
            return response.json();
        }

        searchPlaces(input = {}, options = {}) {
            const payload = {
                provider: provider(input.provider),
                query: limitedText(input.query, 'query', 1, 200),
                limit: Math.min(20, Math.max(1, Math.trunc(Number(input.limit) || 10)))
            };
            if (input.language) payload.language = limitedText(input.language, 'language', 2, 16);
            if (input.region) payload.region = limitedText(input.region, 'region', 2, 32);
            if (input.locationBias) {
                payload.locationBias = {
                    ...point(input.locationBias),
                    radiusMeters: Math.min(50000, Math.max(1, Math.round(Number(input.locationBias.radiusMeters) || 10000)))
                };
            }
            return this.post('places/search', payload, 'application/json', false, options);
        }

        route(input = {}, options = {}) {
            return this.post('routes', {
                provider: provider(input.provider),
                origin: point(input.origin),
                destination: point(input.destination),
                travelMode: travelMode(input.travelMode)
            }, 'application/json', false, options);
        }

        routeMatrix(input = {}, options = {}) {
            const origins = Array.isArray(input.origins) ? input.origins.map(point) : [];
            const destinations = Array.isArray(input.destinations) ? input.destinations.map(point) : [];
            if (origins.length < 1 || origins.length > 10 || destinations.length < 1 || destinations.length > 10 || origins.length * destinations.length > 25) {
                throw new TypeError('matrix dimensions are invalid');
            }
            return this.post('route-matrix', {
                provider: provider(input.provider),
                origins,
                destinations,
                travelMode: travelMode(input.travelMode)
            }, 'application/json', false, options);
        }

        staticMap(input = {}) {
            const points = Array.isArray(input.points) ? input.points.map(point) : [];
            if (points.length < 1 || points.length > 50) throw new TypeError('points are invalid');
            return this.post('static-maps', {
                provider: provider(input.provider),
                points,
                width: Math.min(1280, Math.max(320, Math.trunc(Number(input.width) || 800))),
                height: Math.min(1280, Math.max(200, Math.trunc(Number(input.height) || 600))),
                drawPath: input.drawPath !== false
            }, 'image/png');
        }
    }

    return {
        PROVIDERS,
        BFF_BASE_PATH,
        BffClient,
        BffError,
        isSensitiveFieldName,
        stripSensitiveFields,
        safeSettings,
        sanitizePersistedRecord,
        persistedPlace,
        persistedRouteSegments,
        persistedScheme,
        persistedApplicationRecord,
        migrateLegacyStorage,
        containsSensitiveField
    };
});
