# 17TravelPlanner 问题清单与修复建议

检查日期：2026-06-08

检查范围：`index.html`、`styles.css`、`script.js`、`README.md`、`TUTORIAL.md`。本报告只记录问题和建议方案，未修改业务源码。

## 检查结论

项目是纯静态前端应用，核心业务集中在 `script.js` 单文件中。`node --check script.js` 语法检查通过，但存在多处会影响用户功能、数据准确性、安全性和移动端体验的问题。

建议修复顺序：

1. 先修 P1：搜索降级、API Key 保存/加载、XSS/HTML 注入、API Key 日志泄露、距离计算、导入空白点。
2. 再修 P2：移动端布局、弹窗可用性、ID 冲突、外链 noopener。
3. 最后处理结构拆分、文档版本同步、Bing 功能文案一致性等优化项。

## P1 高优先级问题

### 1. 无 API Key 时搜索演示模式不可用

位置：

- `README.md:46-49`
- `script.js:1331-1362`
- `script.js:1388-1399`

问题说明：

README 写明“演示模式”下可以使用搜索和列表管理功能，但应用默认地图 API 是高德。用户没有配置高德 Key 时，`searchPlaces()` 仍进入 `searchWithGaode()` 分支，然后因为缺少 Key 直接调用 `displaySearchResults([])`，显示“未找到相关地点”，不会进入 `searchDemo()`。

影响：

- 新用户打开应用后，首屏提示“目前可以使用搜索和列表功能”，但搜索实际不可用。
- 用户容易误以为搜索词无结果，而不是应用缺少 API Key。

建议修复方案：

- 在 `searchPlaces()` 中判断当前 provider 是否有可用 Key 或服务对象。
- 对 `gaode`：无 Key 时调用 `searchDemo(keyword)` 或显示明确的“请配置 API Key”状态。
- 对 `google`：没有 `placesService` 时也应降级到演示模式或提示配置。
- 避免把“无 Key”和“无搜索结果”混为同一个 UI。

推荐逻辑：

```js
if (selectedMapApi === 'gaode') {
    const apiKey = this.getApiKey('gaode');
    if (!apiKey) {
        this.searchDemo(keyword);
        return;
    }
    this.searchWithGaode(keyword);
    return;
}
```

### 2. 保存高德 API Key 后不会正确加载地图

位置：

- `script.js:1815-1920`
- `script.js:381-430`
- `script.js:1032-1086`

问题说明：

`saveSettings()` 只记录并比较 `currentGoogleApiKey` 和 `newGoogleApiKey`。如果用户保持默认高德地图并输入高德 Key，`needsReload` 不会因为高德 Key 变化而成立，页面可能只提示“设置已保存”，但不会加载高德地图脚本。

另外，`loadGaodeMapScript()` 中如果 `window.app` 已存在，会调用 `window.app.init()`，这可能导致重复绑定事件监听器。

影响：

- 默认高德模式下，用户配置 API Key 后地图可能不生效。
- 重复调用 `init()` 可能导致按钮点击触发多次、定时器重复、状态混乱。

建议修复方案：

- 使用“当前选中地图 API + 对应 Key”作为统一判断对象，不要只特判 Google。
- 保存前记录所有 provider 的 Key，或只记录当前 provider 的旧 Key。
- 高德 Key 变化时应加载高德脚本或提示刷新。
- 给 `init()` 增加幂等保护，例如 `this.isInitialized`，防止重复绑定事件。

推荐方向：

```js
const currentProvider = currentSelectedMapApi;
const newProvider = this.settings.selectedMapApi;
const oldProviderKey = this.settings.apiKeys?.[currentProvider] || '';
const newProviderKey = this.settings.apiKeys?.[newProvider] || '';
```

### 3. 多处 XSS / HTML 注入风险

位置：

- `script.js:1671-1676`
- `script.js:6213-6273`
- `script.js:6754-6838`
- `script.js:2473-2490`

问题说明：

多个 UI 使用模板字符串直接拼接到 `innerHTML`。其中搜索结果、方案列表、冲突解决界面都包含用户可控或导入文件可控字符串，例如地点名称、地址、方案名称。

风险点：

- 搜索 API 返回的 `place.name`、`place.address` 直接进入 HTML。
- 导入备份中的 `scheme.name` 直接进入 HTML。
- 冲突解决 UI 直接拼接 `importScheme.name`、`existingScheme.name`。
- 游玩列表主内容做了部分 `escapeHTML()`，但 inline `onclick` 参数仍依赖字符串拼接，维护风险较高。

影响：

- 恶意备份文件或异常 API 返回值可以注入 HTML。
- 在某些浏览器环境下可能执行脚本。
- 即使不执行脚本，也可能破坏页面结构，导致按钮失效或数据错乱。

建议修复方案：

- 避免将用户可控字符串直接写入 `innerHTML`。
- 对必须拼接的 HTML，统一使用 `escapeHTML()` 处理文本内容和属性内容。
- 更推荐改为 DOM API 创建元素，并使用 `textContent` 写入文本。
- 移除 inline `onclick`，改用事件委托和 `data-id`。

推荐方向：

```js
const nameEl = document.createElement('div');
nameEl.className = 'search-result-name';
nameEl.textContent = place.name;
```

### 4. API Key 会泄露到浏览器控制台日志

位置：

- `script.js:1428`
- `script.js:1580-1584`
- `script.js:1925-1950`

问题说明：

`getApiKey()` 会打印完整 `this.settings` 和 `apiKeys` 对象。高德搜索还会打印包含 `key=` 参数的完整请求 URL。

影响：

- 用户 API Key 会出现在 DevTools 控制台。
- 如果用户截图、录屏或导出日志，Key 可能泄露。
- 对公开部署的静态站来说，浏览器端 Key 本来就不能绝对保密，但不应主动输出到日志。

建议修复方案：

- 删除所有 API Key 和完整请求 URL 的日志。
- 如果需要调试，只输出 provider 和是否已配置。
- 封装 `maskApiKey()`，最多显示前后 2-4 位。

推荐方向：

```js
console.log(`API Key 状态: ${apiKey ? '已配置' : '未配置'}`);
```

### 5. 直线距离备用计算会把空白点和待定点计入路线

位置：

- `script.js:3551-3574`

问题说明：

`calculateStraightLineDistances()` 直接遍历 `this.travelList`，没有过滤待定点，也没有跳过空白点或无坐标地点。空白点的 `lat/lng` 是 `null`，在数值计算中会被当成 `0`，导致路线距离被错误计算为上万公里。

验证结果：

构造包含北京坐标、空白点和待定点的数据后，总距离出现 `24436.1 公里` 级别的错误值。

影响：

- 无 API Key、API 失败或降级计算时，路线统计严重错误。
- 空白地点功能与距离统计不兼容。
- 待定点不应参与激活路线统计。

建议修复方案：

- 直线距离计算应只处理 `!isPending && !isBlank && lat/lng 有效` 的地点。
- 与真实距离计算逻辑保持一致：查找前一个有效非空白地点。
- 对空白点/无坐标点显示“空白地点”或“无地理信息”，不要参与总计。

推荐方向：

```js
const activePlaces = this.travelList.filter(place =>
    !place.isPending && !place.isBlank &&
    Number.isFinite(place.lat) && Number.isFinite(place.lng)
);
```

### 6. 导入校验拒绝应用自己支持的空白游玩点

位置：

- `script.js:2433-2444`
- `script.js:6631-6635`
- `script.js:6647-6651`

问题说明：

应用支持空白游玩点，数据结构中 `lat` 和 `lng` 为 `null`，并通过 `isBlank: true` 标识。但导入校验要求每个地点的 `lat/lng` 都必须是 `number`。因此包含空白点的备份文件可能无法导入。

影响：

- 用户导出包含空白点的方案后，后续恢复可能失败。
- 与“添加空白游玩点”功能冲突。

建议修复方案：

- 导入校验允许 `isBlank === true` 的地点坐标为 `null`。
- 对非空白地点仍要求有效 number。
- 同时兼容旧数据中没有 `isBlank` 字段但坐标为空的情况，可自动补 `isBlank: true` 或提示修复。

推荐校验：

```js
const isBlank = place.isBlank === true;
const hasValidCoords = Number.isFinite(place.lat) && Number.isFinite(place.lng);
if (!isBlank && !hasValidCoords) {
    this.showToast('备份文件中的地点坐标无效');
    return;
}
```

## P2 中优先级问题

### 7. 移动端 API 横幅遮挡 Header，页面底部被裁切

位置：

- `script.js:518-553`
- `styles.css:31-48`

问题说明：

API 配置横幅是 `position: fixed`，代码固定给 `body` 设置 `paddingTop = '60px'`。移动端 390px 宽度下，横幅实际高度约 94.5px，因此会和 Header 重叠。同时 `html/body/container` 都设置了 `height: 100vh` 和 `overflow: hidden`，页面实际高度超过视口时无法滚动，地图底部会被裁切。

影响：

- 移动端首屏 Header 被横幅压住。
- 地图区域底部超出视口且不可滚动。
- 用户需要关闭横幅或进入紧凑模式才能缓解。

建议修复方案：

- 横幅插入后用 `banner.offsetHeight` 动态设置 padding。
- 或将横幅放入正常文档流，避免 fixed 叠层。
- 移动端不要全局禁止 body 滚动，至少允许主容器滚动。
- 横幅关闭时恢复原始 padding，而不是硬设为 `0`。

### 8. 编辑空白游玩点弹窗在低高度视口下保存按钮不可点击

位置：

- `styles.css:1076-1097`
- `styles.css:1673-1680`

问题说明：

普通 `.modal-content` 使用 `margin: 15% auto`。编辑弹窗内容较高时，在 1280x720 视口下保存按钮底部可能超出可点击区域。自动化验证中点击 `#saveEditBtn` 失败，按钮底部位置超过视口。

影响：

- 小屏笔记本或浏览器窗口高度较低时，用户可能无法直接点击保存。
- 空白点添加后自动打开编辑弹窗，影响核心流程。

建议修复方案：

- 对编辑弹窗使用与设置弹窗类似的居中布局：`top: 50%; transform: translateY(-50%)`。
- 给 `.modal-content` 增加 `max-height: calc(100vh - 40px)` 和 `overflow-y: auto`。
- 让编辑操作按钮固定在弹窗底部或始终位于滚动容器内。

### 9. 地点 ID 使用 `Date.now()`，快速添加可能冲突

位置：

- `script.js:2412`
- `script.js:2435`
- `script.js:2298`
- `script.js:3190`

问题说明：

普通地点和空白地点都使用 `Date.now()` 作为 id。快速连续添加、脚本批量添加或某些浏览器同毫秒操作时可能产生重复 id。编辑、删除、拖拽、路线段都依赖 id。

影响：

- 删除时可能删除多个同 id 地点。
- 编辑时可能编辑到第一个匹配项。
- 路线段 key 可能冲突。

建议修复方案：

- 使用已有 `generateUniqueSchemeId()` 类似逻辑新增 `generateUniquePlaceId()`。
- 更推荐使用 `crypto.randomUUID()`，并兼容不支持时 fallback。
- 导入旧数据时检测重复 id 并重写。

### 10. 外链和 `window.open` 缺少 noopener 防护

位置：

- `index.html:102-106`
- `index.html:288-309`
- `script.js:2924-2930`
- `script.js:2975-2980`
- `script.js:4573`

问题说明：

多个 `<a target="_blank">` 没有 `rel="noopener noreferrer"`。`window.open(url, '_blank')` 也没有显式清理 `opener`。

影响：

- 新标签页可能通过 `window.opener` 操作原页面，存在 tabnabbing 风险。

建议修复方案：

- 所有外链加 `rel="noopener noreferrer"`。
- `window.open` 使用特性参数：`window.open(url, target, 'noopener,noreferrer')`。
- 或打开后手动设置 `newWindow.opener = null`。

### 11. Bing 功能文案与实现不一致

位置：

- `README.md:16-20`
- `index.html:302-310`
- `script.js:333-335`
- `script.js:1639-1642`

问题说明：

UI 和 README 中展示 Bing Maps API 选项，但代码中 Bing 地图加载和搜索仍是“暂未实现”，会降级到演示模式。

影响：

- 用户可能以为 Bing 是完整可用地图服务。
- 配置 Bing Key 后仍无法获得完整地图/搜索能力。

建议修复方案：

- 如果短期不实现，文案明确标注“预留，暂不可用”，并禁用选择项。
- 如果要实现，需要补齐 Bing Maps 脚本加载、地图初始化、搜索、路线、距离计算。

### 12. README 版本号与应用内版本不一致

位置：

- `README.md:5`
- `script.js:1984-1987`
- `script.js:2052-2260`

问题说明：

README 徽章写 `v1.12.1`，但脚本内版本历史最新会计算为 `1.13.0`，页面运行后 Header 会显示 `v1.13.0`。

影响：

- 用户、维护者和发布记录对当前版本判断不一致。

建议修复方案：

- 更新 README 徽章到当前版本。
- 或将版本号抽成单一配置，README、Header、版本面板共用同一来源。

## P3 可维护性与工程优化

### 13. `script.js` 单文件过大，维护成本高

位置：

- `script.js` 全文件，约 8698 行。

问题说明：

地图 API、搜索、列表渲染、导入导出、设置、版本历史、缓存、截图、导航全部在一个类里。功能之间耦合强，任何修复都容易影响其他功能。

建议修复方案：

- 按职责拆分模块：
  - `settings.js`
  - `storage.js`
  - `places.js`
  - `maps/google-map.js`
  - `maps/gaode-map.js`
  - `import-export.js`
  - `ui/modals.js`
- 如果继续保持静态项目，可使用 ES Modules，并在 `index.html` 中用 `type="module"`。

### 14. 大量 inline `onclick` 影响安全和可维护性

位置：

- `script.js:2473-2490`
- `script.js:2618`
- `script.js:2701`
- `script.js:6269-6270`

问题说明：

动态 HTML 中大量使用 inline `onclick`，需要把参数转成 JS 字符串，容易出现转义遗漏、XSS、特殊字符破坏事件的问题，也无法启用严格 CSP。

建议修复方案：

- 使用事件委托：
  - 按钮写 `data-action`、`data-id`
  - 父容器监听 click
  - 根据 action 分发到对应方法
- 对地点名称、地址等文本只使用 `textContent`。

### 15. 生产代码中存在大量调试日志

位置：

- `script.js` 中大量 `console.log`、`console.warn`、`console.error`
- `script.js:8352-8698` 暴露多个测试函数

问题说明：

控制台输出非常密集，包含应用状态、API 状态、地址、路线等信息。底部还向 `window` 暴露多个测试函数。

影响：

- 用户控制台噪音大，排查真正错误困难。
- 可能泄露用户行程、地点、API 状态等隐私信息。
- 测试函数暴露到生产页面，增加误操作面。

建议修复方案：

- 增加 `DEBUG` 开关，默认关闭。
- 生产环境不注册 `window.test*` 调试函数。
- 敏感数据不输出。

### 16. 动态加载第三方 CDN 脚本缺少完整性校验

位置：

- `index.html:498`
- `script.js:7824-7836`

问题说明：

页面异步加载卜算子统计脚本，导出截图时动态从多个 CDN 加载 `html2canvas`，没有 SRI，也没有本地 fallback。

影响：

- 供应链风险。
- 离线使用时导出地图截图能力不稳定。
- CDN 被网络策略拦截时功能不可靠。

建议修复方案：

- 将 `html2canvas` 固定为本地 vendor 文件，或提供明确 fallback。
- 对外部脚本加 `integrity` 和 `crossorigin`，如果可行。
- 对统计脚本增加隐私说明或可关闭选项。

### 17. 自动化检查生成了未跟踪目录

位置：

- `.playwright-cli/`

问题说明：

本次浏览器检查生成了 `.playwright-cli/console-*.log` 和 `.playwright-cli/page-*.yml`。这不是源码问题，但会让 `git status` 出现未跟踪文件。

建议处理：

- 如果不需要保留检查日志，可删除 `.playwright-cli/`。
- 或在 `.gitignore` 中加入 `.playwright-cli/`。

## 已执行验证

### 语法检查

命令：

```bash
node --check script.js
```

结果：通过。

### 浏览器运行检查

方式：

- 使用临时本地服务加载 `http://127.0.0.1:8127/`
- 验证无 API Key 下的初始化、搜索、移动端布局、控制台日志
- 临时服务检查后已停止

复现到的问题：

- 无 API Key 时搜索“北京”显示“未找到相关地点”
- 控制台输出“高德地图API密钥未配置”
- 移动端 390x844 下 API 横幅与 Header 重叠
- 1280x720 下编辑弹窗按钮接近或超出视口底部

### 工作区状态

源码没有修改 diff。当前有自动化检查生成的未跟踪目录：

```text
.playwright-cli/
```

