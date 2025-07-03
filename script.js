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

        // 应用设置 - 默认设置
        this.settings = {
            navigationApp: 'amap', // 默认使用高德地图
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
        // 首先加载保存的设置
        this.loadSavedSettings();

        // 设置页面关闭时的提醒
        this.setupPageUnloadHandler();

        // 然后检查并初始化地图
        this.waitForGoogleMaps();
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

                    console.log('✅ 已加载保存的设置');

                    // 显示API密钥状态
                    const googleApiKey = this.settings.apiKeys?.google;
                    if (googleApiKey) {
                        console.log('🔑 检测到已保存的Google Maps API密钥，将自动应用');
                    } else {
                        console.log('⚠️ 未检测到Google Maps API密钥，将使用演示模式');
                    }
                }
            }
        } catch (error) {
            console.error('加载设置失败:', error);
        }
    }

    // 等待Google Maps API加载
    waitForGoogleMaps() {
        if (typeof google !== 'undefined' && google.maps) {
            this.init();
        } else {
            // 尝试动态加载Google Maps API
            this.tryLoadGoogleMapsAPI();
        }
    }

    // 尝试动态加载Google Maps API
    tryLoadGoogleMapsAPI() {
        const googleApiKey = this.getApiKey('google');

        if (googleApiKey) {
            console.log('🔑 检测到已保存的Google API密钥，自动加载Google Maps...');
            this.loadGoogleMapsScript(googleApiKey);
        } else {
            console.log('⚠️ 未配置Google API密钥，使用演示模式');
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

    // 初始化应用
    init() {
        this.setupEventListeners();
        this.initGoogleMap();
        this.loadSavedData();
        this.updatePageTitle(); // 更新页面标题
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
        const hasGoogleApiKey = this.getApiKey('google');

        if (!hasGoogleApiKey) {
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

            banner.innerHTML = `
                🔑 为了获得完整的地图功能，请在设置中配置您的API密钥
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
        // 搜索相关
        document.getElementById('searchBtn').addEventListener('click', () => this.searchPlaces());
        document.getElementById('searchInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.searchPlaces();
        });

        // 列表控制按钮
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

                this.map = new google.maps.Map(document.getElementById('mapContainer'), {
                    zoom: 10,
                    center: { lat: 39.9042, lng: 116.4074 }, // 北京
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
            } else {
                throw new Error('Google Maps API未加载');
            }
        } catch (error) {
            console.error('Google地图初始化失败:', error);
            this.initDemoMap();
        }
    }

    // 演示版地图（当没有API时）
    initDemoMap() {
        const mapContainer = document.getElementById('mapContainer');
        mapContainer.innerHTML = `
            <div style="height: 100%; display: flex; align-items: center; justify-content: center; background: #f0f0f0; color: #666; flex-direction: column;">
                <h3>🗺️ 演示模式</h3>
                <p>请在HTML中配置Google地图API密钥以启用完整功能</p>
                <p>目前可以使用搜索和列表功能</p>
                <button onclick="app.showApiHelp()" style="margin-top: 15px; padding: 10px 20px; background: #667eea; color: white; border: none; border-radius: 5px; cursor: pointer;">获取API密钥帮助</button>
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

        if (this.placesService) {
            this.searchWithGoogle(keyword);
        } else {
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

    // 演示搜索功能
    searchDemo(keyword) {
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
        // 在更新设置之前，先记录当前的API密钥
        const currentGoogleApiKey = this.getApiKey('google');

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

        // 检查Google API密钥变化
        const newGoogleApiKey = this.settings.apiKeys.google;

        if (newGoogleApiKey && newGoogleApiKey !== currentGoogleApiKey) {
            // API密钥有变化或新增
            if (typeof google === 'undefined') {
                // 之前没有Google Maps，现在要加载
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
                // 已经有Google Maps，但API密钥变了，需要重新加载
                this.showToast('设置已保存，API密钥已更新，页面将刷新以应用新配置...');
                setTimeout(() => {
                    window.location.reload();
                }, 2000);
            }
        } else if (!newGoogleApiKey && typeof google !== 'undefined') {
            // 移除了API密钥，需要刷新到演示模式
            this.showToast('设置已保存，页面将刷新以应用更改...');
            setTimeout(() => {
                window.location.reload();
            }, 2000);
        } else {
            this.showToast('设置已保存');
        }

        this.closeSettingsModal();
    }

    // 获取API密钥
    getApiKey(provider) {
        if (!this.settings.apiKeys) {
            return null;
        }

        switch (provider) {
            case 'google':
                return this.settings.apiKeys.google || null;
            case 'gaode':
                return this.settings.apiKeys.gaode || null;
            case 'bing':
                return this.settings.apiKeys.bing || null;
            default:
                return null;
        }
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
            });
        });
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

        // 更新显示
        this.updateTravelList();
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
        this.calculateDistances();
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
        this.calculateDistances();
        this.drawRoute(); // 添加地点后重新绘制路线
        this.closeModal();
        this.saveData();
        this.markAsModified(); // 标记为已修改
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

    // 更新游玩列表（激活状态的地点）
    updateActiveList(activePlaces) {
        const listContainer = document.getElementById('travelList');

        if (activePlaces.length === 0) {
            listContainer.innerHTML = '<li style="text-align: center; color: #666; padding: 20px;">暂无游玩地点</li>';
            return;
        }

        let htmlContent = '';

        activePlaces.forEach((place, index) => {
            // 如果不是第一个地点，先显示距离信息
            if (index > 0) {
                const segmentKey = `${activePlaces[index - 1].id}-${place.id}`;
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
            }

            // 然后显示地点信息
            const displayName = place.customName || place.name;
            const escapedCustomName = (place.customName || '').replace(/'/g, "\\'");
            const escapedOriginalName = place.name.replace(/'/g, "\\'");

            htmlContent += `
                <li class="travel-item" draggable="true" data-id="${place.id}">
                    <div class="travel-item-header">
                        <div class="travel-item-left">
                            <span class="drag-handle">⠿</span>
                            <span class="travel-item-order">${index + 1}</span>
                            <span class="travel-item-name">${displayName}</span>
                        </div>
                    </div>
                    <div class="travel-item-address">📮 ${place.address}</div>
                    ${place.notes ? `<div class="travel-item-notes">${place.notes}</div>` : ''}
                    <div class="travel-item-actions">
                        <button class="activate-btn" onclick="app.togglePlaceStatus('${place.id}')" title="移至待定">🎯 游玩</button>
                        <button class="action-btn locate-btn" onclick="app.locatePlace(${place.lng}, ${place.lat})" title="在地图上定位">📍</button>
                        <button class="action-btn edit-btn" onclick="app.editPlace('${place.id}')" title="编辑游玩点">✏️</button>
                        <button class="action-btn copy-btn" onclick="app.copyPlaceName('${escapedCustomName || escapedOriginalName}')" title="复制名称">📋</button>
                        <button class="action-btn copy-btn" onclick="app.copyPlaceAddress('${place.address.replace(/'/g, "\\'")}')" title="复制地址">📄</button>
                        <button class="action-btn navigate-to-btn" onclick="app.navigateToPlace(${place.lng}, ${place.lat}, '${displayName.replace(/'/g, "\\'")}')" title="导航到此处">🧭</button>
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
                        <button class="action-btn locate-btn" onclick="app.locatePlace(${place.lng}, ${place.lat})" title="在地图上定位">📍</button>
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

            this.updateTravelList();
            this.calculateDistances();
            this.drawRoute();
            this.saveData();
            this.markAsModified(); // 标记为已修改
        }
    }

    // 定位地点
    locatePlace(lng, lat) {
        if (this.isMapLoaded) {
            this.map.setCenter({ lat: lat, lng: lng });
            this.map.setZoom(16);

            // 显示恢复总地图按钮
            this.showReturnToOverviewButton();
        } else {
            alert(`地点坐标: ${lng.toFixed(6)}, ${lat.toFixed(6)}`);
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

    // 从当前位置导航到指定地点
    navigateToPlace(lng, lat, name) {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const currentLat = position.coords.latitude;
                    const currentLng = position.coords.longitude;

                    // 根据用户设置选择导航应用
                    const navigationApp = this.settings.navigationApp || 'amap';
                    let url = '';
                    let appName = '';

                    switch (navigationApp) {
                        case 'amap':
                            url = `https://uri.amap.com/navigation?from=${currentLng},${currentLat}&to=${lng},${lat}&name=${encodeURIComponent(name)}&coordinate=wgs84&mode=car`;
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
                        default:
                            url = `https://uri.amap.com/navigation?from=${currentLng},${currentLat}&to=${lng},${lat}&name=${encodeURIComponent(name)}&coordinate=wgs84&mode=car`;
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
        // 创建toast元素
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;

        // 添加到页面
        document.body.appendChild(toast);

        // 显示动画
        setTimeout(() => {
            toast.classList.add('show');
        }, 100);

        // 3秒后自动隐藏
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
        this.calculateDistances();
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

    // 使用Google Distance Matrix API计算真实距离
    calculateRealDistances() {
        const activePlaces = this.travelList.filter(place => !place.isPending);

        let totalDistanceKm = 0;
        let totalDurationMin = 0;
        let completedCalculations = 0;
        const totalCalculations = activePlaces.length - 1;

        for (let i = 1; i < activePlaces.length; i++) {
            const prev = activePlaces[i - 1];
            const curr = activePlaces[i];

            this.distanceMatrixService.getDistanceMatrix({
                origins: [{ lat: prev.lat, lng: prev.lng }],
                destinations: [{ lat: curr.lat, lng: curr.lng }],
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
                    const distanceElement = document.getElementById(`distance-${curr.id}`);
                    const durationElement = document.getElementById(`duration-${curr.id}`);

                    if (distanceElement) {
                        distanceElement.textContent = distance;
                    }
                    if (durationElement) {
                        durationElement.textContent = duration;
                    }
                } else {
                    // 如果API调用失败，使用直线距离
                    const straightDistance = this.calculateStraightDistance(prev.lat, prev.lng, curr.lat, curr.lng);
                    totalDistanceKm += straightDistance;
                    totalDurationMin += (straightDistance / 50) * 60; // 假设50km/h

                    const distanceElement = document.getElementById(`distance-${curr.id}`);
                    const durationElement = document.getElementById(`duration-${curr.id}`);

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

        // 获取游玩点在激活列表中的索引（用于显示编号）
        const activePlaces = this.travelList.filter(p => !p.isPending);
        const index = activePlaces.findIndex(p => p.id === place.id);
        const number = index + 1;

        // 使用自定义名称（如果有的话）
        const displayName = place.customName || place.name;

        const marker = new google.maps.Marker({
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
            zIndex: 1000 + index // 确保标记在路线之上
        });

        // 创建自定义标签显示地点名称（仅在Google Maps API可用时）
        let placeLabel = null;
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

        this.markers.push({ id: place.id, marker: marker, place: place });
    }

    // 删除标记
    removeMarker(id) {
        if (!this.isMapLoaded) return;

        const markerIndex = this.markers.findIndex(m => m.id.toString() === id);
        if (markerIndex !== -1) {
            this.markers[markerIndex].marker.setMap(null);
            this.markers.splice(markerIndex, 1);
        }

        // 同时删除对应的标签
        const labelIndex = this.placeLabels.findIndex(l => l.id.toString() === id);
        if (labelIndex !== -1) {
            if (this.placeLabels[labelIndex].label) {
                this.placeLabels[labelIndex].label.setMap(null);
            }
            this.placeLabels.splice(labelIndex, 1);
        }
    }

    // 清除所有标记
    clearMarkers() {
        if (!this.isMapLoaded) return;

        this.markers.forEach(m => m.marker.setMap(null));
        this.markers = [];

        // 清除所有标签
        this.placeLabels.forEach(l => {
            if (l.label) l.label.setMap(null);
        });
        this.placeLabels = [];

        // 清除待定点标记
        this.clearPendingMarkers();

        if (this.directionsRenderer) {
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
            this.showToast('已恢复标记');
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

        this.markers.forEach(m => m.marker.setMap(null));
        this.markers = [];

        // 清除所有标签
        this.placeLabels.forEach(l => {
            if (l.label) l.label.setMap(null);
        });
        this.placeLabels = [];

        // 清除待定点标记
        this.clearPendingMarkers();

        // 清除路线
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

        // 重新适配地图视野
        if (this.travelList.length > 0) {
            this.fitMapToPlaces(this.travelList);
        }
    }

    // 显示路线功能
    showRoute() {
        if (this.travelList.length < 2) {
            this.showToast('至少需要2个地点才能显示路线');
            return;
        }

        // 确保标记已显示
        if (this.markersCleared) {
            this.restoreMarkers();
            const clearBtn = document.getElementById('clearMarkersBtn');
            clearBtn.innerHTML = '🗑️ 清除标记';
            clearBtn.title = '清除地图标记';
            this.markersCleared = false;
        }

        // 重新绘制路线
        this.drawRoute();

        // 适配地图视野以显示所有地点
        this.fitMapToPlaces(this.travelList);

        this.showToast('已显示完整路线');
    }

    // 绘制路线
    drawRoute() {
        // 只处理激活状态的地点
        const activePlaces = this.travelList.filter(place => !place.isPending);

        if (!this.isMapLoaded || activePlaces.length < 2) {
            // 如果只有一个地点或没有地点，清除路线
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
            return;
        }

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
        if (activePlaces.length >= 2) {
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
                    console.log('使用 Directions API 绘制路线');
                } else {
                    console.log('Directions API 失败，使用多彩连线:', status);
                    // 如果路线规划失败，绘制多彩连线
                    this.drawSimplePath();
                }
            });
        } else {
            // 只有两个地点时，直接绘制多彩连线
            this.drawSimplePath();
        }
    }

    // 绘制简单路径（备用方案）
    drawSimplePath() {
        // 只处理激活状态的地点
        const activePlaces = this.travelList.filter(place => !place.isPending);

        if (activePlaces.length < 2) return;

        if (this.polyline) {
            this.polyline.setMap(null);
        }

        // 定义多种颜色用于区分不同路线段
        const routeColors = [
            '#667eea', // 蓝紫色
            '#ff6b6b', // 红色
            '#4ecdc4', // 青绿色
            '#45b7d1', // 蓝色
            '#96ceb4', // 薄荷绿
            '#feca57', // 黄色
            '#ff9ff3', // 粉色
            '#54a0ff', // 亮蓝色
            '#5f27cd', // 紫色
            '#00d2d3', // 青色
            '#ff9f43', // 橙色
            '#10ac84'  // 绿色
        ];

        // 如果只有两个点，使用单一路线
        if (activePlaces.length === 2) {
            const path = activePlaces.map(place => ({ lat: place.lat, lng: place.lng }));

            this.polyline = new google.maps.Polyline({
                path: path,
                geodesic: true,
                strokeColor: routeColors[0],
                strokeOpacity: 0.8,
                strokeWeight: 5,
                icons: [{
                    icon: {
                        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                        scale: 7,
                        strokeColor: routeColors[0],
                        strokeWeight: 2,
                        fillColor: routeColors[0],
                        fillOpacity: 1
                    },
                    offset: '100%',
                    repeat: '200px'
                }]
            });
            this.polyline.setMap(this.map);
        } else {
            // 多个点时，为每个路线段使用不同颜色
            this.polylines = this.polylines || [];

            // 清除之前的路线
            this.polylines.forEach(polyline => polyline.setMap(null));
            this.polylines = [];

            for (let i = 0; i < activePlaces.length - 1; i++) {
                const segmentPath = [
                    { lat: activePlaces[i].lat, lng: activePlaces[i].lng },
                    { lat: activePlaces[i + 1].lat, lng: activePlaces[i + 1].lng }
                ];

                const colorIndex = i % routeColors.length;
                const segmentColor = routeColors[colorIndex];

                const polyline = new google.maps.Polyline({
                    path: segmentPath,
                    geodesic: true,
                    strokeColor: segmentColor,
                    strokeOpacity: 0.8,
                    strokeWeight: 5,
                    icons: [{
                        icon: {
                            path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                            scale: 7,
                            strokeColor: segmentColor,
                            strokeWeight: 2,
                            fillColor: segmentColor,
                            fillOpacity: 1
                        },
                        offset: '100%',
                        repeat: '150px'
                    }]
                });

                polyline.setMap(this.map);
                this.polylines.push(polyline);
            }
        }

        // 调整地图视野以包含所有激活点，但保持合理的缩放级别
        if (activePlaces.length > 1) {
            const bounds = new google.maps.LatLngBounds();
            activePlaces.forEach(place => bounds.extend({ lat: place.lat, lng: place.lng }));

            // 添加一些边距
            const extendedBounds = this.extendBounds(bounds, 0.1);
            this.map.fitBounds(extendedBounds);

            // 确保缩放级别不会太高
            google.maps.event.addListenerOnce(this.map, 'bounds_changed', () => {
                if (this.map.getZoom() > 16) {
                    this.map.setZoom(16);
                }
            });
        }

        console.log('绘制多彩路径，共', activePlaces.length, '个激活地点，', activePlaces.length - 1, '个彩色路线段');
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

    // 计算单个路线段距离
    calculateSegmentDistance(segmentKey) {
        const [fromId, toId] = segmentKey.split('-');
        const fromPlace = this.travelList.find(p => p.id.toString() === fromId);
        const toPlace = this.travelList.find(p => p.id.toString() === toId);

        if (!fromPlace || !toPlace) return;

        // 始终使用Google API计算驾车距离
        if (this.distanceMatrixService && this.isMapLoaded) {
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
                    const distance = this.calculateStraightDistance(fromPlace.lat, fromPlace.lng, toPlace.lat, toPlace.lng);
                    if (distanceElement) {
                        distanceElement.textContent = `${distance.toFixed(1)} 公里 (估算)`;
                    }
                    if (durationElement) {
                        durationElement.textContent = `约${(distance / 50 * 60).toFixed(0)} 分钟`;
                    }
                }
            });
        } else {
            // 如果Google API不可用，使用直线距离
            const distance = this.calculateStraightDistance(fromPlace.lat, fromPlace.lng, toPlace.lat, toPlace.lng);
            const distanceElement = document.getElementById(`distance-${toId}`);
            const durationElement = document.getElementById(`duration-${toId}`);

            if (distanceElement) {
                distanceElement.textContent = `${distance.toFixed(1)} 公里 (直线)`;
            }
            if (durationElement) {
                durationElement.textContent = `约${(distance / 50 * 60).toFixed(0)} 分钟`;
            }
        }
    }

    // 获取当前位置
    getCurrentLocation() {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const lat = position.coords.latitude;
                    const lng = position.coords.longitude;

                    if (this.isMapLoaded) {
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
                    }

                    alert(`已定位到您的位置: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
                },
                (error) => {
                    alert('定位失败: ' + error.message);
                }
            );
        } else {
            alert('您的浏览器不支持地理定位');
        }
    }

    // 切换卫星图
    toggleSatellite() {
        if (!this.isMapLoaded) return;

        const currentType = this.map.getMapTypeId();
        if (currentType === google.maps.MapTypeId.SATELLITE) {
            this.map.setMapTypeId(google.maps.MapTypeId.ROADMAP);
            document.getElementById('satelliteBtn').textContent = '🛰️ 卫星图';
        } else {
            this.map.setMapTypeId(google.maps.MapTypeId.SATELLITE);
            document.getElementById('satelliteBtn').textContent = '🗺️ 普通图';
        }
    }

    // 切换显示/隐藏地点名称
    togglePlaceNames() {
        if (!this.isMapLoaded) return;

        this.showPlaceNames = !this.showPlaceNames;
        const toggleBtn = document.getElementById('toggleNamesBtn');

        if (PlaceLabel && (this.placeLabels.length > 0 || this.pendingMarkers.length > 0)) {
            if (this.showPlaceNames) {
                // 显示所有地点名称（包括游玩点和待定点）
                this.placeLabels.forEach(l => {
                    if (l.label) l.label.show();
                });
                this.pendingMarkers.forEach(m => {
                    if (m.label) m.label.show();
                });
                toggleBtn.textContent = '🏷️ 隐藏名称';
                toggleBtn.title = '隐藏地点名称';
                this.showToast('已显示地点名称');
            } else {
                // 隐藏所有地点名称（包括游玩点和待定点）
                this.placeLabels.forEach(l => {
                    if (l.label) l.label.hide();
                });
                this.pendingMarkers.forEach(m => {
                    if (m.label) m.label.hide();
                });
                toggleBtn.textContent = '🏷️ 显示名称';
                toggleBtn.title = '显示地点名称';
                this.showToast('已隐藏地点名称');
            }
        } else {
            // 演示模式或无标签时的提示
            this.showToast('标签功能需要Google Maps API支持');
            toggleBtn.textContent = this.showPlaceNames ? '🏷️ 隐藏名称' : '🏷️ 显示名称';
        }
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
            this.showToast(`已显示 ${pendingCount} 个待定点`);
        } else {
            // 隐藏待定点
            this.clearPendingMarkers();
            toggleBtn.textContent = '⏳ 显示待定点';
            toggleBtn.title = '显示待定游玩点';
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
        this.pendingMarkers.forEach(markerData => {
            if (markerData.marker) {
                markerData.marker.setMap(null);
            }
            if (markerData.label) {
                markerData.label.setMap(null);
            }
        });
        this.pendingMarkers = [];
    }

    // 添加待定点标记
    addPendingMarker(place) {
        if (!this.isMapLoaded) return;

        // 使用自定义名称（如果有的话）
        const displayName = place.customName || place.name;

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
                        <text x="20" y="19" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="#f39c12">⏳</text>
                    </svg>
                `),
                scaledSize: new google.maps.Size(40, 50),
                anchor: new google.maps.Point(20, 50)
            },
            zIndex: 500 // 确保待定点在游玩点之下
        });

        // 创建自定义标签显示地点名称（仅在Google Maps API可用时）
        let placeLabel = null;
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

        // 存储标记信息
        this.pendingMarkers.push({
            id: place.id,
            marker: marker,
            label: placeLabel,
            place: place
        });
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
            markerObj.marker.setVisible(false);
        });

        // 隐藏所有待定点标记
        this.pendingMarkers.forEach(markerObj => {
            markerObj.marker.setVisible(false);
        });

        // 根据过滤条件显示标记
        let visiblePlaces = [];

        if (this.currentCityFilter === 'all') {
            // 显示所有游玩点标记
            this.markers.forEach(markerObj => {
                markerObj.marker.setVisible(true);
            });
            // 显示所有待定点标记（如果当前显示待定点）
            if (this.showPendingPlaces) {
                this.pendingMarkers.forEach(markerObj => {
                    markerObj.marker.setVisible(true);
                });
            }
            visiblePlaces = this.travelList;
        } else {
            // 只显示指定城市的游玩点标记
            this.markers.forEach(markerObj => {
                const city = this.extractCityFromAddress(markerObj.place.address);
                if (city === this.currentCityFilter) {
                    markerObj.marker.setVisible(true);
                    visiblePlaces.push(markerObj.place);
                }
            });
            // 只显示指定城市的待定点标记（如果当前显示待定点）
            if (this.showPendingPlaces) {
                this.pendingMarkers.forEach(markerObj => {
                    const city = this.extractCityFromAddress(markerObj.place.address);
                    if (city === this.currentCityFilter) {
                        markerObj.marker.setVisible(true);
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
            markerObj.marker.setVisible(false);
        });

        // 隐藏所有待定点标记
        this.pendingMarkers.forEach(markerObj => {
            markerObj.marker.setVisible(false);
        });

        // 根据过滤条件显示标记
        let visiblePlaces = [];

        if (this.currentCityFilter === 'all') {
            // 显示所有游玩点标记
            this.markers.forEach(markerObj => {
                markerObj.marker.setVisible(true);
            });
            // 显示所有待定点标记（如果当前显示待定点）
            if (this.showPendingPlaces) {
                this.pendingMarkers.forEach(markerObj => {
                    markerObj.marker.setVisible(true);
                });
            }
            visiblePlaces = this.travelList;
        } else {
            // 只显示指定城市的游玩点标记
            this.markers.forEach(markerObj => {
                const city = this.extractCityFromAddress(markerObj.place.address);
                if (city === this.currentCityFilter) {
                    markerObj.marker.setVisible(true);
                    visiblePlaces.push(markerObj.place);
                }
            });
            // 只显示指定城市的待定点标记（如果当前显示待定点）
            if (this.showPendingPlaces) {
                this.pendingMarkers.forEach(markerObj => {
                    const city = this.extractCityFromAddress(markerObj.place.address);
                    if (city === this.currentCityFilter) {
                        markerObj.marker.setVisible(true);
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

        // 清除现有标记但不清除路线
        this.markers.forEach(m => m.marker.setMap(null));
        this.markers = [];

        // 清除现有标签
        this.placeLabels.forEach(l => {
            if (l.label) l.label.setMap(null);
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

        // 应用当前的城市过滤
        this.applyyCityFilter();
    }

    // 调整地图视野以适应指定的地点
    fitMapToPlaces(places) {
        if (!this.isMapLoaded || places.length === 0) return;

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
        const pendingPlaces = this.travelList.filter(place => place.isPending);

        if (activePlaces.length < 3) {
            alert('至少需要3个激活状态的地点才能优化路线');
            return;
        }

        if (confirm('优化路线将重新排列游玩顺序（不影响待定列表），是否继续？')) {
            const optimized = this.greedyTSP(activePlaces);
            // 重新组合：优化后的激活地点 + 待定地点
            this.travelList = [...optimized, ...pendingPlaces];
            this.updateTravelList();
            this.calculateDistances();
            this.drawRoute();
            this.saveData();
            this.markAsModified(); // 标记为已修改
            alert('路线已优化！');
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
                this.calculateDistances();

                // 重新添加标记和绘制路线
                this.travelList.forEach(place => this.addMarker(place));
                if (this.travelList.length >= 2) {
                    this.drawRoute();
                }

                // 重置待定点显示状态
                this.showPendingPlaces = false;
                const toggleBtn = document.getElementById('togglePendingBtn');
                if (toggleBtn) {
                    toggleBtn.textContent = '⏳ 显示待定点';
                    toggleBtn.title = '显示待定游玩点';
                }

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
        this.calculateDistances();

        // 重新创建标记
        this.clearMarkers();
        this.travelList.forEach(place => this.addMarker(place));
        this.drawRoute();

        // 重置待定点显示状态
        this.showPendingPlaces = false;
        const toggleBtn = document.getElementById('togglePendingBtn');
        if (toggleBtn) {
            toggleBtn.textContent = '⏳ 显示待定点';
            toggleBtn.title = '显示待定游玩点';
        }

        // 适配地图视野
        if (this.travelList.length > 0) {
            this.fitMapToPlaces(this.travelList);
        }

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
            this.calculateDistances();

            // 重新创建标记和路线
            this.travelList.forEach(place => this.addMarker(place));
            this.drawRoute();

            // 重置待定点显示状态
            this.showPendingPlaces = false;
            const toggleBtn = document.getElementById('togglePendingBtn');
            if (toggleBtn) {
                toggleBtn.textContent = '⏳ 显示待定点';
                toggleBtn.title = '显示待定游玩点';
            }

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
                this.calculateDistances();

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
}

// Google Maps API回调函数
function initMap() {
    // 初始化应用
    window.app = new TravelPlanner();
}

// 应用初始化（备用方案）
document.addEventListener('DOMContentLoaded', () => {
    if (!window.app) {
        // 如果Google Maps还没加载完成，创建一个等待实例
        window.app = {
            showApiHelp: () => {
                alert('正在等待Google Maps API加载，请稍候...');
            },
            locatePlace: () => { },
            removePlaceFromList: () => { }
        };

        setTimeout(() => {
            if (typeof google === 'undefined') {
                window.app = new TravelPlanner();
            }
        }, 3000);
    }
});

// 导出函数供HTML调用
if (typeof window !== 'undefined') {
    window.initMap = initMap;
} 