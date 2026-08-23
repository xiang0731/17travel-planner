// 旅游规划助手 - Google Maps版本

const Security = window.TravelPlannerSecurity;
if (!Security) {
    throw new Error('安全模块未加载，已中止应用初始化');
}
const ClientSecurity = window.TravelPlannerClientSecurity;
if (!ClientSecurity) {
    throw new Error('客户端安全边界未加载，已中止应用初始化');
}
const PlannerData = window.TravelPlannerData;
if (!PlannerData) {
    throw new Error('数据完整性模块未加载，已中止应用初始化');
}
const Search = window.TravelPlannerSearch;
if (!Search) {
    throw new Error('搜索状态模块未加载，已中止应用初始化');
}
const RouteOptimizer = window.TravelPlannerRouteOptimizer;
if (!RouteOptimizer) {
    throw new Error('路线优化模块未加载，已中止应用初始化');
}
const PerformanceCore = window.TravelPlannerPerformance;
const PublicConfig = window.TRAVEL_PLANNER_PUBLIC_CONFIG || { sdkPublicKeys: {}, allowAdvancedByok: false };

const DEMO_SEARCH_PLACES = Object.freeze([
    Object.freeze({ id: 'demo-forbidden-city', name: '故宫博物院', address: '北京市东城区景山前街4号', lat: 39.916345, lng: 116.397155 }),
    Object.freeze({ id: 'demo-bund', name: '外滩', address: '上海市黄浦区中山东一路', lat: 31.240018, lng: 121.490048 }),
    Object.freeze({ id: 'demo-west-lake', name: '杭州西湖风景名胜区', address: '浙江省杭州市西湖区龙井路1号', lat: 30.243108, lng: 120.150722 }),
    Object.freeze({ id: 'demo-canton-tower', name: '广州塔', address: '广东省广州市海珠区阅江西路222号', lat: 23.105818, lng: 113.324553 }),
    Object.freeze({ id: 'demo-kuanzhai', name: '宽窄巷子', address: '四川省成都市青羊区长顺上街127号', lat: 30.669452, lng: 104.055514 })
]);

// 全局变量存储PlaceLabel类，在Google Maps API加载后定义
let PlaceLabel = null;

function renderGooglePlaceLabel(element, value) {
    const text = String(value ?? '');
    const separatorIndex = text.indexOf('. ');
    element.replaceChildren();

    if (separatorIndex > 0 && /^\d+$/.test(text.slice(0, separatorIndex))) {
        const number = document.createElement('span');
        number.className = 'google-map-label-number';
        number.textContent = `${text.slice(0, separatorIndex)}.`;
        const name = document.createElement('span');
        name.textContent = text.slice(separatorIndex + 2);
        element.append(number, name);
    } else {
        element.textContent = text;
    }
}

class DialogManager {
    constructor(ownerDocument = document) {
        this.document = ownerDocument;
        this.stack = [];
        this.originalInert = new Map();
        this.focusableSelector = [
            'a[href]',
            'button:not([disabled])',
            'input:not([disabled])',
            'select:not([disabled])',
            'textarea:not([disabled])',
            'summary',
            '[tabindex]:not([tabindex="-1"])'
        ].join(',');
        this.document.addEventListener('keydown', event => this.handleKeydown(event), true);
        this.document.addEventListener('click', event => {
            const active = this.activeState();
            if (active && event.target === active.dialog) this.requestClose(active);
        });
    }

    resolve(dialogOrId) {
        return typeof dialogOrId === 'string'
            ? this.document.getElementById(dialogOrId)
            : dialogOrId;
    }

    activeState() {
        return this.stack[this.stack.length - 1] || null;
    }

    open(dialogOrId, options = {}) {
        const dialog = this.resolve(dialogOrId);
        if (!dialog) throw new Error(`Dialog not found: ${String(dialogOrId)}`);
        const existing = this.stack.find(state => state.dialog === dialog);
        if (existing) return existing;

        const trigger = options.trigger instanceof HTMLElement
            ? options.trigger
            : (this.document.activeElement instanceof HTMLElement ? this.document.activeElement : null);
        const state = {
            dialog,
            trigger,
            initialFocus: options.initialFocus || null,
            onRequestClose: options.onRequestClose || null
        };
        this.stack.push(state);
        dialog.hidden = false;
        dialog.classList.add('is-open');
        dialog.removeAttribute('aria-hidden');
        this.document.body.classList.add('dialog-open');
        this.updateIsolation();
        this.focusInitial(state);
        return state;
    }

    close(dialogOrId) {
        const dialog = this.resolve(dialogOrId);
        const stateIndex = this.stack.findIndex(state => state.dialog === dialog);
        if (stateIndex < 0) return false;

        const [state] = this.stack.splice(stateIndex, 1);
        state.dialog.classList.remove('is-open');
        state.dialog.hidden = true;
        state.dialog.inert = false;
        state.dialog.removeAttribute('aria-hidden');

        const active = this.activeState();
        if (active) {
            this.updateIsolation();
            const returnTarget = state.trigger && active.dialog.contains(state.trigger)
                ? state.trigger
                : null;
            (returnTarget || this.firstFocusable(active.dialog) || active.dialog).focus({ preventScroll: true });
        } else {
            this.restoreIsolation();
            this.document.body.classList.remove('dialog-open');
            if (state.trigger?.isConnected && !state.trigger.closest('[inert]')) {
                state.trigger.focus({ preventScroll: true });
            }
        }
        return true;
    }

    requestClose(state = this.activeState()) {
        if (!state) return;
        if (typeof state.onRequestClose === 'function') state.onRequestClose();
        else this.close(state.dialog);
    }

    focusInitial(state) {
        let target = state.initialFocus;
        if (typeof target === 'string') target = state.dialog.querySelector(target);
        if (!(target instanceof HTMLElement) || target.hidden || target.matches(':disabled')) {
            target = this.firstFocusable(state.dialog) || state.dialog;
        }
        if (target === state.dialog && !target.hasAttribute('tabindex')) target.tabIndex = -1;
        target.focus({ preventScroll: true });
    }

    focusableElements(dialog) {
        return Array.from(dialog.querySelectorAll(this.focusableSelector)).filter(element => {
            if (!(element instanceof HTMLElement)) return false;
            if (element.hidden || element.closest('[hidden], [inert]')) return false;
            return element.getClientRects().length > 0;
        });
    }

    firstFocusable(dialog) {
        return this.focusableElements(dialog)[0] || null;
    }

    handleKeydown(event) {
        const active = this.activeState();
        if (!active) return;

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.requestClose(active);
            return;
        }
        if (event.key !== 'Tab') return;

        const focusable = this.focusableElements(active.dialog);
        if (focusable.length === 0) {
            event.preventDefault();
            active.dialog.focus({ preventScroll: true });
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const current = this.document.activeElement;
        if (!active.dialog.contains(current)) {
            event.preventDefault();
            first.focus({ preventScroll: true });
        } else if (event.shiftKey && current === first) {
            event.preventDefault();
            last.focus({ preventScroll: true });
        } else if (!event.shiftKey && current === last) {
            event.preventDefault();
            first.focus({ preventScroll: true });
        }
    }

    updateIsolation() {
        const active = this.activeState();
        if (!active) return;
        Array.from(this.document.body.children).forEach(element => {
            const exempt = element === active.dialog || element.matches('script, [data-live-region], .toast');
            if (!this.originalInert.has(element)) this.originalInert.set(element, element.inert === true);
            element.inert = !exempt;
        });
        this.stack.forEach(state => {
            const isActive = state === active;
            state.dialog.inert = !isActive;
            if (isActive) state.dialog.removeAttribute('aria-hidden');
            else state.dialog.setAttribute('aria-hidden', 'true');
        });
    }

    restoreIsolation() {
        this.originalInert.forEach((wasInert, element) => {
            if (element.isConnected) element.inert = wasInert;
        });
        this.originalInert.clear();
    }
}

class TravelPlanner {
    constructor() {
        this.map = null;
        this.markers = [];
        this.travelList = [];
        this.currentLocation = null;
        this.polyline = null;
        this.polylines = []; // 用于存储多彩路线段
        this.isMapLoaded = false;
        this.directionsRenderer = null;
        this.bff = new ClientSecurity.BffClient({ timeoutMs: 8000 });
        if (!PerformanceCore) throw new Error('性能管线模块未加载，已中止应用初始化');

        this.taskGenerations = new PerformanceCore.GenerationRegistry();
        this.routeResultCache = new Map();
        this.routeRequestCoordinator = new PerformanceCore.RequestCoordinator({
            cache: this.routeResultCache,
            cacheTtlMs: 10 * 60 * 1000,
            maxConcurrency: 4,
            maxRetries: 2,
            baseDelayMs: 150
        });
        this.routeResultProvider = new PerformanceCore.RouteResultProvider({
            coordinator: this.routeRequestCoordinator,
            coordinatePrecision: PerformanceCore.ROUTE_COORDINATE_PRECISION,
            algorithmVersion: PerformanceCore.ROUTE_ALGORITHM_VERSION,
            fetchRoute: (request, options) => this.fetchProviderRouteResult(request, options)
        });
        this.routeResults = new Map();
        this.routeResultSignature = '';
        this.routeCalculationPromise = null;
        this.routePipelineTimer = null;
        this.stateRevision = 0;
        this.renderCommitCount = 0;
        this.performanceMetrics = {
            stateCommits: 0,
            renderCommits: 0,
            asyncStateCommits: 0,
            businessRenderCommits: 0,
            asyncRenderCommits: 0,
            listNodesCreated: 0,
            listNodesReused: 0,
            markerCreates: 0,
            markerUpdates: 0,
            markerDeletes: 0,
            labelCollisionComparisons: 0
        };

        // 防抖函数辅助
        this.debounce = (fn, delay) => {
            let timer = null;
            return function (...args) {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => fn.apply(this, args), delay);
            };
        };

        // API调用缓存和优化机制
        // 距离和路线共享同一份 Provider RouteResult 缓存。
        this.distanceCache = this.routeResultCache;
        this.routeCache = this.routeResultCache;
        this.routeMetrics = new Map(); // 路段业务状态只保存米和秒，不从 DOM 文案反向解析
        this.totalMetrics = PlannerData.createRouteMetrics(0, 0);
        this.totalMetricSource = 'unavailable';
        this.searchCache = new Map(); // 搜索结果缓存：key: keyword, value: {results, timestamp}
        this.currentSearchResults = []; // 搜索结果只通过索引关联，不把不可信字段塞进属性
        this.cacheTimeout = 10 * 60 * 1000; // 缓存10分钟
        this.lastTravelListHash = ''; // 用于检测列表变化的哈希值
        this.calculateDistancesTimeout = null; // 距离计算防抖定时器
        this.isCalculatingDistances = false; // 防止重复计算距离的标志

        // 路线配置：为每个路线段存储交通方式和地图提供商
        this.routeSegments = new Map(); // key: "fromId-toId", value: { travelMode: "DRIVING", mapProvider: "baidu" }
        this.routePlanOptions = { roundTrip: false, travelMode: 'DRIVING' };
        this.pendingOptimization = null;
        this.optimizationSnapshot = null;

        // 城市过滤功能
        this.currentCityFilter = 'all'; // 'all' 或具体城市名
        this.cityFilterBtn = null;

        // UI控制按钮
        this.returnToOverviewBtn = null;

        // 地点名称显示控制
        this.showPlaceNames = true; // 默认显示名称
        this.placeLabels = []; // 存储自定义标签覆盖层

        // 待定点显示控制
        this.showPendingPlaces = false; // 默认不显示待定点
        this.pendingMarkers = []; // 存储待定点标记

        // 地图类型状态管理
        this.isSatelliteMode = false; // 跟踪当前是否为卫星图模式

        // 应用设置 - 默认设置
        this.settings = {
            navigationApp: 'amap', // 默认使用高德地图
            selectedMapApi: 'gaode', // 默认使用高德地图作为地图显示API
            advancedByokEnabled: false,
            preferences: {
                openInNewTab: true, // 在新标签页中打开导航
                showNavigationHint: true, // 显示导航操作提示
                showShowInMapButton: true, // 显示"在导航中显示"按钮
                showNavigateToButton: true // 显示"导航至此处"按钮
            }
        };
        this.searchController = new Search.SearchController({
            search: (context, options) => this.fetchSearchResults(context, options),
            demoSearch: context => this.getDemoSearchResults(context),
            onStateChange: state => this.renderSearchState(state),
            unconfiguredBehavior: PublicConfig.search?.unconfiguredBehavior,
            debounceMs: 500,
            cacheTtlMs: this.cacheTimeout,
            cache: this.searchCache,
            maxRetries: 2,
            retryBaseDelayMs: 150
        });

        // 标记状态管理
        this.markersCleared = false;
        this.savedMarkers = []; // 保存被清除的标记信息

        // 当前方案管理
        this.currentSchemeId = null;
        this.currentSchemeName = null;
        this.hasUnsavedChanges = false; // 跟踪是否有未保存的更改
        this.isAutoSaving = false; // 防止自动保存时的递归调用

        // 避让算法优化相关属性
        this.labelCandidates = null; // 缓存候选偏移位置
        this.adjustLabelsRafId = null; // 用于 requestAnimationFrame 的节流
        this.labelSizeCache = new Map(); // 缓存标签尺寸，减少 DOM 读取

        // 导入冲突处理状态
        this.pendingImportData = null;
        this.pendingConflicts = [];
        this.conflictResolutions = new Map(); // 存储冲突解决方案

        // ID生成计数器，确保唯一性
        this.idCounter = 0;
        this.eventsBound = false;
        this.dialogManager = new DialogManager(document);

        // 任何读取前先恢复未完成的导入事务，再执行安全清理和版本迁移。
        this.recoveredImportTransaction = PlannerData.recoverPendingTransaction(localStorage);
        this.storageMigration = ClientSecurity.migrateLegacyStorage(localStorage);
        try {
            this.dataMigration = PlannerData.migrateStoredData(localStorage);
        } catch (error) {
            this.dataMigrationError = error;
            console.error('本地数据显式迁移失败:', error);
        }

        // 首先加载已保存的设置，然后再初始化应用
        this.initializeApp();
    }

    createElement(tagName, options = {}) {
        const element = document.createElement(tagName);
        if (options.className) element.className = options.className;
        if (options.text !== undefined) element.textContent = String(options.text);
        if (options.title !== undefined) element.title = String(options.title);
        if (options.type) element.type = options.type;
        if (options.id) element.id = options.id;
        if (options.disabled !== undefined) element.disabled = Boolean(options.disabled);
        if (options.attributes) {
            Object.entries(options.attributes).forEach(([name, value]) => {
                if (value !== undefined && value !== null) element.setAttribute(name, String(value));
            });
        }

        if (options.dataset) {
            Object.entries(options.dataset).forEach(([key, value]) => {
                element.dataset[key] = String(value);
            });
        }

        return element;
    }

    replaceWithMessage(container, message, className = '') {
        const messageElement = this.createElement('div', { className, text: message });
        container.replaceChildren(messageElement);
        return messageElement;
    }

    appendLabeledText(container, label, value) {
        const paragraph = this.createElement('p');
        const strong = this.createElement('strong', { text: label });
        paragraph.append(strong, document.createTextNode(` ${String(value ?? '')}`));
        container.appendChild(paragraph);
        return paragraph;
    }

    getUsablePlaces(places = this.travelList) {
        return PlannerData.getUsablePlaces(places);
    }

    getPlaceById(placeId) {
        return this.travelList.find(place => String(place.id) === String(placeId));
    }

    getSchemeById(schemes, schemeId) {
        return schemes.find(scheme => String(scheme.id) === String(schemeId));
    }

    hasCurrentSchemeBinding() {
        return this.currentSchemeId !== null &&
            this.currentSchemeId !== undefined &&
            this.currentSchemeId !== '';
    }

    getCurrentScheme(schemes) {
        if (!Array.isArray(schemes)) return null;

        if (this.hasCurrentSchemeBinding()) {
            const schemeById = this.getSchemeById(schemes, this.currentSchemeId);
            if (schemeById) return schemeById;
        }

        // 旧数据或导入后的 ID 可能已重映射；名称仍唯一时可恢复当前方案关联。
        const currentName = String(this.currentSchemeName ?? '');
        if (!currentName) return null;
        const schemesByName = schemes.filter(scheme => String(scheme.name) === currentName);
        return schemesByName.length === 1 ? schemesByName[0] : null;
    }

    // 唯一业务写入口：action 先生成下一状态，再执行一次同步 render commit。
    dispatch(action = {}) {
        if (!action || typeof action.type !== 'string') throw new TypeError('action.type is required');
        const transition = this.reduceAction(action);
        if (!transition.changed) return { changed: false, revision: this.stateRevision };

        this.stateRevision = (this.stateRevision || 0) + 1;
        if (this.performanceMetrics) {
            if (action.type === 'ROUTE_RESULTS_RESOLVED') this.performanceMetrics.asyncStateCommits += 1;
            else this.performanceMetrics.stateCommits += 1;
        }
        this.commitState(action, transition.effects || {});
        return { changed: true, revision: this.stateRevision };
    }

    reduceAction(action) {
        const effects = {
            renderList: true,
            syncMarkers: true,
            routeChanged: true,
            persist: action.persist !== false,
            markModified: action.markModified !== false
        };
        const places = Array.isArray(this.travelList) ? this.travelList : [];

        switch (action.type) {
            case 'ADD_PLACE': {
                if (!action.place || action.place.id === undefined || action.place.id === null) return { changed: false };
                if (places.some(place => String(place.id) === String(action.place.id))) return { changed: false };
                this.travelList = places.concat({ ...action.place });
                return { changed: true, effects };
            }
            case 'ADD_BLANK_PLACE': {
                if (!action.place || action.place.id === undefined || action.place.id === null) return { changed: false };
                this.travelList = [{ ...action.place }, ...places];
                effects.routeChanged = false;
                return { changed: true, effects };
            }
            case 'EDIT_PLACE': {
                const index = places.findIndex(place => String(place.id) === String(action.id));
                if (index < 0) return { changed: false };
                const nextPlace = { ...places[index] };
                const result = PlannerData.applyPlaceEdit(nextPlace, action.customName, action.notes);
                this.travelList = places.map((place, placeIndex) => placeIndex === index ? nextPlace : place);
                effects.routeChanged = false;
                effects.displayName = result.displayName;
                return { changed: true, effects };
            }
            case 'TOGGLE_PLACE_STATUS': {
                const index = places.findIndex(place => String(place.id) === String(action.id));
                if (index < 0) return { changed: false };
                const toggled = { ...places[index], isPending: !places[index].isPending };
                const remaining = places.filter((_, placeIndex) => placeIndex !== index);
                if (toggled.isPending) {
                    this.travelList = remaining.concat(toggled);
                } else {
                    const lastActive = remaining.reduce((result, place, placeIndex) => place.isPending ? result : placeIndex + 1, 0);
                    this.travelList = remaining.slice(0, lastActive).concat(toggled, remaining.slice(lastActive));
                }
                effects.toggledPlace = toggled;
                return { changed: true, effects };
            }
            case 'REORDER_PLACES': {
                const from = places.findIndex(place => String(place.id) === String(action.draggedId));
                const to = places.findIndex(place => String(place.id) === String(action.targetId));
                if (from < 0 || to < 0 || from === to) return { changed: false };
                const next = places.slice();
                const [moved] = next.splice(from, 1);
                next.splice(to, 0, moved);
                this.travelList = next;
                effects.routeChanged = !moved.isBlank;
                return { changed: true, effects };
            }
            case 'REMOVE_PLACE': {
                const next = places.filter(place => String(place.id) !== String(action.id));
                if (next.length === places.length) return { changed: false };
                this.travelList = next;
                return { changed: true, effects };
            }
            case 'REPLACE_PLAN': {
                this.travelList = Array.isArray(action.travelList) ? action.travelList.map(place => ({ ...place })) : [];
                this.routeSegments = new Map(Array.isArray(action.routeSegments) ? action.routeSegments : []);
                if (action.currentSchemeId !== undefined) this.currentSchemeId = action.currentSchemeId;
                if (action.currentSchemeName !== undefined) this.currentSchemeName = action.currentSchemeName;
                if (action.hasUnsavedChanges !== undefined) this.hasUnsavedChanges = action.hasUnsavedChanges === true;
                effects.markModified = action.markModified === true;
                effects.persist = action.persist !== false;
                return { changed: true, effects };
            }
            case 'APPLY_ROUTE_ORDER': {
                if (!Array.isArray(action.travelList)) return { changed: false };
                this.travelList = action.travelList.map(place => ({ ...place }));
                if (action.routeSegments) this.routeSegments = new Map(action.routeSegments);
                if (action.routePlanOptions) this.routePlanOptions = { ...action.routePlanOptions };
                return { changed: true, effects };
            }
            case 'SET_ROUTE_OPTIONS': {
                const nextOptions = { ...this.routePlanOptions, ...(action.options || {}) };
                if (JSON.stringify(nextOptions) === JSON.stringify(this.routePlanOptions)) return { changed: false };
                this.routePlanOptions = nextOptions;
                effects.renderList = false;
                effects.syncMarkers = false;
                return { changed: true, effects };
            }
            case 'UPDATE_ROUTE_SEGMENT': {
                const key = String(action.segmentKey || '');
                if (!key) return { changed: false };
                const previous = this.routeSegments.get(key) || { mapProvider: 'amap' };
                const next = { ...previous, ...(action.config || {}) };
                if (JSON.stringify(previous) === JSON.stringify(next)) return { changed: false };
                this.routeSegments = new Map(this.routeSegments);
                this.routeSegments.set(key, next);
                effects.renderList = false;
                effects.syncMarkers = false;
                effects.routeChanged = false;
                return { changed: true, effects };
            }
            case 'SET_SCHEME_BINDING': {
                const nextId = action.currentSchemeId ?? null;
                const nextName = action.currentSchemeName ?? null;
                const nextUnsaved = action.hasUnsavedChanges === true;
                if (String(this.currentSchemeId ?? '') === String(nextId ?? '') &&
                    String(this.currentSchemeName ?? '') === String(nextName ?? '') &&
                    this.hasUnsavedChanges === nextUnsaved) return { changed: false };
                this.currentSchemeId = nextId;
                this.currentSchemeName = nextName;
                this.hasUnsavedChanges = nextUnsaved;
                effects.renderList = false;
                effects.syncMarkers = false;
                effects.routeChanged = false;
                effects.markModified = false;
                return { changed: true, effects };
            }
            case 'ROUTE_RESULTS_RESOLVED': {
                if (!action.tokens || !this.areRouteTokensCurrent(action.tokens)) return { changed: false };
                this.routeResults = new Map(action.results || []);
                this.routeMetrics = new Map(action.metrics || []);
                this.totalMetrics = action.totalMetrics;
                this.totalMetricSource = action.source;
                this.routeResultSignature = action.signature;
                effects.syncMarkers = false;
                effects.routeChanged = false;
                effects.persist = false;
                effects.markModified = false;
                effects.renderResolvedRoute = true;
                return { changed: true, effects };
            }
            default:
                throw new TypeError(`Unknown action: ${action.type}`);
        }
    }

    commitState(action, effects) {
        this.renderCommitCount = (this.renderCommitCount || 0) + 1;
        if (this.performanceMetrics) {
            this.performanceMetrics.renderCommits += 1;
            if (action.type === 'ROUTE_RESULTS_RESOLVED') this.performanceMetrics.asyncRenderCommits += 1;
            else this.performanceMetrics.businessRenderCommits += 1;
        }

        // 旧的无构造器嵌入测试没有运行时依赖，只保留最小兼容路径。
        if (!this.taskGenerations) {
            if (effects.markModified) this.markAsModified?.();
            if (effects.renderList) this.updateTravelList?.();
            if (effects.syncMarkers) this.recreateMarkers?.();
            if (effects.routeChanged) {
                this.calculateDistancesWithDebounce?.();
                this.drawRoute?.();
            }
            if (effects.persist) this.saveData?.();
            return;
        }

        if (effects.markModified) this.markAsModified();
        if (effects.renderList) this.renderTravelListsIncremental();
        if (effects.syncMarkers) this.syncMarkersIncremental();
        this.updateCityFilterButton();

        if (effects.renderResolvedRoute) {
            this.renderDistanceState();
            this.renderRouteResults(Array.from(this.routeResults.values()));
        } else if (effects.routeChanged) {
            this.scheduleRoutePipeline();
        }
        if (effects.persist) this.saveData();
    }

    normalizeStoredSettings(candidate) {
        return ClientSecurity.safeSettings(candidate);
    }

    getSafeSettings() {
        return ClientSecurity.safeSettings(this.settings);
    }

    normalizeUntrustedText(value, maxLength = 1000) {
        return String(value ?? '').slice(0, maxLength);
    }

    // 生成基于名称和时间的UUID
    generateSchemeUUID(schemeName, createdAt) {
        // 清理方案名称，移除特殊字符，保留中英文和数字
        const cleanName = schemeName.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
        // 格式化时间为 YYYYMMDD_HHMMSS
        const date = new Date(createdAt);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        const timeStr = `${year}${month}${day}_${hours}${minutes}${seconds}`;
        // 组合成UUID：名称_时间
        return `${cleanName}_${timeStr}`;
    }

    // 为了向后兼容，保留原始UUID生成方法（用于现有数据升级）
    generateRandomUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // 生成唯一的方案ID
    generateUniqueSchemeId() {
        // 使用当前时间戳 + 随机数 + 计数器确保唯一性
        const timestamp = Date.now();
        const random = Math.floor(Math.random() * 1000000);
        const counter = (this.idCounter || 0) + 1;
        this.idCounter = counter;
        return timestamp * 1000 + random + counter;
    }

    // 标记方案为已修改并触发自动保存
    markAsModified() {
        if (this.isAutoSaving) return; // 防止递归调用

        this.hasUnsavedChanges = true;
        this.updatePageTitle(); // 更新页面标题
        this.announceSaveStatus('方案有未保存的更改');

        // 使用防抖处理自动保存，避免频繁写入
        if (!this.debouncedAutoSave) {
            this.debouncedAutoSave = this.debounce(() => {
                if (this.hasCurrentSchemeBinding()) {
                    this.autoSaveCurrentScheme();
                }
            }, 1000);
        }
        this.debouncedAutoSave();
    }

    // 自动保存到当前方案
    autoSaveCurrentScheme() {
        if (!this.hasCurrentSchemeBinding() || this.isAutoSaving) {
            return;
        }

        this.isAutoSaving = true;

        try {
            const schemes = this.getSavedSchemes();
            const currentScheme = this.getCurrentScheme(schemes);

            if (currentScheme) {
                const bindingChanged = String(this.currentSchemeId) !== String(currentScheme.id) ||
                    this.currentSchemeName !== currentScheme.name;
                this.currentSchemeId = currentScheme.id;
                this.currentSchemeName = currentScheme.name;

                // 更新方案数据
                currentScheme.travelList = [...this.travelList];
                currentScheme.routeSegments = Array.from(this.routeSegments.entries());
                currentScheme.placesCount = this.getUsablePlaces().length;
                currentScheme.modifiedAt = new Date().toISOString();
                currentScheme.version = PlannerData.BACKUP_VERSION;
                currentScheme.schemaVersion = PlannerData.SCHEMA_VERSION;

                // 保存更新后的方案列表
                localStorage.setItem('travelSchemes', JSON.stringify(ClientSecurity.sanitizePersistedRecord(schemes)));

                // 标记为已保存
                this.hasUnsavedChanges = false;
                if (bindingChanged) this.saveData();
                this.updatePageTitle(); // 更新页面标题
                this.announceSaveStatus(`方案“${this.currentSchemeName}”已自动保存`);

                console.log('方案自动保存成功');
            }
        } catch (error) {
            console.error('自动保存失败:', error);
            this.showToast('自动保存失败，请重试', 'assertive');
        } finally {
            this.isAutoSaving = false;
        }
    }

    // 设置页面关闭时的处理
    setupPageUnloadHandler() {
        window.addEventListener('beforeunload', (e) => {
            // 只有在有未保存更改且没有当前方案时才提醒
            if (this.hasUnsavedChanges && !this.hasCurrentSchemeBinding() && this.travelList.length > 0) {
                const message = '您有未保存的旅游方案，确定要离开吗？';
                e.preventDefault();
                e.returnValue = message;
                return message;
            }
        });
    }

    // 更新页面标题显示保存状态
    updatePageTitle() {
        const baseTitle = '17旅游规划助手';
        let title = baseTitle;

        if (this.currentSchemeName) {
            title = `${this.currentSchemeName} - ${baseTitle}`;
            if (this.hasUnsavedChanges) {
                title = `${this.currentSchemeName} (已修改) - ${baseTitle}`;
            }
        } else if (this.hasUnsavedChanges && this.travelList.length > 0) {
            title = `未保存的方案 - ${baseTitle}`;
        }

        document.title = title;
    }

    announceSaveStatus(message) {
        const region = document.getElementById('saveStatus');
        if (!region) return;
        region.textContent = '';
        requestAnimationFrame(() => {
            region.textContent = String(message);
        });
    }

    // 初始化应用程序
    initializeApp() {
        // 首先加载保存的设置
        this.loadSavedSettings();

        // 设置页面关闭时的提醒
        this.setupPageUnloadHandler();

        // 然后检查并初始化地图
        this.waitForMapAPI();
    }

    // 加载已保存的设置
    loadSavedSettings() {
        try {
            const saved = localStorage.getItem('travelPlannerData');
            if (saved) {
                const data = JSON.parse(saved);

                // 恢复应用设置
                if (data.settings) {
                    this.settings = this.normalizeStoredSettings(data.settings);
                }
            }
        } catch (error) {
            console.error('加载设置失败:', error);
        }
    }

    // 等待地图API加载
    waitForMapAPI() {
        const selectedMapApi = this.settings.selectedMapApi;

        // 检查选择的API是否已经加载
        if (selectedMapApi === 'google' && typeof google !== 'undefined' && google.maps) {
            this.init();
        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
            this.init();
        } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined' && T.Map) {
            this.init();
        } else if (selectedMapApi === 'bing' && typeof Microsoft !== 'undefined') {
            this.init();
        } else {
            // 尝试动态加载选择的地图API
            this.tryLoadMapAPI();
        }
    }

    // 尝试动态加载选择的地图API
    tryLoadMapAPI() {
        const selectedMapApi = this.settings.selectedMapApi;
        const apiKey = this.getPublicSdkKey(selectedMapApi);

        if (selectedMapApi === 'google' && apiKey) {
            this.loadGoogleMapsScript(apiKey);
        } else if (selectedMapApi === 'gaode' && apiKey) {
            this.loadGaodeMapScript(apiKey);
        } else if (selectedMapApi === 'tianditu' && apiKey) {
            this.loadTiandituMapScript(apiKey);
        } else if (selectedMapApi === 'azure' && apiKey) {
            setTimeout(() => {
                this.initDemoMode();
            }, 1000);
        } else {
            setTimeout(() => {
                this.initDemoMode();
            }, 1000);
        }
    }

    // 动态加载Google Maps脚本
    loadGoogleMapsScript(apiKey) {
        // 检查是否已经存在Google Maps脚本
        const existingScript = document.querySelector('script[src*="maps.googleapis.com"]');
        if (existingScript) {
            existingScript.remove();
        }

        // 创建新的脚本标签
        const script = document.createElement('script');
        script.src = Security.buildHttpsUrl(
            'https://maps.googleapis.com',
            '/maps/api/js',
            { key: apiKey, callback: 'initMap' },
            ['https://maps.googleapis.com']
        );
        script.async = true;
        script.defer = true;

        script.onload = () => {
            console.log('✅ Google Maps API加载成功');
            this.removeApiConfigPrompt();
        };

        script.onerror = () => {
            console.error('❌ Google Maps API加载失败，可能是API密钥错误');
            this.showToast('Google Maps API加载失败，请检查API密钥配置');
            this.initDemoMode();
        };

        document.head.appendChild(script);
    }

    // 动态加载高德地图脚本
    loadGaodeMapScript(apiKey) {
        console.log(`🗺️ 开始加载高德地图API...`);

        // 检查是否已经存在高德地图脚本
        const existingScript = document.querySelector('script[src*="webapi.amap.com"]');
        if (existingScript) {
            existingScript.remove();
        }

        // 创建新的脚本标签（只加载地图显示所需的基础组件）
        const script = document.createElement('script');
        script.src = Security.buildHttpsUrl(
            'https://webapi.amap.com',
            '/maps',
            { v: '2.0', key: apiKey, plugin: 'AMap.Scale,AMap.ToolBar' },
            ['https://webapi.amap.com']
        );
        script.async = true;
        script.defer = true;

        script.onload = () => {
            console.log('✅ 高德地图API脚本加载成功');

            // 等待AMap对象可用，然后初始化应用
            const checkAMap = () => {
                if (typeof AMap !== 'undefined') {
                    console.log('🗺️ AMap对象已可用，初始化应用');

                    this.removeApiConfigPrompt();

                    if (!window.app || !window.app.settings) {
                        window.app = new TravelPlanner();
                    } else {
                        // 如果应用已存在，直接初始化地图
                        window.app.init();
                    }
                } else {
                    console.log('⏳ 等待AMap对象...');
                    setTimeout(checkAMap, 50);
                }
            };

            setTimeout(checkAMap, 100);
        };

        const self = this;
        script.onerror = () => {
            console.error('❌ 高德地图API加载失败，可能是API密钥错误');
            if (self.showToast) {
                self.showToast('高德地图API加载失败，请检查API密钥配置');
            }
            self.initDemoMode();
        };

        document.head.appendChild(script);
    }

    // 动态加载天地图脚本
    loadTiandituMapScript(apiKey) {
        console.log(`🗺️ 开始加载天地图API...`);

        // 检查是否已经存在天地图脚本
        const existingScript = document.querySelector('script[src*="api.tianditu.gov.cn/api"]');
        if (existingScript) {
            existingScript.remove();
        }

        const script = document.createElement('script');
        script.src = Security.buildHttpsUrl(
            'https://api.tianditu.gov.cn',
            '/api',
            { v: '4.0', tk: apiKey },
            ['https://api.tianditu.gov.cn']
        );
        script.async = true;
        script.defer = true;

        script.onload = () => {
            console.log('✅ 天地图API脚本加载成功');

            let attempts = 0;
            const checkTianditu = () => {
                attempts++;

                if (typeof T !== 'undefined' && T.Map) {
                    console.log('🗺️ 天地图T对象已可用，初始化应用');

                    this.removeApiConfigPrompt();

                    if (window.app && window.app.settings) {
                        window.app.init();
                    } else {
                        window.app = new TravelPlanner();
                    }
                    return;
                }

                if (attempts < 80) {
                    setTimeout(checkTianditu, 50);
                } else {
                    console.error('❌ 天地图API对象初始化超时');
                    this.showToast('天地图API加载超时，请检查API密钥配置');
                    this.initDemoMode();
                }
            };

            setTimeout(checkTianditu, 100);
        };

        script.onerror = () => {
            console.error('❌ 天地图API加载失败，可能是API密钥错误');
            this.showToast('天地图API加载失败，请检查API密钥配置');
            this.initDemoMode();
        };

        document.head.appendChild(script);
    }

    // 初始化应用
    init() {
        console.log('🎯 开始主要初始化流程...');

        this.setupEventListeners();
        console.log('📝 事件监听器设置完成');

        this.initMap(); // 使用通用的地图初始化方法
        console.log('🗺️ 地图初始化完成');

        this.loadSavedData();
        console.log('💾 数据加载完成');

        this.updatePageTitle(); // 更新页面标题
        console.log('📄 页面标题更新完成');

        this.updateVersionInfo(); // 初始化版本信息显示
        console.log('🔢 版本信息更新完成');

        console.log('✅ 应用初始化完成！');
    }

    // 通用地图初始化方法（根据选择的API）
    initMap() {
        const selectedMapApi = this.settings.selectedMapApi;

        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
            this.initGoogleMap();
        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
            this.initAMap();
        } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined' && T.Map) {
            this.initTiandituMap();
        } else if (selectedMapApi === 'bing' && typeof Microsoft !== 'undefined') {
            // TODO: 实现Bing Maps初始化
            this.initDemoMap();
        } else {
            // 如果没有可用的API，显示演示模式
            this.initDemoMap();
        }
    }

    // 初始化演示模式
    initDemoMode() {
        this.setupEventListeners();
        this.initDemoMap();
        this.loadSavedData();
        this.showApiKeyConfigPrompt();
    }

    // 显示API密钥配置提示
    showApiKeyConfigPrompt() {
        const selectedMapApi = this.settings.selectedMapApi;
        const hasSelectedApiKey = this.getPublicSdkKey(selectedMapApi);

        if (!hasSelectedApiKey && !document.getElementById('api-config-banner')) {
            const messageHost = document.getElementById('systemMessages');
            if (!messageHost) return;

            const banner = document.createElement('div');
            banner.id = 'api-config-banner';
            banner.className = 'api-config-banner';
            banner.setAttribute('role', 'status');

            // 获取API的中文名称
            const apiNameMap = {
                'google': 'Google Maps',
                'gaode': '高德地图',
                'azure': 'Azure Maps',
                'tianditu': '天地图'
            };
            const apiDisplayName = apiNameMap[selectedMapApi] || selectedMapApi;

            const message = this.createElement('span', {
                className: 'api-banner-message',
                text: `未配置 ${apiDisplayName} 地图显示服务，当前为演示模式。`
            });

            const openSettingsButton = this.createElement('button', {
                id: 'openApiSettingsBtn',
                className: 'api-banner-config-btn',
                text: '立即配置',
                type: 'button'
            });
            const dismissButton = this.createElement('button', {
                id: 'dismissBannerBtn',
                className: 'api-banner-dismiss-btn',
                text: '×',
                title: '关闭提示',
                type: 'button',
                attributes: { 'aria-label': '关闭地图配置提示' }
            });
            banner.append(message, openSettingsButton, dismissButton);
            messageHost.replaceChildren(banner);

            // 绑定事件
            openSettingsButton.addEventListener('click', () => {
                this.showSettingsModal();
            });

            dismissButton.addEventListener('click', () => {
                this.removeApiConfigPrompt();
            });
        }
    }

    removeApiConfigPrompt() {
        document.getElementById('api-config-banner')?.remove();
    }

    // 设置事件监听器
    setupEventListeners() {
        if (this.eventsBound) return;
        this.eventsBound = true;
        console.log('🔧 开始设置事件监听器...');

        // 定期清理过期缓存
        setInterval(() => this.cleanExpiredCache(), 5 * 60 * 1000); // 每5分钟清理一次

        // 搜索相关
        const searchBtn = document.getElementById('searchBtn');
        const resetSearchBtn = document.getElementById('resetSearchBtn');
        const searchInput = document.getElementById('searchInput');

        if (searchBtn) {
            searchBtn.addEventListener('click', () => this.submitSearch());
        }

        if (resetSearchBtn) {
            resetSearchBtn.addEventListener('click', () => this.resetSearch());
        }

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.searchController.schedule(this.getSearchContext(e.target.value));
            });

            searchInput.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                this.submitSearch();
            });
        }

        document.getElementById('searchResults').addEventListener('click', event => this.handleSearchResultClick(event));
        document.getElementById('travelList').addEventListener('click', event => this.handlePlaceListClick(event));
        document.getElementById('pendingList').addEventListener('click', event => this.handlePlaceListClick(event));
        document.getElementById('savedSchemesList').addEventListener('click', event => this.handleSavedSchemeClick(event));
        document.getElementById('conflictList').addEventListener('change', event => this.handleConflictResolutionChange(event));

        // 列表控制按钮
        document.getElementById('addBlankPlaceBtn').addEventListener('click', () => this.addBlankPlace());
        document.getElementById('clearAllBtn').addEventListener('click', () => this.clearAllPlaces());
        document.getElementById('optimizeRouteBtn').addEventListener('click', () => this.optimizeRoute());
        document.getElementById('undoOptimizeBtn').addEventListener('click', () => this.undoRouteOptimization());
        document.getElementById('showRouteBtn').addEventListener('click', () => this.showRoute());

        // 地图控制按钮
        document.getElementById('locateBtn').addEventListener('click', () => this.getCurrentLocation());
        document.getElementById('clearMarkersBtn').addEventListener('click', () => this.toggleMarkers());
        document.getElementById('satelliteBtn').addEventListener('click', () => this.toggleSatellite());
        document.getElementById('toggleNamesBtn').addEventListener('click', () => this.togglePlaceNames());
        document.getElementById('togglePendingBtn').addEventListener('click', () => this.togglePendingPlaces());

        // 创建城市过滤按钮
        this.createCityFilterButton();

        // 设置快速悬停提示
        this.setupFastTooltips();

        // 储存方案、导入和导出按钮
        document.getElementById('saveSchemeBtn').addEventListener('click', () => this.showSaveSchemeModal());
        document.getElementById('importBtn').addEventListener('click', () => this.showImportModal());
        document.getElementById('exportBtn').addEventListener('click', () => this.showExportModal());
        document.getElementById('settingsBtn').addEventListener('click', () => this.showSettingsModal());

        // 模态框
        this.setupModalEventListeners();

        // 遮罩点击、Escape、Tab 焦点陷阱与触发点恢复由 DialogManager 统一处理。
    }

    handleSearchResultClick(event) {
        const action = event.target.closest('[data-search-action]')?.dataset.searchAction;
        if (action === 'configure') {
            this.showSettingsModal();
            return;
        }
        const item = event.target.closest('.search-result-item[data-result-index]');
        if (!item || !event.currentTarget.contains(item)) return;

        const resultIndex = Number(item.dataset.resultIndex);
        const place = this.currentSearchResults[resultIndex];
        if (!place || !PlannerData.isValidCoordinate(place)) return;

        const placeData = {
            name: String(place.name ?? ''),
            address: String(place.address ?? ''),
            lng: Number(place.lng),
            lat: Number(place.lat)
        };

        this.showPlaceModal(placeData);
        if (this.isMapLoaded) {
            const selectedMapApi = this.settings.selectedMapApi;
            if (selectedMapApi === 'gaode') {
                this.map.setCenter([placeData.lng, placeData.lat]);
            } else if (selectedMapApi === 'tianditu') {
                this.map.centerAndZoom(new T.LngLat(placeData.lng, placeData.lat), 15);
            } else {
                this.map.setCenter({ lat: placeData.lat, lng: placeData.lng });
                this.map.setZoom(15);
            }
        }
    }

    handlePlaceListClick(event) {
        const button = event.target.closest('button[data-action]');
        if (!button || !event.currentTarget.contains(button)) return;

        const action = button.dataset.action;
        if (action === 'navigate-route') {
            this.openNavigationRoute(
                button.dataset.segmentKey,
                Number(button.dataset.fromIndex),
                Number(button.dataset.toIndex)
            );
            return;
        }

        const item = button.closest('[data-id]');
        const place = item ? this.getPlaceById(item.dataset.id) : null;
        if (!place) return;

        const displayName = String(place.customName || place.name || '');
        const address = String(place.address || '');
        const lat = Number(place.lat);
        const lng = Number(place.lng);

        switch (action) {
            case 'toggle-status':
                this.togglePlaceStatus(String(place.id));
                break;
            case 'locate':
                if (PlannerData.isValidCoordinate(place)) this.locatePlace(lng, lat);
                break;
            case 'show-in-map':
                if (PlannerData.isValidCoordinate(place)) this.showInMap(lng, lat, displayName);
                break;
            case 'navigate-to':
                if (PlannerData.isValidCoordinate(place)) this.navigateToPlace(lng, lat, displayName);
                break;
            case 'edit':
                this.editPlace(String(place.id));
                break;
            case 'copy-name':
                this.copyPlaceName(displayName);
                break;
            case 'copy-address':
                this.copyPlaceAddress(address);
                break;
            case 'remove':
                this.removePlaceFromList(String(place.id));
                break;
            case 'move-up':
                this.movePlaceByOffset(String(place.id), -1);
                break;
            case 'move-down':
                this.movePlaceByOffset(String(place.id), 1);
                break;
        }
    }

    handleSavedSchemeClick(event) {
        const button = event.target.closest('button[data-action][data-id]');
        if (!button || !event.currentTarget.contains(button)) return;

        if (button.dataset.action === 'load-scheme') {
            this.loadScheme(button.dataset.id);
        } else if (button.dataset.action === 'delete-scheme') {
            this.deleteScheme(button.dataset.id);
        }
    }

    handleConflictResolutionChange(event) {
        const radio = event.target.closest('input[type="radio"][data-conflict-index]');
        if (!radio || !event.currentTarget.contains(radio)) return;

        const index = Number(radio.dataset.conflictIndex);
        const renameInput = document.getElementById(`renameInput_${index}`);
        if (!renameInput) return;

        const needsRename = radio.value === 'rename' || radio.value === 'both';
        renameInput.style.display = needsRename ? 'block' : 'none';
        if (!needsRename) return;

        const newNameInput = document.getElementById(`newName_${index}`);
        const conflict = this.pendingConflicts[index];
        if (!newNameInput || !conflict) return;

        if (radio.value === 'both') {
            newNameInput.value = `${String(conflict.importScheme.name || '')} (${new Date().toLocaleDateString('zh-CN')})`;
        }
        this.addRenameInputListener(newNameInput, index);
    }

    // 设置所有模态框的事件监听器
    setupModalEventListeners() {
        // 地点模态框
        document.querySelector('#placeModal .close').addEventListener('click', () => this.closeModal());
        document.getElementById('addToListBtn').addEventListener('click', () => this.addCurrentPlaceToList());

        // 储存方案模态框
        document.querySelector('#saveSchemeModal .close').addEventListener('click', () => this.closeSaveSchemeModal());
        document.getElementById('saveNewSchemeBtn').addEventListener('click', () => this.saveNewScheme());
        document.getElementById('newBlankSchemeBtn').addEventListener('click', () => this.createBlankScheme());
        document.getElementById('schemeNameInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.saveNewScheme();
        });

        // 添加实时检查方案名称的监听器
        document.getElementById('schemeNameInput').addEventListener('input', () => {
            this.checkSchemeNameAvailability();
        });

        // 导入模态框
        document.querySelector('#importModal .close').addEventListener('click', () => this.closeImportModal());
        document.getElementById('selectFileBtn').addEventListener('click', (e) => {
            e.stopPropagation(); // 阻止事件冒泡
            document.getElementById('fileInput').click();
        });
        document.getElementById('fileInput').addEventListener('change', (e) => this.handleFileSelect(e));

        // 拖拽功能
        const dropZone = document.getElementById('fileDropZone');
        dropZone.addEventListener('click', (e) => {
            // 只有当点击的不是选择文件按钮时才触发
            if (!e.target.closest('#selectFileBtn')) {
                document.getElementById('fileInput').click();
            }
        });
        dropZone.addEventListener('dragover', (e) => this.handleFileDragOver(e));
        dropZone.addEventListener('dragleave', (e) => this.handleFileDragLeave(e));
        dropZone.addEventListener('drop', (e) => this.handleFileDrop(e));

        // 导出模态框
        document.querySelector('#exportModal .close').addEventListener('click', () => this.closeExportModal());
        document.querySelector('.share-export').addEventListener('click', () => this.exportShareVersion());
        document.querySelector('.backup-export').addEventListener('click', () => this.exportBackupVersion());

        // 冲突解决模态框
        document.querySelector('#conflictResolutionModal .close').addEventListener('click', () => this.closeConflictResolutionModal());
        document.getElementById('applyResolutionBtn').addEventListener('click', () => this.processConflictResolution());
        document.getElementById('cancelImportBtn').addEventListener('click', () => this.closeConflictResolutionModal());

        // 设置模态框
        document.querySelector('#settingsModal .close').addEventListener('click', () => this.closeSettingsModal());
        document.getElementById('saveSettingsBtn').addEventListener('click', () => this.saveSettings());
        document.getElementById('cancelSettingsBtn').addEventListener('click', () => this.closeSettingsModal());
        const advancedByokToggle = document.getElementById('advancedByokEnabled');
        if (advancedByokToggle) {
            advancedByokToggle.addEventListener('change', () => this.updateAdvancedByokVisibility());
        }

        // 设置菜单切换
        this.setupSettingsMenuToggle();

        // 编辑游玩点模态框
        document.querySelector('#editPlaceModal .close').addEventListener('click', () => this.closeEditPlaceModal());
        document.getElementById('saveEditBtn').addEventListener('click', () => this.saveEditPlace());
        document.getElementById('cancelEditBtn').addEventListener('click', () => this.closeEditPlaceModal());

        // 路线建议只在用户确认后写回；关闭或返回不会改变当前方案。
        document.querySelector('#routeOptimizationModal .optimization-close').addEventListener('click', () => this.closeOptimizationModal());
        document.getElementById('cancelOptimizationBtn').addEventListener('click', () => this.closeOptimizationModal());
        document.getElementById('dismissSuggestionBtn').addEventListener('click', () => this.closeOptimizationModal());
        document.getElementById('calculateSuggestionBtn').addEventListener('click', () => this.generateRouteSuggestion());
        document.getElementById('applySuggestionBtn').addEventListener('click', () => this.applyRouteSuggestion());
        document.getElementById('reconfigureOptimizationBtn').addEventListener('click', () => this.showOptimizationSetup());
        document.getElementById('optimizationRoundTrip').addEventListener('change', () => this.updateOptimizationEndpointState());
        document.getElementById('optimizationStart').addEventListener('change', () => this.updateOptimizationEndpointState());

        this.setupResponsiveChromeSizing();
        this.setupMobileViewNavigation();
    }

    setupResponsiveChromeSizing() {
        const root = document.documentElement;
        const chromeElements = [
            document.querySelector('header'),
            document.getElementById('systemMessages'),
            document.querySelector('.page-footer')
        ].filter(Boolean);

        const updateChromeHeight = () => {
            const height = chromeElements.reduce((total, element) => {
                return total + element.getBoundingClientRect().height;
            }, 0);
            root.style.setProperty('--app-chrome-height', `${height}px`);
        };

        if ('ResizeObserver' in window) {
            this.chromeResizeObserver = new ResizeObserver(updateChromeHeight);
            chromeElements.forEach(element => this.chromeResizeObserver.observe(element));
        } else {
            window.addEventListener('resize', updateChromeHeight, { passive: true });
        }
        updateChromeHeight();
    }

    setupMobileViewNavigation() {
        const container = document.querySelector('.container');
        const itineraryView = document.getElementById('itineraryView');
        const mapView = document.getElementById('mapView');
        const viewButtons = Array.from(document.querySelectorAll('[data-mobile-view]'));
        const mobileMedia = window.matchMedia('(max-width: 768px)');
        const scrollPositions = { itinerary: 0, map: 0 };
        let activeView = localStorage.getItem('mobilePrimaryView') === 'map' ? 'map' : 'itinerary';

        const syncView = (nextView = activeView, restoreScroll = true) => {
            if (!mobileMedia.matches) {
                container.removeAttribute('data-mobile-view');
                itineraryView.removeAttribute('aria-hidden');
                mapView.removeAttribute('aria-hidden');
                return;
            }

            if (nextView !== activeView) {
                scrollPositions[activeView] = window.scrollY;
            }
            activeView = nextView;
            container.dataset.mobileView = activeView;
            itineraryView.setAttribute('aria-hidden', String(activeView !== 'itinerary'));
            mapView.setAttribute('aria-hidden', String(activeView !== 'map'));
            viewButtons.forEach(button => {
                const isCurrent = button.dataset.mobileView === activeView;
                button.classList.toggle('is-active', isCurrent);
                if (isCurrent) {
                    button.setAttribute('aria-current', 'page');
                } else {
                    button.removeAttribute('aria-current');
                }
            });
            localStorage.setItem('mobilePrimaryView', activeView);

            requestAnimationFrame(() => {
                if (activeView === 'map') {
                    window.dispatchEvent(new Event('resize'));
                }
                if (restoreScroll) {
                    window.scrollTo({ top: scrollPositions[activeView], behavior: 'instant' });
                }
            });
        };

        viewButtons.forEach(button => {
            button.addEventListener('click', () => syncView(button.dataset.mobileView));
        });
        document.getElementById('mobileSchemesBtn')?.addEventListener('click', () => {
            document.getElementById('saveSchemeBtn')?.click();
        });
        document.getElementById('mobileSettingsBtn')?.addEventListener('click', () => {
            document.getElementById('settingsBtn')?.click();
        });
        mobileMedia.addEventListener('change', () => syncView(activeView, false));
        syncView(activeView, false);
    }

    // 初始化Google地图
    initGoogleMap() {
        try {
            if (typeof google !== 'undefined' && google.maps) {
                // 定义PlaceLabel类
                if (!PlaceLabel) {
                    PlaceLabel = class extends google.maps.OverlayView {
                        constructor(position, text, map) {
                            super();
                            this.position = position;
                            this.text = text;
                            this.div = null;
                            this.line = null; // 连接线元素
                            this.offsetX = 0; // 水平偏移
                            this.offsetY = 0; // 垂直偏移
                            this.setMap(map);
                        }

                        onAdd() {
                            // 创建标签元素
                            this.div = document.createElement('div');
                            this.div.style.cssText = `
                                position: absolute;
                                background: linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.98) 100%);
                                border: 1px solid rgba(255,255,255,0.8);
                                border-radius: 8px;
                                padding: 6px 10px;
                                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                                font-size: 12px;
                                font-weight: 700;
                                color: #2c3e50;
                                white-space: nowrap;
                                box-shadow: 0 4px 12px rgba(0,0,0,0.15), 0 2px 4px rgba(0,0,0,0.1);
                                backdrop-filter: blur(12px) saturate(1.2);
                                -webkit-backdrop-filter: blur(12px) saturate(1.2);
                                text-shadow: 0 1px 2px rgba(255,255,255,0.8);
                                min-width: 60px;
                                text-align: center;
                                transform: translateX(-50%);
                                cursor: default;
                                user-select: none;
                                z-index: 1000;
                                transition: opacity 0.2s ease, top 0.3s cubic-bezier(0.4, 0, 0.2, 1), left 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                            `;

                            // 创建连接线元素 (SVG)
                            this.line = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                            this.line.style.cssText = `
                                position: absolute;
                                pointer-events: none;
                                z-index: 999;
                                overflow: visible;
                                transition: opacity 0.2s ease;
                                opacity: 0;
                            `;
                            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                            line.setAttribute('x1', '0');
                            line.setAttribute('y1', '0');
                            line.setAttribute('x2', '0');
                            line.setAttribute('y2', '0');
                            line.style.stroke = 'rgba(102, 126, 234, 0.6)';
                            line.style.strokeWidth = '2';
                            line.style.strokeDasharray = '4,3';
                            this.line.appendChild(line);

                            renderGooglePlaceLabel(this.div, this.text);

                            // 添加到地图覆盖层
                            const panes = this.getPanes();
                            panes.overlayLayer.appendChild(this.line);
                            panes.overlayLayer.appendChild(this.div);
                        }

                        draw() {
                            if (!this.div || !this.line) return;

                            // 将地理坐标转换为屏幕坐标
                            const overlayProjection = this.getProjection();
                            const position = overlayProjection.fromLatLngToDivPixel(this.position);

                            // 基础位置（标记的正上方，约40px处是大头针顶部）
                            const baseUrlX = position.x;
                            const baseUrlY = position.y - 40;

                            // 标签目标位置
                            const labelX = position.x + this.offsetX;
                            const labelY = position.y - 85 - this.offsetY;

                            // 设置标签位置
                            this.div.style.left = labelX + 'px';
                            this.div.style.top = labelY + 'px';

                            // 更新连接线
                            if (this.offsetX !== 0 || this.offsetY > 0) {
                                this.line.style.opacity = '1';
                                const lineEl = this.line.querySelector('line');

                                // 设置 SVG 容器位置
                                this.line.style.left = Math.min(baseUrlX, labelX) + 'px';
                                this.line.style.top = Math.min(baseUrlY, labelY + 25) + 'px';

                                // 设置线条起点和终点（相对于 SVG 容器）
                                const x1 = baseUrlX - Math.min(baseUrlX, labelX);
                                const y1 = baseUrlY - Math.min(baseUrlY, labelY + 25);
                                const x2 = labelX - Math.min(baseUrlX, labelX);
                                const y2 = (labelY + 25) - Math.min(baseUrlY, labelY + 25);

                                lineEl.setAttribute('x1', x1);
                                lineEl.setAttribute('y1', y1);
                                lineEl.setAttribute('x2', x2);
                                lineEl.setAttribute('y2', y2);
                            } else {
                                this.line.style.opacity = '0';
                            }
                        }

                        // 设置偏移量并重绘
                        setOffset(offsetX, offsetY) {
                            if (this.offsetX !== offsetX || this.offsetY !== offsetY) {
                                this.offsetX = offsetX;
                                this.offsetY = offsetY;
                                this.draw();
                            }
                        }

                        onRemove() {
                            if (this.div) {
                                this.div.parentNode.removeChild(this.div);
                                this.div = null;
                            }
                            if (this.line) {
                                this.line.parentNode.removeChild(this.line);
                                this.line = null;
                            }
                        }

                        hide() {
                            if (this.div) {
                                this.div.style.opacity = '0';
                                this.div.style.pointerEvents = 'none';
                            }
                            if (this.line) this.line.style.opacity = '0';
                        }

                        show() {
                            if (this.div) {
                                this.div.style.opacity = '1';
                                this.div.style.pointerEvents = 'auto';
                            }
                            if (this.line && (this.offsetX !== 0 || this.offsetY > 0)) {
                                this.line.style.opacity = '1';
                            }
                        }

                        setText(text) {
                            this.text = text;
                            if (this.div) {
                                renderGooglePlaceLabel(this.div, text);
                            }
                        }
                    };
                }

                // 计算初始地图中心和缩放级别
                const mapConfig = this.calculateInitialMapConfig();

                this.map = new google.maps.Map(document.getElementById('mapContainer'), {
                    zoom: mapConfig.zoom,
                    center: mapConfig.center,
                    mapTypeId: google.maps.MapTypeId.ROADMAP
                });

                // Web Service 能力（Places/Geocoder/Directions/Matrix）仅由 PHP BFF 提供。
                this.directionsRenderer = new google.maps.DirectionsRenderer({
                    draggable: false,
                    suppressMarkers: true // 不显示默认标记
                });
                this.directionsRenderer.setMap(this.map);

                // 地图点击事件
                this.map.addListener('click', (e) => {
                    this.onMapClick(e.latLng.lng(), e.latLng.lat());
                });

                // 监听缩放和空闲事件以调整标签位置
                this.map.addListener('zoom_changed', () => {
                    setTimeout(() => this.adjustLabels(), 100);
                });
                this.map.addListener('idle', () => {
                    this.adjustLabels();
                });

                this.isMapLoaded = true;
                console.log('Google地图初始化成功');

                // 延迟绘制路线，确保地图完全加载
                setTimeout(() => {
                    this.initializeMapContent();
                    this.updateSatelliteButtonState();
                }, 500);
            } else {
                throw new Error('Google Maps API未加载');
            }
        } catch (error) {
            console.error('Google地图初始化失败:', error);
            this.initDemoMap();
        }
    }

    // 初始化高德地图
    initAMap() {
        try {
            if (typeof AMap !== 'undefined') {
                // 计算初始地图中心和缩放级别
                const mapConfig = this.calculateInitialMapConfig();

                // 转换为高德地图格式 [lng, lat]
                const amapCenter = [mapConfig.center.lng, mapConfig.center.lat];

                // 创建高德地图实例
                this.map = new AMap.Map('mapContainer', {
                    zoom: mapConfig.zoom,
                    center: amapCenter,
                    mapStyle: 'amap://styles/normal',
                    resizeEnable: true
                });

                this.isMapLoaded = true;
                console.log('高德地图初始化成功');

                this.removeApiConfigPrompt();

                // 地图点击事件
                this.map.on('click', (e) => {
                    const lng = e.lnglat.lng;
                    const lat = e.lnglat.lat;
                    this.onMapClick(lng, lat);
                });

                // 监听缩放和地图状态变化事件以调整标签位置
                this.map.on('zoomchange', () => {
                    setTimeout(() => this.adjustLabels(), 100);
                });
                this.map.on('complete', () => {
                    this.adjustLabels();
                });
                this.map.on('moveend', () => {
                    this.adjustLabels();
                });

                // 创建一些基础的地图控件
                this.map.addControl(new AMap.Scale());
                this.map.addControl(new AMap.ToolBar());

                // 延迟绘制路线，确保地图完全加载
                setTimeout(() => {
                    this.initializeMapContent();
                    this.updateSatelliteButtonState();
                }, 500);

                this.showToast('✅ 高德地图加载成功！');

            } else {
                throw new Error('高德地图API未加载');
            }
        } catch (error) {
            console.error('高德地图初始化失败:', error);
            this.initDemoMap();
        }
    }

    // 初始化天地图
    initTiandituMap() {
        try {
            if (typeof T !== 'undefined') {
                // 计算初始地图中心和缩放级别
                const mapConfig = this.calculateInitialMapConfig();

                // 创建天地图实例
                this.map = new T.Map("mapContainer");

                // 设置中心点和缩放级别
                const centerLngLat = new T.LngLat(mapConfig.center.lng, mapConfig.center.lat);
                this.map.centerAndZoom(centerLngLat, mapConfig.zoom);

                // 允许鼠标滚轮缩放
                this.map.enableScrollWheelZoom();

                this.isMapLoaded = true;
                console.log('天地图初始化成功');

                this.removeApiConfigPrompt();

                // 地图点击事件
                this.map.addEventListener('click', (e) => {
                    const lng = e.lnglat.getLng();
                    const lat = e.lnglat.getLat();
                    this.onMapClick(lng, lat);
                });

                // 监听缩放和拖拽事件
                this.map.addEventListener('zoomend', () => {
                    this.adjustLabels();
                });
                this.map.addEventListener('moveend', () => {
                    this.adjustLabels();
                });

                // 添加基础控件（不同天地图版本可能暴露的控件略有差异）
                if (T.Control && T.Control.Zoom) {
                    this.map.addControl(new T.Control.Zoom());
                }
                if (T.Control && T.Control.Scale) {
                    this.map.addControl(new T.Control.Scale());
                }

                // 延迟绘制路线，确保地图完全加载
                setTimeout(() => {
                    this.initializeMapContent();
                    this.updateSatelliteButtonState();
                }, 500);

                this.showToast('✅ 天地图加载成功！');

            } else {
                throw new Error('天地图API未加载');
            }
        } catch (error) {
            console.error('天地图初始化失败:', error);
            this.initDemoMap();
        }
    }

    // 计算初始地图配置（中心点和缩放级别）
    calculateInitialMapConfig() {
        // 获取当前有效地点（非待定且有坐标）
        const activePlaces = this.getUsablePlaces();

        if (activePlaces.length === 0) {
            // 没有地点时，显示中国的中心位置
            console.log('📍 没有游玩地点，使用默认位置（中国中心）');
            return {
                center: { lat: 35.0, lng: 105.0 },  // Google Maps格式
                zoom: 4
            };
        } else if (activePlaces.length === 1) {
            // 只有一个地点时，以该地点为中心
            console.log(`📍 单个游玩地点，居中显示: ${activePlaces[0].name}`);
            return {
                center: { lat: activePlaces[0].lat, lng: activePlaces[0].lng },
                zoom: 12
            };
        } else {
            // 多个地点时，计算边界并居中
            const bounds = this.calculateMapBounds(activePlaces);
            console.log(`📍 ${activePlaces.length}个游玩地点，计算最佳视野`);
            return bounds || {
                center: { lat: 35.0, lng: 105.0 },
                zoom: 4
            };
        }
    }

    // 初始化地图内容（标记和路线）
    initializeMapContent() {
        if (!this.isMapLoaded) return;

        console.log('🎯 初始化地图内容：添加标记和绘制路线');

        const activePlaces = this.getUsablePlaces();

        // 重新创建所有标记（只为激活的地点）
        this.recreateMarkers();

        // 绘制路线
        if (activePlaces.length >= 2) {
            this.drawRoute();
        }

        // 适配地图视野（如果有多个地点）
        if (activePlaces.length > 1) {
            setTimeout(() => {
                this.fitMapToPlaces(activePlaces);
            }, 800);
        }

        console.log('✅ 地图内容初始化完成');
    }

    // 更新地图到当前方案区域
    updateMapToCurrentScheme() {
        if (!this.isMapLoaded) return;

        const activePlaces = this.getUsablePlaces();

        if (activePlaces.length === 0) {
            console.log('📍 没有有效地点，保持当前地图视野');
            return;
        }

        console.log(`🗺️ 更新地图到当前方案，包含${activePlaces.length}个地点`);

        // 方案切换也按 ID diff overlay，保留新旧方案中未变化的地点。
        this.syncMarkersIncremental();

        // 绘制路线
        if (activePlaces.length >= 2) {
            this.drawRoute();
        }

        // 适配地图视野
        setTimeout(() => {
            this.fitMapToPlaces(activePlaces);
        }, 300);

        // 更新待定点显示
        this.updateTogglePendingButton();

        console.log('✅ 地图已更新到当前方案区域');
    }

    // 调整地图视角以显示所有地点（包括游玩点和待定点）
    fitMapToAllPlaces() {
        if (!this.isMapLoaded) return;

        // 获取所有有坐标的地点（游玩点和待定点）
        const allPlacesWithCoords = this.getUsablePlaces();

        if (allPlacesWithCoords.length === 0) {
            console.log('📍 没有有坐标的地点，无法调整地图视角');
            return;
        }

        // 分离游玩点和待定点
        const activePlaces = allPlacesWithCoords.filter(place => !place.isPending);
        const pendingPlaces = allPlacesWithCoords.filter(place => place.isPending);

        console.log(`🗺️ 调整地图视角显示全部地点: ${activePlaces.length}个游玩点 + ${pendingPlaces.length}个待定点`);

        // 使用所有地点来调整地图视角
        setTimeout(() => {
            this.fitMapToPlaces(allPlacesWithCoords);
            console.log('✅ 地图视角已调整为显示全部地点');
        }, 300);
    }

    // 更新卫星图按钮状态
    updateSatelliteButtonState() {
        const satelliteBtn = document.getElementById('satelliteBtn');
        if (!satelliteBtn) return;

        // 重置按钮状态为普通图模式
        this.isSatelliteMode = false;
        satelliteBtn.textContent = '🛰️ 卫星图';
        satelliteBtn.title = '切换到卫星图';

        console.log('🔄 卫星图按钮状态已初始化');
    }

    // 演示版地图（当没有API时）
    initDemoMap() {
        const selectedMapApi = this.settings.selectedMapApi || 'google';
        const apiNameMap = {
            'google': 'Google Maps',
            'gaode': '高德地图',
            'bing': 'Bing Maps',
            'tianditu': '天地图'
        };
        const selectedApiName = apiNameMap[selectedMapApi] || selectedMapApi;

        const mapContainer = document.getElementById('mapContainer');
        const demo = this.createElement('div', { className: 'demo-map-placeholder' });
        demo.append(
            this.createElement('h3', { text: '🗺️ 地图 SDK 未配置' }),
            this.createElement('p', { text: `部署管理员尚未提供 ${selectedApiName} 的受限公共 SDK Key` }),
            this.createElement('p', { text: '搜索、路线和列表仍由本站安全网关提供' })
        );
        const settingsButton = this.createElement('button', {
            className: 'demo-map-settings-btn',
            text: '打开地图设置',
            type: 'button'
        });
        settingsButton.addEventListener('click', () => this.showSettingsModal());
        demo.appendChild(settingsButton);
        mapContainer.replaceChildren(demo);
        this.isMapLoaded = false;
    }

    // 显示API帮助信息
    showApiHelp() {
        alert('地图 JavaScript SDK 公共 Key 由部署管理员配置，必须绑定本站 HTTP Referrer，且只允许地图渲染 SDK。地点搜索、路线、距离矩阵和静态地图使用独立的服务端 Key，并仅通过 PHP BFF 调用。');
    }

    // 地图点击事件处理
    onMapClick(lng, lat) {
        if (!this.isMapLoaded) return;

        // 反向地理编码获取地址信息
        this.reverseGeocode(lng, lat, (result) => {
            this.showPlaceModal({
                name: result.name || '未知地点',
                address: result.address || '地址未知',
                lng: lng,
                lat: lat
            });
        });
    }

    // 反向地理编码
    reverseGeocode(lng, lat, callback) {
        // v1 暂无反向地理编码能力；禁止借用 SDK Web Service 绕过 BFF。
        callback({
            name: '地图选点',
            address: `经度: ${lng.toFixed(6)}, 纬度: ${lat.toFixed(6)}`
        });
    }

    // 从地理编码结果提取地点名称
    extractPlaceName(result) {
        // 首先尝试从POI类型中获取名称
        const poiTypes = ['establishment', 'point_of_interest', 'tourist_attraction', 'natural_feature'];
        for (let component of result.address_components) {
            for (let type of poiTypes) {
                if (component.types.includes(type)) {
                    return component.long_name;
                }
            }
        }

        // 如果没有POI，尝试获取地址的主要部分
        const addressTypes = ['subpremise', 'premise', 'street_number', 'route', 'neighborhood', 'sublocality'];
        for (let type of addressTypes) {
            for (let component of result.address_components) {
                if (component.types.includes(type)) {
                    return `${component.long_name}附近`;
                }
            }
        }

        // 最后使用行政区域
        for (let component of result.address_components) {
            if (component.types.includes('administrative_area_level_3') ||
                component.types.includes('administrative_area_level_2')) {
                return `${component.long_name}区域`;
            }
        }

        return result.address_components[0]?.long_name || '位置点';
    }

    getSearchContext(query = document.getElementById('searchInput')?.value || '') {
        const locationBias = PlannerData.isValidCoordinate(this.currentLocation)
            ? {
                lat: this.currentLocation.lat,
                lng: this.currentLocation.lng,
                radiusMeters: PublicConfig.search?.locationBiasRadiusMeters || 10000
            }
            : null;
        return {
            provider: this.settings.selectedMapApi,
            query,
            language: PublicConfig.search?.language || document.documentElement.lang || navigator.language || 'zh-CN',
            region: PublicConfig.search?.region || 'CN',
            locationBias
        };
    }

    searchPlaces() {
        return this.submitSearch();
    }

    submitSearch() {
        return this.searchController.submit(this.getSearchContext());
    }

    async fetchSearchResults(context, options = {}) {
        const response = await this.bff.searchPlaces({ ...context, limit: 10 }, { signal: options.signal });
        const payload = response?.data || response || {};
        const rawPlaces = Array.isArray(payload.places) ? payload.places : [];
        return rawPlaces.map(place => ({
            id: this.normalizeUntrustedText(place.id, 200),
            name: this.normalizeUntrustedText(place.name, 1000),
            address: this.normalizeUntrustedText(place.address, 2000),
            lat: Number(place.location?.lat ?? place.lat),
            lng: Number(place.location?.lng ?? place.lng),
            source: context.provider
        })).filter(place => PlannerData.isValidCoordinate(place));
    }

    getDemoSearchResults(context) {
        const keyword = Search.normalizeQuery(context.query);
        return DEMO_SEARCH_PLACES
            .filter(place => Search.normalizeQuery(`${place.name} ${place.address}`).includes(keyword))
            .map(place => ({ ...place, source: 'demo' }));
    }

    renderSearchState(state) {
        const resultsContainer = document.getElementById('searchResults');
        const searchButton = document.getElementById('searchBtn');
        if (!resultsContainer || !searchButton) return;

        const isLoading = state.status === 'loading';
        searchButton.disabled = isLoading;
        searchButton.textContent = isLoading ? '⏳ 搜索中' : '搜索';
        searchButton.setAttribute('aria-busy', String(isLoading));
        resultsContainer.dataset.state = state.status;
        resultsContainer.setAttribute('aria-busy', String(isLoading));
        resultsContainer.setAttribute('aria-live', state.status === 'error' ? 'assertive' : 'polite');

        if (state.status === 'idle') {
            this.currentSearchResults = [];
            resultsContainer.replaceChildren();
            return;
        }
        if (state.status === 'loading') {
            this.currentSearchResults = [];
            this.replaceWithMessage(resultsContainer, '正在搜索地点…', 'search-status search-status--loading');
            return;
        }
        if (state.status === 'empty') {
            this.currentSearchResults = [];
            this.replaceWithMessage(resultsContainer, '未找到相关地点', 'search-status search-status--empty');
            return;
        }
        if (state.status === 'configuration-required') {
            this.currentSearchResults = [];
            const panel = this.createElement('div', { className: 'search-status search-status--configuration' });
            const message = state.reason === 'unsupported'
                ? '当前地图 Provider 不支持地点搜索，请切换服务。'
                : '当前地图 Provider 尚未配置地点搜索 Key。';
            panel.append(
                this.createElement('p', { text: message }),
                this.createElement('button', {
                    className: 'search-configure-btn',
                    text: '打开地图服务设置',
                    type: 'button',
                    dataset: { searchAction: 'configure' }
                })
            );
            resultsContainer.replaceChildren(panel);
            return;
        }
        if (state.status === 'error') {
            this.currentSearchResults = [];
            const messages = {
                key: 'Provider Key 无效或权限不足，请联系管理员检查配置。',
                quota: '地点搜索配额不足或请求过于频繁，请稍后再试。',
                timeout: '地点搜索超时，请重试。',
                network: navigator.onLine === false ? '当前处于离线状态，请恢复网络后重试。' : '网络连接失败，请检查网络后重试。',
                unknown: '地点服务暂时不可用，请稍后重试。'
            };
            this.replaceWithMessage(resultsContainer, messages[state.reason] || messages.unknown, 'search-status search-status--error');
            return;
        }
        if (state.status === 'demo') {
            const banner = this.createElement('div', {
                className: 'search-status search-status--demo',
                text: '当前 Provider 未配置，以下为演示数据，不会发起第三方搜索。'
            });
            const fragment = this.renderSearchResultItems(state.results, true);
            resultsContainer.replaceChildren(banner, fragment);
            return;
        }
        this.renderSearchResults(state.results);
    }

    renderSearchResultItems(results, isDemo = false) {
        this.currentSearchResults = results
            .filter(place => PlannerData.isValidCoordinate(place))
            .map(place => ({
                name: String(place.name ?? ''),
                address: String(place.address ?? ''),
                lng: Number(place.lng),
                lat: Number(place.lat),
                source: String(place.source || '')
            }));

        const fragment = document.createDocumentFragment();
        this.currentSearchResults.forEach((place, index) => {
            const item = this.createElement('button', {
                className: 'search-result-item',
                type: 'button',
                dataset: { resultIndex: index }
            });
            item.append(
                this.createElement('span', { className: 'search-result-name', text: place.name }),
                this.createElement('span', { className: 'search-result-address', text: place.address }),
                ...(isDemo ? [this.createElement('span', { className: 'search-result-demo-badge', text: '演示' })] : [])
            );
            fragment.appendChild(item);
        });
        return fragment;
    }

    renderSearchResults(results) {
        const resultsContainer = document.getElementById('searchResults');
        resultsContainer.replaceChildren(this.renderSearchResultItems(results));
    }

    displaySearchResults(results) {
        this.renderSearchState({ status: results.length ? 'success' : 'empty', results });
    }

    clearSearchResults() {
        this.searchController.reset();
    }

    resetSearch() {
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.value = '';
        this.searchController.reset();
        searchInput?.focus();
    }

    searchWithBff(keyword) {
        return this.searchController.submit(this.getSearchContext(keyword));
    }

    searchWithTianditu(keyword) { return this.searchWithBff(keyword); }
    searchWithGoogle(keyword) { return this.searchWithBff(keyword); }
    searchWithGaode(keyword) { return this.searchWithBff(keyword); }
    searchWithGaodeWebAPI(keyword) { return this.searchWithBff(keyword); }
    searchWithGaodeJSONP(keyword) { return this.searchWithBff(keyword); }
    searchWithBing(keyword) { return this.searchWithBff(keyword); }
    searchDemo(keyword) { return this.getDemoSearchResults(this.getSearchContext(keyword)); }

    async testGaodeAPI() {
        const state = await this.searchWithBff('北京');
        return ['success', 'empty'].includes(state.status);
    }

    testGaodeAPIWithJSONP() {
        return this.testGaodeAPI();
    }

    // 显示地点详情模态框
    showPlaceModal(place) {
        this.currentPlace = place;
        document.getElementById('placeName').textContent = place.name;
        document.getElementById('placeAddress').textContent = place.address;
        this.dialogManager.open('placeModal', {
            initialFocus: '#addToListBtn',
            onRequestClose: () => this.closeModal()
        });
    }

    // 关闭模态框
    closeModal() {
        this.dialogManager.close('placeModal');
    }

    // 显示储存方案模态框
    showSaveSchemeModal() {
        this.loadSavedSchemes();
        document.getElementById('schemeNameInput').value = '';

        // 重置警告信息和按钮状态
        document.getElementById('schemeNameWarning').hidden = true;
        document.getElementById('saveNewSchemeBtn').disabled = true;
        this.dialogManager.open('saveSchemeModal', {
            initialFocus: '#schemeNameInput',
            onRequestClose: () => this.closeSaveSchemeModal()
        });
    }

    createBlankScheme() {
        if (this.hasUnsavedChanges && this.travelList.length > 0 && !confirm(
            '当前方案有未保存的更改。新建空白方案会清空当前编辑内容，是否继续？'
        )) {
            return;
        }

        this.dispatch({
            type: 'REPLACE_PLAN',
            travelList: [],
            routeSegments: [],
            currentSchemeId: null,
            currentSchemeName: null,
            hasUnsavedChanges: false,
            markModified: false
        });
        this.updatePageTitle();
        this.updateTogglePendingButton();
        this.showSaveSchemeModal();
        this.showToast('已新建空白方案，请输入名称后保存');
    }

    // 关闭储存方案模态框
    closeSaveSchemeModal() {
        this.dialogManager.close('saveSchemeModal');
    }

    // 显示导出模态框
    showExportModal() {
        if (this.travelList.length === 0) {
            this.showToast('请先添加一些游玩地点再导出');
            return;
        }
        this.dialogManager.open('exportModal', {
            initialFocus: '.share-export',
            onRequestClose: () => this.closeExportModal()
        });
    }

    // 显示导入模态框
    showImportModal() {
        this.dialogManager.open('importModal', {
            initialFocus: '#selectFileBtn',
            onRequestClose: () => this.closeImportModal()
        });
    }

    // 关闭导入模态框
    closeImportModal() {
        this.dialogManager.close('importModal');
        // 重置文件输入
        document.getElementById('fileInput').value = '';
        document.getElementById('fileDropZone').classList.remove('dragover');
    }

    // 关闭导出模态框
    closeExportModal() {
        this.dialogManager.close('exportModal');
    }

    // 显示设置模态框
    showSettingsModal() {
        // 加载当前设置到界面
        this.loadSettingsToUI();
        this.dialogManager.open('settingsModal', {
            initialFocus: '[role="tab"][aria-selected="true"]',
            onRequestClose: () => this.closeSettingsModal()
        });
    }

    // 关闭设置模态框
    closeSettingsModal() {
        this.dialogManager.close('settingsModal');
    }

    // 加载设置到界面
    loadSettingsToUI() {
        // 加载地图API选择
        document.querySelectorAll('input[name="selectedMapApi"]').forEach(radio => {
            radio.checked = radio.value === this.settings.selectedMapApi;
        });

        // 加载导航应用选择
        document.querySelectorAll('input[name="navigationApp"]').forEach(radio => {
            radio.checked = radio.value === this.settings.navigationApp;
        });

        const byokToggle = document.getElementById('advancedByokEnabled');
        const byokKeys = this.readAdvancedByokKeys();
        if (byokToggle) {
            byokToggle.disabled = PublicConfig.allowAdvancedByok !== true;
            byokToggle.checked = PublicConfig.allowAdvancedByok === true && this.settings.advancedByokEnabled === true;
        }
        const byokInputs = {
            gaode: document.getElementById('gaodeSdkPublicKeyInput'),
            google: document.getElementById('googleSdkPublicKeyInput'),
            tianditu: document.getElementById('tiandituSdkPublicKeyInput')
        };
        Object.entries(byokInputs).forEach(([provider, input]) => {
            if (input) input.value = byokKeys[provider] || '';
        });
        this.updateAdvancedByokVisibility();

        // 加载导航偏好设置
        if (this.settings.preferences) {
            const openInNewTabCheckbox = document.getElementById('openInNewTab');
            const showNavigationHintCheckbox = document.getElementById('showNavigationHint');
            const showShowInMapButtonCheckbox = document.getElementById('showShowInMapButton');
            const showNavigateToButtonCheckbox = document.getElementById('showNavigateToButton');

            if (openInNewTabCheckbox) {
                openInNewTabCheckbox.checked = this.settings.preferences.openInNewTab !== false;
            }
            if (showNavigationHintCheckbox) {
                showNavigationHintCheckbox.checked = this.settings.preferences.showNavigationHint !== false;
            }
            if (showShowInMapButtonCheckbox) {
                showShowInMapButtonCheckbox.checked = this.settings.preferences.showShowInMapButton !== false;
            }
            if (showNavigateToButtonCheckbox) {
                showNavigateToButtonCheckbox.checked = this.settings.preferences.showNavigateToButton !== false;
            }
        }
    }

    // 保存设置
    saveSettings() {
        const currentSelectedMapApi = this.settings.selectedMapApi;
        const currentSelectedApiKey = this.getPublicSdkKey(currentSelectedMapApi);

        // 保存地图API选择设置
        const selectedMapApi = document.querySelector('input[name="selectedMapApi"]:checked');
        if (selectedMapApi) {
            this.settings.selectedMapApi = selectedMapApi.value;
        }

        // 保存导航应用设置
        const selectedApp = document.querySelector('input[name="navigationApp"]:checked');
        if (selectedApp) {
            this.settings.navigationApp = selectedApp.value;
        }

        const byokToggle = document.getElementById('advancedByokEnabled');
        this.settings.advancedByokEnabled = PublicConfig.allowAdvancedByok === true && byokToggle?.checked === true;
        if (this.settings.advancedByokEnabled) {
            this.writeAdvancedByokKeys({
                gaode: document.getElementById('gaodeSdkPublicKeyInput')?.value.trim() || '',
                google: document.getElementById('googleSdkPublicKeyInput')?.value.trim() || '',
                tianditu: document.getElementById('tiandituSdkPublicKeyInput')?.value.trim() || ''
            });
        } else {
            sessionStorage.removeItem('travelPlannerAdvancedByok');
        }

        // 保存导航偏好设置
        const openInNewTabCheckbox = document.getElementById('openInNewTab');
        const showNavigationHintCheckbox = document.getElementById('showNavigationHint');
        const showShowInMapButtonCheckbox = document.getElementById('showShowInMapButton');
        const showNavigateToButtonCheckbox = document.getElementById('showNavigateToButton');

        if (!this.settings.preferences) {
            this.settings.preferences = {};
        }

        if (openInNewTabCheckbox) {
            this.settings.preferences.openInNewTab = openInNewTabCheckbox.checked;
        }
        if (showNavigationHintCheckbox) {
            this.settings.preferences.showNavigationHint = showNavigationHintCheckbox.checked;
        }
        if (showShowInMapButtonCheckbox) {
            this.settings.preferences.showShowInMapButton = showShowInMapButtonCheckbox.checked;
        }
        if (showNavigateToButtonCheckbox) {
            this.settings.preferences.showNavigateToButton = showNavigateToButtonCheckbox.checked;
        }

        // 保存到本地存储
        this.saveData();

        // 检查地图API相关变化
        const newSelectedMapApi = this.settings.selectedMapApi;
        const newSelectedApiKey = this.getPublicSdkKey(newSelectedMapApi);
        if (newSelectedMapApi !== currentSelectedMapApi) {
            // Provider 是搜索上下文的一部分。立即取消旧 Provider 的请求，
            // 即使稍后因地图 SDK 变化而刷新页面，旧结果也不能重新出现。
            this.searchController.contextChanged();
            this.taskGenerations.begin('distance');
            this.taskGenerations.begin('route');
            this.routeResultSignature = '';
        }
        const isSelectedMapApiLoaded = () => {
            switch (newSelectedMapApi) {
                case 'google':
                    return typeof google !== 'undefined' && google.maps;
                case 'gaode':
                    return typeof AMap !== 'undefined';
                case 'tianditu':
                    return typeof T !== 'undefined' && T.Map;
                case 'azure':
                    return false;
                default:
                    return false;
            }
        };

        // 检查是否需要重新加载地图
        const needsReload = (
            // 地图API选择变化
            newSelectedMapApi !== currentSelectedMapApi ||
            // 当前选中地图服务的API密钥变化
            newSelectedApiKey !== currentSelectedApiKey ||
            // 选择了真实地图API但脚本尚未加载
            (newSelectedApiKey && !isSelectedMapApiLoaded()) ||
            // 当前地图正在使用真实API，但选中服务的密钥被移除
            (!newSelectedApiKey && this.isMapLoaded)
        );

        if (needsReload) {
            this.showToast('设置已保存，页面将刷新以应用更改...');
            setTimeout(() => {
                window.location.reload();
            }, 2000);
        } else {
            this.showToast('设置已保存');
        }

        this.closeSettingsModal();
    }

    updateAdvancedByokVisibility() {
        const toggle = document.getElementById('advancedByokEnabled');
        const fields = document.getElementById('advancedByokFields');
        if (!fields) return;
        fields.hidden = !(PublicConfig.allowAdvancedByok === true && toggle?.checked === true);
    }

    readAdvancedByokKeys() {
        if (PublicConfig.allowAdvancedByok !== true) return {};
        try {
            const value = JSON.parse(sessionStorage.getItem('travelPlannerAdvancedByok') || '{}');
            return value && typeof value === 'object' ? value : {};
        } catch (error) {
            sessionStorage.removeItem('travelPlannerAdvancedByok');
            return {};
        }
    }

    writeAdvancedByokKeys(keys) {
        if (PublicConfig.allowAdvancedByok !== true) return;
        const clean = {};
        ['gaode', 'google', 'tianditu'].forEach(provider => {
            clean[provider] = String(keys?.[provider] || '').replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 200);
        });
        sessionStorage.setItem('travelPlannerAdvancedByok', JSON.stringify(clean));
    }

    // 仅用于加载地图渲染 SDK；Web Service 凭据不存在于浏览器数据模型中。
    getPublicSdkKey(provider) {
        const normalizedProvider = String(provider || '');
        if (!ClientSecurity.PROVIDERS.includes(normalizedProvider)) return null;
        if (PublicConfig.allowAdvancedByok === true && this.settings.advancedByokEnabled === true) {
            const byok = this.readAdvancedByokKeys()[normalizedProvider];
            if (byok) return byok;
        }
        const configured = PublicConfig.sdkPublicKeys?.[normalizedProvider];
        return configured ? String(configured) : null;
    }

    // 设置菜单切换功能
    setupSettingsMenuToggle() {
        const tablist = document.querySelector('.settings-menu[role="tablist"]');
        if (!tablist) return;
        const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
        tabs.forEach(tab => {
            tab.addEventListener('click', () => this.activateSettingsTab(tab));
            tab.addEventListener('keydown', event => {
                const currentIndex = tabs.indexOf(tab);
                let nextIndex = null;
                if (['ArrowDown', 'ArrowRight'].includes(event.key)) nextIndex = (currentIndex + 1) % tabs.length;
                if (['ArrowUp', 'ArrowLeft'].includes(event.key)) nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
                if (event.key === 'Home') nextIndex = 0;
                if (event.key === 'End') nextIndex = tabs.length - 1;
                if (nextIndex === null) return;
                event.preventDefault();
                this.activateSettingsTab(tabs[nextIndex], { focus: true });
            });
        });
    }

    activateSettingsTab(activeTab, options = {}) {
        const tabs = Array.from(document.querySelectorAll('.settings-menu [role="tab"]'));
        const panels = Array.from(document.querySelectorAll('.settings-panel[role="tabpanel"]'));
        tabs.forEach(tab => {
            const selected = tab === activeTab;
            tab.classList.toggle('active', selected);
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
        });
        panels.forEach(panel => {
            const selected = panel.id === activeTab.getAttribute('aria-controls');
            panel.classList.toggle('active', selected);
            panel.hidden = !selected;
        });
        if (activeTab.dataset.panel === 'version') this.updateVersionInfo();
        if (options.focus) activeTab.focus();
    }

    // 获取当前版本号
    getCurrentVersion() {
        const versionHistory = this.generateVersionHistory();
        return versionHistory.length > 0 ? versionHistory[0].version : '1.0.0';
    }

    // 更新版本信息
    updateVersionInfo() {
        // 基于手动维护的更新记录生成版本历史
        const versionHistory = this.generateVersionHistory();
        const currentVersion = this.getCurrentVersion();

        // 更新设置面板中的当前版本显示
        const currentVersionElement = document.querySelector('#current-version-text');
        if (currentVersionElement) {
            currentVersionElement.textContent = `当前版本：${currentVersion}`;
        }

        // 更新页面顶部的版本显示
        const headerVersionElement = document.querySelector('#header-version');
        if (headerVersionElement) {
            headerVersionElement.textContent = `v${currentVersion} - 探索世界，规划你的完美旅程`;
        }

        // 更新版本历史列表
        const versionListElement = document.querySelector('.version-list');
        if (versionListElement) {
            const groupedVersions = [];
            versionHistory.forEach(item => {
                const changeTypeClass = item.type === 'feature' ? 'feature' :
                    item.type === 'fix' ? 'fix' : 'optimize';
                const changeTypeText = item.type === 'feature' ? '新增' :
                    item.type === 'fix' ? '修复' : '优化';

                let group = groupedVersions[groupedVersions.length - 1];
                if (!group || group.version !== item.version) {
                    group = { version: item.version, items: [] };
                    groupedVersions.push(group);
                }
                group.items.push({
                    type: item.type,
                    text: item.text,
                    changeTypeClass: changeTypeClass,
                    changeTypeText: changeTypeText
                });
            });

            const fragment = document.createDocumentFragment();
            groupedVersions.forEach(group => {
                fragment.appendChild(this.generateVersionHtml(group.version, group.items));
            });
            versionListElement.replaceChildren(fragment);
        }
    }

    // 生成版本历史（基于手动维护的更新记录）
    generateVersionHistory() {
        // 📝 手动版本更新记录管理说明：
        // 1. 添加新更新：在 updateCommits 数组末尾添加新记录
        // 2. 版本号自动计算：feature类型递增minor版本，fix/optimize递增patch版本
        // 3. 统一格式：{ updates: [{ message: '描述', type: 'feature|fix|optimize' }] }
        // 4. 多项更新：一个版本可包含多个updates，使用相同版本号
        // 5. 时间顺序：按从旧到新排列，最新的放在数组末尾

        // 手动维护的版本更新记录（按时间顺序从旧到新）
        // 💡 添加新版本示例：
        // 单项更新：{ updates: [{ message: '新增XXX功能', type: 'feature' }] }
        // 多项更新：{ updates: [
        //     { message: '新增XXX功能', type: 'feature' },
        //     { message: '修复XXX问题', type: 'fix' }
        // ]}
        const updateCommits = [
            // 1.1.0
            { updates: [{ message: '初版', type: 'feature' }] },
            // 1.1.1
            { updates: [{ message: '添加页脚，优化显示策略', type: 'optimize' }] },
            // 1.1.2
            { updates: [{ message: '进一步优化显示', type: 'optimize' }] },
            // 1.1.3
            { updates: [{ message: '优化导入导出数据，导入时添加验证处理机制', type: 'optimize' }] },
            // 1.2.0
            { updates: [{ message: '添加方案重名验证', type: 'feature' }] },
            // 1.2.1
            { updates: [{ message: '修复"方案冲突解决中相同数据不显示"', type: 'fix' }] },
            // 1.2.2
            { updates: [{ message: '修复"方案冲突解决界面超出窗口"', type: 'fix' }] },
            // 1.2.3
            { updates: [{ message: '修复"方案冲突解决界面弹出时异位"', type: 'fix' }] },
            // 1.2.4
            { updates: [{ message: '优化几个界面显示', type: 'optimize' }] },
            // 1.3.0
            { updates: [{ message: '添加切换方案时保存提醒', type: 'feature' }] },
            // 1.3.1
            { updates: [{ message: '修复"页面刷新后不显示当前方案"', type: 'fix' }] },
            // 1.3.2
            { updates: [{ message: '移除方案覆盖功能', type: 'optimize' }] },
            // 1.4.0
            { updates: [{ message: '增加方案详情', type: 'feature' }] },
            // 1.5.0
            { updates: [{ message: '增加显示/隐藏待定点按钮', type: 'feature' }] },
            // 1.6.0
            { updates: [{ message: '新增"添加空白游玩点"功能', type: 'feature' }] },
            // 1.6.1
            { updates: [{ message: '修复"编辑空白游玩点时触发距离和时间重计算"', type: 'fix' }] },
            // 1.6.2
            { updates: [{ message: '修复"编辑游玩点会触发地图重置视角"', type: 'fix' }] },
            // 1.7.0
            {
                updates: [
                    { message: '新增高德地图API选择功能', type: 'feature' },
                    { message: '修复"地图API选择功能无法保存"', type: 'fix' },
                    { message: '优化按钮解释文字显示在左侧', type: 'optimize' },
                    { message: '优化版本显示样式，改善内容对齐效果', type: 'optimize' },
                ]
            },
            // 1.7.1
            {
                updates: [
                    { message: '调整默认地图API为高德地图', type: 'optimize' },
                    { message: '优化设置界面中地图API选项显示顺序', type: 'optimize' },
                    { message: '优化高德地图导航URI，改善"我的位置"显示效果', type: 'optimize' },
                    { message: '重构导航功能：高德地图使用动态"我的位置"定位', type: 'optimize' },
                    { message: '省略from参数，让高德地图自动获取实时位置', type: 'optimize' },
                    { message: '分离导航逻辑，优化Google和Bing地图导航体验', type: 'optimize' }
                ]
            },
            // 1.8.0
            {
                updates: [
                    { message: '新增"在导航中显示"按钮，支持在地图中查看游玩点位置', type: 'feature' },
                    { message: '游玩列表和待定列表均支持地图显示功能', type: 'feature' },
                ]
            },
            // 1.8.1
            {
                updates: [
                    { message: '优化导航功能：桌面设备使用浏览器定位，移动设备使用地图应用定位', type: 'optimize' },
                    { message: '修复电脑端高德导航起点丢失问题', type: 'fix' },
                    { message: '新增设备类型智能检测，自动选择最优导航策略', type: 'optimize' }
                ]
            },
            // 1.8.2
            {
                updates: [
                    { message: '统一设置窗口尺寸，修复切换菜单时窗口大小变化问题', type: 'fix' },
                    { message: '设置固定窗口高度，以版本详情面板为标准统一所有面板尺寸', type: 'optimize' },
                    { message: '优化移动端设置界面尺寸适配', type: 'optimize' },
                    { message: '修复版本详情面板双滚动条问题，统一使用外层滚动条', type: 'fix' }
                ]
            },
            // 1.9.0
            {
                updates: [
                    { message: '新增移动端紧凑模式，隐藏页头页脚获得更多显示空间', type: 'feature' },
                    { message: '缩小移动端字体和间距，优化空间利用率', type: 'optimize' },
                    { message: '添加浮动切换按钮，便于退出紧凑模式', type: 'feature' },
                    { message: '支持紧凑模式状态记忆，重新访问时自动恢复', type: 'feature' }
                ]
            },
            // 1.9.1
            {
                updates: [
                    { message: '进一步优化紧凑模式字体和布局，最大化空间利用', type: 'optimize' },
                    { message: '大幅缩小地图控制按钮和图例尺寸，节省更多显示空间', type: 'optimize' },
                    { message: '优化游玩列表空间比例，从42vh调整为40vh', type: 'optimize' },
                    { message: '全面优化搜索结果、路线卡片等所有界面元素尺寸', type: 'optimize' }
                ]
            },
            // 1.9.2
            {
                updates: [
                    { message: '修复紧凑模式下Toast消息占用整屏问题', type: 'fix' },
                    { message: '优化Toast位置为底部居中显示，限制最大宽度200px', type: 'optimize' },
                    { message: '新增消息简化系统，紧凑模式下显示更简短的提示', type: 'optimize' },
                    { message: '缩短紧凑模式下Toast显示时间，减少界面干扰', type: 'optimize' }
                ]
            },
            // 1.10.0
            {
                updates: [
                    { message: '新增API调用缓存系统，减少重复API调用提升性能', type: 'feature' },
                    { message: '实现距离计算防抖优化，避免频繁重复计算', type: 'optimize' },
                    { message: '添加搜索结果缓存，相同关键词复用之前的搜索结果', type: 'optimize' },
                    { message: '智能检测列表变化，避免不必要的距离重新计算', type: 'feature' }
                ]
            },
            // 1.11.0
            {
                updates: [
                    { message: '引入 CSS 变量系统，优化样式可维护性', type: 'feature' },
                    { message: '重构全局样式，提高主题定制灵活性', type: 'optimize' }
                ]
            },
            // 1.12.0
            {
                updates: [
                    { message: '增强安全性，全面引入 XSS 防护机制', type: 'feature' },
                    { message: '优化 DOM 渲染逻辑，统一列表渲染函数', type: 'optimize' }
                ]
            },
            // 1.12.1
            {
                updates: [
                    { message: '实现搜索与自动保存的防抖处理，降低系统负载', type: 'optimize' }
                ]
            },
            // 1.13.0
            {
                updates: [
                    { message: '新增地点名称智能避让系统，多维度自动寻找最优显示位置', type: 'feature' },
                    { message: '添加动态虚线牵引功能，清晰关联名称标签与地图图标', type: 'feature' },
                    { message: '优化标签排列算法，优先就近显示并防止遮挡图标', type: 'optimize' },
                    { message: '修复由于初始化逻辑冗余导致的游玩点名称重复显示问题', type: 'fix' }
                ]
            },
            // 1.14.0
            {
                updates: [
                    { message: '新增天地图API集成，支持使用天地图作为地图显示和路线规划服务', type: 'feature' },
                    { message: '在设置中增加天地图API密钥配置', type: 'feature' },
                    { message: '支持使用天地图进行导航', type: 'feature' }
                ]
            },
            // 1.15.0
            {
                updates: [
                    { message: '新增版本化应用壳缓存，加快重复访问时的静态资源加载', type: 'feature' },
                    { message: '移除地图初始化前的固定等待时间，页面就绪后立即加载地图SDK', type: 'optimize' },
                    { message: '根据所选地图服务提前建立网络连接，缩短地图首次出现时间', type: 'optimize' }
                ]
            },
            // 1.15.1
            {
                updates: [
                    { message: '增加搜索重置按钮，可一键清空搜索内容和结果', type: 'optimize' },
                    { message: '增强天地图路线对比度，使用深色描边和高亮主线凸显路线', type: 'optimize' },
                    { message: '重置搜索时忽略尚未返回的旧请求，避免结果再次出现', type: 'fix' }
                ]
            },
            // 1.16.0
            {
                updates: [
                    { message: '完成P0级XSS治理，移除主页面HTML字符串注入和内联事件处理器', type: 'feature' },
                    { message: '新增地图SDK统一安全渲染器与分享HTML上下文编码', type: 'feature' },
                    { message: '启用强制脚本CSP并提供Report-Only和Trusted Types评估配置', type: 'feature' }
                ]
            }
        ];

        // 版本号生成规则：1.a.b
        // a: 二级更新（新增/增加）的次数
        // b: 三级更新（优化/修复）的次数
        let major = 1;
        let minor = 0;
        let patch = 0;
        let currentMinor = 0;
        let currentPatch = 0;

        const versionHistory = [];

        updateCommits.forEach((commit, index) => {
            // 统一处理：所有commit都使用updates数组格式
            const updates = commit.updates || [];

            // 根据最高优先级的类型确定版本号增长
            const hasFeature = updates.some(update => update.type === 'feature');
            const hasFix = updates.some(update => update.type === 'fix');
            const hasOptimize = updates.some(update => update.type === 'optimize');

            // 版本号增长策略：有feature就增加minor，否则增加patch
            if (hasFeature) {
                currentMinor++;
                minor = currentMinor;
                patch = 0;
                currentPatch = 0;
            } else if (hasFix || hasOptimize) {
                currentPatch++;
                patch = currentPatch;
            }

            const version = `${major}.${minor}.${patch}`;

            // 为所有更新项创建历史记录，使用相同的版本号
            updates.forEach((update, updateIndex) => {
                versionHistory.push({
                    version: version,
                    type: update.type,
                    text: update.message,
                    isMultiple: updates.length > 1,
                    updateIndex: updateIndex,
                    updateTotal: updates.length
                });
            });
        });

        // 按时间倒序排列（最新版本在前）
        return versionHistory.reverse();
    }

    // 生成版本更新 DOM；版本文本即使未来来自远端也只进入 textContent。
    generateVersionHtml(version, versionItems) {
        const fragment = document.createDocumentFragment();
        if (versionItems.length === 0) return fragment;

        const isMultiple = versionItems.length > 1;
        const versionClass = isMultiple ? 'version-item multiple-updates' : 'version-item single-update';
        const versionElement = this.createElement('div', { className: versionClass });
        const header = this.createElement('div', { className: 'version-header' });
        header.appendChild(this.createElement('span', { className: 'version-number', text: version }));
        if (isMultiple) {
            header.appendChild(this.createElement('span', {
                className: 'update-indicator',
                text: `${versionItems.length}项更新`
            }));
        }

        const content = this.createElement('div', { className: 'version-content' });
        versionItems.forEach(item => {
            const changes = this.createElement('div', { className: 'version-changes' });
            changes.append(
                this.createElement('span', {
                    className: `change-type ${item.changeTypeClass}`,
                    text: item.changeTypeText
                }),
                this.createElement('span', { className: 'change-text', text: item.text })
            );
            content.appendChild(changes);
        });

        versionElement.append(header, content);
        return versionElement;
    }



    // 编辑游玩点
    editPlace(placeId) {
        const place = this.travelList.find(p => p.id.toString() === placeId);
        if (!place) return;

        // 存储当前编辑的游玩点
        this.currentEditPlace = place;

        // 设置模态框内容
        document.getElementById('editOriginalName').textContent = place.name;
        document.getElementById('editOriginalAddress').textContent = place.address;
        document.getElementById('customNameInput').value = place.customName || '';
        document.getElementById('notesInput').value = place.notes || '';

        this.dialogManager.open('editPlaceModal', {
            initialFocus: '#customNameInput',
            onRequestClose: () => this.closeEditPlaceModal()
        });
    }

    // 关闭编辑游玩点模态框
    closeEditPlaceModal() {
        this.dialogManager.close('editPlaceModal');
        this.currentEditPlace = null;

        // 清空表单
        document.getElementById('customNameInput').value = '';
        document.getElementById('notesInput').value = '';
    }

    // 保存编辑的游玩点
    saveEditPlace() {
        if (!this.currentEditPlace) return;

        // 保存关闭弹窗后仍需使用的引用和名称，避免 closeEditPlaceModal 将对象置空后再访问。
        const editedPlace = this.currentEditPlace;
        const customName = document.getElementById('customNameInput').value.trim();
        const notes = document.getElementById('notesInput').value.trim();
        let displayName;
        if (Array.isArray(this.travelList)) {
            const preview = { ...editedPlace };
            displayName = PlannerData.applyPlaceEdit(preview, customName, notes).displayName;
            this.dispatch({ type: 'EDIT_PLACE', id: editedPlace.id, customName, notes });
        } else {
            // 仅供无完整应用状态的嵌入式调用兼容；正式业务状态只走 dispatch。
            displayName = PlannerData.applyPlaceEdit(editedPlace, customName, notes).displayName;
            this.updateTravelListWithoutRecalculation?.();
            this.recreateMarkers?.();
            this.markAsModified?.();
            this.saveData?.();
        }

        // 关闭模态框
        this.closeEditPlaceModal();

        // 显示成功提示
        this.showToast(`已更新游玩点：${displayName}`);
    }

    // 切换游玩点状态（游玩 ↔ 待定）
    togglePlaceStatus(placeId) {
        const place = this.travelList.find(p => p.id.toString() === placeId);
        if (!place) return;

        const displayName = place.customName || place.name;

        const willBePending = !place.isPending;
        this.dispatch({ type: 'TOGGLE_PLACE_STATUS', id: placeId });

        if (willBePending) {
            this.showToast(`"${displayName}" 已移至待定列表`);
        } else {
            this.showToast(`"${displayName}" 已加入游玩列表`);
        }
    }

    // 添加当前地点到游玩列表
    addCurrentPlaceToList() {
        if (!this.currentPlace) return;

        // 检查是否已存在
        const exists = this.travelList.some(item =>
            Math.abs(item.lng - this.currentPlace.lng) < 0.0001 &&
            Math.abs(item.lat - this.currentPlace.lat) < 0.0001
        );

        if (exists) {
            alert('该地点已在游玩列表中！');
            return;
        }

        const newPlace = {
            id: Date.now(),
            name: this.currentPlace.name,
            address: this.currentPlace.address,
            lng: this.currentPlace.lng,
            lat: this.currentPlace.lat,
            customName: null, // 自定义名称
            notes: null, // 备注信息
            isPending: false // 是否为待定状态
        };

        this.dispatch({ type: 'ADD_PLACE', place: newPlace });
        this.closeModal();
    }

    // 添加空白游玩点
    addBlankPlace() {
        const blankPlace = {
            id: Date.now(),
            name: '新游玩点',
            address: '手动添加，无地理信息',
            lng: null, // 没有经度
            lat: null, // 没有纬度
            customName: null, // 自定义名称
            notes: null, // 备注信息
            isPending: false, // 默认为激活状态
            isBlank: true // 标记为空白地点
        };

        this.dispatch({ type: 'ADD_BLANK_PLACE', place: blankPlace });

        this.showToast('已添加空白游玩点，请编辑名称和备注');

        // 自动打开编辑模态框
        setTimeout(() => {
            this.editPlace(blankPlace.id.toString());
        }, 100);
    }

    createActionButton(action, text, title, className = 'action-btn', attributes = {}) {
        return this.createElement('button', {
            className,
            text,
            title,
            type: 'button',
            dataset: { action },
            attributes: { 'aria-label': title, ...attributes }
        });
    }

    // 用户、地图和导入数据只进入 textContent；行为由列表容器统一委托。
    createPlaceItemElement(place, options = {}) {
        const { isPending = false, displayOrder = '', activeIndex = -1, activeCount = 0 } = options;
        const displayName = String(place.customName || place.name || '');
        const itemClass = isPending ? 'pending-item' : `travel-item${place.isBlank ? ' blank-item' : ''}`;
        const item = this.createElement('li', {
            className: itemClass,
            dataset: { id: String(place.id) }
        });
        if (!isPending) item.draggable = true;

        const header = this.createElement('div', {
            className: isPending ? 'pending-item-header' : 'travel-item-header'
        });
        const left = this.createElement('div', {
            className: isPending ? 'pending-item-left' : 'travel-item-left'
        });
        if (!isPending) {
            left.appendChild(this.createElement('span', {
                className: 'drag-handle',
                text: '⠿',
                attributes: { 'aria-hidden': 'true' }
            }));
        }
        if (displayOrder !== '') {
            left.appendChild(this.createElement('span', { className: 'travel-item-order', text: displayOrder }));
        }
        left.appendChild(this.createElement('span', {
            className: isPending ? 'pending-item-name' : 'travel-item-name',
            text: displayName
        }));
        header.appendChild(left);
        if (!isPending) {
            const reorderControls = this.createElement('div', {
                className: 'reorder-controls',
                attributes: { role: 'group', 'aria-label': `${displayName}排序操作` }
            });
            reorderControls.append(
                this.createActionButton(
                    'move-up',
                    '↑',
                    `将“${displayName}”上移`,
                    'reorder-btn',
                    { disabled: undefined }
                ),
                this.createActionButton(
                    'move-down',
                    '↓',
                    `将“${displayName}”下移`,
                    'reorder-btn'
                )
            );
            reorderControls.firstElementChild.disabled = activeIndex <= 0;
            reorderControls.lastElementChild.disabled = activeIndex < 0 || activeIndex >= activeCount - 1;
            header.appendChild(reorderControls);
        }

        const address = this.createElement('div', {
            className: isPending ? 'pending-item-address' : 'travel-item-address',
            text: `📮 ${String(place.address || '')}`
        });

        const actions = this.createElement('div', {
            className: isPending ? 'pending-item-actions' : 'travel-item-actions'
        });
        actions.appendChild(this.createActionButton(
            'toggle-status',
            isPending ? '⏳ 待定' : '🎯 游玩',
            isPending ? '加入游玩列表' : '移至待定',
            isPending ? 'pending-btn' : 'activate-btn',
            {
                'aria-label': `游玩地点：${displayName}`,
                'aria-pressed': String(!isPending)
            }
        ));

        if (PlannerData.isValidCoordinate(place)) {
            actions.appendChild(this.createActionButton('locate', '📍', '在地图上定位', 'action-btn locate-btn'));
            if (this.settings.preferences.showShowInMapButton) {
                actions.appendChild(this.createActionButton('show-in-map', '🗺️', '在导航中显示', 'action-btn show-in-map-btn'));
            }
            if (!isPending && this.settings.preferences.showNavigateToButton) {
                actions.appendChild(this.createActionButton('navigate-to', '🧭', '导航到此处', 'action-btn navigate-to-btn'));
            }
        }

        actions.append(
            this.createActionButton('edit', '✏️', '编辑游玩点', 'action-btn edit-btn'),
            this.createActionButton('copy-name', '📋', '复制名称', 'action-btn copy-btn'),
            this.createActionButton('copy-address', '📄', '复制地址', 'action-btn copy-btn'),
            this.createActionButton('remove', '✕', '删除')
        );

        item.append(header, address);
        if (place.notes) {
            item.appendChild(this.createElement('div', {
                className: isPending ? 'pending-item-notes' : 'travel-item-notes',
                text: String(place.notes)
            }));
        }
        item.appendChild(actions);
        return item;
    }

    createRouteSegmentElement(place, previousPlace, index, distanceText, durationText) {
        const segment = this.createElement('li', { className: 'route-segment' });
        const connector = this.createElement('div', { className: 'route-connector' });
        const hasCoordinates = PlannerData.isValidCoordinate(place) && PlannerData.isValidCoordinate(previousPlace);

        if (hasCoordinates && !place.isBlank) {
            const segmentKey = `${String(previousPlace.id)}-${String(place.id)}`;

            connector.appendChild(this.createElement('div', { className: 'route-line' }));
            const card = this.createElement('div', { className: 'route-info-card compact' });
            const routeInfo = this.createElement('div', { className: 'route-info' });
            const distance = this.createElement('span', { className: 'distance-info', text: '🚗 ' });
            const distanceValue = this.createElement('span', { text: distanceText });
            distanceValue.id = `distance-${String(place.id)}`;
            distance.appendChild(distanceValue);
            const duration = this.createElement('span', { className: 'duration-info', text: '⏱️ ' });
            const durationValue = this.createElement('span', { text: durationText });
            durationValue.id = `duration-${String(place.id)}`;
            duration.appendChild(durationValue);
            routeInfo.append(distance, duration);

            const navigate = this.createActionButton('navigate-route', '🧭', '打开导航', 'navigate-btn compact');
            navigate.dataset.segmentKey = segmentKey;
            navigate.dataset.fromIndex = String(index - 1);
            navigate.dataset.toIndex = String(index);
            card.append(routeInfo, navigate);
            connector.appendChild(card);
        } else {
            connector.appendChild(this.createElement('div', { className: 'route-line no-coordinates' }));
            const card = this.createElement('div', { className: 'route-info-card compact disabled' });
            const routeInfo = this.createElement('div', { className: 'route-info' });
            routeInfo.appendChild(this.createElement('span', {
                className: 'distance-info',
                text: `📍 ${place.isBlank ? '空白地点' : '无地理信息'}`
            }));
            card.appendChild(routeInfo);
            connector.appendChild(card);
        }

        segment.appendChild(connector);
        return segment;
    }

    // 更新游玩列表显示
    updateTravelList() {
        this.renderTravelListsIncremental();
        this.syncMarkersIncremental();
        this.updateCityFilterButton();
    }

    // 更新游玩列表显示（不触发距离重新计算）
    updateTravelListWithoutRecalculation() {
        this.renderTravelListsIncremental();
        this.syncMarkersIncremental();
        this.updateCityFilterButton();
    }

    routeMetricDisplay(fromPlace, toPlace) {
        if (!PlannerData.isUsablePlace(fromPlace) || !PlannerData.isUsablePlace(toPlace)) {
            return { distanceText: '无地理信息', durationText: '无法计算' };
        }

        const segmentKey = `${fromPlace.id}-${toPlace.id}`;
        const metrics = this.routeMetrics?.get(segmentKey);
        const result = this.routeResults?.get(segmentKey);
        const matchesCurrentCoordinates = result &&
            Number(result.origin?.lat).toFixed(5) === Number(fromPlace?.lat).toFixed(5) &&
            Number(result.origin?.lng).toFixed(5) === Number(fromPlace?.lng).toFixed(5) &&
            Number(result.destination?.lat).toFixed(5) === Number(toPlace?.lat).toFixed(5) &&
            Number(result.destination?.lng).toFixed(5) === Number(toPlace?.lng).toFixed(5);
        if (!metrics || !matchesCurrentCoordinates) {
            return { distanceText: '计算中...', durationText: '计算中...' };
        }
        const estimated = result?.source !== 'provider';
        return {
            distanceText: `${(metrics.distanceMeters / 1000).toFixed(1)} 公里${estimated ? ' (直线估算)' : ''}`,
            durationText: `${estimated ? '约' : ''}${Math.round(metrics.durationSeconds / 60)} 分钟`
        };
    }

    createActiveListDescriptors(activePlaces) {
        if (activePlaces.length === 0) {
            return [{
                key: 'empty:active',
                signature: 'empty:active:v1',
                create: () => this.createElement('li', { className: 'empty-active', text: '暂无游玩地点' })
            }];
        }

        const descriptors = [];
        let nonBlankIndex = 0;
        let previousUsable = null;
        activePlaces.forEach((place, index) => {
            if (index > 0) {
                const segmentFrom = previousUsable;
                const segmentPlace = place;
                const segmentIndex = index;
                const metric = this.routeMetricDisplay(segmentFrom, segmentPlace);
                const segmentKey = `segment:${segmentFrom ? String(segmentFrom.id) : 'none'}:${String(segmentPlace.id)}`;
                const signature = JSON.stringify([
                    segmentKey,
                    PlannerData.isValidCoordinate(segmentPlace),
                    segmentFrom ? `${segmentFrom.lat},${segmentFrom.lng}` : '',
                    `${segmentPlace.lat},${segmentPlace.lng}`,
                    metric.distanceText,
                    metric.durationText
                ]);
                descriptors.push({
                    key: segmentKey,
                    signature,
                    create: () => this.createRouteSegmentElement(
                        segmentPlace,
                        segmentFrom,
                        segmentIndex,
                        metric.distanceText,
                        metric.durationText
                    )
                });
            }

            const displayOrder = place.isBlank ? '✏️' : ++nonBlankIndex;
            const placeKey = `place:${String(place.id)}`;
            const signature = JSON.stringify([
                placeKey,
                displayOrder,
                place.name,
                place.customName,
                place.address,
                place.notes,
                place.isBlank,
                index,
                activePlaces.length,
                this.settings.preferences
            ]);
            descriptors.push({
                key: placeKey,
                signature,
                create: () => this.createPlaceItemElement(place, {
                    isPending: false,
                    displayOrder,
                    activeIndex: index,
                    activeCount: activePlaces.length
                })
            });
            if (PlannerData.isUsablePlace(place)) previousUsable = place;
        });
        return descriptors;
    }

    createPendingListDescriptors(pendingPlaces) {
        if (pendingPlaces.length === 0) {
            return [{
                key: 'empty:pending',
                signature: 'empty:pending:v1',
                create: () => this.createElement('li', { className: 'empty-pending', text: '暂无待定地点' })
            }];
        }
        return pendingPlaces.map(place => ({
            key: `pending:${String(place.id)}`,
            signature: JSON.stringify([
                place.id,
                place.name,
                place.customName,
                place.address,
                place.notes,
                place.lat,
                place.lng,
                this.settings.preferences
            ]),
            create: () => this.createPlaceItemElement(place, { isPending: true })
        }));
    }

    renderTravelListsIncremental() {
        const activePlaces = this.travelList.filter(place => !place.isPending);
        const pendingPlaces = this.travelList.filter(place => place.isPending);
        const activeResult = PerformanceCore.reconcileKeyedChildren(
            document.getElementById('travelList'),
            this.createActiveListDescriptors(activePlaces)
        );
        const pendingResult = PerformanceCore.reconcileKeyedChildren(
            document.getElementById('pendingList'),
            this.createPendingListDescriptors(pendingPlaces)
        );
        if (this.performanceMetrics) {
            this.performanceMetrics.listNodesCreated += activeResult.created + pendingResult.created;
            this.performanceMetrics.listNodesReused += activeResult.reused + pendingResult.reused;
        }
        this.setupDragAndDrop();
    }

    // 更新游玩列表（激活状态的地点，保留现有距离信息）
    updateActiveListWithoutRecalculation(activePlaces) {
        const listContainer = document.getElementById('travelList');

        if (activePlaces.length === 0) {
            listContainer.replaceChildren(this.createElement('li', { className: 'empty-active', text: '暂无游玩地点' }));
            return;
        }

        // 保存现有的距离信息
        const existingDistances = {};
        const existingDurations = {};

        activePlaces.forEach(place => {
            const distanceElement = document.getElementById(`distance-${place.id}`);
            const durationElement = document.getElementById(`duration-${place.id}`);

            if (distanceElement) {
                existingDistances[place.id] = distanceElement.textContent;
            }
            if (durationElement) {
                existingDurations[place.id] = durationElement.textContent;
            }
        });

        const fragment = document.createDocumentFragment();
        let nonBlankIndex = 0; // 非空白地点的序号计数器

        activePlaces.forEach((place, index) => {
            // 如果不是第一个地点，先显示距离信息
            if (index > 0) {
                // 找到前一个非空白地点来计算距离
                let prevNonBlankPlace = null;
                for (let i = index - 1; i >= 0; i--) {
                    if (PlannerData.isUsablePlace(activePlaces[i])) {
                        prevNonBlankPlace = activePlaces[i];
                        break;
                    }
                }

                fragment.appendChild(this.createRouteSegmentElement(
                    place,
                    prevNonBlankPlace,
                    index,
                    existingDistances[place.id] || '保持原值',
                    existingDurations[place.id] || '保持原值'
                ));
            }

            // 只为非空白地点分配序号
            let displayOrder = '';
            if (!place.isBlank) {
                nonBlankIndex++;
                displayOrder = nonBlankIndex;
            } else {
                displayOrder = '✏️'; // 空白地点显示编辑图标
            }

            fragment.appendChild(this.createPlaceItemElement(place, {
                isPending: false,
                displayOrder,
                activeIndex: index,
                activeCount: activePlaces.length
            }));
        });

        listContainer.replaceChildren(fragment);
    }

    // 更新游玩列表（激活状态的地点）
    updateActiveList(activePlaces) {
        const listContainer = document.getElementById('travelList');

        if (activePlaces.length === 0) {
            listContainer.replaceChildren(this.createElement('li', { className: 'empty-active', text: '暂无游玩地点' }));
            return;
        }

        const fragment = document.createDocumentFragment();
        let nonBlankIndex = 0; // 非空白地点的序号计数器

        activePlaces.forEach((place, index) => {
            // 如果不是第一个地点，先显示距离信息
            if (index > 0) {
                // 找到前一个非空白地点来计算距离
                let prevNonBlankPlace = null;
                for (let i = index - 1; i >= 0; i--) {
                    if (PlannerData.isUsablePlace(activePlaces[i])) {
                        prevNonBlankPlace = activePlaces[i];
                        break;
                    }
                }
                fragment.appendChild(this.createRouteSegmentElement(
                    place,
                    prevNonBlankPlace,
                    index,
                    '计算中...',
                    '计算中...'
                ));
            }

            // 只为非空白地点分配序号
            let displayOrder = '';
            if (!place.isBlank) {
                nonBlankIndex++;
                displayOrder = nonBlankIndex;
            } else {
                displayOrder = '✏️'; // 空白地点显示编辑图标
            }

            fragment.appendChild(this.createPlaceItemElement(place, {
                isPending: false,
                displayOrder,
                activeIndex: index,
                activeCount: activePlaces.length
            }));
        });

        listContainer.replaceChildren(fragment);
    }

    // 更新待定列表
    updatePendingList(pendingPlaces) {
        const listContainer = document.getElementById('pendingList');

        if (pendingPlaces.length === 0) {
            listContainer.replaceChildren(this.createElement('li', { className: 'empty-pending', text: '暂无待定地点' }));
            return;
        }

        const fragment = document.createDocumentFragment();
        pendingPlaces.forEach((place) => {
            fragment.appendChild(this.createPlaceItemElement(place, { isPending: true }));
        });

        listContainer.replaceChildren(fragment);
    }

    // 设置拖拽功能
    setupDragAndDrop() {
        const items = document.querySelectorAll('.travel-item');
        items.forEach(item => {
            if (item.dataset.dragBound === 'true') return;
            item.dataset.dragBound = 'true';
            item.addEventListener('dragstart', this.handleDragStart.bind(this));
            item.addEventListener('dragover', this.handleDragOver.bind(this));
            item.addEventListener('drop', this.handleDrop.bind(this));
            item.addEventListener('dragend', this.handleDragEnd.bind(this));
        });
    }

    handleDragStart(e) {
        this.draggedElement = e.target;
        e.target.classList.add('dragging');
    }

    handleDragOver(e) {
        e.preventDefault();
    }

    handleDrop(e) {
        e.preventDefault();
        if (this.draggedElement !== e.target) {
            const draggedId = this.draggedElement.dataset.id;
            const targetId = e.target.closest('.travel-item').dataset.id;

            this.reorderTravelList(draggedId, targetId);
        }
    }

    handleDragEnd(e) {
        e.target.classList.remove('dragging');
        this.draggedElement = null;
    }

    // 重新排序游玩列表
    reorderTravelList(draggedId, targetId) {
        const moved = this.getPlaceById(draggedId);
        this.dispatch({ type: 'REORDER_PLACES', draggedId, targetId });
        if (moved) this.announceSortResult(moved, '拖拽');
    }

    movePlaceByOffset(placeId, offset) {
        const activePlaces = this.travelList.filter(place => !place.isPending);
        const currentIndex = activePlaces.findIndex(place => String(place.id) === String(placeId));
        const targetIndex = currentIndex + offset;
        if (currentIndex < 0 || targetIndex < 0 || targetIndex >= activePlaces.length) return;

        const moved = activePlaces[currentIndex];
        const target = activePlaces[targetIndex];
        this.dispatch({ type: 'REORDER_PLACES', draggedId: moved.id, targetId: target.id });
        this.announceSortResult(moved, offset < 0 ? '上移' : '下移');
        requestAnimationFrame(() => {
            const item = Array.from(document.querySelectorAll('#travelList .travel-item'))
                .find(element => element.dataset.id === String(placeId));
            const preferred = item?.querySelector(`[data-action="${offset < 0 ? 'move-up' : 'move-down'}"]`);
            const focusTarget = preferred && !preferred.disabled
                ? preferred
                : item?.querySelector('.reorder-btn:not(:disabled)');
            focusTarget?.focus();
        });
    }

    announceSortResult(place, action) {
        const activePlaces = this.travelList.filter(candidate => !candidate.isPending);
        const position = activePlaces.findIndex(candidate => String(candidate.id) === String(place.id)) + 1;
        const displayName = String(place.customName || place.name || '地点');
        const message = `${displayName}已${action}至第${position}位，共${activePlaces.length}个游玩地点`;
        const region = document.getElementById('sortStatus');
        if (!region) return;
        region.textContent = '';
        requestAnimationFrame(() => {
            region.textContent = message;
        });
    }

    // 定位地点
    locatePlace(lng, lat) {
        lng = Number(lng);
        lat = Number(lat);
        if (!PlannerData.isValidCoordinate({ lng, lat })) {
            this.showToast('地点坐标无效');
            return;
        }
        console.log(`🎯 定位到地点: ${lng.toFixed(6)}, ${lat.toFixed(6)}`);

        if (this.isMapLoaded) {
            const selectedMapApi = this.settings.selectedMapApi;

            if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                this.map.setCenter({ lat: lat, lng: lng });
                this.map.setZoom(16);
            } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                this.map.setCenter([lng, lat]); // 高德地图使用 [经度, 纬度] 格式
                this.map.setZoom(16);
            } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
                this.map.centerAndZoom(new T.LngLat(lng, lat), 16);
            } else {
                console.warn('地图API未加载，无法在地图上定位');
                this.showToast(`地点坐标: ${lng.toFixed(6)}, ${lat.toFixed(6)}`);
                return;
            }

            // 显示恢复总地图按钮
            this.showReturnToOverviewButton();

            console.log('✅ 地点定位完成');
        } else {
            this.showToast(`地点坐标: ${lng.toFixed(6)}, ${lat.toFixed(6)}`);
        }
    }

    // 复制地点名称
    copyPlaceName(name) {
        navigator.clipboard.writeText(name).then(() => {
            this.showToast(`已复制地点名称: ${name}`);
        }).catch(() => {
            // 降级方案：使用临时输入框
            const textArea = document.createElement('textarea');
            textArea.value = name;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            this.showToast(`已复制地点名称: ${name}`);
        });
    }

    // 复制地点地址
    copyPlaceAddress(address) {
        navigator.clipboard.writeText(address).then(() => {
            this.showToast(`已复制地址: ${address}`);
        }).catch(() => {
            // 降级方案：使用临时输入框
            const textArea = document.createElement('textarea');
            textArea.value = address;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            this.showToast(`已复制地址: ${address}`);
        });
    }

    // 检测是否为移动设备
    isMobileDevice() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
            (navigator.maxTouchPoints && navigator.maxTouchPoints > 2 && /MacIntel/.test(navigator.platform));
    }

    // 从当前位置导航到指定地点
    navigateToPlace(lng, lat, name) {
        lng = Number(lng);
        lat = Number(lat);
        name = String(name ?? '');
        if (!PlannerData.isValidCoordinate({ lng, lat })) {
            this.showToast('地点坐标无效');
            return;
        }

        // 根据用户设置选择导航应用
        const navigationApp = this.settings.navigationApp || 'amap';
        const isMobile = this.isMobileDevice();

        switch (navigationApp) {
            case 'amap':
                if (isMobile) {
                    // 移动设备：省略from参数，让高德地图自动获取"我的位置"作为起点
                    const url = `https://uri.amap.com/navigation?to=${lng},${lat},${encodeURIComponent(name)}&mode=car&policy=1&src=17travelplanner&coordinate=gaode&callnative=1`;
                    this.openNavigationUrl(url, '高德地图', name);
                } else {
                    // 桌面设备：使用浏览器获取位置，避免起点丢失
                    this.navigateWithGeolocation(lng, lat, name, 'amap');
                }
                break;
            case 'google':
                // Google地图需要获取当前位置
                this.navigateWithGeolocation(lng, lat, name, 'google');
                break;
            case 'bing':
                // Bing地图需要获取当前位置
                this.navigateWithGeolocation(lng, lat, name, 'bing');
                break;
            case 'tianditu':
                // 天地图需要获取当前位置
                this.navigateWithGeolocation(lng, lat, name, 'tianditu');
                break;
            default:
                if (isMobile) {
                    // 移动设备：默认使用优化的高德地图URI（省略from参数）
                    const url = `https://uri.amap.com/navigation?to=${lng},${lat},${encodeURIComponent(name)}&mode=car&policy=1&src=17travelplanner&coordinate=gaode&callnative=1`;
                    this.openNavigationUrl(url, '高德地图', name);
                } else {
                    // 桌面设备：使用浏览器获取位置
                    this.navigateWithGeolocation(lng, lat, name, 'amap');
                }
                break;
        }
    }

    // 打开导航URL的通用方法
    openNavigationUrl(url, appName, placeName, actionText = '导航到') {
        const safeUrl = Security.sanitizeUrl(url, {
            allowedHttpsOrigins: [
                'https://uri.amap.com',
                'https://www.google.com',
                'https://www.bing.com',
                'https://map.tianditu.gov.cn'
            ]
        });
        if (!safeUrl) {
            this.showToast('导航链接未通过安全校验');
            return;
        }

        // 根据用户偏好设置决定是否在新标签页中打开
        const openInNewTab = this.settings.preferences?.openInNewTab !== false;
        const target = openInNewTab ? '_blank' : '_self';

        try {
            const openedWindow = window.open(safeUrl, target, openInNewTab ? 'noopener,noreferrer' : undefined);
            if (openedWindow && openInNewTab) openedWindow.opener = null;

            // 如果用户设置了显示导航提示
            if (this.settings.preferences?.showNavigationHint !== false) {
                const targetText = openInNewTab ? '新标签页' : '当前页面';
                this.showToast(`已在${targetText}中打开${appName}${actionText}: ${placeName}`);
            }
        } catch (error) {
            // 备用方案：复制导航链接
            navigator.clipboard.writeText(safeUrl).then(() => {
                this.showToast(`${appName}链接已复制到剪贴板`);
            });
        }
    }

    // 在地图中显示游玩点（不进行导航，仅显示位置）
    showInMap(lng, lat, name) {
        lng = Number(lng);
        lat = Number(lat);
        name = String(name ?? '');
        if (!PlannerData.isValidCoordinate({ lng, lat })) {
            this.showToast('地点坐标无效');
            return;
        }

        // 根据用户设置选择导航应用（统一使用导航设置）
        const navigationApp = this.settings.navigationApp || 'amap';
        let url = '';
        let appName = '';

        switch (navigationApp) {
            case 'amap':
                // 高德地图：显示POI点，不进行导航
                url = `https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(name)}&src=17travelplanner&coordinate=gaode&callnative=1`;
                appName = '高德地图';
                break;
            case 'google':
                // Google地图：显示位置标记
                url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
                appName = 'Google 地图';
                break;
            case 'bing':
                // Bing地图：显示位置
                url = `https://www.bing.com/maps?cp=${lat}~${lng}&lvl=16`;
                appName = 'Bing 地图';
                break;
            case 'tianditu':
                // 天地图：显示指定位置
                url = `https://map.tianditu.gov.cn/?center=${lng},${lat}&zoom=16`;
                appName = '天地图';
                break;
            default:
                // 默认使用高德地图
                url = `https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(name)}&src=17travelplanner&coordinate=gaode&callnative=1`;
                appName = '高德地图';
                break;
        }

        this.openNavigationUrl(url, appName, name, '显示');
    }

    // 需要获取当前位置的导航方式（高德桌面版、Google、Bing等）
    navigateWithGeolocation(lng, lat, name, navigationApp) {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const currentLat = position.coords.latitude;
                    const currentLng = position.coords.longitude;

                    let url = '';
                    let appName = '';

                    switch (navigationApp) {
                        case 'amap':
                            // 高德地图桌面版：包含from参数，避免起点丢失
                            url = `https://uri.amap.com/navigation?from=${currentLng},${currentLat},我的位置&to=${lng},${lat},${encodeURIComponent(name)}&mode=car&policy=1&src=17travelplanner&coordinate=gaode&callnative=1`;
                            appName = '高德地图';
                            break;
                        case 'google':
                            url = `https://www.google.com/maps/dir/${currentLat},${currentLng}/${lat},${lng}`;
                            appName = 'Google 地图';
                            break;
                        case 'bing':
                            url = `https://www.bing.com/maps/directions?rtp=pos.${currentLat}_${currentLng}~pos.${lat}_${lng}`;
                            appName = 'Bing 地图';
                            break;
                        case 'tianditu':
                            url = `https://map.tianditu.gov.cn/?orig=${currentLng},${currentLat}&dest=${lng},${lat}&type=route`;
                            appName = '天地图';
                            break;
                    }

                    this.openNavigationUrl(url, appName, name);
                },
                (error) => {
                    alert('获取当前位置失败，请检查定位权限设置');
                }
            );
        } else {
            alert('您的浏览器不支持地理定位功能');
        }
    }

    // 显示提示消息
    showToast(message, priority = 'auto') {
        // 创建toast元素
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        const isUrgent = priority === 'assertive' || (
            priority === 'auto' && /失败|错误|无效|无法|不支持|配额|权限不足/.test(String(message))
        );
        toast.setAttribute('role', isUrgent ? 'alert' : 'status');
        toast.setAttribute('aria-live', isUrgent ? 'assertive' : 'polite');
        toast.setAttribute('aria-atomic', 'true');
        toast.dataset.liveRegion = '';

        // 添加到页面
        document.body.appendChild(toast);

        // 显示动画
        setTimeout(() => {
            toast.classList.add('show');
        }, 100);

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                if (toast.parentNode) {
                    document.body.removeChild(toast);
                }
            }, 300);
        }, 3000);
    }

    // 显示恢复总地图按钮
    showReturnToOverviewButton() {
        if (!this.returnToOverviewBtn) {
            const mapControls = document.querySelector('.map-controls');
            this.returnToOverviewBtn = document.createElement('button');
            this.returnToOverviewBtn.className = 'control-btn return-overview-btn';
            this.returnToOverviewBtn.textContent = '🗺️ 恢复总地图';
            this.returnToOverviewBtn.title = '返回查看所有游玩点（不包括待定列表）';
            this.returnToOverviewBtn.addEventListener('click', () => this.returnToOverview());
            mapControls.appendChild(this.returnToOverviewBtn);
        }
        this.returnToOverviewBtn.style.display = 'block';
    }

    // 恢复总地图视图
    returnToOverview() {
        if (this.isMapLoaded && this.travelList.length > 0) {
            const activePlaces = this.getUsablePlaces();

            if (activePlaces.length > 0) {
                if (this.currentCityFilter === 'all') {
                    // 显示所有激活的游玩点
                    this.fitMapToPlaces(activePlaces);
                } else {
                    // 显示当前过滤城市的激活游玩点
                    const filteredActivePlaces = activePlaces.filter(place =>
                        this.extractCityFromAddress(place.address) === this.currentCityFilter
                    );
                    if (filteredActivePlaces.length > 0) {
                        this.fitMapToPlaces(filteredActivePlaces);
                    } else {
                        this.fitMapToPlaces(activePlaces);
                    }
                }
            }
        }

        // 隐藏恢复总地图按钮
        if (this.returnToOverviewBtn) {
            this.returnToOverviewBtn.style.display = 'none';
        }
    }

    // 从列表中删除地点
    removePlaceFromList(id) {
        this.dispatch({ type: 'REMOVE_PLACE', id });
    }

    beginRouteTokens() {
        return {
            distance: this.taskGenerations.begin('distance'),
            route: this.taskGenerations.begin('route')
        };
    }

    areRouteTokensCurrent(tokens) {
        return Boolean(tokens &&
            this.taskGenerations.isCurrent(tokens.distance) &&
            this.taskGenerations.isCurrent(tokens.route));
    }

    generateRoutePipelineSignature() {
        const precision = PerformanceCore.ROUTE_COORDINATE_PRECISION;
        return JSON.stringify({
            provider: this.settings.selectedMapApi,
            travelMode: this.routePlanOptions?.travelMode || 'DRIVING',
            roundTrip: this.routePlanOptions?.roundTrip === true,
            precision,
            algorithmVersion: PerformanceCore.ROUTE_ALGORITHM_VERSION,
            places: this.getUsablePlaces().map(place => [
                String(place.id),
                Number(place.lat).toFixed(precision),
                Number(place.lng).toFixed(precision)
            ])
        });
    }

    buildRoutePipelineSegments() {
        const places = this.getUsablePlaces();
        const segments = PlannerData.buildValidSegments(places)
            .map(([from, to]) => ({ from, to, isReturn: false }));
        if (this.routePlanOptions?.roundTrip && places.length > 1) {
            segments.push({ from: places[places.length - 1], to: places[0], isReturn: true });
        }
        return segments;
    }

    scheduleRoutePipeline(delayMs = 80) {
        if (this.routePipelineTimer) clearTimeout(this.routePipelineTimer);
        const tokens = this.beginRouteTokens();
        const signature = this.generateRoutePipelineSignature();
        const places = this.getUsablePlaces();
        this.routeResultSignature = '';
        this.clearAllRoutes();
        if (places.length >= 2) {
            // 排序提交后立即显示当前顺序的轻量直线，旧详细路线不会继续留在画布上。
            this.drawSimplePath(this.routePlanOptions?.roundTrip ? places.concat(places[0]) : places);
        } else {
            this.routeResults = new Map();
            this.routeMetrics = new Map();
            this.totalMetrics = PlannerData.createRouteMetrics(0, 0);
            this.totalMetricSource = 'unavailable';
            this.renderDistanceState();
            return tokens;
        }
        this.routePipelineTimer = setTimeout(() => {
            this.routePipelineTimer = null;
            if (!this.areRouteTokensCurrent(tokens)) return;
            this.startRoutePipeline(tokens, signature);
        }, Math.max(0, Number(delayMs) || 0));
        return tokens;
    }

    startRoutePipeline(tokens = this.beginRouteTokens(), signature = this.generateRoutePipelineSignature()) {
        const promise = this.executeRoutePipeline(tokens, signature);
        this.routeCalculationPromise = promise;
        this.isCalculatingDistances = true;
        promise.catch(error => {
            if (error?.name !== 'AbortError' && error?.code !== 'BFF_ABORTED') {
                console.warn('路线计算失败:', error);
            }
        }).finally(() => {
            if (this.routeCalculationPromise === promise) {
                this.routeCalculationPromise = null;
                this.isCalculatingDistances = false;
            }
        });
        return promise;
    }

    async executeRoutePipeline(tokens, signature) {
        const segments = this.buildRoutePipelineSegments();
        const provider = this.settings.selectedMapApi;
        const travelMode = this.routePlanOptions?.travelMode || 'DRIVING';
        const entries = await Promise.all(segments.map(async segment => {
            let result;
            try {
                result = await this.routeResultProvider.get({
                    provider,
                    travelMode,
                    origin: segment.from,
                    destination: segment.to
                }, { signal: tokens.route.signal });
            } catch (error) {
                if (error?.name === 'AbortError' || error?.code === 'BFF_ABORTED') throw error;
                const distanceMeters = RouteOptimizer.haversineDistanceMeters(segment.from, segment.to);
                result = {
                    provider,
                    travelMode,
                    origin: { lat: segment.from.lat, lng: segment.from.lng },
                    destination: { lat: segment.to.lat, lng: segment.to.lng },
                    coordinates: [[segment.from.lng, segment.from.lat], [segment.to.lng, segment.to.lat]],
                    distanceMeters,
                    durationSeconds: RouteOptimizer.estimatedDurationSeconds(distanceMeters, travelMode),
                    source: 'straight-line-estimate',
                    algorithmVersion: PerformanceCore.ROUTE_ALGORITHM_VERSION
                };
            }
            return [`${segment.from.id}-${segment.to.id}`, {
                ...result,
                fromId: segment.from.id,
                toId: segment.to.id,
                isReturn: segment.isReturn
            }];
        }));
        if (!this.areRouteTokensCurrent(tokens)) return null;

        let distanceMeters = 0;
        let durationSeconds = 0;
        let estimates = 0;
        const metrics = entries.map(([key, result]) => {
            const value = PlannerData.createRouteMetrics(result.distanceMeters, result.durationSeconds);
            distanceMeters += value.distanceMeters;
            durationSeconds += value.durationSeconds;
            if (result.source !== 'provider') estimates += 1;
            return [key, value];
        });
        const source = estimates === 0
            ? (entries.length ? 'provider' : 'unavailable')
            : (estimates === entries.length ? 'straight-line-estimate' : 'mixed');
        this.dispatch({
            type: 'ROUTE_RESULTS_RESOLVED',
            tokens,
            signature,
            results: entries,
            metrics,
            totalMetrics: PlannerData.createRouteMetrics(distanceMeters, durationSeconds),
            source
        });
        return entries;
    }

    async fetchProviderRouteResult(request, options = {}) {
        const response = await this.bff.route({
            provider: request.provider,
            origin: request.origin,
            destination: request.destination,
            travelMode: request.travelMode
        }, { signal: options.signal });
        const payload = response?.data || response || {};
        const coordinates = Array.isArray(payload.polyline)
            ? payload.polyline.map(point => [Number(point?.lng), Number(point?.lat)])
                .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]))
            : [];
        return {
            coordinates,
            distanceMeters: Number(payload.distanceMeters),
            durationSeconds: Number(payload.durationSeconds)
        };
    }

    renderDistanceState() {
        const metrics = this.totalMetrics || PlannerData.createRouteMetrics(0, 0);
        this.updateDistanceSummary(metrics.distanceMeters, metrics.durationSeconds, this.totalMetricSource);
    }

    renderRouteResults(results) {
        const places = this.getUsablePlaces();
        if (!this.isMapLoaded || places.length < 2 || results.length === 0) {
            this.clearAllRoutes();
            return;
        }
        this.clearAllRoutes();
        const provider = this.settings.selectedMapApi;
        const colors = this.getTiandituRouteColors();
        const tiandituLayers = [];
        results.forEach((result, index) => {
            const coordinates = result.coordinates;
            if (provider === 'google' && typeof google !== 'undefined') {
                const polyline = new google.maps.Polyline({
                    path: coordinates.map(point => ({ lat: point[1], lng: point[0] })),
                    geodesic: true,
                    strokeColor: colors[index % colors.length],
                    strokeOpacity: result.source === 'provider' ? 0.9 : 0.65,
                    strokeWeight: result.source === 'provider' ? 6 : 4,
                    zIndex: 100 + index
                });
                polyline.setMap(this.map);
                this.polylines.push(polyline);
            } else if (provider === 'gaode' && typeof AMap !== 'undefined') {
                this.drawGaodeRouteSegment(coordinates, index);
            } else if (provider === 'tianditu' && typeof T !== 'undefined') {
                tiandituLayers.push({
                    path: coordinates.map(point => new T.LngLat(point[0], point[1])),
                    color: colors[index % colors.length],
                    lineStyle: result.source === 'provider' ? 'solid' : 'dashed'
                });
            }
        });
        if (provider === 'tianditu' && tiandituLayers.length > 0) this.renderTiandituRouteLayers(tiandituLayers);
    }

    // 计算相邻地点距离
    calculateDistances() {
        return this.startRoutePipeline();
    }

    // 所有真实距离计算通过固定同源 route-matrix BFF 完成。
    calculateRealDistances() {
        return this.calculateRealDistancesWithBff();
    }

    async calculateRealDistancesWithBff() {
        if (this.taskGenerations && this.routeResultProvider) return this.startRoutePipeline();
        const activePlaces = this.getUsablePlaces();
        let totalDistanceMeters = 0;
        let totalDurationSeconds = 0;
        let straightLineSegments = 0;
        this.routeMetrics.clear();
        const travelMode = this.routePlanOptions?.travelMode || 'DRIVING';
        const segments = PlannerData.buildValidSegments(activePlaces)
            .map(([from, to]) => ({ from, to, isReturn: false }));
        if (this.routePlanOptions?.roundTrip && activePlaces.length > 1) {
            segments.push({
                from: activePlaces[activePlaces.length - 1],
                to: activePlaces[0],
                isReturn: true
            });
        }

        for (const segment of segments) {
            const previous = segment.from;
            const current = segment.to;
            const result = await this.calculateBffDistance(previous, current, travelMode);
            let metrics;
            let isStraightLine = false;
            if (result.success) {
                metrics = PlannerData.createRouteMetrics(result.distanceMeters, result.durationSeconds);
            } else {
                const straightDistanceMeters = RouteOptimizer.haversineDistanceMeters(previous, current);
                metrics = PlannerData.createRouteMetrics(
                    straightDistanceMeters,
                    RouteOptimizer.estimatedDurationSeconds(straightDistanceMeters, travelMode)
                );
                isStraightLine = true;
                straightLineSegments += 1;
            }
            this.routeMetrics.set(`${previous.id}-${current.id}`, metrics);
            totalDistanceMeters += metrics.distanceMeters;
            totalDurationSeconds += metrics.durationSeconds;

            if (segment.isReturn) continue;
            const distanceElement = document.getElementById(`distance-${current.id}`);
            const durationElement = document.getElementById(`duration-${current.id}`);
            if (distanceElement) {
                const suffix = isStraightLine ? ' (直线估算)' : '';
                distanceElement.textContent = `${(metrics.distanceMeters / 1000).toFixed(1)} 公里${suffix}`;
            }
            if (durationElement) {
                const prefix = isStraightLine ? '约' : '';
                durationElement.textContent = `${prefix}${Math.round(metrics.durationSeconds / 60)} 分钟`;
            }
        }

        const source = straightLineSegments === 0
            ? 'provider'
            : (straightLineSegments === segments.length ? 'straight-line-estimate' : 'mixed');
        this.updateDistanceSummary(totalDistanceMeters, totalDurationSeconds, source);
    }

    calculateRealDistancesWithGoogle() {
        return this.calculateRealDistancesWithBff();
    }

    calculateRealDistancesWithGaode() {
        return this.calculateRealDistancesWithBff();
    }

    calculateRealDistancesWithTianditu() {
        return this.calculateRealDistancesWithBff();
    }

    async calculateBffDistance(fromPlace, toPlace, travelMode = 'DRIVING') {
        if (!PlannerData.isUsablePlace(fromPlace) || !PlannerData.isUsablePlace(toPlace)) {
            return { success: false };
        }
        try {
            const result = await this.routeResultProvider.get({
                provider: this.settings.selectedMapApi,
                origin: fromPlace,
                destination: toPlace,
                travelMode
            });
            return {
                success: true,
                distanceMeters: result.distanceMeters,
                durationSeconds: result.durationSeconds,
                coordinates: result.coordinates
            };
        } catch (error) {
            return { success: false };
        }
    }

    calculateGaodeDistance(fromPlace, toPlace) {
        return this.calculateBffDistance(fromPlace, toPlace);
    }

    calculateTiandituDistance(fromPlace, toPlace) {
        return this.calculateBffDistance(fromPlace, toPlace);
    }
    // 计算直线距离（备用方案）
    calculateStraightLineDistances() {
        const usablePlaces = this.getUsablePlaces();
        let totalDistanceMeters = 0;
        let totalDurationSeconds = 0;
        this.routeMetrics.clear();

        for (let i = 1; i < usablePlaces.length; i++) {
            const prev = usablePlaces[i - 1];
            const curr = usablePlaces[i];

            const distanceKm = this.calculateStraightDistance(prev.lat, prev.lng, curr.lat, curr.lng);
            const metrics = PlannerData.createRouteMetrics(distanceKm * 1000, (distanceKm / 50) * 3600);
            this.routeMetrics.set(`${prev.id}-${curr.id}`, metrics);
            totalDistanceMeters += metrics.distanceMeters;
            totalDurationSeconds += metrics.durationSeconds;

            // 更新距离显示
            const distanceElement = document.getElementById(`distance-${curr.id}`);
            const durationElement = document.getElementById(`duration-${curr.id}`);

            if (distanceElement) {
                distanceElement.textContent = `${distanceKm.toFixed(1)} 公里 (直线估算)`;
            }
            if (durationElement) {
                durationElement.textContent = `约${Math.round(metrics.durationSeconds / 60)} 分钟`;
            }
        }

        this.updateDistanceSummary(totalDistanceMeters, totalDurationSeconds, 'straight-line-estimate');
    }

    // 计算两点间直线距离（使用Haversine公式）
    calculateStraightDistance(lat1, lng1, lat2, lng2) {
        const R = 6371; // 地球半径（公里）
        const dLat = this.toRadians(lat2 - lat1);
        const dLng = this.toRadians(lng2 - lng1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    toRadians(degrees) {
        return degrees * (Math.PI / 180);
    }

    // 更新距离统计
    updateDistanceSummary(distanceMeters, durationSeconds, source = 'unavailable') {
        this.totalMetrics = PlannerData.createRouteMetrics(distanceMeters, durationSeconds);
        this.totalMetricSource = source;
        document.getElementById('totalDistance').textContent = `总距离: ${(distanceMeters / 1000).toFixed(1)} 公里`;

        // 将时间转换为更友好的格式
        const totalMinutes = Math.round(durationSeconds / 60);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        let timeText = '';
        if (hours > 0) {
            timeText = `${hours}小时`;
            if (minutes > 0) {
                timeText += `${minutes}分钟`;
            }
        } else {
            timeText = `${minutes}分钟`;
        }

        document.getElementById('estimatedTime').textContent = `预计时间: ${timeText}`;
        const sourceElement = document.getElementById('distanceSource');
        if (sourceElement) {
            const labels = {
                provider: '数据来源: Provider 交通路线',
                mixed: '数据来源: Provider + 直线估算',
                'straight-line-estimate': '数据来源: 直线估算',
                unavailable: '数据来源: 尚未计算'
            };
            const returnSuffix = this.routePlanOptions?.roundTrip ? ' · 含返程' : '';
            sourceElement.textContent = `${labels[source] || labels.unavailable}${returnSuffix}`;
        }
    }

    // 添加地图标记
    addMarker(place) {
        if (!this.isMapLoaded) return;

        // 如果是待定点，不创建普通标记
        if (place.isPending) {
            return;
        }

        // 如果没有坐标信息，不创建标记
        if (!PlannerData.isValidCoordinate(place)) {
            return;
        }

        // 如果是空白地点，不创建标记
        if (place.isBlank) {
            return;
        }

        // 获取非空白游玩点在激活列表中的序号
        const activePlaces = this.travelList.filter(p => !p.isPending);
        const nonBlankActivePlaces = this.getUsablePlaces(activePlaces);
        const index = nonBlankActivePlaces.findIndex(p => p.id === place.id);
        const number = index + 1;

        // 使用自定义名称（如果有的话）
        const displayName = place.customName || place.name;

        const selectedMapApi = this.settings.selectedMapApi;
        let marker = null;
        let placeLabel = null;

        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
            // Google Maps 标记
            marker = this.createGoogleMarker(place, number, displayName, index);

            // 创建自定义标签显示地点名称
            if (PlaceLabel && this.isMapLoaded) {
                placeLabel = new PlaceLabel(
                    { lat: place.lat, lng: place.lng },
                    `${number}. ${displayName}`,
                    this.map
                );

                // 如果当前设置为隐藏名称，则隐藏标签
                if (!this.showPlaceNames) {
                    placeLabel.hide();
                }

                this.placeLabels.push({ id: place.id, label: placeLabel });
            }
        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
            // 高德地图标记
            marker = this.createGaodeMarker(place, number, displayName, index);
        } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
            // 天地图标记
            marker = this.createTiandituMarker(place, number, displayName, index);
        } else {
            console.warn('⚠️ 无法创建标记：地图API未加载');
            return;
        }

        if (marker) {
            this.markers.push({ id: place.id, marker: marker, place: place });
        }
    }

    // 创建Google Maps标记
    createGoogleMarker(place, number, displayName, index) {
        return new google.maps.Marker({
            position: { lat: place.lat, lng: place.lng },
            map: this.map,
            title: `${number}. ${displayName}`,
            icon: {
                url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
                    Security.renderMapMarkerSvg({ number, pending: false })
                ),
                scaledSize: new google.maps.Size(40, 50),
                anchor: new google.maps.Point(20, 50)
            },
            zIndex: 1000 + index
        });
    }

    // 创建高德地图标记
    createGaodeMarker(place, number, displayName, index) {
        const marker = new AMap.Marker({
            position: [place.lng, place.lat], // 高德地图使用 [经度, 纬度] 格式
            title: `${number}. ${displayName}`,
            content: Security.renderMapSdkHtml('active-marker', { number }),
            anchor: 'bottom-center',
            zIndex: 1000 + index
        });

        // 添加点击事件
        marker.on('click', () => {
            this.showPlaceModal({
                name: place.name,
                address: place.address,
                lng: place.lng,
                lat: place.lat,
                customName: place.customName,
                notes: place.notes,
                isPending: false
            });
        });

        // 创建高德地图标签
        if (this.showPlaceNames) {
            this.createGaodeLabel(place, number, displayName);
        }

        this.map.add(marker);
        return marker;
    }

    // 创建高德地图标签
    createGaodeLabel(place, number, displayName) {
        const labelText = `${number}. ${displayName}`;

        const labelMarker = new AMap.Marker({
            position: [place.lng, place.lat],
            offset: new AMap.Pixel(0, -75),
            content: Security.renderMapSdkHtml('active-label', { number, text: displayName }),
            anchor: 'bottom-center',
            zIndex: 1100,
            clickable: false
        });

        this.map.add(labelMarker);

        // 存储标签信息
        this.placeLabels.push({
            id: place.id,
            label: labelMarker,
            visible: this.showPlaceNames
        });

        return labelMarker;
    }

    createTiandituMarker(place, number, displayName, index) {
        const markerSvg = Security.renderMapMarkerSvg({ number, pending: false });

        const icon = new T.Icon({
            iconUrl: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(markerSvg.trim()),
            iconSize: new T.Point(40, 50),
            iconAnchor: new T.Point(20, 50)
        });

        const marker = new T.Marker(new T.LngLat(place.lng, place.lat), {
            icon: icon,
            title: `${number}. ${displayName}`,
            zIndexOffset: 1000 + index
        });

        this.map.addOverLay(marker);

        // 绑定点击事件，打开信息窗体
        marker.addEventListener("click", () => {
            this.showPlaceModal({
                name: place.name,
                address: place.address,
                lng: place.lng,
                lat: place.lat,
                customName: place.customName,
                notes: place.notes,
                isPending: false
            });
        });

        // 创建标签
        this.createTiandituLabel(place, number, displayName);

        return marker;
    }

    // 创建天地图标签
    createTiandituLabel(place, number, displayName) {
        const labelText = Security.renderMapSdkHtml('active-label', { number, text: displayName });

        const label = new T.Label({
            text: labelText,
            position: new T.LngLat(place.lng, place.lat),
            offset: new T.Point(-30, -75), // 居中偏移
            // 天地图默认的 .tdt-label 自带背景、内边距和阴影，会与
            // labelText 中的自定义卡片叠成双层。使用专用类接管外层样式。
            className: 'travel-map-label travel-map-label--place'
        });

        label.setBackgroundColor('transparent');
        label.setBorderColor('transparent');

        this.map.addOverLay(label);

        if (!this.showPlaceNames && label.getElement()) {
            label.getElement().style.display = 'none';
        }

        this.placeLabels.push({
            id: place.id,
            label: label,
            visible: this.showPlaceNames
        });

        return label;
    }

    // 删除标记
    removeMarker(id) {
        if (!this.isMapLoaded) return;

        const selectedMapApi = this.settings.selectedMapApi;
        const markerIndex = this.markers.findIndex(m => m.id.toString() === id);

        if (markerIndex !== -1) {
            const markerObj = this.markers[markerIndex];

            if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                // Google Maps 标记删除
                markerObj.marker.setMap(null);
            } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                // 高德地图标记删除
                this.map.remove(markerObj.marker);
            } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
                // 天地图标记删除
                this.map.removeOverLay(markerObj.marker);
            }

            this.markers.splice(markerIndex, 1);
        }

        // 同时删除对应的标签（支持Google Maps和高德地图）
        const labelIndex = this.placeLabels.findIndex(l => l.id.toString() === id);
        if (labelIndex !== -1) {
            if (this.placeLabels[labelIndex].label) {
                if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                    this.placeLabels[labelIndex].label.setMap(null);
                } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                    this.map.remove(this.placeLabels[labelIndex].label);
                } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
                    this.map.removeOverLay(this.placeLabels[labelIndex].label);
                }
            }
            this.placeLabels.splice(labelIndex, 1);
        }
        this.labelSizeCache?.delete(id);
        this.labelSizeCache?.delete(String(id));
    }

    // 清除所有标记
    clearMarkers() {
        if (!this.isMapLoaded) return;

        const selectedMapApi = this.settings.selectedMapApi;

        // 清除游玩点标记
        this.markers.forEach(m => {
            if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                m.marker.setMap(null);
            } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                this.map.remove(m.marker);
            } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
                this.map.removeOverLay(m.marker);
            }
        });
        this.markers = [];

        // 清除所有标签
        this.placeLabels.forEach(l => {
            if (l.label) {
                if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                    l.label.setMap(null);
                } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                    this.map.remove(l.label);
                } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
                    this.map.removeOverLay(l.label);
                }
            }
        });
        this.placeLabels = [];
        this.labelSizeCache.clear();

        // 清除待定点标记
        this.clearPendingMarkers();

        // 清除路线
        if (selectedMapApi === 'google' && this.directionsRenderer) {
            this.directionsRenderer.setDirections({ routes: [] });
        }

        // 重置城市过滤
        this.currentCityFilter = 'all';
        if (this.cityFilterBtn) {
            this.cityFilterBtn.textContent = '🏙️ 全部城市';
            this.cityFilterBtn.style.display = 'none';
        }

        // 隐藏恢复总地图按钮
        if (this.returnToOverviewBtn) {
            this.returnToOverviewBtn.style.display = 'none';
        }
    }

    // 切换标记显示/隐藏
    toggleMarkers() {
        const clearBtn = document.getElementById('clearMarkersBtn');

        if (this.markersCleared) {
            // 恢复标记
            this.restoreMarkers();
            clearBtn.textContent = '🗑️ 清除标记';
            clearBtn.title = '清除地图标记';
            const activeCount = this.getUsablePlaces().length;
            this.showToast(`已恢复标记并调整视角显示${activeCount}个游玩点`);
        } else {
            // 清除标记
            this.saveMarkersState();
            this.clearMarkersOnly();
            clearBtn.textContent = '↩️ 恢复标记';
            clearBtn.title = '恢复地图标记';
            this.showToast('已清除标记');
        }
        this.markersCleared = !this.markersCleared;
        clearBtn.setAttribute('aria-pressed', String(!this.markersCleared));
    }

    // 保存标记状态
    saveMarkersState() {
        this.savedMarkers = [...this.travelList];
    }

    // 只清除地图上的标记，不影响列表
    clearMarkersOnly() {
        if (!this.isMapLoaded) return;

        const selectedMapApi = this.settings.selectedMapApi;

        // 清除游玩点标记
        this.markers.forEach(m => {
            if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                m.marker.setMap(null);
            } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                this.map.remove(m.marker);
            } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
                this.map.removeOverLay(m.marker);
            }
        });
        this.markers = [];

        // 清除所有标签
        this.placeLabels.forEach(l => {
            if (l.label) {
                if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                    l.label.setMap(null);
                } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                    this.map.remove(l.label);
                } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
                    this.map.removeOverLay(l.label);
                }
            }
        });
        this.placeLabels = [];
        this.labelSizeCache.clear();

        // 清除待定点标记
        this.clearPendingMarkers();

        // 清除路线
        if (selectedMapApi === 'google') {
            if (this.directionsRenderer) {
                this.directionsRenderer.setDirections({ routes: [] });
            }
            if (this.polyline) {
                this.polyline.setMap(null);
                this.polyline = null;
            }
            if (this.polylines) {
                this.polylines.forEach(polyline => polyline.setMap(null));
                this.polylines = [];
            }
        } else if (selectedMapApi === 'gaode') {
            if (this.polylines) {
                this.polylines.forEach(polyline => this.map.remove(polyline));
                this.polylines = [];
            }
        } else if (selectedMapApi === 'tianditu') {
            if (this.polylines) {
                this.polylines.forEach(polyline => this.map.removeOverLay(polyline));
                this.polylines = [];
            }
        }
    }

    // 恢复标记
    restoreMarkers() {
        if (!this.isMapLoaded || this.savedMarkers.length === 0) return;

        // 重新创建标记（只恢复非待定点）
        const activePlaces = this.savedMarkers.filter(place => !place.isPending);
        activePlaces.forEach(place => this.addMarker(place));

        // 如果当前显示待定点，重新创建待定点标记
        if (this.showPendingPlaces) {
            this.createPendingMarkers();
        }

        // 重新绘制路线
        if (this.travelList.length >= 2) {
            this.drawRoute();
        }

        // 重新适配地图视野，只显示游玩点区域
        const currentActivePlaces = this.getUsablePlaces();
        if (currentActivePlaces.length > 0) {
            setTimeout(() => {
                this.fitMapToPlaces(currentActivePlaces);
                console.log(`✅ 已恢复标记并调整视角显示${currentActivePlaces.length}个游玩点`);
            }, 300);
        }
    }

    // 显示路线功能（优化版）
    showRoute() {
        const activePlaces = this.getUsablePlaces();

        if (activePlaces.length < 2) {
            this.showToast('至少需要2个有效地点才能显示路线');
            return;
        }

        console.log(`🛣️ 显示路线：${activePlaces.length}个地点`);

        // 确保标记已显示
        if (this.markersCleared) {
            this.restoreMarkers();
            const clearBtn = document.getElementById('clearMarkersBtn');
            clearBtn.textContent = '🗑️ 清除标记';
            clearBtn.title = '清除地图标记';
            this.markersCleared = false;
        }

        // 立即重新绘制路线（快速显示）
        this.drawRoute();

        // 立即适配地图视野显示所有地点
        setTimeout(() => {
            this.fitMapToPlaces(activePlaces);
        }, 100);

        // 刷新所有标记确保正确显示
        setTimeout(() => {
            this.refreshAllMarkers();
        }, 200);

        this.showToast(`✅ 已显示${activePlaces.length}个地点的完整路线`);
    }

    // 刷新所有标记
    refreshAllMarkers() {
        if (!this.isMapLoaded) return;

        console.log('🔄 刷新所有地图标记');

        // 重新创建所有标记
        this.recreateMarkers();

        // 更新待定点显示
        this.updateTogglePendingButton();

        console.log('✅ 标记刷新完成');
    }

    // 绘制路线
    drawRoute() {
        const activePlaces = this.getUsablePlaces();
        if (!this.isMapLoaded || activePlaces.length < 2) {
            this.clearAllRoutes();
            return;
        }
        if (this.routeResultSignature === this.generateRoutePipelineSignature() && this.routeResults.size > 0) {
            this.renderRouteResults(Array.from(this.routeResults.values()));
            return;
        }
        this.scheduleRoutePipeline(0);
    }

    // 清除所有路线
    clearAllRoutes() {
        const selectedMapApi = this.settings.selectedMapApi;

        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
            // 清除Google Maps路线
            if (this.directionsRenderer) {
                this.directionsRenderer.setDirections({ routes: [] });
            }
            if (this.polyline) {
                this.polyline.setMap(null);
                this.polyline = null;
            }
            if (this.polylines) {
                this.polylines.forEach(polyline => polyline.setMap(null));
                this.polylines = [];
            }
        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
            // 清除高德地图路线
            if (this.polylines) {
                this.polylines.forEach(polyline => this.map.remove(polyline));
                this.polylines = [];
            }
        } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
            // 清除天地图路线
            if (this.polylines) {
                this.polylines.forEach(polyline => this.map.removeOverLay(polyline));
                this.polylines = [];
            }
        }
    }

    // Google Maps路线绘制
    drawGoogleRoute(activePlaces) {
        this.scheduleRoutePipeline(0);
    }

    // 高德地图路线绘制
    drawGaodeRoute(activePlaces) {
        this.scheduleRoutePipeline(0);
    }

    // 使用高德路径规划API绘制路线（快速版本）
    async drawGaodeRoutesWithAPI(activePlaces) {
        return this.drawDetailedRoutesWithBff(activePlaces, 'gaode');
    }

    // 异步绘制详细路线（后台处理）
    async drawDetailedGaodeRoutes(activePlaces) {
        return this.drawDetailedRoutesWithBff(activePlaces, 'gaode');
    }

    // 获取高德路径规划数据（带缓存优化）
    async getGaodeRoute(origin, destination) {
        return this.getBffRoute(origin, destination, 'gaode');
    }

    async getBffRoute(origin, destination, provider = this.settings.selectedMapApi) {
        if (!PlannerData.isUsablePlace(origin) || !PlannerData.isUsablePlace(destination)) {
            return { success: false };
        }
        const travelMode = this.routePlanOptions?.travelMode || 'DRIVING';
        try {
            const result = await this.routeResultProvider.get({
                provider,
                origin,
                destination,
                travelMode
            });
            return { success: true, ...result };
        } catch (error) {
            return { success: false };
        }
    }

    async drawDetailedRoutesWithBff(activePlaces, provider = this.settings.selectedMapApi) {
        if (this.taskGenerations && this.routeResultProvider) return this.startRoutePipeline();
        activePlaces = this.getUsablePlaces(activePlaces);
        const results = await Promise.all(activePlaces.slice(0, -1).map((origin, index) =>
            this.getBffRoute(origin, activePlaces[index + 1], provider)
        ));
        if (provider !== this.settings.selectedMapApi || !this.isMapLoaded) return;

        this.clearAllRoutes();
        const colors = this.getTiandituRouteColors();
        const tiandituLayers = [];
        results.forEach((result, index) => {
            const origin = activePlaces[index];
            const destination = activePlaces[index + 1];
            const coordinates = result.success
                ? result.coordinates
                : [[origin.lng, origin.lat], [destination.lng, destination.lat]];

            if (provider === 'google' && typeof google !== 'undefined') {
                const polyline = new google.maps.Polyline({
                    path: coordinates.map(point => ({ lat: point[1], lng: point[0] })),
                    geodesic: true,
                    strokeColor: colors[index % colors.length],
                    strokeOpacity: result.success ? 0.9 : 0.65,
                    strokeWeight: result.success ? 6 : 4,
                    zIndex: 100 + index
                });
                polyline.setMap(this.map);
                this.polylines.push(polyline);
            } else if (provider === 'gaode' && typeof AMap !== 'undefined') {
                if (result.success) this.drawGaodeRouteSegment(coordinates, index);
                else this.drawGaodeDirectLine(origin, destination, index);
            } else if (provider === 'tianditu' && typeof T !== 'undefined') {
                tiandituLayers.push({
                    path: coordinates.map(point => new T.LngLat(point[0], point[1])),
                    color: colors[index % colors.length],
                    lineStyle: result.success ? 'solid' : 'dashed'
                });
            }
        });
        if (provider === 'tianditu' && tiandituLayers.length > 0) {
            this.renderTiandituRouteLayers(tiandituLayers);
        }
    }

    // 解析高德地图polyline字符串
    parseGaodePolyline(polylineStr) {
        if (!polylineStr) return [];

        try {
            // 高德的polyline格式：经度,纬度;经度,纬度;...
            return polylineStr.split(';').map(point => {
                const [lng, lat] = point.split(',').map(Number);
                return [lng, lat];
            }).filter(coord => coord.length === 2 && !isNaN(coord[0]) && !isNaN(coord[1]));
        } catch (error) {
            console.error('❌ 解析polyline失败:', error);
            return [];
        }
    }

    // 绘制高德路线段
    drawGaodeRouteSegment(coordinates, segmentIndex) {
        if (!coordinates || coordinates.length < 2) {
            console.warn('⚠️ 路线坐标数据不足');
            return;
        }

        const colors = [
            '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
            '#1abc9c', '#e67e22', '#34495e', '#f1c40f', '#e91e63'
        ];

        const color = colors[segmentIndex % colors.length];

        try {
            const polyline = new AMap.Polyline({
                path: coordinates,
                strokeColor: color,
                strokeOpacity: 0.9,
                strokeWeight: 8,  // 增加线条宽度
                strokeStyle: 'solid',
                zIndex: 100 + segmentIndex,
                // 添加线条样式优化
                lineJoin: 'round',
                lineCap: 'round',
                // 添加阴影效果
                strokeDasharray: [0, 0],
                // 边框效果
                borderWeight: 2,
                outlineColor: '#ffffff'
            });

            this.map.add(polyline);
            this.polylines.push(polyline);

            console.log(`✅ 已绘制路线段 ${segmentIndex + 1}，坐标点数: ${coordinates.length}`);
        } catch (error) {
            console.error('❌ 绘制高德路线段失败:', error);
        }
    }

    // 绘制高德直线（备用方案）
    drawGaodeDirectLine(origin, destination, segmentIndex) {
        const colors = [
            '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
            '#1abc9c', '#e67e22', '#34495e', '#f1c40f', '#e91e63'
        ];

        const color = colors[segmentIndex % colors.length];
        const path = [
            [origin.lng, origin.lat],
            [destination.lng, destination.lat]
        ];

        try {
            const polyline = new AMap.Polyline({
                path: path,
                strokeColor: color,
                strokeOpacity: 0.7,
                strokeWeight: 6,  // 增加线条宽度
                strokeStyle: 'dashed', // 虚线表示直线距离
                strokeDasharray: [10, 5], // 虚线间隔
                zIndex: 100 + segmentIndex,
                lineJoin: 'round',
                lineCap: 'round'
            });

            this.map.add(polyline);
            this.polylines.push(polyline);

            console.log(`✅ 已绘制直线段 ${segmentIndex + 1} (备用方案)`);
        } catch (error) {
            console.error('❌ 绘制高德直线段失败:', error);
        }
    }

    // Google Maps简单路径绘制
    drawGoogleSimplePath(activePlaces) {
        const colors = [
            '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
            '#1abc9c', '#e67e22', '#34495e', '#f1c40f', '#e91e63'
        ];

        const path = activePlaces.map(place => ({ lat: place.lat, lng: place.lng }));

        for (let i = 0; i < path.length - 1; i++) {
            const segmentPath = [path[i], path[i + 1]];
            const color = colors[i % colors.length];

            const polyline = new google.maps.Polyline({
                path: segmentPath,
                geodesic: true,
                strokeColor: color,
                strokeOpacity: 0.8,
                strokeWeight: 4,
                zIndex: 100 + i
            });

            polyline.setMap(this.map);
            this.polylines.push(polyline);
        }
    }

    // 高德地图简单路径绘制
    drawGaodeSimplePath(activePlaces) {
        const colors = [
            '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
            '#1abc9c', '#e67e22', '#34495e', '#f1c40f', '#e91e63'
        ];

        for (let i = 0; i < activePlaces.length - 1; i++) {
            const color = colors[i % colors.length];
            const path = [
                [activePlaces[i].lng, activePlaces[i].lat],
                [activePlaces[i + 1].lng, activePlaces[i + 1].lat]
            ];

            const polyline = new AMap.Polyline({
                path: path,
                strokeColor: color,
                strokeOpacity: 0.9,
                strokeWeight: 8,  // 增加线条宽度
                strokeStyle: 'solid',
                zIndex: 100 + i,
                lineJoin: 'round',
                lineCap: 'round'
            });

            this.map.add(polyline);
            this.polylines.push(polyline);
        }
    }

    // 绘制简单路径（通用方法）
    drawSimplePath(activePlaces) {
        activePlaces = this.getUsablePlaces(activePlaces || this.travelList);

        if (!this.isMapLoaded || activePlaces.length < 2) {
            return;
        }

        const selectedMapApi = this.settings.selectedMapApi;
        console.log(`🎨 绘制简单多彩路径，使用${selectedMapApi}`);

        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
            this.drawGoogleSimplePath(activePlaces);
        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
            this.drawGaodeSimplePath(activePlaces);
        } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
            this.drawTiandituSimplePath(activePlaces);
        } else {
            console.warn('⚠️ 无法绘制路径：地图API未加载');
        }
    }

    // 天地图路线绘制
    drawTiandituRoute(activePlaces) {
        this.scheduleRoutePipeline(0);
    }

    async drawTiandituRoutesWithAPI(activePlaces) {
        return this.drawDetailedRoutesWithBff(activePlaces, 'tianditu');
    }

    async drawDetailedTiandituRoutes(activePlaces) {
        return this.drawDetailedRoutesWithBff(activePlaces, 'tianditu');
    }

    async getTiandituRoute(origin, destination) {
        return this.getBffRoute(origin, destination, 'tianditu');
    }

    // 天地图简单路径绘制
    drawTiandituSimplePath(activePlaces) {
        const colors = this.getTiandituRouteColors();
        const routeLayers = [];

        for (let i = 0; i < activePlaces.length - 1; i++) {
            const color = colors[i % colors.length];
            const path = [
                new T.LngLat(activePlaces[i].lng, activePlaces[i].lat),
                new T.LngLat(activePlaces[i + 1].lng, activePlaces[i + 1].lat)
            ];

            routeLayers.push({ path, color, lineStyle: 'solid' });
        }

        this.renderTiandituRouteLayers(routeLayers);
    }

    // 天地图底图道路颜色较丰富，使用深色描边托起高亮路线，避免与底图混淆
    renderTiandituRouteLayers(routeLayers) {
        const outlineColor = '#102a43';

        // 先绘制所有外轮廓，再绘制彩色主线，保证各路线段都处于轮廓之上
        routeLayers.forEach(({ path, lineStyle }) => {
            const outline = new T.Polyline(path, {
                color: outlineColor,
                weight: 14,
                opacity: 0.78,
                lineStyle: lineStyle
            });

            this.map.addOverLay(outline);
            this.polylines.push(outline);
        });

        routeLayers.forEach(({ path, color, lineStyle }) => {
            const route = new T.Polyline(path, {
                color: color,
                weight: 7,
                opacity: 1,
                lineStyle: lineStyle
            });

            this.map.addOverLay(route);
            this.polylines.push(route);
        });
    }

    getTiandituRouteColors() {
        return [
            '#ff4d35', '#00a6fb', '#00b86b', '#ff9f1c', '#8b5cf6',
            '#00b8a9', '#f97316', '#2563eb', '#eab308', '#ec4899'
        ];
    }

    // 扩展边界的辅助方法
    extendBounds(bounds, factor) {
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();

        const latDiff = (ne.lat() - sw.lat()) * factor;
        const lngDiff = (ne.lng() - sw.lng()) * factor;

        const extendedBounds = new google.maps.LatLngBounds();
        extendedBounds.extend({ lat: sw.lat() - latDiff, lng: sw.lng() - lngDiff });
        extendedBounds.extend({ lat: ne.lat() + latDiff, lng: ne.lng() + lngDiff });

        return extendedBounds;
    }

    // 改变地图提供商
    changeMapProvider(segmentKey, provider) {
        if (!['amap', 'google', 'bing', 'tianditu'].includes(provider)) return;
        this.dispatch({
            type: 'UPDATE_ROUTE_SEGMENT',
            segmentKey,
            config: { mapProvider: provider }
        });

        // 仅更新按钮状态，不重新计算距离时间
        const buttons = Array.from(document.querySelectorAll('button[data-action="change-map-provider"]'))
            .filter(button => button.dataset.segmentKey === String(segmentKey));
        buttons.forEach(button => {
            button.classList.remove('active');
            if (button.dataset.provider === provider) {
                button.classList.add('active');
            }
        });

        console.log(`地图提供商已更改为: ${provider}`);
    }

    // 打开导航路线 - 支持多种导航应用
    openNavigationRoute(segmentKey, fromIndex, toIndex) {
        fromIndex = Number(fromIndex);
        toIndex = Number(toIndex);
        if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) ||
            fromIndex < 0 || toIndex < 0 ||
            fromIndex >= this.travelList.length || toIndex >= this.travelList.length) return;

        const fromPlace = this.travelList[fromIndex];
        const toPlace = this.travelList[toIndex];
        if (!PlannerData.isUsablePlace(fromPlace) || !PlannerData.isUsablePlace(toPlace)) {
            this.showToast('路线坐标无效');
            return;
        }
        const navigationApp = this.settings.navigationApp;

        let url = '';
        let appName = '';

        // 根据用户设置选择导航应用
        switch (navigationApp) {
            case 'amap':
                // 高德地图
                url = `https://uri.amap.com/navigation?from=${fromPlace.lng},${fromPlace.lat}&to=${toPlace.lng},${toPlace.lat}&mode=car&policy=1&src=mypage&coordinate=gaode&callnative=0`;
                appName = '高德地图';
                break;
            case 'google':
                // Google 地图
                const origin = `${fromPlace.lat},${fromPlace.lng}`;
                const destination = `${toPlace.lat},${toPlace.lng}`;
                url = `https://www.google.com/maps/dir/${origin}/${destination}/`;
                appName = 'Google 地图';
                break;
            case 'bing':
                // Bing 地图
                url = `https://www.bing.com/maps/directions?rtp=pos.${fromPlace.lat}_${fromPlace.lng}~pos.${toPlace.lat}_${toPlace.lng}`;
                appName = 'Bing 地图';
                break;
            case 'tianditu':
                // 天地图 (天地图不支持直接的导航链接传参格式，简单指向主页或搜索页)
                // 但可以传起点和终点给其路线规划服务：
                url = `https://map.tianditu.gov.cn/?orig=${fromPlace.lng},${fromPlace.lat}&dest=${toPlace.lng},${toPlace.lat}&type=route`;
                appName = '天地图';
                break;
            default:
                // 默认使用高德地图
                url = `https://uri.amap.com/navigation?from=${fromPlace.lng},${fromPlace.lat}&to=${toPlace.lng},${toPlace.lat}&mode=car&policy=1&src=mypage&coordinate=gaode&callnative=0`;
                appName = '高德地图';
                break;
        }

        this.openNavigationUrl(url, appName, `${String(fromPlace.name || '')} → ${String(toPlace.name || '')}`, '导航');

        console.log(`打开${appName}导航: 从 "${fromPlace.name}" 到 "${toPlace.name}"`);
    }

    // 设置marker可见性（兼容Google Maps和高德地图）
    setMarkerVisible(marker, visible, label = null) {
        const selectedMapApi = this.settings.selectedMapApi;

        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
            // Google Maps marker
            if (marker && typeof marker.setVisible === 'function') {
                marker.setVisible(visible);
            }
            // Google Maps label
            if (label) {
                if (visible && this.showPlaceNames) {
                    label.show();
                } else {
                    label.hide();
                }
            }
        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
            // 高德地图marker
            if (marker) {
                if (visible) {
                    if (typeof marker.show === 'function') {
                        marker.show();
                    }
                } else {
                    if (typeof marker.hide === 'function') {
                        marker.hide();
                    }
                }
            }
            // 高德地图 label (也是一个 Marker)
            if (label) {
                if (visible && this.showPlaceNames) {
                    if (typeof label.show === 'function') label.show();
                } else {
                    if (typeof label.hide === 'function') label.hide();
                }
            }
        } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
            // 天地图 marker 和 label 的显示隐藏通常通过透明度控制或 setOpacity/hide() 方法
            if (marker) {
                if (visible) {
                    if (typeof marker.show === 'function') marker.show();
                    else marker.setOpacity && marker.setOpacity(1);
                } else {
                    if (typeof marker.hide === 'function') marker.hide();
                    else marker.setOpacity && marker.setOpacity(0);
                }
            }
            if (label) {
                if (visible && this.showPlaceNames) {
                    if (typeof label.show === 'function') label.show();
                    else label.setOpacity && label.setOpacity(1);
                } else {
                    if (typeof label.hide === 'function') label.hide();
                    else label.setOpacity && label.setOpacity(0);
                }
            }
        } else {
            console.warn('⚠️ 未知的地图API类型，无法设置marker可见性');
        }
    }

    // 计算单个路线段距离
    async calculateSegmentDistance(segmentKey) {
        const [fromId, toId] = segmentKey.split('-');
        const fromPlace = this.travelList.find(p => p.id.toString() === fromId);
        const toPlace = this.travelList.find(p => p.id.toString() === toId);

        if (!PlannerData.isUsablePlace(fromPlace) || !PlannerData.isUsablePlace(toPlace)) return;
        const result = await this.calculateBffDistance(fromPlace, toPlace);
        const distanceElement = document.getElementById(`distance-${toId}`);
        const durationElement = document.getElementById(`duration-${toId}`);
        if (!result.success) {
            this.calculateSegmentDistanceWithStraightLine(fromPlace, toPlace, toId, '直线');
            return;
        }
        const metrics = PlannerData.createRouteMetrics(result.distanceMeters, result.durationSeconds);
        this.routeMetrics.set(`${fromPlace.id}-${toPlace.id}`, metrics);
        if (distanceElement) distanceElement.textContent = `${(metrics.distanceMeters / 1000).toFixed(1)} 公里`;
        if (durationElement) durationElement.textContent = `${Math.round(metrics.durationSeconds / 60)} 分钟`;
    }

    calculateSegmentDistanceWithGoogle(fromPlace, toPlace, toId) {
        return this.calculateSegmentDistance(`${fromPlace.id}-${toId}`);
    }

    calculateSegmentDistanceWithGaode(fromPlace, toPlace, toId) {
        return this.calculateSegmentDistance(`${fromPlace.id}-${toId}`);
    }

    calculateSegmentDistanceWithTianditu(fromPlace, toPlace, toId) {
        return this.calculateSegmentDistance(`${fromPlace.id}-${toId}`);
    }

    // 使用直线距离计算路线段距离
    calculateSegmentDistanceWithStraightLine(fromPlace, toPlace, toId, suffix = '直线') {
        if (!PlannerData.isUsablePlace(fromPlace) || !PlannerData.isUsablePlace(toPlace)) return;
        const distanceKm = this.calculateStraightDistance(fromPlace.lat, fromPlace.lng, toPlace.lat, toPlace.lng);
        const metrics = PlannerData.createRouteMetrics(distanceKm * 1000, (distanceKm / 50) * 3600);
        this.routeMetrics.set(`${fromPlace.id}-${toPlace.id}`, metrics);
        const distanceElement = document.getElementById(`distance-${toId}`);
        const durationElement = document.getElementById(`duration-${toId}`);

        if (distanceElement) {
            distanceElement.textContent = `${distanceKm.toFixed(1)} 公里 (${suffix})`;
        }
        if (durationElement) {
            durationElement.textContent = `约${Math.round(metrics.durationSeconds / 60)} 分钟`;
        }
    }

    // 获取当前位置
    getCurrentLocation() {
        console.log('🎯 开始获取当前位置...');

        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const lat = position.coords.latitude;
                    const lng = position.coords.longitude;
                    this.currentLocation = { lat, lng };

                    console.log(`📍 获取到位置: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);

                    if (this.isMapLoaded) {
                        const selectedMapApi = this.settings.selectedMapApi;

                        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                            this.setCurrentLocationGoogle(lat, lng);
                        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                            this.setCurrentLocationGaode(lat, lng);
                        } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
                            this.setCurrentLocationTianditu(lat, lng);
                        } else {
                            console.warn('地图API未加载，无法在地图上显示位置');
                        }
                    }

                    this.showToast(`✅ 已定位到您的位置: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
                },
                (error) => {
                    console.error('❌ 定位失败:', error);
                    let errorMessage = '定位失败: ';
                    switch (error.code) {
                        case error.PERMISSION_DENIED:
                            errorMessage += '用户拒绝了定位请求';
                            break;
                        case error.POSITION_UNAVAILABLE:
                            errorMessage += '位置信息不可用';
                            break;
                        case error.TIMEOUT:
                            errorMessage += '定位请求超时';
                            break;
                        default:
                            errorMessage += error.message;
                    }
                    this.showToast(errorMessage);
                }
            );
        } else {
            this.showToast('❌ 您的浏览器不支持地理定位功能');
        }
    }

    // Google Maps 设置当前位置
    setCurrentLocationGoogle(lat, lng) {
        try {
            this.map.setCenter({ lat: lat, lng: lng });
            this.map.setZoom(15);

            // 添加当前位置标记
            if (this.currentLocationMarker) {
                this.currentLocationMarker.setMap(null);
            }

            this.currentLocationMarker = new google.maps.Marker({
                position: { lat: lat, lng: lng },
                map: this.map,
                title: '我的位置',
                icon: {
                    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
                        Security.renderLocationMarkerSvg('compact')
                    ),
                    scaledSize: new google.maps.Size(24, 24)
                }
            });

            console.log('✅ Google Maps 当前位置标记已设置');
        } catch (error) {
            console.error('❌ Google Maps 设置位置失败:', error);
        }
    }

    // 高德地图设置当前位置
    setCurrentLocationGaode(lat, lng) {
        try {
            this.map.setCenter([lng, lat]); // 高德地图使用 [经度, 纬度] 格式
            this.map.setZoom(15);

            // 添加当前位置标记
            if (this.currentLocationMarker) {
                this.map.remove(this.currentLocationMarker);
            }

            this.currentLocationMarker = new AMap.Marker({
                position: [lng, lat],
                title: '我的位置',
                content: Security.renderMapSdkHtml('current-location')
            });

            this.map.add(this.currentLocationMarker);

            console.log('✅ 高德地图当前位置标记已设置');
        } catch (error) {
            console.error('❌ 高德地图设置位置失败:', error);
        }
    }

    // 切换卫星图
    toggleSatellite() {
        if (!this.isMapLoaded) return;

        const selectedMapApi = this.settings.selectedMapApi;
        const satelliteBtn = document.getElementById('satelliteBtn');

        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
            // Google Maps 切换
            if (this.isSatelliteMode) {
                this.map.setMapTypeId(google.maps.MapTypeId.ROADMAP);
                satelliteBtn.textContent = '🛰️ 卫星图';
                satelliteBtn.title = '切换到卫星图';
                this.isSatelliteMode = false;
                this.showToast('已切换到普通地图');
            } else {
                this.map.setMapTypeId(google.maps.MapTypeId.SATELLITE);
                satelliteBtn.textContent = '🗺️ 普通图';
                satelliteBtn.title = '切换到普通图';
                this.isSatelliteMode = true;
                this.showToast('已切换到卫星图');
            }
        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
            // 高德地图切换 - 使用图层方式
            console.log(`🗺️ 高德地图切换卫星图 - 当前模式: ${this.isSatelliteMode ? '卫星图' : '普通图'}`);

            try {
                if (this.isSatelliteMode) {
                    // 切换回普通地图
                    console.log('🔄 切换到普通地图...');

                    // 立即更新按钮提供视觉反馈
                    satelliteBtn.textContent = '🛰️ 卫星图';
                    satelliteBtn.title = '切换到卫星图';

                    // 使用标准图层
                    const standardLayer = new AMap.TileLayer();
                    this.map.setLayers([standardLayer]);
                    this.isSatelliteMode = false;

                    setTimeout(() => {
                        this.showToast('已切换到普通地图');
                        console.log('✅ 普通地图切换完成');
                    }, 200);
                } else {
                    // 切换到卫星图
                    console.log('🔄 切换到卫星图...');

                    // 立即更新按钮提供视觉反馈
                    satelliteBtn.textContent = '🗺️ 普通图';
                    satelliteBtn.title = '切换到普通图';

                    // 使用卫星图层
                    const satelliteLayer = new AMap.TileLayer.Satellite();
                    this.map.setLayers([satelliteLayer]);
                    this.isSatelliteMode = true;

                    setTimeout(() => {
                        this.showToast('已切换到卫星图');
                        console.log('✅ 卫星图切换完成');
                    }, 200);
                }
            } catch (error) {
                console.error('❌ 高德地图图层切换失败:', error);

                // 回滚按钮状态
                if (this.isSatelliteMode) {
                    satelliteBtn.textContent = '🗺️ 普通图';
                    satelliteBtn.title = '切换到普通图';
                } else {
                    satelliteBtn.textContent = '🛰️ 卫星图';
                    satelliteBtn.title = '切换到卫星图';
                }

                this.showToast('❌ 地图类型切换失败');
            }
        } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
            try {
                if (this.isSatelliteMode) {
                    this.map.setMapType(TMAP_NORMAL_MAP);
                    satelliteBtn.textContent = '🛰️ 卫星图';
                    satelliteBtn.title = '切换到卫星图';
                    this.isSatelliteMode = false;
                    this.showToast('已切换到普通地图');
                } else {
                    this.map.setMapType(TMAP_HYBRID_MAP);
                    satelliteBtn.textContent = '🗺️ 普通图';
                    satelliteBtn.title = '切换到普通图';
                    this.isSatelliteMode = true;
                    this.showToast('已切换到卫星图');
                }
            } catch (error) {
                console.error('❌ 天地图图层切换失败:', error);
                this.showToast('❌ 地图类型切换失败');
            }
        } else {
            this.showToast('⚠️ 当前地图API不支持卫星图切换');
        }
        satelliteBtn.setAttribute('aria-pressed', String(this.isSatelliteMode));
    }

    // 切换显示/隐藏地点名称
    togglePlaceNames() {
        if (!this.isMapLoaded) return;

        this.showPlaceNames = !this.showPlaceNames;
        const toggleBtn = document.getElementById('toggleNamesBtn');
        toggleBtn.setAttribute('aria-pressed', String(this.showPlaceNames));
        const selectedMapApi = this.settings.selectedMapApi;

        if (this.placeLabels.length > 0 || this.pendingMarkers.length > 0) {
            if (this.showPlaceNames) {
                // 显示所有地点名称（包括游玩点和待定点）
                this.placeLabels.forEach(l => {
                    if (l.label) {
                        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                            l.label.show();
                        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                            l.label.show();
                        } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
                            if (typeof l.label.show === 'function') l.label.show();
                            else l.label.setOpacity && l.label.setOpacity(1);
                        }
                    }
                });
                this.pendingMarkers.forEach(m => {
                    if (m.label) {
                        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                            m.label.show();
                        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                            m.label.show();
                        } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
                            if (typeof m.label.show === 'function') m.label.show();
                            else m.label.setOpacity && m.label.setOpacity(1);
                        }
                    }
                });
                toggleBtn.textContent = '🏷️ 隐藏名称';
                toggleBtn.title = '隐藏地点名称';
                this.showToast('已显示地点名称');

                // 显示后自动调整位置以防重叠
                setTimeout(() => this.adjustLabels(), 300);
            } else {
                // 隐藏所有地点名称（包括游玩点和待定点）
                this.placeLabels.forEach(l => {
                    if (l.label) {
                        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                            l.label.hide();
                        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                            l.label.hide();
                        } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
                            if (typeof l.label.hide === 'function') l.label.hide();
                            else l.label.setOpacity && l.label.setOpacity(0);
                        }
                    }
                });
                this.pendingMarkers.forEach(m => {
                    if (m.label) {
                        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                            m.label.hide();
                        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                            m.label.hide();
                        } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
                            if (typeof m.label.hide === 'function') m.label.hide();
                            else m.label.setOpacity && m.label.setOpacity(0);
                        }
                    }
                });
                toggleBtn.textContent = '🏷️ 显示名称';
                toggleBtn.title = '显示地点名称';
                this.showToast('已隐藏地点名称');
            }
        } else {
            // 重新创建标记和标签
            this.recreateMarkers();
            toggleBtn.textContent = this.showPlaceNames ? '🏷️ 隐藏名称' : '🏷️ 显示名称';
            toggleBtn.title = this.showPlaceNames ? '隐藏地点名称' : '显示地点名称';
            this.showToast(this.showPlaceNames ? '已显示地点名称' : '已隐藏地点名称');

            if (this.showPlaceNames) {
                setTimeout(() => this.adjustLabels(), 300);
            }
        }
    }

    // 自动调整标签位置以防止重叠
    adjustLabels() {
        if (!this.isMapLoaded || !this.showPlaceNames) return;

        // 使用 requestAnimationFrame 进行节流，防止高频触发导致的性能问题
        if (this.adjustLabelsRafId) {
            cancelAnimationFrame(this.adjustLabelsRafId);
        }

        this.adjustLabelsRafId = requestAnimationFrame(() => {
            this._executeAdjustLabels();
            this.adjustLabelsRafId = null;
        });
    }

    // 内部执行避让算法的方法
    _executeAdjustLabels() {
        const selectedMapApi = this.settings.selectedMapApi;

        // 获取所有活跃且可见的标签
        const allLabels = [];
        this.placeLabels.forEach(l => {
            if (l.label) {
                let isVisible = true;
                if (selectedMapApi === 'google') {
                    isVisible = l.label.div && l.label.div.style.opacity !== '0';
                } else if (selectedMapApi === 'gaode') {
                    isVisible = l.label.getVisible();
                } else if (selectedMapApi === 'tianditu') {
                    isVisible = l.label.getOpacity ? l.label.getOpacity() !== 0 : true;
                }
                if (isVisible) allLabels.push({ type: 'place', data: l });
            }
        });

        if (this.showPendingPlaces) {
            this.pendingMarkers.forEach(m => {
                if (m.label) {
                    let isVisible = true;
                    if (selectedMapApi === 'google') {
                        isVisible = m.label.div && m.label.div.style.opacity !== '0';
                    } else if (selectedMapApi === 'gaode') {
                        isVisible = m.label.getVisible();
                    } else if (selectedMapApi === 'tianditu') {
                        isVisible = m.label.getOpacity ? m.label.getOpacity() !== 0 : true;
                    }
                    if (isVisible) allLabels.push({ type: 'pending', data: m });
                }
            });
        }
        if (allLabels.length === 0) return;

        // 1. 批量读取 DOM 尺寸和初始位置（减少重排）
        const labelData = allLabels.map(item => {
            let labelElement = null;
            if (selectedMapApi === 'google') {
                labelElement = item.data.label.div;
            } else if (selectedMapApi === 'gaode') {
                labelElement = item.data.label.getElement();
                if (labelElement) labelElement = labelElement.querySelector('div');
            } else if (selectedMapApi === 'tianditu') {
                labelElement = item.data.label.getElement ? item.data.label.getElement() : null;
                if (labelElement) labelElement = labelElement.querySelector('div') || labelElement;
            }

            if (!labelElement) return null;

            // 获取或缓存尺寸
            const labelId = item.data.id;
            let size = this.labelSizeCache.get(labelId);
            if (!size || labelElement.offsetWidth !== size.width) {
                size = {
                    width: labelElement.offsetWidth || 100,
                    height: labelElement.offsetHeight || 32
                };
                this.labelSizeCache.set(labelId, size);
            }

            // 获取屏幕坐标
            let centerX = 0, centerY = 0, pinTop = 0;
            if (selectedMapApi === 'google') {
                const projection = item.data.label.getProjection();
                if (projection) {
                    const pos = projection.fromLatLngToDivPixel(item.data.label.position);
                    centerX = pos.x;
                    centerY = pos.y - 85;
                    pinTop = pos.y - 55;
                }
            } else if (selectedMapApi === 'gaode') {
                const pos = this.map.lngLatToContainer(item.data.label.getPosition());
                centerX = pos.getX();
                centerY = pos.getY() - 85;
                pinTop = pos.getY() - 55;
            } else if (selectedMapApi === 'tianditu') {
                const pos = this.map.lngLatToContainerPoint(item.data.label.getLngLat());
                centerX = pos.x;
                centerY = pos.y - 85;
                pinTop = pos.y - 55;
            }

            return {
                item: item,
                centerX, centerY, pinTop,
                width: size.width,
                height: size.height,
                offsetX: 0, offsetY: 0
            };
        }).filter(d => d && d.centerX !== 0);

        // 2. 预计算候选位置（仅在首次或需要时）
        if (!this.labelCandidates) {
            const candidates = [];
            const stepX = 45;
            const stepY = 35;
            for (let row = 0; row <= 5; row++) {
                for (let col = -3; col <= 3; col++) {
                    const x = col * stepX;
                    const y = row * stepY;
                    candidates.push({ x, y, dist: Math.sqrt(x * x + y * y) });
                }
            }
            this.labelCandidates = candidates.sort((a, b) => a.dist - b.dist);
        }

        // 3. 执行避让数学计算
        const useSpatialIndex = labelData.length >= 16;
        const occupiedRects = [];
        const spatialGrid = useSpatialIndex ? new PerformanceCore.SpatialGrid(96) : null;
        let collisionComparisons = 0;
        const padding = 6;
        const occupy = rect => {
            if (spatialGrid) spatialGrid.insert(rect);
            else occupiedRects.push(rect);
        };
        const conflictsWithOccupied = (rect, owner) => {
            if (spatialGrid) return spatialGrid.intersects(rect, owner);
            return occupiedRects.some(candidate => {
                if (candidate.type === 'pin' && candidate.owner === owner) return false;
                collisionComparisons += 1;
                return !(rect.right < candidate.left || rect.left > candidate.right ||
                    rect.bottom < candidate.top || rect.top > candidate.bottom);
            });
        };

        // 优先锁定图标区域为禁区
        labelData.forEach(label => {
            occupy({
                type: 'pin',
                owner: label,
                left: label.centerX - 18,
                right: label.centerX + 18,
                top: label.pinTop - 5,
                bottom: label.pinTop + 55
            });
        });

        labelData.forEach(label => {
            for (let candidate of this.labelCandidates) {
                const rect = {
                    left: label.centerX + candidate.x - label.width / 2 - padding,
                    right: label.centerX + candidate.x + label.width / 2 + padding,
                    top: label.centerY - candidate.y - padding,
                    bottom: label.centerY - candidate.y + label.height + padding
                };

                // 名称默认位置已与自己的大头针留有间距，只避让其他占用区。
                const conflict = conflictsWithOccupied(rect, label);

                if (!conflict) {
                    label.offsetX = candidate.x;
                    label.offsetY = candidate.y;
                    occupy({ ...rect, type: 'label', owner: label });
                    break;
                }
            }
        });
        collisionComparisons += spatialGrid?.comparisons || 0;
        if (this.performanceMetrics) {
            this.performanceMetrics.labelCollisionComparisons += collisionComparisons;
        }

        // 4. 批量应用样式（统一渲染）
        labelData.forEach(data => {
            if (selectedMapApi === 'google') {
                data.item.data.label.setOffset(data.offsetX, data.offsetY);
            } else if (selectedMapApi === 'gaode') {
                data.item.data.label.setOffset(new AMap.Pixel(data.offsetX, -75 - data.offsetY));
                this.updateGaodeLabelLine(data.item.data.label, data.offsetX, data.offsetY);
            } else if (selectedMapApi === 'tianditu') {
                data.item.data.label.setOffset(new T.Point(data.offsetX - 30, -75 - data.offsetY));
            }
        });
    }

    // 更新高德地图标签的连线
    updateGaodeLabelLine(labelMarker, offsetX, offsetY) {
        let labelElement = labelMarker.getElement();
        if (!labelElement) return;

        let lineContainer = labelElement.querySelector('.label-leader-line');

        if (offsetX === 0 && offsetY === 0) {
            if (lineContainer) lineContainer.style.opacity = '0';
            return;
        }

        if (!lineContainer) {
            lineContainer = document.createElement('div');
            lineContainer.className = 'label-leader-line';
            lineContainer.style.cssText = `
                position: absolute;
                pointer-events: none;
                z-index: -1;
                transition: opacity 0.2s ease;
            `;
            labelElement.appendChild(lineContainer);
        }

        lineContainer.style.opacity = '1';

        // 计算连线起点和终点
        const startX = -offsetX;
        const startY = 45 + offsetY;
        const endX = 0;
        const endY = 25;

        const width = Math.abs(startX - endX);
        const height = Math.abs(startY - endY);
        const left = Math.min(startX, endX);
        const top = Math.min(startY, endY);

        lineContainer.style.width = Math.max(width, 2) + 'px';
        lineContainer.style.height = Math.max(height, 2) + 'px';
        lineContainer.style.left = `calc(50% + ${left}px)`;
        lineContainer.style.top = `${top}px`;

        // 使用 DOM SVG API 画虚线，数值不经过 HTML 解析器。
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', String(Math.max(width, 2)));
        svg.setAttribute('height', String(Math.max(height, 2)));
        svg.style.overflow = 'visible';
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', String(startX - left));
        line.setAttribute('y1', String(startY - top));
        line.setAttribute('x2', String(endX - left));
        line.setAttribute('y2', String(endY - top));
        line.style.stroke = 'rgba(102, 126, 234, 0.6)';
        line.style.strokeWidth = '2';
        line.style.strokeDasharray = '4,3';
        svg.appendChild(line);
        lineContainer.replaceChildren(svg);
    }

    // 更新待定点按钮状态
    updateTogglePendingButton() {
        const toggleBtn = document.getElementById('togglePendingBtn');
        if (!toggleBtn) return;

        const pendingCount = this.travelList.filter(place => place.isPending).length;

        if (this.showPendingPlaces) {
            toggleBtn.textContent = '⏳ 隐藏待定点';
            toggleBtn.title = '隐藏待定游玩点';
            // 如果当前显示待定点，重新创建待定点标记
            if (this.isMapLoaded) {
                this.createPendingMarkers();
            }
        } else {
            toggleBtn.textContent = '⏳ 显示待定点';
            toggleBtn.title = '在地图上显示待定游玩点';
            // 如果当前隐藏待定点，清除待定点标记
            if (this.isMapLoaded) {
                this.clearPendingMarkers();
            }
        }
        toggleBtn.setAttribute('aria-pressed', String(this.showPendingPlaces));

        console.log(`🔄 待定点按钮状态已更新: ${this.showPendingPlaces ? '显示' : '隐藏'}, 待定点数量: ${pendingCount}`);
    }

    // 切换显示/隐藏待定点
    togglePendingPlaces() {
        if (!this.isMapLoaded) return;

        this.showPendingPlaces = !this.showPendingPlaces;
        const toggleBtn = document.getElementById('togglePendingBtn');

        if (this.showPendingPlaces) {
            // 显示待定点
            this.createPendingMarkers();
            toggleBtn.textContent = '⏳ 隐藏待定点';
            toggleBtn.title = '隐藏待定游玩点';
            const pendingCount = this.travelList.filter(place => place.isPending).length;

            // 调整地图视角以显示所有地点（游玩点和待定点）
            this.fitMapToAllPlaces();

            this.showToast(`已显示 ${pendingCount} 个待定点并调整地图视角`);
        } else {
            // 隐藏待定点
            this.clearPendingMarkers();
            toggleBtn.textContent = '⏳ 显示待定点';
            toggleBtn.title = '在地图上显示待定游玩点';
            // 强制应用城市过滤以确保所有待定点都被隐藏（但不调整地图视角）
            this.applyCityFilterWithoutFitting();
            this.showToast('已隐藏待定点');
        }
        toggleBtn.setAttribute('aria-pressed', String(this.showPendingPlaces));
    }

    // 创建待定点标记
    createPendingMarkers() {
        this.syncPendingMarkersIncremental();
    }

    pendingMarkerSignature(place) {
        return JSON.stringify([
            this.settings.selectedMapApi,
            String(place.id),
            Number(place.lat),
            Number(place.lng),
            place.customName || place.name,
            this.showPlaceNames
        ]);
    }

    removePendingMarkerById(id) {
        const markerData = this.pendingMarkers.find(item => String(item.id) === String(id));
        if (!markerData) return;
        const selectedMapApi = this.settings.selectedMapApi;
        if (markerData.marker) {
            if (selectedMapApi === 'google' && typeof google !== 'undefined') markerData.marker.setMap(null);
            else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') this.map.remove(markerData.marker);
            else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') this.map.removeOverLay(markerData.marker);
        }
        if (markerData.label) {
            if (selectedMapApi === 'google' && typeof google !== 'undefined') markerData.label.setMap(null);
            else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') this.map.remove(markerData.label);
            else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') this.map.removeOverLay(markerData.label);
        }
        this.pendingMarkers = this.pendingMarkers.filter(item => String(item.id) !== String(id));
        this.labelSizeCache?.delete(id);
        this.labelSizeCache?.delete(String(id));
    }

    syncPendingMarkersIncremental() {
        if (!this.isMapLoaded) return;
        if (!this.showPendingPlaces) {
            if (this.pendingMarkers.length > 0) this.clearPendingMarkers();
            return;
        }
        const pendingPlaces = this.travelList.filter(place => place.isPending && PlannerData.isValidCoordinate(place));
        const expected = new Map(pendingPlaces.map(place => [String(place.id), place]));
        Array.from(this.pendingMarkers).forEach(markerData => {
            const place = expected.get(String(markerData.id));
            if (!place || markerData.renderSignature !== this.pendingMarkerSignature(place)) {
                this.removePendingMarkerById(markerData.id);
                if (this.performanceMetrics) this.performanceMetrics.markerDeletes += 1;
            }
        });
        pendingPlaces.forEach(place => {
            if (this.pendingMarkers.some(item => String(item.id) === String(place.id))) return;
            this.addPendingMarker(place);
            const added = this.pendingMarkers.find(item => String(item.id) === String(place.id));
            if (added) added.renderSignature = this.pendingMarkerSignature(place);
            if (this.performanceMetrics) this.performanceMetrics.markerCreates += 1;
        });
        this.applyCityFilterWithoutFitting();
    }

    // 清除待定点标记
    clearPendingMarkers() {
        const selectedMapApi = this.settings.selectedMapApi;

        this.pendingMarkers.forEach(markerData => {
            if (markerData.marker) {
                if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                    markerData.marker.setMap(null);
                } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                    this.map.remove(markerData.marker);
                } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
                    this.map.removeOverLay(markerData.marker);
                }
            }
            if (markerData.label) {
                if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                    markerData.label.setMap(null);
                } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                    this.map.remove(markerData.label);
                } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
                    this.map.removeOverLay(markerData.label);
                }
            }
            this.labelSizeCache?.delete(markerData.id);
            this.labelSizeCache?.delete(String(markerData.id));
        });
        this.pendingMarkers = [];
    }

    // 添加待定点标记
    addPendingMarker(place) {
        if (!this.isMapLoaded) return;
        if (!PlannerData.isValidCoordinate(place)) return;

        // 使用自定义名称（如果有的话）
        const displayName = place.customName || place.name;
        const selectedMapApi = this.settings.selectedMapApi;
        let marker = null;
        let placeLabel = null;

        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
            // Google Maps 待定点标记
            marker = this.createGooglePendingMarker(place, displayName);

            // 创建Google Maps标签
            if (PlaceLabel) {
                placeLabel = new PlaceLabel(
                    { lat: place.lat, lng: place.lng },
                    displayName,
                    this.map
                );

                // 根据当前名称显示状态决定是否显示
                if (!this.showPlaceNames) {
                    placeLabel.hide();
                }
            }
        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
            // 高德地图待定点标记
            marker = this.createGaodePendingMarker(place, displayName);

            // 创建高德地图标签
            if (this.showPlaceNames) {
                placeLabel = this.createGaodePendingLabel(place, displayName);
            }
        } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined') {
            // 天地图待定点标记
            marker = this.createTiandituPendingMarker(place, displayName);

            // 创建天地图标签
            if (this.showPlaceNames) {
                placeLabel = this.createTiandituPendingLabel(place, displayName);
            }
        } else {
            console.warn('⚠️ 无法创建待定点标记：地图API未加载');
            return;
        }

        // 存储标记信息
        this.pendingMarkers.push({
            id: place.id,
            marker: marker,
            label: placeLabel,
            place: place
        });
    }

    // 创建Google Maps待定点标记
    createGooglePendingMarker(place, displayName) {
        const marker = new google.maps.Marker({
            position: { lat: place.lat, lng: place.lng },
            map: this.map,
            title: `⏳ ${displayName}`,
            icon: {
                url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
                    Security.renderMapMarkerSvg({ pending: true })
                ),
                scaledSize: new google.maps.Size(40, 50),
                anchor: new google.maps.Point(20, 50)
            },
            zIndex: 500 // 确保待定点在游玩点之下
        });

        // 添加点击事件
        marker.addListener('click', () => {
            this.showPlaceModal({
                name: place.name,
                address: place.address,
                lng: place.lng,
                lat: place.lat,
                customName: place.customName,
                notes: place.notes,
                isPending: true
            });
        });

        return marker;
    }

    // 创建高德地图待定点标记
    createGaodePendingMarker(place, displayName) {
        const marker = new AMap.Marker({
            position: [place.lng, place.lat],
            title: `⏳ ${displayName}`,
            content: Security.renderMapSdkHtml('pending-marker'),
            anchor: 'bottom-center',
            zIndex: 500
        });

        // 添加点击事件
        marker.on('click', () => {
            this.showPlaceModal({
                name: place.name,
                address: place.address,
                lng: place.lng,
                lat: place.lat,
                customName: place.customName,
                notes: place.notes,
                isPending: true
            });
        });

        this.map.add(marker);
        return marker;
    }

    // 创建高德地图待定点标签
    createGaodePendingLabel(place, displayName) {
        const labelMarker = new AMap.Marker({
            position: [place.lng, place.lat],
            offset: new AMap.Pixel(0, -75),
            content: Security.renderMapSdkHtml('pending-label', { text: displayName }),
            anchor: 'bottom-center',
            zIndex: 600,
            clickable: false
        });

        this.map.add(labelMarker);
        return labelMarker;
    }

    // 创建天地图待定点标记
    createTiandituPendingMarker(place, displayName) {
        const pendingMarkerSvg = Security.renderMapMarkerSvg({ pending: true });

        const icon = new T.Icon({
            iconUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(pendingMarkerSvg),
            iconSize: new T.Point(40, 50),
            iconAnchor: new T.Point(20, 50)
        });

        const marker = new T.Marker(new T.LngLat(place.lng, place.lat), { icon: icon });

        // 添加点击事件
        marker.addEventListener('click', () => {
            this.showPlaceModal({
                name: place.name,
                address: place.address,
                lng: place.lng,
                lat: place.lat,
                customName: place.customName,
                notes: place.notes,
                isPending: true
            });
        });

        this.map.addOverLay(marker);
        return marker;
    }

    // 创建天地图待定点标签
    createTiandituPendingLabel(place, displayName) {
        const labelHtml = Security.renderMapSdkHtml('pending-label', { text: displayName });

        const label = new T.Label({
            text: labelHtml,
            position: new T.LngLat(place.lng, place.lat),
            offset: new T.Point(0, -60),
            className: 'travel-map-label travel-map-label--pending'
        });

        // 移除默认边框
        label.setBackgroundColor('transparent');
        label.setBorderColor('transparent');

        this.map.addOverLay(label);
        return label;
    }

    // 天地图设置当前位置
    setCurrentLocationTianditu(lat, lng) {
        const locationSvg = Security.renderLocationMarkerSvg('pulse');

        const icon = new T.Icon({
            iconUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(locationSvg),
            iconSize: new T.Point(40, 40),
            iconAnchor: new T.Point(20, 20)
        });

        const lnglat = new T.LngLat(lng, lat);
        if (this.currentLocationMarker) {
            this.map.removeOverLay(this.currentLocationMarker);
        }
        this.currentLocationMarker = new T.Marker(lnglat, { icon: icon, zIndexOffset: 1000 });
        this.map.addOverLay(this.currentLocationMarker);

        // 如果这是唯一一个位置点，或没有其他地点，自适应地图
        if (this.travelList.length === 0) {
            this.map.centerAndZoom(lnglat, 14);
        } else {
            this.map.panTo(lnglat);
        }
    }

    // 创建城市过滤按钮
    createCityFilterButton() {
        const mapControls = document.querySelector('.map-controls');
        if (!mapControls) {
            console.error('地图控制容器未找到');
            return;
        }

        this.cityFilterBtn = document.createElement('button');
        this.cityFilterBtn.className = 'control-btn city-filter-btn';
        this.cityFilterBtn.textContent = '🏙️ 全部城市';
        this.cityFilterBtn.title = '切换城市显示';
        this.cityFilterBtn.style.display = 'block'; // 默认显示
        this.cityFilterBtn.addEventListener('click', () => this.toggleCityFilter());
        mapControls.appendChild(this.cityFilterBtn);

        console.log('城市过滤按钮已创建');
    }



    // 设置快速悬停提示
    setupFastTooltips() {
        // 处理所有带title属性的按钮
        const handleTooltip = (element) => {
            let originalTitle = '';

            element.addEventListener('mouseenter', () => {
                originalTitle = element.getAttribute('title') || '';
                if (originalTitle) {
                    element.setAttribute('data-tooltip', originalTitle);
                    // 保留title属性，让CSS可以同时支持两种方式
                }
            });

            element.addEventListener('mouseleave', () => {
                // 清理data-tooltip属性，保留原始title
                if (originalTitle) {
                    element.removeAttribute('data-tooltip');
                }
            });
        };

        // 使用 MutationObserver 监听动态添加的按钮
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1) { // 元素节点
                        // 检查新增的按钮 - 包含所有按钮类型
                        if (node.matches && (node.matches('.control-btn') || node.matches('.action-btn') || node.matches('.activate-btn') || node.matches('.pending-btn'))) {
                            handleTooltip(node);
                        }
                        // 检查新增元素的子按钮 - 包含所有按钮类型
                        const buttons = node.querySelectorAll && node.querySelectorAll('.control-btn, .action-btn, .activate-btn, .pending-btn');
                        if (buttons) {
                            buttons.forEach(handleTooltip);
                        }
                    }
                });
            });
        });

        // 开始观察
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // 处理现有的按钮 - 包含所有按钮类型
        document.querySelectorAll('.control-btn, .action-btn, .activate-btn, .pending-btn').forEach(handleTooltip);
    }



    // 从地址中提取城市名称
    extractCityFromAddress(address) {
        if (!address) return '未知城市';

        // 尝试匹配常见的城市格式（支持中英文）
        const cityPatterns = [
            /([^,，\s]*市)/,           // 匹配"XX市"
            /([^,，\s]*县)/,           // 匹配"XX县"
            /([^,，\s]*区)/,           // 匹配"XX区"
            /([^,，\s]*自治区)/,       // 匹配"XX自治区"
            /([^,，\s]*省)/,           // 匹配"XX省"
            /, ([^,]+),/,              // 匹配英文地址中的城市
            /([A-Z][a-z]+ City)/,      // 匹配"City"结尾的城市
            /([A-Z][a-z]+ Province)/,  // 匹配"Province"结尾的省份
            /\b([A-Z][a-z]+)\b(?=.*[A-Z]{2,})/  // 匹配英文城市名（前面有大写国家代码）
        ];

        for (let pattern of cityPatterns) {
            const match = address.match(pattern);
            if (match && match[1]) {
                let city = match[1].trim();
                // 清理可能的标点符号
                city = city.replace(/[,，。\.]/g, '');
                if (city.length > 0) {
                    console.log(`从"${address}"中提取城市: "${city}"`);
                    return city;
                }
            }
        }

        // 如果没有匹配到，尝试从逗号或中文逗号分割的地址中获取
        const parts = address.split(/[,，]/).map(part => part.trim()).filter(part => part.length > 0);
        console.log(`地址分割结果:`, parts);

        if (parts.length >= 2) {
            // 优先选择包含"市"、"县"、"区"等关键词的部分
            for (let part of parts) {
                if (/[市县区省]/.test(part)) {
                    console.log(`从分割部分选择城市: "${part}"`);
                    return part.replace(/[,，。\.]/g, '');
                }
            }
            // 如果没有找到带关键词的，使用倒数第二个部分
            let city = parts[Math.max(0, parts.length - 2)];
            console.log(`使用倒数第二部分作为城市: "${city}"`);
            return city;
        }

        console.log(`无法识别城市，使用默认值: "其他地区"`);
        return '其他地区';
    }

    // 获取所有城市列表
    getAllCities() {
        const cities = new Set();
        this.getUsablePlaces().forEach(place => {
            const city = this.extractCityFromAddress(place.address);
            cities.add(city);
        });
        return Array.from(cities).sort();
    }

    // 切换城市过滤
    toggleCityFilter() {
        const cities = this.getAllCities();

        if (cities.length <= 1) {
            alert('当前只有一个城市的地点，无需过滤');
            return;
        }

        // 创建城市选择菜单
        let currentIndex = -1;
        const allOptions = ['全部城市', ...cities];

        // 找到当前选中的选项
        if (this.currentCityFilter === 'all') {
            currentIndex = 0;
        } else {
            currentIndex = cities.indexOf(this.currentCityFilter) + 1;
        }

        // 切换到下一个选项
        currentIndex = (currentIndex + 1) % allOptions.length;
        const selectedOption = allOptions[currentIndex];

        if (selectedOption === '全部城市') {
            this.currentCityFilter = 'all';
            this.cityFilterBtn.textContent = '🏙️ 全部城市';
        } else {
            this.currentCityFilter = selectedOption;
            this.cityFilterBtn.textContent = `🏙️ ${selectedOption}`;
        }

        // 应用过滤
        this.applyyCityFilter();
    }

    // 应用城市过滤
    applyyCityFilter() {
        if (!this.isMapLoaded) return;

        // 隐藏所有标记（游玩点和其对应的标签）
        this.markers.forEach(markerObj => {
            const labelObj = this.placeLabels.find(l => l.id.toString() === markerObj.id.toString());
            this.setMarkerVisible(markerObj.marker, false, labelObj ? labelObj.label : null);
        });

        // 隐藏所有待定点标记及其标签
        this.pendingMarkers.forEach(markerObj => {
            this.setMarkerVisible(markerObj.marker, false, markerObj.label);
        });

        // 根据过滤条件显示标记
        let visiblePlaces = [];

        if (this.currentCityFilter === 'all') {
            // 显示所有游玩点标记
            this.markers.forEach(markerObj => {
                const labelObj = this.placeLabels.find(l => l.id.toString() === markerObj.id.toString());
                this.setMarkerVisible(markerObj.marker, true, labelObj ? labelObj.label : null);
            });
            // 显示所有待定点标记（如果当前显示待定点）
            if (this.showPendingPlaces) {
                this.pendingMarkers.forEach(markerObj => {
                    this.setMarkerVisible(markerObj.marker, true, markerObj.label);
                });
            }
            visiblePlaces = this.getUsablePlaces();
        } else {
            // 只显示指定城市的游玩点标记
            this.markers.forEach(markerObj => {
                const city = this.extractCityFromAddress(markerObj.place.address);
                if (city === this.currentCityFilter) {
                    const labelObj = this.placeLabels.find(l => l.id.toString() === markerObj.id.toString());
                    this.setMarkerVisible(markerObj.marker, true, labelObj ? labelObj.label : null);
                    visiblePlaces.push(markerObj.place);
                }
            });
            // 只显示指定城市的待定点标记（如果当前显示待定点）
            if (this.showPendingPlaces) {
                this.pendingMarkers.forEach(markerObj => {
                    const city = this.extractCityFromAddress(markerObj.place.address);
                    if (city === this.currentCityFilter) {
                        this.setMarkerVisible(markerObj.marker, true, markerObj.label);
                        if (!visiblePlaces.find(p => p.id === markerObj.place.id)) {
                            visiblePlaces.push(markerObj.place);
                        }
                    }
                });
            }
        }

        // 调整地图视野以适应可见的地点
        if (visiblePlaces.length > 0) {
            this.fitMapToPlaces(visiblePlaces);
        }

        console.log(`城市过滤已应用: ${this.currentCityFilter}, 显示 ${visiblePlaces.length} 个地点`);
    }

    // 应用城市过滤但不调整地图视角（用于显示待定点时）
    applyCityFilterWithoutFitting() {
        if (!this.isMapLoaded) return;

        // 隐藏所有标记（游玩点及其标签）
        this.markers.forEach(markerObj => {
            const labelObj = this.placeLabels.find(l => l.id.toString() === markerObj.id.toString());
            this.setMarkerVisible(markerObj.marker, false, labelObj ? labelObj.label : null);
        });

        // 隐藏所有待定点标记及其标签
        this.pendingMarkers.forEach(markerObj => {
            this.setMarkerVisible(markerObj.marker, false, markerObj.label);
        });

        // 根据过滤条件显示标记
        let visiblePlaces = [];

        if (this.currentCityFilter === 'all') {
            // 显示所有游玩点标记
            this.markers.forEach(markerObj => {
                const labelObj = this.placeLabels.find(l => l.id.toString() === markerObj.id.toString());
                this.setMarkerVisible(markerObj.marker, true, labelObj ? labelObj.label : null);
            });
            // 显示所有待定点标记（如果当前显示待定点）
            if (this.showPendingPlaces) {
                this.pendingMarkers.forEach(markerObj => {
                    this.setMarkerVisible(markerObj.marker, true, markerObj.label);
                });
            }
            visiblePlaces = this.getUsablePlaces();
        } else {
            // 只显示指定城市的游玩点标记
            this.markers.forEach(markerObj => {
                const city = this.extractCityFromAddress(markerObj.place.address);
                if (city === this.currentCityFilter) {
                    const labelObj = this.placeLabels.find(l => l.id.toString() === markerObj.id.toString());
                    this.setMarkerVisible(markerObj.marker, true, labelObj ? labelObj.label : null);
                    visiblePlaces.push(markerObj.place);
                }
            });
            // 只显示指定城市的待定点标记（如果当前显示待定点）
            if (this.showPendingPlaces) {
                this.pendingMarkers.forEach(markerObj => {
                    const city = this.extractCityFromAddress(markerObj.place.address);
                    if (city === this.currentCityFilter) {
                        this.setMarkerVisible(markerObj.marker, true, markerObj.label);
                        if (!visiblePlaces.find(p => p.id === markerObj.place.id)) {
                            visiblePlaces.push(markerObj.place);
                        }
                    }
                });
            }
        }

        // 注意：这里不调用 fitMapToPlaces，保持当前地图视角
        console.log(`城市过滤已应用（不调整视角）: ${this.currentCityFilter}, 显示 ${visiblePlaces.length} 个地点`);
    }

    // 更新城市过滤按钮状态
    updateCityFilterButton() {
        if (!this.cityFilterBtn) {
            console.log('城市过滤按钮未创建');
            return;
        }

        const cities = this.getAllCities();

        if (cities.length <= 1) {
            // 如果只有一个城市或没有城市，仍然显示按钮但禁用
            this.cityFilterBtn.style.display = 'block';
            this.cityFilterBtn.disabled = true;
            this.cityFilterBtn.textContent = `🏙️ ${cities.length === 0 ? '无城市' : cities[0]}`;
            this.cityFilterBtn.title = cities.length === 0 ? '暂无游玩地点' : '只有一个城市，无需过滤';
            console.log('按钮显示但禁用：', cities.length === 0 ? '无城市' : '只有一个城市');
        } else {
            // 如果有多个城市，显示并启用按钮
            this.cityFilterBtn.style.display = 'block';
            this.cityFilterBtn.disabled = false;
            this.cityFilterBtn.title = '切换城市显示';
            console.log('按钮显示并启用，城市数量:', cities.length);

            // 检查当前过滤的城市是否还存在
            if (this.currentCityFilter !== 'all' && !cities.includes(this.currentCityFilter)) {
                // 如果当前过滤的城市不存在了，重置为全部城市
                this.currentCityFilter = 'all';
                this.cityFilterBtn.textContent = '🏙️ 全部城市';
                this.applyyCityFilter();
            }
        }
    }

    // 重新创建所有标记
    recreateMarkers() {
        this.syncMarkersIncremental();
    }

    activeMarkerSignature(place, index) {
        return JSON.stringify([
            this.settings.selectedMapApi,
            String(place.id),
            Number(place.lat),
            Number(place.lng),
            place.customName || place.name,
            index,
            this.showPlaceNames
        ]);
    }

    syncMarkersIncremental() {
        if (!this.isMapLoaded) return;
        const activePlaces = this.getUsablePlaces();
        const expected = new Map(activePlaces.map((place, index) => [String(place.id), {
            place,
            signature: this.activeMarkerSignature(place, index)
        }]));

        Array.from(this.markers).forEach(markerData => {
            const next = expected.get(String(markerData.id));
            if (!next || markerData.renderSignature !== next.signature) {
                const isUpdate = Boolean(next);
                this.removeMarker(String(markerData.id));
                if (this.performanceMetrics) {
                    if (isUpdate) this.performanceMetrics.markerUpdates += 1;
                    else this.performanceMetrics.markerDeletes += 1;
                }
            }
        });

        activePlaces.forEach((place, index) => {
            if (this.markers.some(markerData => String(markerData.id) === String(place.id))) return;
            this.addMarker(place);
            const added = this.markers.find(markerData => String(markerData.id) === String(place.id));
            if (added) added.renderSignature = this.activeMarkerSignature(place, index);
            if (this.performanceMetrics) this.performanceMetrics.markerCreates += 1;
        });

        this.syncPendingMarkersIncremental();
        this.applyCityFilterWithoutFitting();
        this.adjustLabels();
    }

    // 调整地图视野以适应指定的地点
    fitMapToPlaces(places) {
        places = this.getUsablePlaces(places);
        if (!this.isMapLoaded || places.length === 0) return;

        const selectedMapApi = this.settings.selectedMapApi;
        console.log(`📐 调整地图视野：${places.length}个地点，使用${selectedMapApi}`);

        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
            this.fitMapToPlacesGoogle(places);
        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
            this.fitMapToPlacesGaode(places);
        } else if (selectedMapApi === 'tianditu' && typeof T !== 'undefined' && T.Map) {
            this.fitMapToPlacesTianditu(places);
        } else {
            console.warn('⚠️ 无法调整地图视野：未知的地图API');
        }
    }

    // Google Maps 调整视野
    fitMapToPlacesGoogle(places) {
        if (places.length === 1) {
            // 如果只有一个地点，中心到该地点，使用合适的缩放级别
            this.map.setCenter({ lat: places[0].lat, lng: places[0].lng });
            this.map.setZoom(14);
        } else {
            // 如果有多个地点，调整边界以包含所有地点
            const bounds = new google.maps.LatLngBounds();
            places.forEach(place => {
                bounds.extend({ lat: place.lat, lng: place.lng });
            });

            const extendedBounds = this.extendBounds(bounds, 0.1);
            this.map.fitBounds(extendedBounds);

            // 确保缩放级别不会太高
            google.maps.event.addListenerOnce(this.map, 'bounds_changed', () => {
                if (this.map.getZoom() > 16) {
                    this.map.setZoom(16);
                }
            });
        }
    }

    // 高德地图调整视野
    fitMapToPlacesGaode(places) {
        if (places.length === 1) {
            // 如果只有一个地点，中心到该地点
            this.map.setCenter([places[0].lng, places[0].lat]);
            this.map.setZoom(14);
            console.log(`📍 高德地图居中到单个地点: ${places[0].name}`);
        } else {
            // 计算边界
            let minLat = places[0].lat;
            let maxLat = places[0].lat;
            let minLng = places[0].lng;
            let maxLng = places[0].lng;

            places.forEach(place => {
                minLat = Math.min(minLat, place.lat);
                maxLat = Math.max(maxLat, place.lat);
                minLng = Math.min(minLng, place.lng);
                maxLng = Math.max(maxLng, place.lng);
            });

            // 添加边距（扩展10%）
            const latMargin = (maxLat - minLat) * 0.1;
            const lngMargin = (maxLng - minLng) * 0.1;

            minLat -= latMargin;
            maxLat += latMargin;
            minLng -= lngMargin;
            maxLng += lngMargin;

            // 设置地图边界
            const bounds = new AMap.Bounds([minLng, minLat], [maxLng, maxLat]);
            this.map.setBounds(bounds);

            console.log(`📐 高德地图边界已调整: ${places.length}个地点`);
        }
    }

    // 天地图调整视野
    fitMapToPlacesTianditu(places) {
        if (places.length === 1) {
            this.map.centerAndZoom(new T.LngLat(places[0].lng, places[0].lat), 14);
            console.log(`📍 天地图居中到单个地点: ${places[0].name}`);
            return;
        }

        const points = places.map(place => new T.LngLat(place.lng, place.lat));
        if (typeof this.map.setViewport === 'function') {
            this.map.setViewport(points);
            console.log(`📐 天地图视野已调整: ${places.length}个地点`);
            return;
        }

        let minLat = places[0].lat;
        let maxLat = places[0].lat;
        let minLng = places[0].lng;
        let maxLng = places[0].lng;

        places.forEach(place => {
            minLat = Math.min(minLat, place.lat);
            maxLat = Math.max(maxLat, place.lat);
            minLng = Math.min(minLng, place.lng);
            maxLng = Math.max(maxLng, place.lng);
        });

        const center = new T.LngLat((minLng + maxLng) / 2, (minLat + maxLat) / 2);
        const span = Math.max(maxLat - minLat, maxLng - minLng);
        let zoom = 12;

        if (span > 30) {
            zoom = 4;
        } else if (span > 15) {
            zoom = 5;
        } else if (span > 8) {
            zoom = 6;
        } else if (span > 3) {
            zoom = 8;
        } else if (span > 1) {
            zoom = 10;
        }

        this.map.centerAndZoom(center, zoom);
        console.log(`📐 天地图视野已通过中心点回退调整: ${places.length}个地点`);
    }

    // 清空所有地点
    clearAllPlaces() {
        if (this.travelList.length === 0) return;

        if (confirm('确定要清空所有游玩地点和待定地点吗？')) {
            this.dispatch({
                type: 'REPLACE_PLAN',
                travelList: [],
                routeSegments: [],
                currentSchemeId: null,
                currentSchemeName: null,
                hasUnsavedChanges: false,
                markModified: false
            });
            this.updatePageTitle();
            this.loadSavedSchemes(); // 刷新方案列表显示
        }
    }

    // 打开路线校对台。此步骤只收集纯数据配置，不改变当前行程。
    optimizeRoute() {
        const places = this.getUsablePlaces();
        if (places.length < 3) {
            alert('至少需要3个非空白的激活状态地点才能优化路线');
            return;
        }
        this.pendingOptimization = null;
        this.populateOptimizationControls(places);
        this.showOptimizationSetup();
        document.getElementById('optimizationMethodBadge').textContent = '建议路线';
        document.getElementById('optimizationStatus').textContent = '';
        this.dialogManager.open('routeOptimizationModal', {
            initialFocus: '#optimizationStart',
            onRequestClose: () => this.closeOptimizationModal()
        });
    }

    populateOptimizationControls(places) {
        const startSelect = document.getElementById('optimizationStart');
        const endSelect = document.getElementById('optimizationEnd');
        const lockedList = document.getElementById('optimizationLockedPlaces');
        startSelect.replaceChildren();
        endSelect.replaceChildren();
        lockedList.replaceChildren();

        const optionalEnd = this.createElement('option', { text: '不固定终点' });
        optionalEnd.value = '';
        endSelect.appendChild(optionalEnd);
        places.forEach((place, index) => {
            const displayName = String(place.customName || place.name || place.id);
            const label = `${index + 1}. ${displayName}`;
            const startOption = this.createElement('option', { text: label });
            startOption.value = String(place.id);
            startSelect.appendChild(startOption);
            const endOption = this.createElement('option', { text: label });
            endOption.value = String(place.id);
            endSelect.appendChild(endOption);

            const lockLabel = this.createElement('label', { className: 'locked-place-option' });
            const checkbox = this.createElement('input', { type: 'checkbox' });
            checkbox.value = String(place.id);
            const lockName = this.createElement('span', { text: label });
            lockLabel.append(checkbox, lockName);
            lockedList.appendChild(lockLabel);
        });
        startSelect.value = String(places[0].id);
        endSelect.value = '';
        document.getElementById('optimizationRoundTrip').checked = false;
        document.getElementById('optimizationTravelMode').value = this.routePlanOptions?.travelMode || 'DRIVING';
        this.updateOptimizationEndpointState();
    }

    updateOptimizationEndpointState() {
        const start = document.getElementById('optimizationStart');
        const end = document.getElementById('optimizationEnd');
        const roundTrip = document.getElementById('optimizationRoundTrip').checked;
        if (roundTrip || end.value === start.value) end.value = '';
        end.disabled = roundTrip;
        Array.from(end.options).forEach(option => {
            option.disabled = option.value !== '' && option.value === start.value;
        });
    }

    showOptimizationSetup() {
        document.getElementById('optimizationSetup').hidden = false;
        document.getElementById('optimizationComparison').hidden = true;
    }

    closeOptimizationModal() {
        this.dialogManager.close('routeOptimizationModal');
        this.pendingOptimization = null;
    }

    optimizationListSignature(places = this.getUsablePlaces()) {
        return JSON.stringify(places.map(place => [String(place.id), place.lat, place.lng]));
    }

    async generateRouteSuggestion() {
        const places = this.getUsablePlaces();
        const status = document.getElementById('optimizationStatus');
        const calculateButton = document.getElementById('calculateSuggestionBtn');
        const signature = this.optimizationListSignature(places);
        const fixedStartId = document.getElementById('optimizationStart').value;
        const fixedEndId = document.getElementById('optimizationEnd').value || null;
        const roundTrip = document.getElementById('optimizationRoundTrip').checked;
        const travelMode = document.getElementById('optimizationTravelMode').value;
        const lockedPlaceIds = Array.from(
            document.querySelectorAll('#optimizationLockedPlaces input[type="checkbox"]:checked')
        ).map(input => input.value);

        calculateButton.disabled = true;
        status.classList.remove('is-error');
        status.textContent = '正在获取交通时间矩阵并计算建议路线…';
        try {
            const matrixData = await this.acquireOptimizationMatrices(places, travelMode);
            if (signature !== this.optimizationListSignature()) {
                throw new Error('地点列表已改变，请重新生成建议路线');
            }
            const input = {
                places: places.map(place => ({
                    id: String(place.id),
                    name: String(place.customName || place.name || place.id),
                    lat: place.lat,
                    lng: place.lng
                })),
                travelTimeMatrix: matrixData.travelTimeMatrix,
                distanceMatrix: matrixData.distanceMatrix,
                matrixSources: matrixData.matrixSources,
                fixedStartId,
                fixedEndId,
                roundTrip,
                lockedPlaceIds,
                travelMode,
                constraints: []
            };
            const result = RouteOptimizer.optimizeRoute(input);
            this.pendingOptimization = { input, result, signature, matrixPlan: matrixData.plan };
            this.renderOptimizationComparison(this.pendingOptimization);
            status.textContent = '';
        } catch (error) {
            status.classList.add('is-error');
            status.textContent = error?.message || '无法生成建议路线';
        } finally {
            calculateButton.disabled = false;
        }
    }

    async acquireOptimizationMatrices(places, travelMode) {
        const fallback = RouteOptimizer.createHaversineMatrices(
            places.map(place => ({ id: String(place.id), name: place.customName || place.name, lat: place.lat, lng: place.lng })),
            travelMode
        );
        const distanceMatrix = fallback.distanceMatrix.map(row => row.slice());
        const travelTimeMatrix = fallback.travelTimeMatrix.map(row => row.slice());
        const matrixSources = fallback.matrixSources.map(row => row.slice());
        const plan = RouteOptimizer.createMatrixAcquisitionPlan(places.length, {
            providerPairLimit: 400,
            chunkSize: 5
        });
        if (plan.strategy !== 'provider-chunked') {
            return { distanceMatrix, travelTimeMatrix, matrixSources, plan };
        }

        const fetchChunk = async chunk => {
            const origins = places.slice(chunk.originStart, chunk.originEnd);
            const destinations = places.slice(chunk.destinationStart, chunk.destinationEnd);
            try {
                const response = await this.bff.routeMatrix({
                    provider: this.settings.selectedMapApi,
                    origins: origins.map(place => ({ lat: place.lat, lng: place.lng })),
                    destinations: destinations.map(place => ({ lat: place.lat, lng: place.lng })),
                    travelMode
                });
                const payload = response?.data || response || {};
                origins.forEach((origin, originOffset) => {
                    destinations.forEach((destination, destinationOffset) => {
                        const element = payload.matrix?.[originOffset]?.[destinationOffset];
                        const distanceMeters = Number(element?.distanceMeters);
                        const durationSeconds = Number(element?.durationSeconds);
                        if (element?.status !== 'OK' || !Number.isFinite(distanceMeters) || distanceMeters < 0 ||
                            !Number.isFinite(durationSeconds) || durationSeconds < 0) return;
                        const row = chunk.originStart + originOffset;
                        const column = chunk.destinationStart + destinationOffset;
                        distanceMatrix[row][column] = distanceMeters;
                        travelTimeMatrix[row][column] = durationSeconds;
                        matrixSources[row][column] = 'provider';
                    });
                });
            } catch (error) {
                // 对应矩阵块保留 Haversine；结果页会明确标记“直线估算”。
            }
        };
        for (let index = 0; index < plan.chunks.length; index += 2) {
            await Promise.all(plan.chunks.slice(index, index + 2).map(fetchChunk));
        }
        return { distanceMatrix, travelTimeMatrix, matrixSources, plan };
    }

    renderOptimizationComparison(pending) {
        const { result, input, matrixPlan } = pending;
        const original = result.original;
        const suggestion = result.suggestion;
        document.getElementById('optimizationSetup').hidden = true;
        document.getElementById('optimizationComparison').hidden = false;
        document.getElementById('originalDistance').textContent = this.formatOptimizationDistance(original.distanceMeters);
        document.getElementById('originalDuration').textContent = this.formatOptimizationDuration(original.durationSeconds);
        document.getElementById('suggestedDistance').textContent = this.formatOptimizationDistance(suggestion.distanceMeters);
        document.getElementById('suggestedDuration').textContent = this.formatOptimizationDuration(suggestion.durationSeconds);
        document.getElementById('optimizationSavings').textContent = this.formatSavingsRatio(result.savings.durationRatio);
        document.getElementById('optimizationSavingsLabel').textContent = result.savings.durationRatio >= 0
            ? '预计节省'
            : '预计变化';
        document.getElementById('optimizationDistanceSavings').textContent = `距离 ${this.formatSavingsRatio(result.savings.distanceRatio)}`;

        const methodBadge = document.getElementById('optimizationMethodBadge');
        methodBadge.textContent = result.globalOptimal ? '建议路线 · 精确验证' : '建议路线 · 快速优化';
        const sourceBadge = document.getElementById('optimizationSourceBadge');
        const comparisonHasEstimate = original.hasStraightLineEstimates || suggestion.hasStraightLineEstimates;
        sourceBadge.classList.toggle('is-estimate', comparisonHasEstimate);
        sourceBadge.textContent = !comparisonHasEstimate
            ? 'Provider 交通矩阵'
            : (original.measurement === 'straight-line-estimate' && suggestion.measurement === 'straight-line-estimate'
                ? '直线估算'
                : 'Provider + 直线估算');
        document.getElementById('optimizationBudgetNote').textContent = matrixPlan.strategy === 'provider-chunked'
            ? `${matrixPlan.chunks.length} 个矩阵分块 · ${result.diagnostics.startsEvaluated} 个确定性起始分支`
            : `${matrixPlan.reason}，已按预算降级`;

        const names = new Map(input.places.map(place => [place.id, place.name]));
        const originalPositions = new Map(result.original.routeIds.map((id, index) => [id, index]));
        const differenceList = document.getElementById('optimizationOrderDiff');
        differenceList.replaceChildren();
        let changedCount = 0;
        result.suggestion.routeIds.forEach((id, index) => {
            const previous = originalPositions.get(id);
            const moved = previous !== index;
            if (moved) changedCount += 1;
            const item = this.createElement('li', {
                className: `order-difference-item${moved ? ' is-moved' : ''}`
            });
            item.append(
                this.createElement('span', { className: 'order-number', text: String(index + 1).padStart(2, '0') }),
                this.createElement('span', { text: names.get(id) || id }),
                this.createElement('span', {
                    className: 'order-move',
                    text: moved ? `原第 ${previous + 1} 站` : '位置不变'
                })
            );
            differenceList.appendChild(item);
        });
        document.getElementById('changedPlaceCount').textContent = `${changedCount} 个地点改变位置`;

        const caveat = comparisonHasEstimate
            ? '部分或全部路段使用直线估算，时间仅用于路线比较；应用后仍会继续尝试获取实际路况。'
            : '建议基于 Provider 返回的交通时间矩阵。交通会变化，应用前请核对顺序。';
        const proof = result.globalOptimal
            ? '小规模路线已通过精确算法交叉验证，界面仍以“建议路线”呈现。'
            : '本次使用多起点最近邻与 2-opt，并受确定性计算预算限制，未穷举所有可能顺序。';
        document.getElementById('optimizationCaveat').textContent = `${caveat}${proof}`;
    }

    formatOptimizationDistance(distanceMeters) {
        return `${(distanceMeters / 1000).toFixed(1)} 公里`;
    }

    formatOptimizationDuration(durationSeconds) {
        const minutes = Math.round(durationSeconds / 60);
        const hours = Math.floor(minutes / 60);
        const remainder = minutes % 60;
        return hours > 0 ? `${hours} 小时 ${remainder} 分钟` : `${remainder} 分钟`;
    }

    formatSavingsRatio(ratio) {
        const percentage = Math.abs(ratio * 100).toFixed(1);
        return ratio >= 0 ? `${percentage}%` : `增加 ${percentage}%`;
    }

    applyRouteSuggestion() {
        const pending = this.pendingOptimization;
        if (!pending) return;
        if (pending.signature !== this.optimizationListSignature()) {
            document.getElementById('optimizationCaveat').textContent = '地点列表已改变，请返回并重新生成建议路线。';
            return;
        }
        this.optimizationSnapshot = {
            travelList: this.travelList.map(place => ({ ...place })),
            routeSegments: new Map(Array.from(this.routeSegments.entries(), ([key, value]) => [key, { ...value }])),
            routePlanOptions: { ...this.routePlanOptions },
            capturedAt: new Date().toISOString()
        };
        const orderedPlaces = pending.result.suggestion.routeIds.map(id => this.getPlaceById(id));
        let optimizedIndex = 0;
        const nextTravelList = this.travelList.map(place => {
            if (!PlannerData.isUsablePlace(place)) return place;
            return orderedPlaces[optimizedIndex++];
        });
        const nextRoutePlanOptions = {
            roundTrip: pending.result.roundTrip,
            travelMode: pending.result.travelMode
        };
        const nextRouteSegments = new Map(this.routeSegments);
        PlannerData.buildValidSegments(orderedPlaces).forEach(([from, to]) => {
            const key = `${from.id}-${to.id}`;
            nextRouteSegments.set(key, {
                ...(nextRouteSegments.get(key) || { mapProvider: 'amap' }),
                travelMode: pending.result.travelMode
            });
        });
        this.dispatch({
            type: 'APPLY_ROUTE_ORDER',
            travelList: nextTravelList,
            routeSegments: Array.from(nextRouteSegments.entries()),
            routePlanOptions: nextRoutePlanOptions
        });
        document.getElementById('undoOptimizeBtn').hidden = false;
        this.closeOptimizationModal();
        this.showToast('已应用建议路线，可随时撤销');
    }

    undoRouteOptimization() {
        if (!this.optimizationSnapshot) return;
        const routeSegments = Array.from(
            this.optimizationSnapshot.routeSegments.entries(),
            ([key, value]) => [key, { ...value }]
        );
        const snapshot = this.optimizationSnapshot;
        this.optimizationSnapshot = null;
        document.getElementById('undoOptimizeBtn').hidden = true;
        this.dispatch({
            type: 'APPLY_ROUTE_ORDER',
            travelList: snapshot.travelList,
            routeSegments,
            routePlanOptions: snapshot.routePlanOptions
        });
        this.showToast('已撤销路线优化，恢复优化前快照');
    }

    // 保存数据到本地存储
    saveData() {
        const record = PlannerData.validateApplicationRecord({
            travelList: this.travelList,
            routeSegments: Array.from(this.routeSegments.entries()),
            settings: this.getSafeSettings(),
            currentSchemeId: this.currentSchemeId,
            currentSchemeName: this.currentSchemeName,
            hasUnsavedChanges: this.hasUnsavedChanges,
            dataSchemaVersion: PlannerData.SCHEMA_VERSION,
            lastSaved: new Date().toISOString()
        });
        PlannerData.atomicWrite(localStorage, {
            travelPlannerData: JSON.stringify(ClientSecurity.sanitizePersistedRecord(record))
        });
    }

    // 加载已保存的数据（设置已在前面单独加载）
    loadSavedData() {
        try {
            const saved = localStorage.getItem('travelPlannerData');
            if (saved) {
                const data = PlannerData.readApplicationRecord(localStorage);
                this.dispatch({
                    type: 'REPLACE_PLAN',
                    travelList: data.travelList,
                    routeSegments: data.routeSegments,
                    currentSchemeId: data.currentSchemeId ?? null,
                    currentSchemeName: data.currentSchemeName ?? null,
                    hasUnsavedChanges: data.hasUnsavedChanges === true,
                    markModified: false,
                    persist: false
                });
                const currentScheme = this.getCurrentScheme(this.getSavedSchemes());
                if (currentScheme &&
                    (String(this.currentSchemeId) !== String(currentScheme.id) ||
                        this.currentSchemeName !== currentScheme.name)) {
                    this.dispatch({
                        type: 'SET_SCHEME_BINDING',
                        currentSchemeId: currentScheme.id,
                        currentSchemeName: currentScheme.name,
                        hasUnsavedChanges: this.hasUnsavedChanges
                    });
                }
                this.updatePageTitle();
                this.updateTogglePendingButton();

                console.log('✅ 已加载保存的旅游数据');
                if (this.currentSchemeName) {
                    console.log(`📌 当前方案: ${this.currentSchemeName}`);
                }
            }
        } catch (error) {
            console.error('加载保存数据失败:', error);
        }
    }

    // 保存新方案
    saveNewScheme() {
        const schemeName = document.getElementById('schemeNameInput').value.trim();
        if (!schemeName) {
            this.showToast('请输入方案名称');
            return;
        }

        const schemes = this.getSavedSchemes();

        // 检查是否重名
        if (schemes.some(scheme => scheme.name === schemeName)) {
            this.showToast('已存在相同名称的方案，请使用不同的名称');
            return;
        }

        const createdAt = new Date().toISOString();
        const newScheme = {
            id: this.generateUniqueSchemeId(), // 使用新的唯一ID生成方法
            uuid: this.generateSchemeUUID(schemeName, createdAt), // 基于名称和时间的UUID
            name: schemeName,
            travelList: [...this.travelList],
            routeSegments: Array.from(this.routeSegments.entries()),
            createdAt: createdAt,
            modifiedAt: createdAt, // 创建时修改时间等于创建时间
            placesCount: this.getUsablePlaces().length,
            schemaVersion: PlannerData.SCHEMA_VERSION,
            version: PlannerData.BACKUP_VERSION
        };

        // 移除同名方案（如果存在）
        const filteredSchemes = schemes.filter(scheme => scheme.name !== schemeName);
        filteredSchemes.push(newScheme);

        localStorage.setItem('travelSchemes', JSON.stringify(ClientSecurity.sanitizePersistedRecord(filteredSchemes)));

        this.dispatch({
            type: 'SET_SCHEME_BINDING',
            currentSchemeId: newScheme.id,
            currentSchemeName: schemeName,
            hasUnsavedChanges: false
        });
        this.updatePageTitle();

        this.announceSaveStatus(`方案“${schemeName}”已保存并设为当前方案`);
        this.showToast(`方案"${schemeName}"保存成功并已设为当前方案`);

        document.getElementById('schemeNameInput').value = '';
        this.loadSavedSchemes();
    }

    // 获取已保存的方案
    getSavedSchemes() {
        try {
            const schemes = localStorage.getItem('travelSchemes');
            const parsedSchemes = schemes ? JSON.parse(schemes) : [];
            // 读取只做校验，不做迁移或写回；旧数据迁移仅在构造阶段显式执行一次。
            return PlannerData.validateSchemes(parsedSchemes, 'travelSchemes');
        } catch (error) {
            console.error('获取保存方案失败:', error);
            return [];
        }
    }

    // 加载并显示已保存的方案
    loadSavedSchemes() {
        const schemes = this.getSavedSchemes();
        const container = document.getElementById('savedSchemesList');

        if (schemes.length === 0) {
            container.replaceChildren(this.createElement('div', { className: 'empty-schemes', text: '暂无保存的方案' }));
            return;
        }

        // 按创建时间倒序排列
        schemes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const currentScheme = this.getCurrentScheme(schemes);

        const fragment = document.createDocumentFragment();
        schemes.forEach(scheme => {
            const createdDate = new Date(scheme.createdAt).toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });

            // 方案统计只计算激活、非空白、坐标合法的地点。
            const schemePlaces = Array.isArray(scheme.travelList) ? scheme.travelList : [];
            const activePlaces = this.getUsablePlaces(schemePlaces);
            const activeCount = activePlaces.length;
            const totalCount = activeCount;

            // 格式化修改时间
            const modifiedDate = scheme.modifiedAt ? new Date(scheme.modifiedAt).toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            }) : createdDate;

            const isCurrentScheme = currentScheme === scheme;
            const schemeItemClass = isCurrentScheme ? 'scheme-item current-scheme' : 'scheme-item';
            const loadButtonText = isCurrentScheme ? '当前' : '切换';
            const loadButtonClass = isCurrentScheme ? 'scheme-btn current-scheme-btn' : 'scheme-btn load-scheme-btn';

            // 构建详细信息
            const detailInfo = [];
            if (activeCount > 0) detailInfo.push(`${activeCount}个游玩`);
            if (detailInfo.length === 0) detailInfo.push('无有效地点');

            const schemeItem = this.createElement('div', { className: schemeItemClass });
            const schemeInfo = this.createElement('div', { className: 'scheme-info' });
            const schemeName = this.createElement('div', {
                className: 'scheme-name',
                text: `${isCurrentScheme ? '📌 ' : ''}${String(scheme.name ?? '')}`
            });
            if (isCurrentScheme) {
                schemeName.append(' ', this.createElement('span', { className: 'current-badge', text: '当前方案' }));
            }

            const schemeDate = this.createElement('div', { className: 'scheme-date' });
            const timeInfo = this.createElement('div', { className: 'scheme-time-info' });
            timeInfo.appendChild(this.createElement('span', { className: 'created-time', text: `📅 创建：${createdDate}` }));
            if (scheme.modifiedAt && scheme.modifiedAt !== scheme.createdAt) {
                timeInfo.appendChild(this.createElement('span', { className: 'modified-time', text: `✏️ 修改：${modifiedDate}` }));
            }
            const counts = this.createElement('div', { className: 'scheme-counts' });
            counts.append(
                this.createElement('span', { className: 'places-info', text: `📍 ${detailInfo.join('，')}` }),
                this.createElement('span', { className: 'total-info', text: `（共${totalCount}个地点）` })
            );
            schemeDate.append(timeInfo, counts);
            schemeInfo.append(schemeName, schemeDate);

            const actions = this.createElement('div', { className: 'scheme-actions' });
            actions.append(
                this.createElement('button', {
                    className: loadButtonClass,
                    text: loadButtonText,
                    type: 'button',
                    disabled: isCurrentScheme,
                    dataset: { action: 'load-scheme', id: String(scheme.id) }
                }),
                this.createElement('button', {
                    className: 'scheme-btn delete-scheme-btn',
                    text: '删除',
                    type: 'button',
                    dataset: { action: 'delete-scheme', id: String(scheme.id) }
                })
            );
            schemeItem.append(schemeInfo, actions);
            fragment.appendChild(schemeItem);
        });
        container.replaceChildren(fragment);
    }

    // 加载方案
    loadScheme(schemeId) {
        const schemes = this.getSavedSchemes();
        const scheme = this.getSchemeById(schemes, schemeId);

        if (!scheme) {
            this.showToast('方案不存在');
            return;
        }

        // 检查是否有未保存的更改
        if (this.hasUnsavedChanges && this.travelList.length > 0) {
            this.showUnsavedChangesDialog(scheme.id, scheme.name);
            return;
        }

        // 执行实际的方案加载
        this.performSchemeLoad(scheme.id, scheme);
    }

    // 显示未保存更改对话框
    showUnsavedChangesDialog(targetSchemeId, targetSchemeName) {
        const currentName = this.currentSchemeName || '未命名方案';

        const choice = confirm(
            `⚠️ 当前方案"${currentName}"有未保存的更改。\n\n切换到"${targetSchemeName}"将会丢失这些更改。\n\n是否继续切换？\n\n点击"确定"继续切换（丢失更改）\n点击"取消"留在当前方案`
        );

        if (choice) {
            // 用户选择继续切换，直接切换到目标方案
            this.discardChangesAndSwitch(targetSchemeId, targetSchemeName);
        }
        // 如果用户选择取消，则什么都不做（保持当前方案）
    }



    // 放弃更改并切换
    discardChangesAndSwitch(targetSchemeId, targetSchemeName) {
        // 直接切换到目标方案
        const schemes = this.getSavedSchemes();
        const scheme = schemes.find(s => s.id === targetSchemeId);
        if (scheme) {
            this.performSchemeLoad(targetSchemeId, scheme);
            this.showToast(`已切换到方案"${targetSchemeName}"`);
        }
    }

    // 执行实际的方案加载
    performSchemeLoad(schemeId, scheme) {
        this.dispatch({
            type: 'REPLACE_PLAN',
            travelList: scheme.travelList,
            routeSegments: scheme.routeSegments,
            currentSchemeId: schemeId,
            currentSchemeName: scheme.name,
            hasUnsavedChanges: false,
            markModified: false
        });
        this.updatePageTitle();

        // 更新待定点按钮状态（不重置状态）
        this.updateTogglePendingButton();

        // 强制更新地图到新方案区域
        this.updateMapToCurrentScheme();

        this.showToast(`已切换到方案"${scheme.name}"`);
        this.closeSaveSchemeModal();

        // 更新方案列表显示当前方案
        setTimeout(() => this.loadSavedSchemes(), 100);
    }

    // 删除方案
    deleteScheme(schemeId) {
        const schemes = this.getSavedSchemes();
        const scheme = this.getSchemeById(schemes, schemeId);

        if (!scheme) {
            this.showToast('方案不存在');
            return;
        }

        if (!confirm(`确定删除方案"${scheme.name}"吗？此操作不可恢复。`)) {
            return;
        }

        // 如果删除的是当前方案，清空当前方案标识
        if (String(this.currentSchemeId) === String(scheme.id)) {
            this.dispatch({
                type: 'SET_SCHEME_BINDING',
                currentSchemeId: null,
                currentSchemeName: null,
                hasUnsavedChanges: this.travelList.length > 0
            });
            this.updatePageTitle();
        }

        const filteredSchemes = schemes.filter(s => String(s.id) !== String(scheme.id));
        localStorage.setItem('travelSchemes', JSON.stringify(ClientSecurity.sanitizePersistedRecord(filteredSchemes)));

        this.showToast(`方案"${scheme.name}"已删除`);
        this.loadSavedSchemes();
    }



    // 导出分享版本
    async exportShareVersion() {
        this.closeExportModal();

        // 显示当前导出状态的提示
        const currentFilter = this.currentCityFilter;
        let statusMsg = '正在生成地图图片，包含所有游玩点...';

        if (currentFilter && currentFilter !== 'all') {
            // 检查过滤后是否有游玩点
            const filteredPlaces = this.getUsablePlaces().filter(place => {
                const cityName = this.extractCityFromAddress(place.address);
                return cityName === currentFilter;
            });

            if (filteredPlaces.length > 0) {
                statusMsg = `正在生成"${currentFilter}"地区的地图图片（${filteredPlaces.length}个游玩点）...`;
            } else {
                statusMsg = `"${currentFilter}"地区无游玩点，将生成包含所有游玩点的地图图片...`;
            }
        }

        this.showToast(statusMsg);

        let mapScreenshot = null;
        let attempts = 0;
        const maxAttempts = 1; // 由于新的截图方法内部已有多重保护，减少外部重试

        // 尝试截图
        while (attempts < maxAttempts && !mapScreenshot) {
            attempts++;
            try {
                console.log(`开始第 ${attempts} 次地图截图尝试...`);
                this.showToast('🎯 智能地图生成中（三重保护机制）...');

                mapScreenshot = await this.captureMapScreenshot();

                if (mapScreenshot && mapScreenshot.length > 100) { // 检查base64数据是否有效
                    console.log('地图图片生成成功！数据长度:', mapScreenshot.length);

                    // 检查是否为文本占位符
                    if (mapScreenshot.includes('data:image/png')) {
                        this.showToast('✅ 地图图片生成成功，正在打包导出...');
                    }
                    break;
                } else {
                    console.warn('地图图片数据无效...');
                    mapScreenshot = null;
                }
            } catch (error) {
                console.error(`第 ${attempts} 次截图失败:`, error);
                this.showToast('⚠️ 地图截图遇到问题，使用备选方案...');
            }
        }

        try {
            const html = this.generateShareHTML(mapScreenshot);
            const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
            const url = URL.createObjectURL(blob);

            // 生成更具描述性的文件名
            const cityPrefix = currentFilter && currentFilter !== 'all' ? `${currentFilter}_` : '';
            const fileName = `旅游计划_${cityPrefix}${new Date().toLocaleDateString('zh-CN')}.html`;

            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            if (mapScreenshot) {
                // 检查是否包含"文本版路线图"来判断使用的是哪种方案
                if (mapScreenshot.includes('失败')) {
                    this.showToast('📋 导出成功！地图截图失败已使用文本版路线图，行程信息完整');
                } else {
                    this.showToast('🎉 导出成功！包含高质量地图图片和完整行程信息');
                }
                console.log('导出成功，包含地图图片');
            } else {
                this.showToast('📄 导出成功！已使用地图占位符，行程信息完整');
                console.log('导出成功，使用占位符');
            }
        } catch (error) {
            console.error('导出HTML失败:', error);
            this.showToast('❌ 导出失败，请检查浏览器设置或重试');
        }
    }

    // 导出备份版本
    exportBackupVersion() {
        this.closeExportModal();

        try {
            const allSchemes = ClientSecurity.sanitizePersistedRecord(this.getSavedSchemes());
            const backupData = PlannerData.createBackup({
                exportDate: new Date().toISOString(),
                currentData: {
                    travelList: this.travelList,
                    routeSegments: Array.from(this.routeSegments.entries()),
                    settings: this.getSafeSettings(),
                    currentSchemeId: this.currentSchemeId,
                    currentSchemeName: this.currentSchemeName,
                    hasUnsavedChanges: this.hasUnsavedChanges
                },
                schemes: allSchemes
            });

            const sanitizedBackup = ClientSecurity.sanitizePersistedRecord(backupData);
            if (ClientSecurity.containsSensitiveField(sanitizedBackup)) {
                throw new Error('备份安全检查失败');
            }
            const blob = new Blob([JSON.stringify(sanitizedBackup, null, 2)], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            const dateStr = new Date().toLocaleDateString('zh-CN').replace(/\//g, '');
            a.download = `17旅游方案全备份_${dateStr}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            this.showToast(`备份导出成功，包含 ${allSchemes.length} 个方案`);
        } catch (error) {
            console.error('备份导出失败:', error);
            this.showToast(`备份导出失败：${error.message}`);
        }
    }

    // 处理文件拖拽悬停
    handleFileDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        document.getElementById('fileDropZone').classList.add('dragover');
    }

    // 处理文件拖拽离开
    handleFileDragLeave(e) {
        e.preventDefault();
        if (!e.relatedTarget || !document.getElementById('fileDropZone').contains(e.relatedTarget)) {
            document.getElementById('fileDropZone').classList.remove('dragover');
        }
    }

    // 处理文件拖拽放下
    handleFileDrop(e) {
        e.preventDefault();
        document.getElementById('fileDropZone').classList.remove('dragover');

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            this.processImportFile(files[0]);
        }
    }

    // 处理文件选择
    handleFileSelect(e) {
        const file = e.target.files[0];
        if (file) {
            this.processImportFile(file);
        }
    }

    // 处理导入文件
    processImportFile(file) {
        if (!file.name.toLowerCase().endsWith('.json')) {
            this.showToast('请选择JSON格式的备份文件');
            return;
        }
        if (file.size > PlannerData.LIMITS.maxFileBytes) {
            this.showToast(`备份文件过大，最大支持${PlannerData.LIMITS.maxFileBytes / 1024 / 1024}MB`);
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const importData = JSON.parse(e.target.result);
                this.validateAndImportData(importData);
            } catch (error) {
                console.error('文件解析失败:', error);
                this.showToast('文件格式错误，请选择有效的备份文件');
            }
        };

        reader.onerror = () => {
            this.showToast('文件读取失败，请重试');
        };

        reader.readAsText(file);
    }

    // 验证并导入数据
    validateAndImportData(data) {
        // 验证数据格式
        if (!data || typeof data !== 'object') {
            this.showToast('数据格式无效');
            return;
        }

        // 检查数据版本和类型
        if (['2.0', '3.0', PlannerData.BACKUP_VERSION].includes(data.version) && data.type === 'full-backup') {
            // 新格式：包含多个方案的完整备份
            this.validateAndImportFullBackup(data);
        } else if (data.travelList && Array.isArray(data.travelList)) {
            // 旧格式：单个方案的备份
            this.validateAndImportSingleScheme(data);
        } else {
            this.showToast('备份文件格式无效或不支持');
            return;
        }
    }

    // 验证并导入完整备份（新格式）
    validateAndImportFullBackup(data) {
        try {
            // 旧版本只在这里通过显式 migration 转换；校验函数本身从不改写输入。
            const validated = data.version === PlannerData.BACKUP_VERSION &&
                data.schemaVersion === PlannerData.SCHEMA_VERSION
                ? PlannerData.validateBackup(data)
                : PlannerData.migrateBackup(data);
            this.checkSchemeConflicts(validated);
        } catch (error) {
            this.showToast(`备份校验失败：${error.message}`);
        }
    }

    // 验证并导入单个方案（旧格式）
    validateAndImportSingleScheme(data) {
        let validated;
        try {
            validated = PlannerData.validatePlanData(data, 'travelData');
        } catch (error) {
            this.showToast(`备份校验失败：${error.message}`);
            return;
        }

        // 确认导入
        const confirmMessage = `即将导入 ${validated.travelList.length} 个游玩地点，这将替换当前所有数据。是否继续？`;
        if (!confirm(confirmMessage)) {
            return;
        }

        // 执行导入
        this.importTravelData({ ...validated, exportDate: data.exportDate });
    }

    // 检查方案冲突
    checkSchemeConflicts(importData) {
        const existingSchemes = this.getSavedSchemes();
        const conflicts = [];

        // 检查每个要导入的方案是否与现有方案冲突
        for (let importScheme of importData.schemes) {
            // 确保导入方案有UUID（如果没有则生成）
            if (!importScheme.uuid) {
                const createdAt = importScheme.createdAt || new Date().toISOString();
                importScheme.uuid = this.generateSchemeUUID(importScheme.name, createdAt);
            }

            // 检查UUID冲突（同一个方案）
            const uuidConflict = existingSchemes.find(existing =>
                existing.uuid === importScheme.uuid
            );

            // 检查名称冲突（不同方案但同名）
            const nameConflict = existingSchemes.find(existing =>
                existing.name === importScheme.name && existing.uuid !== importScheme.uuid
            );

            if (uuidConflict) {
                // 同一个方案，检查修改时间
                const existingModified = new Date(uuidConflict.modifiedAt || uuidConflict.createdAt);
                const importModified = new Date(importScheme.modifiedAt || importScheme.createdAt);

                if (importModified > existingModified) {
                    // 导入的版本更新，标记为版本冲突
                    conflicts.push({
                        importScheme: importScheme,
                        conflictType: 'version',
                        existingScheme: uuidConflict,
                        isNewer: true
                    });
                } else if (importModified.getTime() === existingModified.getTime()) {
                    // 完全相同的版本，显示冲突并推荐跳过
                    conflicts.push({
                        importScheme: importScheme,
                        conflictType: 'version',
                        existingScheme: uuidConflict,
                        isNewer: false,
                        isIdentical: true
                    });
                } else {
                    // 导入的版本较旧
                    conflicts.push({
                        importScheme: importScheme,
                        conflictType: 'version',
                        existingScheme: uuidConflict,
                        isNewer: false
                    });
                }
            } else if (nameConflict) {
                // 不同方案但同名
                conflicts.push({
                    importScheme: importScheme,
                    conflictType: 'name',
                    existingScheme: nameConflict
                });
            }
        }

        if (conflicts.length > 0) {
            // 有冲突，显示冲突解决界面
            this.showConflictResolutionModal(importData, conflicts);
        } else {
            // 没有冲突，直接导入
            this.importFullBackup(importData);
        }
    }

    // 显示冲突解决模态框
    showConflictResolutionModal(importData, conflicts) {
        this.pendingImportData = importData;
        this.conflictResolutions.clear();

        // 创建冲突解决界面
        this.createConflictResolutionUI(conflicts);

        this.dialogManager.open('conflictResolutionModal', {
            initialFocus: 'input[type="radio"]:checked',
            onRequestClose: () => this.closeConflictResolutionModal()
        });
    }

    // 创建冲突解决界面
    createConflictResolutionUI(conflicts) {
        const container = document.getElementById('conflictList');
        this.pendingConflicts = Array.isArray(conflicts) ? conflicts : [];
        const fragment = document.createDocumentFragment();

        const createSchemeSummary = (heading, scheme, className) => {
            const summary = this.createElement('div', { className: `scheme-info ${className}` });
            summary.appendChild(this.createElement('h5', { text: heading }));
            this.appendLabeledText(summary, '名称:', String(scheme.name ?? ''));
            this.appendLabeledText(summary, '地点数:', String(scheme.placesCount ?? 0));
            this.appendLabeledText(summary, '创建时间:', new Date(scheme.createdAt).toLocaleString('zh-CN'));
            if (scheme.modifiedAt) {
                this.appendLabeledText(summary, '修改时间:', new Date(scheme.modifiedAt).toLocaleString('zh-CN'));
            }
            return summary;
        };

        const createOption = (index, value, labelText, checked = false) => {
            const label = this.createElement('label');
            const radio = this.createElement('input', {
                type: 'radio',
                dataset: { conflictIndex: index }
            });
            radio.name = `resolution_${index}`;
            radio.value = value;
            radio.checked = checked;
            label.append(radio, this.createElement('span', { text: labelText }));
            return label;
        };

        this.pendingConflicts.forEach((conflict, index) => {
            const importScheme = conflict.importScheme;
            const existingScheme = conflict.existingScheme;

            const item = this.createElement('div', {
                className: 'conflict-item',
                dataset: { conflictIndex: index }
            });
            const header = this.createElement('div', { className: 'conflict-header' });
            header.appendChild(this.createElement('h4', {
                text: `冲突 ${index + 1}: "${String(importScheme.name ?? '')}"`
            }));
            const conflictClass = conflict.conflictType === 'version'
                ? (conflict.isIdentical ? 'version-identical' : (conflict.isNewer ? 'version-newer' : 'version-older'))
                : 'name-conflict';
            const conflictText = conflict.conflictType === 'version'
                ? (conflict.isIdentical ? '🔄 完全相同' : (conflict.isNewer ? '⬆️ 版本更新' : '⬇️ 版本较旧'))
                : '📝 同名方案';
            header.appendChild(this.createElement('div', {
                className: `conflict-type ${conflictClass}`,
                text: conflictText
            }));

            const details = this.createElement('div', { className: 'conflict-details' });
            const comparison = this.createElement('div', { className: 'scheme-comparison' });
            comparison.append(
                createSchemeSummary('现有方案', existingScheme, 'existing'),
                createSchemeSummary('要导入的方案', importScheme, 'importing')
            );
            details.appendChild(comparison);

            const resolution = this.createElement('div', { className: 'conflict-resolution' });
            const resolutionTitle = this.createElement('h5', {
                id: `resolutionTitle_${index}`,
                text: '选择处理方式:'
            });
            resolution.appendChild(resolutionTitle);
            const options = this.createElement('div', { className: 'resolution-options' });
            options.setAttribute('role', 'radiogroup');
            options.setAttribute('aria-labelledby', resolutionTitle.id);
            if (conflict.conflictType === 'version' && conflict.isIdentical) {
                options.append(
                    createOption(index, 'skip', '跳过此方案（推荐）', true),
                    createOption(index, 'both', '保留副本')
                );
            } else if (conflict.conflictType === 'version') {
                options.append(
                    createOption(index, 'update', conflict.isNewer ? '更新到新版本（推荐）' : '更新到此版本', conflict.isNewer),
                    createOption(index, 'keep', '保留现有版本', !conflict.isNewer),
                    createOption(index, 'both', '同时保留两个版本')
                );
            } else {
                options.append(
                    createOption(index, 'overwrite', '覆盖现有方案'),
                    createOption(index, 'rename', '重命名导入（推荐）', true),
                    createOption(index, 'skip', '跳过此方案')
                );
            }

            const rename = this.createElement('div', { className: 'rename-input', id: `renameInput_${index}` });
            rename.style.display = conflict.conflictType === 'version' ? 'none' : 'block';
            const renameHeader = this.createElement('div', { className: 'rename-header' });
            const renameLabelId = `renameLabel_${index}`;
            renameHeader.append(
                this.createElement('div', {
                    className: 'rename-label',
                    id: renameLabelId,
                    text: '冲突方案重命名为：'
                }),
                this.createElement('div', {
                    className: 'rename-warning',
                    id: `renameWarning_${index}`,
                    text: '⚠️ 名称已存在'
                })
            );
            renameHeader.lastElementChild.style.display = 'none';
            const newName = this.createElement('input', {
                id: `newName_${index}`,
                type: 'text',
                attributes: { 'aria-labelledby': renameLabelId }
            });
            newName.placeholder = '输入新名称...';
            newName.value = `${String(importScheme.name ?? '')} (导入)`;
            newName.maxLength = 100;
            rename.append(renameHeader, newName);
            resolution.append(options, rename);
            item.append(header, details, resolution);
            fragment.appendChild(item);

            if (rename.style.display !== 'none') {
                this.addRenameInputListener(newName, index);
            }
        });

        container.replaceChildren(fragment);
    }

    // 导入旅游数据（旧格式）
    importTravelData(data) {
        try {
            const nextCurrentData = {
                travelList: data.travelList,
                routeSegments: data.routeSegments,
                settings: this.getSafeSettings(),
                currentSchemeId: null,
                currentSchemeName: null,
                hasUnsavedChanges: data.travelList.length > 0
            };
            // 先把数据、方案绑定和 dirty 状态作为一个事务持久化；成功后才更新内存与 UI。
            const committed = PlannerData.commitImportTransaction(localStorage, {
                schemes: this.getSavedSchemes(),
                currentData: nextCurrentData
            });

            this.dispatch({
                type: 'REPLACE_PLAN',
                travelList: committed.currentData.travelList,
                routeSegments: committed.currentData.routeSegments,
                currentSchemeId: committed.currentData.currentSchemeId,
                currentSchemeName: committed.currentData.currentSchemeName,
                hasUnsavedChanges: committed.currentData.hasUnsavedChanges,
                markModified: false,
                persist: false
            });

            // 更新待定点按钮状态（不重置状态）
            this.updateTogglePendingButton();

            this.updatePageTitle();

            // 显示成功消息
            const importedUsableCount = this.getUsablePlaces(data.travelList).length;
            this.showToast(`成功导入 ${importedUsableCount} 个有效游玩地点`);
            this.closeImportModal();

            // 重新加载方案列表
            this.loadSavedSchemes();

            console.log('数据导入成功:', {
                places: importedUsableCount,
                cities: data.cities?.length || this.getAllCities().length,
                exportDate: data.exportDate
            });

        } catch (error) {
            console.error('数据导入失败:', error);
            this.showToast(`导入失败：${error.message}`);
        }
    }

    // 导入完整备份（新格式）
    importFullBackup(importData) {
        try {
            const existingSchemes = this.getSavedSchemes();
            const importedSchemes = [];
            const skippedSchemes = [];
            const importedIdMap = new Map();

            // 处理每个方案
            for (const sourceScheme of importData.schemes) {
                const originalId = String(sourceScheme.id);
                const importScheme = PlannerData.validateScheme(sourceScheme);
                // 检查是否有冲突解决方案（只在有冲突时才存在）
                const resolution = this.conflictResolutions.get(importScheme.uuid || importScheme.name);
                const existingIndex = existingSchemes.findIndex(existing =>
                    (importScheme.uuid && existing.uuid === importScheme.uuid) || existing.name === importScheme.name
                );

                if (resolution === 'skip' || resolution === 'keep') {
                    if (resolution === 'skip') {
                        skippedSchemes.push(importScheme.name);
                    }
                    if (existingIndex !== -1) importedIdMap.set(originalId, existingSchemes[existingIndex].id);
                    continue;
                }

                // 确保方案有UUID
                if (!importScheme.uuid) {
                    const createdAt = importScheme.createdAt || new Date().toISOString();
                    importScheme.uuid = this.generateSchemeUUID(importScheme.name, createdAt);
                }

                // 处理重命名或同时保留两个版本
                if (resolution && (resolution.startsWith('rename:') || resolution.startsWith('both:'))) {
                    const newName = resolution.substring(resolution.indexOf(':') + 1);
                    importScheme.name = newName;
                    // 重新生成UUID以避免冲突
                    const createdAt = importScheme.createdAt || new Date().toISOString();
                    importScheme.uuid = this.generateSchemeUUID(newName, createdAt);
                    // 生成新的ID以避免冲突
                    importScheme.id = this.generateUniqueSchemeId();
                }

                // 处理覆盖或更新
                if (resolution === 'overwrite' || resolution === 'update') {
                    if (existingIndex !== -1) {
                        importScheme.id = existingSchemes[existingIndex].id;
                        existingSchemes.splice(existingIndex, 1);
                    } else {
                        importScheme.id = this.generateUniqueSchemeId();
                    }
                } else if (!(resolution && (resolution.startsWith('rename:') || resolution.startsWith('both:')))) {
                    // 对于其他情况（直接导入），也生成新的ID以避免冲突
                    importScheme.id = this.generateUniqueSchemeId();
                }

                importScheme.placesCount = this.getUsablePlaces(importScheme.travelList).length;
                importScheme.version = PlannerData.BACKUP_VERSION;
                importedSchemes.push(importScheme);
                importedIdMap.set(originalId, importScheme.id);
            }

            const allSchemes = [...existingSchemes, ...importedSchemes];
            const sourceCurrentId = importData.currentData.currentSchemeId;
            const mappedCurrentId = sourceCurrentId == null
                ? null
                : importedIdMap.get(String(sourceCurrentId));
            const currentScheme = mappedCurrentId == null
                ? null
                : allSchemes.find(scheme => String(scheme.id) === String(mappedCurrentId));
            const nextCurrentData = {
                travelList: importData.currentData.travelList,
                routeSegments: importData.currentData.routeSegments,
                settings: this.getSafeSettings(),
                currentSchemeId: currentScheme ? currentScheme.id : null,
                currentSchemeName: currentScheme ? currentScheme.name : null,
                hasUnsavedChanges: currentScheme
                    ? importData.currentData.hasUnsavedChanges === true
                    : importData.currentData.travelList.length > 0
            };

            // 两个 localStorage 键先原子提交；配额或权限错误会恢复原值，内存尚未改变。
            const committed = PlannerData.commitImportTransaction(localStorage, {
                schemes: allSchemes,
                currentData: nextCurrentData
            });

            this.dispatch({
                type: 'REPLACE_PLAN',
                travelList: committed.currentData.travelList,
                routeSegments: committed.currentData.routeSegments,
                currentSchemeId: committed.currentData.currentSchemeId,
                currentSchemeName: committed.currentData.currentSchemeName,
                hasUnsavedChanges: committed.currentData.hasUnsavedChanges,
                markModified: false,
                persist: false
            });
            this.updatePageTitle();

            // 显示成功消息
            let message = `成功导入 ${importedSchemes.length} 个方案`;
            if (skippedSchemes.length > 0) {
                message += `，跳过 ${skippedSchemes.length} 个方案`;
            }

            // 统计处理类型
            const updateCount = Array.from(this.conflictResolutions.values()).filter(r => r === 'update').length;
            const overwriteCount = Array.from(this.conflictResolutions.values()).filter(r => r === 'overwrite').length;
            const renameCount = Array.from(this.conflictResolutions.values()).filter(r => r.startsWith('rename:')).length;
            const bothCount = Array.from(this.conflictResolutions.values()).filter(r => r.startsWith('both:')).length;

            if (updateCount > 0) message += `，更新 ${updateCount} 个`;
            if (overwriteCount > 0) message += `，覆盖 ${overwriteCount} 个`;
            if (renameCount > 0) message += `，重命名 ${renameCount} 个`;
            if (bothCount > 0) message += `，保留副本 ${bothCount} 个`;

            if (importData.currentData && importData.currentData.travelList) {
                message += `，当前显示 ${this.getUsablePlaces(importData.currentData.travelList).length} 个有效地点`;
            }

            this.showToast(message);
            this.closeImportModal();
            this.closeConflictResolutionModal();

            // 重新加载方案列表以显示导入的方案
            this.loadSavedSchemes();

            console.log('完整备份导入成功:', {
                schemes: importedSchemes.length,
                skipped: skippedSchemes.length,
                currentPlaces: importData.currentData?.travelList?.length || 0,
                exportDate: importData.exportDate
            });

        } catch (error) {
            console.error('完整备份导入失败:', error);
            this.showToast(`导入失败：${error.message}`);
        }
    }

    // 验证方案名称是否可用
    validateSchemeName(name, excludeSchemeId = null) {
        const existingSchemes = this.getSavedSchemes();
        return !existingSchemes.some(scheme =>
            scheme.name === name &&
            (excludeSchemeId === null || scheme.id !== excludeSchemeId)
        );
    }

    // 为重命名输入框添加实时检查监听器
    addRenameInputListener(inputElement, index) {
        if (!inputElement) return;

        // 移除已有的监听器（如果存在）
        inputElement.removeEventListener('input', inputElement._renameCheckListener);

        // 创建新的监听器
        inputElement._renameCheckListener = () => {
            this.checkConflictRenameAvailability(index);
        };

        // 添加监听器
        inputElement.addEventListener('input', inputElement._renameCheckListener);

        // 初始检查
        this.checkConflictRenameAvailability(index);
    }

    // 检查冲突解决中的重命名是否可用
    checkConflictRenameAvailability(index) {
        const nameInput = document.getElementById(`newName_${index}`);
        const warning = document.getElementById(`renameWarning_${index}`);

        if (!nameInput || !warning) return;

        const newName = nameInput.value.trim();

        if (!newName) {
            warning.style.display = 'none';
            return;
        }

        // 检查是否与现有方案重名
        const isAvailable = this.validateSchemeName(newName);

        if (!isAvailable) {
            warning.style.display = 'block';
        } else {
            warning.style.display = 'none';
        }
    }

    // 检查方案名称可用性并更新UI
    checkSchemeNameAvailability() {
        const nameInput = document.getElementById('schemeNameInput');
        const warning = document.getElementById('schemeNameWarning');
        const saveBtn = document.getElementById('saveNewSchemeBtn');
        const schemeName = nameInput.value.trim();

        if (!schemeName) {
            // 名称为空
            warning.hidden = true;
            saveBtn.disabled = true;
            return;
        }

        if (!this.validateSchemeName(schemeName)) {
            // 名称重复
            warning.hidden = false;
            saveBtn.disabled = true;
        } else {
            // 名称可用
            warning.hidden = true;
            saveBtn.disabled = false;
        }
    }

    // 处理冲突解决
    processConflictResolution() {
        this.conflictResolutions.clear();

        for (let i = 0; i < this.pendingConflicts.length; i++) {
            const selectedRadio = document.querySelector(`input[name="resolution_${i}"]:checked`);
            if (!selectedRadio) continue;

            const resolution = selectedRadio.value;
            const conflictData = this.pendingConflicts[i].importScheme;
            const schemeKey = conflictData.uuid || String(conflictData.name ?? '');

            if (resolution === 'rename' || resolution === 'both') {
                const newNameInput = document.getElementById(`newName_${i}`);
                const newName = newNameInput.value.trim();
                if (!newName) {
                    this.showToast('请为所有重命名的方案输入新名称');
                    return;
                }

                // 检查重命名是否与现有方案重名
                if (!this.validateSchemeName(newName)) {
                    this.showToast(`方案名称"${newName}"已存在，请重新命名`);
                    newNameInput.focus();
                    return;
                }

                this.conflictResolutions.set(schemeKey, `${resolution}:${newName}`);
            } else {
                this.conflictResolutions.set(schemeKey, resolution);
            }
        }

        // 执行导入
        this.importFullBackup(this.pendingImportData);
    }

    // 关闭冲突解决模态框
    closeConflictResolutionModal() {
        this.dialogManager.close('conflictResolutionModal');
        this.pendingImportData = null;
        this.pendingConflicts = [];
        this.conflictResolutions.clear();
        // 确保导入模态框也被关闭
        this.closeImportModal();
    }

    // 截取地图截图
    async captureMapScreenshot() {
        try {
            const staticMapResult = await this.generateStaticMapImage();
            if (staticMapResult) return staticMapResult;
            const html2canvasResult = await this.tryHtml2canvasScreenshot();
            return html2canvasResult || this.generateTextMapPlaceholder();
        } catch (error) {
            return this.generateTextMapPlaceholder();
        }
    }

    // 尝试html2canvas截图
    async tryHtml2canvasScreenshot() {
        try {
            if (!this.isMapLoaded) {
                console.warn('⚠️ 地图未加载，跳过html2canvas');
                return null;
            }

            // 检查并加载html2canvas
            console.log('📦 检查html2canvas库...');
            if (typeof html2canvas === 'undefined') {
                try {
                    await this.loadHtml2Canvas();
                    console.log('✅ html2canvas库加载成功');
                } catch (error) {
                    console.error('❌ html2canvas库加载失败:', error);
                    return null;
                }
            }

            // 验证html2canvas函数可用
            if (typeof html2canvas !== 'function') {
                console.error('❌ html2canvas不是一个函数');
                return null;
            }

            const mapContainer = document.getElementById('mapContainer');
            if (!mapContainer) {
                console.error('❌ 地图容器未找到');
                return null;
            }

            // 简单等待地图稳定
            console.log('⏳ 等待地图稳定...');
            await new Promise(resolve => setTimeout(resolve, 2000));

            // 应用截图样式
            console.log('🎨 应用截图样式...');
            mapContainer.classList.add('screenshot-mode');
            await new Promise(resolve => setTimeout(resolve, 500));

            // 最简单的截图尝试
            console.log('📸 开始截图...');
            const canvas = await html2canvas(mapContainer, {
                allowTaint: true,
                useCORS: true,
                scale: 0.8,
                backgroundColor: '#ffffff',
                logging: false, // 关闭日志避免干扰
                width: 800,
                height: 600,
                scrollX: 0,
                scrollY: 0
            });

            console.log(`📸 截图完成: ${canvas.width}x${canvas.height}`);

            // 检查是否有任何内容
            const quality = this.checkCanvasQuality(canvas);
            console.log(`📊 截图质量: ${(quality * 100).toFixed(2)}%`);

            if (quality > 0) {
                const imageData = canvas.toDataURL('image/png', 0.8);
                console.log(`✅ 截图成功，数据长度: ${imageData.length}`);
                return imageData;
            } else {
                console.warn('⚠️ 截图内容为空');
                return null;
            }

        } catch (error) {
            console.error('❌ html2canvas截图失败:', error);
            return null;
        } finally {
            // 清理工作
            try {
                const mapContainer = document.getElementById('mapContainer');
                if (mapContainer) {
                    mapContainer.classList.remove('screenshot-mode');
                }
            } catch (cleanupError) {
                console.warn('⚠️ 清理失败:', cleanupError);
            }
        }
    }

    // 生成基于文本的地图占位符
    generateTextMapPlaceholder() {
        try {
            const usablePlaces = this.getUsablePlaces();
            if (usablePlaces.length === 0) {
                return null;
            }

            // 创建canvas
            const canvas = document.createElement('canvas');
            canvas.width = 800;
            canvas.height = 600;
            const ctx = canvas.getContext('2d');

            // 背景
            ctx.fillStyle = '#f0f8ff';
            ctx.fillRect(0, 0, 800, 600);

            // 边框
            ctx.strokeStyle = '#4a90e2';
            ctx.lineWidth = 3;
            ctx.strokeRect(5, 5, 790, 590);

            // 标题
            ctx.fillStyle = '#2c3e50';
            ctx.font = 'bold 28px Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('🗺️ 旅游路线地图', 400, 50);

            // 副标题
            ctx.fillStyle = '#7f8c8d';
            ctx.font = '16px Arial, sans-serif';
            ctx.fillText(`共 ${usablePlaces.length} 个游玩点`, 400, 80);

            // 游玩点列表
            ctx.textAlign = 'left';
            ctx.fillStyle = '#2c3e50';
            ctx.font = '18px Arial, sans-serif';

            const startY = 120;
            const lineHeight = 35;
            const maxItemsPerColumn = 12;
            const columnWidth = 380;

            usablePlaces.forEach((place, index) => {
                const column = Math.floor(index / maxItemsPerColumn);
                const row = index % maxItemsPerColumn;

                if (column < 2) { // 最多显示两列
                    const x = 50 + (column * columnWidth);
                    const y = startY + (row * lineHeight);

                    // 序号圆圈
                    ctx.fillStyle = '#4a90e2';
                    ctx.beginPath();
                    ctx.arc(x, y - 5, 12, 0, 2 * Math.PI);
                    ctx.fill();

                    // 序号文字
                    ctx.fillStyle = 'white';
                    ctx.font = 'bold 12px Arial, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText((index + 1).toString(), x, y);

                    // 地点名称
                    ctx.fillStyle = '#2c3e50';
                    ctx.font = '16px Arial, sans-serif';
                    ctx.textAlign = 'left';
                    const maxNameLength = 25;
                    const displayName = place.name.length > maxNameLength ?
                        place.name.substring(0, maxNameLength) + '...' : place.name;
                    ctx.fillText(displayName, x + 25, y + 3);
                }
            });

            // 如果游玩点太多，显示省略提示
            if (usablePlaces.length > 24) {
                ctx.fillStyle = '#95a5a6';
                ctx.font = '14px Arial, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(`还有 ${usablePlaces.length - 24} 个游玩点...`, 400, 540);
            }

            // 底部提示
            ctx.fillStyle = '#95a5a6';
            ctx.font = '14px Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('📍 地图截图生成失败，此为文本版路线图', 400, 570);

            return canvas.toDataURL('image/png', 0.9);

        } catch (error) {
            console.error('❌ 文本地图占位符生成失败:', error);
            return null;
        }
    }

    // 静态地图只从固定 BFF 端点取得图片字节；浏览器永不接收 provider URL 或服务端 Key。
    async generateStaticMapImage() {
        try {
            const validPlaces = this.getUsablePlaces();
            if (validPlaces.length === 0) return null;
            const provider = ['google', 'azure'].includes(this.settings.selectedMapApi)
                ? this.settings.selectedMapApi
                : 'google';
            const blob = await this.bff.staticMap({
                provider,
                points: validPlaces.slice(0, 50).map(place => ({ lat: place.lat, lng: place.lng })),
                width: 800,
                height: 600,
                drawPath: validPlaces.length > 1
            });
            if (!(blob instanceof Blob) || !['image/png', 'image/jpeg'].includes(blob.type)) return null;
            return await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
                reader.onerror = () => reject(new Error('static map decode failed'));
                reader.readAsDataURL(blob);
            });
        } catch (error) {
            return null;
        }
    }

    // 计算地图边界和缩放级别
    calculateMapBounds(places = this.getUsablePlaces()) {
        places = this.getUsablePlaces(places);
        if (places.length === 0) return null;

        if (places.length === 1) {
            return {
                center: { lat: places[0].lat, lng: places[0].lng },
                zoom: 14
            };
        }

        // 计算边界
        let minLat = places[0].lat;
        let maxLat = places[0].lat;
        let minLng = places[0].lng;
        let maxLng = places[0].lng;

        places.forEach(place => {
            minLat = Math.min(minLat, place.lat);
            maxLat = Math.max(maxLat, place.lat);
            minLng = Math.min(minLng, place.lng);
            maxLng = Math.max(maxLng, place.lng);
        });

        // 计算中心点
        const centerLat = (minLat + maxLat) / 2;
        const centerLng = (minLng + maxLng) / 2;

        // 计算合适的缩放级别
        const latDiff = maxLat - minLat;
        const lngDiff = maxLng - minLng;
        const maxDiff = Math.max(latDiff, lngDiff);

        let zoom;
        if (maxDiff > 10) zoom = 5;
        else if (maxDiff > 5) zoom = 6;
        else if (maxDiff > 2) zoom = 7;
        else if (maxDiff > 1) zoom = 8;
        else if (maxDiff > 0.5) zoom = 9;
        else if (maxDiff > 0.25) zoom = 10;
        else if (maxDiff > 0.125) zoom = 11;
        else if (maxDiff > 0.0625) zoom = 12;
        else if (maxDiff > 0.03125) zoom = 13;
        else zoom = 14;

        return {
            center: { lat: centerLat, lng: centerLng },
            zoom: zoom
        };
    }

    // 检查canvas质量的辅助方法
    checkCanvasQuality(canvas) {
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        let nonWhitePixels = 0;
        const totalPixels = imageData.data.length / 4;

        for (let i = 0; i < imageData.data.length; i += 4) {
            const r = imageData.data[i];
            const g = imageData.data[i + 1];
            const b = imageData.data[i + 2];
            const a = imageData.data[i + 3];

            // 如果不是白色(255,255,255)或透明(alpha=0)，则计为非空白像素
            if (!(r === 255 && g === 255 && b === 255) && a > 0) {
                nonWhitePixels++;
            }
        }

        return nonWhitePixels / totalPixels;
    }

    // 等待地图完全加载完成
    async waitForMapIdle() {
        return new Promise((resolve) => {
            // 设置超时保护
            const timeout = setTimeout(resolve, 5000);

            const idleListener = google.maps.event.addListener(this.map, 'idle', () => {
                clearTimeout(timeout);
                google.maps.event.removeListener(idleListener);
                resolve();
            });

            // 如果地图已经是idle状态，立即resolve
            setTimeout(() => {
                clearTimeout(timeout);
                google.maps.event.removeListener(idleListener);
                resolve();
            }, 100);
        });
    }

    // 为截图准备地图状态
    async prepareMapForScreenshot() {
        console.log('🎯 开始准备地图状态用于截图...');

        const usablePlaces = this.getUsablePlaces();
        if (usablePlaces.length === 0) {
            console.log('❌ 没有游玩点，跳过地图准备');
            return;
        }

        // 截图时优先显示所有游玩点，除非用户明确只想要某个城市的截图
        let placesToShow = usablePlaces;

        // 只有在有城市过滤且确实需要过滤时才使用过滤
        if (this.currentCityFilter && this.currentCityFilter !== 'all') {
            const filteredPlaces = usablePlaces.filter(place => {
                const cityName = this.extractCityFromAddress(place.address);
                return cityName === this.currentCityFilter;
            });

            // 如果过滤后还有游玩点，使用过滤结果；否则显示全部
            if (filteredPlaces.length > 0) {
                placesToShow = filteredPlaces;
                console.log(`🏙️ 过滤后显示 ${placesToShow.length} 个游玩点（${this.currentCityFilter}）`);
            } else {
                console.log(`⚠️ 过滤后无游玩点，显示全部 ${placesToShow.length} 个游玩点`);
            }
        } else {
            console.log(`📍 显示全部 ${placesToShow.length} 个游玩点`);
        }

        // 显示要截图的游玩点列表
        console.log('📝 待截图的游玩点:', placesToShow.map((place, index) =>
            `${index + 1}. ${place.name} (${place.lat.toFixed(4)}, ${place.lng.toFixed(4)})`
        ).join('\n'));

        if (placesToShow.length > 0) {
            // 调整地图视野 - 使用基于边界点的方法
            this.fitMapToPlacesForScreenshot(placesToShow);
            console.log('🗺️ 地图视野已调整用于截图');

            // 等待地图视野调整完成
            await new Promise(resolve => setTimeout(resolve, 1000));

            // 验证所有游玩点是否都在当前地图视野内
            await this.verifyAllPlacesInBounds(placesToShow);
        }

        // 确保所有标记都已正确显示
        this.recreateMarkers();
        console.log('📌 标记已重新创建');

        // 重新绘制路线
        this.drawRoute();
        console.log('🛣️ 路线已重新绘制');

        // 等待地图更新完成
        await new Promise(resolve => setTimeout(resolve, 1500));

        // 确保地图瓦片完全加载
        await this.waitForMapTilesLoaded();
        console.log('🧩 地图瓦片加载完成');

        console.log('✅ 地图状态准备完成，可以开始截图');
    }

    // 验证所有游玩点是否都在当前地图边界内
    async verifyAllPlacesInBounds(places) {
        places = this.getUsablePlaces(places);
        return new Promise((resolve) => {
            const checkBounds = () => {
                const currentBounds = this.map.getBounds();
                if (!currentBounds) {
                    console.log('⏳ 地图边界尚未确定，等待...');
                    setTimeout(checkBounds, 200);
                    return;
                }

                const outsidePlaces = [];
                places.forEach((place, index) => {
                    const point = new google.maps.LatLng(place.lat, place.lng);
                    if (!currentBounds.contains(point)) {
                        outsidePlaces.push({
                            index: index + 1,
                            name: place.name,
                            lat: place.lat,
                            lng: place.lng
                        });
                    }
                });

                if (outsidePlaces.length > 0) {
                    console.warn('⚠️ 发现边界外的游玩点:', outsidePlaces);
                    console.log('🔧 尝试重新调整地图边界...');

                    // 重新计算并设置边界，给予更大的扩展
                    const boundaries = this.findBoundaryPoints(places);
                    const expandedBounds = this.createExpandedBounds(boundaries, places, 0.5); // 使用更大的扩展比例
                    this.map.fitBounds(expandedBounds);

                    // 再次验证
                    setTimeout(checkBounds, 1000);
                } else {
                    console.log('✅ 所有游玩点都在地图边界内');
                    console.log(`📏 当前地图边界: 北${currentBounds.getNorthEast().lat().toFixed(4)} 南${currentBounds.getSouthWest().lat().toFixed(4)} 东${currentBounds.getNorthEast().lng().toFixed(4)} 西${currentBounds.getSouthWest().lng().toFixed(4)}`);
                    resolve();
                }
            };

            checkBounds();
        });
    }

    // 找到游玩点的四边边界点
    findBoundaryPoints(places) {
        places = this.getUsablePlaces(places);
        if (places.length === 0) return null;

        let northernmost = places[0]; // 最北（纬度最大）
        let southernmost = places[0]; // 最南（纬度最小）
        let easternmost = places[0];  // 最东（经度最大）
        let westernmost = places[0];  // 最西（经度最小）

        places.forEach(place => {
            if (place.lat > northernmost.lat) northernmost = place;
            if (place.lat < southernmost.lat) southernmost = place;
            if (place.lng > easternmost.lng) easternmost = place;
            if (place.lng < westernmost.lng) westernmost = place;
        });

        return {
            north: { lat: northernmost.lat, lng: northernmost.lng, name: northernmost.name },
            south: { lat: southernmost.lat, lng: southernmost.lng, name: southernmost.name },
            east: { lat: easternmost.lat, lng: easternmost.lng, name: easternmost.name },
            west: { lat: westernmost.lat, lng: westernmost.lng, name: westernmost.name },
            // 计算边界范围
            latRange: northernmost.lat - southernmost.lat,
            lngRange: easternmost.lng - westernmost.lng
        };
    }

    // 基于边界点创建扩大的地图边界
    createExpandedBounds(boundaries, places, expansionFactor = 0.3) {
        // 计算需要的扩展距离
        const latRange = boundaries.latRange;
        const lngRange = boundaries.lngRange;

        // 基础扩展比例
        let latExpansion = Math.max(latRange * expansionFactor, 0.01); // 至少扩展指定比例或0.01度
        let lngExpansion = Math.max(lngRange * expansionFactor, 0.01); // 至少扩展指定比例或0.01度

        // 如果游玩点分布很集中，给予更大的扩展
        if (latRange < 0.05) latExpansion = Math.max(latExpansion, 0.02);
        if (lngRange < 0.05) lngExpansion = Math.max(lngExpansion, 0.02);

        // 如果游玩点很多，适当增加扩展范围
        if (places.length > 5) {
            latExpansion *= 1.2;
            lngExpansion *= 1.2;
        }

        const expandedBounds = new google.maps.LatLngBounds();

        // 添加扩展后的边界点
        expandedBounds.extend({
            lat: boundaries.north.lat + latExpansion,
            lng: boundaries.west.lng - lngExpansion
        }); // 西北角

        expandedBounds.extend({
            lat: boundaries.south.lat - latExpansion,
            lng: boundaries.east.lng + lngExpansion
        }); // 东南角

        console.log(`📊 原始边界范围: 纬度${latRange.toFixed(4)}度, 经度${lngRange.toFixed(4)}度`);
        console.log(`🔧 扩展距离: 纬度${latExpansion.toFixed(4)}度, 经度${lngExpansion.toFixed(4)}度 (扩展比例: ${(expansionFactor * 100).toFixed(0)}%)`);
        console.log(`📐 最终边界: 北${(boundaries.north.lat + latExpansion).toFixed(4)} 南${(boundaries.south.lat - latExpansion).toFixed(4)} 东${(boundaries.east.lng + lngExpansion).toFixed(4)} 西${(boundaries.west.lng - lngExpansion).toFixed(4)}`);

        return expandedBounds;
    }

    // 等待地图瓦片完全加载
    async waitForMapTilesLoaded() {
        return new Promise((resolve) => {
            let checkCount = 0;
            const maxChecks = 50; // 最多检查5秒

            const checkTiles = () => {
                checkCount++;
                const mapContainer = document.getElementById('mapContainer');
                const images = mapContainer.querySelectorAll('img');
                let allLoaded = true;

                images.forEach(img => {
                    if (!img.complete || img.naturalHeight === 0) {
                        allLoaded = false;
                    }
                });

                if (allLoaded || checkCount >= maxChecks) {
                    console.log(`地图瓦片检查完成，检查次数: ${checkCount}, 全部加载: ${allLoaded}`);
                    resolve();
                } else {
                    setTimeout(checkTiles, 100);
                }
            };

            checkTiles();
        });
    }

    // 动态加载html2canvas库
    async loadHtml2Canvas() {
        if (typeof html2canvas === 'function') return;
        throw new Error('html2canvas must be self-hosted and loaded by the application shell');
    }

    // 生成分享用的HTML文件
    generateShareHTML(mapScreenshot = null) {
        const currentDate = new Date().toLocaleDateString('zh-CN');
        const shareMetrics = PlannerData.toShareMetrics(this.totalMetrics);
        const usablePlaces = this.getUsablePlaces();

        return Security.buildShareHtml({
            currentDate,
            currentFilter: String(this.currentCityFilter ?? 'all'),
            cityCount: this.getAllCities().length,
            totalDistance: shareMetrics.totalDistanceKm,
            totalTime: shareMetrics.totalTimeHours,
            mapScreenshot,
            places: usablePlaces.map(place => ({
                name: String(place && place.name || ''),
                address: String(place && place.address || '')
            }))
        });
    }

    // 专门用于截图的地图视野调整方法
    fitMapToPlacesForScreenshot(places) {
        places = this.getUsablePlaces(places);
        if (!this.isMapLoaded || places.length === 0) return;

        if (places.length === 1) {
            // 如果只有一个地点，中心到该地点，使用合适的缩放级别
            this.map.setCenter({ lat: places[0].lat, lng: places[0].lng });
            this.map.setZoom(12); // 稍微放大一些以显示更多细节
            console.log(`📍 单个游玩点截图，中心点: ${places[0].name}`);
        } else {
            // 找到四边最边上的点作为边界
            const boundaries = this.findBoundaryPoints(places);
            console.log('🔲 四边边界点:', boundaries);

            // 基于边界点创建包围所有游玩点的矩形区域
            const bounds = this.createExpandedBounds(boundaries, places, 0.3); // 默认扩展30%

            // 强制设置地图边界
            this.map.fitBounds(bounds);

            // 设置合理的缩放级别范围，并给予额外的缓冲时间
            google.maps.event.addListenerOnce(this.map, 'bounds_changed', () => {
                const currentZoom = this.map.getZoom();
                let adjustedZoom = currentZoom;

                if (currentZoom > 15) {
                    adjustedZoom = 15; // 最大缩放级别
                } else if (currentZoom < 5) {
                    adjustedZoom = 5;  // 最小缩放级别
                } else if (currentZoom > 13) {
                    // 如果缩放级别太高，适当降低以确保有足够的边界
                    adjustedZoom = currentZoom - 1;
                }

                if (adjustedZoom !== currentZoom) {
                    this.map.setZoom(adjustedZoom);
                }

                console.log(`📐 截图地图缩放级别: ${this.map.getZoom()}, 地图中心: ${this.map.getCenter().lat().toFixed(4)}, ${this.map.getCenter().lng().toFixed(4)}`);
            });
        }
    }

    // ==================== API缓存和优化方法 ====================

    // 生成列表变化的哈希值，用于检测是否需要重新计算距离
    generateTravelListHash() {
        const activePlaces = this.getUsablePlaces();
        const placeData = activePlaces.map(place => ({
            id: place.id,
            lat: place.lat,
            lng: place.lng
        }));
        return JSON.stringify({
            provider: this.settings.selectedMapApi,
            travelMode: this.routePlanOptions?.travelMode || 'DRIVING',
            roundTrip: this.routePlanOptions?.roundTrip === true,
            places: placeData
        });
    }

    // 检查是否需要重新计算距离
    shouldRecalculateDistances() {
        const currentHash = this.generateTravelListHash();
        if (currentHash !== this.lastTravelListHash) {
            this.lastTravelListHash = currentHash;
            return true;
        }
        return false;
    }

    // 生成距离缓存的键
    generateDistanceCacheKey(fromPlace, toPlace, provider = this.settings.selectedMapApi, mode = 'DRIVING') {
        return PerformanceCore.createRouteResultCacheKey({
            provider,
            travelMode: mode,
            origin: fromPlace,
            destination: toPlace,
            coordinatePrecision: PerformanceCore.ROUTE_COORDINATE_PRECISION,
            algorithmVersion: PerformanceCore.ROUTE_ALGORITHM_VERSION
        });
    }

    // 获取缓存的距离数据
    getCachedDistance(fromPlace, toPlace, travelMode = 'DRIVING') {
        const key = this.generateDistanceCacheKey(fromPlace, toPlace, this.settings.selectedMapApi, travelMode);
        const cached = this.distanceCache.get(key);

        if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
            return cached.value || cached;
        }

        return null;
    }

    // 缓存距离数据
    cacheDistance(fromPlace, toPlace, distanceMeters, durationSeconds, travelMode = 'DRIVING') {
        const key = this.generateDistanceCacheKey(fromPlace, toPlace, this.settings.selectedMapApi, travelMode);
        const existing = this.distanceCache.get(key)?.value || {};
        this.distanceCache.set(key, {
            value: { ...existing, distanceMeters, durationSeconds },
            timestamp: Date.now()
        });
    }

    // 生成搜索缓存的键
    generateSearchCacheKey(input) {
        const context = typeof input === 'string' ? this.getSearchContext(input) : input;
        return Search.createSearchCacheKey(context);
    }

    // 获取缓存的搜索结果
    getCachedSearchResult(input) {
        const key = this.generateSearchCacheKey(input);
        const cached = this.searchCache.get(key);

        if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
            return cached.results;
        }

        return null;
    }

    // 缓存搜索结果
    cacheSearchResult(input, results) {
        const key = this.generateSearchCacheKey(input);
        this.searchCache.set(key, {
            results,
            timestamp: Date.now()
        });
    }

    // 生成路线缓存的键
    generateRouteCacheKey(origin, destination, provider = this.settings.selectedMapApi, mode = 'DRIVING') {
        return this.generateDistanceCacheKey(origin, destination, provider, mode);
    }

    // 获取缓存的路线数据
    getCachedRoute(origin, destination, provider = this.settings.selectedMapApi, mode = 'DRIVING') {
        const key = this.generateRouteCacheKey(origin, destination, provider, mode);
        const cached = this.routeCache.get(key);

        if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
            return cached.value || cached;
        }

        return null;
    }

    // 缓存路线数据
    cacheRoute(origin, destination, coordinates, distanceMeters, durationSeconds, provider = this.settings.selectedMapApi, mode = 'DRIVING') {
        const key = this.generateRouteCacheKey(origin, destination, provider, mode);
        this.routeCache.set(key, {
            value: {
                provider,
                travelMode: mode,
                origin: { lat: origin.lat, lng: origin.lng },
                destination: { lat: destination.lat, lng: destination.lng },
                coordinates,
                distanceMeters,
                durationSeconds,
                source: 'provider',
                algorithmVersion: PerformanceCore.ROUTE_ALGORITHM_VERSION
            },
            timestamp: Date.now()
        });
    }

    // 清理过期缓存
    cleanExpiredCache() {
        const now = Date.now();
        let cleanedCount = 0;

        // 清理距离缓存
        for (const [key, value] of this.distanceCache.entries()) {
            if (now - value.timestamp > this.cacheTimeout) {
                this.distanceCache.delete(key);
                cleanedCount++;
            }
        }

        // 清理搜索缓存
        for (const [key, value] of this.searchCache.entries()) {
            if (now - value.timestamp > this.cacheTimeout) {
                this.searchCache.delete(key);
                cleanedCount++;
            }
        }

        // 清理路线缓存
        for (const [key, value] of this.routeCache.entries()) {
            if (now - value.timestamp > this.cacheTimeout) {
                this.routeCache.delete(key);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            console.log(`🧹 清理了 ${cleanedCount} 个过期缓存项`);
        }
    }

    // 防抖距离计算
    calculateDistancesWithDebounce() {
        return this.scheduleRoutePipeline(120);
    }

    // 优化后的距离计算（带缓存和重复检查）
    calculateDistancesOptimized() {
        const signature = this.generateRoutePipelineSignature();
        if (signature === this.routeResultSignature) return Promise.resolve(this.routeResults);
        return this.startRoutePipeline(this.beginRouteTokens(), signature);
    }
}

// Google Maps API回调函数
function initMap() {
    console.log('🌍 Google Maps API回调函数被调用');
    if (window.app && window.app.settings) {
        window.app.init();
        console.log('📱 已有TravelPlanner实例，继续初始化Google Maps');
    } else {
        window.app = new TravelPlanner();
        console.log('📱 TravelPlanner应用实例已创建 (Google Maps)');
    }
}

// 高德地图不需要回调函数，已在loadGaodeMapScript中直接处理

// 注册版本化应用壳缓存；只缓存本站静态文件，不缓存地图API、API Key或地图瓦片。
function registerAppShellServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

    const register = () => {
        navigator.serviceWorker.register('./service-worker.js').catch(error => {
            console.warn('应用缓存注册失败，将继续使用普通网络加载:', error);
        });
    };

    if (document.readyState === 'complete') {
        register();
    } else {
        window.addEventListener('load', register, { once: true });
    }
}

// 应用初始化：DOM就绪后立即创建实例并开始加载所选地图SDK。
document.addEventListener('DOMContentLoaded', () => {
    registerAppShellServiceWorker();

    if (!window.app || !window.app.settings) {
        window.app = new TravelPlanner();
    }
});

// 导出函数供HTML调用
if (typeof window !== 'undefined') {
    window.initMap = initMap;
    window.TravelPlanner = TravelPlanner;
}
