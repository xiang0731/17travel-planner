(function preloadSelectedMapProvider() {
    'use strict';

    const providerOrigins = {
        gaode: ['https://webapi.amap.com'],
        tianditu: ['https://api.tianditu.gov.cn'],
        google: ['https://maps.googleapis.com', 'https://maps.gstatic.com']
    };

    try {
        const saved = JSON.parse(localStorage.getItem('travelPlannerData') || '{}');
        const requestedProvider = saved && saved.settings && saved.settings.selectedMapApi;
        const provider = Object.prototype.hasOwnProperty.call(providerOrigins, requestedProvider)
            ? requestedProvider
            : 'gaode';

        providerOrigins[provider].forEach(origin => {
            const preconnect = document.createElement('link');
            preconnect.rel = 'preconnect';
            preconnect.href = origin;
            preconnect.crossOrigin = 'anonymous';
            document.head.appendChild(preconnect);

            const dnsPrefetch = document.createElement('link');
            dnsPrefetch.rel = 'dns-prefetch';
            dnsPrefetch.href = origin;
            document.head.appendChild(dnsPrefetch);
        });
    } catch (error) {
        // 损坏或恶意构造的本地设置不能影响页面启动。
    }
})();
