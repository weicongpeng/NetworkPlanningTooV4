# 工参地图 (gongcan-map) - Code Wiki

## 文档概述

本 Code Wiki 为工参地图项目的完整技术文档，涵盖项目架构、模块职责、关键类与函数说明、依赖关系以及项目运行方式等关键信息。

## 文档目录

### 1. [项目架构总览](./01-项目架构总览.md)

**内容概要:**
- 项目简介和核心特性
- 技术栈概览（React Native/Expo/TypeScript）
- 项目目录结构
- 架构分层说明（路由层/组件层/服务层/状态层/工具层）
- 数据流核心路径（地图渲染/本地导入/GPS导航）
- 坐标系统（WGS84 ↔ GCJ02）
- 性能优化策略
- API 地址解析优先级
- 模块依赖关系图

**适合阅读:** 初次接触项目的开发者，快速了解项目全貌

---

### 2. [模块详解](./02-模块详解.md)

**内容概要:**

#### 页面组件 (app/(tabs)/)
- `index.tsx` - 地图主屏：初始化流程、组件组合、状态来源
- `data.tsx` - 数据管理：缓存刷新、文件导入、导出删除
- `favorites.tsx` - 收藏列表：定位、导航、编辑、复制、删除
- `settings.tsx` - 设置页：API 地址配置、连接测试

#### 核心组件 (src/components/)
- `MapView.tsx` - 核心地图视图：WebView 封装、26 个 ref 方法、坐标转换
- `NavigationPanel.tsx` - 导航面板：设置模式/导航模式、手势拖拽、GPS 信号指示
- `SearchBar.tsx` - 搜索栏：扇区参数搜索、POI 搜索
- `MarkerList.tsx` - 标记列表
- `MeasureControl.tsx` - 测量控制

#### 服务层 (src/services/)
- `api.ts` - API 服务：axios 封装、动态 baseURL、核心 API 方法
- `cacheService.ts` - 缓存服务：首次启动自动缓存、本地文件导入、元数据管理
- `navigationService.ts` - 导航服务：GPS 定位、路径规划、TTS 播报、偏航检测
- `dataParser.ts` - 数据解析器：多格式文件解析、字段检测
- `streamingParser.ts` - 流式解析器：大文件分块读取
- `asyncParser.ts` - 异步解析器：中等文件分片处理

#### 工具层 (src/utils/)
- `config.ts` - 配置管理：API 地址解析、高德地图配置
- `coordinate.ts` - 坐标转换：WGS84 ↔ GCJ02 算法
- `clusterManager.ts` - 聚类管理：Supercluster 封装
- `viewportFilter.ts` - 视窗过滤：RBush 空间索引

**适合阅读:** 需要深入了解特定模块的开发者

---

### 3. [数据流和状态管理](./03-数据流和状态管理.md)

**内容概要:**

#### 核心类型定义 (src/types/data.ts)
- 缓存元数据类型：`CacheMeta`, `FullParamsCacheInfo`, `GeoDataCacheInfo`, `LayersCacheInfo`
- 导入相关类型：`DataFileType`, `ImportResult`, `ImportProgress`
- 解析中间类型：`ParsedSite`, `ParsedSector`, `GeoJsonFeature`, `GeoJsonFeatureCollection`
- MIF 解析相关类型：`MifGeometry`, `MifFeature`, `MifParseResult`

#### 全局状态管理 (src/store/mapStore.ts)
- 导出的类型：`SectorData`, `MarkerPoint`, `MeasurePoint`, `SearchMarker`
- 状态分组：后端连接、地图、标记/收藏、测量、搜索、模式、导航、缓存
- 持久化配置：仅 `favorites` 持久化到 AsyncStorage
- 辅助函数：`getDistance`（Haversine 公式）、`calculateTotalDistance`

#### 缓存机制详解
- 缓存目录结构
- 缓存策略：首次启动自动缓存、后端下载流程、本地文件导入流程
- 元数据管理：AsyncStorage 存储结构示例

#### 坐标转换系统
- WGS84 ↔ GCJ02 背景
- 核心算法：正向转换、逆向转换（迭代逼近法）
- 中国境外判断
- 转换时机

#### 聚类和视窗过滤机制
- 聚类管理（Supercluster）：配置、工作流程、性能优化
- 视窗过滤（RBush）：配置、工作流程、性能优化
- 使用场景对比

#### 大文件导入和解析流程
- 文件大小判断
- 流式解析（streamingParser）：Excel/CSV 流式解析流程
- 异步解析（asyncParser）：分片处理机制
- 解析策略选择
- 防 ANR 机制

#### 完整数据流图
- 从数据源到 UI 渲染的完整流程图

**适合阅读:** 需要理解数据流转和状态管理的开发者

---

### 4. [API 和服务层](./04-API和服务层.md)

**内容概要:**

#### API 服务 (src/services/api.ts)
- ApiService 类：地址管理、核心数据 API、搜索 API
- 请求拦截器：动态获取最新 API 地址
- 导出：单例 `apiService`
- 依赖关系

#### 缓存服务 (src/services/cacheService.ts)
- CacheService 类：初始化、元数据管理、后端下载缓存、本地读取、文件导入、文件删除、文件导出
- 缓存目录结构
- 文件读取策略：三级回退（SAF/临时文件/直接读取）
- 依赖关系

#### 导航服务 (src/services/navigationService.ts)
- 导出的类型：`NaviMode`, `GpsSignalQuality`, `GpsSignalInfo`, `RouteStep`, `RouteData`, `NaviStateSnapshot`
- 导出的函数：状态订阅、权限请求、定位、路径规划、导航控制
- 内部核心机制：后台定位任务、GPS 信号质量评估、偏航检测、多策略定位、TTS 语音播报
- 依赖关系

#### 数据解析器 (src/services/dataParser.ts)
- 核心函数：文件解析、字段检测、坐标转换时机
- 字段检测逻辑：`FieldMapping` 接口、`detectFields` 函数

#### 流式解析器 (src/services/streamingParser.ts)
- 核心函数：流式解析入口、Excel/CSV 流式解析
- 配置参数：`BATCH_SIZE`, `YIELD_INTERVAL`
- Excel 流式解析流程
- CSV 流式解析

#### 异步解析器 (src/services/asyncParser.ts)
- 核心函数：异步解析入口、分片处理
- 配置参数：`chunkSize`, `yieldInterval`
- 分片处理机制：`processInChunks`、`waitForInteraction`、`yieldToMainThread`

#### 配置管理 (src/utils/config.ts)
- 导出的常量/函数
- API 地址解析优先级
- 连接测试

#### 服务层依赖关系图

**适合阅读:** 需要深入了解服务层 API 和实现的开发者

---

### 5. [运行和部署指南](./05-运行和部署指南.md)

**内容概要:**

#### 环境要求
- Node.js 版本要求
- 包管理器
- Expo CLI
- Android 环境

#### 安装依赖
```bash
npm install
```

#### 开发运行
- 启动开发服务器：`npm start`
- 在 Android 设备/模拟器运行：`npm run android`
- 连接物理设备步骤

#### 构建发布
- 构建 Android APK：`npm run build:android`
- 使用 EAS Build：安装 EAS CLI、登录、配置、构建命令、查看状态、下载产物

#### 环境变量配置
- `.env` 文件创建
- 变量说明：`EXPO_PUBLIC_API_URL`
- API 地址解析优先级

#### 权限配置
- Android 权限列表
- 后台定位配置

#### 缓存系统
- 缓存目录结构
- 首次启动自动缓存
- 手动刷新
- 本地导入

#### 调试技巧
- React Native Debugger
- 查看日志
- 网络请求调试
- 性能监控

#### 常见问题
- 无法连接到开发服务器
- Android 构建失败
- 定位权限被拒绝
- 缓存数据不更新
- 大文件导入卡死

#### 部署流程
- 版本号管理
- 构建 Release APK
- 使用 EAS Build
- 分发方式

#### 监控和维护
- 日志收集（Sentry）
- 性能监控
- 崩溃报告

#### 更新策略
- OTA 更新
- 强制更新

#### 备份和恢复
- 备份缓存数据
- 恢复缓存数据
- 备份收藏数据

#### 安全建议
- API 密钥保护
- HTTPS
- 输入验证
- 权限最小化
- 数据加密

#### 性能优化建议
- 使用聚类
- 视窗过滤
- 懒加载
- 缓存策略
- 代码分割
- 图片优化
- 减少重渲染

#### 开发规范
- 代码风格
- 提交规范
- 分支管理

#### 相关资源
- Expo 文档
- React Native 文档
- 高德地图文档
- Zustand 文档

**适合阅读:** 需要运行、调试或部署项目的开发者

---

## 快速导航

### 按角色阅读

#### 新入职开发者
1. 阅读 [项目架构总览](./01-项目架构总览.md) - 了解项目全貌
2. 阅读 [模块详解](./02-模块详解.md) - 了解各模块职责
3. 阅读 [运行和部署指南](./05-运行和部署指南.md) - 搭建开发环境

#### 前端开发者
1. 阅读 [模块详解](./02-模块详解.md) - 了解组件和页面
2. 阅读 [数据流和状态管理](./03-数据流和状态管理.md) - 了解状态管理
3. 阅读 [API 和服务层](./04-API和服务层.md) - 了解服务调用

#### 后端开发者
1. 阅读 [API 和服务层](./04-API和服务层.md) - 了解 API 接口
2. 阅读 [数据流和状态管理](./03-数据流和状态管理.md) - 了解数据处理
3. 阅读 [项目架构总览](./01-项目架构总览.md) - 了解整体架构

#### 运维/部署人员
1. 阅读 [运行和部署指南](./05-运行和部署指南.md) - 了解部署流程
2. 阅读 [项目架构总览](./01-项目架构总览.md) - 了解技术栈

### 按任务阅读

#### 修改地图渲染逻辑
1. [模块详解 - MapView.tsx](./02-模块详解.md#mapmapviewtsx---核心地图视图)
2. [数据流和状态管理 - 聚类和视窗过滤机制](./03-数据流和状态管理.md#聚类和视窗过滤机制)
3. [数据流和状态管理 - 完整数据流图](./03-数据流和状态管理.md#完整数据流图)

#### 添加新的数据源
1. [API 和服务层 - 数据解析器](./04-API和服务层.md#数据解析器-srcservicesdatapatserts)
2. [API 和服务层 - 流式解析器](./04-API和服务层.md#流式解析器-srcservicesstreamingparserts)
3. [数据流和状态管理 - 大文件导入和解析流程](./03-数据流和状态管理.md#大文件导入和解析流程)

#### 修改导航功能
1. [模块详解 - NavigationPanel.tsx](./02-模块详解.md#navigationnavigationpaneltsx---导航面板)
2. [API 和服务层 - 导航服务](./04-API和服务层.md#导航服务-srcservicesnavigationservicets)
3. [数据流和状态管理 - 坐标转换系统](./03-数据流和状态管理.md#坐标转换系统)

#### 修改缓存策略
1. [API 和服务层 - 缓存服务](./04-API和服务层.md#缓存服务-srcservicescacheservicets)
2. [数据流和状态管理 - 缓存机制详解](./03-数据流和状态管理.md#缓存机制详解)

#### 修改 API 地址配置
1. [API 和服务层 - 配置管理](./04-API和服务层.md#配置管理-srcutilsconfigts)
2. [模块详解 - settings.tsx](./02-模块详解.md#settingstsx---设置页)

---

## 核心概念

### 1. 坐标系统

**WGS84 ↔ GCJ02 转换**

- **WGS84**: GPS 标准坐标，后端返回的数据使用
- **GCJ02**: 国测局坐标（火星坐标），高德地图使用，在中国境内有偏移

**关键原则:** 所有进入地图渲染的坐标必须是 GCJ02

**转换时机:**
1. 后端数据导入时立即转换
2. 本地文件导入时转换
3. GPS 定位后转换

**相关文件:** `src/utils/coordinate.ts`

### 2. 缓存策略

**三级缓存:**
1. 本地文件缓存（优先）
2. 后端 API 下载（回退）
3. 用户手动刷新（更新）

**缓存目录:**
```
FileSystem.documentDirectory}cache/
├── fullParams/          # 全量工参
├── geoData/             # 地理化数据
├── layers/              # 图层文件
└── meta/                # 元数据（AsyncStorage）
```

**相关文件:** `src/services/cacheService.ts`

### 3. 性能优化

**大数据量渲染:**
- 聚类：20000+ 点数据时使用 Supercluster 自动聚类
- 视窗过滤：使用 RBush 空间索引只渲染视窗内的点
- 数量限制：视窗内超过 1000 个点时自动均匀采样

**大文件处理:**
- 流式解析：>5MB 或 >5000 行使用流式解析，分块读取
- 异步处理：中等文件使用 InteractionManager + 分片处理
- 让出主线程：每处理 50-100 行让出一次，防止 ANR

**相关文件:**
- `src/utils/clusterManager.ts`
- `src/utils/viewportFilter.ts`
- `src/services/streamingParser.ts`
- `src/services/asyncParser.ts`

### 4. 状态管理

**Zustand 全局状态:**
- 扇区数据：`lteSectors`, `nrSectors`
- 缓存状态：`cacheAvailable`, `cacheUpdatedAt`
- 标记/收藏：`markers`, `favorites`
- 测量：`measurePoints`, `measureMode`
- 导航：`isNavigating`, `gpsSignal`, `pendingNavi`
- 搜索：`searchMarker`, `focusLocation`

**持久化:**
- 仅 `favorites` 持久化到 AsyncStorage
- 其他状态应用重启后清空

**相关文件:** `src/store/mapStore.ts`

### 5. API 地址解析

**优先级:**
1. 用户自定义地址（AsyncStorage）
2. 环境变量 `EXPO_PUBLIC_API_URL`
3. LAN IP（从 `Constants.expoConfig.hostUri` 推导）
4. 回退 `http://localhost:8000`

**相关文件:** `src/utils/config.ts`

---

## 关键文件索引

### 入口文件
- `App.tsx` - 应用入口
- `app/_layout.tsx` - 根布局
- `app/(tabs)/_layout.tsx` - Tab 布局

### 页面组件
- `app/(tabs)/index.tsx` - 地图主屏
- `app/(tabs)/data.tsx` - 数据管理
- `app/(tabs)/favorites.tsx` - 收藏列表
- `app/(tabs)/settings.tsx` - 设置页

### 核心组件
- `src/components/Map/MapView.tsx` - 核心地图视图
- `src/components/Navigation/NavigationPanel.tsx` - 导航面板
- `src/components/Search/SearchBar.tsx` - 搜索栏
- `src/components/Marker/MarkerList.tsx` - 标记列表
- `src/components/Measure/MeasureControl.tsx` - 测量控制

### 服务层
- `src/services/api.ts` - API 服务
- `src/services/cacheService.ts` - 缓存服务
- `src/services/navigationService.ts` - 导航服务
- `src/services/dataParser.ts` - 数据解析器
- `src/services/streamingParser.ts` - 流式解析器
- `src/services/asyncParser.ts` - 异步解析器

### 状态管理
- `src/store/mapStore.ts` - Zustand 全局状态

### 类型定义
- `src/types/data.ts` - 共享类型定义

### 工具函数
- `src/utils/config.ts` - 配置管理
- `src/utils/coordinate.ts` - 坐标转换
- `src/utils/clusterManager.ts` - 聚类管理
- `src/utils/viewportFilter.ts` - 视窗过滤

### 配置文件
- `package.json` - 依赖配置
- `tsconfig.json` - TypeScript 配置
- `app.json` - Expo 配置
- `eas.json` - EAS Build 配置
- `.env` - 环境变量（本地配置）

---

## 技术栈总结

| 类别 | 技术 | 版本 | 用途 |
|------|------|------|------|
| 核心框架 | React Native | 0.76.9 | 移动应用框架 |
| 开发工具 | Expo SDK | 52.0.0 | 开发工具和原生模块 |
| UI 框架 | React | 18.3.1 | UI 框架 |
| 类型系统 | TypeScript | 5.3.0 | 类型检查 |
| 导航 | React Navigation | 7.x | 路由和导航 |
| 状态管理 | Zustand | 5.0.12 | 全局状态管理 |
| 地图 | react-native-amap3d | 3.2.4 | 高德地图封装 |
| WebView | react-native-webview | 13.12.5 | WebView 封装 |
| 数据处理 | xlsx | 0.18.5 | Excel 解析 |
| CSV 解析 | papaparse | 5.5.3 | CSV 解析 |
| 压缩 | jszip | 3.10.1 | ZIP 压缩 |
| 聚类 | supercluster | 8.0.1 | 点聚类 |
| 空间索引 | rbush | 4.0.1 | 空间索引 |
| 定位 | expo-location | 18.0.10 | GPS 定位 |
| 语音 | expo-speech | 13.0.1 | TTS 语音播报 |
| 文件系统 | expo-file-system | 18.0.12 | 文件系统 |
| 文件选择 | expo-document-picker | 13.0.3 | 文件选择 |
| 后台任务 | expo-task-manager | 12.0.3 | 后台任务 |
| 网络请求 | axios | 1.15.1 | HTTP 请求 |
| 本地存储 | AsyncStorage | - | 本地持久化 |

---

## 项目特点

### 1. 离线优先
- 首次启动自动缓存全量数据
- 优先读本地缓存，后台刷新
- 支持本地文件导入

### 2. 大数据量支持
- 20000+ 点数据聚类渲染
- 视窗过滤只渲染可见点
- 大文件流式解析防 ANR

### 3. 完整导航功能
- GPS 多策略定位
- 高德路径规划
- TTS 语音播报
- 偏航检测与重新规划
- 后台定位保活

### 4. 灵活配置
- API 地址动态切换
- 支持多环境配置
- 用户自定义设置

### 5. 性能优化
- 空间索引（KD-Tree/R-Tree）
- 分片处理
- 主线程让出
- 缓存策略

---

## 文档维护

### 更新时机
- 新增模块时
- 修改核心逻辑时
- 重构代码时
- 发现文档不准确时

### 更新流程
1. 修改对应文档
2. 更新本索引（如有必要）
3. 提交 PR 并说明修改内容

### 文档规范
- 使用 Markdown 格式
- 代码示例使用 TypeScript
- 保持中文表述
- 包含必要的代码链接

---

## 联系与支持

如有问题或建议，请：
1. 查阅相关文档
2. 查看代码注释
3. 联系项目维护者

---

**文档生成时间:** 2026-06-14  
**项目版本:** 1.0.0  
**文档版本:** 1.0.0
