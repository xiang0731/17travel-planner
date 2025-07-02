# API密钥配置说明

## 概述

为了让旅游规划工具获得完整的地图功能，您需要配置相应的API密钥。本应用支持配置多个地图服务提供商的API密钥。

## 支持的地图服务

### 1. Google Maps API
- **用途**: 地图显示、地点搜索、路线规划、静态地图生成
- **获取方式**: 访问 [Google Cloud Console](https://console.cloud.google.com/)
- **所需API**: Maps JavaScript API, Places API, Static Maps API

### 2. 高德地图API
- **用途**: 中国大陆地区的地图服务和导航功能（预留）
- **获取方式**: 访问 [高德开放平台](https://console.amap.com/)

### 3. Bing Maps API
- **用途**: 微软Bing地图服务（预留）
- **获取方式**: 访问 [Bing Maps Dev Center](https://www.bingmapsportal.com/)

## 如何配置

1. 点击右上角的 **⚙️ 设置** 按钮
2. 在设置页面中找到 **🔑 API密钥配置** 区域
3. 输入您的API密钥
4. 点击 **保存设置**

## 功能说明

- **安全存储**: API密钥仅存储在您的浏览器本地，不会上传到任何服务器
- **动态加载**: 配置Google API密钥后会自动重新加载地图服务
- **提示横幅**: 未配置API密钥时会显示配置提示
- **演示模式**: 没有API密钥时会使用基础演示模式

## 注意事项

1. 请妥善保管您的API密钥，避免在公共场所输入
2. 建议为API密钥设置适当的使用限制和域名限制
3. Google Maps API通常需要启用计费才能正常使用
4. 某些功能（如静态地图生成）需要有效的API密钥才能工作

## 获取Google Maps API密钥详细步骤

1. 访问 [Google Cloud Console](https://console.cloud.google.com/)
2. 创建新项目或选择现有项目
3. 启用以下API：
   - Maps JavaScript API
   - Places API
   - Static Maps API
4. 转到"凭据"页面
5. 点击"创建凭据" → "API密钥"
6. 复制生成的API密钥
7. （推荐）设置API密钥限制以提高安全性

## 故障排除

- **地图无法加载**: 检查API密钥是否正确，是否启用了必要的API服务
- **搜索功能不工作**: 确保启用了Places API
- **静态地图生成失败**: 确保启用了Static Maps API，且API密钥有效
- **配置提示一直显示**: 请检查API密钥是否已正确保存

如有其他问题，请检查浏览器控制台的错误信息。 