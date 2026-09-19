# 用户管理升级：按「地市+运营商」分组隔离数据空间 — 实施计划

## 已确认决策
1. **组内共享**：数据空间按 (city, operator) 分组，同组多用户共享同一套工参/图层/地理数据；数据归组所有（快照语义）。
2. **后端配置固定清单**：地市中心清单存后端配置（`NPT_CITY_PRESETS`），前端下拉从后端接口取；运营商固定 [移动, 联通, 电信, 广电]。
3. **存量数据归管理员**：现有无标记数据（city/operator=NULL）仅管理员可见，各组从零上传。
4. **注册必填**：地市+运营商均为注册必填下拉项，管理员建号/改号同样校验。

## 总体设计
- **归属模型**：给 Workbook/Site/Sector/GeoFile/Layer/StationParamRow/StationMetricRow/TaskResult 加可空 `city`/`operator` 列，写入时从操作者（或其操作的工参所属组）盖章。比 JOIN owner 方案简单：SQLite 无需 JOIN，内存索引条目自带组信息，任务线程无需反查用户表。
- **可见性规则**（统一封装在 `data_group` 模块）：
  - 管理员 → 全部可见；
  - 普通用户（city/operator 已填）→ 仅见组完全相等的行；
  - 用户组信息缺失 → 看不到任何业务数据（需管理员补齐）；
  - NULL 组行（存量）→ 仅管理员。
- **入口鉴权**：新增 FastAPI 依赖 `require_data_group_access(data_id)`，挂在所有 `/{data_id}` 路由，跨组访问返回 404（不泄露存在性）。
- **full_params 解析**：任务创建时把组快照进 `task.config`，执行期按组过滤索引扫描；管理员任务保持全局最新行为。

## 现状要点（已核实）
- `User.city`/`User.operator` 列已存在（backend/app/models/database.py:45-46），注册/管理端/类型/i18n 链路已通 —— 注册只需把地市从文本框改为下拉。
- 数据当前全局共享：user_id 只是印记、查询从不按它过滤；硬编码 `user_id=1` 两处（endpoints/geo_data.py:85、endpoints/data.py:1352）；分块上传索引条目缺 user_id（data.py:1413-1421 → data_service.py:4041 恒回退 1）。
- "全局唯一 full_params" 假设 7 处：task_manager.py:1549,1704,1780,2314,2443,2512,2910 + map.py:102-110 + tac_planning_service.py:446。
- map.py:20-23 全局单份 `_map_data_cache`（TTL 30 分钟）——必须按组分键，否则跨组串数据。

## 实施步骤

### 步骤 0 — 需要用户提供
- **初始地市清单**：写入 `backend/.env` 的 `NPT_CITY_PRESETS=郑州,洛阳,...`（逗号分隔）。清单为空时注册校验恒失败，必须先配。

### 1. 配置与公开选项端点
- `backend/app/core/config.py`：新增 `NPT_CITY_PRESETS: str = ""` + 计算属性 `CITY_PRESETS -> list[str]`（去空白/去空项，仿 `BACKEND_CORS_ORIGINS` 模式）。
- `backend/app/api/v1/endpoints/auth.py`：新增 **`GET /auth/options`（公开，登录前可达）** 返回 `{cities, operators}`；operators 取自新模块的 `OPERATORS` 常量。
- `backend/app/services/data_group.py`（新文件，约 120 行）：
  - `OPERATORS = ["移动", "联通", "电信", "广电"]`
  - `user_group(user) -> tuple|None`
  - `group_sql_filter(city_col, operator_col, user)`（管理员→None 不过滤；组缺失→`sqlalchemy.false()`）
  - `index_entry_visible(entry, user)`（条目缺 city/operator 键视为存量→仅管理员）
  - `validate_group(city, operator) -> str|None`

### 2. 数据库 schema 与迁移
- `models/database.py`：Workbook/Site/Sector/GeoFile/Layer/StationParamRow/StationMetricRow/TaskResult 各加 `city String(100) nullable index` + `operator String(50) nullable`。
- `core/database.py init_db()`：仿现有 `PRAGMA table_info` 轻量迁移，8 张表逐表 `ALTER TABLE ADD COLUMN`（存量行保持 NULL）。

### 3. 注册/建号校验
- `models/schemas.py` `UserCreate`(:713)：city/operator 改必填（min_length=1）；`UserUpdate`(:790) 保持 Optional、传了才校验。
- `endpoints/auth.py register()`：调 `validate_group`，失败 400（GBK 安全错误处理）。
- `endpoints/admin_users.py create_user()`(:58)/`update_user()`(:102)：提供即校验。
- `services/auth_service.py delete_user()`(:369)：**移除数据级联**（TaskResult by user_name、Workbook/Site/Sector/GeoFile/Layer by user_id，:379-385），保留 UserSession/UserSettings 级联——组数据不随成员删除而消失。

### 4. 写入盖章（写入路径全部补 city/operator 参数）
| 位置 | 改动 |
|---|---|
| data_service.init_upload(:3574) | 增参；:3676 索引条目补 user_id+group |
| endpoints/data.py 分块上传 :1413-1421 | 索引条目补 user_id=current_user.id + group（顺带修复） |
| data_service._process_upload_sync :4041 | 回读条目 user_id/city/operator |
| data_service._save_to_sqlite(:4075) | :4108/4127/4146 Workbook/Site/Sector 盖章（upsert 分支同步） |
| data_service.update_parameters(:539) | 新行继承**目标工参**的组（:689-696, :767），非操作者本人组 |
| add_cell_to_full_params(:1443)/bulk_add(:1154)/bulk_update_cells(:1982) | 新增行继承目标 workbook 的组 |
| endpoints/geo_data.py:85、data.py:1352 | 硬编码 1 → current_user.id + group |
| geo_data_service.parse_geo_data(:27)/_save_geo_file_metadata(:488) | GeoFile 盖章 |
| mapinfo_service.parse_mapinfo_files(:1338/1365/1394)，调用方 data_service.py:5630 | 组参数透传至 Layer |
| layer_edit_service create_empty(:63)/_upsert(:378)/_write(:460)/save_layer_geojson(:560) | :131/:398/:544 盖章 |
| assistant ingest_service(:155/203/243) | 增参盖章；assistant.py:75 补传 |
| task_manager Task(:64)/create_*_task(:732-786) | Task 增 city/operator；创建时快照进 config 与 TaskResult |

### 5. 查询过滤 + full_params 组内解析
- `data_service.py`：
  - `list_data`(:5993)/`get_total_count` 增 user 参数，索引遍历用 `index_entry_visible` 过滤；
  - `get_workbooks_from_db`(:6404) 启用 group 过滤（Workbook/GeoFile/Layer 三查询）；
  - `get_data_from_db`(:6583)、`get_sectors_preview_from_db`(:6532)、`search_cells`(:1117)、`check_cell_duplicates`(:1635) 加组过滤；
  - 新增 `check_access(data_id, user) -> bool`；
  - `_collect_db_entries_for_index`(:144)/`_build_index_from_db`(:179) 把 wb.city/operator 抄进索引条目（NULL 则不写键）。
- **full_params（高风险，改完 grep `fileType.*full_params` 复核清零）**：
  - task_manager.py 新增 `_resolve_full_params_index(city, operator)`：组内取最新 full_params；city=None（管理员）回退旧全局逻辑；替换 :1549-1552、:1704、:1780、:2314、:2443、:2512、:2910 共 7 处；
  - endpoints/map.py `_load_map_data_from_files`(:94) 增 user 参数、Workbook 查询加组过滤；**缓存按组分键**（`_map_data_cache` 改 `dict[key,...]`，key="admin" 或 "city|operator"）；
  - tac_planning_service.py:446 同样组过滤（组从任务 config 取）。
- 任务历史：task_manager.list_task_history(:2789) 增 user 参数按 TaskResult 新列过滤；pci.py:240/neighbor.py/tac.py 历史端点传 current_user。

### 6. 端点访问控制
- 新依赖 `require_data_group_access`（core 层新模块），取 path `data_id` → `data_service.check_access`，失败 404。
- 挂到 data.py 全部 `/{data_id}` 路由：GET :724、DELETE :739、preview :767、layers :794、layers/{id}/data :830、download/render-mobile 等（实施时 grep `/{data_id}` 全量核对）；PUT layers data :595、POST map/layers/create :564 同款。

### 7. 网优助手按组隔离
- `ingest_service.list_datasets`(:283) 过滤改按组；调用方 assistant.py:104、data.py:688 传 current_user。
- `assistant/query_service.py` 各工具 SQL 注入组条件（管理员不加）；个别改造成本高的工具先标注限制、后续补。

### 8. 前端改动
- `shared/types.ts`：新增 `RegisterOptions {cities, operators}`；DataItem 增 `city?/operator?`（backend schemas.py DataItem 同步）。
- `services/api.ts`：新增 `authApi.getOptions()`。
- `components/LoginModal.tsx`：mount 拉 options（失败回退内置 4 运营商 + 空城市表并提示）；地市 :243-249 改 `<select>`（必填）；运营商 select(:256-265) options 用接口数据；提交前非空校验。
- `pages/AdminUsersPage.tsx`：新增/编辑对话框地市输入(:495,:595)改 `<select>`；运营商 select(:499-505,:599-605) 统一走接口数据源，删 3 处硬编码。
- `components/Layout/MainLayout.tsx`：用户名旁(:505 附近)展示 `{user.city} · {user.operator}`（有才显示）。
- wire format 不变；authStore.register 已支持，无需改。

### 9. i18n（zh.json :1207 附近 / en.json 同步）
- 新增 `auth.citySelectPlaceholder`、`auth.optionsLoadFailed`、`auth.groupRequired`。

### 10. 测试
- 新增 `backend/tests/test_data_group_scope.py`：
  - /auth/options 返回配置清单；注册缺项/非法地市/非法运营商 → 400；
  - A(郑州,移动) 上传后：list 只含本组；B(洛阳,联通) list 空、GET/DELETE 他人 data_id → 404；
  - 管理员全见；NULL 组用户不可见；
  - 两组各一份 full_params，B 组 PCI 任务解析到 B 组文件；
  - 任务历史按组隔离；删除用户不删组数据。
- 回归 `python -m pytest tests/ -v`；前端 LoginModal 注册模式测试 + `npm run lint && npm run type-check`。
- 手动验收：两组账号各传全量工参 → 数据管理/地图/PCI/邻区/TAC/图层/助手/任务历史逐项互查隔离。

### 11. 上线（由用户自行执行，不代劳）
1. `backend/.env` 配置 `NPT_CITY_PRESETS=<地市清单>`；
2. `cd frontend && npm run build:vite`；
3. `systemctl restart npt-backend`。

## 风险点
1. task_manager 7 处 full_params 扫描最易漏 → 改完 grep 复核；组必须创建任务时快照进 config（任务线程禁止反查用户表）。
2. map.py 缓存必须按组分键，否则 TTL 内跨组串数据。
3. `get_data` 内部调用方众多，不加 user 参数；入口校验全靠第 6 节依赖。
4. 组继承方向：工参更新/小区录入继承**目标工参**的组，防止跨组操作致数据"搬家"。
5. 移动端（mobile-app）注册链路桥接 city/operator 但无 UI；后端必填化后移动端注册需补下拉，列待办、本次不阻塞。
6. 存量普通用户 city/operator 为 NULL → 登录后无数据可见，需管理员在用户管理页补齐。

## 待办输入
- 步骤 0 的初始地市清单（实施开始时向用户索取）。
