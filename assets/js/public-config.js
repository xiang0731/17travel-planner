(function configureTravelPlanner(root) {
    'use strict';

    // These are browser-visible JavaScript SDK keys only. Production keys must be
    // restricted by HTTP Referrer and limited to the provider's map-rendering SDK.
    // Web Service keys belong exclusively in the PHP BFF environment/Secret Manager.
    const existing = root.TRAVEL_PLANNER_PUBLIC_CONFIG || {};
    const search = existing.search && typeof existing.search === 'object' ? existing.search : {};
    const unconfiguredBehavior = search.unconfiguredBehavior === 'demo'
        ? 'demo'
        : 'configuration-required';
    root.TRAVEL_PLANNER_PUBLIC_CONFIG = Object.freeze({
        sdkPublicKeys: Object.freeze({
            gaode: String(existing.sdkPublicKeys?.gaode || ''),
            google: String(existing.sdkPublicKeys?.google || ''),
            tianditu: String(existing.sdkPublicKeys?.tianditu || ''),
            azure: String(existing.sdkPublicKeys?.azure || '')
        }),
        allowAdvancedByok: existing.allowAdvancedByok === true,
        search: Object.freeze({
            // Deployments may choose "demo" to show the clearly labelled sample
            // catalogue when the selected Web Service provider has no server key.
            unconfiguredBehavior,
            language: String(search.language || document.documentElement.lang || navigator.language || 'zh-CN').slice(0, 16),
            region: String(search.region || 'CN').toUpperCase().slice(0, 2),
            locationBiasRadiusMeters: Math.min(50000, Math.max(100, Number(search.locationBiasRadiusMeters) || 10000))
        })
    });
})(window);
