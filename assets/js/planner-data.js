(function (root, factory) {
    'use strict';

    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root === 'object') {
        Object.defineProperty(root, 'TravelPlannerData', {
            configurable: false,
            enumerable: true,
            writable: false,
            value: Object.freeze(api)
        });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SCHEMA_VERSION = 4;
    const BACKUP_VERSION = '4.0';
    const LIMITS = Object.freeze({
        maxFileBytes: 10 * 1024 * 1024,
        maxSchemes: 100,
        maxPlacesPerPlan: 2000,
        maxTotalPlaces: 10000,
        maxRouteSegments: 2000,
        maxIdLength: 200,
        maxSchemeNameLength: 100,
        maxPlaceNameLength: 1000,
        maxAddressLength: 2000,
        maxCustomNameLength: 100,
        maxNotesLength: 500,
        maxRouteKeyLength: 500,
        maxUuidLength: 300,
        maxDateLength: 64
    });
    const PROVIDERS = new Set(['amap', 'gaode', 'google', 'tianditu', 'azure']);
    const TRAVEL_MODES = new Set(['DRIVING', 'WALKING', 'BICYCLING', 'TRANSIT']);
    const IMPORT_TRANSACTION_KEY = 'travelPlannerImportTransaction';

    class DataValidationError extends Error {
        constructor(message, code = 'INVALID_DATA') {
            super(message);
            this.name = 'DataValidationError';
            this.code = code;
        }
    }

    function fail(message, code) {
        throw new DataValidationError(message, code);
    }

    function isPlainObject(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    function byteLength(value) {
        const text = String(value ?? '');
        if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
        if (typeof Buffer === 'function') return Buffer.byteLength(text, 'utf8');
        return unescape(encodeURIComponent(text)).length;
    }

    function cloneJson(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function assertString(value, path, maxLength, options = {}) {
        if (typeof value !== 'string') fail(`${path} 必须是字符串`);
        if (value.length > maxLength) fail(`${path} 字符串过长`);
        if (options.nonEmpty && value.trim().length === 0) fail(`${path} 不能为空`);
        return value;
    }

    function assertNullableString(value, path, maxLength) {
        if (value === null || value === undefined) return null;
        return assertString(value, path, maxLength);
    }

    function assertId(value, path, nullable = false) {
        if (nullable && (value === null || value === undefined || value === '')) return null;
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) fail(`${path} 必须是有限数值或字符串`);
            return value;
        }
        return assertString(value, path, LIMITS.maxIdLength, { nonEmpty: true });
    }

    function isValidCoordinate(place) {
        if (!isPlainObject(place)) return false;
        return Number.isFinite(place.lat) && Number.isFinite(place.lng) &&
            place.lat >= -90 && place.lat <= 90 &&
            place.lng >= -180 && place.lng <= 180;
    }

    function isUsablePlace(place) {
        return isPlainObject(place) && place.isPending !== true && place.isBlank !== true &&
            isValidCoordinate(place);
    }

    function getUsablePlaces(places) {
        return Array.isArray(places) ? places.filter(isUsablePlace) : [];
    }

    function buildValidSegments(places) {
        const usable = getUsablePlaces(places);
        const segments = [];
        for (let index = 1; index < usable.length; index++) {
            segments.push([usable[index - 1], usable[index]]);
        }
        return segments;
    }

    function validatePlace(value, path = 'place') {
        if (!isPlainObject(value)) fail(`${path} 必须是对象`);
        const isBlank = value.isBlank === true;
        const isPending = value.isPending === true;
        if (value.isBlank !== undefined && typeof value.isBlank !== 'boolean') {
            fail(`${path}.isBlank 必须是布尔值`);
        }
        if (value.isPending !== undefined && typeof value.isPending !== 'boolean') {
            fail(`${path}.isPending 必须是布尔值`);
        }

        const result = {
            id: assertId(value.id, `${path}.id`),
            name: assertString(value.name, `${path}.name`, LIMITS.maxPlaceNameLength),
            address: assertString(value.address, `${path}.address`, LIMITS.maxAddressLength),
            lat: value.lat,
            lng: value.lng,
            customName: assertNullableString(value.customName, `${path}.customName`, LIMITS.maxCustomNameLength),
            notes: assertNullableString(value.notes, `${path}.notes`, LIMITS.maxNotesLength),
            isPending,
            isBlank
        };

        if (isBlank && value.lat == null && value.lng == null) {
            result.lat = null;
            result.lng = null;
        } else if (!isValidCoordinate(value)) {
            fail(`${path} 坐标无效；非空白地点必须使用范围内的有限数值坐标`);
        }
        if (isBlank && ((value.lat == null) !== (value.lng == null))) {
            fail(`${path} 的空白地点 lat/lng 必须同时为空或同时有效`);
        }
        if (value.source !== undefined) {
            if (!['gaode', 'google', 'tianditu', 'azure', 'manual'].includes(value.source)) {
                fail(`${path}.source 无效`);
            }
            result.source = value.source;
        }
        return result;
    }

    function validateRouteSegments(value, path) {
        const entries = value === undefined ? [] : value;
        if (!Array.isArray(entries)) fail(`${path} 必须是数组`);
        if (entries.length > LIMITS.maxRouteSegments) fail(`${path} 数量超过限制`);
        return entries.map((entry, index) => {
            const entryPath = `${path}[${index}]`;
            if (!Array.isArray(entry) || entry.length !== 2) fail(`${entryPath} 格式无效`);
            const key = assertString(entry[0], `${entryPath}[0]`, LIMITS.maxRouteKeyLength);
            if (!isPlainObject(entry[1])) fail(`${entryPath}[1] 必须是对象`);
            const provider = entry[1].mapProvider === undefined ? 'amap' : entry[1].mapProvider;
            const mode = entry[1].travelMode === undefined ? 'DRIVING' : entry[1].travelMode;
            if (!PROVIDERS.has(provider)) fail(`${entryPath}.mapProvider 无效`);
            if (!TRAVEL_MODES.has(mode)) fail(`${entryPath}.travelMode 无效`);
            return [key, { mapProvider: provider, travelMode: mode }];
        });
    }

    function validatePlanData(value, path = 'plan') {
        if (!isPlainObject(value)) fail(`${path} 必须是对象`);
        if (!Array.isArray(value.travelList)) fail(`${path}.travelList 必须是数组`);
        if (value.travelList.length > LIMITS.maxPlacesPerPlan) {
            fail(`${path}.travelList 地点数超过限制`);
        }
        return {
            travelList: value.travelList.map((place, index) =>
                validatePlace(place, `${path}.travelList[${index}]`)),
            routeSegments: validateRouteSegments(value.routeSegments, `${path}.routeSegments`)
        };
    }

    function validateSettings(value, path) {
        if (value === undefined) return undefined;
        if (!isPlainObject(value)) fail(`${path} 必须是对象`);
        const preferences = value.preferences === undefined ? {} : value.preferences;
        if (!isPlainObject(preferences)) fail(`${path}.preferences 必须是对象`);
        const navigationApps = new Set(['amap', 'google', 'bing', 'tianditu']);
        const selectedMapApi = value.selectedMapApi === undefined ? 'gaode' : value.selectedMapApi;
        const navigationApp = value.navigationApp === undefined ? 'amap' : value.navigationApp;
        if (!PROVIDERS.has(selectedMapApi) || selectedMapApi === 'amap') {
            fail(`${path}.selectedMapApi 无效`);
        }
        if (!navigationApps.has(navigationApp)) fail(`${path}.navigationApp 无效`);
        return {
            navigationApp,
            selectedMapApi,
            advancedByokEnabled: value.advancedByokEnabled === true,
            preferences: {
                openInNewTab: preferences.openInNewTab !== false,
                showNavigationHint: preferences.showNavigationHint !== false,
                showShowInMapButton: preferences.showShowInMapButton !== false,
                showNavigateToButton: preferences.showNavigateToButton !== false
            }
        };
    }

    function copyCurrentData(value, path = 'currentData', requireSchemaVersion = false) {
        const plan = validatePlanData(value, path);
        if (requireSchemaVersion && value.schemaVersion !== SCHEMA_VERSION) {
            fail(`${path}.schemaVersion 与备份 Schema 版本不一致`);
        }
        const result = {
            ...plan,
            ...(requireSchemaVersion ? { schemaVersion: SCHEMA_VERSION } : {}),
            currentSchemeId: assertId(value.currentSchemeId, `${path}.currentSchemeId`, true),
            currentSchemeName: assertNullableString(
                value.currentSchemeName,
                `${path}.currentSchemeName`,
                LIMITS.maxSchemeNameLength
            ),
            hasUnsavedChanges: value.hasUnsavedChanges === true
        };
        if (value.settings !== undefined) result.settings = validateSettings(value.settings, `${path}.settings`);
        return result;
    }

    function validateScheme(value, path = 'scheme') {
        const plan = validatePlanData(value, path);
        if (value.version !== BACKUP_VERSION || value.schemaVersion !== SCHEMA_VERSION) {
            fail(`${path} 与备份 Schema 版本不一致`);
        }
        return {
            ...plan,
            schemaVersion: SCHEMA_VERSION,
            id: assertId(value.id, `${path}.id`),
            uuid: assertString(value.uuid ?? '', `${path}.uuid`, LIMITS.maxUuidLength),
            name: assertString(value.name, `${path}.name`, LIMITS.maxSchemeNameLength, { nonEmpty: true }),
            placesCount: getUsablePlaces(plan.travelList).length,
            createdAt: assertString(value.createdAt ?? '', `${path}.createdAt`, LIMITS.maxDateLength),
            modifiedAt: assertString(value.modifiedAt ?? '', `${path}.modifiedAt`, LIMITS.maxDateLength),
            version: value.version
        };
    }

    function validateSchemes(value, path = 'schemes') {
        if (!Array.isArray(value)) fail(`${path} 必须是数组`);
        if (value.length > LIMITS.maxSchemes) fail(`${path} 方案数超过限制`);
        const schemes = value.map((scheme, index) => validateScheme(scheme, `${path}[${index}]`));
        const totalPlaces = schemes.reduce((sum, scheme) => sum + scheme.travelList.length, 0);
        if (totalPlaces > LIMITS.maxTotalPlaces) fail(`${path} 地点总数超过限制`);
        return schemes;
    }

    function validateBackup(value) {
        if (!isPlainObject(value)) fail('备份数据必须是对象');
        if (value.type !== 'full-backup') fail('备份类型无效');
        if (value.version !== BACKUP_VERSION || value.schemaVersion !== SCHEMA_VERSION) {
            fail(`备份版本无效；需要先显式迁移到 ${BACKUP_VERSION}`, 'UNSUPPORTED_VERSION');
        }
        const schemes = validateSchemes(value.schemes);
        const currentData = copyCurrentData(value.currentData, 'currentData', true);
        const allPlaceCount = schemes.reduce((sum, scheme) => sum + scheme.travelList.length, 0) +
            currentData.travelList.length;
        if (allPlaceCount > LIMITS.maxTotalPlaces) fail('备份地点总数超过限制');
        return {
            version: BACKUP_VERSION,
            schemaVersion: SCHEMA_VERSION,
            type: 'full-backup',
            exportDate: assertString(value.exportDate ?? '', 'exportDate', LIMITS.maxDateLength),
            currentData,
            schemes,
            totalSchemes: schemes.length,
            totalPlaces: getUsablePlaces(currentData.travelList).length
        };
    }

    function createBackup(value) {
        const source = isPlainObject(value) ? value : {};
        const backup = validateBackup({
            version: BACKUP_VERSION,
            schemaVersion: SCHEMA_VERSION,
            type: 'full-backup',
            exportDate: source.exportDate || new Date().toISOString(),
            currentData: { ...source.currentData, schemaVersion: SCHEMA_VERSION },
            schemes: Array.isArray(source.schemes)
                ? source.schemes.map(scheme => ({ ...scheme, schemaVersion: SCHEMA_VERSION, version: BACKUP_VERSION }))
                : source.schemes
        });
        if (byteLength(JSON.stringify(backup)) > LIMITS.maxFileBytes) {
            fail('备份文件过大，请减少方案或地点后重试', 'FILE_TOO_LARGE');
        }
        return backup;
    }

    function parseAndValidateBackup(text) {
        if (byteLength(text) > LIMITS.maxFileBytes) {
            fail(`备份文件过大，最大支持 ${Math.floor(LIMITS.maxFileBytes / 1024 / 1024)}MB`, 'FILE_TOO_LARGE');
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            fail('备份文件不是有效的 JSON', 'INVALID_JSON');
        }
        return validateBackup(parsed);
    }

    function migrateBlankCoordinates(record) {
        if (!isPlainObject(record) || !Array.isArray(record.travelList)) return;
        record.travelList.forEach(place => {
            if (isPlainObject(place) && place.isBlank === true && !isValidCoordinate(place)) {
                place.lat = null;
                place.lng = null;
            }
        });
    }

    function migrateBackup(value) {
        if (!isPlainObject(value)) fail('备份数据必须是对象');
        if (value.version === BACKUP_VERSION && value.schemaVersion === SCHEMA_VERSION) {
            return validateBackup(value);
        }
        if (!['2.0', '3.0'].includes(value.version) || value.type !== 'full-backup') {
            fail('不支持的旧备份版本', 'UNSUPPORTED_VERSION');
        }
        const migrated = cloneJson(value);
        migrated.version = BACKUP_VERSION;
        migrated.schemaVersion = SCHEMA_VERSION;
        if (!isPlainObject(migrated.currentData)) migrated.currentData = { travelList: [], routeSegments: [] };
        migrated.currentData.schemaVersion = SCHEMA_VERSION;
        migrateBlankCoordinates(migrated.currentData);
        if (!Array.isArray(migrated.schemes)) migrated.schemes = [];
        migrated.schemes.forEach(scheme => {
            migrateBlankCoordinates(scheme);
            if (isPlainObject(scheme)) {
                scheme.version = BACKUP_VERSION;
                scheme.schemaVersion = SCHEMA_VERSION;
            }
        });
        return validateBackup(migrated);
    }

    function validateApplicationRecord(value, path = 'travelPlannerData') {
        const current = copyCurrentData(value, path);
        return {
            ...current,
            settings: validateSettings(value.settings, `${path}.settings`),
            dataSchemaVersion: SCHEMA_VERSION,
            lastSaved: typeof value.lastSaved === 'string'
                ? assertString(value.lastSaved, `${path}.lastSaved`, LIMITS.maxDateLength)
                : new Date().toISOString()
        };
    }

    function applicationRecordFromCurrentData(currentData) {
        return validateApplicationRecord({
            ...currentData,
            dataSchemaVersion: SCHEMA_VERSION,
            lastSaved: new Date().toISOString()
        });
    }

    function migrateApplicationRecord(value) {
        if (!isPlainObject(value)) fail('本地当前方案数据必须是对象');
        if (value.dataSchemaVersion === SCHEMA_VERSION) return validateApplicationRecord(value);
        const migrated = cloneJson(value);
        if (!Array.isArray(migrated.travelList)) migrated.travelList = [];
        if (!Array.isArray(migrated.routeSegments)) migrated.routeSegments = [];
        migrateBlankCoordinates(migrated);
        migrated.currentSchemeId = migrated.currentSchemeId ?? null;
        migrated.currentSchemeName = migrated.currentSchemeName ?? null;
        migrated.hasUnsavedChanges = migrated.hasUnsavedChanges === true;
        migrated.dataSchemaVersion = SCHEMA_VERSION;
        migrated.lastSaved = migrated.lastSaved || new Date().toISOString();
        return validateApplicationRecord(migrated);
    }

    function migrateStoredSchemes(value) {
        if (!Array.isArray(value)) fail('本地方案数据必须是数组');
        const migrated = cloneJson(value);
        migrated.forEach(scheme => {
            if (!isPlainObject(scheme)) return;
            if (!Array.isArray(scheme.travelList)) scheme.travelList = [];
            if (!Array.isArray(scheme.routeSegments)) scheme.routeSegments = [];
            migrateBlankCoordinates(scheme);
            scheme.uuid = scheme.uuid ?? '';
            scheme.createdAt = scheme.createdAt ?? '';
            scheme.modifiedAt = scheme.modifiedAt ?? scheme.createdAt;
            scheme.version = BACKUP_VERSION;
            scheme.schemaVersion = SCHEMA_VERSION;
        });
        return validateSchemes(migrated, 'travelSchemes');
    }

    function migrateStoredData(storage) {
        const nextRecords = {};
        const appRaw = storage.getItem('travelPlannerData');
        if (appRaw) {
            const parsed = JSON.parse(appRaw);
            if (parsed.dataSchemaVersion !== SCHEMA_VERSION) {
                nextRecords.travelPlannerData = JSON.stringify(migrateApplicationRecord(parsed));
            }
        }
        const schemesRaw = storage.getItem('travelSchemes');
        if (schemesRaw) {
            const parsed = JSON.parse(schemesRaw);
            const needsMigration = Array.isArray(parsed) && parsed.some(scheme =>
                !isPlainObject(scheme) || scheme.version !== BACKUP_VERSION ||
                scheme.schemaVersion !== SCHEMA_VERSION);
            if (needsMigration) nextRecords.travelSchemes = JSON.stringify(migrateStoredSchemes(parsed));
        }
        if (Object.keys(nextRecords).length > 0) atomicWrite(storage, nextRecords);
        return Object.keys(nextRecords);
    }

    function restoreStorageValue(storage, key, previousValue) {
        try {
            if (previousValue === null) storage.removeItem(key);
            else storage.setItem(key, previousValue);
            return true;
        } catch (error) {
            return false;
        }
    }

    function recoverPendingTransaction(storage) {
        const raw = storage && storage.getItem(IMPORT_TRANSACTION_KEY);
        if (!raw) return false;
        let journal;
        try {
            journal = JSON.parse(raw);
        } catch (error) {
            fail('导入恢复日志损坏，请清除此站点的本地数据后重试', 'INVALID_TRANSACTION_LOG');
        }
        if (!isPlainObject(journal) || !isPlainObject(journal.previous)) {
            fail('导入恢复日志无效，请清除此站点的本地数据后重试', 'INVALID_TRANSACTION_LOG');
        }
        const restoreResults = Object.entries(journal.previous).map(([key, previousValue]) =>
            restoreStorageValue(storage, key, previousValue));
        const restored = restoreResults.every(Boolean);
        if (!restored) {
            fail('上次导入尚未完成回滚，请释放浏览器存储空间后刷新页面', 'ROLLBACK_PENDING');
        }
        storage.removeItem(IMPORT_TRANSACTION_KEY);
        return true;
    }

    function atomicWrite(storage, records) {
        if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
            fail('本地存储不可用', 'STORAGE_UNAVAILABLE');
        }
        const entries = Object.entries(records);
        const previous = new Map(entries.map(([key]) => [key, storage.getItem(key)]));
        const usesJournal = entries.length > 1;
        const written = [];
        try {
            if (usesJournal) {
                storage.setItem(IMPORT_TRANSACTION_KEY, JSON.stringify({
                    version: 1,
                    previous: Object.fromEntries(previous)
                }));
            }
            entries.forEach(([key, value]) => {
                storage.setItem(key, String(value));
                written.push(key);
            });
            if (usesJournal) storage.removeItem(IMPORT_TRANSACTION_KEY);
        } catch (error) {
            const restoreResults = [...written].reverse().map(key =>
                restoreStorageValue(storage, key, previous.get(key)));
            const restored = restoreResults.every(Boolean);
            if (usesJournal && restored) {
                try { storage.removeItem(IMPORT_TRANSACTION_KEY); } catch (cleanupError) { /* recovered on startup */ }
            }
            const quota = error && (error.name === 'QuotaExceededError' || error.code === 22);
            fail(
                quota
                    ? `本地存储空间不足，导入已${restored ? '完整回滚' : '进入安全恢复'}。请删除不需要的方案后重试。`
                    : `本地存储写入失败，导入已${restored ? '完整回滚' : '进入安全恢复'}。请检查浏览器存储权限后重试。`,
                quota ? 'STORAGE_QUOTA' : 'STORAGE_WRITE_FAILED'
            );
        }
    }

    function commitImportTransaction(storage, value) {
        if (!isPlainObject(value)) fail('导入事务数据无效');
        const schemes = validateSchemes(value.schemes);
        const applicationRecord = applicationRecordFromCurrentData(value.currentData);
        const allPlaceCount = schemes.reduce((sum, scheme) => sum + scheme.travelList.length, 0) +
            applicationRecord.travelList.length;
        if (allPlaceCount > LIMITS.maxTotalPlaces) fail('导入地点总数超过限制');
        atomicWrite(storage, {
            travelSchemes: JSON.stringify(schemes),
            travelPlannerData: JSON.stringify(applicationRecord)
        });
        return { schemes, currentData: applicationRecord };
    }

    function readApplicationRecord(storage) {
        const raw = storage && storage.getItem('travelPlannerData');
        if (!raw) return null;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            fail('本地当前方案数据损坏', 'INVALID_STORED_DATA');
        }
        if (parsed.dataSchemaVersion !== SCHEMA_VERSION) {
            fail('本地数据版本过旧，需要先执行显式迁移', 'UNSUPPORTED_VERSION');
        }
        return validateApplicationRecord(parsed);
    }

    function createRouteMetrics(distanceMeters, durationSeconds) {
        if (!Number.isFinite(distanceMeters) || distanceMeters < 0 ||
            !Number.isFinite(durationSeconds) || durationSeconds < 0) {
            fail('距离和时间必须是非负有限数值');
        }
        return { distanceMeters, durationSeconds };
    }

    function toShareMetrics(value) {
        const metrics = createRouteMetrics(value.distanceMeters, value.durationSeconds);
        return {
            totalDistanceKm: metrics.distanceMeters / 1000,
            totalTimeHours: metrics.durationSeconds / 3600,
            totalTimeMinutes: metrics.durationSeconds / 60
        };
    }

    function applyPlaceEdit(place, customName, notes) {
        if (!isPlainObject(place)) fail('要编辑的地点不存在');
        const normalizedCustomName = String(customName ?? '').trim().slice(0, LIMITS.maxCustomNameLength);
        const normalizedNotes = String(notes ?? '').trim().slice(0, LIMITS.maxNotesLength);
        place.customName = normalizedCustomName || null;
        place.notes = normalizedNotes || null;
        return {
            place,
            displayName: normalizedCustomName || String(place.name ?? '')
        };
    }

    return Object.freeze({
        SCHEMA_VERSION,
        BACKUP_VERSION,
        LIMITS,
        DataValidationError,
        isValidCoordinate,
        isUsablePlace,
        getUsablePlaces,
        buildValidSegments,
        validatePlace,
        validatePlanData,
        validateScheme,
        validateSchemes,
        validateBackup,
        createBackup,
        parseAndValidateBackup,
        migrateBackup,
        validateApplicationRecord,
        applicationRecordFromCurrentData,
        migrateApplicationRecord,
        migrateStoredSchemes,
        migrateStoredData,
        recoverPendingTransaction,
        atomicWrite,
        commitImportTransaction,
        readApplicationRecord,
        createRouteMetrics,
        toShareMetrics,
        applyPlaceEdit
    });
});
