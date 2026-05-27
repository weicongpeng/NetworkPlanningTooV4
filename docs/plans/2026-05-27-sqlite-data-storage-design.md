# SQLite 数据存储方案及多用户数据隔离设计

**日期**: 2026-05-27
**版本**: 1.0
**状态**: 设计完成

---

## 一、设计目标

用 SQLite 替代文件存储来管理工参数据，保留图层/地理化数据的文件存储模式，并通过 `user_id` 实现多用户数据隔离。

### 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 数据库引擎 | SQLite | 零配置、适合单机部署、与 ARM 服务器契合 |
| 数据隔离模型 | 共享库 + user_id 列 | 管理简单、管理员可跨用户查看 |
| 存储策略 | 工参入 SQL / 图层留文件 | 两种数据类型各自用最优方案 |

---

## 二、架构对比

### 当前架构

```
data/
  ├─ uuid_1/
  │   ├─ original.xlsx    # 原始 Excel 文件
  │   └─ data.json        # 解析后的站点/扇区数据 (JSON)
  ├─ uuid_2/
  │   ├─ original.xlsx
  │   ├─ data.json
  │   └─ sub_cell_info.csv  # 现网工参CSV数据
  └─ index.json            # 所有文件的元数据索引

uploads/
  └─ uuid.xlsx             # 上传的原始文件副本

图层文件 (独立目录)
地理化数据文件 (独立目录)
```

### 目标架构

```
data.db                    # SQLite 数据库 (合并 users.db)
  ├─ users                 # 已有：用户认证
  ├─ user_sessions         # 已有：会话管理
  ├─ workbooks             # 新增：工参元数据
  ├─ sites                 # 新增：站点数据
  ├─ sectors               # 新增：扇区数据
  ├─ geo_files             # 新增：地理化数据元数据
  └─ layers                # 新增：图层文件元数据

uploads/
  └─ uuid.xlsx             # 保留：原始文件 (下载功能依赖)

data/{uuid}/
  └─ original.xlsx         # 保留：原始文件副本

图层文件                    # 不变：实际地理数据文件
地理化数据文件               # 不变：实际地理数据文件
```

### 关键变化

- 取消 `data/index.json` 和 `data/{uuid}/data.json` 读写
- 工参数据以行记录存入 SQLite 表
- 图层/地理化数据保留文件存储，SQLite 只存元数据索引
- `user_id` 列贯穿所有业务表

---

## 三、数据模型

### 3.1 workbooks — 工参工作簿元数据

替换 `index.json` 中的文件元数据条目。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID，兼容现有 data_id |
| `user_id` | INTEGER | FK→users.id, NOT NULL | 数据隔离键 |
| `name` | TEXT | NOT NULL | 原始文件名 |
| `file_type` | TEXT | NOT NULL | full_params / target_cells / current_params / default |
| `network_types` | TEXT (JSON) | | `["LTE"]` / `["NR"]` / `["LTE","NR"]` |
| `status` | TEXT | NOT NULL, DEFAULT 'processing' | processing / ready / error |
| `size` | INTEGER | | 文件大小 (bytes) |
| `original_path` | TEXT | | 用户原始文件路径 |
| `metadata` | TEXT (JSON) | | `{"LTESiteCount": 100, "NRSectorCount": 300}` |
| `error_message` | TEXT | | 解析错误信息 |
| `created_at` | TEXT | NOT NULL | ISO 时间戳 |
| `updated_at` | TEXT | | ISO 时间戳 |

### 3.2 sites — 站点

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | |
| `workbook_id` | TEXT | FK→workbooks.id, NOT NULL | 所属工参 |
| `user_id` | INTEGER | FK→users.id, NOT NULL | 数据隔离键 |
| `site_id` | TEXT | NOT NULL | 原始基站ID (eNodeB/gNodeB) |
| `name` | TEXT | | 基站名称 |
| `longitude` | REAL | | |
| `latitude` | REAL | | |
| `network_type` | TEXT | NOT NULL | LTE / NR |
| `managed_element_id` | TEXT | | 管理网元 ID |
| `mcc` | TEXT | | NR专用 |
| `mnc` | TEXT | | NR专用 |

### 3.3 sectors — 扇区

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | |
| `site_id_fk` | INTEGER | FK→sites.id | 所属站点 |
| `workbook_id` | TEXT | FK→workbooks.id, NOT NULL | |
| `user_id` | INTEGER | FK→users.id, NOT NULL | |
| `sector_id` | TEXT | NOT NULL | 原始小区标识 |
| `name` | TEXT | | 小区名称 |
| `longitude` | REAL | | |
| `latitude` | REAL | | |
| `azimuth` | REAL | | 方位角 |
| `beamwidth` | REAL | | 默认65 |
| `height` | REAL | | 挂高 |
| `pci` | INTEGER | | 物理小区识别码 |
| `tac` | INTEGER | | 跟踪区码 |
| `frequency` | REAL | | EARFCN(LTE) / SSB频点(NR) |
| `cell_cover_type` | INTEGER | | 1=室外 4=室内 |
| `is_shared` | TEXT | | 是/否 |
| `first_group` | TEXT | | 第一分组 |
| `mcc` | TEXT | | NR专用 |
| `mnc` | TEXT | | NR专用 |

### 3.4 geo_files — 地理化数据元数据

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID |
| `user_id` | INTEGER | FK→users.id, NOT NULL | |
| `filename` | TEXT | NOT NULL | |
| `file_path` | TEXT | NOT NULL | 实际文件路径 |
| `geometry_type` | TEXT | NOT NULL | point / sector / polygon |
| `field_mapping` | TEXT (JSON) | | 检测到的字段映射 |
| `point_count` | INTEGER | | |
| `bbox` | TEXT (JSON) | | `[minLng, minLat, maxLng, maxLat]` |
| `file_size` | INTEGER | | |
| `created_at` | TEXT | NOT NULL | |

### 3.5 layers — 图层文件元数据

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID |
| `user_id` | INTEGER | FK→users.id, NOT NULL | |
| `name` | TEXT | NOT NULL | 图层名称 |
| `file_path` | TEXT | NOT NULL | 实际文件路径 |
| `layer_type` | TEXT | NOT NULL | tab / mif / geojson |
| `geometry_type` | TEXT | NOT NULL | point / line / polygon |
| `feature_count` | INTEGER | | |
| `bbox` | TEXT (JSON) | | |
| `file_size` | INTEGER | | |
| `created_at` | TEXT | NOT NULL | |

### 3.6 索引策略

```sql
-- 数据隔离列
CREATE INDEX idx_workbooks_user ON workbooks(user_id, file_type);
CREATE INDEX idx_sites_user_workbook ON sites(user_id, workbook_id);
CREATE INDEX idx_sectors_user_workbook ON sectors(user_id, workbook_id);
CREATE INDEX idx_sectors_site ON sectors(site_id_fk);

-- 搜索辅助
CREATE INDEX idx_sites_network ON sites(network_type, latitude, longitude);
CREATE INDEX idx_sectors_pci ON sectors(workbook_id, pci);
CREATE INDEX idx_sectors_name ON sectors(name);
CREATE INDEX idx_geo_files_user ON geo_files(user_id);
CREATE INDEX idx_layers_user ON layers(user_id);
```

---

## 四、多用户数据隔离

### 隔离层次

```
请求 → JWT 解析 → user_id → 所有查询 WHERE user_id = ?
```

### 三层保障

| 层级 | 机制 | 说明 |
|------|------|------|
| API 层 | `get_current_user()` 依赖注入 | JWT 提取 user_id，每个请求绑定用户上下文 |
| 服务层 | `user_id` 参数透传 | 所有 data_service 方法签名追加 `user_id: int` |
| 数据层 | SQL WHERE 子句 | 每张业务表 user_id 列强制过滤 |

### 典型查询示例

```python
# 获取用户的所有工参
workbooks = db.query(Workbook).filter(
    Workbook.user_id == user_id,
    Workbook.status == "ready"
).order_by(Workbook.created_at.desc()).all()

# 预览扇区数据（分页）
sectors = db.query(Sector).filter(
    Sector.user_id == user_id,
    Sector.workbook_id == workbook_id
).offset(0).limit(100).all()
```

### 管理员特权

```python
def get_workbooks(user_id: int, is_admin: bool = False):
    query = db.query(Workbook)
    if not is_admin:
        query = query.filter(Workbook.user_id == user_id)
    return query.all()
```

### 无需变更的部分

- `auth_service.py` / `license_service.py`：已有用户概念
- `task_manager.py`：任务执行中已能获取 user_id
- 算法层（`algorithms/`）：完全不碰

---

## 五、迁移策略

### 渐进式迁移

```
阶段 0: 双写 (新上传同步写入 SQLite + 文件存储)
阶段 1: 切换读取 (前端从 SQLite 查，旧数据按需迁移)
阶段 2: 清理 (移除 index.json 读写逻辑)
```

### 阶段 0 — 双写

- 新增 SQLite 建表逻辑（`init_db()` 扩充）
- 新上传文件解析后同时写入 SQLite + 旧 `data/{uuid}/` 目录
- 旧数据不变，系统正常运行

### 阶段 1 — 切换读取

- 列表/预览/下载 API 逐步切到 SQLite
- 对仅存在于旧 `index.json` 的数据，运行时自动迁移
- `SELECT 未命中 → 读 data.json → 写入 SQLite → 返回`

### 阶段 2 — 清理（后续迭代）

- 移除 `index.json` 读写
- 移除 `data/{uuid}/data.json` 写入
- 保留 `data/{uuid}/original.xlsx`（下载功能）
- 清理 DataService 中不再需要的代码路径

### 数据库合并方案

使用单一 `data.db` 文件替代当前 `users.db`：

```python
# core/database.py
DATABASE_URL = f"sqlite:///{settings.DATA_DIR / 'data.db'}"
```

理由：外键约束在同一数据库内更可靠，WAL 模式足够支撑混合读写。

---

## 六、性能预估

### 关键场景优化

| 场景 | 当前方式 | SQLite 方案 | 收益 |
|------|---------|------------|------|
| 获取数据列表 | 读 index.json (全量) | `SELECT FROM workbooks WHERE user_id=?` | O(n)→O(log n) |
| 预览前 N 行 | Pandas 解析全量 data.json | `SELECT LIMIT 100` | 无需全量加载 |
| 按网络类型过滤 | Python 遍历 JSON | `WHERE network_type='LTE'` | 数据库层过滤 |
| 搜索小区名称 | 遍历 data.json | `WHERE name LIKE '%kw%'` | 数据库层搜索 |

### 内存消耗对比 (10000 扇区)

| 项目 | 文件方案 | SQLite 方案 |
|------|---------|------------|
| 首次加载索引 | ~5MB | ~50KB |
| 全量数据预览 | ~200MB | ~10MB (分页) |
| 空闲状态 | ~50MB | ~2MB |

### API 响应时间预估

| API | 当前 | SQLite | 提升 |
|-----|------|--------|------|
| GET /data/list | 20-50ms | 5-10ms | 2-4x |
| GET /data/{id}/preview | 200-800ms | 10-20ms | 10-40x |
| POST /data/upload | 2-10s | 1.5-5s | 1.5-2x |

---

## 七、实现范围

### 新增/修改文件

```
backend/app/models/database.py     ← 扩充：Workbook, Site, Sector, GeoFile, Layer
backend/app/models/schemas.py      ← 扩充：对应 Pydantic 响应模型
backend/app/core/database.py       ← 改 URL 为 data.db
backend/app/services/data_service.py ← 核心查询逻辑切 SQLAlchemy
backend/app/services/geo_data_service.py ← 元数据入库
backend/app/services/mapinfo_service.py ← 元数据入库
```

### 不改动文件

- `core/config.py`
- 所有 API 端点文件（仅参数签名增加 `current_user` 依赖）
- 算法层（`algorithms/`）
- 前端代码（API 响应格式保持一致）

### 关键实现细节

- 扇区批量写入使用 `db.bulk_insert_mappings()` 提升性能
- 地理化/图层数据仅提取元数据入库，完整坐标保留原始文件
- 数据库文件合并为 `data.db`
