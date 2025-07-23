// 旅游规划助手 - Google Maps版本

// 全局变量存储PlaceLabel类，在Google Maps API加载后定义
let PlaceLabel = null;

class TravelPlanner {
    constructor() {
        this.map = null;
        this.markers = [];
        this.travelList = [];
        this.currentLocation = null;
        this.polyline = null;
        this.polylines = []; // 用于存储多彩路线段
        this.isMapLoaded = false;
        this.placesService = null;
        this.geocoder = null;
        this.directionsService = null;
        this.directionsRenderer = null;
        this.distanceMatrixService = null;

        // API调用缓存和优化机制
        this.distanceCache = new Map(); // 距离计算缓存：key: "fromLng,fromLat-toLng,toLat", value: {distance, duration, timestamp}
        this.routeCache = new Map(); // 路线计算缓存：key: "origin-destination", value: {coordinates, distance, duration, timestamp}
        this.searchCache = new Map(); // 搜索结果缓存：key: keyword, value: {results, timestamp}
        this.cacheTimeout = 10 * 60 * 1000; // 缓存10分钟
        this.lastTravelListHash = ''; // 用于检测列表变化的哈希值
        this.calculateDistancesTimeout = null; // 距离计算防抖定时器
        this.isCalculatingDistances = false; // 防止重复计算距离的标志

        // 路线配置：为每个路线段存储交通方式和地图提供商
        this.routeSegments = new Map(); // key: "fromId-toId", value: { travelMode: "DRIVING", mapProvider: "baidu" }

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
            apiKeys: {
                google: '', // Google Maps API密钥
                gaode: '', // 高德地图API密钥
                bing: '' // Bing Maps API密钥
            },
            preferences: {
                openInNewTab: true, // 在新标签页中打开导航
                showNavigationHint: true // 显示导航操作提示
            }
        };

        // 标记状态管理
        this.markersCleared = false;
        this.savedMarkers = []; // 保存被清除的标记信息

        // 当前方案管理
        this.currentSchemeId = null;
        this.currentSchemeName = null;
        this.hasUnsavedChanges = false; // 跟踪是否有未保存的更改
        this.isAutoSaving = false; // 防止自动保存时的递归调用

        // 导入冲突处理状态
        this.pendingImportData = null;
        this.conflictResolutions = new Map(); // 存储冲突解决方案

        // ID生成计数器，确保唯一性
        this.idCounter = 0;

        // 首先加载已保存的设置，然后再初始化应用
        console.log('🏗️ TravelPlanner构造函数被调用');
        this.initializeApp();
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

        // 如果有当前方案，自动保存
        if (this.currentSchemeId && this.currentSchemeName) {
            this.autoSaveCurrentScheme();
        }
    }

    // 自动保存到当前方案
    autoSaveCurrentScheme() {
        if (!this.currentSchemeId || !this.currentSchemeName || this.isAutoSaving) {
            return;
        }

        this.isAutoSaving = true;

        try {
            const schemes = this.getSavedSchemes();
            const currentScheme = schemes.find(s => s.id === this.currentSchemeId);

            if (currentScheme) {
                // 更新方案数据
                currentScheme.travelList = [...this.travelList];
                currentScheme.routeSegments = Array.from(this.routeSegments.entries());
                currentScheme.settings = { ...this.settings };
                currentScheme.placesCount = this.travelList.length;
                currentScheme.modifiedAt = new Date().toISOString();
                currentScheme.version = '2.0';

                // 保存更新后的方案列表
                localStorage.setItem('travelSchemes', JSON.stringify(schemes));

                // 标记为已保存
                this.hasUnsavedChanges = false;
                this.updatePageTitle(); // 更新页面标题

                console.log(`✅ 自动保存方案"${this.currentSchemeName}"成功`);
            }
        } catch (error) {
            console.error('自动保存失败:', error);
        } finally {
            this.isAutoSaving = false;
        }
    }

    // 设置页面关闭时的处理
    setupPageUnloadHandler() {
        window.addEventListener('beforeunload', (e) => {
            // 只有在有未保存更改且没有当前方案时才提醒
            if (this.hasUnsavedChanges && !this.currentSchemeId && this.travelList.length > 0) {
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

    // 初始化应用程序
    initializeApp() {
        console.log('🚀 开始初始化应用程序...');

        // 首先加载保存的设置
        this.loadSavedSettings();
        console.log('📂 设置已加载');

        // 设置页面关闭时的提醒
        this.setupPageUnloadHandler();
        console.log('🔔 页面关闭提醒已设置');

        // 然后检查并初始化地图
        this.waitForMapAPI();
        console.log('🗺️ 地图API检查完成');
    }

    // 加载已保存的设置
    loadSavedSettings() {
        try {
            const saved = localStorage.getItem('travelPlannerData');
            if (saved) {
                const data = JSON.parse(saved);

                // 恢复应用设置
                if (data.settings) {
                    this.settings = { ...this.settings, ...data.settings };

                    // 确保API密钥设置结构完整
                    if (!this.settings.apiKeys) {
                        this.settings.apiKeys = { google: '', gaode: '', bing: '' };
                    }

                    // 确保偏好设置结构完整
                    if (!this.settings.preferences) {
                        this.settings.preferences = {
                            openInNewTab: true,
                            showNavigationHint: true
                        };
                    }

                    // 确保地图API选择设置完整
                    if (!this.settings.selectedMapApi) {
                        this.settings.selectedMapApi = 'google';
                    }

                    console.log('✅ 已加载保存的设置');

                    // 显示API密钥状态
                    const selectedMapApi = this.settings.selectedMapApi;
                    const selectedApiKey = this.settings.apiKeys?.[selectedMapApi];
                    if (selectedApiKey) {
                        console.log(`🔑 检测到已保存的${selectedMapApi} API密钥，将自动应用`);
                    } else {
                        console.log(`⚠️ 未检测到${selectedMapApi} API密钥，将使用演示模式`);
                    }
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
        const apiKey = this.getApiKey(selectedMapApi);

        console.log(`🔍 选择的地图API: ${selectedMapApi}`);
        console.log(`🔑 API密钥状态: ${apiKey ? '已配置' : '未配置'}`);

        if (selectedMapApi === 'google' && apiKey) {
            console.log('🔑 使用Google Maps API作为地图显示服务...');
            this.loadGoogleMapsScript(apiKey);
        } else if (selectedMapApi === 'gaode' && apiKey) {
            console.log('🔑 使用高德地图API作为地图显示服务...');
            this.loadGaodeMapScript(apiKey);
        } else if (selectedMapApi === 'bing' && apiKey) {
            console.log('🔑 使用Bing Maps API作为地图显示服务（暂未实现）...');
            // TODO: 实现Bing Maps API加载
            setTimeout(() => {
                this.initDemoMode();
            }, 1000);
        } else {
            console.log(`⚠️ 未配置${selectedMapApi}API密钥或选择了未支持的API，使用演示模式`);
            console.log(`设置详情:`, this.settings);
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
        script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&callback=initMap`;
        script.async = true;
        script.defer = true;

        script.onload = () => {
            console.log('✅ Google Maps API加载成功');
            // 移除API配置提示横幅（如果存在）
            const banner = document.getElementById('api-config-banner');
            if (banner) {
                document.body.removeChild(banner);
                document.body.style.paddingTop = '0';
            }
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
        script.src = `https://webapi.amap.com/maps?v=2.0&key=${apiKey}&plugin=AMap.Scale,AMap.ToolBar`;
        script.async = true;
        script.defer = true;

        script.onload = () => {
            console.log('✅ 高德地图API脚本加载成功');

            // 等待AMap对象可用，然后初始化应用
            const checkAMap = () => {
                if (typeof AMap !== 'undefined') {
                    console.log('🗺️ AMap对象已可用，初始化应用');

                    // 移除API配置提示横幅
                    const banner = document.getElementById('api-config-banner');
                    if (banner) {
                        document.body.removeChild(banner);
                        document.body.style.paddingTop = '0';
                    }

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
        const hasSelectedApiKey = this.getApiKey(selectedMapApi);

        if (!hasSelectedApiKey) {
            // 添加API配置提示横幅
            const banner = document.createElement('div');
            banner.id = 'api-config-banner';
            banner.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                background: linear-gradient(135deg, #f39c12, #e67e22);
                color: white;
                padding: 12px 20px;
                text-align: center;
                font-size: 14px;
                font-weight: 500;
                z-index: 9999;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                backdrop-filter: blur(10px);
            `;

            // 获取API的中文名称
            const apiNameMap = {
                'google': 'Google Maps',
                'gaode': '高德地图',
                'bing': 'Bing Maps'
            };
            const apiDisplayName = apiNameMap[selectedMapApi] || selectedMapApi;

            banner.innerHTML = `
                🔑 为了获得完整的地图功能，请在设置中配置您的${apiDisplayName} API密钥
                <button id="openApiSettingsBtn" style="
                    margin-left: 15px;
                    padding: 6px 12px;
                    background: rgba(255, 255, 255, 0.2);
                    border: 1px solid rgba(255, 255, 255, 0.3);
                    border-radius: 6px;
                    color: white;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 600;
                    transition: all 0.3s ease;
                " onmouseover="this.style.background='rgba(255, 255, 255, 0.3)'" 
                   onmouseout="this.style.background='rgba(255, 255, 255, 0.2)'">
                    立即配置
                </button>
                <button id="dismissBannerBtn" style="
                    margin-left: 10px;
                    padding: 4px 8px;
                    background: none;
                    border: none;
                    color: rgba(255, 255, 255, 0.8);
                    cursor: pointer;
                    font-size: 16px;
                    font-weight: bold;
                " title="关闭提示">
                    ×
                </button>
            `;

            document.body.appendChild(banner);

            // 调整body的padding，避免内容被横幅遮挡
            document.body.style.paddingTop = '60px';

            // 绑定事件
            document.getElementById('openApiSettingsBtn').addEventListener('click', () => {
                this.showSettingsModal();
            });

            document.getElementById('dismissBannerBtn').addEventListener('click', () => {
                document.body.removeChild(banner);
                document.body.style.paddingTop = '0';
            });
        }
    }

    // 设置事件监听器
    setupEventListeners() {
        console.log('🔧 开始设置事件监听器...');

        // 定期清理过期缓存
        setInterval(() => this.cleanExpiredCache(), 5 * 60 * 1000); // 每5分钟清理一次

        // 搜索相关
        const searchBtn = document.getElementById('searchBtn');
        if (searchBtn) {
            searchBtn.addEventListener('click', () => this.searchPlaces());
            console.log('✅ 搜索按钮事件监听器已设置');
        } else {
            console.error('❌ 找不到搜索按钮元素');
        }
        document.getElementById('searchInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.searchPlaces();
        });

        // 列表控制按钮
        document.getElementById('addBlankPlaceBtn').addEventListener('click', () => this.addBlankPlace());
        document.getElementById('clearAllBtn').addEventListener('click', () => this.clearAllPlaces());
        document.getElementById('optimizeRouteBtn').addEventListener('click', () => this.optimizeRoute());
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

        // 点击模态框外部关闭
        window.addEventListener('click', (e) => {
            const placeModal = document.getElementById('placeModal');
            const saveSchemeModal = document.getElementById('saveSchemeModal');
            const importModal = document.getElementById('importModal');
            const exportModal = document.getElementById('exportModal');
            const settingsModal = document.getElementById('settingsModal');
            const editPlaceModal = document.getElementById('editPlaceModal');

            if (e.target === placeModal) {
                this.closeModal();
            } else if (e.target === saveSchemeModal) {
                this.closeSaveSchemeModal();
            } else if (e.target === importModal) {
                this.closeImportModal();
            } else if (e.target === exportModal) {
                this.closeExportModal();
            } else if (e.target === settingsModal) {
                this.closeSettingsModal();
            } else if (e.target === editPlaceModal) {
                this.closeEditPlaceModal();
            }
        });
    }

    // 设置所有模态框的事件监听器
    setupModalEventListeners() {
        // 地点模态框
        document.querySelector('#placeModal .close').addEventListener('click', () => this.closeModal());
        document.getElementById('addToListBtn').addEventListener('click', () => this.addCurrentPlaceToList());

        // 储存方案模态框
        document.querySelector('#saveSchemeModal .close').addEventListener('click', () => this.closeSaveSchemeModal());
        document.getElementById('saveNewSchemeBtn').addEventListener('click', () => this.saveNewScheme());
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

        // 设置菜单切换
        this.setupSettingsMenuToggle();

        // 编辑游玩点模态框
        document.querySelector('#editPlaceModal .close').addEventListener('click', () => this.closeEditPlaceModal());
        document.getElementById('saveEditBtn').addEventListener('click', () => this.saveEditPlace());
        document.getElementById('cancelEditBtn').addEventListener('click', () => this.closeEditPlaceModal());

        // 移动端紧凑模式
        this.setupMobileCompactMode();
    }

    // 设置移动端紧凑模式
    setupMobileCompactMode() {
        const compactModeBtn = document.getElementById('compactModeBtn');
        const compactToggleFloating = document.getElementById('compactToggleFloating');

        // 检测是否为移动设备
        const isMobile = () => {
            return window.innerWidth <= 768 ||
                /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        };

        // 更新按钮显示状态
        const updateButtonVisibility = () => {
            if (isMobile()) {
                compactModeBtn.style.display = 'inline-block';
            } else {
                compactModeBtn.style.display = 'none';
                // 如果不是移动设备，确保退出紧凑模式
                if (document.body.classList.contains('mobile-compact-mode')) {
                    this.toggleMobileCompactMode(false);
                }
            }
        };

        // 切换紧凑模式
        this.toggleMobileCompactMode = (enable) => {
            if (enable === undefined) {
                enable = !document.body.classList.contains('mobile-compact-mode');
            }

            if (enable) {
                document.body.classList.add('mobile-compact-mode');
                compactModeBtn.classList.add('active');
                compactModeBtn.innerHTML = '✅ 紧凑';
                compactModeBtn.title = '紧凑模式已启用';
                compactToggleFloating.style.display = 'block';

                // 保存紧凑模式状态
                localStorage.setItem('mobileCompactMode', 'true');

                this.showToast('🎯 已启用紧凑模式，获得更多显示空间');
            } else {
                document.body.classList.remove('mobile-compact-mode');
                compactModeBtn.classList.remove('active');
                compactModeBtn.innerHTML = '📱 紧凑';
                compactModeBtn.title = '紧凑模式';
                compactToggleFloating.style.display = 'none';

                // 清除紧凑模式状态
                localStorage.removeItem('mobileCompactMode');

                this.showToast('📱 已退出紧凑模式');
            }
        };

        // 绑定事件监听器
        if (compactModeBtn) {
            compactModeBtn.addEventListener('click', () => {
                this.toggleMobileCompactMode();
            });
        }

        if (compactToggleFloating) {
            compactToggleFloating.addEventListener('click', () => {
                this.toggleMobileCompactMode(false);
            });
        }

        // 窗口大小变化时更新按钮显示
        window.addEventListener('resize', updateButtonVisibility);

        // 初始化时更新按钮显示
        updateButtonVisibility();

        // 恢复之前的紧凑模式状态
        if (isMobile() && localStorage.getItem('mobileCompactMode') === 'true') {
            this.toggleMobileCompactMode(true);
        }
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
                            this.setMap(map);
                        }

                        onAdd() {
                            // 创建标签元素
                            this.div = document.createElement('div');
                            this.div.style.cssText = `
                                position: absolute;
                                background: linear-gradient(135deg, rgba(255,255,255,0.9) 0%, rgba(248,250,252,0.92) 100%);
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
                                transition: opacity 0.2s ease;
                            `;

                            // 分离编号和名称的样式
                            const parts = this.text.split('. ');
                            if (parts.length === 2) {
                                this.div.innerHTML = `
                                    <span style="
                                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                        -webkit-background-clip: text;
                                        -webkit-text-fill-color: transparent;
                                        background-clip: text;
                                        font-weight: 800;
                                        margin-right: 4px;
                                    ">${parts[0]}.</span><span>${parts[1]}</span>
                                `;
                            } else {
                                this.div.textContent = this.text;
                            }

                            // 添加到地图覆盖层
                            const panes = this.getPanes();
                            panes.overlayLayer.appendChild(this.div);
                        }

                        draw() {
                            if (!this.div) return;

                            // 将地理坐标转换为屏幕坐标
                            const overlayProjection = this.getProjection();
                            const position = overlayProjection.fromLatLngToDivPixel(this.position);

                            // 设置标签位置（在标记上方）
                            this.div.style.left = position.x + 'px';
                            this.div.style.top = (position.y - 85) + 'px'; // 在标记上方85px，避免与大头针重叠
                        }

                        onRemove() {
                            if (this.div) {
                                this.div.parentNode.removeChild(this.div);
                                this.div = null;
                            }
                        }

                        hide() {
                            if (this.div) {
                                this.div.style.opacity = '0';
                                this.div.style.pointerEvents = 'none';
                            }
                        }

                        show() {
                            if (this.div) {
                                this.div.style.opacity = '1';
                                this.div.style.pointerEvents = 'auto';
                            }
                        }

                        setText(text) {
                            this.text = text;
                            if (this.div) {
                                const parts = text.split('. ');
                                if (parts.length === 2) {
                                    this.div.innerHTML = `
                                        <span style="
                                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                            -webkit-background-clip: text;
                                            -webkit-text-fill-color: transparent;
                                            background-clip: text;
                                            font-weight: 800;
                                            margin-right: 4px;
                                        ">${parts[0]}.</span><span>${parts[1]}</span>
                                    `;
                                } else {
                                    this.div.textContent = text;
                                }
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

                // 初始化服务
                this.placesService = new google.maps.places.PlacesService(this.map);
                this.geocoder = new google.maps.Geocoder();
                this.directionsService = new google.maps.DirectionsService();
                this.distanceMatrixService = new google.maps.DistanceMatrixService();
                this.directionsRenderer = new google.maps.DirectionsRenderer({
                    draggable: false,
                    suppressMarkers: true // 不显示默认标记
                });
                this.directionsRenderer.setMap(this.map);

                // 地图点击事件
                this.map.addListener('click', (e) => {
                    this.onMapClick(e.latLng.lng(), e.latLng.lat());
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

                // 移除API配置提示横幅（如果存在）
                const banner = document.getElementById('api-config-banner');
                if (banner) {
                    document.body.removeChild(banner);
                    document.body.style.paddingTop = '0';
                }

                // 地图点击事件
                this.map.on('click', (e) => {
                    const lng = e.lnglat.lng;
                    const lat = e.lnglat.lat;
                    this.onMapClick(lng, lat);
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

    // 计算初始地图配置（中心点和缩放级别）
    calculateInitialMapConfig() {
        // 获取当前有效地点（非待定且有坐标）
        const activePlaces = this.travelList.filter(place =>
            !place.isPending && place.lat && place.lng && !place.isBlank
        );

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
            const bounds = this.calculateMapBounds();
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

        // 添加所有标记
        const activePlaces = this.travelList.filter(place => !place.isPending);
        activePlaces.forEach(place => this.addMarker(place));

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

        const activePlaces = this.travelList.filter(place => !place.isPending && place.lat && place.lng && !place.isBlank);

        if (activePlaces.length === 0) {
            console.log('📍 没有有效地点，保持当前地图视野');
            return;
        }

        console.log(`🗺️ 更新地图到当前方案，包含${activePlaces.length}个地点`);

        // 清除现有标记和路线
        this.clearMarkers();

        // 重新添加标记
        activePlaces.forEach(place => this.addMarker(place));

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
        const allPlacesWithCoords = this.travelList.filter(place =>
            place.lat && place.lng && !place.isBlank
        );

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
            'bing': 'Bing Maps'
        };
        const selectedApiName = apiNameMap[selectedMapApi] || selectedMapApi;

        const mapContainer = document.getElementById('mapContainer');
        mapContainer.innerHTML = `
            <div style="height: 100%; display: flex; align-items: center; justify-content: center; background: #f0f0f0; color: #666; flex-direction: column;">
                <h3>🗺️ 演示模式</h3>
                <p>请在设置中配置${selectedApiName}API密钥以启用完整功能</p>
                <p>目前可以使用搜索和列表功能</p>
                <button onclick="app.showSettingsModal()" style="margin-top: 15px; padding: 10px 20px; background: #667eea; color: white; border: none; border-radius: 5px; cursor: pointer;">打开设置配置API</button>
            </div>
        `;
        this.isMapLoaded = false;
    }

    // 显示API帮助信息
    showApiHelp() {
        alert('获取Google地图API密钥的步骤：\\n\\n1. 访问 https://console.cloud.google.com/\\n2. 创建或选择一个项目\\n3. 启用以下API：\\n   - Maps JavaScript API\\n   - Places API\\n   - Geocoding API\\n4. 创建API密钥\\n5. 在HTML中替换"您的Google地图API密钥"\\n\\n注意：Google Maps API需要绑定信用卡，但有免费额度\\n\\n完成后刷新页面即可使用完整功能！');
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
        if (this.geocoder) {
            this.geocoder.geocode({
                location: { lat: lat, lng: lng }
            }, (results, status) => {
                if (status === 'OK' && results[0]) {
                    callback({
                        name: this.extractPlaceName(results[0]) || '位置点',
                        address: results[0].formatted_address
                    });
                } else {
                    callback({
                        name: '位置点',
                        address: `${lng.toFixed(6)}, ${lat.toFixed(6)}`
                    });
                }
            });
        } else {
            callback({
                name: '演示地点',
                address: `经度: ${lng.toFixed(6)}, 纬度: ${lat.toFixed(6)}`
            });
        }
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

    // 搜索地点
    searchPlaces() {
        const keyword = document.getElementById('searchInput').value.trim();
        if (!keyword) return;

        const resultsContainer = document.getElementById('searchResults');
        resultsContainer.innerHTML = '<div style="padding: 10px; text-align: center; color: #666;">搜索中...</div>';

        const selectedMapApi = this.settings.selectedMapApi;
        console.log(`🔍 开始搜索 - API: ${selectedMapApi}, 关键字: ${keyword}`);
        console.log('🔍 当前设置:', this.settings);

        // 详细的API状态检查
        console.log('🔍 API状态检查:');
        console.log('  - selectedMapApi:', selectedMapApi);
        console.log('  - typeof AMap:', typeof AMap);
        console.log('  - this.placesService:', !!this.placesService);
        console.log('  - 高德API密钥:', this.getApiKey('gaode') ? '已配置' : '未配置');

        if (selectedMapApi === 'google' && this.placesService) {
            console.log('✅ 使用Google Places API搜索');
            this.searchWithGoogle(keyword);
        } else if (selectedMapApi === 'gaode') {
            console.log('🗺️ 使用高德Web服务API搜索');
            this.searchWithGaode(keyword);
        } else if (selectedMapApi === 'bing') {
            console.log('🌐 使用Bing搜索（暂未实现）');
            this.searchWithBing(keyword);
        } else {
            console.warn('⚠️ 当前地图API不支持搜索或未加载，使用演示模式');
            console.warn('  原因：selectedMapApi =', selectedMapApi, ', this.placesService =', !!this.placesService);
            this.searchDemo(keyword);
        }
    }

    // 使用Google Places API搜索
    searchWithGoogle(keyword) {
        const request = {
            query: keyword,
            fields: ['place_id', 'name', 'formatted_address', 'geometry']
        };

        this.placesService.textSearch(request, (results, status) => {
            if (status === google.maps.places.PlacesServiceStatus.OK && results.length > 0) {
                const places = results.slice(0, 10).map(place => ({
                    name: place.name,
                    address: place.formatted_address,
                    lng: place.geometry.location.lng(),
                    lat: place.geometry.location.lat()
                }));
                this.displaySearchResults(places);
            } else {
                this.displaySearchResults([]);
            }
        });
    }

    // 使用高德地图Web服务API搜索
    searchWithGaode(keyword) {
        console.log('🗺️ 使用高德地图Web服务API搜索...', keyword);

        // 检查API密钥
        const apiKey = this.getApiKey('gaode');
        console.log('🔑 高德API密钥状态:', apiKey ? '已配置' : '❌ 未配置');

        if (!apiKey) {
            console.error('❌ 高德地图API密钥未配置，无法进行搜索');
            this.displaySearchResults([]);
            return;
        }

        // 使用Web服务API进行搜索
        this.searchWithGaodeWebAPI(keyword, apiKey);
    }

    // 使用高德Web服务API进行搜索（带缓存优化）
    async searchWithGaodeWebAPI(keyword, apiKey) {
        try {
            // 检查缓存
            const cachedResults = this.getCachedSearchResult(keyword);
            if (cachedResults) {
                this.displaySearchResults(cachedResults);
                return;
            }

            console.log('🌐 调用高德Web服务API...');

            // 构建请求URL
            const searchUrl = 'https://restapi.amap.com/v3/place/text';
            const params = new URLSearchParams({
                key: apiKey,
                keywords: keyword,
                offset: '10',  // 返回结果数量
                page: '1',     // 页码
                extensions: 'all'  // 返回详细信息
            });

            const requestUrl = `${searchUrl}?${params.toString()}`;
            console.log('🔗 请求URL:', requestUrl);

            // 发送请求
            const response = await fetch(requestUrl);
            console.log('📡 HTTP响应状态:', response.status, response.statusText);

            if (!response.ok) {
                throw new Error(`HTTP错误: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            console.log('📦 API响应数据:', data);

            // 处理响应
            if (data.status === '1') {
                console.log('✅ 搜索成功');

                if (data.pois && data.pois.length > 0) {
                    console.log('✅ 找到POI数据，数量:', data.pois.length);

                    const places = data.pois.map((poi, index) => {
                        console.log(`🔍 处理POI ${index + 1}:`, poi);

                        // 构建完整地址
                        let address = '';
                        if (poi.pname) address += poi.pname;
                        if (poi.cityname) address += poi.cityname;
                        if (poi.adname) address += poi.adname;
                        if (poi.address) address += poi.address;

                        // 解析坐标（Web服务API返回的是字符串格式："lng,lat"）
                        const [lng, lat] = poi.location.split(',').map(Number);

                        const place = {
                            name: poi.name || '未知地点',
                            address: address || '地址未知',
                            lng: lng || 0,
                            lat: lat || 0
                        };

                        console.log(`🔍 转换后的地点 ${index + 1}:`, place);
                        return place;
                    }).filter(place => place.lng && place.lat);

                    console.log('✅ 最终结果数量:', places.length);

                    // 缓存搜索结果
                    this.cacheSearchResult(keyword, places);

                    this.displaySearchResults(places);
                } else {
                    console.log('📭 搜索成功但无结果');
                    this.displaySearchResults([]);
                }
            } else {
                console.error('❌ API返回错误:', data.info || '未知错误');
                console.error('❌ 错误代码:', data.infocode);
                this.displaySearchResults([]);
            }

        } catch (error) {
            console.error('❌ 调用高德Web服务API时出错:', error);
            console.error('❌ 错误堆栈:', error.stack);

            // 检查是否是跨域问题
            if (error.message.includes('CORS') || error.message.includes('network')) {
                console.warn('⚠️ 可能遇到跨域问题，尝试使用JSONP方式...');
                this.searchWithGaodeJSONP(keyword, apiKey);
            } else {
                this.displaySearchResults([]);
            }
        }
    }

    // 使用JSONP方式调用高德API（解决跨域问题）
    searchWithGaodeJSONP(keyword, apiKey) {
        console.log('🔄 使用JSONP方式调用高德API...');

        const callbackName = `gaodeCallback_${Date.now()}`;

        // 创建全局回调函数
        window[callbackName] = (data) => {
            console.log('📦 JSONP响应数据:', data);

            try {
                if (data.status === '1') {
                    if (data.pois && data.pois.length > 0) {
                        const places = data.pois.map(poi => {
                            const [lng, lat] = poi.location.split(',').map(Number);
                            return {
                                name: poi.name || '未知地点',
                                address: (poi.pname || '') + (poi.cityname || '') + (poi.adname || '') + (poi.address || '') || '地址未知',
                                lng: lng || 0,
                                lat: lat || 0
                            };
                        }).filter(place => place.lng && place.lat);

                        console.log('✅ JSONP搜索成功，结果数量:', places.length);
                        this.displaySearchResults(places);
                    } else {
                        console.log('📭 JSONP搜索成功但无结果');
                        this.displaySearchResults([]);
                    }
                } else {
                    console.error('❌ JSONP API返回错误:', data.info);
                    this.displaySearchResults([]);
                }
            } catch (error) {
                console.error('❌ 处理JSONP响应时出错:', error);
                this.displaySearchResults([]);
            } finally {
                // 清理
                delete window[callbackName];
                document.head.removeChild(script);
            }
        };

        // 创建script标签
        const script = document.createElement('script');
        const params = new URLSearchParams({
            key: apiKey,
            keywords: keyword,
            offset: '10',
            page: '1',
            extensions: 'all',
            callback: callbackName
        });

        script.src = `https://restapi.amap.com/v3/place/text?${params.toString()}`;
        script.onerror = () => {
            console.error('❌ JSONP请求失败');
            delete window[callbackName];
            document.head.removeChild(script);
            this.displaySearchResults([]);
        };

        document.head.appendChild(script);
    }

    // 测试高德地图Web服务API是否正常工作
    async testGaodeAPI() {
        console.log('🧪 === 测试高德地图Web服务API ===');

        const apiKey = this.getApiKey('gaode');
        if (!apiKey) {
            console.error('❌ 高德API密钥未配置');
            return false;
        }

        console.log('🔑 API密钥状态: 已配置');

        try {
            const testUrl = `https://restapi.amap.com/v3/place/text?key=${apiKey}&keywords=北京&offset=1`;
            console.log('🔗 测试URL:', testUrl);

            const response = await fetch(testUrl);
            console.log('📡 HTTP状态:', response.status);

            const data = await response.json();
            console.log('📦 测试响应:', data);

            if (data.status === '1') {
                console.log('✅ 高德Web服务API测试成功！');
                return true;
            } else {
                console.error('❌ API返回错误:', data.info);
                return false;
            }
        } catch (error) {
            console.error('❌ 测试API时出错:', error);

            // 如果fetch失败，尝试JSONP测试
            console.log('🔄 尝试JSONP测试...');
            return this.testGaodeAPIWithJSONP(apiKey);
        }
    }

    // 使用JSONP测试高德API
    testGaodeAPIWithJSONP(apiKey) {
        return new Promise((resolve) => {
            const callbackName = `testCallback_${Date.now()}`;

            window[callbackName] = (data) => {
                console.log('📦 JSONP测试响应:', data);

                if (data.status === '1') {
                    console.log('✅ 高德Web服务API (JSONP) 测试成功！');
                    resolve(true);
                } else {
                    console.error('❌ JSONP API返回错误:', data.info);
                    resolve(false);
                }

                // 清理
                delete window[callbackName];
                document.head.removeChild(script);
            };

            const script = document.createElement('script');
            script.src = `https://restapi.amap.com/v3/place/text?key=${apiKey}&keywords=北京&offset=1&callback=${callbackName}`;
            script.onerror = () => {
                console.error('❌ JSONP测试失败');
                delete window[callbackName];
                document.head.removeChild(script);
                resolve(false);
            };

            document.head.appendChild(script);
        });
    }

    // 使用Bing地图搜索（暂未实现）
    searchWithBing(keyword) {
        console.log('🌐 Bing地图搜索暂未实现，使用演示模式');
        this.searchDemo(keyword);
    }

    // 演示搜索功能
    searchDemo(keyword) {
        console.log('🎭 使用演示搜索模式');
        // 模拟真实的搜索结果
        const demoResults = [
            { name: `${keyword}博物馆`, address: '北京市东城区王府井大街1号', lng: 116.397428, lat: 39.90923 },
            { name: `${keyword}公园`, address: '北京市朝阳区朝阳路88号', lng: 116.407428, lat: 39.91923 },
            { name: `${keyword}购物中心`, address: '北京市海淀区中关村大街2号', lng: 116.387428, lat: 39.89923 },
            { name: `${keyword}美食街`, address: '北京市西城区德胜门内大街102号', lng: 116.377428, lat: 39.88923 },
            { name: `${keyword}艺术馆`, address: '北京市丰台区南四环西路188号', lng: 116.367428, lat: 39.87923 }
        ];

        setTimeout(() => {
            this.displaySearchResults(demoResults);
        }, 500);
    }

    // 显示搜索结果
    displaySearchResults(results) {
        const resultsContainer = document.getElementById('searchResults');

        if (results.length === 0) {
            resultsContainer.innerHTML = '<div style="padding: 10px; text-align: center; color: #666;">未找到相关地点</div>';
            return;
        }

        resultsContainer.innerHTML = results.map(place => `
            <div class="search-result-item" data-lng="${place.lng}" data-lat="${place.lat}" data-name="${place.name}" data-address="${place.address}">
                <div class="search-result-name">${place.name}</div>
                <div class="search-result-address">${place.address}</div>
            </div>
        `).join('');

        // 添加点击事件
        resultsContainer.querySelectorAll('.search-result-item').forEach(item => {
            item.addEventListener('click', () => {
                const placeData = {
                    name: item.dataset.name,
                    address: item.dataset.address,
                    lng: parseFloat(item.dataset.lng),
                    lat: parseFloat(item.dataset.lat)
                };

                this.showPlaceModal(placeData);
                if (this.isMapLoaded) {
                    this.map.setCenter({ lat: placeData.lat, lng: placeData.lng });
                    this.map.setZoom(15);
                }
            });
        });
    }

    // 显示地点详情模态框
    showPlaceModal(place) {
        this.currentPlace = place;
        document.getElementById('placeName').textContent = place.name;
        document.getElementById('placeAddress').textContent = place.address;
        document.getElementById('placeModal').style.display = 'block';
    }

    // 关闭模态框
    closeModal() {
        document.getElementById('placeModal').style.display = 'none';
    }

    // 显示储存方案模态框
    showSaveSchemeModal() {
        document.getElementById('saveSchemeModal').style.display = 'block';
        this.loadSavedSchemes();
        document.getElementById('schemeNameInput').value = '';

        // 重置警告信息和按钮状态
        document.getElementById('schemeNameWarning').style.display = 'none';
        document.getElementById('saveNewSchemeBtn').disabled = true;

        document.getElementById('schemeNameInput').focus();
    }

    // 关闭储存方案模态框
    closeSaveSchemeModal() {
        document.getElementById('saveSchemeModal').style.display = 'none';
    }

    // 显示导出模态框
    showExportModal() {
        if (this.travelList.length === 0) {
            this.showToast('请先添加一些游玩地点再导出');
            return;
        }
        document.getElementById('exportModal').style.display = 'block';
    }

    // 显示导入模态框
    showImportModal() {
        document.getElementById('importModal').style.display = 'block';
    }

    // 关闭导入模态框
    closeImportModal() {
        document.getElementById('importModal').style.display = 'none';
        // 重置文件输入
        document.getElementById('fileInput').value = '';
        document.getElementById('fileDropZone').classList.remove('dragover');
    }

    // 关闭导出模态框
    closeExportModal() {
        document.getElementById('exportModal').style.display = 'none';
    }

    // 显示设置模态框
    showSettingsModal() {
        // 加载当前设置到界面
        this.loadSettingsToUI();
        document.getElementById('settingsModal').style.display = 'block';
    }

    // 关闭设置模态框
    closeSettingsModal() {
        document.getElementById('settingsModal').style.display = 'none';
    }

    // 加载设置到界面
    loadSettingsToUI() {
        // 加载地图API选择
        const mapApiRadioButton = document.querySelector(`input[name="selectedMapApi"][value="${this.settings.selectedMapApi}"]`);
        if (mapApiRadioButton) {
            mapApiRadioButton.checked = true;
        }

        // 加载导航应用选择
        const radioButton = document.querySelector(`input[name="navigationApp"][value="${this.settings.navigationApp}"]`);
        if (radioButton) {
            radioButton.checked = true;
        }

        // 加载API密钥
        if (this.settings.apiKeys) {
            const googleInput = document.getElementById('googleApiKeyInput');
            const gaodeInput = document.getElementById('gaodeApiKeyInput');
            const bingInput = document.getElementById('bingApiKeyInput');

            if (googleInput) googleInput.value = this.settings.apiKeys.google || '';
            if (gaodeInput) gaodeInput.value = this.settings.apiKeys.gaode || '';
            if (bingInput) bingInput.value = this.settings.apiKeys.bing || '';
        }

        // 加载导航偏好设置
        if (this.settings.preferences) {
            const openInNewTabCheckbox = document.getElementById('openInNewTab');
            const showNavigationHintCheckbox = document.getElementById('showNavigationHint');

            if (openInNewTabCheckbox) {
                openInNewTabCheckbox.checked = this.settings.preferences.openInNewTab !== false;
            }
            if (showNavigationHintCheckbox) {
                showNavigationHintCheckbox.checked = this.settings.preferences.showNavigationHint !== false;
            }
        }
    }

    // 保存设置
    saveSettings() {
        // 在更新设置之前，先记录当前的API密钥和地图API选择
        const currentGoogleApiKey = this.getApiKey('google');
        const currentSelectedMapApi = this.settings.selectedMapApi;

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

        // 保存API密钥
        const googleInput = document.getElementById('googleApiKeyInput');
        const gaodeInput = document.getElementById('gaodeApiKeyInput');
        const bingInput = document.getElementById('bingApiKeyInput');

        if (!this.settings.apiKeys) {
            this.settings.apiKeys = {};
        }

        if (googleInput) this.settings.apiKeys.google = googleInput.value.trim();
        if (gaodeInput) this.settings.apiKeys.gaode = gaodeInput.value.trim();
        if (bingInput) this.settings.apiKeys.bing = bingInput.value.trim();

        // 保存导航偏好设置
        const openInNewTabCheckbox = document.getElementById('openInNewTab');
        const showNavigationHintCheckbox = document.getElementById('showNavigationHint');

        if (!this.settings.preferences) {
            this.settings.preferences = {};
        }

        if (openInNewTabCheckbox) {
            this.settings.preferences.openInNewTab = openInNewTabCheckbox.checked;
        }
        if (showNavigationHintCheckbox) {
            this.settings.preferences.showNavigationHint = showNavigationHintCheckbox.checked;
        }

        // 保存到本地存储
        this.saveData();

        // 检查地图API相关变化
        const newGoogleApiKey = this.settings.apiKeys.google;
        const newSelectedMapApi = this.settings.selectedMapApi;

        // 检查是否需要重新加载地图
        const needsReload = (
            // API密钥变化
            newGoogleApiKey !== currentGoogleApiKey ||
            // 地图API选择变化
            newSelectedMapApi !== currentSelectedMapApi ||
            // 选择了Google但之前没有加载Google Maps
            (newSelectedMapApi === 'google' && newGoogleApiKey && typeof google === 'undefined') ||
            // 移除了API密钥但还在使用该API
            (!newGoogleApiKey && newSelectedMapApi === 'google' && typeof google !== 'undefined')
        );

        if (needsReload) {
            if (newSelectedMapApi === 'google' && newGoogleApiKey) {
                if (typeof google === 'undefined') {
                    // 需要加载Google Maps
                    this.showToast('设置已保存，正在加载Google Maps...');
                    setTimeout(() => {
                        // 移除API配置提示横幅
                        const banner = document.getElementById('api-config-banner');
                        if (banner) {
                            document.body.removeChild(banner);
                            document.body.style.paddingTop = '0';
                        }
                        // 加载Google Maps
                        this.loadGoogleMapsScript(newGoogleApiKey);
                    }, 1000);
                } else {
                    // 已经有Google Maps，但API密钥或设置变了，需要重新加载
                    this.showToast('设置已保存，配置已更新，页面将刷新以应用新配置...');
                    setTimeout(() => {
                        window.location.reload();
                    }, 2000);
                }
            } else {
                // 选择了其他API或移除了配置，需要刷新页面
                this.showToast('设置已保存，页面将刷新以应用更改...');
                setTimeout(() => {
                    window.location.reload();
                }, 2000);
            }
        } else {
            this.showToast('设置已保存');
        }

        this.closeSettingsModal();
    }

    // 获取API密钥
    getApiKey(provider) {
        console.log(`🔍 获取API密钥 - 提供商: ${provider}`);
        console.log(`📋 当前设置:`, this.settings);

        if (!this.settings.apiKeys) {
            console.log('❌ 没有apiKeys配置');
            return null;
        }

        console.log(`🔑 apiKeys配置:`, this.settings.apiKeys);

        let apiKey = null;
        switch (provider) {
            case 'google':
                apiKey = this.settings.apiKeys.google || null;
                break;
            case 'gaode':
                apiKey = this.settings.apiKeys.gaode || null;
                break;
            case 'bing':
                apiKey = this.settings.apiKeys.bing || null;
                break;
            default:
                apiKey = null;
        }

        console.log(`🔑 ${provider} API密钥: ${apiKey ? '已配置' : '未配置'}`);
        return apiKey;
    }

    // 设置菜单切换功能
    setupSettingsMenuToggle() {
        const menuItems = document.querySelectorAll('.settings-menu-item');

        menuItems.forEach(item => {
            item.addEventListener('click', () => {
                // 移除所有活动状态
                menuItems.forEach(i => i.classList.remove('active'));
                document.querySelectorAll('.settings-panel').forEach(panel => {
                    panel.classList.remove('active');
                });

                // 激活当前菜单项
                item.classList.add('active');

                // 显示对应面板
                const panelId = item.dataset.panel + 'Panel';
                const targetPanel = document.getElementById(panelId);
                if (targetPanel) {
                    targetPanel.classList.add('active');
                }

                // 如果切换到版本详情面板，更新版本信息
                if (item.dataset.panel === 'version') {
                    this.updateVersionInfo();
                }
            });
        });
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
            let html = '';
            let currentVersion = '';
            let versionItems = [];

            versionHistory.forEach((item, index) => {
                const changeTypeClass = item.type === 'feature' ? 'feature' :
                    item.type === 'fix' ? 'fix' : 'optimize';
                const changeTypeText = item.type === 'feature' ? '新增' :
                    item.type === 'fix' ? '修复' : '优化';

                // 统一处理：收集同一版本的所有更新项
                if (currentVersion !== item.version) {
                    // 如果之前有版本项目，先输出它们
                    if (versionItems.length > 0) {
                        html += this.generateVersionHtml(currentVersion, versionItems);
                        versionItems = [];
                    }
                    currentVersion = item.version;
                }

                versionItems.push({
                    type: item.type,
                    text: item.text,
                    changeTypeClass: changeTypeClass,
                    changeTypeText: changeTypeText
                });

                // 如果这是最后一项，或者下一项是不同版本
                const nextItem = versionHistory[index + 1];
                if (!nextItem || nextItem.version !== item.version) {
                    html += this.generateVersionHtml(currentVersion, versionItems);
                    versionItems = [];
                    currentVersion = '';
                }
            });

            versionListElement.innerHTML = html;
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
                    { message: '新增设备类型智能检测，自动选择最优导航策略', type: 'feature' }
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
                    { message: '新增消息简化系统，紧凑模式下显示更简短的提示', type: 'feature' },
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

    // 生成版本更新的统一HTML
    generateVersionHtml(version, versionItems) {
        if (versionItems.length === 0) return '';

        let changesHtml = '';
        versionItems.forEach(item => {
            changesHtml += `
                <div class="version-changes">
                    <span class="change-type ${item.changeTypeClass}">${item.changeTypeText}</span>
                    <span class="change-text">${item.text}</span>
                </div>
            `;
        });

        const isMultiple = versionItems.length > 1;
        const versionClass = isMultiple ? 'version-item multiple-updates' : 'version-item single-update';
        const indicator = isMultiple ? `<span class="update-indicator">${versionItems.length}项更新</span>` : '';

        return `
            <div class="${versionClass}">
                <div class="version-header">
                    <span class="version-number">${version}</span>
                    ${indicator}
                </div>
                <div class="version-content">
                    ${changesHtml}
                </div>
            </div>
        `;
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

        // 显示模态框
        document.getElementById('editPlaceModal').style.display = 'block';
    }

    // 关闭编辑游玩点模态框
    closeEditPlaceModal() {
        document.getElementById('editPlaceModal').style.display = 'none';
        this.currentEditPlace = null;

        // 清空表单
        document.getElementById('customNameInput').value = '';
        document.getElementById('notesInput').value = '';
    }

    // 保存编辑的游玩点
    saveEditPlace() {
        if (!this.currentEditPlace) return;

        const customName = document.getElementById('customNameInput').value.trim();
        const notes = document.getElementById('notesInput').value.trim();

        // 更新游玩点信息
        this.currentEditPlace.customName = customName || null;
        this.currentEditPlace.notes = notes || null;

        // 更新显示（不重新计算距离）
        this.updateTravelListWithoutRecalculation();
        this.recreateMarkers(); // 重新创建标记以更新名称
        this.saveData();
        this.markAsModified(); // 标记为已修改

        // 关闭模态框
        this.closeEditPlaceModal();

        // 显示成功提示
        const displayName = customName || this.currentEditPlace.name;
        this.showToast(`已更新游玩点：${displayName}`);
    }

    // 切换游玩点状态（游玩 ↔ 待定）
    togglePlaceStatus(placeId) {
        const place = this.travelList.find(p => p.id.toString() === placeId);
        if (!place) return;

        const displayName = place.customName || place.name;

        // 切换状态
        place.isPending = !place.isPending;

        // 重新排序：激活的地点移到游玩列表最后，待定的地点移到待定列表最后
        if (place.isPending) {
            // 移至待定状态 - 将其移到列表最后
            const index = this.travelList.indexOf(place);
            this.travelList.splice(index, 1);
            this.travelList.push(place);
            this.showToast(`"${displayName}" 已移至待定列表`);
        } else {
            // 激活状态 - 将其插入到所有激活地点的最后
            const index = this.travelList.indexOf(place);
            this.travelList.splice(index, 1);

            // 找到最后一个非待定地点的位置
            let insertIndex = 0;
            for (let i = 0; i < this.travelList.length; i++) {
                if (!this.travelList[i].isPending) {
                    insertIndex = i + 1;
                }
            }
            this.travelList.splice(insertIndex, 0, place);
            this.showToast(`"${displayName}" 已加入游玩列表`);
        }

        // 更新显示和相关计算
        this.updateTravelList();
        this.calculateDistancesWithDebounce();
        this.drawRoute();

        // 如果当前显示待定点，需要重新创建待定点标记
        if (this.showPendingPlaces) {
            this.createPendingMarkers();
        }

        this.saveData();
        this.markAsModified(); // 标记为已修改
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

        this.travelList.push(newPlace);

        this.updateTravelList();
        this.calculateDistancesWithDebounce();
        this.drawRoute(); // 添加地点后重新绘制路线
        this.closeModal();
        this.saveData();
        this.markAsModified(); // 标记为已修改
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

        // 将空白地点添加到游玩列表的最上方（数组开头）
        this.travelList.unshift(blankPlace);

        // 只更新显示，不重新计算距离或绘制路线
        this.updateTravelListWithoutRecalculation();
        this.saveData();
        this.markAsModified(); // 标记为已修改

        this.showToast('已添加空白游玩点，请编辑名称和备注');

        // 自动打开编辑模态框
        setTimeout(() => {
            this.editPlace(blankPlace.id.toString());
        }, 100);
    }

    // 更新游玩列表显示
    updateTravelList() {
        // 分离游玩中和待定的地点
        const activePlaces = this.travelList.filter(place => !place.isPending);
        const pendingPlaces = this.travelList.filter(place => place.isPending);

        // 更新游玩列表
        this.updateActiveList(activePlaces);

        // 更新待定列表
        this.updatePendingList(pendingPlaces);

        this.setupDragAndDrop();

        // 重新创建所有标记（只为激活的地点）
        this.recreateMarkers();

        // 刷新城市过滤按钮状态
        this.updateCityFilterButton();
    }

    // 更新游玩列表显示（不触发距离重新计算）
    updateTravelListWithoutRecalculation() {
        // 分离游玩中和待定的地点
        const activePlaces = this.travelList.filter(place => !place.isPending);
        const pendingPlaces = this.travelList.filter(place => place.isPending);

        // 更新游玩列表（保留现有距离信息）
        this.updateActiveListWithoutRecalculation(activePlaces);

        // 更新待定列表
        this.updatePendingList(pendingPlaces);

        this.setupDragAndDrop();

        // 重新创建所有标记（只为激活的地点）
        this.recreateMarkers();

        // 刷新城市过滤按钮状态
        this.updateCityFilterButton();
    }

    // 更新游玩列表（激活状态的地点，保留现有距离信息）
    updateActiveListWithoutRecalculation(activePlaces) {
        const listContainer = document.getElementById('travelList');

        if (activePlaces.length === 0) {
            listContainer.innerHTML = '<li style="text-align: center; color: #666; padding: 20px;">暂无游玩地点</li>';
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

        let htmlContent = '';
        let nonBlankIndex = 0; // 非空白地点的序号计数器

        activePlaces.forEach((place, index) => {
            // 如果不是第一个地点，先显示距离信息
            if (index > 0) {
                // 找到前一个非空白地点来计算距离
                let prevNonBlankPlace = null;
                for (let i = index - 1; i >= 0; i--) {
                    if (activePlaces[i].lat && activePlaces[i].lng && !activePlaces[i].isBlank) {
                        prevNonBlankPlace = activePlaces[i];
                        break;
                    }
                }

                const hasCoordinates = place.lat && place.lng && prevNonBlankPlace && prevNonBlankPlace.lat && prevNonBlankPlace.lng;

                if (hasCoordinates && !place.isBlank) {
                    // 显示到前一个非空白地点的距离
                    const segmentKey = `${prevNonBlankPlace.id}-${place.id}`;
                    const segmentConfig = this.routeSegments.get(segmentKey) || { mapProvider: 'amap' };

                    // 确保新路线段使用高德地图作为默认
                    if (!this.routeSegments.has(segmentKey)) {
                        this.routeSegments.set(segmentKey, { mapProvider: 'amap' });
                    }

                    // 使用保存的距离信息或默认显示
                    const distanceText = existingDistances[place.id] || '保持原值';
                    const durationText = existingDurations[place.id] || '保持原值';

                    htmlContent += `
                        <li class="route-segment">
                            <div class="route-connector">
                                <div class="route-line"></div>
                                <div class="route-info-card compact">
                                    <div class="route-info">
                                        <span class="distance-info">🚗 <span id="distance-${place.id}">${distanceText}</span></span>
                                        <span class="duration-info">⏱️ <span id="duration-${place.id}">${durationText}</span></span>
                                    </div>
                                    <button class="navigate-btn compact" onclick="app.openNavigationRoute('${segmentKey}', ${index - 1}, ${index})" title="打开导航">
                                        🧭
                                    </button>
                                </div>
                            </div>
                        </li>
                    `;
                } else if (place.isBlank || !hasCoordinates) {
                    // 空白地点或无坐标地点显示简单的分隔线
                    htmlContent += `
                        <li class="route-segment">
                            <div class="route-connector">
                                <div class="route-line no-coordinates"></div>
                                <div class="route-info-card compact disabled">
                                    <div class="route-info">
                                        <span class="distance-info">📍 ${place.isBlank ? '空白地点' : '无地理信息'}</span>
                                    </div>
                                </div>
                            </div>
                        </li>
                    `;
                }
            }

            // 然后显示地点信息
            const displayName = place.customName || place.name;
            const escapedCustomName = (place.customName || '').replace(/'/g, "\\'");
            const escapedOriginalName = place.name.replace(/'/g, "\\'");

            // 只为非空白地点分配序号
            let displayOrder = '';
            if (!place.isBlank) {
                nonBlankIndex++;
                displayOrder = nonBlankIndex;
            } else {
                displayOrder = '✏️'; // 空白地点显示编辑图标
            }

            htmlContent += `
                <li class="travel-item ${place.isBlank ? 'blank-item' : ''}" draggable="true" data-id="${place.id}">
                    <div class="travel-item-header">
                        <div class="travel-item-left">
                            <span class="drag-handle">⠿</span>
                            <span class="travel-item-order">${displayOrder}</span>
                            <span class="travel-item-name">${displayName}</span>
                        </div>
                    </div>
                    <div class="travel-item-address">📮 ${place.address}</div>
                    ${place.notes ? `<div class="travel-item-notes">${place.notes}</div>` : ''}
                    <div class="travel-item-actions">
                        <button class="activate-btn" onclick="app.togglePlaceStatus('${place.id}')" title="移至待定">🎯 游玩</button>
                        ${place.lat && place.lng ? `<button class="action-btn locate-btn" onclick="app.locatePlace(${place.lng}, ${place.lat})" title="在地图上定位">📍</button>` : ''}
                        ${place.lat && place.lng ? `<button class="action-btn show-in-map-btn" onclick="app.showInMap(${place.lng}, ${place.lat}, '${displayName.replace(/'/g, "\\'")}')" title="在导航中显示">🗺️</button>` : ''}
                        ${place.lat && place.lng ? `<button class="action-btn navigate-to-btn" onclick="app.navigateToPlace(${place.lng}, ${place.lat}, '${displayName.replace(/'/g, "\\'")}')" title="导航到此处">🧭</button>` : ''}
                        <button class="action-btn edit-btn" onclick="app.editPlace('${place.id}')" title="编辑游玩点">✏️</button>
                        <button class="action-btn copy-btn" onclick="app.copyPlaceName('${escapedCustomName || escapedOriginalName}')" title="复制名称">📋</button>
                        <button class="action-btn copy-btn" onclick="app.copyPlaceAddress('${place.address.replace(/'/g, "\\'")}')" title="复制地址">📄</button>
                        <button class="action-btn" onclick="app.removePlaceFromList('${place.id}')" title="删除">✕</button>
                    </div>
                </li>
            `;
        });

        listContainer.innerHTML = htmlContent;
    }

    // 更新游玩列表（激活状态的地点）
    updateActiveList(activePlaces) {
        const listContainer = document.getElementById('travelList');

        if (activePlaces.length === 0) {
            listContainer.innerHTML = '<li style="text-align: center; color: #666; padding: 20px;">暂无游玩地点</li>';
            return;
        }

        let htmlContent = '';
        let nonBlankIndex = 0; // 非空白地点的序号计数器

        activePlaces.forEach((place, index) => {
            // 如果不是第一个地点，先显示距离信息
            if (index > 0) {
                // 找到前一个非空白地点来计算距离
                let prevNonBlankPlace = null;
                for (let i = index - 1; i >= 0; i--) {
                    if (activePlaces[i].lat && activePlaces[i].lng && !activePlaces[i].isBlank) {
                        prevNonBlankPlace = activePlaces[i];
                        break;
                    }
                }

                const hasCoordinates = place.lat && place.lng && prevNonBlankPlace && prevNonBlankPlace.lat && prevNonBlankPlace.lng;

                if (hasCoordinates && !place.isBlank) {
                    // 显示到前一个非空白地点的距离
                    const segmentKey = `${prevNonBlankPlace.id}-${place.id}`;
                    const segmentConfig = this.routeSegments.get(segmentKey) || { mapProvider: 'amap' };

                    // 确保新路线段使用高德地图作为默认
                    if (!this.routeSegments.has(segmentKey)) {
                        this.routeSegments.set(segmentKey, { mapProvider: 'amap' });
                    }

                    htmlContent += `
                        <li class="route-segment">
                            <div class="route-connector">
                                <div class="route-line"></div>
                                <div class="route-info-card compact">
                                    <div class="route-info">
                                        <span class="distance-info">🚗 <span id="distance-${place.id}">计算中...</span></span>
                                        <span class="duration-info">⏱️ <span id="duration-${place.id}">计算中...</span></span>
                                    </div>
                                    <button class="navigate-btn compact" onclick="app.openNavigationRoute('${segmentKey}', ${index - 1}, ${index})" title="打开导航">
                                        🧭
                                    </button>
                                </div>
                            </div>
                        </li>
                    `;
                } else if (place.isBlank || !hasCoordinates) {
                    // 空白地点或无坐标地点显示简单的分隔线
                    htmlContent += `
                        <li class="route-segment">
                            <div class="route-connector">
                                <div class="route-line no-coordinates"></div>
                                <div class="route-info-card compact disabled">
                                    <div class="route-info">
                                        <span class="distance-info">📍 ${place.isBlank ? '空白地点' : '无地理信息'}</span>
                                    </div>
                                </div>
                            </div>
                        </li>
                    `;
                }
            }

            // 然后显示地点信息
            const displayName = place.customName || place.name;
            const escapedCustomName = (place.customName || '').replace(/'/g, "\\'");
            const escapedOriginalName = place.name.replace(/'/g, "\\'");

            // 只为非空白地点分配序号
            let displayOrder = '';
            if (!place.isBlank) {
                nonBlankIndex++;
                displayOrder = nonBlankIndex;
            } else {
                displayOrder = '✏️'; // 空白地点显示编辑图标
            }

            htmlContent += `
                <li class="travel-item ${place.isBlank ? 'blank-item' : ''}" draggable="true" data-id="${place.id}">
                    <div class="travel-item-header">
                        <div class="travel-item-left">
                            <span class="drag-handle">⠿</span>
                            <span class="travel-item-order">${displayOrder}</span>
                            <span class="travel-item-name">${displayName}</span>
                        </div>
                    </div>
                    <div class="travel-item-address">📮 ${place.address}</div>
                    ${place.notes ? `<div class="travel-item-notes">${place.notes}</div>` : ''}
                    <div class="travel-item-actions">
                        <button class="activate-btn" onclick="app.togglePlaceStatus('${place.id}')" title="移至待定">🎯 游玩</button>
                        ${place.lat && place.lng ? `<button class="action-btn locate-btn" onclick="app.locatePlace(${place.lng}, ${place.lat})" title="在地图上定位">📍</button>` : ''}
                        ${place.lat && place.lng ? `<button class="action-btn show-in-map-btn" onclick="app.showInMap(${place.lng}, ${place.lat}, '${displayName.replace(/'/g, "\\'")}')" title="在导航中显示">🗺️</button>` : ''}
                        ${place.lat && place.lng ? `<button class="action-btn navigate-to-btn" onclick="app.navigateToPlace(${place.lng}, ${place.lat}, '${displayName.replace(/'/g, "\\'")}')" title="导航到此处">🧭</button>` : ''}
                        <button class="action-btn edit-btn" onclick="app.editPlace('${place.id}')" title="编辑游玩点">✏️</button>
                        <button class="action-btn copy-btn" onclick="app.copyPlaceName('${escapedCustomName || escapedOriginalName}')" title="复制名称">📋</button>
                        <button class="action-btn copy-btn" onclick="app.copyPlaceAddress('${place.address.replace(/'/g, "\\'")}')" title="复制地址">📄</button>
                        <button class="action-btn" onclick="app.removePlaceFromList('${place.id}')" title="删除">✕</button>
                    </div>
                </li>
            `;
        });

        listContainer.innerHTML = htmlContent;
    }

    // 更新待定列表
    updatePendingList(pendingPlaces) {
        const listContainer = document.getElementById('pendingList');

        if (pendingPlaces.length === 0) {
            listContainer.innerHTML = '<li class="empty-pending">暂无待定地点</li>';
            return;
        }

        let htmlContent = '';

        pendingPlaces.forEach((place) => {
            const displayName = place.customName || place.name;
            const escapedCustomName = (place.customName || '').replace(/'/g, "\\'");
            const escapedOriginalName = place.name.replace(/'/g, "\\'");

            htmlContent += `
                <li class="pending-item" data-id="${place.id}">
                    <div class="pending-item-header">
                        <div class="pending-item-left">
                            <span class="pending-item-name">${displayName}</span>
                        </div>
                    </div>
                    <div class="pending-item-address">📮 ${place.address}</div>
                    ${place.notes ? `<div class="pending-item-notes">${place.notes}</div>` : ''}
                    <div class="pending-item-actions">
                        <button class="pending-btn" onclick="app.togglePlaceStatus('${place.id}')" title="加入游玩列表">⏳ 待定</button>
                        ${place.lat && place.lng ? `<button class="action-btn locate-btn" onclick="app.locatePlace(${place.lng}, ${place.lat})" title="在地图上定位">📍</button>` : ''}
                        ${place.lat && place.lng ? `<button class="action-btn show-in-map-btn" onclick="app.showInMap(${place.lng}, ${place.lat}, '${displayName.replace(/'/g, "\\'")}')" title="在导航中显示">🗺️</button>` : ''}
                        <button class="action-btn edit-btn" onclick="app.editPlace('${place.id}')" title="编辑游玩点">✏️</button>
                        <button class="action-btn copy-btn" onclick="app.copyPlaceName('${escapedCustomName || escapedOriginalName}')" title="复制名称">📋</button>
                        <button class="action-btn copy-btn" onclick="app.copyPlaceAddress('${place.address.replace(/'/g, "\\'")}')" title="复制地址">📄</button>
                        <button class="action-btn" onclick="app.removePlaceFromList('${place.id}')" title="删除">✕</button>
                    </div>
                </li>
            `;
        });

        listContainer.innerHTML = htmlContent;
    }

    // 设置拖拽功能
    setupDragAndDrop() {
        const items = document.querySelectorAll('.travel-item');
        items.forEach(item => {
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
        const draggedIndex = this.travelList.findIndex(item => item.id.toString() === draggedId);
        const targetIndex = this.travelList.findIndex(item => item.id.toString() === targetId);

        if (draggedIndex !== -1 && targetIndex !== -1) {
            const [draggedItem] = this.travelList.splice(draggedIndex, 1);
            this.travelList.splice(targetIndex, 0, draggedItem);

            // 检查拖动的项目是否为空白地点
            const isDraggingBlank = draggedItem.isBlank;

            if (isDraggingBlank) {
                // 如果是空白地点，使用不重新计算距离的方法
                this.updateTravelListWithoutRecalculation();
            } else {
                // 如果是普通地点，正常更新并重新计算距离
                this.updateTravelList();
                this.calculateDistancesWithDebounce();
                this.drawRoute();
            }

            this.saveData();
            this.markAsModified(); // 标记为已修改
        }
    }

    // 定位地点
    locatePlace(lng, lat) {
        console.log(`🎯 定位到地点: ${lng.toFixed(6)}, ${lat.toFixed(6)}`);

        if (this.isMapLoaded) {
            const selectedMapApi = this.settings.selectedMapApi;

            if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                this.map.setCenter({ lat: lat, lng: lng });
                this.map.setZoom(16);
            } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                this.map.setCenter([lng, lat]); // 高德地图使用 [经度, 纬度] 格式
                this.map.setZoom(16);
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
    openNavigationUrl(url, appName, placeName) {
        // 根据用户偏好设置决定是否在新标签页中打开
        const openInNewTab = this.settings.preferences?.openInNewTab !== false;
        const target = openInNewTab ? '_blank' : '_self';

        try {
            window.open(url, target);

            // 如果用户设置了显示导航提示
            if (this.settings.preferences?.showNavigationHint !== false) {
                const targetText = openInNewTab ? '新标签页' : '当前页面';
                this.showToast(`已在${targetText}中打开${appName}导航到: ${placeName}`);
            }
        } catch (error) {
            // 备用方案：复制导航链接
            navigator.clipboard.writeText(url).then(() => {
                this.showToast(`${appName}导航链接已复制到剪贴板`);
            });
        }
    }

    // 在地图中显示游玩点（不进行导航，仅显示位置）
    showInMap(lng, lat, name) {
        // 根据用户设置选择地图应用
        const selectedMapApi = this.settings.selectedMapApi || 'gaode';
        let url = '';
        let appName = '';

        switch (selectedMapApi) {
            case 'gaode':
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
            default:
                // 默认使用高德地图
                url = `https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(name)}&src=17travelplanner&coordinate=gaode&callnative=1`;
                appName = '高德地图';
                break;
        }

        // 根据用户偏好设置决定是否在新标签页中打开
        const openInNewTab = this.settings.preferences?.openInNewTab !== false;
        const target = openInNewTab ? '_blank' : '_self';

        try {
            window.open(url, target);

            // 如果用户设置了显示导航提示
            if (this.settings.preferences?.showNavigationHint !== false) {
                const targetText = openInNewTab ? '新标签页' : '当前页面';
                this.showToast(`已在${targetText}中打开${appName}显示: ${name}`);
            }
        } catch (error) {
            // 备用方案：复制地图链接
            navigator.clipboard.writeText(url).then(() => {
                this.showToast(`${appName}显示链接已复制到剪贴板`);
            });
        }
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
                    }

                    // 根据用户偏好设置决定是否在新标签页中打开
                    const openInNewTab = this.settings.preferences?.openInNewTab !== false;
                    const target = openInNewTab ? '_blank' : '_self';

                    try {
                        window.open(url, target);

                        // 如果用户设置了显示导航提示
                        if (this.settings.preferences?.showNavigationHint !== false) {
                            const targetText = openInNewTab ? '新标签页' : '当前页面';
                            this.showToast(`已在${targetText}中打开${appName}导航到: ${name}`);
                        }
                    } catch (error) {
                        // 备用方案：复制导航链接
                        navigator.clipboard.writeText(url).then(() => {
                            this.showToast(`${appName}导航链接已复制到剪贴板`);
                        });
                    }
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
    showToast(message) {
        // 检查是否为紧凑模式，如果是则简化消息
        const isCompactMode = document.body.classList.contains('mobile-compact-mode');
        let displayMessage = message;

        if (isCompactMode) {
            displayMessage = this.simplifyToastMessage(message);
        }

        // 创建toast元素
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = displayMessage;

        // 添加到页面
        document.body.appendChild(toast);

        // 显示动画
        setTimeout(() => {
            toast.classList.add('show');
        }, 100);

        // 紧凑模式下缩短显示时间
        const displayTime = isCompactMode ? 2000 : 3000;
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                if (toast.parentNode) {
                    document.body.removeChild(toast);
                }
            }, 300);
        }, displayTime);
    }

    // 简化Toast消息（紧凑模式专用）
    simplifyToastMessage(message) {
        const simplifications = {
            '🎯 已启用紧凑模式，获得更多显示空间': '✅ 紧凑模式',
            '📱 已退出紧凑模式': '❌ 退出紧凑',
            '已在新标签页中打开': '✅ 已打开',
            '已在当前页面中打开': '✅ 已打开',
            '导航链接已复制到剪贴板': '📋 已复制',
            '显示链接已复制到剪贴板': '📋 已复制',
            '✅ 已定位到您的位置': '📍 已定位',
            '已复制地点名称': '📋 已复制',
            '已复制地址': '📋 已复制',
            '已切换到普通地图': '🗺️ 普通图',
            '已切换到卫星图': '🛰️ 卫星图',
            '已显示地点名称': '🏷️ 显示名称',
            '已隐藏地点名称': '🏷️ 隐藏名称',
            '已显示待定点': '⏳ 显示待定',
            '已隐藏待定点': '⏳ 隐藏待定',
            '设置已保存': '✅ 已保存',
            '至少需要2个有效地点才能显示路线': '⚠️ 需要2+地点',
            '请先添加一些游玩地点再导出': '⚠️ 先添加地点'
        };

        // 优先匹配完整消息
        if (simplifications[message]) {
            return simplifications[message];
        }

        // 处理包含动态内容的消息
        if (message.includes('已更新游玩点：')) {
            return '✅ 已更新';
        }
        if (message.includes('已移至待定列表')) {
            return '⏳ 移至待定';
        }
        if (message.includes('已加入游玩列表')) {
            return '✅ 已加入';
        }
        if (message.includes('已显示') && message.includes('个地点的完整路线')) {
            return '🛣️ 已显示路线';
        }
        if (message.includes('已显示') && message.includes('个待定点')) {
            return '⏳ 显示待定';
        }
        if (message.includes('导航到')) {
            return '🧭 导航中';
        }
        if (message.includes('显示:')) {
            return '🗺️ 已显示';
        }

        // 如果消息太长，截断并添加省略号
        if (message.length > 15) {
            return message.substring(0, 12) + '...';
        }

        return message;
    }

    // 显示恢复总地图按钮
    showReturnToOverviewButton() {
        if (!this.returnToOverviewBtn) {
            const mapControls = document.querySelector('.map-controls');
            this.returnToOverviewBtn = document.createElement('button');
            this.returnToOverviewBtn.className = 'control-btn return-overview-btn';
            this.returnToOverviewBtn.innerHTML = '🗺️ 恢复总地图';
            this.returnToOverviewBtn.title = '返回查看所有游玩点（不包括待定列表）';
            this.returnToOverviewBtn.addEventListener('click', () => this.returnToOverview());
            mapControls.appendChild(this.returnToOverviewBtn);
        }
        this.returnToOverviewBtn.style.display = 'block';
    }

    // 恢复总地图视图
    returnToOverview() {
        if (this.isMapLoaded && this.travelList.length > 0) {
            // 只显示激活状态的游玩点
            const activePlaces = this.travelList.filter(place => !place.isPending);

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
        this.travelList = this.travelList.filter(item => item.id.toString() !== id);
        this.updateTravelList();
        this.calculateDistancesWithDebounce();
        this.drawRoute(); // 删除地点后重新绘制路线
        this.removeMarker(id);
        this.saveData();
        this.markAsModified(); // 标记为已修改

        // 删除地点后更新城市过滤状态
        this.updateCityFilterButton();
    }

    // 计算相邻地点距离
    calculateDistances() {
        const activePlaces = this.travelList.filter(place => !place.isPending);

        if (activePlaces.length < 2) {
            this.updateDistanceSummary(0, 0);
            return;
        }

        // 使用真实距离计算并更新总统计
        this.calculateRealDistances();
    }

    // 计算真实距离（根据选择的地图API）
    calculateRealDistances() {
        const selectedMapApi = this.settings.selectedMapApi;
        console.log(`📏 使用${selectedMapApi} API计算距离`);

        if (selectedMapApi === 'google' && this.distanceMatrixService) {
            this.calculateRealDistancesWithGoogle();
        } else if (selectedMapApi === 'gaode') {
            this.calculateRealDistancesWithGaode();
        } else {
            console.warn('⚠️ 当前地图API不支持距离计算，使用直线距离');
            this.calculateStraightLineDistances();
        }
    }

    // 使用Google Distance Matrix API计算真实距离
    calculateRealDistancesWithGoogle() {
        const activePlaces = this.travelList.filter(place => !place.isPending);

        // 只处理有坐标的非空白地点
        const nonBlankPlaces = activePlaces.filter(place => place.lat && place.lng && !place.isBlank);

        let totalDistanceKm = 0;
        let totalDurationMin = 0;
        let completedCalculations = 0;
        let totalCalculations = 0;

        // 为每个地点寻找其前一个非空白地点，计算距离
        for (let i = 0; i < activePlaces.length; i++) {
            const currentPlace = activePlaces[i];

            // 跳过空白地点或无坐标地点
            if (!currentPlace.lat || !currentPlace.lng || currentPlace.isBlank) {
                // 为空白地点或无坐标地点更新显示
                const distanceElement = document.getElementById(`distance-${currentPlace.id}`);
                const durationElement = document.getElementById(`duration-${currentPlace.id}`);

                if (distanceElement) {
                    distanceElement.textContent = currentPlace.isBlank ? '空白地点' : '无地理信息';
                }
                if (durationElement) {
                    durationElement.textContent = '-';
                }
                continue;
            }

            // 寻找前一个非空白地点
            let prevNonBlankPlace = null;
            for (let j = i - 1; j >= 0; j--) {
                if (activePlaces[j].lat && activePlaces[j].lng && !activePlaces[j].isBlank) {
                    prevNonBlankPlace = activePlaces[j];
                    break;
                }
            }

            // 如果找到了前一个非空白地点，计算距离
            if (prevNonBlankPlace) {
                totalCalculations++;
            }
        }

        if (totalCalculations === 0) {
            this.updateDistanceSummary(0, 0);
            return;
        }

        // 执行距离计算
        for (let i = 0; i < activePlaces.length; i++) {
            const currentPlace = activePlaces[i];

            // 跳过空白地点或无坐标地点
            if (!currentPlace.lat || !currentPlace.lng || currentPlace.isBlank) {
                continue;
            }

            // 寻找前一个非空白地点
            let prevNonBlankPlace = null;
            for (let j = i - 1; j >= 0; j--) {
                if (activePlaces[j].lat && activePlaces[j].lng && !activePlaces[j].isBlank) {
                    prevNonBlankPlace = activePlaces[j];
                    break;
                }
            }

            // 如果找到了前一个非空白地点，计算距离
            if (prevNonBlankPlace) {
                this.distanceMatrixService.getDistanceMatrix({
                    origins: [{ lat: prevNonBlankPlace.lat, lng: prevNonBlankPlace.lng }],
                    destinations: [{ lat: currentPlace.lat, lng: currentPlace.lng }],
                    travelMode: google.maps.TravelMode.DRIVING,
                    unitSystem: google.maps.UnitSystem.METRIC,
                    avoidHighways: false,
                    avoidTolls: false
                }, (response, status) => {
                    completedCalculations++;

                    if (status === 'OK' && response.rows[0].elements[0].status === 'OK') {
                        const element = response.rows[0].elements[0];
                        const distance = element.distance.text;
                        const duration = element.duration.text;

                        // 提取数值进行累计
                        const distanceValue = element.distance.value / 1000; // 转换为公里
                        const durationValue = element.duration.value / 60; // 转换为分钟

                        totalDistanceKm += distanceValue;
                        totalDurationMin += durationValue;

                        // 更新界面显示
                        const distanceElement = document.getElementById(`distance-${currentPlace.id}`);
                        const durationElement = document.getElementById(`duration-${currentPlace.id}`);

                        if (distanceElement) {
                            distanceElement.textContent = distance;
                        }
                        if (durationElement) {
                            durationElement.textContent = duration;
                        }
                    } else {
                        // 如果API调用失败，使用直线距离
                        const straightDistance = this.calculateStraightDistance(prevNonBlankPlace.lat, prevNonBlankPlace.lng, currentPlace.lat, currentPlace.lng);
                        totalDistanceKm += straightDistance;
                        totalDurationMin += (straightDistance / 50) * 60; // 假设50km/h

                        const distanceElement = document.getElementById(`distance-${currentPlace.id}`);
                        const durationElement = document.getElementById(`duration-${currentPlace.id}`);

                        if (distanceElement) {
                            distanceElement.textContent = `${straightDistance.toFixed(1)} 公里 (直线)`;
                        }
                        if (durationElement) {
                            durationElement.textContent = `约${(straightDistance / 50 * 60).toFixed(0)} 分钟`;
                        }
                    }

                    // 当所有计算完成时更新总计
                    if (completedCalculations === totalCalculations) {
                        this.updateDistanceSummary(totalDistanceKm, totalDurationMin / 60);
                    }
                });
            }
        }
    }

    // 使用高德地图Web服务API计算真实距离
    async calculateRealDistancesWithGaode() {
        const activePlaces = this.travelList.filter(place => !place.isPending);
        const apiKey = this.getApiKey('gaode');

        if (!apiKey) {
            console.error('❌ 高德API密钥未配置，使用直线距离');
            this.calculateStraightLineDistances();
            return;
        }

        let totalDistanceKm = 0;
        let totalDurationMin = 0;
        let completedCalculations = 0;
        let totalCalculations = 0;

        // 统计需要计算的路段数
        for (let i = 0; i < activePlaces.length; i++) {
            const currentPlace = activePlaces[i];

            if (!currentPlace.lat || !currentPlace.lng || currentPlace.isBlank) {
                const distanceElement = document.getElementById(`distance-${currentPlace.id}`);
                const durationElement = document.getElementById(`duration-${currentPlace.id}`);

                if (distanceElement) {
                    distanceElement.textContent = currentPlace.isBlank ? '空白地点' : '无地理信息';
                }
                if (durationElement) {
                    durationElement.textContent = '-';
                }
                continue;
            }

            let prevNonBlankPlace = null;
            for (let j = i - 1; j >= 0; j--) {
                if (activePlaces[j].lat && activePlaces[j].lng && !activePlaces[j].isBlank) {
                    prevNonBlankPlace = activePlaces[j];
                    break;
                }
            }

            if (prevNonBlankPlace) {
                totalCalculations++;
            }
        }

        if (totalCalculations === 0) {
            this.updateDistanceSummary(0, 0);
            return;
        }

        // 计算每个路段的距离
        for (let i = 0; i < activePlaces.length; i++) {
            const currentPlace = activePlaces[i];

            if (!currentPlace.lat || !currentPlace.lng || currentPlace.isBlank) {
                continue;
            }

            let prevNonBlankPlace = null;
            for (let j = i - 1; j >= 0; j--) {
                if (activePlaces[j].lat && activePlaces[j].lng && !activePlaces[j].isBlank) {
                    prevNonBlankPlace = activePlaces[j];
                    break;
                }
            }

            if (prevNonBlankPlace) {
                try {
                    const result = await this.calculateGaodeDistance(prevNonBlankPlace, currentPlace, apiKey);
                    completedCalculations++;

                    if (result.success) {
                        totalDistanceKm += result.distance;
                        totalDurationMin += result.duration;

                        const distanceElement = document.getElementById(`distance-${currentPlace.id}`);
                        const durationElement = document.getElementById(`duration-${currentPlace.id}`);

                        if (distanceElement) {
                            distanceElement.textContent = `${result.distance.toFixed(1)} 公里`;
                        }
                        if (durationElement) {
                            durationElement.textContent = `${Math.round(result.duration)} 分钟`;
                        }
                    } else {
                        // API失败，使用直线距离
                        const straightDistance = this.calculateStraightDistance(
                            prevNonBlankPlace.lat, prevNonBlankPlace.lng,
                            currentPlace.lat, currentPlace.lng
                        );
                        totalDistanceKm += straightDistance;
                        totalDurationMin += (straightDistance / 50) * 60;

                        const distanceElement = document.getElementById(`distance-${currentPlace.id}`);
                        const durationElement = document.getElementById(`duration-${currentPlace.id}`);

                        if (distanceElement) {
                            distanceElement.textContent = `${straightDistance.toFixed(1)} 公里 (直线)`;
                        }
                        if (durationElement) {
                            durationElement.textContent = `约${Math.round(straightDistance / 50 * 60)} 分钟`;
                        }
                    }

                    // 当所有计算完成时更新总计
                    if (completedCalculations === totalCalculations) {
                        this.updateDistanceSummary(totalDistanceKm, totalDurationMin / 60);
                    }
                } catch (error) {
                    console.error('❌ 高德距离计算出错:', error);
                    completedCalculations++;

                    // 使用直线距离作为备用
                    const straightDistance = this.calculateStraightDistance(
                        prevNonBlankPlace.lat, prevNonBlankPlace.lng,
                        currentPlace.lat, currentPlace.lng
                    );
                    totalDistanceKm += straightDistance;
                    totalDurationMin += (straightDistance / 50) * 60;

                    const distanceElement = document.getElementById(`distance-${currentPlace.id}`);
                    const durationElement = document.getElementById(`duration-${currentPlace.id}`);

                    if (distanceElement) {
                        distanceElement.textContent = `${straightDistance.toFixed(1)} 公里 (直线)`;
                    }
                    if (durationElement) {
                        durationElement.textContent = `约${Math.round(straightDistance / 50 * 60)} 分钟`;
                    }

                    if (completedCalculations === totalCalculations) {
                        this.updateDistanceSummary(totalDistanceKm, totalDurationMin / 60);
                    }
                }
            }
        }
    }

    // 使用高德API计算两点间距离（带缓存优化）
    async calculateGaodeDistance(fromPlace, toPlace, apiKey) {
        // 检查缓存
        const cachedDistance = this.getCachedDistance(fromPlace, toPlace);
        if (cachedDistance) {
            return {
                success: true,
                distance: cachedDistance.distance,
                duration: cachedDistance.duration
            };
        }

        try {
            const url = 'https://restapi.amap.com/v3/direction/driving';
            const params = new URLSearchParams({
                key: apiKey,
                origin: `${fromPlace.lng},${fromPlace.lat}`,
                destination: `${toPlace.lng},${toPlace.lat}`,
                extensions: 'base'
            });

            const response = await fetch(`${url}?${params.toString()}`);

            if (!response.ok) {
                throw new Error(`HTTP错误: ${response.status}`);
            }

            const data = await response.json();

            if (data.status === '1' && data.route && data.route.paths && data.route.paths.length > 0) {
                const path = data.route.paths[0];
                const distance = parseFloat(path.distance) / 1000; // 转换为公里
                const duration = parseFloat(path.duration) / 60;   // 转换为分钟

                // 缓存结果
                this.cacheDistance(fromPlace, toPlace, distance, duration);

                return {
                    success: true,
                    distance: distance,
                    duration: duration
                };
            } else {
                console.warn('⚠️ 高德路径规划API返回错误:', data.info);
                return { success: false };
            }
        } catch (error) {
            console.error('❌ 调用高德路径规划API失败:', error);
            return { success: false };
        }
    }

    // 计算直线距离（备用方案）
    calculateStraightLineDistances() {
        let totalDistance = 0;

        for (let i = 1; i < this.travelList.length; i++) {
            const prev = this.travelList[i - 1];
            const curr = this.travelList[i];

            const distance = this.calculateStraightDistance(prev.lat, prev.lng, curr.lat, curr.lng);
            totalDistance += distance;

            // 更新距离显示
            const distanceElement = document.getElementById(`distance-${curr.id}`);
            const durationElement = document.getElementById(`duration-${curr.id}`);

            if (distanceElement) {
                distanceElement.textContent = `${distance.toFixed(1)} 公里 (直线)`;
            }
            if (durationElement) {
                durationElement.textContent = `约${(distance / 50 * 60).toFixed(0)} 分钟`;
            }
        }

        const estimatedTime = totalDistance / 50; // 假设平均速度50km/h
        this.updateDistanceSummary(totalDistance, estimatedTime);
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
    updateDistanceSummary(distance, time) {
        document.getElementById('totalDistance').textContent = `总距离: ${distance.toFixed(1)} 公里`;

        // 将时间转换为更友好的格式
        const hours = Math.floor(time);
        const minutes = Math.round((time - hours) * 60);

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
    }

    // 添加地图标记
    addMarker(place) {
        if (!this.isMapLoaded) return;

        // 如果是待定点，不创建普通标记
        if (place.isPending) {
            return;
        }

        // 如果没有坐标信息，不创建标记
        if (!place.lat || !place.lng) {
            return;
        }

        // 如果是空白地点，不创建标记
        if (place.isBlank) {
            return;
        }

        // 获取非空白游玩点在激活列表中的序号
        const activePlaces = this.travelList.filter(p => !p.isPending);
        const nonBlankActivePlaces = activePlaces.filter(p => !p.isBlank && p.lat && p.lng);
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
                url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
                    <svg width="40" height="50" viewBox="0 0 40 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <!-- 外层阴影 -->
                        <ellipse cx="20" cy="47" rx="8" ry="3" fill="rgba(0,0,0,0.3)"/>
                        <!-- 主要标记 -->
                        <path d="M20 3C13.4 3 8 8.4 8 15C8 24.75 20 47 20 47C20 47 32 24.75 32 15C32 8.4 26.6 3 20 3Z" fill="#e74c3c" stroke="#ffffff" stroke-width="2"/>
                        <!-- 内圆 -->
                        <circle cx="20" cy="15" r="6" fill="#ffffff"/>
                        <!-- 编号文字 -->
                        <text x="20" y="19" text-anchor="middle" font-family="Arial" font-size="8" font-weight="bold" fill="#e74c3c">${number}</text>
                    </svg>
                `),
                scaledSize: new google.maps.Size(40, 50),
                anchor: new google.maps.Point(20, 50)
            },
            zIndex: 1000 + index
        });
    }

    // 创建高德地图标记
    createGaodeMarker(place, number, displayName, index) {
        // 使用SVG创建标记，与Google Maps保持一致的视觉效果
        const markerSvg = `
            <svg width="40" height="50" viewBox="0 0 40 50" xmlns="http://www.w3.org/2000/svg">
                <!-- 阴影 -->
                <ellipse cx="20" cy="47" rx="8" ry="3" fill="rgba(0,0,0,0.3)"/>
                <!-- 主要标记 -->
                <path d="M20 3C13.4 3 8 8.4 8 15C8 24.75 20 47 20 47C20 47 32 24.75 32 15C32 8.4 26.6 3 20 3Z" fill="#e74c3c" stroke="#ffffff" stroke-width="2"/>
                <!-- 内圆 -->
                <circle cx="20" cy="15" r="6" fill="#ffffff"/>
                <!-- 编号文字 -->
                <text x="20" y="19" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#e74c3c">${number}</text>
            </svg>
        `;

        const marker = new AMap.Marker({
            position: [place.lng, place.lat], // 高德地图使用 [经度, 纬度] 格式
            title: `${number}. ${displayName}`,
            content: `
                <div style="
                    position: relative;
                    width: 40px;
                    height: 50px;
                    cursor: pointer;
                ">
                    ${markerSvg}
                </div>
            `,
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
            content: `
                <div style="
                    position: absolute;
                    background: linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.97) 100%);
                    border: 1px solid rgba(255,255,255,0.9);
                    border-radius: 8px;
                    padding: 6px 10px;
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    font-size: 12px;
                    font-weight: 600;
                    color: #2c3e50;
                    white-space: nowrap;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15), 0 2px 4px rgba(0,0,0,0.1);
                    backdrop-filter: blur(8px);
                    text-shadow: 0 1px 2px rgba(255,255,255,0.8);
                    min-width: 60px;
                    text-align: center;
                    cursor: default;
                    user-select: none;
                    z-index: 1000;
                    top: -75px;
                    left: 50%;
                    transform: translateX(-50%);
                    pointer-events: none;
                ">
                    <span style="
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        -webkit-background-clip: text;
                        -webkit-text-fill-color: transparent;
                        background-clip: text;
                        font-weight: 800;
                        margin-right: 4px;
                    ">${number}.</span><span>${displayName}</span>
                </div>
            `,
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
                }
            }
            this.placeLabels.splice(labelIndex, 1);
        }
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
                }
            }
        });
        this.placeLabels = [];

        // 清除待定点标记
        this.clearPendingMarkers();

        // 清除路线
        if (selectedMapApi === 'google' && this.directionsRenderer) {
            this.directionsRenderer.setDirections({ routes: [] });
        }

        // 重置城市过滤
        this.currentCityFilter = 'all';
        if (this.cityFilterBtn) {
            this.cityFilterBtn.innerHTML = '🏙️ 全部城市';
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
            clearBtn.innerHTML = '🗑️ 清除标记';
            clearBtn.title = '清除地图标记';
            const activeCount = this.travelList.filter(place => !place.isPending && place.lat && place.lng && !place.isBlank).length;
            this.showToast(`已恢复标记并调整视角显示${activeCount}个游玩点`);
        } else {
            // 清除标记
            this.saveMarkersState();
            this.clearMarkersOnly();
            clearBtn.innerHTML = '↩️ 恢复标记';
            clearBtn.title = '恢复地图标记';
            this.showToast('已清除标记');
        }
        this.markersCleared = !this.markersCleared;
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
                }
            }
        });
        this.placeLabels = [];

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
        const currentActivePlaces = this.travelList.filter(place => !place.isPending && place.lat && place.lng && !place.isBlank);
        if (currentActivePlaces.length > 0) {
            setTimeout(() => {
                this.fitMapToPlaces(currentActivePlaces);
                console.log(`✅ 已恢复标记并调整视角显示${currentActivePlaces.length}个游玩点`);
            }, 300);
        }
    }

    // 显示路线功能（优化版）
    showRoute() {
        const activePlaces = this.travelList.filter(place => !place.isPending && !place.isBlank && place.lat && place.lng);

        if (activePlaces.length < 2) {
            this.showToast('至少需要2个有效地点才能显示路线');
            return;
        }

        console.log(`🛣️ 显示路线：${activePlaces.length}个地点`);

        // 确保标记已显示
        if (this.markersCleared) {
            this.restoreMarkers();
            const clearBtn = document.getElementById('clearMarkersBtn');
            clearBtn.innerHTML = '🗑️ 清除标记';
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
        // 只处理激活状态且非空白的地点
        const activePlaces = this.travelList.filter(place => !place.isPending && !place.isBlank && place.lat && place.lng);

        if (!this.isMapLoaded || activePlaces.length < 2) {
            this.clearAllRoutes();
            return;
        }

        const selectedMapApi = this.settings.selectedMapApi;
        console.log(`🛣️ 使用${selectedMapApi}绘制路线`);

        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
            this.drawGoogleRoute(activePlaces);
        } else if (selectedMapApi === 'gaode') {
            // 高德路线规划使用Web服务API，但绘制需要AMap对象
            if (typeof AMap !== 'undefined') {
                this.drawGaodeRoute(activePlaces);
            } else {
                console.warn('⚠️ AMap对象未加载，无法绘制高德地图路线');
                this.drawSimplePath(activePlaces);
            }
        } else {
            console.warn('⚠️ 当前地图API不支持路线绘制，使用简单连线');
            this.drawSimplePath(activePlaces);
        }
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
        }
    }

    // Google Maps路线绘制
    drawGoogleRoute(activePlaces) {
        // 清除现有路线
        if (this.directionsRenderer) {
            this.directionsRenderer.setDirections({ routes: [] });
        }
        if (this.polyline) {
            this.polyline.setMap(null);
            this.polyline = null;
        }
        // 清除多彩路线段
        if (this.polylines) {
            this.polylines.forEach(polyline => polyline.setMap(null));
            this.polylines = [];
        }

        // 如果有两个以上激活地点，尝试使用 Directions API
        if (activePlaces.length >= 2 && this.directionsService) {
            // 创建路线点
            const waypoints = activePlaces.slice(1, -1).map(place => ({
                location: { lat: place.lat, lng: place.lng },
                stopover: true
            }));

            const request = {
                origin: { lat: activePlaces[0].lat, lng: activePlaces[0].lng },
                destination: {
                    lat: activePlaces[activePlaces.length - 1].lat,
                    lng: activePlaces[activePlaces.length - 1].lng
                },
                waypoints: waypoints,
                travelMode: google.maps.TravelMode.DRIVING,
                optimizeWaypoints: false // 保持用户指定的顺序
            };

            this.directionsService.route(request, (result, status) => {
                if (status === 'OK') {
                    this.directionsRenderer.setDirections(result);
                    console.log('✅ 使用Google Directions API绘制路线');
                } else {
                    console.log('⚠️ Google Directions API失败，使用多彩连线:', status);
                    // 如果路线规划失败，绘制多彩连线
                    this.drawGoogleSimplePath(activePlaces);
                }
            });
        } else {
            // 只有两个地点时，直接绘制多彩连线
            this.drawGoogleSimplePath(activePlaces);
        }
    }

    // 高德地图路线绘制
    drawGaodeRoute(activePlaces) {
        // 清除现有路线
        if (this.polylines) {
            this.polylines.forEach(polyline => this.map.remove(polyline));
            this.polylines = [];
        }

        const apiKey = this.getApiKey('gaode');
        if (!apiKey) {
            console.warn('⚠️ 高德API密钥未配置，使用简单连线');
            this.drawGaodeSimplePath(activePlaces);
            return;
        }

        // 尝试使用高德路径规划API
        console.log('🛣️ 使用高德路径规划API绘制路线');
        this.drawGaodeRoutesWithAPI(activePlaces, apiKey);
    }

    // 使用高德路径规划API绘制路线（快速版本）
    async drawGaodeRoutesWithAPI(activePlaces, apiKey) {
        try {
            this.polylines = this.polylines || [];
            console.log(`🛣️ 开始快速绘制${activePlaces.length - 1}段路线`);

            // 先立即绘制简单连线（快速显示）
            this.drawGaodeSimplePath(activePlaces);
            console.log('✅ 已显示简单路线，正在获取详细路径...');

            // 然后异步获取并替换为详细路径
            this.drawDetailedGaodeRoutes(activePlaces, apiKey);

        } catch (error) {
            console.error('❌ 高德路径规划出错:', error);
            // 回退到简单路径
            this.drawGaodeSimplePath(activePlaces);
        }
    }

    // 异步绘制详细路线（后台处理）
    async drawDetailedGaodeRoutes(activePlaces, apiKey) {
        try {
            const routePromises = [];

            // 批量发起所有路径规划请求
            for (let i = 0; i < activePlaces.length - 1; i++) {
                const origin = activePlaces[i];
                const destination = activePlaces[i + 1];

                routePromises.push(
                    this.getGaodeRoute(origin, destination, apiKey)
                        .then(routeData => ({ index: i, routeData, origin, destination }))
                        .catch(error => ({ index: i, error, origin, destination }))
                );
            }

            console.log(`🔄 正在批量获取${routePromises.length}段详细路径...`);

            // 等待所有路径规划完成
            const results = await Promise.all(routePromises);

            // 清除简单路线
            if (this.polylines) {
                this.polylines.forEach(polyline => this.map.remove(polyline));
                this.polylines = [];
            }

            // 绘制详细路线
            let successCount = 0;
            results.forEach(result => {
                if (result.error) {
                    console.warn(`⚠️ 路径${result.index + 1}规划失败，使用直线: ${result.origin.name} -> ${result.destination.name}`);
                    this.drawGaodeDirectLine(result.origin, result.destination, result.index);
                } else if (result.routeData.success) {
                    this.drawGaodeRouteSegment(result.routeData.coordinates, result.index);
                    successCount++;
                } else {
                    console.warn(`⚠️ 路径${result.index + 1}规划失败，使用直线: ${result.origin.name} -> ${result.destination.name}`);
                    this.drawGaodeDirectLine(result.origin, result.destination, result.index);
                }
            });

            console.log(`✅ 详细路线绘制完成，成功: ${successCount}/${results.length}`);

        } catch (error) {
            console.error('❌ 批量路径规划失败:', error);
        }
    }

    // 获取高德路径规划数据（带缓存优化）
    async getGaodeRoute(origin, destination, apiKey) {
        // 检查路线缓存
        const cachedRoute = this.getCachedRoute(origin, destination);
        if (cachedRoute) {
            return {
                success: true,
                coordinates: cachedRoute.coordinates,
                distance: cachedRoute.distance,
                duration: cachedRoute.duration
            };
        }

        try {
            const url = 'https://restapi.amap.com/v3/direction/driving';
            const params = new URLSearchParams({
                key: apiKey,
                origin: `${origin.lng},${origin.lat}`,
                destination: `${destination.lng},${destination.lat}`,
                extensions: 'all'  // 获取详细路径信息
            });

            const response = await fetch(`${url}?${params.toString()}`);

            if (!response.ok) {
                throw new Error(`HTTP错误: ${response.status}`);
            }

            const data = await response.json();

            if (data.status === '1' && data.route && data.route.paths && data.route.paths.length > 0) {
                const path = data.route.paths[0];

                // 解析路径坐标
                const coordinates = [];
                if (path.steps && path.steps.length > 0) {
                    path.steps.forEach(step => {
                        if (step.polyline) {
                            // 解析polyline字符串为坐标数组
                            const stepCoords = this.parseGaodePolyline(step.polyline);
                            coordinates.push(...stepCoords);
                        }
                    });
                }

                if (coordinates.length === 0) {
                    // 如果没有详细路径，使用起终点连线
                    coordinates.push([origin.lng, origin.lat], [destination.lng, destination.lat]);
                }

                // 缓存路线结果
                this.cacheRoute(origin, destination, coordinates, parseFloat(path.distance), parseFloat(path.duration));

                return {
                    success: true,
                    coordinates: coordinates,
                    distance: parseFloat(path.distance),
                    duration: parseFloat(path.duration)
                };
            } else {
                console.warn('⚠️ 高德路径规划API返回错误:', data.info);
                return { success: false };
            }
        } catch (error) {
            console.error('❌ 调用高德路径规划API失败:', error);
            return { success: false };
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
        if (!activePlaces) {
            activePlaces = this.travelList.filter(place => !place.isPending && !place.isBlank && place.lat && place.lng);
        }

        if (!this.isMapLoaded || activePlaces.length < 2) {
            return;
        }

        const selectedMapApi = this.settings.selectedMapApi;
        console.log(`🎨 绘制简单多彩路径，使用${selectedMapApi}`);

        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
            this.drawGoogleSimplePath(activePlaces);
        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
            this.drawGaodeSimplePath(activePlaces);
        } else {
            console.warn('⚠️ 无法绘制路径：地图API未加载');
        }
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
        const config = this.routeSegments.get(segmentKey) || {};
        config.mapProvider = provider;
        this.routeSegments.set(segmentKey, config);

        // 仅更新按钮状态，不重新计算距离时间
        const buttons = document.querySelectorAll(`[onclick*="changeMapProvider('${segmentKey}'"]`);
        buttons.forEach(button => {
            button.classList.remove('active');
            if (button.getAttribute('onclick').includes(`'${provider}'`)) {
                button.classList.add('active');
            }
        });

        // 保存数据
        this.saveData();
        this.markAsModified(); // 标记为已修改
        console.log(`地图提供商已更改为: ${provider}`);
    }

    // 打开导航路线 - 支持多种导航应用
    openNavigationRoute(segmentKey, fromIndex, toIndex) {
        if (fromIndex >= this.travelList.length || toIndex >= this.travelList.length) return;

        const fromPlace = this.travelList[fromIndex];
        const toPlace = this.travelList[toIndex];
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
            default:
                // 默认使用高德地图
                url = `https://uri.amap.com/navigation?from=${fromPlace.lng},${fromPlace.lat}&to=${toPlace.lng},${toPlace.lat}&mode=car&policy=1&src=mypage&coordinate=gaode&callnative=0`;
                appName = '高德地图';
                break;
        }

        // 根据用户偏好设置决定是否在新标签页中打开
        const openInNewTab = this.settings.preferences?.openInNewTab !== false;
        const target = openInNewTab ? '_blank' : '_self';

        window.open(url, target);

        // 如果用户设置了显示导航提示
        if (this.settings.preferences?.showNavigationHint !== false) {
            const targetText = openInNewTab ? '新标签页' : '当前页面';
            this.showToast(`已在${targetText}中打开${appName}导航`);
        }

        console.log(`打开${appName}导航: 从 "${fromPlace.name}" 到 "${toPlace.name}"`);
    }

    // 设置marker可见性（兼容Google Maps和高德地图）
    setMarkerVisible(marker, visible) {
        const selectedMapApi = this.settings.selectedMapApi;

        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
            // Google Maps marker
            if (marker && typeof marker.setVisible === 'function') {
                marker.setVisible(visible);
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
        } else {
            console.warn('⚠️ 未知的地图API类型，无法设置marker可见性');
        }
    }

    // 计算单个路线段距离
    calculateSegmentDistance(segmentKey) {
        const [fromId, toId] = segmentKey.split('-');
        const fromPlace = this.travelList.find(p => p.id.toString() === fromId);
        const toPlace = this.travelList.find(p => p.id.toString() === toId);

        if (!fromPlace || !toPlace) return;

        const selectedMapApi = this.settings.selectedMapApi;
        console.log(`📏 计算路线段距离: ${fromPlace.name} -> ${toPlace.name}, 使用${selectedMapApi} API`);

        if (selectedMapApi === 'google' && this.distanceMatrixService && this.isMapLoaded) {
            this.calculateSegmentDistanceWithGoogle(fromPlace, toPlace, toId);
        } else if (selectedMapApi === 'gaode') {
            this.calculateSegmentDistanceWithGaode(fromPlace, toPlace, toId);
        } else {
            // 使用直线距离作为备用
            this.calculateSegmentDistanceWithStraightLine(fromPlace, toPlace, toId);
        }
    }

    // 使用Google API计算路线段距离
    calculateSegmentDistanceWithGoogle(fromPlace, toPlace, toId) {
        this.distanceMatrixService.getDistanceMatrix({
            origins: [{ lat: fromPlace.lat, lng: fromPlace.lng }],
            destinations: [{ lat: toPlace.lat, lng: toPlace.lng }],
            travelMode: google.maps.TravelMode.DRIVING,
            unitSystem: google.maps.UnitSystem.METRIC,
            avoidHighways: false,
            avoidTolls: false
        }, (response, status) => {
            const distanceElement = document.getElementById(`distance-${toId}`);
            const durationElement = document.getElementById(`duration-${toId}`);

            if (status === 'OK' && response.rows[0].elements[0].status === 'OK') {
                const element = response.rows[0].elements[0];

                if (distanceElement) {
                    distanceElement.textContent = element.distance.text;
                }
                if (durationElement) {
                    durationElement.textContent = element.duration.text;
                }
            } else {
                // API失败时使用直线距离
                this.calculateSegmentDistanceWithStraightLine(fromPlace, toPlace, toId, '估算');
            }
        });
    }

    // 使用高德API计算路线段距离
    async calculateSegmentDistanceWithGaode(fromPlace, toPlace, toId) {
        const apiKey = this.getApiKey('gaode');
        if (!apiKey) {
            console.warn('⚠️ 高德API密钥未配置，使用直线距离');
            this.calculateSegmentDistanceWithStraightLine(fromPlace, toPlace, toId, '直线');
            return;
        }

        try {
            const result = await this.calculateGaodeDistance(fromPlace, toPlace, apiKey);
            const distanceElement = document.getElementById(`distance-${toId}`);
            const durationElement = document.getElementById(`duration-${toId}`);

            if (result.success) {
                if (distanceElement) {
                    distanceElement.textContent = `${result.distance.toFixed(1)} 公里`;
                }
                if (durationElement) {
                    durationElement.textContent = `${Math.round(result.duration)} 分钟`;
                }
            } else {
                // API失败时使用直线距离
                this.calculateSegmentDistanceWithStraightLine(fromPlace, toPlace, toId, '直线');
            }
        } catch (error) {
            console.error('❌ 高德路线段距离计算出错:', error);
            this.calculateSegmentDistanceWithStraightLine(fromPlace, toPlace, toId, '直线');
        }
    }

    // 使用直线距离计算路线段距离
    calculateSegmentDistanceWithStraightLine(fromPlace, toPlace, toId, suffix = '直线') {
        const distance = this.calculateStraightDistance(fromPlace.lat, fromPlace.lng, toPlace.lat, toPlace.lng);
        const distanceElement = document.getElementById(`distance-${toId}`);
        const durationElement = document.getElementById(`duration-${toId}`);

        if (distanceElement) {
            distanceElement.textContent = `${distance.toFixed(1)} 公里 (${suffix})`;
        }
        if (durationElement) {
            durationElement.textContent = `约${Math.round(distance / 50 * 60)} 分钟`;
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

                    console.log(`📍 获取到位置: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);

                    if (this.isMapLoaded) {
                        const selectedMapApi = this.settings.selectedMapApi;

                        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                            this.setCurrentLocationGoogle(lat, lng);
                        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                            this.setCurrentLocationGaode(lat, lng);
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
                    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="12" cy="12" r="8" fill="#27ae60" stroke="white" stroke-width="2"/>
                            <circle cx="12" cy="12" r="3" fill="white"/>
                        </svg>
                    `),
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
                content: `
                    <div style="
                        width: 24px; 
                        height: 24px; 
                        background: #27ae60; 
                        border: 2px solid white; 
                        border-radius: 50%; 
                        display: flex; 
                        align-items: center; 
                        justify-content: center;
                        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                    ">
                        <div style="
                            width: 8px; 
                            height: 8px; 
                            background: white; 
                            border-radius: 50%;
                        "></div>
                    </div>
                `
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
        } else {
            this.showToast('⚠️ 当前地图API不支持卫星图切换');
        }
    }

    // 切换显示/隐藏地点名称
    togglePlaceNames() {
        if (!this.isMapLoaded) return;

        this.showPlaceNames = !this.showPlaceNames;
        const toggleBtn = document.getElementById('toggleNamesBtn');
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
                        }
                    }
                });
                this.pendingMarkers.forEach(m => {
                    if (m.label) {
                        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                            m.label.show();
                        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                            m.label.show();
                        }
                    }
                });
                toggleBtn.textContent = '🏷️ 隐藏名称';
                toggleBtn.title = '隐藏地点名称';
                this.showToast('已显示地点名称');
            } else {
                // 隐藏所有地点名称（包括游玩点和待定点）
                this.placeLabels.forEach(l => {
                    if (l.label) {
                        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                            l.label.hide();
                        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                            l.label.hide();
                        }
                    }
                });
                this.pendingMarkers.forEach(m => {
                    if (m.label) {
                        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                            m.label.hide();
                        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                            m.label.hide();
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
        }
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
    }

    // 创建待定点标记
    createPendingMarkers() {
        // 清除现有的待定点标记
        this.clearPendingMarkers();

        const pendingPlaces = this.travelList.filter(place => place.isPending);
        pendingPlaces.forEach(place => {
            this.addPendingMarker(place);
        });

        // 应用当前的城市过滤（但不调整地图视角）
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
                }
            }
            if (markerData.label) {
                if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                    markerData.label.setMap(null);
                } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                    this.map.remove(markerData.label);
                }
            }
        });
        this.pendingMarkers = [];
    }

    // 添加待定点标记
    addPendingMarker(place) {
        if (!this.isMapLoaded) return;

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
                url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
                    <svg width="40" height="50" viewBox="0 0 40 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <!-- 外层阴影 -->
                        <ellipse cx="20" cy="47" rx="8" ry="3" fill="rgba(0,0,0,0.3)"/>
                        <!-- 主要标记 -->
                        <path d="M20 3C13.4 3 8 8.4 8 15C8 24.75 20 47 20 47C20 47 32 24.75 32 15C32 8.4 26.6 3 20 3Z" fill="#f39c12" stroke="#ffffff" stroke-width="2"/>
                        <!-- 内圆 -->
                        <circle cx="20" cy="15" r="6" fill="#ffffff"/>
                        <!-- 待定图标 -->
                        <text x="20" y="19" text-anchor="middle" font-family="Arial" font-size="10" font-weight="bold" fill="#f39c12">⏳</text>
                    </svg>
                `),
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
        // 使用SVG创建待定点标记
        const pendingMarkerSvg = `
            <svg width="40" height="50" viewBox="0 0 40 50" xmlns="http://www.w3.org/2000/svg">
                <!-- 阴影 -->
                <ellipse cx="20" cy="47" rx="8" ry="3" fill="rgba(0,0,0,0.3)"/>
                <!-- 主要标记 -->
                <path d="M20 3C13.4 3 8 8.4 8 15C8 24.75 20 47 20 47C20 47 32 24.75 32 15C32 8.4 26.6 3 20 3Z" fill="#f39c12" stroke="#ffffff" stroke-width="2"/>
                <!-- 内圆 -->
                <circle cx="20" cy="15" r="6" fill="#ffffff"/>
                <!-- 待定图标 -->
                <text x="20" y="19" text-anchor="middle" font-family="Arial, sans-serif" font-size="10" font-weight="bold" fill="#f39c12">⏳</text>
            </svg>
        `;

        const marker = new AMap.Marker({
            position: [place.lng, place.lat],
            title: `⏳ ${displayName}`,
            content: `
                <div style="
                    position: relative;
                    width: 40px;
                    height: 50px;
                    cursor: pointer;
                ">
                    ${pendingMarkerSvg}
                </div>
            `,
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
            content: `
                <div style="
                    position: absolute;
                    background: linear-gradient(135deg, rgba(255,193,7,0.95) 0%, rgba(255,235,59,0.97) 100%);
                    border: 1px solid rgba(255,193,7,0.9);
                    border-radius: 8px;
                    padding: 6px 10px;
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    font-size: 12px;
                    font-weight: 600;
                    color: #8b5a00;
                    white-space: nowrap;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15), 0 2px 4px rgba(0,0,0,0.1);
                    backdrop-filter: blur(8px);
                    text-shadow: 0 1px 2px rgba(255,255,255,0.8);
                    min-width: 60px;
                    text-align: center;
                    cursor: default;
                    user-select: none;
                    z-index: 600;
                    top: -75px;
                    left: 50%;
                    transform: translateX(-50%);
                    pointer-events: none;
                ">
                    ⏳ ${displayName}
                </div>
            `,
            anchor: 'bottom-center',
            zIndex: 600,
            clickable: false
        });

        this.map.add(labelMarker);
        return labelMarker;
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
        this.cityFilterBtn.innerHTML = '🏙️ 全部城市';
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
        this.travelList.forEach(place => {
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
            this.cityFilterBtn.innerHTML = '🏙️ 全部城市';
        } else {
            this.currentCityFilter = selectedOption;
            this.cityFilterBtn.innerHTML = `🏙️ ${selectedOption}`;
        }

        // 应用过滤
        this.applyyCityFilter();
    }

    // 应用城市过滤
    applyyCityFilter() {
        if (!this.isMapLoaded) return;

        // 隐藏所有标记（游玩点）
        this.markers.forEach(markerObj => {
            this.setMarkerVisible(markerObj.marker, false);
        });

        // 隐藏所有待定点标记
        this.pendingMarkers.forEach(markerObj => {
            this.setMarkerVisible(markerObj.marker, false);
        });

        // 根据过滤条件显示标记
        let visiblePlaces = [];

        if (this.currentCityFilter === 'all') {
            // 显示所有游玩点标记
            this.markers.forEach(markerObj => {
                this.setMarkerVisible(markerObj.marker, true);
            });
            // 显示所有待定点标记（如果当前显示待定点）
            if (this.showPendingPlaces) {
                this.pendingMarkers.forEach(markerObj => {
                    this.setMarkerVisible(markerObj.marker, true);
                });
            }
            visiblePlaces = this.travelList;
        } else {
            // 只显示指定城市的游玩点标记
            this.markers.forEach(markerObj => {
                const city = this.extractCityFromAddress(markerObj.place.address);
                if (city === this.currentCityFilter) {
                    this.setMarkerVisible(markerObj.marker, true);
                    visiblePlaces.push(markerObj.place);
                }
            });
            // 只显示指定城市的待定点标记（如果当前显示待定点）
            if (this.showPendingPlaces) {
                this.pendingMarkers.forEach(markerObj => {
                    const city = this.extractCityFromAddress(markerObj.place.address);
                    if (city === this.currentCityFilter) {
                        this.setMarkerVisible(markerObj.marker, true);
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

        // 隐藏所有标记（游玩点）
        this.markers.forEach(markerObj => {
            this.setMarkerVisible(markerObj.marker, false);
        });

        // 隐藏所有待定点标记
        this.pendingMarkers.forEach(markerObj => {
            this.setMarkerVisible(markerObj.marker, false);
        });

        // 根据过滤条件显示标记
        let visiblePlaces = [];

        if (this.currentCityFilter === 'all') {
            // 显示所有游玩点标记
            this.markers.forEach(markerObj => {
                this.setMarkerVisible(markerObj.marker, true);
            });
            // 显示所有待定点标记（如果当前显示待定点）
            if (this.showPendingPlaces) {
                this.pendingMarkers.forEach(markerObj => {
                    this.setMarkerVisible(markerObj.marker, true);
                });
            }
            visiblePlaces = this.travelList;
        } else {
            // 只显示指定城市的游玩点标记
            this.markers.forEach(markerObj => {
                const city = this.extractCityFromAddress(markerObj.place.address);
                if (city === this.currentCityFilter) {
                    this.setMarkerVisible(markerObj.marker, true);
                    visiblePlaces.push(markerObj.place);
                }
            });
            // 只显示指定城市的待定点标记（如果当前显示待定点）
            if (this.showPendingPlaces) {
                this.pendingMarkers.forEach(markerObj => {
                    const city = this.extractCityFromAddress(markerObj.place.address);
                    if (city === this.currentCityFilter) {
                        this.setMarkerVisible(markerObj.marker, true);
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
        console.log('检测到的城市:', cities);
        console.log('当前游玩列表:', this.travelList.map(place => ({
            name: place.name,
            address: place.address,
            extractedCity: this.extractCityFromAddress(place.address)
        })));

        if (cities.length <= 1) {
            // 如果只有一个城市或没有城市，仍然显示按钮但禁用
            this.cityFilterBtn.style.display = 'block';
            this.cityFilterBtn.disabled = true;
            this.cityFilterBtn.innerHTML = `🏙️ ${cities.length === 0 ? '无城市' : cities[0]}`;
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
                this.cityFilterBtn.innerHTML = '🏙️ 全部城市';
                this.applyyCityFilter();
            }
        }
    }

    // 重新创建所有标记
    recreateMarkers() {
        if (!this.isMapLoaded) return;

        const selectedMapApi = this.settings.selectedMapApi;

        // 清除现有标记但不清除路线
        this.markers.forEach(m => {
            if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                m.marker.setMap(null);
            } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                this.map.remove(m.marker);
            }
        });
        this.markers = [];

        // 清除现有标签
        this.placeLabels.forEach(l => {
            if (l.label) {
                if (selectedMapApi === 'google' && typeof google !== 'undefined') {
                    l.label.setMap(null);
                } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
                    this.map.remove(l.label);
                }
            }
        });
        this.placeLabels = [];

        // 只为激活状态的地点创建新标记
        const activePlaces = this.travelList.filter(place => !place.isPending);
        activePlaces.forEach(place => {
            this.addMarker(place);
        });

        // 如果当前显示待定点，重新创建待定点标记
        if (this.showPendingPlaces) {
            this.createPendingMarkers();
        }

        // 应用当前的城市过滤（不调整地图视角）
        this.applyCityFilterWithoutFitting();
    }

    // 调整地图视野以适应指定的地点
    fitMapToPlaces(places) {
        if (!this.isMapLoaded || places.length === 0) return;

        const selectedMapApi = this.settings.selectedMapApi;
        console.log(`📐 调整地图视野：${places.length}个地点，使用${selectedMapApi}`);

        if (selectedMapApi === 'google' && typeof google !== 'undefined') {
            this.fitMapToPlacesGoogle(places);
        } else if (selectedMapApi === 'gaode' && typeof AMap !== 'undefined') {
            this.fitMapToPlacesGaode(places);
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

    // 清空所有地点
    clearAllPlaces() {
        if (this.travelList.length === 0) return;

        if (confirm('确定要清空所有游玩地点和待定地点吗？')) {
            this.travelList = [];
            this.currentSchemeId = null; // 清空当前方案标识
            this.currentSchemeName = null;
            this.hasUnsavedChanges = false; // 清空后重置为未修改状态
            this.updatePageTitle(); // 更新页面标题
            this.updateTravelList();
            this.updateDistanceSummary(0, 0);
            this.drawRoute(); // 清空后确保路线也被清除
            this.clearMarkers();
            this.saveData();
            this.loadSavedSchemes(); // 刷新方案列表显示
        }
    }

    // 优化路线（简单的贪心算法）
    optimizeRoute() {
        const activePlaces = this.travelList.filter(place => !place.isPending);
        const nonBlankActivePlaces = activePlaces.filter(place => !place.isBlank && place.lat && place.lng);
        const blankPlaces = activePlaces.filter(place => place.isBlank);
        const pendingPlaces = this.travelList.filter(place => place.isPending);

        if (nonBlankActivePlaces.length < 3) {
            alert('至少需要3个非空白的激活状态地点才能优化路线');
            return;
        }

        if (confirm('优化路线将重新排列非空白游玩点的顺序（不影响空白地点和待定列表），是否继续？')) {
            const optimized = this.greedyTSP(nonBlankActivePlaces);

            // 创建新的游玩列表：保持空白地点在原位置，优化后的非空白地点按新顺序排列
            const newTravelList = [];
            let optimizedIndex = 0;

            // 遍历原列表，保持空白地点位置，替换非空白地点
            activePlaces.forEach(place => {
                if (place.isBlank) {
                    // 空白地点保持原位置
                    newTravelList.push(place);
                } else if (place.lat && place.lng) {
                    // 非空白地点使用优化后的顺序
                    newTravelList.push(optimized[optimizedIndex]);
                    optimizedIndex++;
                }
            });

            // 重新组合：优化后的游玩地点 + 待定地点
            this.travelList = [...newTravelList, ...pendingPlaces];
            this.updateTravelList();
            this.calculateDistancesWithDebounce();
            this.drawRoute();
            this.saveData();
            this.markAsModified(); // 标记为已修改
            alert('路线已优化！空白地点位置保持不变。');
        }
    }

    // 贪心算法求解TSP问题（简化版）
    greedyTSP(places) {
        if (places.length <= 2) return places;

        const result = [places[0]];
        const remaining = places.slice(1);

        while (remaining.length > 0) {
            const current = result[result.length - 1];
            let nearest = 0;
            let minDistance = Infinity;

            for (let i = 0; i < remaining.length; i++) {
                const distance = this.calculateStraightDistance(
                    current.lat, current.lng,
                    remaining[i].lat, remaining[i].lng
                );
                if (distance < minDistance) {
                    minDistance = distance;
                    nearest = i;
                }
            }

            result.push(remaining.splice(nearest, 1)[0]);
        }

        return result;
    }

    // 保存数据到本地存储
    saveData() {
        localStorage.setItem('travelPlannerData', JSON.stringify({
            travelList: this.travelList,
            routeSegments: Array.from(this.routeSegments.entries()),
            settings: this.settings,
            currentSchemeId: this.currentSchemeId,
            currentSchemeName: this.currentSchemeName,
            lastSaved: new Date().toISOString()
        }));
    }

    // 加载已保存的数据（设置已在前面单独加载）
    loadSavedData() {
        try {
            const saved = localStorage.getItem('travelPlannerData');
            if (saved) {
                const data = JSON.parse(saved);
                this.travelList = data.travelList || [];

                // 为旧数据添加默认的isPending字段
                this.travelList.forEach(place => {
                    if (place.isPending === undefined) {
                        place.isPending = false;
                    }
                });

                // 恢复路线段配置
                if (data.routeSegments) {
                    this.routeSegments = new Map(data.routeSegments);
                }

                // 恢复当前方案信息
                this.currentSchemeId = data.currentSchemeId || null;
                this.currentSchemeName = data.currentSchemeName || null;

                // 更新页面标题
                this.updatePageTitle();

                this.updateTravelList();
                this.calculateDistancesWithDebounce();

                // 重新添加标记和绘制路线
                this.travelList.forEach(place => this.addMarker(place));
                if (this.travelList.length >= 2) {
                    this.drawRoute();
                }

                // 更新待定点按钮状态（不重置状态）
                this.updateTogglePendingButton();

                // 确保城市过滤按钮状态正确
                this.updateCityFilterButton();

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

        if (this.travelList.length === 0) {
            this.showToast('当前没有游玩地点可保存');
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
            settings: { ...this.settings }, // 保存当前设置
            createdAt: createdAt,
            modifiedAt: createdAt, // 创建时修改时间等于创建时间
            placesCount: this.travelList.length,
            version: '2.0' // 方案格式版本
        };

        // 移除同名方案（如果存在）
        const filteredSchemes = schemes.filter(scheme => scheme.name !== schemeName);
        filteredSchemes.push(newScheme);

        localStorage.setItem('travelSchemes', JSON.stringify(filteredSchemes));

        // 将新保存的方案设为当前方案
        this.currentSchemeId = newScheme.id;
        this.currentSchemeName = schemeName;
        this.hasUnsavedChanges = false; // 重置未保存状态
        this.updatePageTitle(); // 更新页面标题

        // 保存数据，包括当前方案信息
        this.saveData();

        this.showToast(`方案"${schemeName}"保存成功并已设为当前方案`);

        document.getElementById('schemeNameInput').value = '';
        this.loadSavedSchemes();
    }

    // 获取已保存的方案
    getSavedSchemes() {
        try {
            const schemes = localStorage.getItem('travelSchemes');
            let parsedSchemes = schemes ? JSON.parse(schemes) : [];

            // 为旧方案添加UUID（如果没有的话）
            let needsUpdate = false;
            parsedSchemes = parsedSchemes.map(scheme => {
                if (!scheme.uuid) {
                    // 为旧方案生成基于名称和创建时间的UUID
                    const createdAt = scheme.createdAt || new Date().toISOString();
                    scheme.uuid = this.generateSchemeUUID(scheme.name, createdAt);
                    scheme.version = scheme.version || '1.0';
                    // 如果没有修改时间，设置为创建时间
                    if (!scheme.modifiedAt) {
                        scheme.modifiedAt = createdAt;
                    }
                    needsUpdate = true;
                }

                // 为旧地点添加默认的isPending状态
                if (scheme.travelList && Array.isArray(scheme.travelList)) {
                    scheme.travelList.forEach(place => {
                        if (place.isPending === undefined) {
                            place.isPending = false;
                            needsUpdate = true;
                        }
                    });
                }

                return scheme;
            });

            // 如果有方案被更新，保存回localStorage
            if (needsUpdate) {
                localStorage.setItem('travelSchemes', JSON.stringify(parsedSchemes));
                console.log('✅ 为现有方案添加了UUID标识');
            }

            return parsedSchemes;
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
            container.innerHTML = '<div class="empty-schemes">暂无保存的方案</div>';
            return;
        }

        // 按创建时间倒序排列
        schemes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        container.innerHTML = schemes.map(scheme => {
            const createdDate = new Date(scheme.createdAt).toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });

            // 计算游玩列表和待定列表的个数
            const activePlaces = scheme.travelList ? scheme.travelList.filter(place => !place.isPending) : [];
            const pendingPlaces = scheme.travelList ? scheme.travelList.filter(place => place.isPending) : [];
            const activeCount = activePlaces.length;
            const pendingCount = pendingPlaces.length;
            const totalCount = activeCount + pendingCount;

            // 格式化修改时间
            const modifiedDate = scheme.modifiedAt ? new Date(scheme.modifiedAt).toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            }) : createdDate;

            const isCurrentScheme = this.currentSchemeId === scheme.id;
            const schemeItemClass = isCurrentScheme ? 'scheme-item current-scheme' : 'scheme-item';
            const loadButtonText = isCurrentScheme ? '当前' : '切换';
            const loadButtonClass = isCurrentScheme ? 'scheme-btn current-scheme-btn' : 'scheme-btn load-scheme-btn';

            // 构建详细信息
            const detailInfo = [];
            if (activeCount > 0) detailInfo.push(`${activeCount}个游玩`);
            if (pendingCount > 0) detailInfo.push(`${pendingCount}个待定`);
            if (detailInfo.length === 0) detailInfo.push('无地点');

            return `
                <div class="${schemeItemClass}">
                    <div class="scheme-info">
                        <div class="scheme-name">
                            ${isCurrentScheme ? '📌 ' : ''}${scheme.name}
                            ${isCurrentScheme ? ' <span class="current-badge">当前方案</span>' : ''}
                        </div>
                        <div class="scheme-date">
                            <div class="scheme-time-info">
                                <span class="created-time">📅 创建：${createdDate}</span>
                                ${scheme.modifiedAt && scheme.modifiedAt !== scheme.createdAt ?
                    `<span class="modified-time">✏️ 修改：${modifiedDate}</span>` : ''}
                            </div>
                            <div class="scheme-counts">
                                <span class="places-info">📍 ${detailInfo.join('，')}</span>
                                <span class="total-info">（共${totalCount}个地点）</span>
                            </div>
                        </div>
                    </div>
                    <div class="scheme-actions">
                        <button class="${loadButtonClass}" onclick="app.loadScheme(${scheme.id})" ${isCurrentScheme ? 'disabled' : ''}>${loadButtonText}</button>
                        <button class="scheme-btn delete-scheme-btn" onclick="app.deleteScheme(${scheme.id})">删除</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    // 加载方案
    loadScheme(schemeId) {
        const schemes = this.getSavedSchemes();
        const scheme = schemes.find(s => s.id === schemeId);

        if (!scheme) {
            this.showToast('方案不存在');
            return;
        }

        // 检查是否有未保存的更改
        if (this.hasUnsavedChanges && this.travelList.length > 0) {
            this.showUnsavedChangesDialog(schemeId, scheme.name);
            return;
        }

        // 执行实际的方案加载
        this.performSchemeLoad(schemeId, scheme);
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
        // 保存当前方案标识
        this.currentSchemeId = schemeId;
        this.currentSchemeName = scheme.name;
        this.hasUnsavedChanges = false; // 重置未保存状态
        this.updatePageTitle(); // 更新页面标题

        // 直接清除当前数据并加载新方案
        this.travelList = [];
        this.updateTravelList();
        this.updateDistanceSummary(0, 0);
        this.clearMarkers();

        // 加载方案数据
        this.travelList = [...scheme.travelList];
        this.routeSegments.clear();
        scheme.routeSegments.forEach(([key, value]) => {
            this.routeSegments.set(key, value);
        });

        // 更新界面
        this.updateTravelList();
        this.calculateDistancesWithDebounce();

        // 重新创建标记
        this.clearMarkers();
        this.travelList.forEach(place => this.addMarker(place));
        this.drawRoute();

        // 更新待定点按钮状态（不重置状态）
        this.updateTogglePendingButton();

        // 强制更新地图到新方案区域
        this.updateMapToCurrentScheme();

        this.showToast(`已切换到方案"${scheme.name}"`);
        this.closeSaveSchemeModal();

        // 保存数据，包括当前方案信息
        this.saveData();

        // 更新方案列表显示当前方案
        setTimeout(() => this.loadSavedSchemes(), 100);
    }

    // 删除方案
    deleteScheme(schemeId) {
        const schemes = this.getSavedSchemes();
        const scheme = schemes.find(s => s.id === schemeId);

        if (!scheme) {
            this.showToast('方案不存在');
            return;
        }

        if (!confirm(`确定删除方案"${scheme.name}"吗？此操作不可恢复。`)) {
            return;
        }

        // 如果删除的是当前方案，清空当前方案标识
        if (this.currentSchemeId === schemeId) {
            this.currentSchemeId = null;
            this.currentSchemeName = null;
            this.hasUnsavedChanges = this.travelList.length > 0; // 如果有数据则标记为未保存
            this.updatePageTitle(); // 更新页面标题
            this.saveData(); // 保存更新后的状态
        }

        const filteredSchemes = schemes.filter(s => s.id !== schemeId);
        localStorage.setItem('travelSchemes', JSON.stringify(filteredSchemes));

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
            const filteredPlaces = this.travelList.filter(place => {
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

        // 获取所有保存的方案
        const allSchemes = this.getSavedSchemes();

        // 创建包含所有方案的备份数据
        const backupData = {
            version: '2.0', // 升级版本号以支持多方案
            exportDate: new Date().toISOString(),
            type: 'full-backup', // 标识这是完整备份
            currentData: {
                travelList: this.travelList,
                routeSegments: Array.from(this.routeSegments.entries()),
                settings: this.settings,
                currentSchemeId: this.currentSchemeId,
                currentSchemeName: this.currentSchemeName
            },
            schemes: allSchemes, // 包含所有保存的方案
            totalSchemes: allSchemes.length,
            totalPlaces: this.travelList.length,
            allCities: this.getAllCities(),
            exportSource: '17旅游规划助手',
            formatDescription: '此文件包含所有保存的旅游方案，可导入到17旅游规划助手中'
        };

        const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json;charset=utf-8' });
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
        if (data.version === '2.0' && data.type === 'full-backup') {
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
        // 验证必要字段
        if (!data.schemes || !Array.isArray(data.schemes)) {
            this.showToast('备份文件中缺少方案数据');
            return;
        }

        // 验证每个方案的数据完整性
        for (let scheme of data.schemes) {
            if (!scheme.name || !scheme.travelList || !Array.isArray(scheme.travelList)) {
                this.showToast('备份文件中的方案数据不完整');
                return;
            }

            // 验证方案中的地点数据
            for (let place of scheme.travelList) {
                if (!place.id || !place.name || !place.address ||
                    typeof place.lat !== 'number' || typeof place.lng !== 'number') {
                    this.showToast('备份文件中的地点数据不完整');
                    return;
                }
            }
        }

        // 检查方案冲突
        this.checkSchemeConflicts(data);
    }

    // 验证并导入单个方案（旧格式）
    validateAndImportSingleScheme(data) {
        // 验证每个地点的数据完整性
        for (let place of data.travelList) {
            if (!place.id || !place.name || !place.address ||
                typeof place.lat !== 'number' || typeof place.lng !== 'number') {
                this.showToast('备份文件中的地点数据不完整');
                return;
            }
        }

        // 确认导入
        const confirmMessage = `即将导入 ${data.travelList.length} 个游玩地点，这将替换当前所有数据。是否继续？`;
        if (!confirm(confirmMessage)) {
            return;
        }

        // 执行导入
        this.importTravelData(data);
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

        // 显示模态框
        document.getElementById('conflictResolutionModal').style.display = 'block';
    }

    // 创建冲突解决界面
    createConflictResolutionUI(conflicts) {
        const container = document.getElementById('conflictList');

        container.innerHTML = conflicts.map((conflict, index) => {
            const importScheme = conflict.importScheme;
            const existingScheme = conflict.existingScheme;

            return `
                <div class="conflict-item">
                    <div class="conflict-header">
                        <h4>冲突 ${index + 1}: "${importScheme.name}"</h4>
                                                <div class="conflict-type ${conflict.conflictType === 'version' ?
                    (conflict.isIdentical ? 'version-identical' : (conflict.isNewer ? 'version-newer' : 'version-older')) :
                    'name-conflict'}">
                            ${conflict.conflictType === 'version' ?
                    (conflict.isIdentical ? '🔄 完全相同' : (conflict.isNewer ? '⬆️ 版本更新' : '⬇️ 版本较旧')) :
                    '📝 同名方案'}
                        </div>
                    </div>
                    
                    <div class="conflict-details">
                        <div class="scheme-comparison">
                            <div class="scheme-info existing">
                                <h5>现有方案</h5>
                                <p><strong>名称:</strong> ${existingScheme.name}</p>
                                <p><strong>地点数:</strong> ${existingScheme.placesCount}</p>
                                <p><strong>创建时间:</strong> ${new Date(existingScheme.createdAt).toLocaleString('zh-CN')}</p>
                                ${existingScheme.modifiedAt ? `<p><strong>修改时间:</strong> ${new Date(existingScheme.modifiedAt).toLocaleString('zh-CN')}</p>` : ''}
                            </div>
                            
                            <div class="scheme-info importing">
                                <h5>要导入的方案</h5>
                                <p><strong>名称:</strong> ${importScheme.name}</p>
                                <p><strong>地点数:</strong> ${importScheme.placesCount}</p>
                                <p><strong>创建时间:</strong> ${new Date(importScheme.createdAt).toLocaleString('zh-CN')}</p>
                                ${importScheme.modifiedAt ? `<p><strong>修改时间:</strong> ${new Date(importScheme.modifiedAt).toLocaleString('zh-CN')}</p>` : ''}
                            </div>
                        </div>
                    </div>
                    
                    <div class="conflict-resolution">
                        <h5>选择处理方式:</h5>
                        <div class="resolution-options">
                            ${conflict.conflictType === 'version' ? `
                                ${conflict.isIdentical ? `
                                    <label>
                                        <input type="radio" name="resolution_${index}" value="skip" checked />
                                        <span>跳过此方案（推荐）</span>
                                    </label>
                                    <label>
                                        <input type="radio" name="resolution_${index}" value="both" />
                                        <span>保留副本</span>
                                    </label>
                                ` : `
                                    <label>
                                        <input type="radio" name="resolution_${index}" value="update" ${conflict.isNewer ? 'checked' : ''} />
                                        <span>${conflict.isNewer ? '更新到新版本（推荐）' : '更新到此版本'}</span>
                                    </label>
                                    <label>
                                        <input type="radio" name="resolution_${index}" value="keep" ${!conflict.isNewer ? 'checked' : ''} />
                                        <span>保留现有版本</span>
                                    </label>
                                    <label>
                                        <input type="radio" name="resolution_${index}" value="both" />
                                        <span>同时保留两个版本</span>
                                    </label>
                                `}
                            ` : `
                                <label>
                                    <input type="radio" name="resolution_${index}" value="overwrite" />
                                    <span>覆盖现有方案</span>
                                </label>
                                <label>
                                    <input type="radio" name="resolution_${index}" value="rename" checked />
                                    <span>重命名导入（推荐）</span>
                                </label>
                                <label>
                                    <input type="radio" name="resolution_${index}" value="skip" />
                                    <span>跳过此方案</span>
                                </label>
                            `}
                        </div>
                        
                        <div class="rename-input" id="renameInput_${index}" ${conflict.conflictType === 'version' ? 'style="display: none;"' : ''}>
                            <div class="rename-header">
                                <div class="rename-label">冲突方案重命名为：</div>
                                <div class="rename-warning" id="renameWarning_${index}" style="display: none;">
                                    ⚠️ 名称已存在
                                </div>
                            </div>
                            <input type="text" placeholder="输入新名称..." 
                                   value="${importScheme.name} (导入)" 
                                   id="newName_${index}" />
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        // 添加事件监听器
        container.querySelectorAll('input[type="radio"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                const index = e.target.name.split('_')[1];
                const renameInput = document.getElementById(`renameInput_${index}`);

                if (e.target.value === 'rename' || e.target.value === 'both') {
                    renameInput.style.display = 'block';
                    if (e.target.value === 'both') {
                        // 为版本冲突的"同时保留"选项设置不同的默认名称
                        const newNameInput = document.getElementById(`newName_${index}`);
                        const conflicts = document.querySelectorAll('.conflict-item');
                        const conflictItem = conflicts[index];
                        const schemeName = conflictItem.querySelector('h4').textContent.match(/"([^"]+)"/)[1];
                        const currentTime = new Date().toLocaleDateString('zh-CN');
                        newNameInput.value = `${schemeName} (${currentTime})`;
                    }
                    // 添加输入检查事件监听器
                    const newNameInput = document.getElementById(`newName_${index}`);
                    this.addRenameInputListener(newNameInput, index);
                } else {
                    renameInput.style.display = 'none';
                }
            });
        });

        // 为已显示的重命名输入框添加监听器
        container.querySelectorAll('.rename-input').forEach((renameInput, index) => {
            if (renameInput.style.display !== 'none') {
                const newNameInput = document.getElementById(`newName_${index}`);
                if (newNameInput) {
                    this.addRenameInputListener(newNameInput, index);
                }
            }
        });
    }

    // 导入旅游数据（旧格式）
    importTravelData(data) {
        try {
            // 清除当前数据
            this.travelList = [];
            this.updateTravelList();
            this.updateDistanceSummary(0, 0);
            this.clearMarkers();

            // 导入新数据
            this.travelList = [...data.travelList];

            // 恢复路线段配置
            this.routeSegments.clear();
            if (data.routeSegments && Array.isArray(data.routeSegments)) {
                data.routeSegments.forEach(([key, value]) => {
                    this.routeSegments.set(key, value);
                });
            }

            // 更新界面
            this.updateTravelList();
            this.calculateDistancesWithDebounce();

            // 重新创建标记和路线
            this.travelList.forEach(place => this.addMarker(place));
            this.drawRoute();

            // 更新待定点按钮状态（不重置状态）
            this.updateTogglePendingButton();

            // 保存数据
            this.saveData();

            // 清空当前方案状态（因为导入的是新数据）
            this.currentSchemeId = null;
            this.currentSchemeName = null;
            this.hasUnsavedChanges = true; // 导入后标记为未保存
            this.updatePageTitle(); // 更新页面标题

            // 显示成功消息
            this.showToast(`成功导入 ${data.travelList.length} 个游玩地点`);
            this.closeImportModal();

            // 重新加载方案列表
            this.loadSavedSchemes();

            console.log('数据导入成功:', {
                places: data.travelList.length,
                cities: data.cities?.length || this.getAllCities().length,
                exportDate: data.exportDate
            });

        } catch (error) {
            console.error('数据导入失败:', error);
            this.showToast('导入失败，请检查文件格式');
        }
    }

    // 导入完整备份（新格式）
    importFullBackup(importData) {
        try {
            const existingSchemes = this.getSavedSchemes();
            const importedSchemes = [];
            const skippedSchemes = [];

            // 处理每个方案
            for (let importScheme of importData.schemes) {
                // 检查是否有冲突解决方案（只在有冲突时才存在）
                const resolution = this.conflictResolutions.get(importScheme.uuid || importScheme.name);

                if (resolution === 'skip' || resolution === 'keep') {
                    if (resolution === 'skip') {
                        skippedSchemes.push(importScheme.name);
                    }
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
                    const originalUUID = importScheme.uuid;
                    importScheme.name = newName;
                    // 重新生成UUID以避免冲突
                    const createdAt = importScheme.createdAt || new Date().toISOString();
                    importScheme.uuid = this.generateSchemeUUID(newName, createdAt);
                    // 生成新的ID以避免冲突
                    importScheme.id = this.generateUniqueSchemeId();
                }

                // 处理覆盖或更新
                if (resolution === 'overwrite' || resolution === 'update') {
                    // 找到要覆盖的方案并移除
                    const existingIndex = existingSchemes.findIndex(existing =>
                        existing.name === importScheme.name ||
                        (existing.uuid === importScheme.uuid && !resolution.startsWith('rename:') && !resolution.startsWith('both:'))
                    );
                    if (existingIndex !== -1) {
                        existingSchemes.splice(existingIndex, 1);
                    }
                } else {
                    // 对于其他情况（直接导入），也生成新的ID以避免冲突
                    importScheme.id = this.generateUniqueSchemeId();
                }

                importedSchemes.push(importScheme);
            }

            // 合并方案
            const allSchemes = [...existingSchemes, ...importedSchemes];
            localStorage.setItem('travelSchemes', JSON.stringify(allSchemes));

            // 导入当前数据（如果有）
            if (importData.currentData && importData.currentData.travelList) {
                this.travelList = [];
                this.updateTravelList();
                this.updateDistanceSummary(0, 0);
                this.clearMarkers();

                // 导入当前数据
                this.travelList = [...importData.currentData.travelList];

                // 恢复路线段配置
                this.routeSegments.clear();
                if (importData.currentData.routeSegments && Array.isArray(importData.currentData.routeSegments)) {
                    importData.currentData.routeSegments.forEach(([key, value]) => {
                        this.routeSegments.set(key, value);
                    });
                }

                // 更新界面
                this.updateTravelList();
                this.calculateDistancesWithDebounce();

                // 重新创建标记和路线
                this.travelList.forEach(place => this.addMarker(place));
                this.drawRoute();

                // 保存数据
                this.saveData();
            }

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
                message += `，当前显示 ${importData.currentData.travelList.length} 个地点`;
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
            this.showToast('导入失败，请检查文件格式');
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
            warning.style.display = 'none';
            saveBtn.disabled = true;
            return;
        }

        if (!this.validateSchemeName(schemeName)) {
            // 名称重复
            warning.style.display = 'block';
            saveBtn.disabled = true;
        } else {
            // 名称可用
            warning.style.display = 'none';
            saveBtn.disabled = false;
        }
    }

    // 处理冲突解决
    processConflictResolution() {
        const conflicts = document.querySelectorAll('.conflict-item');
        this.conflictResolutions.clear();

        for (let i = 0; i < conflicts.length; i++) {
            const selectedRadio = document.querySelector(`input[name="resolution_${i}"]:checked`);
            if (!selectedRadio) continue;

            const resolution = selectedRadio.value;
            const conflictItem = conflicts[i];
            const schemeName = conflictItem.querySelector('h4').textContent.match(/"([^"]+)"/)[1];

            // 从冲突数据中获取UUID
            const conflictData = this.pendingImportData.schemes.find(scheme => scheme.name === schemeName);
            const schemeKey = conflictData ? conflictData.uuid : schemeName;

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
        document.getElementById('conflictResolutionModal').style.display = 'none';
        this.pendingImportData = null;
        this.conflictResolutions.clear();
        // 确保导入模态框也被关闭
        this.closeImportModal();
    }

    // 截取地图截图
    async captureMapScreenshot() {
        console.log('📸 ===== 开始地图截图流程 =====');

        try {
            // 方法1: 简化的html2canvas截图
            const html2canvasResult = await this.tryHtml2canvasScreenshot();
            if (html2canvasResult) {
                console.log('✅ html2canvas截图成功');
                return html2canvasResult;
            }

            // 方法2: 尝试Google Maps静态地图（如果有API key）
            const googleApiKey = this.getApiKey('google');
            if (googleApiKey && googleApiKey.length > 10) {
                console.log('🎯 尝试生成Google Maps静态地图...');
                const staticMapResult = await this.generateStaticMapImage();
                if (staticMapResult) {
                    console.log('✅ Google Maps静态地图生成成功');
                    return staticMapResult;
                }
            }

            // 方法3: 生成基于文本的地图占位符
            console.log('🎯 生成文本地图占位符...');
            const textMapResult = this.generateTextMapPlaceholder();
            if (textMapResult) {
                console.log('✅ 文本地图占位符生成成功');
                return textMapResult;
            }

            console.log('❌ 所有截图方法都失败了');
            return null;

        } catch (error) {
            console.error('❌ 截图过程发生错误:', error);
            return null;
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
            if (this.travelList.length === 0) {
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
            ctx.fillText(`共 ${this.travelList.length} 个游玩点`, 400, 80);

            // 游玩点列表
            ctx.textAlign = 'left';
            ctx.fillStyle = '#2c3e50';
            ctx.font = '18px Arial, sans-serif';

            const startY = 120;
            const lineHeight = 35;
            const maxItemsPerColumn = 12;
            const columnWidth = 380;

            this.travelList.forEach((place, index) => {
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
            if (this.travelList.length > 24) {
                ctx.fillStyle = '#95a5a6';
                ctx.font = '14px Arial, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(`还有 ${this.travelList.length - 24} 个游玩点...`, 400, 540);
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

    // 生成Google Maps静态地图
    async generateStaticMapImage() {
        try {
            if (this.travelList.length === 0) {
                console.log('📍 无游玩点，跳过静态地图生成');
                return null;
            }

            // 计算地图中心点和缩放级别
            const bounds = this.calculateMapBounds();
            if (!bounds) {
                console.log('📏 无法计算地图边界');
                return null;
            }

            const center = bounds.center;
            const zoom = Math.min(Math.max(bounds.zoom, 8), 15); // 限制缩放级别

            // 构建标记参数
            const markers = this.travelList.map((place, index) => {
                const label = String.fromCharCode(65 + (index % 26)); // A, B, C...
                return `markers=color:red%7Clabel:${label}%7C${place.lat},${place.lng}`;
            }).join('&');

            // 构建路径参数（如果有多个点）
            let pathParam = '';
            if (this.travelList.length > 1) {
                const pathPoints = this.travelList.map(place => `${place.lat},${place.lng}`).join('|');
                pathParam = `&path=color:0x0000ff|weight:3|${pathPoints}`;
            }

            // 获取Google API密钥
            const googleApiKey = this.getApiKey('google');

            // 构建静态地图URL
            if (!googleApiKey) {
                console.warn('⚠️ 未配置Google Maps API密钥，无法生成静态地图');
                return null;
            }

            const staticMapUrl = `https://maps.googleapis.com/maps/api/staticmap?` +
                `center=${center.lat},${center.lng}` +
                `&zoom=${zoom}` +
                `&size=800x600` +
                `&maptype=roadmap` +
                `&${markers}` +
                `${pathParam}` +
                `&key=${googleApiKey}`;

            console.log('🌐 静态地图URL构建完成');

            // 尝试加载静态地图
            return new Promise((resolve) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';

                img.onload = () => {
                    try {
                        // 将图片转换为base64
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0);
                        const dataURL = canvas.toDataURL('image/png', 0.9);
                        console.log('✅ 静态地图转换成功');
                        resolve(dataURL);
                    } catch (error) {
                        console.error('❌ 静态地图转换失败:', error);
                        resolve(null);
                    }
                };

                img.onerror = () => {
                    console.error('❌ 静态地图加载失败');
                    resolve(null);
                };

                // 设置超时
                setTimeout(() => {
                    console.warn('⏰ 静态地图加载超时');
                    resolve(null);
                }, 10000);

                img.src = staticMapUrl;
            });

        } catch (error) {
            console.error('❌ 静态地图生成失败:', error);
            return null;
        }
    }

    // 计算地图边界和缩放级别
    calculateMapBounds() {
        if (this.travelList.length === 0) return null;

        if (this.travelList.length === 1) {
            return {
                center: { lat: this.travelList[0].lat, lng: this.travelList[0].lng },
                zoom: 14
            };
        }

        // 计算边界
        let minLat = this.travelList[0].lat;
        let maxLat = this.travelList[0].lat;
        let minLng = this.travelList[0].lng;
        let maxLng = this.travelList[0].lng;

        this.travelList.forEach(place => {
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

        // 如果没有游玩点，直接返回
        if (this.travelList.length === 0) {
            console.log('❌ 没有游玩点，跳过地图准备');
            return;
        }

        // 截图时优先显示所有游玩点，除非用户明确只想要某个城市的截图
        let placesToShow = this.travelList;

        // 只有在有城市过滤且确实需要过滤时才使用过滤
        if (this.currentCityFilter && this.currentCityFilter !== 'all') {
            const filteredPlaces = this.travelList.filter(place => {
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
        return new Promise((resolve, reject) => {
            if (typeof html2canvas !== 'undefined') {
                resolve();
                return;
            }

            // 多个CDN备选源
            const cdnSources = [
                'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
                'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js',
                'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
            ];

            let currentIndex = 0;

            const tryLoadNext = () => {
                if (currentIndex >= cdnSources.length) {
                    reject(new Error('所有CDN源都加载失败'));
                    return;
                }

                console.log(`📦 尝试从CDN ${currentIndex + 1}/${cdnSources.length} 加载html2canvas...`);

                const script = document.createElement('script');
                script.src = cdnSources[currentIndex];

                // 设置超时
                const timeout = setTimeout(() => {
                    console.warn(`⏰ CDN ${currentIndex + 1} 加载超时`);
                    script.remove();
                    currentIndex++;
                    tryLoadNext();
                }, 10000); // 10秒超时

                script.onload = () => {
                    clearTimeout(timeout);
                    console.log(`✅ html2canvas从CDN ${currentIndex + 1} 加载成功`);
                    // 验证html2canvas确实可用
                    if (typeof html2canvas !== 'undefined') {
                        resolve();
                    } else {
                        console.warn(`⚠️ CDN ${currentIndex + 1} 脚本加载但html2canvas未定义`);
                        currentIndex++;
                        tryLoadNext();
                    }
                };

                script.onerror = () => {
                    clearTimeout(timeout);
                    console.warn(`❌ CDN ${currentIndex + 1} 加载失败`);
                    currentIndex++;
                    tryLoadNext();
                };

                document.head.appendChild(script);
            };

            tryLoadNext();
        });
    }

    // 生成分享用的HTML文件
    generateShareHTML(mapScreenshot = null) {
        const cities = this.getAllCities();
        const currentDate = new Date().toLocaleDateString('zh-CN');

        let totalDistance = 0;
        let totalTime = 0;

        // 计算总距离和时间
        const distanceEl = document.getElementById('totalDistance');
        const timeEl = document.getElementById('estimatedTime');
        if (distanceEl && timeEl) {
            const distanceText = distanceEl.textContent.replace(/[^0-9.]/g, '');
            const timeText = timeEl.textContent.replace(/[^0-9.]/g, '');
            totalDistance = parseFloat(distanceText) || 0;
            totalTime = parseFloat(timeText) || 0;
        }

        // 构建地图区域HTML
        const currentFilter = this.currentCityFilter;
        const mapTitle = currentFilter && currentFilter !== 'all' ?
            `🗺️ ${currentFilter} - 路线地图` : '🗺️ 完整路线地图';
        const mapDescription = currentFilter && currentFilter !== 'all' ?
            `显示 ${currentFilter} 地区的游玩点和路线` : '显示所有游玩点和完整路线';

        const mapSection = mapScreenshot ? `
        <div class="map-section">
            <h2>${mapTitle}</h2>
            <p class="map-description">${mapDescription}</p>
            <div class="map-container">
                <img src="${mapScreenshot}" alt="旅游路线地图" class="map-image">
            </div>
            <p class="map-note">📍 高清地图截图 | 🔴 红色标记：游玩点 | 🌈 多彩路线：每段使用不同颜色便于区分</p>
        </div>` : `
        <div class="map-section">
            <h2>${mapTitle}</h2>
            <p class="map-description">${mapDescription}</p>
            <div class="map-placeholder">
                <div class="placeholder-icon">🗺️</div>
                <p>地图截图生成失败</p>
                <p>请在原网页中查看完整地图</p>
            </div>
        </div>`;

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>我的旅游计划 - ${currentDate}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6; color: #333; background: #f8f9fa; min-height: 100vh;
        }
        .container { width: 100%; margin: 0 auto; padding: 20px; }
        .header { 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white; padding: 30px; border-radius: 15px; text-align: center; margin-bottom: 30px;
        }
        .header h1 { font-size: 2.5rem; margin-bottom: 10px; }
        .header p { font-size: 1.1rem; opacity: 0.9; }
        .stats { 
            display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px; margin-bottom: 30px;
        }
        .stat-card { 
            background: white; padding: 20px; border-radius: 10px; text-align: center;
            box-shadow: 0 4px 15px rgba(0,0,0,0.1);
        }
        .stat-number { font-size: 2rem; font-weight: bold; color: #667eea; }
        .stat-label { color: #666; margin-top: 5px; }
        
        /* 单栏布局 - 地图在上方占据整个宽度 */
        .map-section { 
            background: white; border-radius: 15px; padding: 30px; 
            box-shadow: 0 4px 20px rgba(0,0,0,0.1); margin-bottom: 30px;
        }
        .places-list { 
            background: white; border-radius: 15px; padding: 30px; 
            box-shadow: 0 4px 20px rgba(0,0,0,0.1); margin-bottom: 30px;
        }
        
        .map-section h2, .places-list h2 { color: #2c3e50; margin-bottom: 15px; }
        .map-description { 
            color: #7f8c8d; font-size: 0.95rem; margin-bottom: 20px; 
            font-style: italic; text-align: center;
        }
        .map-note { 
            color: #95a5a6; font-size: 0.85rem; margin-top: 15px; 
            text-align: center; line-height: 1.4;
        }
        
        .map-container {
            border-radius: 15px; overflow: hidden; 
            box-shadow: 0 4px 15px rgba(0,0,0,0.1);
            background: #f8f9fa;
        }
        .map-image { 
            width: 100%; height: auto; display: block; 
            min-height: 500px; max-height: 800px; object-fit: contain;
            border: 2px solid #e1e5e9; border-radius: 10px;
        }
        .map-placeholder {
            background: linear-gradient(135deg, #f8f9ff 0%, #f0f2ff 100%);
            border: 2px dashed #667eea; border-radius: 10px; padding: 60px;
            text-align: center; color: #7f8c8d; min-height: 400px;
            display: flex; flex-direction: column; justify-content: center; align-items: center;
        }
        .placeholder-icon { font-size: 4rem; margin-bottom: 20px; }
        
        .place-item { 
            display: flex; align-items: center; padding: 20px 0; border-bottom: 1px solid #eee;
        }
        .place-item:last-child { border-bottom: none; }
        .place-number { 
            background: #667eea; color: white; width: 35px; height: 35px;
            border-radius: 50%; display: flex; align-items: center; justify-content: center;
            font-weight: bold; margin-right: 20px; flex-shrink: 0; font-size: 1.1rem;
        }
        .place-info h3 { color: #2c3e50; margin-bottom: 8px; font-size: 1.2rem; }
        .place-address { color: #7f8c8d; font-size: 1rem; line-height: 1.4; }
        .footer { 
            text-align: center; margin-top: 40px; padding: 30px;
            color: #666; font-size: 1rem;
        }
        
        /* 响应式设计 */
        @media (max-width: 768px) {
            .container { padding: 15px; }
            .header { padding: 20px; }
            .header h1 { font-size: 2rem; }
            .map-section, .places-list { padding: 20px; }
            .place-info h3 { font-size: 1.1rem; }
        }
        
        @media print {
            body { background: white; }
            .container { padding: 0; }
            .map-image { max-height: none; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🗺️ 我的旅游计划</h1>
            <p>生成时间：${currentDate}</p>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-number">${this.travelList.length}</div>
                <div class="stat-label">游玩地点</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${cities.length}</div>
                <div class="stat-label">涉及城市</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${totalDistance.toFixed(1)}</div>
                <div class="stat-label">总距离 (公里)</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${totalTime.toFixed(1)}</div>
                <div class="stat-label">预计时间 (小时)</div>
            </div>
        </div>
        
        <!-- 地图区域 - 占据整个宽度 -->
        ${mapSection}
        
        <!-- 行程列表 - 独立区域 -->
        <div class="places-list">
            <h2>📝 详细行程</h2>
            ${this.travelList.map((place, index) => `
                <div class="place-item">
                    <div class="place-number">${index + 1}</div>
                    <div class="place-info">
                        <h3>${place.name}</h3>
                        <div class="place-address">${place.address}</div>
                    </div>
                </div>
            `).join('')}
        </div>
        
        <div class="footer">
            <p>✨ 使用旅游规划助手生成 | 祝您旅途愉快！</p>
            <p>📅 ${currentDate} | 🌟 包含多彩路线标识，每段路线使用不同颜色便于区分</p>
        </div>
    </div>
</body>
</html>`;
    }

    // 专门用于截图的地图视野调整方法
    fitMapToPlacesForScreenshot(places) {
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
        const activePlaces = this.travelList.filter(place => !place.isPending);
        const placeData = activePlaces.map(place => ({
            id: place.id,
            lat: place.lat,
            lng: place.lng,
            isBlank: place.isBlank
        }));
        return JSON.stringify(placeData);
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
    generateDistanceCacheKey(fromPlace, toPlace) {
        return `${fromPlace.lng},${fromPlace.lat}-${toPlace.lng},${toPlace.lat}`;
    }

    // 获取缓存的距离数据
    getCachedDistance(fromPlace, toPlace) {
        const key = this.generateDistanceCacheKey(fromPlace, toPlace);
        const cached = this.distanceCache.get(key);

        if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
            console.log(`📦 使用缓存的距离数据: ${key}`);
            return cached;
        }

        return null;
    }

    // 缓存距离数据
    cacheDistance(fromPlace, toPlace, distance, duration) {
        const key = this.generateDistanceCacheKey(fromPlace, toPlace);
        this.distanceCache.set(key, {
            distance,
            duration,
            timestamp: Date.now()
        });
        console.log(`💾 缓存距离数据: ${key}`);
    }

    // 生成搜索缓存的键
    generateSearchCacheKey(keyword) {
        return keyword.toLowerCase().trim();
    }

    // 获取缓存的搜索结果
    getCachedSearchResult(keyword) {
        const key = this.generateSearchCacheKey(keyword);
        const cached = this.searchCache.get(key);

        if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
            console.log(`📦 使用缓存的搜索结果: ${keyword}`);
            return cached.results;
        }

        return null;
    }

    // 缓存搜索结果
    cacheSearchResult(keyword, results) {
        const key = this.generateSearchCacheKey(keyword);
        this.searchCache.set(key, {
            results,
            timestamp: Date.now()
        });
        console.log(`💾 缓存搜索结果: ${keyword} (${results.length}条)`);
    }

    // 生成路线缓存的键
    generateRouteCacheKey(origin, destination) {
        return `${origin.lng},${origin.lat}-${destination.lng},${destination.lat}`;
    }

    // 获取缓存的路线数据
    getCachedRoute(origin, destination) {
        const key = this.generateRouteCacheKey(origin, destination);
        const cached = this.routeCache.get(key);

        if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
            console.log(`📦 使用缓存的路线数据: ${key}`);
            return cached;
        }

        return null;
    }

    // 缓存路线数据
    cacheRoute(origin, destination, coordinates, distance, duration) {
        const key = this.generateRouteCacheKey(origin, destination);
        this.routeCache.set(key, {
            coordinates,
            distance,
            duration,
            timestamp: Date.now()
        });
        console.log(`💾 缓存路线数据: ${key}`);
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
        // 清除之前的定时器
        if (this.calculateDistancesTimeout) {
            clearTimeout(this.calculateDistancesTimeout);
        }

        // 设置新的防抖定时器
        this.calculateDistancesTimeout = setTimeout(() => {
            this.calculateDistancesOptimized();
        }, 300); // 300ms防抖
    }

    // 优化后的距离计算（带缓存和重复检查）
    calculateDistancesOptimized() {
        // 检查是否正在计算距离
        if (this.isCalculatingDistances) {
            console.log('⚠️ 距离计算正在进行中，跳过重复调用');
            return;
        }

        // 检查是否需要重新计算
        if (!this.shouldRecalculateDistances()) {
            console.log('📋 列表未变化，跳过距离重新计算');
            return;
        }

        console.log('🔄 开始优化的距离计算...');
        this.isCalculatingDistances = true;

        try {
            // 调用原有的计算逻辑
            this.calculateDistances();
        } finally {
            // 确保在任何情况下都重置标志
            setTimeout(() => {
                this.isCalculatingDistances = false;
            }, 1000);
        }
    }
}

// Google Maps API回调函数
function initMap() {
    console.log('🌍 Google Maps API回调函数被调用');
    // 初始化应用
    window.app = new TravelPlanner();
    console.log('📱 TravelPlanner应用实例已创建 (Google Maps)');
}

// 高德地图不需要回调函数，已在loadGaodeMapScript中直接处理

// 应用初始化（备用方案）
document.addEventListener('DOMContentLoaded', () => {
    if (!window.app) {
        // 如果地图API还没加载完成，创建一个等待实例
        window.app = {
            showApiHelp: () => {
                alert('正在等待地图API加载，请稍候...');
            },
            showSettingsModal: () => {
                alert('应用正在初始化中，请稍候...');
            },
            locatePlace: () => { },
            removePlaceFromList: () => { }
        };

        setTimeout(() => {
            // 如果3秒后还没有完整的应用实例，直接创建一个
            if (!window.app || !window.app.settings) {
                console.log('⚠️ 地图API加载超时，创建演示模式应用');
                window.app = new TravelPlanner();
            }
        }, 3000);
    }
});

// 导出函数供HTML调用
if (typeof window !== 'undefined') {
    window.initMap = initMap;

    // 导出调试函数
    window.testGaodeSearch = function (keyword = '北京大学') {
        console.log('🧪 === 手动测试高德搜索 ===');
        if (window.app && window.app.searchWithGaode) {
            window.app.searchWithGaode(keyword);
        } else {
            console.error('❌ 应用未初始化或searchWithGaode方法不存在');
        }
    };

    window.testGaodeAPI = async function () {
        console.log('🧪 === 手动测试高德Web服务API ===');
        if (window.app && window.app.testGaodeAPI) {
            const result = await window.app.testGaodeAPI();
            console.log('🧪 测试结果:', result ? '成功' : '失败');
            return result;
        } else {
            console.error('❌ 应用未初始化或testGaodeAPI方法不存在');
            return false;
        }
    };

    window.checkAppStatus = function () {
        console.log('🔍 === 应用状态检查 ===');
        console.log('window.app:', !!window.app);
        if (window.app) {
            console.log('app.settings:', window.app.settings);
            console.log('app.isMapLoaded:', window.app.isMapLoaded);
            console.log('selectedMapApi:', window.app.settings?.selectedMapApi);
            console.log('google API key状态:', window.app.getApiKey ? (window.app.getApiKey('google') ? '已配置' : '未配置') : 'getApiKey方法不存在');
            console.log('gaode API key状态:', window.app.getApiKey ? (window.app.getApiKey('gaode') ? '已配置' : '未配置') : 'getApiKey方法不存在');
            console.log('bing API key状态:', window.app.getApiKey ? (window.app.getApiKey('bing') ? '已配置' : '未配置') : 'getApiKey方法不存在');
        }
        console.log('🌍 浏览器fetch支持:', typeof fetch !== 'undefined');
        console.log('🗺️ AMap对象存在:', typeof AMap !== 'undefined');
        if (typeof AMap !== 'undefined') {
            console.log('AMap版本:', AMap.version);
        }
    };

    window.testRouteDrawing = function () {
        console.log('🧪 === 测试路线绘制 ===');
        if (window.app && window.app.showRoute) {
            if (window.app.travelList && window.app.travelList.length >= 2) {
                window.app.showRoute();
                console.log('✅ 路线绘制命令已执行');
            } else {
                console.warn('⚠️ 需要至少2个地点才能绘制路线');
                console.log('当前地点数量:', window.app.travelList ? window.app.travelList.length : 0);
            }
        } else {
            console.error('❌ 应用未初始化或showRoute方法不存在');
        }
    };

    window.testDistanceCalculation = function () {
        console.log('🧪 === 测试距离计算 ===');
        if (window.app && window.app.calculateDistances) {
            if (window.app.travelList && window.app.travelList.length >= 2) {
                window.app.calculateDistances();
                console.log('✅ 距离计算命令已执行');
            } else {
                console.warn('⚠️ 需要至少2个地点才能计算距离');
                console.log('当前地点数量:', window.app.travelList ? window.app.travelList.length : 0);
            }
        } else {
            console.error('❌ 应用未初始化或calculateDistances方法不存在');
        }
    };

    window.testMarkerCompatibility = function () {
        console.log('🧪 === 测试Marker兼容性 ===');
        if (window.app) {
            try {
                // 尝试应用城市过滤功能来测试marker兼容性
                if (window.app.applyCityFilterWithoutFitting) {
                    window.app.applyCityFilterWithoutFitting();
                    console.log('✅ Marker兼容性测试通过');
                    return true;
                } else {
                    console.warn('⚠️ applyCityFilterWithoutFitting方法不存在');
                    return false;
                }
            } catch (error) {
                console.error('❌ Marker兼容性测试失败:', error);
                return false;
            }
        } else {
            console.error('❌ 应用未初始化');
            return false;
        }
    };

    window.testMapUpdates = function () {
        console.log('🧪 === 测试地图更新功能 ===');
        if (window.app) {
            try {
                // 测试地图视野调整
                if (window.app.travelList && window.app.travelList.length > 0) {
                    console.log('🗺️ 测试地图视野调整...');
                    const activePlaces = window.app.travelList.filter(place => !place.isPending && place.lat && place.lng);
                    if (activePlaces.length > 0) {
                        window.app.fitMapToPlaces(activePlaces);
                        console.log('✅ 地图视野调整测试完成');
                    } else {
                        console.warn('⚠️ 没有有效地点进行测试');
                    }
                } else {
                    console.warn('⚠️ 没有地点数据进行测试');
                }

                // 测试标记刷新
                console.log('🔄 测试标记刷新...');
                window.app.refreshAllMarkers();
                console.log('✅ 标记刷新测试完成');

                return true;
            } catch (error) {
                console.error('❌ 地图更新测试失败:', error);
                return false;
            }
        } else {
            console.error('❌ 应用未初始化');
            return false;
        }
    };

    window.testShowRoute = function () {
        console.log('🧪 === 测试显示路线功能 ===');
        if (window.app && window.app.showRoute) {
            try {
                window.app.showRoute();
                console.log('✅ 显示路线测试完成');
                return true;
            } catch (error) {
                console.error('❌ 显示路线测试失败:', error);
                return false;
            }
        } else {
            console.error('❌ 应用未初始化或showRoute方法不存在');
            return false;
        }
    };

    window.testPendingPlacesView = function () {
        console.log('🧪 === 测试待定点视角调整功能 ===');
        if (window.app) {
            try {
                const pendingCount = window.app.travelList.filter(place => place.isPending).length;
                const activeCount = window.app.travelList.filter(place => !place.isPending && place.lat && place.lng).length;

                console.log(`📊 当前状态: ${activeCount}个游玩点, ${pendingCount}个待定点`);

                if (pendingCount === 0) {
                    console.warn('⚠️ 没有待定点可供测试，建议先将一些地点设置为待定状态');
                    return false;
                }

                console.log('👀 测试显示待定点并调整视角...');

                // 首先确保待定点是隐藏的
                if (window.app.showPendingPlaces) {
                    window.app.togglePendingPlaces(); // 先隐藏
                    setTimeout(() => {
                        window.app.togglePendingPlaces(); // 再显示，触发视角调整
                        console.log('✅ 待定点视角调整测试完成');
                    }, 500);
                } else {
                    window.app.togglePendingPlaces(); // 直接显示，触发视角调整
                    console.log('✅ 待定点视角调整测试完成');
                }

                return true;
            } catch (error) {
                console.error('❌ 待定点视角调整测试失败:', error);
                return false;
            }
        } else {
            console.error('❌ 应用未初始化');
            return false;
        }
    };

    window.testSatelliteToggle = function () {
        console.log('🧪 === 测试卫星图切换功能 ===');
        if (window.app && window.app.isMapLoaded) {
            try {
                const selectedMapApi = window.app.settings.selectedMapApi;
                console.log(`📍 当前地图API: ${selectedMapApi}`);
                console.log(`🗺️ 当前模式: ${window.app.isSatelliteMode ? '卫星图' : '普通图'}`);

                console.log('🔄 测试切换到卫星图...');
                if (!window.app.isSatelliteMode) {
                    window.app.toggleSatellite();
                }

                setTimeout(() => {
                    console.log('🔄 测试切换回普通图...');
                    if (window.app.isSatelliteMode) {
                        window.app.toggleSatellite();
                    }
                    console.log('✅ 卫星图切换测试完成');
                }, 2000);

                return true;
            } catch (error) {
                console.error('❌ 卫星图切换测试失败:', error);
                return false;
            }
        } else {
            console.error('❌ 地图未初始化或应用未加载');
            return false;
        }
    };

    window.testMarkerToggle = function () {
        console.log('🧪 === 测试标记清除和恢复功能 ===');
        if (window.app && window.app.isMapLoaded) {
            try {
                const activeCount = window.app.travelList.filter(place => !place.isPending && place.lat && place.lng && !place.isBlank).length;
                const pendingCount = window.app.travelList.filter(place => place.isPending).length;

                console.log(`📊 当前状态: ${activeCount}个游玩点, ${pendingCount}个待定点`);

                if (activeCount === 0) {
                    console.warn('⚠️ 没有游玩点可供测试，建议先添加一些地点');
                    return false;
                }

                console.log('🗑️ 测试清除标记...');
                if (!window.app.markersCleared) {
                    window.app.toggleMarkers(); // 清除标记
                }

                setTimeout(() => {
                    console.log('↩️ 测试恢复标记并调整视角...');
                    if (window.app.markersCleared) {
                        window.app.toggleMarkers(); // 恢复标记
                    }
                    console.log('✅ 标记切换测试完成');
                    console.log(`📋 验证：恢复标记时地图视角应该调整为只显示${activeCount}个游玩点区域`);
                }, 2000);

                return true;
            } catch (error) {
                console.error('❌ 标记切换测试失败:', error);
                return false;
            }
        } else {
            console.error('❌ 地图未初始化或应用未加载');
            return false;
        }
    };

    window.testGaodeMarkers = function () {
        console.log('🧪 === 测试高德地图标记功能 ===');
        if (window.app && window.app.settings.selectedMapApi === 'gaode') {
            try {
                console.log('🔄 重新创建标记...');
                window.app.recreateMarkers();

                console.log('⏳ 测试待定点显示...');
                if (window.app.travelList.some(place => place.isPending)) {
                    window.app.showPendingPlaces = true;
                    window.app.updateTogglePendingButton();
                } else {
                    console.warn('⚠️ 没有待定点可供测试');
                }

                console.log('🏷️ 测试标签切换...');
                window.app.togglePlaceNames();
                setTimeout(() => {
                    window.app.togglePlaceNames();
                }, 2000);

                console.log('✅ 高德地图标记测试完成');
                return true;
            } catch (error) {
                console.error('❌ 高德地图标记测试失败:', error);
                return false;
            }
        } else {
            console.warn('⚠️ 当前不是高德地图模式');
            return false;
        }
    };

    window.testGaodeCompatibility = function () {
        console.log('🧪 === 测试高德地图完整兼容性 ===');
        if (window.app) {
            try {
                const originalApi = window.app.settings.selectedMapApi;
                console.log(`📋 当前地图API: ${originalApi}`);

                if (originalApi !== 'gaode') {
                    console.log('⚠️ 当前不是高德地图，建议在设置中切换到高德地图后测试');
                }

                // 测试标记创建
                console.log('🎯 测试标记创建...');
                window.app.recreateMarkers();

                // 测试路线绘制
                console.log('🛣️ 测试路线绘制...');
                window.app.drawRoute();

                // 测试地图视野调整
                console.log('📐 测试地图视野调整...');
                const activePlaces = window.app.travelList.filter(place => !place.isPending && place.lat && place.lng);
                if (activePlaces.length > 0) {
                    window.app.fitMapToPlaces(activePlaces);
                }

                // 测试标签功能
                console.log('🏷️ 测试标签功能...');
                setTimeout(() => {
                    window.app.togglePlaceNames();
                    setTimeout(() => {
                        window.app.togglePlaceNames();
                    }, 1000);
                }, 500);

                console.log('✅ 高德地图兼容性测试完成');
                return true;
            } catch (error) {
                console.error('❌ 高德地图兼容性测试失败:', error);
                return false;
            }
        } else {
            console.error('❌ 应用未初始化');
            return false;
        }
    };

    console.log('🔧 调试函数已加载，您可以在控制台使用：');
    console.log('  - testGaodeSearch("关键字") : 测试高德Web服务API搜索');
    console.log('  - testGaodeAPI() : 测试高德Web服务API状态');
    console.log('  - checkAppStatus() : 检查应用状态');
    console.log('  - testRouteDrawing() : 测试路线绘制功能');
    console.log('  - testDistanceCalculation() : 测试距离计算功能');
    console.log('  - testMarkerCompatibility() : 测试Marker兼容性修复');
    console.log('  - testMapUpdates() : 测试地图更新和视野调整功能');
    console.log('  - testShowRoute() : 测试显示路线按钮功能');
    console.log('  - testPendingPlacesView() : 测试待定点视角调整功能');
    console.log('  - testSatelliteToggle() : 测试卫星图切换功能');
    console.log('  - testMarkerToggle() : 测试标记清除和恢复功能');
    console.log('  - testGaodeMarkers() : 测试高德地图标记功能');
    console.log('  - testGaodeCompatibility() : 测试高德地图完整兼容性');
} 