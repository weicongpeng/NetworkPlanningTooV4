# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## 项目概述

**NetworkPlanningTooV3**（网优引擎 v3.0）：电信网络规划 Web 应用，前端 Vite + React 18 + TypeScript，后端 FastAPI + SQLite。

- **前端**：纯 Web 应用（`npm run dev`），代码在 `frontend/src/renderer/`；生产构建产物 `frontend/dist-renderer/` 由 FastAPI 以 SPA 方式托管。
- **后端**：FastAPI + SQLAlchemy 2.0 / SQLite（仓库根 `data/data.db` 为权威数据源，注意不是 `backend/data/`）+ Excel 双写，代码在 `backend/`。
- **移动端**：独立 Expo / React Native 应用在 `mobile-app/`（有自己的 CLAUDE.md / AGENTS.md，本文件不覆盖）；调用同一后端，APK 由后端 `/api/v1/app-versions` 分发。
- **桌面端（Windows）**：`desktop/`，pywebview 壳 + 进程内 uvicorn 跑同一套 FastAPI，PyInstaller onedir → Inno Setup 安装包，由 GitHub Actions 在 windows-latest 出包；支持「共享 / 单机」两种运行模式。
- **Electron / Capacitor 已废弃**：`frontend/package.json.electron`、`frontend/capacitor.config.ts`、`frontend/start-electron-dev.bat` 均为遗留文件，`frontend/electron/` 目录与 electron 依赖不存在，不要按 Electron/Capacitor 方式启动或构建。
- 本文件与根 `CLAUDE.md` **互为镜像**（改其一需同步另一份），`README.md` 是面向用户的功能概览；三者与代码不一致时以当前代码为准，发现滞后请顺手更新对应文件。

**主要功能**：PCI 规划（碰撞/混淆、模 3/模 30）、邻区规划（覆盖圆）、TAC 核查与规划（异 TAC 孤岛/插花）、地图可视化与图层制作/编辑（在线高德/OSM、离线；TAB/MIF/KML/Excel 地理数据；专题与值热力面、标签防重叠、条件选择、绘制缓冲区）、数据管理（上传、全量工参、小区查询/批量更新、新站录入、数据组隔离）、距离匹配、站间距、频点换算（LTE/NR/GSCN）、网优助手（LLM）、用户与权限、APP 版本管理。

## 常用开发命令

### 后端（FastAPI，`backend/`）

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # 生产 systemd 使用的也是 backend/.venv
pip install -r requirements.txt
python main.py                                       # 开发启动（NPT_RELOAD=true 时热重载）
uvicorn main:app --host 127.0.0.1 --port 8000        # 单次运行（main.py 内已 create_app()）
```

- 后端地址 http://127.0.0.1:8000 ｜ Swagger http://127.0.0.1:8000/docs
- 测试（pytest；仓库无 pytest.ini，从 `backend/` 目录运行）：
  - 全部：`python -m pytest tests/ -v`
  - 单文件：`python -m pytest tests/test_cell_query_update.py -v`
  - 按用例名：`python -m pytest -k "bulk_update"`
  - 显示 print：`python -m pytest -s`
  - `tests/conftest.py` 在本机缺少 geopandas/shapely/fiona/pyogrio 时会自动 mock，无 GDAL 也能跑测试
- `scripts/run-tests.sh` 依次执行后端 pytest 与前端 vitest。

### 前端（`frontend/`）

```bash
cd frontend
npm install
npm run dev          # Vite 开发服务器 http://localhost:5173（代理 /api、/layer-files → 8000，/ws → ws://8000）
npm run build        # 等价于 build:vite，产物 frontend/dist-renderer/
npm run lint         # eslint src --ext .ts,.tsx
npm run type-check   # tsc --noEmit
npm run test         # vitest run
npx vitest run src/renderer/utils/__tests__/frequencyConversion.test.ts   # 单个测试文件
npx vitest run -t "GSCN"                                                  # 按用例名过滤
```

- 前端脚本都在 `frontend/package.json`；仓库根 `package.json` 是空的 `{}`。
- Vitest 配置内嵌在 `frontend/vite.config.ts` 的 `test` 块（jsdom + `src/test/setup.ts`），测试文件与源码同目录，位于 `__tests__/*.test.ts`。

### 桌面端（Windows 安装包，`desktop/`）

```bash
# 仅在 Windows 上构建；CI 见 .github/workflows/build-windows-desktop.yml
pip install -r backend/requirements.txt -r desktop/requirements-desktop.txt
python desktop/tools/make_icon.py                       # 生成 desktop/app.ico（构建期产物，不入库）
python desktop/tools/spike.py                           # GDAL / pywebview / TAB 读写 / 上传链路基线自检
pyinstaller --noconfirm --clean desktop/desktop.spec    # → dist/NetworkPlanningTool/{NPT.exe,_internal/}
NPT.exe --selftest                                      # 打包产物冒烟
ISCC desktop/installer.iss                              # → installer-out/NetworkPlanningTool-Setup-*.exe
```

- 权威打包链路是 `desktop/desktop.spec` + `.github/workflows/build-windows-desktop.yml`；根 `nptserve.spec` 是遗留配置（入口 `/tmp/nptserve/entry.py` 不在仓库内），**不要**用它构建。
- CI 触发：`workflow_dispatch`、push 到 `feat/windows-desktop`、push tag `desktop-v*`；仅 tag 触发时用 `gh release create` 发布安装包。CI 会跑桌面相关 pytest（`test_desktop_license*` / `test_desktop_local_*` / `test_desktop_releases` / `test_desktop_update_client` / `test_desktop_shared_mode` 等）并校验产物含 gdal/proj DLL、`proj.db`、`WebView2Loader.dll`、`frontend/dist-renderer/index.html`。

### 生产部署（Linux + systemd + Cloudflare Tunnel）

```bash
cd frontend && npm run build:vite     # 前端改动必须先构建
systemctl restart npt-backend         # 后端改动 / 前端构建后重启
```

- 入口 https://app.pengwc.asia → cloudflared 隧道 → `localhost:8000`（FastAPI 同时服务 REST API 与 `frontend/dist-renderer/` 静态资源）。
- systemd 单元 `/etc/systemd/system/npt-backend.service`：`WorkingDirectory=.../backend`、`ExecStart=.../backend/.venv/bin/python3 main.py`、`NPT_RELOAD=false`、`MemoryMax=2G`（仓库根同名文件为参考副本）。
- 日志：`journalctl -u npt-backend -n 100 --no-pager` 或 `tail -f /var/log/npt-backend.log`；仓库根 `重启命令` 有简版说明。
- `backend/Dockerfile`、`frontend/Dockerfile` 存在但无编排、未用于生产（后者只跑 dev server）；生产以 systemd 为准。

## 高层架构

```
浏览器 / mobile-app(Expo, JWT)
   │ HTTPS  app.pengwc.asia → cloudflared → localhost:8000
   ▼
FastAPI (backend/app/)
   ├─ /api/v1/*          REST 端点 (api/v1/endpoints/)
   ├─ /api/v1/ws/tasks   WebSocket 任务推送
   ├─ /static            outputs/ 静态文件
   ├─ /layer-files       uploads/layers 图层文件
   └─ SPA 兜底            frontend/dist-renderer/index.html
        │
   services/    业务逻辑：数据 / 任务 / 图层 / 认证 / 助手…
        │
   algorithms/  PCI、邻区、距离
        │
   存储：data/data.db (SQLite, 权威) + data/<id>/original.xlsx (双写)
        + data/index.json (内存索引) , outputs/ , exports/ , uploads/
```

### 分层职责 (`backend/app/`)

| 层 | 位置 | 职责 |
|----|------|------|
| API 层 | `api/v1/endpoints/` | HTTP、参数校验、鉴权/权限依赖 |
| 服务层 | `services/` | 业务逻辑、数据管理、任务编排 |
| 算法层 | `algorithms/` | 纯计算：PCI、邻区、距离 |
| ORM 模型 | `models/database.py` | SQLAlchemy 表定义 |
| Pydantic 模型 | `models/schemas.py` | 请求/响应模型 |
| 基础设施 | `core/` | `config.py`(Settings/`NPT_`)、`database.py`(引擎+迁移+默认管理员)、`security.py`(JWT+权限依赖)、`data_access.py`(数据组鉴权)、`exceptions.py`(自定义异常) |
| 应用入口 | `main.py` + `api/__init__.py` | UTF-8 处理；create_app/lifespan（建目录、清索引、init_db、预取图层缓存）、静态 SPA |

### 数据与存储（改动前必读）

- SQLite `data/data.db` 是查询与规划的权威数据源（WAL、外键），由 `core/database.py` 管理；`init_db()` 用 `PRAGMA table_info` 做轻量迁移，启动时创建默认管理员账号（首次登录强制改密，见 `core/database.py`）。
- 上传 Excel 时同时写 SQLite（Workbook/Site/Sector 等）并保留 `data/<id>/original.xlsx`；下载/导出时从 SQLite 反写 Excel（`data_service._save_to_sqlite`、`task_manager._sync_excel_from_sqlite`）。
- `data/index.json` 是内存索引的持久化，启动时会与 SQLite 中的 Workbooks/GeoFiles/Layers 对账合并（`data_service`）。
- ORM 表（`models/database.py`，15 张）：User、UserSession、Workbook、Site、Sector、GeoFile、Layer、UserSettings、TaskResult、AppVersion、DesktopLicense、DesktopRelease、DatasetRevision、StationParamRow、StationMetricRow。`init_db()` 用 `PRAGMA table_info` 做轻量迁移，无 alembic。
- 桌面端相关列：`users.is_desktop_shadow`（服务器侧影子账号，承载无绑定授权的数据归属）、`users.desktop_run_mode`（`shared`/`standalone`，网页端恒 NULL）；`desktop_licenses` 另有 `mode`/`username`/`user_id`/`login_count`/`last_login_at`/`idle_logout_days`。

### 数据组隔离（地市 + 运营商，横切约束）

- 数据按 `(city, operator)` 分组，**含管理员在内一律仅可见同组业务数据**（不设跨组特权）；用户组信息缺失（NULL）不可见任何业务数据；跨组访问一律 404，不泄露数据存在性。
- 写入时盖章组信息（上传/创建从操作者或来源工参复制）；存量 NULL 数据在用户管理「改组」时经 `migrate_group_data` 迁移。
- 落地：`services/data_group.py`（`user_group` / `group_sql_filter` / `index_entry_visible` / `OPERATORS = ["移动","联通","电信","广电"]`）、`core/data_access.py`（`require_data_group_access` / `require_task_access` 依赖）。
- 新增任何数据查询/写入路径都必须接上组门禁。

### 认证与权限

- JWT Bearer（python-jose，HS256，默认 1440 分钟过期）+ bcrypt（passlib）。`UserSession` 表支持会话吊销、IP 绑定与空闲超时。
- 会话空闲超时：`NPT_SESSION_IDLE_TIMEOUT_MINUTES`（默认 180 分钟），由 `get_current_user` 在每次请求校验；连续无请求（含 4 分钟心跳）超过该时长才要求重新登录，期间换网络/IP（含 IPv4/IPv6 切换）不打断，仅新设备登录踢掉旧会话。
- `core/security.py` 提供依赖：`get_current_user`、`get_current_admin_user`、`require_permission(...)`，以及 `require_data_import/delete/update`、`require_cell_entry`、`require_cell_query_update`、`require_assistant`；管理员绕过权限位。数据条目相关路由另经 `require_data_group_access`（失败 404）。
- 前端：`authStore` 持久化 `localStorage['auth-storage']`；`services/api.ts` 自动附加 Bearer，401 时清除凭证并派发 `auth:required`；`AuthGuard` 包裹全应用（未登录只显示 `LoginModal`），`ProtectedRoute` 处理 license 到期 / `requireAdmin` / `requirePermission`；`useHeartbeat` 每 4 分钟 ping。

### 桌面端运行形态（`desktop/`）

- `desktop/launcher.py` 是 PyInstaller 入口：daemon 线程跑 uvicorn 绑 `127.0.0.1` 随机端口，主线程开 pywebview 窗口；注入 `NPT_DESKTOP=1`、`NPT_MAX_WORKERS=1`（Windows 无 fork）、`NPT_SERVER_URL`（默认 `https://app.pengwc.asia`）；可写数据落 `%APPDATA%\NetworkPlanningTool`（`NPT_DATA_ROOT` 可覆盖），与安装目录解耦；Windows 命名互斥体 `Local\NPTDesktop` 保证单实例。
- **同一份后端代码跑两种形态**：`NPT_DESKTOP=1` 时 `api/__init__.py` 额外挂后台协程（`desktop_cloud_client.renewal_loop` 静默续期、`desktop_sync_service.sync_loop` 共享模式同步、`desktop_local.session_guard_loop` 单设备登录校验），并放行 `/api/v1/desktop`；服务器专用管理端点（`admin_users` 等）经 `core/security.reject_desktop_mode` 在桌面形态下一律 404。
- 授权：Ed25519 密钥对由 `desktop/tools/gen_keypair.py` 生成，私钥在 `desktop/tools/keys/`（已 gitignore，禁止入库/外发），公钥 hex 写入 `backend/app/core/license_public_key.py`；`desktop/tools/gen_license.py` 签发离线 `.nptlic`。
- 云端数据同步端点的身份凭证是**签名许可文件 + 机器码**（非 JWT），见 `desktop_cloud._verify_license`。

### 异步任务处理

- `services/task_manager.py`（单例）：`asyncio` + 信号量 `NPT_MAX_TASKS`，可选 ProcessPool（`NPT_MAX_WORKERS`）；状态 PENDING → PROCESSING → COMPLETED/FAILED。
- 进度经 `websocket_manager` 广播到前端 `/api/v1/ws/tasks`；结果落 `outputs/tasks_index.json` 与 `task_results` 表。
- 前端以 `taskStore` 2 秒轮询为主，WebSocket 目前只消费全局 `task_deleted` 消息。
- PCI/TAC「应用到工参」直接 UPDATE SQLite（`task_manager._apply_pci_fast_sqlite_only` 等），随后后台线程同步回 Excel。

### 算法层现状

- 活跃：`algorithms/pci_planning_v1_service.py`（`task_manager.py:28` 实际调用，**不是 v2**）、`neighbor_planning_v1_service.py`、`distance_calculator.py`；TAC 规划另用 scikit-learn BallTree 做插花检测。
- 非活跃：`pci_planning_service_v2.py`（仅测试与未接线的 `task_manager._run_pci_sync` 引用）、`pci_planning_service.py`、`pci_collision_detector.py` 为历史/死代码，勿据其推断现状；所有 `*.bak*` / `*.backup*` 文件忽略。

### 前端架构（`frontend/src/renderer/`）

- 路由在 `App.tsx`（`LastRouteTracker > AuthGuard > MainLayout > Suspense > Routes`）：除 `HomePage` 直接 import 外，页面均由 `pageLoaders.ts` 做 React.lazy 分包 + 导航悬停预取；`recoverable()` 处理部署更新后旧 chunk 加载失败（自动刷新一次）；`LastRouteTracker` + `utils/lastRoute.ts` 支持重新登录后恢复上次页面。
  `/` 首页、`/data` 数据管理、`/pci`、`/neighbor`、`/tac`（核查）、`/tac-planning`、`/map` 地图与图层编辑、`/layer` 图层制作、`/distance-match` 距离匹配、`/site-spacing` 站间距、`/frequency-conversion` 频点换算、`/license`（许可证/主题/语言/LLM 配置，唯一不受 ProtectedRoute 限制）、`/admin/users`、`/app-versions`、`/assistant` 网优助手、`/desktop-releases` 桌面版分发、`/desktop-licenses` 桌面授权管理（后两者 `requireAdmin`，侧栏仅非桌面形态的管理员可见）。
  `pages/HistoryPage.tsx`、`TaskConfigPage.tsx`、`NetworkStatusDemo.tsx` 未挂路由（遗留/演示）。
- Zustand store（`store/`，17 个文件）：`authStore`（含桌面端 `desktopMode`/`desktopProbed`/`desktopRunMode`/`desktopPendingUsername`，`probeDesktopMode()` 探测本机后端）、`dataStore`、`taskStore`、`mapStore`（按用户持久化 `map-settings-user-<id>`，与后端 user settings 同步）、`layerEditStore`（图层编辑真源：workspaces/撤销/剪贴板/保存计划）、`mapDataCacheStore`（跨页 LRU 缓存）、`desktopSyncStore`（共享模式每 5s 轮询 `/desktop/sync-status`，同步落地派发 `DESKTOP_SYNCED_EVENT`）、`licenseStore`、`pciStore`/`neighborStore`/`tacCheckStore`/`tacPlanningStore`（向导状态）、`tacStore`（旧版，@deprecated）、`themeStore`、`toastStore`（全局 Toast）、`downloadStore`；`uploadStore` 不是 Zustand（分片上传单例）。
- 桌面形态差异：是否桌面端由 `authStore.probeDesktopMode()` 探测本机后端（`GET /system/desktop-mode` → `settings.NPT_DESKTOP`）得出，`AuthGuard` 探测完成前显示 spinner 以免闪出网页登录页；`components/` 下的 `DesktopAuthPendingDialog`（单机待批 5s 轮询）、`DesktopSessionGuard`（单设备登录 30s 校验）、`DesktopSyncIndicator`、`DesktopUpdateDialog` 仅在桌面形态生效，桌面端同时隐藏管理员侧栏入口与管理员授权卡片。
- `services/api.ts`：`apiClient`（`/api/v1`，300s）+ `uploadClient`（dev 直连 8000，规避 multipart 代理问题）+ 拦截器；按域导出 `authApi`/`adminUserApi`/`userSettingsApi`/`appVersionsApi`/`dataApi`/`layerApi`/`layerToolsApi`/`pciApi`/`neighborApi`/`tacApi`/`tacPlanningApi`/`distanceMatchApi`/`siteSpacingApi`/`mapApi`/`attributeJoinApi`/`bufferApi`/`assistantApi` 等；另有 512KB 分片上传与并行 Range 下载（`utils/parallelDownload.ts`）。
- 地图（`components/Map/`，41 个 `.ts`/`.tsx` 源文件，另有 `__tests__/`）：`OnlineMap.tsx`（Leaflet + 高德，跨页共享实例缓存，托管图层/选择/编辑会话）、`OfflineMap.tsx`、`MapInfoLayer.tsx`（TAB/MIF）、`GeoDataLayer.tsx`、`SectorRendererSVG.tsx`（LTE/NR 扇区 + PCI 模着色）、`LayerControl.tsx`（图层树：显隐/可选/编辑开关/排序）、`LabelLayoutManager.ts`（统一标签防重叠）、`HeatmapLayerManager.ts`（值热力面）、`OriginalSamplesLayer.ts`、`FloatingPanel.tsx`（可拖拽缩放面板）、`AttributeJoinDialog.tsx`（条件选择）、`BufferDialog.tsx`（绘制缓冲区）、各类图例与对话框。
- 图层编辑子系统：`components/Map/LayerEditSession.ts`（绘制/顶点/吸附/圈选/命中，由 OnlineMap 懒创建）+ `store/layerEditStore.ts`；工具栏在 `pages/MapPage.tsx`，按钮 `save/export/new/undo/capture/paste/measure/drag/select/marquee/draw/style/nodesnap/nodemerge/maptype/fullscreen`，顺序与标签按用户持久化（右键设置），「条件选择」「绘制缓冲区」在工具菜单中。保存：`layerApi.saveLayerData` → `PUT /api/v1/data/{dataId}/layers/{layerId}/data`，由 `buildSavePlan` 决定增量 patch（有基底版本指纹）或整层 GeoJSON，409 基底冲突回退整层，请求体默认 gzip；新建：`POST /api/v1/data/map/layers/create`。装饰图层要素存 IndexedDB（`services/decorationStorage.ts`，按用户隔离）。前端几何使用 GCJ02，后端持久化 WGS84。
- 地图数据链路：`services/mapDataService.ts` 拉取全量工参 → 过滤/坐标转换（WGS84→GCJ02）/LTE-NR 分类/LOD → IndexedDB 持久化缓存（按登录用户隔离），供 OnlineMap 消费。
- i18n：i18next 单 namespace，`locales/zh.json` / `en.json`（zh 约 1570 个 key、en 约 1560 个，23 个分组）；语言切换入口在 LicensePage。
- 测试：与源码同目录的 `__tests__/*.test.ts`（前端 36 个已跟踪测试文件：Map 组件、utils、store、services、config 等；另有 5 个未跟踪 `zz-*.test.ts` 调试脚本）；后端 `backend/tests/` 39 个 pytest 文件。

## API 端点前缀（`api/v1/endpoints/`）

| 文件 | 前缀 | 说明 |
|------|------|------|
| `auth.py` | `/api/v1/auth` | 注册/登录/me/ping/登出/改密 |
| `admin_users.py` | `/api/v1/admin/users` | 用户 CRUD、重置密码、权限（admin） |
| `user_settings.py` | `/api/v1/user` | 用户设置（地图偏好等，GET/PUT `/settings`） |
| `data.py` | `/api/v1/data` | 上传（含分片）、全量工参、小区查询/批量更新/删除、图层数据读写（整层/增量 patch、gzip）与下载、新站录入 |
| `geo_data.py` | `/api/v1/data` | 地理化数据上传（与 data 同前缀、不同 tag） |
| `layer.py` | `/api/v1/layer` | 图层制作（`/excel-info`、`/point`、`/sector`，Excel → TAB/MIF/KML） |
| `pci.py` / `neighbor.py` / `tac.py` | `/api/v1/pci` 等 | 规划/核查、进度、结果、历史、导出、应用到工参 |
| `distance_match.py` | `/api/v1/distance-match` | 批量距离匹配 |
| `site_spacing.py` | `/api/v1/site-spacing` | 站间距计算 |
| `attribute_join.py` | `/api/v1/attribute-join` | 条件选择（图层属性空间连接，`/plan` + 进度/结果/下载） |
| `buffer.py` | `/api/v1/buffer` | 绘制缓冲区（`/plan` + 进度/结果） |
| `map.py` | `/api/v1/map` | 地图数据/小区/扇区、缓存清理、在线与离线配置 |
| `license.py` | `/api/v1/license` | 许可证状态/上传/激活 |
| `app_versions.py` | `/api/v1/app-versions` | APP 版本管理：latest/download（公开）、上传（admin、分片） |
| `desktop_licenses.py` | `/api/v1/desktop-licenses` | 桌面授权管理（admin）：创建激活码/批准/禁用/解绑换机/重发码 |
| `desktop_cloud.py` | `/api/v1/desktop-cloud` | 桌面客户端公开接口：激活/续期/申请（激活码或旧许可即凭证）、`/config`、`releases/latest`、`releases/download/{id}`（Range） |
| `desktop_local.py` | `/api/v1/desktop` | 桌面版**本机**接口（仅 `NPT_DESKTOP=1`，否则 404）：`login/auth-poll`（账号登录与单机授权轮询）、`cloud-status/activate/renew/apply`、共享模式 `sync-status/run-mode/sync/sync-resolve/group`、`update/status|download|progress|snooze|install`、`exit`（经 `app/desktop_bridge.py` 关闭窗口） |
| `desktop_releases.py` | `/api/v1/desktop-releases` | 桌面版安装包管理（admin）：分片上传（complete 才鉴权）、列表/编辑/删除/设最新 |
| `assistant.py` | `/api/v1/assistant` | LLM 配置、数据集、对话（需 can_assistant 权限） |
| `system.py` | `/api/v1/system` | 状态/信息 |
| `websocket.py` | `/api/v1/ws/tasks` | 任务进度推送（注意不是裸 `/ws`） |

> 图层编辑/增量保存的端点不在 `layer.py`，而在 `data.py` 的 `PUT /{data_id}/layers/{layer_id}/data` 等路径，内部调用 `layer_edit_service`（整层重写）/ `layer_patch_service`（增量合并 + 版本冲突 409）。

## 关键文件位置

### 后端
- `main.py` — 入口、UTF-8/print 兜底、uvicorn；`api/__init__.py` — create_app、lifespan（建目录、清索引/临时文件、init_db、预热图层缓存）、CORS、`SelectiveGZipMiddleware`（APK 跳过压缩）、SPA 静态兜底与缓存策略
- `core/config.py` — Settings（`NPT_` 环境变量）；`core/database.py` — SQLite 引擎/迁移/默认管理员；`core/security.py` — JWT 与权限依赖；`core/data_access.py` — 数据组访问依赖；`core/exceptions.py` — 自定义异常
- `models/database.py` — ORM 表；`models/schemas.py` — Pydantic 模型
- `services/data_service.py` — 数据中心（单例）；`task_manager.py` — 任务引擎（单例）；`auth_service.py` — 认证/会话；`data_group.py` — 数据组隔离；`license_service.py` — 许可证
- `services/layer_service.py` — 图层制作；`layer_edit_service.py` — 图层编辑整层保存/打包下载；`layer_patch_service.py` — 增量保存与版本冲突；`tab_io.py` — TAB 底层读写；`tab_style_writer.py` / `ogr_style_reader.py` — 逐要素样式读写；`mapinfo_service.py` — TAB/MIF/KML 解析与样式
- `services/buffer_service.py` — 绘制缓冲区；`attribute_join_service.py` — 条件选择；`geo_data_service.py` / `geo_field_detector.py` — 地理化数据；`tac_planning_service.py` — TAC 规划；`distance_match_service.py` / `site_spacing_service.py` — 工具算法服务；`export_service.py` — 导出；`websocket_manager.py` — WS 广播
- `services/assistant/` — `chat_service.py`(function-calling)、`ingest_service.py`、`query_service.py`(只读 SQL 工具)、`llm_client.py`、`llm_config.py`(配置持久化到 `data/llm_config.json`)
- 桌面端：`services/desktop_license_service.py`（授权记录/登录/续期/影子账号）、`desktop_signing.py`（Ed25519 签发与验签）、`desktop_cloud_client.py`（客户端→授权服务器 HTTP）、`desktop_sync_service.py`（共享模式数据集双向同步）、`desktop_update_service.py`（OTA 检查/断点续传/sha256/静默安装）、`dataset_revision_service.py`（数据集修订号与墓碑）、`app/desktop_bridge.py`（桌面壳退出回调）
- `utils/` — `coordinate_transformer.py`、`excel_columns.py`、`geojson_geometry.py`、`layer_type_config.py`、`hardware_fingerprint.py`
- 运行时目录：`data/`（上传文件、`index.json`、`data.db`）、`outputs/`（任务结果）、`exports/`、`uploads/layers/`（图层文件）、`backend/app/apks/`（APK 文件）、`desktop_releases/`（桌面安装包，`DESKTOP_RELEASES_DIR`）、`licenses/`（许可文件与 Ed25519 私钥）、`installer-out/`（本地 Inno Setup 产物）
- 设计/实施历史文档在 `docs/plans/`（按日期，含图层/距离匹配/频点换算/小区查询等）

### 前端
- `App.tsx` — 路由与守卫；`pageLoaders.ts` — 懒加载/预取/chunk 恢复；`main.tsx` — 入口（首帧前 `applyTheme()`）；`i18n.ts` — 国际化
- `services/api.ts` — 全部后端 API 封装；`services/mapDataService.ts` — 工参拉取/过滤/坐标转换/LOD/IndexedDB 缓存；`services/decorationStorage.ts` — 装饰图层 IndexedDB 持久化
- `components/Map/` — 地图与图层编辑（见上文）；`store/` — Zustand；`utils/` — 坐标、配色、热力场、要素属性等纯函数
- `config/layer-config.ts`（图层字段匹配规则）、`config/sector-config.ts`（扇区渲染配置/LOD）

### 文档
- 部署：`NetworkPlanningTooV3-部署指南.md`、`NetworkPlanningTooV3-linux服务器版本部署指南.md`（均有同名 PDF）
- 根 `README.md` 已重写为完整功能概览；根 `CLAUDE.md` 已更新到当前代码状态；图层/许可证等专题在 `docs/`，历史设计与实施记录在 `docs/plans/`（按日期）

## 数据流与关键模式

- **文件上传**：前端 → `POST /api/v1/data/upload/excel`（大文件走 512KB 分片接口；按操作者/来源工参盖章数据组）→ Pandas 解析（LTE/NR 分表）→ 写 SQLite + `data/<id>/original.xlsx` → 刷新 `index.json`。
- **规划任务**：配置 → `POST /api/v1/{pci,neighbor,tac}/plan` → `task_manager.create_*_task` → `asyncio` 执行算法 → 进度回调 → WS/轮询 → 结果存 `outputs/` 与 `task_results` 表。
- **应用到工参**：规划结果直接 UPDATE SQLite，后台线程再同步回 Excel。
- **图层保存**：前端 GeoJSON（GCJ02）→ `PUT /api/v1/data/{dataId}/layers/{layerId}/data`（支持 gzip 请求体）→ 有基底版本指纹时走 `layer_patch_service` 增量合并（冲突 409，前端回退整层），否则 `layer_edit_service.save_layer_geojson` 整层重写 TAB/MIF（含样式元数据列）→ 刷新数据条目时间戳。
- **条件选择**：`POST /api/v1/attribute-join/plan` → `task_manager` → `attribute_join_service`（锚点落入 TAC/县界面图层，追加属性列）→ 结果 Excel 下载。
- **绘制缓冲区**：`POST /api/v1/buffer/plan` → `buffer_service`（each 逐要素 / dissolve 融合，点用测地线、线面用局部切平面）→ 写回装饰图层（前端 IndexedDB）或已有 MapInfo 图层（`layer_patch_service`）。
- **图层下载**：`GET /api/v1/data/{dataId}/layers/{layerId}/download` 打包同 stem 的 .tab/.dat/.id/.map/.ind；数据管理页原文件下载走 `GET /api/v1/data/{id}/download`。
- **APP 分发**：管理端分片上传 APK（绕过 Cloudflare 100MB 限制）→ `app_versions` 表 + `backend/app/apks/`；客户端 `GET /api/v1/app-versions/latest` 与 `/download/{id}`（支持 Range、下载计数）。
- **桌面版登录与授权（2026-10 改版）**：桌面端不再有 owner 免登录账号，与网页端**共用同一套账号**。登录页在桌面形态下多一组「运行模式」选择：
  - **共享模式**：`POST /desktop/login`（本机）→ 代理 `POST /desktop-cloud/auth/login`（服务器）→ `desktop_license_service.login()` 用 `auth_service.authenticate_user` 校验网页端账号 → 为该「账号+机器」自动签发许可（`DesktopLicense.mode='shared'`，作为同步凭证）→ 本机 `_mirror_local_user` 镜像同名本地账号（组/权限位/管理员位照搬）→ 签发本机 JWT。权限与数据组语义与网页端完全一致。
  - **单机模式**：同上流程，但服务器按 `(username, machine_code)` 找/建 `mode='standalone'` 授权记录；未批准返回 `result=pending`，前端 `DesktopAuthPendingDialog` 轮询 `POST /desktop/auth-poll`，管理员在网页端「桌面授权」页批准后当场签发许可并建立登录态。单机模式 `require_permission` 一律放行（权限全开）、强制 `run_mode=offline`、隐藏「桌面离线授权/运行模式与数据同步/数据组」三张卡片。
  - 记账：每次联机登录累加 `DesktopLicense.login_count`；断网登录本机记 `pending_offline_logins`，下次联机补报。`idle_logout_days`（默认 2 天）写在授权上并随许可下发，覆盖本机会话空闲超时（`core/security._desktop_idle_timeout_minutes`）。
  - 本机 users 表新增 `desktop_run_mode` 列区分当前模式；`DesktopLicense` 新增 `mode/username/user_id/login_count/last_login_at/idle_logout_days`。
- **许可签发与续期**：Ed25519 许可（私钥仅服务器：`NPT_LICENSE_PRIVATE_KEY` 或 `licenses/license_private_key.pem`，见 `services/desktop_signing.py`），租约默认 30 天、启动后台静默续期（剩余<20 天或距上次≥7 天）。OTA：管理端上传安装包到 `desktop_releases`，客户端比对版本 → 断点续传下载 + sha256 校验 → 在 `%APPDATA%\NetworkPlanningTool\updates\`（`DATA_ROOT/updates`）写升级脚本 `npt_update_*.cmd` → `CREATE_NO_WINDOW` 隐藏拉起（不弹终端窗口；脚本用 `ping` 计时，无控制台时 `timeout` 会报错），脚本等应用退出（`EXIT_WAIT_SECONDS=60` 超时 `taskkill` 兜底）→ `/VERYSILENT` 安装并记 `npt_setup.log` → 重启应用；应用侧由 `app/desktop_bridge.py` 的退出回调关窗，`desktop/launcher.py` 先武装 `EXIT_GRACE_SECONDS=20` 强制退出看门狗、`destroy` 抛异常则立即 `os._exit`，保证进程一定退出。「稍后」3 次或 `mandatory` 转强制。离线 `.nptlic` 导入通道保留。桌面版必须用 `NPT_CONSOLE=0` 构建（CI tag 发行会用 0 重新打包），否则程序自带控制台窗口。
- **网优助手**：LLM 配置/数据集导入到 `station_param_rows`、`station_metric_rows` 两张表，对话走 function-calling（最多 5 轮工具调用），查询只读。

## 添加新 API 端点

1. 在 `backend/app/api/v1/endpoints/` 新建端点文件
2. 在 `backend/app/api/v1/__init__.py` 用 `api_router.include_router(...)` 注册
3. 需要登录/权限时加 `Depends(get_current_user)` 或 `require_permission(...)`（见 `core/security.py`）；涉及数据条目再加 `require_data_group_access`（`core/data_access.py`，跨组 404）
4. 在 `shared/types.ts` 添加 TS 类型，在 `frontend/src/renderer/services/api.ts` 添加调用函数

## 关键开发约束

### 多语言（前端必须遵守）
- UI 文本一律用 `t()`，不得硬编码中文显示串。
- `useTranslation()` 必须在 React 组件函数体内调用（含 `UploadArea`/`DataPreview` 等子组件），不得依赖父组件传入的 `t`。
- 日期格式按 `i18n.language` 动态设 locale：`i18n.language === 'en' ? 'en-US' : 'zh-CN'`。
- 搜索/过滤逻辑不得依赖 `t()` 返回值；用布尔值或原始数据比较。
- 新增 key 必须同时在 `locales/zh.json` 和 `locales/en.json` 添加。

### 坐标系
- 前端渲染与图层编辑使用 GCJ02；后端持久化 WGS84。跨端传几何按既有链路转换（前端 `utils/coordinate.ts`，后端 `utils/coordinate_transformer.py` / `geojson_geometry.py`），新链路不得自行混用坐标系。

### 数据组隔离（后端横切约束）
- 任何数据查询/写入路径都必须接入组门禁（`data_group.py` + `core/data_access.py`）；含管理员在内仅见同组数据，跨组一律 404，不泄露数据存在性。
- 读取用 `group_sql_filter` / `index_entry_visible`，路由用 `require_data_group_access` / `require_task_access`；新建数据必须盖章 `(city, operator)`。

### 后端编码（Windows GBK 兼容）
- API 响应用 `UTF8JSONResponse`（`ensure_ascii=False`）；错误消息做 GBK 安全处理 `str(e).encode("gbk", "replace").decode("gbk")` 后再抛 `HTTPException`。

### CPU 密集型操作
- pandas/geopandas 用 `run_in_threadpool` 包裹；重任务放 `task_manager`，不要阻塞事件循环。

### 前端构建
- Vite `outDir` 必须为 `dist-renderer`（后端按此路径托管 SPA）；不要添加 `manualChunks`（历史上导致跨 chunk TDZ 错误，`vite.config.ts` 有注释说明）。

### 桌面端与服务器共存
- 桌面端与网页端**共用同一份后端代码**；所有桌面专属分支必须由 `NPT_DESKTOP` 门控，不得改变服务器（systemd）部署行为（`core/security.reject_desktop_mode` 会在桌面形态下把服务器专用管理端点一律 404）。
- 桌面端本机后端与服务器端后端各有一套 `data.db`，共享模式靠 `dataset_revisions` + `sync_state.json` 对齐，不要绕开同步链路直接改对端库；新增数据读写路径同样要接数据组门禁。
- `desktop/tools/keys/` 与 `licenses/` 下的 Ed25519 私钥已 gitignore，禁止入库或外发。

### 代码风格
- 前端：外部库 → 内部 `@/` 或 `@shared` 别名 → `type` 类型导入；组件 PascalCase、函数 camelCase、常量 UPPER_SNAKE_CASE、文件 kebab-case。
- 后端：标准库 → 第三方 → 内部（`from app...`）；类 PascalCase、函数 snake_case。
- React：Effects 仅用于同步外部系统（地图/事件/WS）；派生状态用 `useMemo`；自定义 Hook 以 `use` 前缀。
- 前端栈：React 18 + TypeScript + Zustand + Tailwind + Radix UI + lucide-react；地图 Leaflet/react-leaflet（在线）+ 自定义扇区渲染。

### 协作与提交约定（来自根 AGENTS.md）
- 回复使用简体中文；沟通按金字塔原理（结论先行、先全局后细节）。
- 编码遵循 DRY/KISS/SOLID/YAGNI；单文件超过 500 行、单函数超过 50 行时应识别拆分。
- Git 采用 GitHub Flow：禁止直接提交/强推 main；Conventional Commits；原子提交。
- 编码前有歧义先问；极简优先；只做精准修改，不顺手重构无关代码。
- 依赖管理：AGENTS.md 的通用约定是前端 pnpm、后端 uv；本仓库实际使用 npm（`frontend/`）+ pip/venv（`backend/.venv`），AGENTS.md 中已注明该例外。

## 依赖与环境注意

- **GDAL/geopandas**：图层与地理数据处理依赖（`requirements.txt` 中 gdal 行已注释，实际靠 pyogrio wheel 自带 libgdal）；Windows 参考 `install_geopandas.bat` 或 `conda install -c conda-forge gdal`。测试在缺库时由 conftest 自动 mock。
- **端口**：后端 8000、前端 5173；改端口需同步 `frontend/vite.config.ts` 代理。
- **类型同步**：前后端共享类型在 `shared/types.ts`，修改后同步。
- **环境文件**：后端 `backend/.env`（模板 `.env.example`），前端 `frontend/.env`（`VITE_DEV_MODE`、`VITE_API_URL`）。
- **镜像源**：npm 慢用 `npm config set registry https://registry.npmmirror.com`；pip 慢用清华源。
- 生产 systemd 配 `MemoryMax=2G`；SQLite 主库是仓库根 `data/data.db`，属运行时数据不要清理（`backend/data/` 下的 0 字节 `data.db` / `npt.db` 为残留，可忽略）。
- **桌面端依赖**：`desktop/requirements-desktop.txt`（pywebview、pyinstaller、pyogrio）只在 Windows 打包机上安装，不要加进 `backend/requirements.txt`。

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
NPT_DESKTOP_MAX_SNOOZE                    # 强制更新前允许「稍后」的次数
NPT_DESKTOP_SYNC_INTERVAL_MINUTES         # 共享模式后台同步轮询间隔
NPT_DESKTOP_SYNC_DEBOUNCE_SECONDS         # 本地改动上行防抖秒数，默认 3
```

## 故障排除

- **端口占用**：`ss -ltnp | grep :8000`（Linux）/ `netstat -ano | findstr :8000`（Windows）。
- **401/掉登录**：凭证在 `localStorage['auth-storage']`，JWT 过期、会话空闲超时或服务端吊销后前端会清除并要求重新登录；修改 `NPT_JWT_*` 会使旧 token 全部失效。
- **看不到数据（非 401）**：先查数据组隔离——用户 `city`/`operator` 为空即不可见任何业务数据，跨组一律 404。
- **地图不显示**：检查高德 Key（`NPT_AMAP_API_KEY`，config.py 有开发默认值）与网络。
- **上传失败（开发）**：`uploadClient` 直连 `http://localhost:8000`，检查 `VITE_API_URL` 与后端是否已启动。
- **GDAL 安装失败**：用预编译 wheel 或 conda 安装。
- **后端编码错误**：确认 `PYTHONIOENCODING=utf-8`（main.py 已设置）。
- **前端构建后线上没变化**：确认执行了 `npm run build:vite` 并重启 `npt-backend`（静态文件由后端托管）。
- **桌面端登录一直 pending**：单机模式需管理员在网页端「桌面授权」页批准（`NPT_DESKTOP_ACTIVATION_MODE=approve`），批准后前端 `auth-poll` 轮询会自动进入。
- **桌面端被踢下线**：共享模式为单设备登录，同账号在别处登录会使本机 `session-check` 失败并登出；`DesktopLicense.idle_logout_days`（默认 2 天）覆盖本机会话空闲超时。
- **桌面端数据不同步**：先看 `/desktop/sync-status` 与 `sync_state.json` 的 `conflicts`（push 带 `base_rev`，服务器 rev 不符返回 409）；服务器权威 rev 在 `dataset_revisions` 表，与本地记录的基线是两套数字。
- **桌面端 OTA 安装卡住 / 关不掉程序**：升级脚本在 `%APPDATA%\NetworkPlanningTool\updates\`，安装日志 `npt_setup.log`，运行日志 `logs/desktop.log`（关注「注入桌面桥接退出回调失败」「强制结束进程」）；脚本 60 秒等不到退出会 `taskkill`，应用侧 20 秒兜底 `os._exit`。若安装包自带控制台窗口，说明构建时 `NPT_CONSOLE` 不是 0（tag 发行由 CI 用 0 重新打包）。
- **桌面打包缺 GDAL**：确认 `desktop/hooks/hook-pyogrio.py` 生效且产物含 `gdal*.dll`/`proj*.dll`/`proj.db`（CI 有该校验步骤）。
