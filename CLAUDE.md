# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**NetworkPlanningTooV3**（网优引擎 v3.0）：电信网络规划应用。

**架构**：FastAPI + SQLite 后端提供 REST API，并同时以 SPA 方式托管 Vite + React 18 前端构建产物；另有独立的 Expo / React Native 移动端。

- **前端**：`frontend/src/renderer/`，生产构建产物 `frontend/dist-renderer/`，由后端同域托管（前端走 `/api/v1/...`，无独立 Web 服务器）
- **后端**：`backend/`，FastAPI + SQLAlchemy 2.0 + SQLite（仓库根 `data/data.db` 为权威数据源，Excel 双写）
- **移动端**：`mobile-app/`（Expo，独立工程，有自己的 CLAUDE.md / AGENTS.md，本文件不覆盖）；调用同一后端，APK 由 `/api/v1/app-versions` 分发
- **桌面端（Windows）**：`desktop/`，pywebview 壳 + 进程内 uvicorn 跑同一套 FastAPI，PyInstaller onedir → Inno Setup 安装包，由 GitHub Actions 在 windows-latest 出包；支持「共享 / 单机」两种运行模式
- **Electron / Capacitor 已废弃**：`frontend/electron/` 目录不存在，electron 依赖已从 `package.json` 移除。仅遗留 `package.json.electron`、`start-electron-dev.bat`、`capacitor.config.ts` 等历史文件，**不要**按 Electron / Capacitor 方式启动或构建。

**主要功能**：

- **规划**：PCI 规划（碰撞/混淆、模 3/模 30）、邻区规划（覆盖圆）、TAC 核查与 TAC 规划（异 TAC 孤岛/插花）
- **地图**：在线（高德/OSM）/离线地图、工参扇区渲染、专题图层、值热力面、标签防重叠、图层制作与编辑（TAB/MIF/KML）、绘制/测量/圈选/节点合并、条件选择、缓冲区、图例与导出
- **数据**：Excel/CSV/TXT/TAB/MIF 上传、全量工参、小区查询/批量更新、新站录入、地理化数据
- **工具**：批量距离匹配、站间距、频点换算（LTE/NR/GSCN）
- **平台**：用户与权限、数据组隔离、网优助手（LLM）、APP 版本管理、许可证

## 常用开发命令

### 后端（`backend/`）

```bash
cd backend

# 首次运行（生产 systemd 使用的也是 backend/.venv）
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 启动（开发；NPT_RELOAD=true 时热重载）
python main.py

# 单次运行（main.py 内已 create_app()）
uvicorn main:app --host 127.0.0.1 --port 8000
```

- 后端地址 http://127.0.0.1:8000 ｜ Swagger http://127.0.0.1:8000/docs

### 前端（`frontend/`）

```bash
cd frontend
npm install

npm run dev          # Vite 开发服务器 http://localhost:5173
npm run build        # 等价 build:vite，产物 dist-renderer/
npm run lint         # eslint src --ext .ts,.tsx
npm run type-check   # tsc --noEmit
```

- Vite 代理：`/api`、`/layer-files` → `http://localhost:8000`；`/ws` → `ws://localhost:8000`
- 仓库根 `package.json` 是空的 `{}`，前端脚本全部在 `frontend/package.json`

### 测试

```bash
# 后端 pytest（仓库无 pytest.ini，需从 backend/ 目录运行）
cd backend
python -m pytest tests/ -v                        # 全部
python -m pytest tests/test_cell_query_update.py -v   # 单文件
python -m pytest -k "bulk_update"                 # 按用例名
python -m pytest -s                               # 显示 print
```

- `backend/tests/conftest.py` 在缺少 geopandas/shapely/fiona/pyogrio 时自动 mock，无 GDAL 也能跑测试

```bash
# 前端 vitest（配置内嵌于 vite.config.ts 的 test 块：jsdom + src/test/setup.ts）
cd frontend
npm run test                                      # vitest run
npx vitest run src/renderer/utils/__tests__/frequencyConversion.test.ts  # 单文件
npx vitest run -t "GSCN"                          # 按用例名过滤
```

- `scripts/run-tests.sh` 依次执行后端 pytest 与前端 vitest

### 桌面端（Windows 安装包，`desktop/`）

```bash
# 仅在 Windows 上构建；CI 见 .github/workflows/build-windows-desktop.yml
pip install -r backend/requirements.txt -r desktop/requirements-desktop.txt
python desktop/tools/make_icon.py                       # 生成 desktop/app.ico（构建期产物，不入库；安装器
                                                        # 拷成 app-<版本>.ico 作快捷方式图标并刷新图标缓存）
python desktop/tools/spike.py                           # GDAL / pywebview / TAB 读写 / 上传链路基线自检
pyinstaller --noconfirm --clean desktop/desktop.spec    # → dist/NetworkPlanningTool/{NPT.exe,_internal/}
NPT.exe --selftest                                      # 打包产物冒烟
ISCC desktop/installer.iss                              # → installer-out/NetOpt Engine_Setup-*.exe
```

- 权威打包链路是 `desktop/desktop.spec` + `.github/workflows/build-windows-desktop.yml`；根 `nptserve.spec` 是遗留配置（入口 `/tmp/nptserve/entry.py` 不在仓库内），**不要**用它构建
- CI 触发：`workflow_dispatch`、push 到 `feat/windows-desktop`、push tag `desktop-v*`；仅 tag 触发时用 `gh release create` 发布安装包
- CI 会跑桌面相关 pytest（`test_desktop_license*` / `test_desktop_local_*` / `test_desktop_releases` / `test_desktop_update_client` / `test_desktop_shared_mode` 等）并校验打包产物含 gdal/proj DLL、`proj.db`、`WebView2Loader.dll`、`frontend/dist-renderer/index.html`

### 生产部署（Linux + systemd + Cloudflare Tunnel）

```bash
cd frontend && npm run build:vite     # 前端改动必须先构建
systemctl restart npt-backend         # 后端改动 / 前端构建后重启
```

- 入口 https://app.pengwc.asia → cloudflared 隧道 → `localhost:8000`
- systemd 单元 `/etc/systemd/system/npt-backend.service`：`WorkingDirectory=/home/pwc/NetworkPlanningTooV3/backend`、`ExecStart=.../backend/.venv/bin/python3 main.py`、`NPT_RELOAD=false`、`MemoryMax=2G`（仓库根同名文件为参考副本）
- 日志：`journalctl -u npt-backend -n 100 --no-pager` 或 `tail -f /var/log/npt-backend.log`
- `backend/Dockerfile`、`frontend/Dockerfile` 存在但无编排、未用于生产；生产以 systemd 为准

## 高层架构

```
浏览器 / mobile-app (Expo, JWT)
   │ HTTPS  app.pengwc.asia → cloudflared → localhost:8000
   ▼
FastAPI (backend/app/)
   ├─ /api/v1/*         REST 端点 (api/v1/endpoints/)
   ├─ /api/v1/ws/tasks  WebSocket 任务推送
   ├─ /static           outputs/ 静态文件
   ├─ /layer-files      uploads/layers 图层文件
   └─ SPA 兜底          frontend/dist-renderer/index.html
        │
   services/     业务逻辑：数据 / 任务 / 图层 / 认证 / 助手…
        │
   algorithms/   PCI、邻区、距离
        │
   存储：data/data.db (SQLite，权威) + data/<id>/original.xlsx (双写)
        + data/index.json (内存索引) + outputs/ + exports/ + uploads/
```

### 分层职责（`backend/app/`）

| 层 | 位置 | 职责 |
|----|------|------|
| API 层 | `api/v1/endpoints/` | HTTP、参数校验、鉴权/权限依赖 |
| 服务层 | `services/` | 业务逻辑、数据管理、任务编排 |
| 算法层 | `algorithms/` | 纯计算：PCI、邻区、距离 |
| ORM 模型 | `models/database.py` | SQLAlchemy 表定义（12 张表） |
| Pydantic 模型 | `models/schemas.py` | 请求/响应模型 |
| 基础设施 | `core/` | `config.py`(Settings/`NPT_`)、`database.py`(引擎+迁移+默认管理员)、`security.py`(JWT+权限依赖)、`data_access.py`(数据组鉴权) |
| 应用入口 | `main.py` + `api/__init__.py` | UTF-8 处理；create_app/lifespan（建目录、清索引、init_db、预取图层缓存）、静态 SPA |

### 数据与存储（改动前必读）

- SQLite `data/data.db`（仓库根，非 `backend/data/`）是查询与规划的权威数据源（WAL、外键），由 `core/database.py` 管理
- `init_db()` 用 `PRAGMA table_info` 做轻量迁移（**无 alembic**），启动时创建默认管理员 `admin` / `admin123`（`must_change_password=True`，首次登录强制改密）
- 上传 Excel 时同时写 SQLite（Workbook/Site/Sector 等）并保留 `data/<id>/original.xlsx`；下载/导出时从 SQLite 反写 Excel
- `data/index.json` 是内存索引的持久化，启动时与 SQLite 中的 Workbooks/GeoFiles/Layers 对账合并
- **ORM 表**（`models/database.py`，15 张）：`users`、`user_sessions`、`workbooks`、`sites`、`sectors`、`geo_files`、`layers`、`user_settings`、`task_results`、`app_versions`、`desktop_licenses`、`desktop_releases`、`dataset_revisions`、`station_param_rows`、`station_metric_rows`
- 桌面端相关列：`users.is_desktop_shadow`（服务器侧影子账号，承载无绑定授权的数据归属）、`users.desktop_run_mode`（`shared`/`standalone`，网页端恒 NULL）；`desktop_licenses` 另有 `mode`/`username`/`user_id`/`login_count`/`last_login_at`/`idle_logout_days`

### 数据组隔离（地市 + 运营商）

数据空间按 `(city, operator)` 分组隔离，**数据归组所有**，是本项目最容易踩坑的横切约束：

- **写入盖章**：上传/创建数据时从操作者（或其操作的工参所属组）复制组信息
- **查询过滤**：所有用户**含管理员**一律仅见同组数据，不设跨组特权；用户组信息缺失（city/operator 为 NULL）不可见任何业务数据
- **存量迁移**：启动时把 city/operator 为 NULL 的存量数据迁移归入主管理员所在组
- **落地工具**：`services/data_group.py`（`user_group`、`group_sql_filter`、`index_entry_visible`）、`core/data_access.py`（`require_data_group_access`、`require_task_access`，失败一律 **404** 以不泄露数据存在性）
- 新增任何数据查询/写入路径都必须接上组门禁；`OPERATORS = ["移动","联通","电信","广电"]` 是唯一来源

### 认证与权限

- JWT Bearer（python-jose，HS256，默认 1440 分钟）+ bcrypt（passlib）；`user_sessions` 表支持会话吊销、IP 绑定与空闲超时
- `core/security.py` 依赖：`get_current_user`、`get_current_admin_user`、`require_permission(...)`，预置 `require_data_import` / `require_data_delete` / `require_data_update` / `require_cell_entry` / `require_cell_query_update` / `require_assistant`（管理员绕过权限位）
- 会话空闲超时：`NPT_SESSION_IDLE_TIMEOUT_MINUTES`（默认 180），由 `get_current_user` 在每次请求校验
- 前端：`authStore` 持久化 `localStorage['auth-storage']`；`services/api.ts` 自动附加 Bearer，401 时清除凭证并派发 `auth:required`；`AuthGuard` 包裹全应用（未登录只显示 `LoginModal`），`ProtectedRoute` 处理 license 到期 / `requireAdmin` / `requirePermission`；`useHeartbeat` 每 4 分钟 ping

### 桌面端运行形态（`desktop/`）

- `desktop/launcher.py` 是 PyInstaller 入口：daemon 线程跑 uvicorn 绑 `127.0.0.1` 随机端口，主线程开 pywebview 窗口；注入 `NPT_DESKTOP=1`、`NPT_MAX_WORKERS=1`（Windows 无 fork）、`NPT_SERVER_URL`（默认 `https://app.pengwc.asia`）；可写数据落 `%APPDATA%\NetworkPlanningTool`（`NPT_DATA_ROOT` 可覆盖），与安装目录解耦；**业务数据按运行模式分档**（`profiles/shared/`、`profiles/standalone/` 各一套 data.db/导入文件/任务历史，详见「数据隔离」）；Windows 命名互斥体 `Local\NPTDesktop` 保证单实例；创建窗口须显式 `text_select=True`（pywebview 默认 False 会注入 `body{user-select:none}`，桌面端 UI 文字无法选中复制，网页端却能复制）；地图页「全屏」由壳层切窗口全屏（`POST /desktop/fullscreen` → `desktop_bridge.set_window_fullscreen` → pywebview `toggle_fullscreen()`，退出后补 `maximize()` 回到启动时的最大化窗口）——WebView2 里的 HTML Fullscreen 只让网页内容占满 WebView 自身，窗口/标题栏不变、占不满屏幕
- **同一份后端代码跑两种形态**：`NPT_DESKTOP=1` 时 `api/__init__.py` 额外挂后台协程（`desktop_cloud_client.renewal_loop` 静默续期、`desktop_sync_service.sync_loop` 共享模式同步、`desktop_local.session_guard_loop` 单设备登录校验），并放行 `/api/v1/desktop`；服务器专用管理端点（`admin_users` 等）经 `core/security.reject_desktop_mode` 在桌面形态下一律 404
- **所有桌面分支必须由 `NPT_DESKTOP` 门控，不得改变服务器（systemd）部署行为**
- 授权：Ed25519 密钥对由 `desktop/tools/gen_keypair.py` 生成，私钥在 `desktop/tools/keys/`（已 gitignore，**禁止入库/外发**），公钥 hex 写入 `backend/app/core/license_public_key.py`；`desktop/tools/gen_license.py` 签发离线 `.nptlic`
- 同步凭证：云端数据同步端点的身份是**签名许可文件 + 机器码**（非 JWT），见 `desktop_cloud._verify_license`

### 异步任务处理

- `services/task_manager.py`（单例）：`asyncio` + 信号量 `NPT_MAX_TASKS`，可选 ProcessPool（`NPT_MAX_WORKERS`）；状态 PENDING → PROCESSING → COMPLETED/FAILED
- 进度经 `websocket_manager` 广播到 `/api/v1/ws/tasks`；结果落 `outputs/tasks_index.json` 与 `task_results` 表。**索引只存元数据**：任务结果落 `outputs/task_results/<task_id>.json`，重启后由 `_ensure_result` 按需装载（sidecar → `task_results.result_json` 兜底），`_persist_task` 也不再整文件读写；旧版「结果内嵌」的大索引（>8MB）启动时**不解析**，由 `migrate_legacy_index_if_needed()` 在延后队列里拆分（服务器端 lifespan 同步跑一次）。历史上该文件曾达 271MB，导入期解析要 6 秒以上
- 前端以 `taskStore` 轮询为主，WebSocket 目前只消费全局 `task_deleted` 消息
- PCI/TAC「应用到工参」直接 UPDATE SQLite，随后后台线程同步回 Excel

### 算法层现状

- **活跃**：`algorithms/pci_planning_v1_service.py`（`task_manager.py` 实际调用，**不是 v2**）、`neighbor_planning_v1_service.py`、`distance_calculator.py`
- **非活跃**：`pci_planning_service_v2.py`（仅测试与未接线的 `_run_pci_sync` 引用）、`pci_planning_service.py`、`pci_collision_detector.py`（死代码，勿据其推断现状）
- TAC 规划另用 scikit-learn BallTree 做插花检测

### 前端架构（`frontend/src/renderer/`）

- 路由在 `App.tsx`：`LastRouteTracker > AuthGuard > MainLayout > Suspense > Routes`；页面由 `pageLoaders.ts` 做 `React.lazy` 分包 + `recoverable`（chunk 加载失败自动刷新一次）+ 导航悬停预取
- Zustand store（`store/`，17 个）：`authStore`（含桌面端 `desktopMode`/`desktopProbed`/`desktopRunMode`/`desktopPendingUsername`，`probeDesktopMode()` 探测本机后端）、`dataStore`、`taskStore`、`mapStore`（按用户持久化，与后端 user settings 同步）、`layerEditStore`（图层编辑真源：workspaces/撤销/剪贴板）、`mapDataCacheStore`（跨页 LRU）、`desktopSyncStore`（共享模式每 5s 轮询 `/desktop/sync-status`，同步落地派发 `DESKTOP_SYNCED_EVENT`）、`licenseStore`、`pciStore`/`neighborStore`/`tacCheckStore`/`tacPlanningStore`（向导状态）、`tacStore`（旧版，`@deprecated`）、`themeStore`、`toastStore`、`downloadStore`；`uploadStore` 不是 Zustand（分片上传单例）
**切账号时的内存态清理**：`authStore.clearUserDataCaches()`（登录/注册/登出/桌面登录四处调用）统一清 `mapDataService` 内存缓存、数据列表、`layerEditStore`（工作集/撤销栈/剪贴板/编辑态，`resetForUserSwitch`）与 `mapDataCacheStore`（图层 GeoJSON/工参/地理化 LRU）；新增「按用户隔离」的内存态必须挂到这里，否则会出现「上一账号打开过的图层/未保存改动」带到下一个账号（2026-10-13 修：3D 基站图层显隐曾停在挂载那一刻的值、编辑工作集跨账号残留）。
- `services/api.ts`：`apiClient`（`/api/v1`，300s）+ `uploadClient`（dev 直连 8000，规避 multipart 代理问题）+ 拦截器；按域导出 `authApi` / `adminUserApi` / `userSettingsApi` / `appVersionsApi` / `dataApi` / `layerApi` / `layerToolsApi` / `pciApi` / `neighborApi` / `tacApi` / `tacPlanningApi` / `distanceMatchApi` / `siteSpacingApi` / `mapApi` / `assistantApi` / `systemApi`（`info`/`desktopMode`）/ `desktopLoginApi` / `desktopCloudApi` / `desktopLicensesApi` / `desktopReleasesApi` / `desktopUpdateApi` 等
- 地图（`components/Map/`，44 个 `.ts`/`.tsx` 源文件，另有 `__tests__/`）：`OnlineMap.tsx`（2D，Leaflet + 高德，跨页共享实例缓存，托管图层/选择/编辑会话）、`cesium/CesiumMap.tsx`（3D，CesiumJS + 天地图影像，`OnlineMap` 的同构替身：同一套 props 与 `OnlineMapRef`，MapPage 按 `mapProvider` 只换挂载点）、`OfflineMap.tsx`、`MapInfoLayer.tsx`（TAB/MIF）、`GeoDataLayer.tsx`、`SectorRendererSVG.tsx`（LTE/NR 扇区 + PCI 模着色）、`LayerControl.tsx`（图层树：显隐/可选/编辑开关/排序）、`labelLayoutCore.ts`（标签防重叠与绘制的共享纯函数）+ `LabelLayoutManager.ts`（2D Leaflet 侧接入）+ `cesium/CesiumLabelOverlay.ts`（3D 侧接入，同一算法）、`HeatmapLayerManager.ts`（2D 值热力面）+ `cesium/CesiumHeatmapLayer.ts`（3D 侧，共用计算与栅格化）、`OriginalSamplesLayer.ts`、`FloatingPanel.tsx`（可拖拽缩放面板）、`AttributeJoinDialog.tsx`（条件选择）、`BufferDialog.tsx`（绘制缓冲区）、各类图例与对话框。
  - **2D/3D 行为必须拉齐**：3D 的交互手势、配色、图例口径一律以 2D 为准（测量＝右键结束、圈选＝拖动有框且松手保留终态框、点选＝橙色描边、标签统一防重叠）。3D 侧的高频重绘图形（圈选框、点选高亮、标签）走**屏幕空间覆盖层**（SVG / Canvas），不要每次鼠标移动都重建 Cesium 贴地图元——`clampToGround` 图元要等地形瓦片就绪才出图，每帧重建等于永远画不出来，且集合在渲染帧附近被改会触发 Cesium 内部 `TypeError: ...reading '_target'`。
- 图层编辑子系统：`components/Map/LayerEditSession.ts`（绘制/顶点/吸附/圈选/命中，由 OnlineMap 懒创建）+ `store/layerEditStore.ts`；工具栏在 `pages/MapPage.tsx`
- 坐标约定见下方「坐标系」
- i18n：i18next 单 namespace，`locales/zh.json` / `en.json`（约 1600 行 / 23 个分组）；语言切换入口在 LicensePage

### 前端路由表

| path | 页面 | 说明 |
|------|------|------|
| `/license` | `LicensePage` | 许可证/主题/语言/LLM 配置（唯一不受 `ProtectedRoute` 限制） |
| `/` | `HomePage` | 首页（直接 import，非懒加载） |
| `/data` | `DataPage` | 数据管理（上传/预览/查询更新/新站录入） |
| `/pci` | `PCIPage` | PCI 规划 |
| `/neighbor` | `NeighborPage` | 邻区规划 |
| `/tac` | `TACPage` | TAC 核查 |
| `/tac-planning` | `TACPlanningPage` | TAC 规划 |
| `/map` | `MapPage` | 地图工具（在线/离线、搜索、图层、绘制、编辑） |
| `/layer` | `LayerToolsPage` | 图层制作（Excel → TAB/MIF/KML） |
| `/distance-match` | `DistanceMatchPage` | 批量距离匹配 |
| `/site-spacing` | `SiteSpacingPage` | 站间距计算 |
| `/frequency-conversion` | `FrequencyConversionPage` | 频点换算 |
| `/admin/users` | `AdminUsersPage` | 用户管理（`requireAdmin`） |
| `/app-versions` | `AppVersionsPage` | APP 版本管理（`requireAdmin`） |
| `/assistant` | `AssistantPage` | 网优助手（`requirePermission="can_assistant"`） |
| `/desktop-releases` | `DesktopReleasesPage` | 桌面版安装包分发（`requireAdmin`，侧栏仅非桌面形态的管理员可见） |
| `/desktop-licenses` | `DesktopLicensesPage` | 桌面授权管理（`requireAdmin`，同上）；编辑弹窗只保留「无操作退出登录时长（天）」，到期/数据组跟随用户管理 |
| `*` | — | 重定向 `/` |

> `pages/HistoryPage.tsx`、`pages/TaskConfigPage.tsx`、`pages/NetworkStatusDemo.tsx` 未挂路由（组件级/演示用途）。

**桌面形态下的前端差异**：是否桌面端由 `authStore.probeDesktopMode()` 探测本机后端（`GET /system/desktop-mode` → `settings.NPT_DESKTOP`）得出，`AuthGuard` 探测完成前显示 spinner 以免闪出网页登录页。桌面端隐藏管理员侧栏入口与管理员授权卡片，改走 `desktopCloudApi.appVersion()`；`components/` 下的 `DesktopAuthPendingDialog`（单机待批 5s 轮询）、`DesktopSessionGuard`（单设备登录 30s 校验）、`DesktopSyncIndicator`（共享模式同步状态）、`DesktopUpdateDialog`（OTA）仅在桌面形态生效。

## API 端点前缀（`api/v1/endpoints/`）

| 文件 | 前缀 | 说明 |
|------|------|------|
| `auth.py` | `/api/v1/auth` | 注册/登录/me/ping/登出/改密 |
| `admin_users.py` | `/api/v1/admin/users` | 用户 CRUD、重置密码、权限（admin） |
| `user_settings.py` | `/api/v1/user` | 用户设置（地图偏好等，GET/PUT `/settings`） |
| `data.py` | `/api/v1/data` | 上传（含分片）、全量工参与小区查询/批量更新、图层数据读写/下载 |
| `geo_data.py` | `/api/v1/data` | 地理化数据上传（与 data 同前缀，不同 tag） |
| `layer.py` | `/api/v1/layer` | 图层制作（`/excel-info`、`/point`、`/sector`） |
| `pci.py` / `neighbor.py` / `tac.py` | `/api/v1/pci` 等 | 规划/核查、进度、结果、历史、导出、应用到工参 |
| `distance_match.py` | `/api/v1/distance-match` | 批量距离匹配 |
| `site_spacing.py` | `/api/v1/site-spacing` | 站间距计算 |
| `attribute_join.py` | `/api/v1/attribute-join` | 条件选择（图层属性空间连接） |
| `buffer.py` | `/api/v1/buffer` | 绘制缓冲区 |
| `map.py` | `/api/v1/map` | 地图数据/小区/扇区、缓存清理、在线与离线配置 |
| `license.py` | `/api/v1/license` | 许可证状态/上传/激活 |
| `app_versions.py` | `/api/v1/app-versions` | APP 版本管理：latest/download（公开）、上传（admin、分片） |
| `assistant.py` | `/api/v1/assistant` | LLM 配置、数据集、对话（需 `can_assistant`） |
| `desktop_licenses.py` | `/api/v1/desktop-licenses` | 桌面授权管理（admin）：创建激活码/批准/禁用/解绑换机/重发码；数据组与到期以「用户管理」的（地市+运营商）/许可证到期为准（列表回写授权记录） |
| `desktop_cloud.py` | `/api/v1/desktop-cloud` | 桌面客户端**公开**接口（授权服务器侧）：账号登录/单设备会话校验、激活/续期/申请（凭证=激活码或签名许可 + 机器码，非 JWT）、`/config`、数据集同步（`/data/session|manifest|dataset/{id}/package`）、`releases/latest` 与 `releases/download/{id}`（Range） |
| `desktop_local.py` | `/api/v1/desktop` | 桌面版**本机**接口（仅 `NPT_DESKTOP=1`，否则 404）：`login`/`auth-poll`、`cloud-status|activate|renew|apply`、共享模式 `sync-status|run-mode|sync|sync-resolve`、`update/status|download|progress|snooze|install`、`exit`（经 `app/desktop_bridge.py` 关闭窗口）、`window-title`/`fullscreen`（经 `desktop_bridge` 写标题栏 / 切窗口全屏） |
| `desktop_releases.py` | `/api/v1/desktop-releases` | 桌面版安装包管理（admin）：分片上传、列表/编辑/删除/设最新 |
| `system.py` | `/api/v1/system` | 状态/信息（`/info`、`/desktop-mode` 供前端探测桌面形态） |
| `websocket.py` | `/api/v1/ws/tasks` | 任务进度推送 + 同组数据变更 `data_changed`（`?token=JWT` 登记数据组；**注意不是裸 `/ws`**） |

> 图层编辑/增量保存的端点不在 `layer.py`，而在 `data.py` 的 `PUT /{data_id}/layers/{layer_id}/data` 等路径，内部调用 `layer_edit_service` / `layer_patch_service`。

## 关键文件位置

### 后端

- `main.py` — 入口、UTF-8/print 兜底、uvicorn；`api/__init__.py` — create_app、lifespan、CORS、GZip、SPA 静态兜底
- `core/config.py` — Settings（`NPT_` 环境变量）；`core/database.py` — SQLite 引擎/迁移/默认管理员；`core/security.py` — JWT 与权限依赖；`core/data_access.py` — 数据组鉴权依赖
- `models/database.py` — ORM 表；`models/schemas.py` — Pydantic 模型
- `services/data_service.py` — 数据中心（单例）；`task_manager.py` — 任务引擎（单例）；`auth_service.py` — 认证/会话；`data_group.py` — 数据组隔离
- `services/layer_service.py` — 图层制作；`layer_edit_service.py` — 图层编辑保存/打包下载；`layer_patch_service.py` — 增量保存与版本冲突；`tab_io.py` — TAB 底层读写；`tab_style_writer.py` / `ogr_style_reader.py` — 逐要素样式读写；`mapinfo_service.py` — TAB/MIF/KML 解析与样式
- `services/buffer_service.py` — 缓冲区；`attribute_join_service.py` — 条件选择；`geo_data_service.py` / `geo_field_detector.py` — 地理化数据；`tac_planning_service.py` — TAC 规划；`distance_match_service.py` / `site_spacing_service.py` — 工具算法；`export_service.py` — 导出；`websocket_manager.py` — WS 广播
- `services/assistant/` — `chat_service.py`(function-calling)、`ingest_service.py`、`query_service.py`(只读 SQL 工具)、`llm_config.py`(配置持久化到 `data/llm_config.json`)
- 桌面端：`services/desktop_license_service.py`（授权记录/登录/续期/影子账号）、`desktop_signing.py`（Ed25519 签发与验签）、`desktop_cloud_client.py`（客户端→授权服务器 HTTP）、`desktop_sync_service.py`（共享模式数据集双向同步 + 同组任务历史 `sync_tasks()` + `repair_dataset()` 按需补拉不完整镜像）、`desktop_update_service.py`（OTA 检查/断点续传/sha256/静默安装）、`dataset_revision_service.py`（数据集修订号与墓碑）、`app/desktop_bridge.py`（桌面壳退出 / 窗口标题 / 窗口全屏回调）
- `utils/` — `coordinate_transformer.py`、`excel_columns.py`、`geojson_geometry.py`、`layer_type_config.py`、`hardware_fingerprint.py`

### 前端

- `App.tsx` — 路由与守卫；`pageLoaders.ts` — 懒加载/预取/chunk 恢复；`main.tsx` — 入口（首帧前 `applyTheme()`）；`i18n.ts` — 国际化
- `services/api.ts` — 全部后端 API 封装；`services/mapDataService.ts` — 工参拉取/过滤/坐标转换/LOD/IndexedDB 缓存
- `components/Map/` — 地图与图层编辑（见上文）；`store/` — Zustand；`utils/` — 坐标、配色、热力场、要素属性等纯函数
- `config/layer-config.ts`（图层字段匹配规则）、`config/sector-config.ts`（扇区渲染配置/LOD）

### 数据与产物

- `data/`（上传文件、`index.json`、`data.db`）、`outputs/`（任务结果）、`exports/`、`uploads/layers/`（图层文件）、`backend/app/apks/`（APK 文件）
- 桌面端：`desktop_releases/`（安装包仓库，`DESKTOP_RELEASES_DIR`）、`licenses/`（许可文件与 Ed25519 私钥）、`installer-out/`（本地 Inno Setup 产物）、`desktop/`（源码 + `desktop.spec` + `installer.iss` + `tools/`）
- 设计/实施历史文档在 `docs/plans/`（按日期，含图层/距离匹配/频点换算/小区查询等）
- 文档分工（见根 `AGENTS.md`）：本文件与根 `CODEBUDDY.md` **互为镜像**，改其一需同步另一份；`README.md` 是面向用户的功能概览；`docs/LICENSE_GUIDE.md` 等专题文档可能滞后于代码，以当前代码为准

## 数据流与关键模式

- **文件上传**：前端 → `POST /api/v1/data/upload/excel`（大文件走分片接口）→ Pandas 解析（LTE/NR 分表）→ 写 SQLite + `data/<id>/original.xlsx` → 刷新 `index.json`
- **规划任务**：配置 → `POST /api/v1/{pci,neighbor,tac}/plan` → `task_manager.create_*_task` → `asyncio` 执行算法 → 进度回调 → WS/轮询 → 结果存 `outputs/` 与 `task_results`
- **应用到工参**：规划结果直接 UPDATE SQLite，后台线程再同步回 Excel
- **工参更新**（现网工参合并进全量工参）：`POST /api/v1/data/update-parameters` → `task_manager.create_update_params_task` → `data_service.update_parameters()`（新建带时间戳的**新**全量工参条目，删同组旧全量工参，组归属继承）。三条硬约束（2026-10-08 加）：① 现网工参 CSV（`LTE_SDR_CellInfo_*` / `LTE_ITBBU_CellInfo_*` / `NR_CellInfo_*`）在本机缺失 → 桌面共享模式先 `desktop_sync_service.repair_dataset()` 从服务器补拉一次，仍缺失则**报错**；② 合并后一个小区都没匹配上也没新增行 → **报错**（否则会产出与更新前一致的文件）；③ 工作表缺 Key 列 → **报错**（原来静默跳过）。任务结果带 `stats`（每制式匹配/新增行数），前端展示"更新统计"
- **图层保存**：前端 GeoJSON（GCJ02）→ `PUT /api/v1/data/{dataId}/layers/{layerId}/data` → `layer_edit_service` 整层重写 TAB/MIF（含样式元数据列）→ 刷新数据条目时间戳。`source_file` 跨端后由 `services/layer_paths.py` 按当前数据目录同名文件回退；网页端写服务器 `DATA_DIR`，桌面共享写 `profiles/shared/` 再上行，单机写 `profiles/standalone/`
- **图层下载**：`GET /api/v1/data/{dataId}/layers/{layerId}/download` 打包同 stem 的 `.tab/.dat/.id/.map/.ind`
- **APP 分发**：管理端分片上传 APK（绕过 Cloudflare 100MB 限制）→ `app_versions` 表 + `backend/app/apks/`；客户端 `GET /api/v1/app-versions/latest` 与 `/download/{id}`（支持 Range、下载计数）
- **桌面版登录与授权（2026-10 改版）**：桌面端不再有 owner 免登录账号，与网页端**共用同一套账号**；桌面形态的登录页多一组「运行模式」选择：
  - **共享模式**：`POST /desktop/login`（本机）→ 代理 `POST /desktop-cloud/auth/login`（服务器）→ 用 `auth_service.authenticate_user` 校验网页端账号 → 为「账号 + 机器」自动签发许可（`DesktopLicense.mode='shared'`，兼作同步凭证）→ 本机镜像同名本地账号（组/权限位/管理员位照搬）→ 签发本机 JWT。**登录优先**：首次同步不在登录路径上跑，登录响应返回后 `LOGIN_SYNC_DELAY_SECONDS`（15s）由后台定时器触发一次 `sync_once`。
    - **离线/弱网登录（共享与单机一致，2026-10-17）**：两种模式都先在**线程池**里做本机凭据校验（`_local_offline_login`：管理员镜像账号免许可；普通用户要求本机许可 valid 且归属账号匹配 + bcrypt）。本机凭据有效时服务器只做 1.2s 快速探测（`STANDALONE_FAST_PROBE_SECONDS`，不重试），超时/网络不可达/5xx 立即离线进入（`_finish_offline_login(db, user, mode)`）：单机置 run_mode=offline，**共享保持 shared**（同步循环联网后自动恢复）；迟到的探测结果由 `_apply_late_login_probe` 后台补权限位/会话。本机无凭据（首次登录/换机/许可归属他人）才走完整在线请求（10s，`cloud.login` 对网络类错误含 TLS 握手超时自动重试 1 次，4xx/5xx 不重试）——修掉共享模式频繁报 `_ssl.c:993 handshake timed out` 后被挡在门外的问题。
    - **退出登录立即响应**：前端 `authStore.logout()` 先清本地登录态（登录窗立刻出现），`/auth/logout` 的服务器会话结束通知由后端 `npt-logout-notify` 守护线程 fire-and-forget（跨公网 HTTP/TLS 不好时不再卡 UI；服务器会话也会因心跳停止在活跃窗口过期）。
  - **单机模式**：同流程，但按 `(username, machine_code)` 找/建 `mode='standalone'` 授权；未批准返回 `result=pending`，前端 `DesktopAuthPendingDialog` 轮询 `POST /desktop/auth-poll`，管理员在网页端「桌面授权」页批准后签发许可。单机模式强制 `run_mode=offline`（数据本机私有、不参与同步）、隐藏授权/同步/数据组卡片。**离线可用**：本机已有该账号镜像且许可有效时，服务器登录只给短探测（`STANDALONE_ONLINE_PROBE_SECONDS`＝4s），连不上/5xx 立即离线登录（本地校验密码，`offline=true`）；许可过期/换机/账号不匹配按本地原因明确提示。离线登录置 `needs_license_verify`，联网后巡检经许可续期通道校验并续期（过期可自动换回有效许可），`license_verified`/`license_error` 随 `/desktop/session-status` 回传、前端 toast。**权限位与网页端一致**（不再全量放行），由管理员在「用户管理 → 编辑」设置；运行中经 `session-check` 心跳同步到本机镜像账号。**2026-10-09 调整**：① **管理员完全免授权**——服务端按模式直接签发 active 许可（忽略 pending/禁用/换机限制），本机离线也不要求已有许可（镜像管理员账号 + 密码即可登录）；② 普通用户**授权一次即可**——离线单机登录不再要求"本机许可必须是单机模式"，有效许可（shared/standalone）归属账号匹配 + 本机密码正确即可；③ **记住账号密码**——登录页勾选（默认勾选）后本机 Fernet 加密存 `DATA_ROOT/last_login.json`（密钥 `.last_login.key` 0600），`GET/DELETE /desktop/last-login` 读写，勾选时登录页自动登录一次（失败回退表单）；用户主动退出登录后本次不再自动登录（必须手动点登录），凭据保留、下次启动软件照常自动登录。

- **共享/单机数据物理隔离（2026-10-16）**：两种运行模式各用独立配置档（profile），路径 `%APPDATA%/NetworkPlanningTool/profiles/<shared|standalone>/`，档内各自持有 `data/data.db`（工参/图层/**历史任务**/用户镜像全部表）、`data/<id>/`（导入文件 original.xlsx 等）、`uploads/`、`outputs/`、`exports/`、`sync_state.json`；授权（`licenses/`）、记住密码、OTA（`updates/`）、`webview/`、日志、端口仍在数据根全局共享。配置档由 `core/desktop_profiles.py` 管理，launcher 导入 app 前读 `active_profile.json` 注入 `NPT_DESKTOP_PROFILE`（config 导入时按档定型路径）；首启自动把旧版平铺数据幂等迁入 shared 档（单机档从空库开始）。**切模式必须重启进程**：`/desktop/login`（注册同理）发现请求模式 ≠ 当前档时短路（不建镜像、不发 token、不触服务器），把加密的一次性凭据写全局 `pending_login.json` 并改 `active_profile.json`，前端收到 `restart_required` 调 `/desktop/restart`（Windows 脚本等退出后自动拉起，非 Windows 提示手动重启），新档登录页消费 pending 自动登录；浏览器侧 IndexedDB 缓存键经 `utils/cacheKey.ts` 追加 `_dshared/_dstandalone` 后缀，防止同账号两档镜像 id 相同导致串缓存。
  - **切档重启后仍进旧模式的根因与修复**：重启脚本会继承父进程的 `NPT_DESKTOP_PROFILE=shared` 环境变量，launcher 看到显式变量即跳过读 `active_profile.json`，新进程永远落在旧档（与 OTA 脚本的 `NPT_DESKTOP_VERSION` 继承坑同源）。双保险：① `write_relaunch_helper` 生成的 `.cmd` 在 `:launch` 前 `set "NPT_DESKTOP_PROFILE="`；② `spawn_relaunch` 用净化后的 `env={k:v for k,v in os.environ.items() if k!="NPT_DESKTOP_PROFILE"}` 拉起子进程。
  - **切档前必须用户确认**：`LoginModal` 三阶段弹窗（confirm → restarting → manual），用户点「立即重启」才调 `/desktop/restart`；点「取消」调 `POST /desktop/switch-cancel`，后端把 `active_profile.json` 恢复回当前运行档并销毁一次性 pending 凭据（未确认成功前不许关弹窗，避免下次启动误入目标档）。i18n key：`desktopAuth.switchConfirmTitle/Body/Ok/Cancel/switching/switchRestartingHint/switchManualTitle/switchRestartManual/switchManualAck/switchBack`，zh.json + en.json 同时加。
  - **启动速度优化（桌面端）**：lifespan 中所有非关键重活（索引无效项清理 `cleanup_index`、layer_tmp/distance_tmp 过期 `src_*` 清理、`cleanup_stale_installers` 历史安装包清理、图层 GeoJSON 缓存预热、`backfill_coord_zero_warnings`、旧版任务索引拆分）统一进 `npt-desktop-deferred` 后台守护线程**串行**执行，且**先等首次登录完成**（`core/startup_gate.wait_for_login`，120s 兜底）——它们是纯 Python/GDAL 线程、持 GIL，与用户点登录同时起跑会明显拖慢登录与首屏；uvicorn 不等它们结束才接请求。组迁移 `init_db` 加 `.group_migration_v1` marker 门控，只跑一次。launcher 就绪探测间隔 0.15s，重启脚本 `ping -n 2` 约 1s 粒度。服务器形态（systemd）行为不变：索引/临时文件清理、旧索引拆分仍在 lifespan 内同步完成。
  - **桌面壳先出窗口**：`desktop/launcher.py` 在创建窗口**之前**就起后端线程（`_start_server`，import app + lifespan 与 WebView2 运行时冷启动并行），随后 `create_window(html=启动页)` + `webview.start(_open_when_ready, args)`，func 只负责等就绪并 `window.load_url()` 导航。否则「双击图标 / 切运行模式重启」要等整份后端导入 + lifespan 跑完才出现窗口，那段时间只有空白。启动失败把错误页显示在窗口里（不再弹模态框）。`--selftest` 仍走同步顺序。切档重启脚本（`core/desktop_profiles.py`）拉起前的固定等待由两个 `ping -n 2` 减为 `ping -n 1`（互斥体在旧进程终止时即由内核释放，端口有 SO_REUSEADDR）。
  - 单设备登录：共享模式登录在服务器记账并踢掉该账号其它会话；客户端每 60s 调 `POST /desktop-cloud/auth/session-check`，**只有服务器明确回复 `valid=False`**（账号在别处登录/会话失效）才本机登出（`desktop_local.session_guard_loop`）；网络不可达、超时、5xx 一律按"无法确定"处理，断网（尤其单机模式）可继续使用，绝不因网络抖动踢下线。每次联机登录累加 `DesktopLicense.login_count`，断网登录本机记账、联机补报。
- **桌面端数据同步（共享模式）**：粒度是**整包数据集（zip）**，不是行级增量。`dataset_revision_service.py` 为每个数据集维护**单调递增 rev**——只有真正改变内容的写入才 `bump`，`set_sha`（下载）不推进 rev，否则 rev 抖动会导致反复整包下载；删除写**墓碑** `deleted=True`，避免本地删除被当成新建推回。客户端 `sync_state.json` 记录「服务器 rev 基线 + sha256 + dirty」，本地改动经 `NPT_DESKTOP_SYNC_DEBOUNCE_SECONDS` 防抖后立即上行；**服务器 → 桌面端走长轮询即时推送**（`desktop_sync_service.watch_loop` 常连 `POST /desktop-cloud/data/changes`，服务器按「组内数据集 + rev + 墓碑」算指纹，变化即刻返回并触发 `sync_once`，无变化挂起 25 秒），`sync_loop` 只作兜底轮询。冲突不做行级合并：**按「最后更新时间」自动选边（LWW）**——清单项带 `server_updated_at`，本地改动记 `changed_at`（用清单 `server_time` 校准时钟偏差），本地更晚则带 `changed_at` 覆盖服务器、服务器更晚则直接采用服务器版本；时间戳缺失的存量条目才走人工选边（`/desktop/sync-resolve`）。push 带 `base_rev` 乐观锁 + `changed_at`，服务器 rev 不符且改动时间不晚于服务器更新时间时返回 409；待上行删除在服务器有更新时会被撤销并拉回。**服务器权威 `dataset_revisions` 表与本地 `sync_state.json` 里记录的服务器 rev 是两套数字，不可混用。**
- **同组任务历史共享（2026-10-08）**：PCI/邻区/TAC 核查/TAC 规划四类历史任务（`TaskManager.SHARED_TASK_TYPES`）在同组内互通。网页端历史列表本就按组过滤；桌面端共享模式新增任务同步（`sync_once` 第 4 步 `sync_tasks`）：拉同组任务元数据写入本机镜像行（`task_results.origin='shared'`，结果按需拉取，小结果类型另预拉取，见下条）、本机新建规划任务含结果上行（只推一次）、传播删除与应用标记；镜像结果在查看/导出时按需从服务器拉取并缓存。服务端接口 `/desktop-cloud/data/tasks/*`（许可+机器码鉴权，组以授权记录为准）。存量无组任务启动迁移时按发起人 `user_name` 的当前组重盖章。
  - **跨端一致性（2026-10-08 修复）**：`is_applied` **双向**同步（别处应用 → 本机显示已应用；本机刚应用尚未上行时以本机为准）；服务器删除会同时清掉本机镜像行与**已上行过的本机任务**；清单新增 `total`，`total > len(items)`（LIMIT 200 截断）时不做删除判定，防止误删老任务；`list_task_history` 对**无本机结果的镜像行**回退到 `is_applied` 标记（原来恒为"未应用"），且该标记参与 `_history_verify_cache` 缓存键。前端 `HistoryTable` 监听 `desktop:synced` 事件 + 可见时每 60s 静默刷新；`taskStore.syncHistoryFromBackend` 按"本页最早一条的时间边界"剔除已被别端删除的本地记录（运行中/`activeTaskIds` 除外）。
  - **小数量与应用标记落库（2026-10-09）**：`task_results.cell_count` 在任务完成/桌面端上行时计算，随清单元数据下发到镜像行，`list_task_history` 对镜像行返回 `resultSummary.cellCount`（前端 4 个规划页 `getCellCount` 优先读它）；`upsert_shared_task` 对 `is_applied` 单调置位（此前完全忽略该字段 → 桌面端应用后同组永远"未应用"）；`_queue_shared_task_update/_delete` 入队后立即 `schedule_sync()`。存量行由服务器启动后台线程 `backfill_task_cell_counts()` 回填。
  - **「已应用」双向一致（2026-10-09 补充）**：桌面端同步时"本机 1 / 服务器 0"不再回落，改为把本机标记上行（旧版服务器丢过该标记）；本机任务上行 payload 带 `is_applied`；服务器启动后台线程 `backfill_applied_flags()` 按当前工参对照结果回填存量（仅 pci/tac/tac_planning，且要求结果里有可比较的 PCI/TAC 值）。
  - **「已应用」以工参动态比对为准 + 镜像行预拉取（2026-10-12）**：操作列 = 结果里的规划值（PCI 与 TAC **同时**，凡出现者都要匹配）对照**当前全量工参**逐小区比对，一致即已应用。镜像行（本机无结果）此前只能沿用别端 `is_applied` 标记，而"查看"把结果按需拉到本机后判定来源切换 → "点查看后从未应用变成已应用"、工参变更后标记又不更新。修复：`sync_tasks` 对 `(pci, tac_planning)` 类型镜像行**预拉取结果**（清单带 `result_size`，单条 ≤8MB、每轮 ≤16MB/30 条，拉完清 `_history_verify_cache`），镜像行与本地任务统一走动态判定；工参内容指纹改**主键加权**（`SUM(pci*id)`/`SUM(tac*id)`）以识别 PCI/TAC 值轮换（总量不变）；结果无可比 PCI/TAC 值时回退标记而不是空判为已应用。
  - **删除不被清单重建 + 任务历史秒级同步（2026-10-12）**：① `sync_tasks` 绝不按清单快照重建 `task_deletes`（删除待上行）里的任务——删除意图在本轮同步末尾才下行，旧逻辑会把本机刚删的任务又镜像回来（用户报"删掉的历史任务又回来了"），本机残留行也在 step 1 一并清掉；② 长轮询指纹 `_group_fingerprint` 末尾追加组内共享任务指纹 `tasks:{count}:{max(created_at)}:{sum(is_applied)}`（新增/删除/应用标记都会变）→ 同组桌面端由"最长等 1 分钟兜底轮询"变成秒级唤醒；③ 服务端任务变更（`upsert_shared_task`/`delete_shared_task`/`mark_task_applied`）经 `websocket_manager.notify_tasks_changed` 广播 `tasks_changed`，前端 `websocketService` 转成 `TASKS_CHANGED_EVENT`，`HistoryTable` 监听后只重载历史列表（网页端即时刷新，不做整表刷新）。
- **同组数据变更即时推送（2026-10-09）**：`dataset_revision_service.bump()` 成功后经 `websocket_manager.notify_data_changed` 向**同组** WebSocket 连接广播 `data_changed`（线程安全；单进程广播，`NPT_WORKERS=1`）；`/api/v1/ws/tasks` 支持 `?token=JWT` 或 `{"type":"auth","token"}` 登记数据组；前端 `websocketService` 收到即 `triggerDataRefresh('full')`（清小区列表缓存 + 广播事件），网页端无需刷新即可看到桌面端/同组用户的写入；`AuthGuard` 登录后 `websocketService.authenticate(token)`。另：`getCellList()` 的空结果一律不信任（内存/IndexedDB 空缓存视为未命中，缓存版本 v6），桌面端 `desktopSyncStore` 首次拿到 `last_sync_at` 时也触发一次刷新。
- **许可签发与续期**：Ed25519 许可（私钥仅服务器：`NPT_LICENSE_PRIVATE_KEY` 或 `licenses/license_private_key.pem`），租约默认 30 天、启动后台静默续期（剩余 <20 天或距上次 ≥7 天）；离线 `.nptlic` 导入通道保留。
- **桌面端 OTA**：管理端分片上传安装包到 `desktop_releases` → 客户端比对版本 → 断点续传下载 + sha256 校验 → 在 `%APPDATA%\NetworkPlanningTool\updates\`（`DATA_ROOT/updates`）写升级脚本 `npt_update_*.cmd` → `CREATE_NO_WINDOW` 隐藏拉起（不弹终端窗口；脚本用 `ping` 计时，无控制台时 `timeout` 会报错）→ 等应用退出（`EXIT_WAIT_SECONDS=60` 超时 `taskkill` 兜底）→ `/VERYSILENT` 静默安装（日志 `npt_setup.log`；安装命令带 `/DIR="<当前运行目录>"`，失败退回默认目录重试；重启优先从注册表 `InstallLocation`（安装器记录的实际安装目录）拉起，其次当前运行目录/默认目录/旧路径，避免"装到别处、重启旧 exe"导致版本没变；`installer.iss` 安装时按 `/DMyAppVersion` 统一重写包内 `version.json`，打包产物版本缺失/滞后也不会误报"更新未生效"）→ 重启应用；安装器退出码写 `updates/npt_ota_result.txt`（含 `install_dir` 与实际重启目标），重启目标的 `version.json` 拷成 `updates/installed_version.json` 供核对，应用重启后经 `/desktop/update/status` 的 `last_result` 判定是否已生效，未生效则弹窗提示手动运行安装包。**后台运行**：弹窗可选「后台运行」（`POST /desktop/update/background`），关掉窗口后由启动器进程继续下载，完成后自动安装并重启（期间持有单实例互斥体，重复启动会提示"正在后台更新"；后台更新期间关窗不武装 20 秒强制退出看门狗，否则下载会被杀在半路，下载等待结束后再武装）。应用侧经 `app/desktop_bridge.py` 的退出回调关闭窗口，`desktop/launcher.py` 先武装 `EXIT_GRACE_SECONDS=20` 强制退出看门狗、`destroy` 抛异常则立即 `os._exit`，确保进程一定退出、安装不会卡在等待里。**无强制更新**：新版本只提示，弹窗可随时关闭、「稍后」不计数；自动检查每 12 小时一次（1 天 2 次，本地 `npt-ota-last-prompt` 记录上次提醒，重启应用也不会重复打扰），面向所有桌面端用户。桌面版必须 `NPT_CONSOLE=0` 构建（CI tag 发行会用 0 重新打包），否则程序自带控制台窗口。 **版本号只认包内 `version.json`**：升级脚本由**旧版本进程**拉起，重启的新进程会继承旧进程环境里的 `NPT_DESKTOP_VERSION`（旧版本号）——launcher 必须用赋值覆盖（不能用 `setdefault`），升级脚本拉起前也 `set "NPT_DESKTOP_VERSION="` 兜底；否则自动重启后「系统设置」的版本、OTA `last_result.applied`、服务器「桌面授权」的「当前版本」列都停在升级前，要用户手动再重启一次才会对（"重启即完成"是该链路的要求）。
- **网优助手**：LLM 配置/数据集导入到 `station_param_rows`、`station_metric_rows`；对话走 function-calling（最多 5 轮工具调用），查询只读

## 添加新 API 端点

1. 在 `backend/app/api/v1/endpoints/` 新建端点文件
2. 在 `backend/app/api/v1/__init__.py` 用 `api_router.include_router(...)` 注册
3. 需要登录/权限时加 `Depends(get_current_user)`、`require_permission(...)`（`core/security.py`）；涉及数据条目再加 `require_data_group_access`（`core/data_access.py`）
4. 在 `shared/types.ts` 添加 TS 类型，在 `frontend/src/renderer/services/api.ts` 添加调用函数

## 关键开发约束

### 多语言（前端必须遵守）

- UI 文本一律用 `t()`，不得硬编码中文显示串
- `useTranslation()` 必须在 React 组件函数体内调用（含 `UploadArea` / `DataPreview` 等子组件），不得依赖父组件传入的 `t`
- 日期格式按 `i18n.language` 动态设 locale：`i18n.language === 'en' ? 'en-US' : 'zh-CN'`
- 搜索/过滤逻辑不得依赖 `t()` 返回值；用布尔值或原始数据比较
- 新增 key 必须同时在 `locales/zh.json` 和 `locales/en.json` 添加

### 坐标系

- 前端渲染与图层编辑使用 **GCJ02**；后端持久化 **WGS84**
- 工参/地理化点数据为 WGS84，前端转 GCJ02；MapInfo 与地理化多边形 path 由后端已转 GCJ02
- 跨端传几何按既有链路转换（前端 `utils/coordinate.ts`，后端 `utils/coordinate_transformer.py` / `geojson_geometry.py`），新链路不得自行混用坐标系

### 后端编码（Windows GBK 兼容）

- API 响应用 `UTF8JSONResponse`（`ensure_ascii=False`）；错误消息做 GBK 安全处理后再抛 `HTTPException`：

```python
except Exception as e:
    safe_detail = str(e).encode("gbk", "replace").decode("gbk")
    raise HTTPException(status_code=400, detail=safe_detail)
```

- **控制台/print 编码加固**（`app/core/console_encoding.setup_console_encoding()`）：替换 `builtins.print`（编码失败降级为 GBK 安全串、管道断开静默）+ Windows 下放宽 stdout/stderr。**网页端服务端由 `main.py` 调用（强制 utf-8，既有行为）**；**桌面端必须由 `desktop/launcher.py` 的 `main()` 调用（`force_utf8=False`，保留控制台原生 cp936）**——桌面端不走 `main.py`，2026-10-12 就因地理化数据导入里带 emoji 的调试 print（`🔴`）打到 cp936 流抛 `'gbk' codec can't encode character` 而把整个上传报成"上传失败"。**业务代码里不要用 emoji 做 print/日志标记**（日志写 utf-8 文件不受影响，但 print 到控制台会翻车）。

### CPU 密集型操作

- pandas/geopandas 用 `run_in_threadpool` 包裹；重任务放 `task_manager`，不要阻塞事件循环

### 前端构建

- Vite `outDir` 必须为 `dist-renderer`（后端按此路径托管 SPA）；**不要添加 `manualChunks`**（历史上导致跨 chunk TDZ 错误，`vite.config.ts` 有注释说明）

### 别改错文件（根目录同名旧快照）

- 仓库根的 `data_service.py`、`mapinfo_service.py`、`tac_planning_service.py` 是 7 月的**旧快照**（已入库，体量远小于现行版），不是运行代码；一律改 `backend/app/services/` 下的同名文件
- 根 `nptserve.spec` 是遗留打包配置，桌面打包以 `desktop/desktop.spec` + `.github/workflows/build-windows-desktop.yml` 为准
- 同类遗留：`frontend/package.json.electron`、`frontend/capacitor.config.ts`、`frontend/start-electron-dev.bat`（Electron/Capacitor 已废弃）

### 桌面端与服务器共存

- 桌面端与网页端**共用同一份后端代码**；所有桌面专属分支必须由 `NPT_DESKTOP` 门控，**不得改变服务器（systemd）部署行为**
- 新增数据读写路径同样要接数据组门禁；桌面端本机按运行模式持有**两套** `data.db`（`profiles/shared/`、`profiles/standalone/`，2026-10-16 起物理隔离，切档靠重启），与服务器端再各一套；共享模式靠 `dataset_revisions` + 档内 `sync_state.json` 对齐，不要绕开同步链路直接改对端库
- `desktop/tools/keys/` 与 `licenses/` 下的 Ed25519 私钥已 gitignore，**禁止入库或外发**

### 代码风格

- 前端：外部库 → 内部 `@/` 或 `@shared` 别名 → `type` 类型导入；组件 PascalCase、函数 camelCase、常量 UPPER_SNAKE_CASE、文件 kebab-case
- 后端：标准库 → 第三方 → 内部（`from app...`）；类 PascalCase、函数 snake_case
- React：Effects 仅用于同步外部系统（地图/事件/WS）；派生状态用 `useMemo`；自定义 Hook 以 `use` 前缀
- 前端栈：React 18 + TypeScript + Zustand + Tailwind + Radix UI + lucide-react；地图 Leaflet/react-leaflet（2D 在线/离线）+ CesiumJS（3D，CDN 懒加载 `services/cesiumLoader.ts`，无本地包故类型一律 `any`）+ 自定义扇区渲染。
- 单文件超过 500 行、单函数超过 50 行时应识别拆分（见根 `AGENTS.md`）

### 协作与提交约定（来自根 `AGENTS.md`）

- 回复使用简体中文；沟通按金字塔原理（结论先行、先全局后细节）
- 编码遵循 DRY/KISS/SOLID/YAGNI
- Git 采用 GitHub Flow：禁止直接提交/强推 main；Conventional Commits；原子提交
- 依赖管理：AGENTS.md 通用约定为前端 pnpm、后端 uv；**本仓库实际使用 npm（`frontend/`）+ pip/venv（`backend/.venv`）**，不要改用 pnpm / uv

## 环境变量（`NPT_` 前缀，支持 `backend/.env` 覆盖）

```
NPT_HOST / NPT_PORT / NPT_CORS_ORIGINS
NPT_JWT_SECRET_KEY / NPT_JWT_ALGORITHM / NPT_JWT_ACCESS_TOKEN_EXPIRE_MINUTES
NPT_SESSION_IDLE_TIMEOUT_MINUTES          # 默认 180（分钟）
NPT_LICENSE_SECRET_KEY / NPT_LICENSE_EXPIRY_DAYS
NPT_AMAP_API_KEY / NPT_AMAP_SECURITY_CODE
NPT_MAX_TASKS / NPT_TASK_TIMEOUT / NPT_MAX_WORKERS
NPT_RELOAD / NPT_WORKERS
NPT_LLM_BASE_URL / NPT_LLM_API_KEY / NPT_LLM_MODEL / NPT_LLM_TIMEOUT
NPT_CITY_PRESETS                          # 地市预设（逗号分隔），注册/建号校验源
NPT_DATA_ROOT                             # 可写数据根目录（桌面端默认 %APPDATA%\NetworkPlanningTool）
# 桌面端（仅 NPT_DESKTOP=1 时生效；服务器侧只用到 NPT_LICENSE_PRIVATE_KEY 等）
NPT_DESKTOP                               # 运行形态开关，launcher.py 注入 1
NPT_LICENSE_PRIVATE_KEY                   # Ed25519 签发私钥（或用 licenses/license_private_key.pem）
NPT_SERVER_URL / NPT_DESKTOP_CHANNEL / NPT_DESKTOP_VERSION
NPT_DESKTOP_ACTIVATION_MODE               # precreate（默认）/ approve（单机需管理员批准）
NPT_DESKTOP_LEASE_DAYS                    # 许可租约天数，默认 30
NPT_DESKTOP_SYNC_INTERVAL_MINUTES         # 共享模式后台同步兜底轮询间隔（主通道为长轮询即时推送）
NPT_DESKTOP_SYNC_DEBOUNCE_SECONDS         # 本地改动上行防抖秒数，默认 3
```

前端 `frontend/.env`：`VITE_DEV_MODE`、`VITE_API_URL`。

## 依赖与环境注意

- **GDAL/geopandas**：图层与地理数据处理依赖；Windows 参考 `install_geopandas.bat` 或 `conda install -c conda-forge gdal`。`requirements.txt` 中 gdal 行已注释，实际靠 pyogrio wheel 自带 libgdal
- **端口**：后端 8000、前端 5173；改端口需同步 `frontend/vite.config.ts` 代理
- **类型同步**：前后端共享类型在 `shared/types.ts`，修改后同步
- **镜像源**：npm 慢用 `npm config set registry https://registry.npmmirror.com`；pip 慢用清华源
- 生产 systemd 配 `MemoryMax=2G`；**SQLite 主库 `data/data.db` 是运行时数据，不要当临时文件清理**（`backend/data/` 下的 `data.db` / `npt.db` 是 0 字节残留，可忽略）
- **桌面端依赖**：`desktop/requirements-desktop.txt`（pywebview / pyinstaller / pyogrio）只在 Windows 打包机上安装，不要加进 `backend/requirements.txt`

## 故障排除

- **端口占用**：`ss -ltnp | grep :8000`（Linux）/ `netstat -ano | findstr :8000`（Windows）
- **401 / 掉登录**：凭证在 `localStorage['auth-storage']`；JWT 过期、会话空闲超时或服务端吊销后前端清除并要求重新登录；修改 `NPT_JWT_*` 会使旧 token 全部失效
- **看不到数据（非 401）**：先查数据组隔离——用户 `city`/`operator` 为空即不可见任何业务数据，跨组一律 404
- **地图不显示**：检查高德 Key（`NPT_AMAP_API_KEY`，config.py 有开发默认值）与网络
- **上传失败（开发）**：`uploadClient` 直连 `http://localhost:8000`，检查 `VITE_API_URL` 与后端是否已启动
- **前端构建后线上没变化**：确认执行了 `npm run build:vite` 并重启 `npt-backend`
- **桌面端登录一直 pending**：单机模式需管理员在网页端「桌面授权」页批准（`NPT_DESKTOP_ACTIVATION_MODE=approve`），批准后前端 `auth-poll` 轮询会自动进入
- **桌面端被踢下线**：共享模式为单设备登录，同账号在别处登录会使本机 `session-check` 失败并登出；`DesktopLicense.idle_logout_days`（默认 2 天）覆盖本机会话空闲超时
- **桌面端数据不同步**：先看 `/desktop/sync-status` 与 `sync_state.json` 的 `conflicts`（push 带 `base_rev`，服务器 rev 不符返回 409）；服务器权威 rev 在 `dataset_revisions` 表，与本地记录的基线是两套数字
- **桌面打包缺 GDAL**：确认 `desktop/hooks/hook-pyogrio.py` 生效且产物含 `gdal*.dll`/`proj*.dll`/`proj.db`（CI 有该校验步骤）
- **桌面端 OTA 安装卡住 / 关不掉程序**：升级脚本在 `%APPDATA%\NetworkPlanningTool\updates\`，安装日志 `npt_setup.log`、运行日志 `logs/desktop.log`（关注「注入桌面桥接退出回调失败」「强制结束进程」）；脚本 60 秒等不到退出会 `taskkill`，应用侧 20 秒兜底 `os._exit`（后台更新模式下关窗不武装、等下载等待结束才武装，避免下载被杀在半路）；点「重启并安装」后版本没变时先看 `updates/npt_ota_result.txt`（`setup_rc` 非 0 = 安装器未成功，实际错误见同目录 `npt_setup.log`；`install_dir` 为注册表记录的实际安装目录、`restarted` 为实际拉起路径，配合 `updates/installed_version.json` 可判断"装到哪儿、装了什么版本"）——脚本先按当前运行目录 `/DIR` 安装、失败退回默认目录重试，重启优先从注册表 `InstallLocation` 拉起；若安装包自带控制台窗口，说明构建时 `NPT_CONSOLE` 不是 0（tag 发行由 CI 用 0 重新打包）
- **GDAL 安装失败**：用预编译 wheel 或 conda 安装
- **编码错误（如导入报 `'gbk' codec can't encode character '\U0001f534' ...`）**：`app/core/console_encoding.setup_console_encoding()` 已统一给 print 与 stdout/stderr 兜底（网页端 `main.py`、桌面端 `desktop/launcher.py` 各自在最早处调用）；若仍复现，多半是新加的 print/日志带了 emoji 等 GBK 外字符（改用纯文本标记），或该执行路径没经过两个入口之一
