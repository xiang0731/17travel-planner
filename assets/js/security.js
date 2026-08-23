(function (root, factory) {
    'use strict';

    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (root && typeof root === 'object') {
        Object.defineProperty(root, 'TravelPlannerSecurity', {
            configurable: false,
            enumerable: true,
            writable: false,
            value: Object.freeze(api)
        });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SHARE_IMAGE_HTTPS_ORIGINS = Object.freeze([]);

    const MAP_PROVIDER_ORIGINS = Object.freeze({
        google: 'https://maps.googleapis.com',
        gaode: 'https://webapi.amap.com',
        tianditu: 'https://api.tianditu.gov.cn'
    });

    function stringValue(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    // HTML 文本节点上下文：引号没有语法意义，关键是先编码 &，阻止实体二次解码。
    function encodeHtmlText(value) {
        return stringValue(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // 双引号 HTML 属性上下文：额外编码两种引号和控制字符。
    function encodeHtmlAttribute(value) {
        return encodeHtmlText(value)
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/[\u0000-\u001F\u007F]/g, character => `&#${character.charCodeAt(0)};`);
    }

    function normalizeAllowedOrigins(allowedHttpsOrigins) {
        if (!Array.isArray(allowedHttpsOrigins)) return new Set();

        const origins = allowedHttpsOrigins
            .map(value => {
                try {
                    const url = new URL(stringValue(value));
                    return url.protocol === 'https:' ? url.origin : '';
                } catch (error) {
                    return '';
                }
            })
            .filter(Boolean);

        return new Set(origins);
    }

    function isPngDataUrl(value) {
        const url = stringValue(value).trim();
        return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(url);
    }

    // URL 上下文：仅返回严格 PNG data URL，或调用方明确列入 allowlist 的 HTTPS URL。
    function sanitizeUrl(value, options = {}) {
        const candidate = stringValue(value).trim();
        const allowDataImagePng = options.allowDataImagePng === true;

        if (allowDataImagePng && isPngDataUrl(candidate)) {
            return candidate;
        }

        let parsed;
        try {
            parsed = new URL(candidate);
        } catch (error) {
            return '';
        }

        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
            return '';
        }

        const allowedOrigins = normalizeAllowedOrigins(options.allowedHttpsOrigins);
        if (allowedOrigins.size === 0 || !allowedOrigins.has(parsed.origin)) {
            return '';
        }

        return parsed.href;
    }

    function encodeUrlAttribute(value, options = {}) {
        const safeUrl = sanitizeUrl(value, options);
        return safeUrl ? encodeHtmlAttribute(safeUrl) : '';
    }

    function buildHttpsUrl(origin, path, parameters = {}, allowedOrigins = []) {
        const safeOrigin = sanitizeUrl(origin, { allowedHttpsOrigins: allowedOrigins });
        if (!safeOrigin) return '';

        const url = new URL(path, safeOrigin);
        const allowed = normalizeAllowedOrigins(allowedOrigins);
        if (url.protocol !== 'https:' || !allowed.has(url.origin)) return '';

        Object.entries(parameters).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, stringValue(value));
            }
        });

        return url.href;
    }

    function finiteNumber(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function safeCount(value) {
        return Math.max(0, Math.trunc(finiteNumber(value, 0)));
    }

    function renderMarkerSvg(pending, number) {
        const color = pending ? '#f39c12' : '#e74c3c';
        const markerText = pending ? '⏳' : String(Math.max(1, Math.trunc(finiteNumber(number, 1))));
        const fontSize = pending ? '10' : '12';

        return `<svg width="40" height="50" viewBox="0 0 40 50" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><ellipse cx="20" cy="47" rx="8" ry="3" fill="rgba(0,0,0,0.3)"/><path d="M20 3C13.4 3 8 8.4 8 15C8 24.75 20 47 20 47C20 47 32 24.75 32 15C32 8.4 26.6 3 20 3Z" fill="${color}" stroke="#ffffff" stroke-width="2"/><circle cx="20" cy="15" r="6" fill="#ffffff"/><text x="20" y="19" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="${color}">${encodeHtmlText(markerText)}</text></svg>`;
    }

    // 地图 SDK 的唯一 HTML 字符串渲染入口。kind 和结构均为 allowlist，数据只进入文本节点。
    function renderMapSdkHtml(kind, data = {}) {
        switch (kind) {
            case 'active-marker':
                return `<div class="map-sdk-marker map-sdk-marker--active">${renderMarkerSvg(false, data.number)}</div>`;
            case 'pending-marker':
                return `<div class="map-sdk-marker map-sdk-marker--pending">${renderMarkerSvg(true, 1)}</div>`;
            case 'active-label': {
                const number = Math.max(1, Math.trunc(finiteNumber(data.number, 1)));
                return `<div class="map-sdk-label map-sdk-label--active"><span class="map-sdk-label__number">${number}.</span><span>${encodeHtmlText(data.text)}</span></div>`;
            }
            case 'pending-label':
                return `<div class="map-sdk-label map-sdk-label--pending">⏳ ${encodeHtmlText(data.text)}</div>`;
            case 'current-location':
                return '<div class="map-sdk-current-location"><span aria-hidden="true"></span></div>';
            default:
                throw new TypeError(`Unsupported map HTML kind: ${stringValue(kind)}`);
        }
    }

    function renderMapMarkerSvg(options = {}) {
        return renderMarkerSvg(options.pending === true, options.number);
    }

    function renderLocationMarkerSvg(variant = 'compact') {
        if (variant === 'compact') {
            return '<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="#27ae60" stroke="white" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="white"/></svg>';
        }
        if (variant === 'pulse') {
            return '<svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><ellipse cx="20" cy="35" rx="12" ry="4" fill="rgba(0,0,0,0.2)"/><circle cx="20" cy="20" r="14" fill="rgba(52,152,219,0.2)"><animate attributeName="r" values="12;20;12" dur="2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.8;0;0.8" dur="2s" repeatCount="indefinite"/></circle><circle cx="20" cy="20" r="10" fill="#ffffff"/><circle cx="20" cy="20" r="7" fill="#3498db"/></svg>';
        }
        throw new TypeError(`Unsupported location marker variant: ${stringValue(variant)}`);
    }

    function normalizeSharePlaces(places) {
        if (!Array.isArray(places)) return [];
        return places.map(place => ({
            name: stringValue(place && place.name),
            address: stringValue(place && place.address)
        }));
    }

    function buildShareHtml(model = {}) {
        const places = normalizeSharePlaces(model.places);
        const currentDate = stringValue(model.currentDate);
        const currentFilter = stringValue(model.currentFilter);
        const isFiltered = currentFilter && currentFilter !== 'all';
        const mapTitle = isFiltered ? `🗺️ ${currentFilter} - 路线地图` : '🗺️ 完整路线地图';
        const mapDescription = isFiltered ? `显示 ${currentFilter} 地区的游玩点和路线` : '显示所有游玩点和完整路线';
        const safeMapUrl = sanitizeUrl(model.mapScreenshot, {
            allowDataImagePng: true
        });
        const csp = "default-src 'none'; script-src 'none'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none'; font-src 'none'; media-src 'none'";

        const mapSection = safeMapUrl
            ? `<div class="map-section"><h2>${encodeHtmlText(mapTitle)}</h2><p class="map-description">${encodeHtmlText(mapDescription)}</p><div class="map-container"><img src="${encodeHtmlAttribute(safeMapUrl)}" alt="旅游路线地图" class="map-image"></div><p class="map-note">📍 高清地图截图 | 🔴 红色标记：游玩点 | 🌈 多彩路线：每段使用不同颜色便于区分</p></div>`
            : `<div class="map-section"><h2>${encodeHtmlText(mapTitle)}</h2><p class="map-description">${encodeHtmlText(mapDescription)}</p><div class="map-placeholder"><div class="placeholder-icon">🗺️</div><p>地图截图生成失败</p><p>请在原网页中查看完整地图</p></div></div>`;

        const placesHtml = places.map((place, index) => `<div class="place-item"><div class="place-number">${index + 1}</div><div class="place-info"><h3>${encodeHtmlText(place.name)}</h3><div class="place-address">${encodeHtmlText(place.address)}</div></div></div>`).join('');

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${encodeHtmlAttribute(csp)}">
    <meta name="referrer" content="no-referrer">
    <title>我的旅游计划 - ${encodeHtmlText(currentDate)}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; background: #f8f9fa; min-height: 100vh; }
        .container { width: 100%; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 15px; text-align: center; margin-bottom: 30px; }
        .header h1 { font-size: 2.5rem; margin-bottom: 10px; }
        .header p { font-size: 1.1rem; opacity: 0.9; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: white; padding: 20px; border-radius: 10px; text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
        .stat-number { font-size: 2rem; font-weight: bold; color: #667eea; }
        .stat-label { color: #666; margin-top: 5px; }
        .map-section, .places-list { background: white; border-radius: 15px; padding: 30px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); margin-bottom: 30px; }
        .map-section h2, .places-list h2 { color: #2c3e50; margin-bottom: 15px; }
        .map-description { color: #7f8c8d; font-size: 0.95rem; margin-bottom: 20px; font-style: italic; text-align: center; }
        .map-note { color: #95a5a6; font-size: 0.85rem; margin-top: 15px; text-align: center; line-height: 1.4; }
        .map-container { border-radius: 15px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.1); background: #f8f9fa; }
        .map-image { width: 100%; height: auto; display: block; min-height: 500px; max-height: 800px; object-fit: contain; border: 2px solid #e1e5e9; border-radius: 10px; }
        .map-placeholder { background: linear-gradient(135deg, #f8f9ff 0%, #f0f2ff 100%); border: 2px dashed #667eea; border-radius: 10px; padding: 60px; text-align: center; color: #7f8c8d; min-height: 400px; display: flex; flex-direction: column; justify-content: center; align-items: center; }
        .placeholder-icon { font-size: 4rem; margin-bottom: 20px; }
        .place-item { display: flex; align-items: center; padding: 20px 0; border-bottom: 1px solid #eee; }
        .place-item:last-child { border-bottom: none; }
        .place-number { background: #667eea; color: white; width: 35px; height: 35px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; margin-right: 20px; flex-shrink: 0; font-size: 1.1rem; }
        .place-info h3 { color: #2c3e50; margin-bottom: 8px; font-size: 1.2rem; }
        .place-address { color: #7f8c8d; font-size: 1rem; line-height: 1.4; }
        .footer { text-align: center; margin-top: 40px; padding: 30px; color: #666; font-size: 1rem; }
        @media (max-width: 768px) { .container { padding: 15px; } .header { padding: 20px; } .header h1 { font-size: 2rem; } .map-section, .places-list { padding: 20px; } .place-info h3 { font-size: 1.1rem; } }
        @media print { body { background: white; } .container { padding: 0; } .map-image { max-height: none; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header"><h1>🗺️ 我的旅游计划</h1><p>生成时间：${encodeHtmlText(currentDate)}</p></div>
        <div class="stats">
            <div class="stat-card"><div class="stat-number">${places.length}</div><div class="stat-label">游玩地点</div></div>
            <div class="stat-card"><div class="stat-number">${safeCount(model.cityCount)}</div><div class="stat-label">涉及城市</div></div>
            <div class="stat-card"><div class="stat-number">${finiteNumber(model.totalDistance, 0).toFixed(1)}</div><div class="stat-label">总距离 (公里)</div></div>
            <div class="stat-card"><div class="stat-number">${finiteNumber(model.totalTime, 0).toFixed(1)}</div><div class="stat-label">预计时间 (小时)</div></div>
        </div>
        ${mapSection}
        <div class="places-list"><h2>📝 详细行程</h2>${placesHtml}</div>
        <div class="footer"><p>✨ 使用旅游规划助手生成 | 祝您旅途愉快！</p><p>📅 ${encodeHtmlText(currentDate)} | 🌟 包含多彩路线标识，每段路线使用不同颜色便于区分</p></div>
    </div>
</body>
</html>`;
    }

    return {
        SHARE_IMAGE_HTTPS_ORIGINS,
        MAP_PROVIDER_ORIGINS,
        encodeHtmlText,
        encodeHtmlAttribute,
        sanitizeUrl,
        encodeUrlAttribute,
        buildHttpsUrl,
        isPngDataUrl,
        renderMapSdkHtml,
        renderMapMarkerSvg,
        renderLocationMarkerSvg,
        buildShareHtml
    };
});
