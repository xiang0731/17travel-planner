(function (root, factory) {
    'use strict';

    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root === 'object') {
        Object.defineProperty(root, 'TravelPlannerRouteOptimizer', {
            configurable: false,
            enumerable: true,
            writable: false,
            value: Object.freeze(api)
        });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const TRAVEL_MODES = Object.freeze(['DRIVING', 'WALKING', 'BICYCLING', 'TRANSIT']);
    const MATRIX_SOURCES = Object.freeze(['provider', 'haversine']);
    const CONSTRAINT_TYPES = Object.freeze({
        OPENING_HOURS: 'opening-hours',
        STAY_DURATION: 'stay-duration',
        DAY_BOUNDARY: 'day-boundary'
    });
    const DEFAULT_BUDGETS = Object.freeze({
        exactThreshold: 10,
        exactEvaluations: 250000,
        mediumMaxStarts: 24,
        mediumTwoOptEvaluations: 120000,
        mediumTwoOptPasses: 30,
        largeMaxStarts: 12,
        largeTwoOptEvaluations: 90000,
        largeTwoOptPasses: 12,
        hugeMaxStarts: 6,
        hugeTwoOptEvaluations: 50000,
        hugeTwoOptPasses: 6
    });

    class RouteOptimizationError extends Error {
        constructor(message, code = 'INVALID_OPTIMIZATION_INPUT') {
            super(message);
            this.name = 'RouteOptimizationError';
            this.code = code;
        }
    }

    function fail(message, code) {
        throw new RouteOptimizationError(message, code);
    }

    function isPlainObject(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === null || (
            typeof prototype.constructor === 'function' && prototype.constructor.name === 'Object'
        );
    }

    function isPureData(value, seen = new WeakSet()) {
        if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
        if (typeof value === 'number') return Number.isFinite(value);
        if (typeof value !== 'object' || seen.has(value)) return false;
        seen.add(value);
        if (Array.isArray(value)) return value.every(item => isPureData(item, seen));
        if (!isPlainObject(value)) return false;
        return Object.values(value).every(item => isPureData(item, seen));
    }

    function normalizeId(value, field) {
        if (!['string', 'number'].includes(typeof value) || !String(value).trim()) {
            fail(`${field} 必须是非空字符串或有限数值`);
        }
        if (typeof value === 'number' && !Number.isFinite(value)) fail(`${field} 必须是有限数值`);
        return String(value);
    }

    function normalizePlaces(value) {
        if (!Array.isArray(value) || value.length < 2) fail('places 至少需要两个地点');
        const seen = new Set();
        return value.map((place, index) => {
            if (!isPlainObject(place)) fail(`places[${index}] 无效`);
            const id = normalizeId(place.id, `places[${index}].id`);
            if (place.isBlank === true || place.isPending === true) {
                fail(`地点 ${id} 是空白点或待定点，不能进入优化`, 'EXCLUDED_PLACE');
            }
            if (seen.has(id)) fail(`地点 ID 重复：${id}`);
            seen.add(id);
            if (!Number.isFinite(place.lat) || place.lat < -90 || place.lat > 90 ||
                !Number.isFinite(place.lng) || place.lng < -180 || place.lng > 180) {
                fail(`地点 ${id} 缺少有效坐标`);
            }
            return Object.freeze({
                id,
                name: String(place.name ?? id),
                lat: place.lat,
                lng: place.lng
            });
        });
    }

    function normalizeNumericMatrix(value, size, field) {
        if (!Array.isArray(value) || value.length !== size) fail(`${field} 维度必须为 ${size}×${size}`);
        return value.map((row, rowIndex) => {
            if (!Array.isArray(row) || row.length !== size) fail(`${field}[${rowIndex}] 维度无效`);
            return Object.freeze(row.map((entry, columnIndex) => {
                if (!Number.isFinite(entry) || entry < 0) {
                    fail(`${field}[${rowIndex}][${columnIndex}] 必须是非负有限数值`);
                }
                return entry;
            }));
        });
    }

    function normalizeSourceMatrix(value, size) {
        if (value === undefined) {
            return Array.from({ length: size }, () => Object.freeze(Array(size).fill('provider')));
        }
        if (!Array.isArray(value) || value.length !== size) fail(`matrixSources 维度必须为 ${size}×${size}`);
        return value.map((row, rowIndex) => {
            if (!Array.isArray(row) || row.length !== size) fail(`matrixSources[${rowIndex}] 维度无效`);
            return Object.freeze(row.map((entry, columnIndex) => {
                if (!MATRIX_SOURCES.includes(entry)) {
                    fail(`matrixSources[${rowIndex}][${columnIndex}] 来源无效`);
                }
                return entry;
            }));
        });
    }

    // Constraint 是可序列化的数据接口。下一阶段实现对应 evaluator 前，启用的约束会显式拒绝，绝不静默忽略。
    function normalizeConstraints(value) {
        if (value === undefined) return Object.freeze([]);
        if (!Array.isArray(value)) fail('constraints 必须是数组');
        return Object.freeze(value.map((constraint, index) => {
            if (!isPlainObject(constraint)) fail(`constraints[${index}] 无效`);
            const type = String(constraint.type ?? '').trim();
            if (!type) fail(`constraints[${index}].type 不能为空`);
            const parameters = constraint.parameters === undefined ? {} : constraint.parameters;
            if (!isPlainObject(parameters)) fail(`constraints[${index}].parameters 必须是对象`);
            return Object.freeze({
                id: String(constraint.id ?? `constraint-${index}`),
                type,
                enabled: constraint.enabled !== false,
                parameters: Object.freeze({ ...parameters })
            });
        }));
    }

    function positiveInteger(value, fallback, maximum) {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 1) return fallback;
        return Math.min(maximum, Math.floor(number));
    }

    function computationBudget(size, override = {}) {
        const source = isPlainObject(override) ? override : {};
        let tier;
        if (size <= 20) {
            tier = {
                name: 'standard',
                maxStarts: Math.min(size - 1, DEFAULT_BUDGETS.mediumMaxStarts),
                maxTwoOptEvaluations: DEFAULT_BUDGETS.mediumTwoOptEvaluations,
                maxTwoOptPasses: DEFAULT_BUDGETS.mediumTwoOptPasses
            };
        } else if (size <= 50) {
            tier = {
                name: 'large',
                maxStarts: DEFAULT_BUDGETS.largeMaxStarts,
                maxTwoOptEvaluations: DEFAULT_BUDGETS.largeTwoOptEvaluations,
                maxTwoOptPasses: DEFAULT_BUDGETS.largeTwoOptPasses
            };
        } else {
            tier = {
                name: 'degraded',
                maxStarts: DEFAULT_BUDGETS.hugeMaxStarts,
                maxTwoOptEvaluations: DEFAULT_BUDGETS.hugeTwoOptEvaluations,
                maxTwoOptPasses: DEFAULT_BUDGETS.hugeTwoOptPasses
            };
        }
        return Object.freeze({
            name: tier.name,
            maxStarts: positiveInteger(source.maxStarts, tier.maxStarts, 100),
            maxTwoOptEvaluations: positiveInteger(source.maxTwoOptEvaluations, tier.maxTwoOptEvaluations, 2000000),
            maxTwoOptPasses: positiveInteger(source.maxTwoOptPasses, tier.maxTwoOptPasses, 100),
            exactThreshold: positiveInteger(source.exactThreshold, DEFAULT_BUDGETS.exactThreshold, 12),
            exactEvaluations: positiveInteger(source.exactEvaluations, DEFAULT_BUDGETS.exactEvaluations, 2000000)
        });
    }

    function normalizeInput(value) {
        if (!isPlainObject(value)) fail('优化输入必须是纯数据对象');
        if (!isPureData(value)) fail('优化输入只能包含可序列化的纯数据');
        const allowedFields = new Set([
            'places', 'travelTimeMatrix', 'distanceMatrix', 'matrixSources',
            'fixedStartId', 'fixedEndId', 'roundTrip', 'lockedPlaceIds',
            'travelMode', 'constraints', 'computationBudget'
        ]);
        Object.keys(value).forEach(field => {
            if (!allowedFields.has(field)) fail(`优化输入包含未知字段：${field}`);
        });
        const places = normalizePlaces(value.places);
        const size = places.length;
        const ids = new Set(places.map(place => place.id));
        const fixedStartId = normalizeId(value.fixedStartId, 'fixedStartId');
        if (!ids.has(fixedStartId)) fail('fixedStartId 不在地点列表中');
        const fixedEndId = value.fixedEndId == null || value.fixedEndId === ''
            ? null
            : normalizeId(value.fixedEndId, 'fixedEndId');
        if (fixedEndId && !ids.has(fixedEndId)) fail('fixedEndId 不在地点列表中');
        if (fixedEndId === fixedStartId) fail('固定起点和固定终点不能相同');
        const roundTrip = value.roundTrip === true;
        if (roundTrip && fixedEndId) fail('往返路线不能同时设置固定终点');
        const travelMode = String(value.travelMode ?? 'DRIVING').toUpperCase();
        if (!TRAVEL_MODES.includes(travelMode)) fail('travelMode 无效');

        const lockedPlaceIds = Array.isArray(value.lockedPlaceIds)
            ? value.lockedPlaceIds.map((id, index) => normalizeId(id, `lockedPlaceIds[${index}]`))
            : [];
        if (new Set(lockedPlaceIds).size !== lockedPlaceIds.length) fail('lockedPlaceIds 不能重复');
        lockedPlaceIds.forEach(id => {
            if (!ids.has(id)) fail(`锁定地点不存在：${id}`);
        });
        const originalOrder = new Map(places.map((place, index) => [place.id, index]));
        lockedPlaceIds.sort((left, right) => originalOrder.get(left) - originalOrder.get(right));
        const startLockIndex = lockedPlaceIds.indexOf(fixedStartId);
        if (startLockIndex > 0) fail('固定起点之前不能存在锁定地点');
        const endLockIndex = fixedEndId ? lockedPlaceIds.indexOf(fixedEndId) : -1;
        if (endLockIndex >= 0 && endLockIndex !== lockedPlaceIds.length - 1) {
            fail('固定终点之后不能存在锁定地点');
        }

        const constraints = normalizeConstraints(value.constraints);
        const unsupported = constraints.filter(constraint => constraint.enabled);
        if (unsupported.length) {
            fail(`当前阶段尚未启用约束：${unsupported.map(item => item.type).join('、')}`, 'UNSUPPORTED_CONSTRAINT');
        }

        return Object.freeze({
            places,
            travelTimeMatrix: normalizeNumericMatrix(value.travelTimeMatrix, size, 'travelTimeMatrix'),
            distanceMatrix: normalizeNumericMatrix(value.distanceMatrix, size, 'distanceMatrix'),
            matrixSources: normalizeSourceMatrix(value.matrixSources, size),
            fixedStartId,
            fixedEndId,
            roundTrip,
            lockedPlaceIds: Object.freeze(lockedPlaceIds),
            travelMode,
            constraints,
            computationBudget: computationBudget(size, value.computationBudget)
        });
    }

    function compareIds(left, right, places) {
        return places[left].id.localeCompare(places[right].id, 'en');
    }

    function scoreRoute(route, input) {
        let durationSeconds = 0;
        let distanceMeters = 0;
        const segments = [];
        const append = (from, to) => {
            const duration = input.travelTimeMatrix[from][to];
            const distance = input.distanceMatrix[from][to];
            const source = input.matrixSources[from][to];
            durationSeconds += duration;
            distanceMeters += distance;
            segments.push(Object.freeze({
                fromId: input.places[from].id,
                toId: input.places[to].id,
                durationSeconds: duration,
                distanceMeters: distance,
                source
            }));
        };
        for (let index = 1; index < route.length; index++) append(route[index - 1], route[index]);
        if (input.roundTrip && route.length > 1) append(route[route.length - 1], route[0]);
        return Object.freeze({ durationSeconds, distanceMeters, segments: Object.freeze(segments) });
    }

    function routeLexicalKey(route, input) {
        return route.map(index => input.places[index].id).join('\u0000');
    }

    function compareRouteScores(leftRoute, rightRoute, input) {
        if (!rightRoute) return -1;
        const left = scoreRoute(leftRoute, input);
        const right = scoreRoute(rightRoute, input);
        if (left.durationSeconds !== right.durationSeconds) return left.durationSeconds - right.durationSeconds;
        if (left.distanceMeters !== right.distanceMeters) return left.distanceMeters - right.distanceMeters;
        return routeLexicalKey(leftRoute, input).localeCompare(routeLexicalKey(rightRoute, input), 'en');
    }

    function lockedOrderIsValid(route, input) {
        let previous = -1;
        for (const lockedId of input.lockedPlaceIds) {
            const placeIndex = input.places.findIndex(place => place.id === lockedId);
            const position = route.indexOf(placeIndex);
            if (position <= previous) return false;
            previous = position;
        }
        return true;
    }

    function canAppend(candidate, visited, input, placeIndexById) {
        const candidateId = input.places[candidate].id;
        const lockIndex = input.lockedPlaceIds.indexOf(candidateId);
        if (lockIndex <= 0) return true;
        return input.lockedPlaceIds.slice(0, lockIndex).every(id => visited.has(placeIndexById.get(id)));
    }

    function nearestNeighbor(input, seededSecond = null) {
        const placeIndexById = new Map(input.places.map((place, index) => [place.id, index]));
        const start = placeIndexById.get(input.fixedStartId);
        const end = input.fixedEndId ? placeIndexById.get(input.fixedEndId) : null;
        const route = [start];
        const visited = new Set(route);

        if (seededSecond != null && seededSecond !== end && canAppend(seededSecond, visited, input, placeIndexById)) {
            route.push(seededSecond);
            visited.add(seededSecond);
        }

        while (visited.size < input.places.length - (end == null ? 0 : 1)) {
            const current = route[route.length - 1];
            const candidates = input.places
                .map((place, index) => index)
                .filter(index => !visited.has(index) && index !== end && canAppend(index, visited, input, placeIndexById))
                .sort((left, right) => {
                    const cost = input.travelTimeMatrix[current][left] - input.travelTimeMatrix[current][right];
                    return cost || compareIds(left, right, input.places);
                });
            if (!candidates.length) fail('锁定顺序无法生成可行路线', 'INFEASIBLE_ROUTE');
            route.push(candidates[0]);
            visited.add(candidates[0]);
        }
        if (end != null) {
            if (!canAppend(end, visited, input, placeIndexById)) fail('固定终点与锁定顺序冲突', 'INFEASIBLE_ROUTE');
            route.push(end);
        }
        if (!lockedOrderIsValid(route, input)) fail('锁定顺序无法满足', 'INFEASIBLE_ROUTE');
        return route;
    }

    function seedCandidates(input) {
        const placeIndexById = new Map(input.places.map((place, index) => [place.id, index]));
        const start = placeIndexById.get(input.fixedStartId);
        const end = input.fixedEndId ? placeIndexById.get(input.fixedEndId) : null;
        const visited = new Set([start]);
        const candidates = input.places
            .map((place, index) => index)
            .filter(index => index !== start && index !== end && canAppend(index, visited, input, placeIndexById))
            .sort((left, right) => {
                const cost = input.travelTimeMatrix[start][left] - input.travelTimeMatrix[start][right];
                return cost || compareIds(left, right, input.places);
            });
        return candidates.slice(0, input.computationBudget.maxStarts);
    }

    function runMultiStartNearestNeighbor(input) {
        const seeds = seedCandidates(input);
        if (!seeds.length) return { route: nearestNeighbor(input), startsEvaluated: 1 };
        let best = null;
        seeds.forEach(seed => {
            const candidate = nearestNeighbor(input, seed);
            if (compareRouteScores(candidate, best, input) < 0) best = candidate;
        });
        return { route: best, startsEvaluated: seeds.length };
    }

    function improveWithTwoOpt(initialRoute, input) {
        let route = initialRoute.slice();
        let evaluations = 0;
        let passes = 0;
        let improvements = 0;
        let budgetHit = false;
        const fixedEndIndex = input.fixedEndId ? route.length - 1 : route.length;

        while (passes < input.computationBudget.maxTwoOptPasses) {
            passes += 1;
            let bestCandidate = null;
            for (let left = 1; left < fixedEndIndex - 1; left++) {
                for (let right = left + 1; right < fixedEndIndex; right++) {
                    if (evaluations >= input.computationBudget.maxTwoOptEvaluations) {
                        budgetHit = true;
                        break;
                    }
                    evaluations += 1;
                    const candidate = route.slice(0, left)
                        .concat(route.slice(left, right + 1).reverse(), route.slice(right + 1));
                    if (!lockedOrderIsValid(candidate, input)) continue;
                    if (compareRouteScores(candidate, route, input) >= 0) continue;
                    if (!bestCandidate || compareRouteScores(candidate, bestCandidate, input) < 0) bestCandidate = candidate;
                }
                if (budgetHit) break;
            }
            if (!bestCandidate) break;
            route = bestCandidate;
            improvements += 1;
            if (budgetHit) break;
        }
        return { route, evaluations, passes, improvements, budgetHit };
    }

    function exactHeldKarp(input) {
        const size = input.places.length;
        if (size > input.computationBudget.exactThreshold || size > 30) return { route: null, evaluations: 0, completed: false };
        const placeIndexById = new Map(input.places.map((place, index) => [place.id, index]));
        const start = placeIndexById.get(input.fixedStartId);
        const end = input.fixedEndId ? placeIndexById.get(input.fixedEndId) : null;
        const startMask = (1 << start) >>> 0;
        let layer = new Map([[`${startMask}:${start}`, { mask: startMask, last: start, route: [start] }]]);
        let evaluations = 0;

        for (let depth = 1; depth < size; depth++) {
            const nextLayer = new Map();
            for (const state of layer.values()) {
                const visited = new Set(state.route);
                for (let candidate = 0; candidate < size; candidate++) {
                    if (visited.has(candidate)) continue;
                    if (end != null && candidate === end && depth !== size - 1) continue;
                    if (!canAppend(candidate, visited, input, placeIndexById)) continue;
                    evaluations += 1;
                    if (evaluations > input.computationBudget.exactEvaluations) {
                        return { route: null, evaluations, completed: false };
                    }
                    const mask = (state.mask | (1 << candidate)) >>> 0;
                    const route = state.route.concat(candidate);
                    const key = `${mask}:${candidate}`;
                    const existing = nextLayer.get(key);
                    if (!existing || compareOpenPathScores(route, existing.route, input) < 0) {
                        nextLayer.set(key, { mask, last: candidate, route });
                    }
                }
            }
            layer = nextLayer;
            if (!layer.size) return { route: null, evaluations, completed: true };
        }
        let best = null;
        for (const state of layer.values()) {
            if (compareRouteScores(state.route, best, input) < 0) best = state.route;
        }
        return { route: best, evaluations, completed: true };
    }

    function compareOpenPathScores(leftRoute, rightRoute, input) {
        const openScore = route => {
            let durationSeconds = 0;
            let distanceMeters = 0;
            for (let index = 1; index < route.length; index++) {
                durationSeconds += input.travelTimeMatrix[route[index - 1]][route[index]];
                distanceMeters += input.distanceMatrix[route[index - 1]][route[index]];
            }
            return { durationSeconds, distanceMeters };
        };
        const left = openScore(leftRoute);
        const right = openScore(rightRoute);
        if (left.durationSeconds !== right.durationSeconds) return left.durationSeconds - right.durationSeconds;
        if (left.distanceMeters !== right.distanceMeters) return left.distanceMeters - right.distanceMeters;
        return routeLexicalKey(leftRoute, input).localeCompare(routeLexicalKey(rightRoute, input), 'en');
    }

    function classifyMeasurement(segments) {
        const fallbackCount = segments.filter(segment => segment.source === 'haversine').length;
        if (fallbackCount === 0) return 'provider';
        if (fallbackCount === segments.length) return 'straight-line-estimate';
        return 'mixed';
    }

    function routeResult(route, input) {
        const metrics = scoreRoute(route, input);
        return Object.freeze({
            routeIds: Object.freeze(route.map(index => input.places[index].id)),
            durationSeconds: metrics.durationSeconds,
            distanceMeters: metrics.distanceMeters,
            segments: metrics.segments,
            measurement: classifyMeasurement(metrics.segments),
            hasStraightLineEstimates: metrics.segments.some(segment => segment.source === 'haversine')
        });
    }

    function originalRoute(input) {
        return input.places.map((place, index) => index);
    }

    function optimizeRoute(value) {
        const input = normalizeInput(value);
        const nearest = runMultiStartNearestNeighbor(input);
        const nearestScore = routeResult(nearest.route, input);
        const twoOpt = improveWithTwoOpt(nearest.route, input);
        let chosen = twoOpt.route;
        const exact = exactHeldKarp(input);
        let globalOptimal = false;
        let method = 'multi-start-nearest-neighbor+2-opt';
        if (exact.completed && exact.route) {
            chosen = exact.route;
            globalOptimal = true;
            method = 'exact-held-karp';
        }
        const suggestion = routeResult(chosen, input);
        const original = routeResult(originalRoute(input), input);
        return Object.freeze({
            original,
            suggestion,
            savings: Object.freeze({
                durationRatio: original.durationSeconds > 0
                    ? (original.durationSeconds - suggestion.durationSeconds) / original.durationSeconds
                    : 0,
                distanceRatio: original.distanceMeters > 0
                    ? (original.distanceMeters - suggestion.distanceMeters) / original.distanceMeters
                    : 0
            }),
            method,
            globalOptimal,
            travelMode: input.travelMode,
            fixedStartId: input.fixedStartId,
            fixedEndId: input.fixedEndId,
            roundTrip: input.roundTrip,
            lockedPlaceIds: input.lockedPlaceIds,
            diagnostics: Object.freeze({
                budgetTier: input.computationBudget.name,
                startsEvaluated: nearest.startsEvaluated,
                nearestNeighborDurationSeconds: nearestScore.durationSeconds,
                nearestNeighborDistanceMeters: nearestScore.distanceMeters,
                twoOptDurationSeconds: routeResult(twoOpt.route, input).durationSeconds,
                twoOptDistanceMeters: routeResult(twoOpt.route, input).distanceMeters,
                twoOptImprovements: twoOpt.improvements,
                twoOptEvaluations: twoOpt.evaluations,
                twoOptBudgetHit: twoOpt.budgetHit,
                exactEvaluations: exact.evaluations,
                exactCompleted: exact.completed
            })
        });
    }

    function haversineDistanceMeters(from, to) {
        const radians = degrees => degrees * Math.PI / 180;
        const earthRadiusMeters = 6371000;
        const deltaLat = radians(to.lat - from.lat);
        const deltaLng = radians(to.lng - from.lng);
        const left = Math.sin(deltaLat / 2);
        const right = Math.sin(deltaLng / 2);
        const a = left * left + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * right * right;
        return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function estimatedDurationSeconds(distanceMeters, travelMode) {
        const speedsKph = { DRIVING: 50, WALKING: 4.8, BICYCLING: 15, TRANSIT: 30 };
        const mode = String(travelMode ?? 'DRIVING').toUpperCase();
        if (!TRAVEL_MODES.includes(mode)) fail('travelMode 无效');
        return distanceMeters / 1000 / speedsKph[mode] * 3600;
    }

    function createHaversineMatrices(places, travelMode = 'DRIVING') {
        const normalized = normalizePlaces(places);
        const distanceMatrix = [];
        const travelTimeMatrix = [];
        const matrixSources = [];
        normalized.forEach((from, rowIndex) => {
            const distances = [];
            const durations = [];
            const sources = [];
            normalized.forEach((to, columnIndex) => {
                const distance = rowIndex === columnIndex ? 0 : haversineDistanceMeters(from, to);
                distances.push(distance);
                durations.push(rowIndex === columnIndex ? 0 : estimatedDurationSeconds(distance, travelMode));
                sources.push(rowIndex === columnIndex ? 'provider' : 'haversine');
            });
            distanceMatrix.push(distances);
            travelTimeMatrix.push(durations);
            matrixSources.push(sources);
        });
        return { distanceMatrix, travelTimeMatrix, matrixSources };
    }

    function createMatrixAcquisitionPlan(placeCount, options = {}) {
        const count = positiveInteger(placeCount, 1, 5000);
        const providerPairLimit = positiveInteger(options.providerPairLimit, 400, 10000);
        const chunkSize = positiveInteger(options.chunkSize, 5, 5);
        const pairCount = count * count;
        if (pairCount > providerPairLimit) {
            return Object.freeze({
                strategy: 'haversine-budget-fallback',
                pairCount,
                providerPairLimit,
                chunks: Object.freeze([]),
                reason: `${count} 个地点需要 ${pairCount} 个矩阵单元，超过 Provider 预算 ${providerPairLimit}`
            });
        }
        const chunks = [];
        for (let originStart = 0; originStart < count; originStart += chunkSize) {
            for (let destinationStart = 0; destinationStart < count; destinationStart += chunkSize) {
                chunks.push(Object.freeze({
                    originStart,
                    originEnd: Math.min(count, originStart + chunkSize),
                    destinationStart,
                    destinationEnd: Math.min(count, destinationStart + chunkSize)
                }));
            }
        }
        return Object.freeze({
            strategy: 'provider-chunked',
            pairCount,
            providerPairLimit,
            chunks: Object.freeze(chunks),
            reason: null
        });
    }

    return Object.freeze({
        TRAVEL_MODES,
        MATRIX_SOURCES,
        CONSTRAINT_TYPES,
        DEFAULT_BUDGETS,
        RouteOptimizationError,
        normalizeInput,
        computationBudget,
        optimizeRoute,
        createHaversineMatrices,
        createMatrixAcquisitionPlan,
        haversineDistanceMeters,
        estimatedDurationSeconds
    });
});
