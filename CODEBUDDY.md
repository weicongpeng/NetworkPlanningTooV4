# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## 项目概述

**NetworkPlanningTooV3**（网络规划工具 v3.0）：电信网络规划 Web 应用，前端 Vite + React 18 + TypeScript，后端 FastAPI + SQLite。

- **前端**：纯 Web 应用（`npm run dev`），代码在 `frontend/src/renderer/`；生产构建产物 `frontend/dist-renderer/` 由 FastAPI 以 SPA 方式托管。
- **后端**：FastAPI + SQLAlchemy 2.0 / SQLite（`data/data.db` 为权威数据源）+ Excel 双写，代码在 `backend/`。
- **移动端**：独立 Expo / React Native 应用在 `mobile-app/`（有自己的 CLAUDE.md / AGENTS.md，本文件不覆盖）；调用同一后端，APK 由后端 `/api/v1/app-versions` 分发。
- **Electron / Capacitor 已废弃**：`frontend/package.json.electron`、`capacitor.config.ts` 仍在仓库，但 `frontend/electron/` 目录与 electron 依赖均不存在（仅剩 `frontend/start-electron-dev.bat`），不要按 Electron/Capacitor 方式启动或构建；旧部署文档中相关章节已过时。
- 仓库根的 `CLAUDE.md` 内容较旧（仍描述 Electron 启动、Docker、`/ws`、PCI v2 等），以本文件与当前代码为准。

**主要功能**：PCI 规划（碰撞/混淆、模 3/模 30）、邻区规划（覆盖圆）、TAC 核查与规划（异 TAC 孤岛/插花）、地图可视化与图层制作/编辑（在线高德/OSM、离线；TAB/MIF/KML/Excel 地理数据）、数据管理（上传、全量工参、小区查询/更新、新站录入）、距离匹配、站间距、频点换算（LTE/NR/GSCN）、网优助手（LLM）、用户与权限、APP 版本管理。

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

### 生产部署（Linux + systemd + Cloudflare Tunnel）

```bash
cd frontend && npm run build:vite     # 前端改动必须先构建
systemctl restart npt-backend         # 后端改动 / 前端构建后重启
```

- 入口 https://app.pengwc.asia → cloudflared 隧道 → `localhost:8000`（FastAPI 同时服务 REST API 与 `frontend/dist-renderer/` 静态资源）。
- systemd 单元 `npt-backend.service`：`WorkingDirectory=.../backend`、`ExecStart=.../backend/.venv/bin/python3 main.py`、`NPT_RELOAD=false`、`MemoryMax=2G`。
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
        + data/index.json (内存索引) , outputs/ , exports/
```

### 分层职责 (`backend/app/`)

| 层 | 位置 | 职责 |
|----|------|------|
| API 层 | `api/v1/endpoints/` | HTTP、参数校验、鉴权/权限依赖 |
| 服务层 | `services/` | 业务逻辑、数据管理、任务编排 |
| 算法层 | `algorithms/` | 纯计算：PCI、邻区、距离 |
| ORM 模型 | `models/database.py` | SQLAlchemy 表定义 |
| Pydantic 模型 | `models/schemas.py` | 请求/响应模型 |
| 基础设施 | `core/` | `config.py`(Settings/`NPT_`)、`database.py`(引擎+迁移+默认管理员)、`security.py`(JWT+权限依赖) |
| 应用入口 | `main.py` + `api/__init__.py` | UTF-8 处理；create_app/lifespan（建目录、清索引、init_db、预取图层缓存）、静态 SPA |

### 数据与存储（改动前必读）

- SQLite `data/data.db` 是查询与规划的权威数据源（WAL、外键），由 `core/database.py` 管理；`init_db()` 用 `PRAGMA table_info` 做轻量迁移，启动时创建默认管理员账号（首次登录强制改密，见 `core/database.py`）。
- 上传 Excel 时同时写 SQLite（Workbook/Site/Sector 等）并保留 `data/<id>/original.xlsx`；下载/导出时从 SQLite 反写 Excel（`data_service._save_to_sqlite`、`task_manager._sync_excel_from_sqlite`）。
- `data/index.json` 是内存索引的持久化，启动时会与 SQLite 中的 Workbooks/GeoFiles/Layers 对账合并（`data_service`）。
- ORM 表（`models/database.py`）：User、UserSession、Workbook、Site、Sector、GeoFile、Layer、UserSettings、TaskResult、AppVersion、StationParamRow、StationMetricRow。

### 认证与权限

- JWT Bearer（python-jose，HS256，默认 1440 分钟过期）+ bcrypt（passlib）。`UserSession` 表支持会话吊销与 IP 绑定。
- `core/security.py` 提供依赖：`get_current_user`、`get_current_admin_user`、`require_permission(...)`，以及 `require_data_import/delete/update`、`require_cell_entry`、`require_cell_query_update`、`require_assistant`；管理员绕过权限位。
- 前端：`authStore` 持久化 `localStorage['auth-storage']`；`services/api.ts` 自动附加 Bearer，401 时清除凭证并派发 `auth:required`；`AuthGuard` 包裹全应用（未登录只显示 `LoginModal`），`ProtectedRoute` 处理 license 到期 / `requireAdmin` / `requirePermission`；`useHeartbeat` 每 4 分钟 ping。

### 异步任务处理

- `services/task_manager.py`（单例）：`asyncio` + 信号量 `NPT_MAX_TASKS`，可选 ProcessPool（`NPT_MAX_WORKERS`）；状态 PENDING → PROCESSING → COMPLETED/FAILED。
- 进度经 `websocket_manager` 广播到前端 `/api/v1/ws/tasks`；结果落 `outputs/tasks_index.json` 与 `TaskResult` 表。
- 前端以 `taskStore` 2 秒轮询为主，WebSocket 目前只消费全局 `task_deleted` 消息。
- PCI/TAC「应用到工参」直接 UPDATE SQLite（`task_manager._apply_pci_fast_sqlite_only` 等），随后后台线程同步回 Excel。

### 算法层现状

- 活跃：`algorithms/pci_planning_v1_service.py`（`task_manager.py:28` 引用，**不是 v2**）、`neighbor_planning_v1_service.py`、`distance_calculator.py`；TAC 规划另用 scikit-learn BallTree。
- `pci_planning_service_v2.py` / `pci_planning_service.py` / `pci_collision_detector.py` 为历史版本，无活跃调用；所有 `*.bak*` / `*.backup*` 文件忽略。

### 前端架构（`frontend/src/renderer/`）

- 路由在 `App.tsx`（`AuthGuard > MainLayout > Suspense > Routes`）；页面在 `pages/`，由 `pageLoaders.ts` 做 React.lazy 分包 + 导航悬停预取：
  `/` 首页、`/data` 数据管理、`/pci`、`/neighbor`、`/tac`（核查）、`/tac-planning`、`/map` 地图与图层编辑、`/layer` 图层制作、`/distance-match` 距离匹配、`/site-spacing` 站间距、`/frequency-conversion` 频点换算、`/license`（许可证/主题/语言/LLM 配置，唯一不受 ProtectedRoute 限制）、`/admin/users`、`/app-versions`、`/assistant` 网优助手。
- Zustand store（`store/`，15 个文件）：`authStore`、`dataStore`、`taskStore`、`mapStore`（按用户持久化 `map-settings-user-<id>`，与后端 user settings 同步）、`layerEditStore`（图层编辑真源：workspaces/撤销/剪贴板）、`mapDataCacheStore`（跨页 LRU 缓存）、`licenseStore`、`pciStore`/`neighborStore`/`tacCheckStore`/`tacPlanningStore`（向导状态）、`tacStore`（旧版）、`themeStore`、`downloadStore`；`uploadStore` 不是 Zustand（分片上传单例）。
- `services/api.ts`：`apiClient`（`/api/v1`，300s）+ `uploadClient`（dev 直连 8000，规避 multipart 代理问题）+ 拦截器；按域导出 `authApi`/`adminUserApi`/`userSettingsApi`/`appVersionsApi`/`dataApi`/`layerApi`/`layerToolsApi`/`pciApi`/`neighborApi`/`tacApi`/`tacPlanningApi`/`distanceMatchApi`/`siteSpacingApi`/`mapApi`/`assistantApi` 等；另有 512KB 分片上传与并行 Range 下载（`utils/parallelDownload.ts`）。
- 地图（`components/Map/`，约 30 个源文件）：`OnlineMap.tsx`（Leaflet + 高德，跨页共享实例缓存，托管图层/选择/编辑会话）、`OfflineMap.tsx`、`MapInfoLayer.tsx`（TAB/MIF）、`GeoDataLayer.tsx`、`SectorRendererSVG.tsx`（LTE/NR 扇区）、`LayerControl.tsx`（图层树：显隐/可选/编辑开关/排序）、各类图例与对话框。
- 图层编辑子系统：`components/Map/LayerEditSession.ts`（绘制/顶点/吸附/圈选/命中，由 OnlineMap 懒创建）+ `store/layerEditStore.ts`；工具栏在 `pages/MapPage.tsx`（save/export/new/undo/capture/paste/measure/drag/select/marquee/draw/style/maptype/fullscreen，顺序与标签按用户持久化）。保存：`layerApi.saveLayerData` → `PUT /api/v1/data/{dataId}/layers/{layerId}/data`；新建：`POST /api/v1/data/map/layers/create`。前端几何使用 GCJ02，后端持久化 WGS84。
- i18n：i18next 单 namespace，`locales/zh.json` / `en.json`（约 1400 个 key，23 个分组）；语言切换入口在 LicensePage。
- 测试：与源码同目录的 `__tests__/*.test.ts`（Map 组件、utils、config、services 等 13 个文件）。

## API 端点前缀（`api/v1/endpoints/`）

| 文件 | 前缀 | 说明 |
|------|------|------|
| `auth.py` | `/api/v1/auth` | 注册/登录/me/ping/登出/改密 |
| `admin_users.py` | `/api/v1/admin/users` | 用户 CRUD、重置密码、权限（admin） |
| `user_settings.py` | `/api/v1/user` | 用户设置（地图偏好等，GET/PUT `/settings`） |
| `data.py` | `/api/v1/data` | 上传（含分片）、全量工参与小区查询/批量更新、图层数据读写/下载（权限位控制） |
| `geo_data.py` | `/api/v1/data` | 地理化数据上传（与 data 同前缀） |
| `layer.py` | `/api/v1/layer` | 图层制作（Excel → 点/扇区 TAB/MIF/KML） |
| `pci.py` / `neighbor.py` / `tac.py` | `/api/v1/pci` 等 | 规划/核查、进度、结果、历史、导出、应用到工参 |
| `distance_match.py` | `/api/v1/distance-match` | 批量距离匹配 |
| `site_spacing.py` | `/api/v1/site-spacing` | 站间距计算 |
| `map.py` | `/api/v1/map` | 地图数据/在线配置/离线配置 |
| `license.py` | `/api/v1/license` | 许可证状态/上传/激活 |
| `app_versions.py` | `/api/v1/app-versions` | APP 版本管理：latest/download（公开）、上传（admin、分片） |
| `assistant.py` | `/api/v1/assistant` | LLM 配置、数据集、对话（需 can_assistant 权限） |
| `system.py` | `/api/v1/system` | 状态/信息 |
| `websocket.py` | `/api/v1/ws/tasks` | 任务进度推送（注意不是裸 `/ws`） |

## 关键文件位置

### 后端
- `main.py` — 入口、UTF-8/print 兜底、uvicorn；`api/__init__.py` — create_app、lifespan、CORS、GZip、SPA 静态兜底
- `core/config.py` — Settings（`NPT_` 环境变量）；`core/database.py` — SQLite 引擎/迁移/默认管理员；`core/security.py` — JWT 与权限依赖
- `models/database.py` — ORM 表；`models/schemas.py` — Pydantic 模型
- `services/data_service.py` — 数据中心（单例）；`task_manager.py` — 任务引擎（单例）；`auth_service.py` — 认证/会话
- `services/layer_service.py` — 图层制作；`layer_edit_service.py` — 图层编辑保存/打包下载；`tab_io.py` — TAB 底层读写；`mapinfo_service.py` — TAB/MIF/KML 解析与样式
- `services/geo_data_service.py` / `geo_field_detector.py` — 地理化数据；`tac_planning_service.py` — TAC 规划；`distance_match_service.py` / `site_spacing_service.py` — 工具算法服务；`export_service.py` — 导出；`websocket_manager.py` — WS 广播
- `services/assistant/` — `chat_service.py`(function-calling)、`ingest_service.py`、`query_service.py`(只读 SQL 工具)、`llm_config.py`(配置持久化到 `data/llm_config.json`)
- `data/`（上传文件、`index.json`、`data.db`）、`outputs/`（任务结果）、`uploads/layers/`（图层文件）、`backend/app/apks/`（APK 文件）
- 设计/实施历史文档在 `docs/plans/`（按日期，含图层/距离匹配/频点换算/小区查询等）

### 文档
- 部署：`NetworkPlanningTooV3-部署指南.md`、`NetworkPlanningTooV3-linux服务器版本部署指南.md`
- 图层/许可证等专题：`docs/`；根 `README.md` 仅一行标题，无有效内容

## 数据流与关键模式

- **文件上传**：前端 → `POST /api/v1/data/upload/excel`（大文件走 512KB 分片接口）→ Pandas 解析（LTE/NR 分表）→ 写 SQLite + `data/<id>/original.xlsx` → 刷新 `index.json`。
- **规划任务**：配置 → `POST /api/v1/{pci,neighbor,tac}/plan` → `task_manager.create_*_task` → `asyncio` 执行算法 → 进度回调 → WS/轮询 → 结果存 `outputs/` 与 `TaskResult`。
- **应用到工参**：规划结果直接 UPDATE SQLite，后台线程再同步回 Excel。
- **图层保存**：前端 GeoJSON（GCJ02）→ `PUT /api/v1/data/{dataId}/layers/{layerId}/data` → `layer_edit_service.save_layer_geojson` 整层重写 TAB/MIF（含样式元数据列）→ 刷新数据条目时间戳。
- **图层下载**：`GET /api/v1/data/{dataId}/layers/{layerId}/download` 打包同 stem 的 .tab/.dat/.id/.map/.ind；数据管理页原文件下载走 `GET /api/v1/data/{id}/download`。
- **APP 分发**：管理端分片上传 APK（绕过 Cloudflare 100MB 限制）→ AppVersion 表 + `backend/app/apks/`；客户端 `GET /api/v1/app-versions/latest` 与 `/download/{id}`（支持 Range、下载计数）。
- **网优助手**：LLM 配置/数据集导入到 `station_param_rows`、`station_metric_rows` 两张表，对话走 function-calling（最多 5 轮工具调用），查询只读。

## 添加新 API 端点

1. 在 `backend/app/api/v1/endpoints/` 新建端点文件
2. 在 `backend/app/api/v1/__init__.py` 用 `api_router.include_router(...)` 注册
3. 需要登录/权限时加 `Depends(get_current_user)` 或 `require_permission(...)`（见 `core/security.py`）
4. 在 `shared/types.ts` 添加 TS 类型，在 `frontend/src/renderer/services/api.ts` 添加调用函数

## 关键开发约束

### 多语言（前端必须遵守）
- UI 文本一律用 `t()`，不得硬编码中文显示串。
- `useTranslation()` 必须在 React 组件函数体内调用（含 `UploadArea`/`DataPreview` 等子组件），不得依赖父组件传入的 `t`。
- 日期格式按 `i18n.language` 动态设 locale：`i18n.language === 'en' ? 'en-US' : 'zh-CN'`。
- 搜索/过滤逻辑不得依赖 `t()` 返回值；用布尔值或原始数据比较。
- 新增 key 必须同时在 `locales/zh.json` 和 `locales/en.json` 添加。

### 坐标系
- 前端渲染与图层编辑使用 GCJ02；后端持久化 WGS84。跨端传几何按既有链路转换（前端 `utils/coordinate.ts`，后端 geo 工具），新链路不得自行混用坐标系。

### 后端编码（Windows GBK 兼容）
- API 响应用 `UTF8JSONResponse`（`ensure_ascii=False`）；错误消息做 GBK 安全处理 `str(e).encode("gbk", "replace").decode("gbk")` 后再抛 `HTTPException`。

### CPU 密集型操作
- pandas/geopandas 用 `run_in_threadpool` 包裹；重任务放 `task_manager`，不要阻塞事件循环。

### 前端构建
- Vite `outDir` 必须为 `dist-renderer`（后端按此路径托管 SPA）；不要添加 `manualChunks`（历史上导致跨 chunk TDZ 错误，`vite.config.ts` 有注释说明）。

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

- **GDAL/geopandas**：图层与地理数据处理依赖；Windows 参考 `install_geopandas.bat` 或 `conda install -c conda-forge gdal`。测试在缺库时由 conftest 自动 mock。
- **端口**：后端 8000、前端 5173；改端口需同步 `frontend/vite.config.ts` 代理。
- **类型同步**：前后端共享类型在 `shared/types.ts`，修改后同步。
- **环境文件**：后端 `backend/.env`（模板 `.env.example`），前端 `frontend/.env`（`VITE_DEV_MODE`、`VITE_API_URL`）。
- **镜像源**：npm 慢用 `npm config set registry https://registry.npmmirror.com`；pip 慢用清华源。
- 生产 systemd 配 `MemoryMax=2G`；SQLite 主库 `data/data.db` 是运行时数据，不要当临时文件清理。

## 环境变量（`NPT_` 前缀，支持 `backend/.env` 覆盖）

```
NPT_HOST / NPT_PORT / NPT_CORS_ORIGINS
NPT_JWT_SECRET_KEY / NPT_JWT_ALGORITHM / NPT_JWT_ACCESS_TOKEN_EXPIRE_MINUTES
NPT_LICENSE_SECRET_KEY / NPT_LICENSE_EXPIRY_DAYS
NPT_AMAP_API_KEY / NPT_AMAP_SECURITY_CODE
NPT_MAX_TASKS / NPT_TASK_TIMEOUT / NPT_MAX_WORKERS
NPT_RELOAD / NPT_WORKERS
NPT_LLM_BASE_URL / NPT_LLM_API_KEY / NPT_LLM_MODEL / NPT_LLM_TIMEOUT
```

## 故障排除

- **端口占用**：`ss -ltnp | grep :8000`（Linux）/ `netstat -ano | findstr :8000`（Windows）。
- **401/掉登录**：凭证在 `localStorage['auth-storage']`，JWT 过期或服务端会话吊销后前端会清除并要求重新登录；修改 `NPT_JWT_*` 会使旧 token 全部失效。
- **地图不显示**：检查高德 Key（`NPT_AMAP_API_KEY`，config.py 有开发默认值）与网络。
- **上传失败（开发）**：`uploadClient` 直连 `http://localhost:8000`，检查 `VITE_API_URL` 与后端是否已启动。
- **GDAL 安装失败**：用预编译 wheel 或 conda 安装。
- **后端编码错误**：确认 `PYTHONIOENCODING=utf-8`（main.py 已设置）。
- **前端构建后线上没变化**：确认执行了 `npm run build:vite` 并重启 `npt-backend`（静态文件由后端托管）。
