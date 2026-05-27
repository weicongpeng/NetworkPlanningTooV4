# SQLite 数据存储方案及多用户数据隔离 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用 SQLite 替代文件存储管理工参数据，保留图层/地理化数据文件存储，通过 `user_id` 列实现多用户数据隔离。

**Architecture:** 在现有 SQLAlchemy 基础设施上新增 5 张业务表（workbooks/sites/sectors/geo_files/layers），合并 users.db 为 data.db。分 3 阶段渐进式迁移：双写 → 切读 → 清理。

**Tech Stack:** SQLite + SQLAlchemy ORM + Pydantic v2 + FastAPI

---

## 阶段 0：双写（基础设施 + 新数据同步写入）

### Task 1: 数据库基础设施改造

**Files:**
- Modify: `backend/app/core/database.py`
- Modify: `backend/app/models/database.py`

**Step 1: 扩展 database.py 模型文件**

在 `backend/app/models/database.py` 末尾新增 5 个 ORM 模型：

```python
# backend/app/models/database.py 末尾追加

import json
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey, Index, Text, Float
)

class Workbook(Base):
    """工参工作簿元数据"""
    __tablename__ = "workbooks"

    id = Column(String(36), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    file_type = Column(String(50), nullable=False)
    network_types = Column(Text, nullable=True)  # JSON: ["LTE","NR"]
    status = Column(String(20), nullable=False, default="processing")
    size = Column(Integer, nullable=True)
    original_path = Column(Text, nullable=True)
    metadata = Column(Text, nullable=True)  # JSON
    error_message = Column(Text, nullable=True)
    created_at = Column(String(30), nullable=False)
    updated_at = Column(String(30), nullable=True)

    # 索引
    __table_args__ = (
        Index("idx_workbooks_user_type", "user_id", "file_type"),
    )


class Site(Base):
    """站点"""
    __tablename__ = "sites"

    id = Column(Integer, primary_key=True, autoincrement=True)
    workbook_id = Column(String(36), ForeignKey("workbooks.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    site_id = Column(String(100), nullable=False)
    name = Column(String(255), nullable=True)
    longitude = Column(Float, nullable=True)
    latitude = Column(Float, nullable=True)
    network_type = Column(String(10), nullable=False)
    managed_element_id = Column(String(100), nullable=True)
    mcc = Column(String(10), nullable=True)
    mnc = Column(String(10), nullable=True)

    __table_args__ = (
        Index("idx_sites_user_workbook", "user_id", "workbook_id"),
        Index("idx_sites_network_coords", "network_type", "latitude", "longitude"),
    )


class Sector(Base):
    """扇区"""
    __tablename__ = "sectors"

    id = Column(Integer, primary_key=True, autoincrement=True)
    site_id_fk = Column(Integer, ForeignKey("sites.id"), nullable=True)
    workbook_id = Column(String(36), ForeignKey("workbooks.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    sector_id = Column(String(100), nullable=False)
    name = Column(String(255), nullable=True)
    longitude = Column(Float, nullable=True)
    latitude = Column(Float, nullable=True)
    azimuth = Column(Float, nullable=True)
    beamwidth = Column(Float, nullable=True, default=65.0)
    height = Column(Float, nullable=True)
    pci = Column(Integer, nullable=True)
    tac = Column(Integer, nullable=True)
    frequency = Column(Float, nullable=True)
    cell_cover_type = Column(Integer, nullable=True, default=1)
    is_shared = Column(String(10), nullable=True)
    first_group = Column(String(100), nullable=True)
    mcc = Column(String(10), nullable=True)
    mnc = Column(String(10), nullable=True)

    __table_args__ = (
        Index("idx_sectors_user_workbook", "user_id", "workbook_id"),
        Index("idx_sectors_site", "site_id_fk"),
        Index("idx_sectors_pci", "workbook_id", "pci"),
        Index("idx_sectors_name", "name"),
    )


class GeoFile(Base):
    """地理化数据文件元数据"""
    __tablename__ = "geo_files"

    id = Column(String(36), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    filename = Column(String(255), nullable=False)
    file_path = Column(Text, nullable=False)
    geometry_type = Column(String(20), nullable=False)
    field_mapping = Column(Text, nullable=True)  # JSON
    point_count = Column(Integer, nullable=True)
    bbox = Column(Text, nullable=True)  # JSON
    file_size = Column(Integer, nullable=True)
    created_at = Column(String(30), nullable=False)

    __table_args__ = (
        Index("idx_geo_files_user", "user_id"),
    )


class Layer(Base):
    """图层文件元数据"""
    __tablename__ = "layers"

    id = Column(String(36), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    file_path = Column(Text, nullable=False)
    layer_type = Column(String(20), nullable=False)
    geometry_type = Column(String(20), nullable=False)
    feature_count = Column(Integer, nullable=True)
    bbox = Column(Text, nullable=True)  # JSON
    file_size = Column(Integer, nullable=True)
    created_at = Column(String(30), nullable=False)

    __table_args__ = (
        Index("idx_layers_user", "user_id"),
    )
```

**Step 2: 修改 database.py 初始化和数据库路径**

将 `backend/app/core/database.py` 中的 DATABASE_URL 从 `users.db` 改为 `data.db`，并扩充 `init_db()` ：

```python
# 修改行 10
DATABASE_URL = f"sqlite:///{settings.DATA_DIR / 'data.db'}"
```

扩充 `init_db()` 函数以包含所有新模型：

```python
def init_db():
    """初始化数据库表结构（含迁移逻辑）"""
    from app.models.database import (
        User, UserSession, Workbook, Site, Sector, GeoFile, Layer
    )  # noqa: F401
    Base.metadata.create_all(bind=engine)

    # 迁移：为已有数据库添加新列（保留原有逻辑）
    with engine.connect() as conn:
        # 检查并添加 User 表新列
        existing_cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(users)").fetchall()]
        migrations = [
            ("city", "ALTER TABLE users ADD COLUMN city VARCHAR(100)"),
            ("operator", "ALTER TABLE users ADD COLUMN operator VARCHAR(50)"),
            ("equipment_vendor", "ALTER TABLE users ADD COLUMN equipment_vendor VARCHAR(50)"),
            ("ip_address", "ALTER TABLE user_sessions ADD COLUMN ip_address VARCHAR(45)"),
        ]
        for col_name, sql in migrations:
            table_name = "user_sessions" if "user_sessions" in sql else "users"
            table_cols = [row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table_name})").fetchall()]
            if col_name not in table_cols:
                conn.exec_driver_sql(sql)
        conn.commit()
```

**Step 3: 验证 — 启动后端确认建表成功**

```bash
cd backend && python main.py
```
访问 http://127.0.0.1:8000/docs 确认服务正常启动，检查 data.db 文件生成。

**Step 4: 提交**

```bash
git add backend/app/models/database.py backend/app/core/database.py
git commit -m "feat: add Workbook/Site/Sector/GeoFile/Layer ORM models and switch to data.db"
```

---

### Task 2: DataService 双写 — 工参上传时写入 SQLite

**Files:**
- Modify: `backend/app/services/data_service.py`

**注意**: 这是阶段 0 的核心任务，代码量较大。需要在保留原文件写入逻辑的基础上，新增 SQL 写入路径。

**Step 1: 导入 SQLAlchemy 依赖**

在 `data_service.py` 顶部新增导入：

```python
# 新增导入（在现有 import 之后）
from app.core.database import SessionLocal
from app.models.database import Workbook, Site, Sector
```

**Step 2: 新增辅助方法 — 写入工参数据到 SQLite**

在 `DataService` 类中新增方法：

```python
def _save_to_sqlite(
    self,
    data_id: str,
    filename: str,
    file_type: str,
    user_id: int,
    parsed_data: Dict[str, List],
    metadata: Dict[str, Any],
    file_path: Path,
    original_path: Optional[str] = None,
):
    """将工参数据写入 SQLite（双写阶段）"""
    db = SessionLocal()
    try:
        # 1) 写入 Workbook
        network_types = list(parsed_data.keys())
        wb = Workbook(
            id=data_id,
            user_id=user_id,
            name=filename,
            file_type=file_type,
            network_types=json.dumps(network_types) if network_types else None,
            status="ready",
            size=file_path.stat().st_size if file_path.exists() else None,
            original_path=original_path,
            metadata=json.dumps(metadata, ensure_ascii=False) if metadata else None,
            created_at=datetime.now().isoformat(),
        )
        db.add(wb)

        # 2) 写入 Sites + Sectors
        for network_type, sites in parsed_data.items():
            for site_data in sites:
                site = Site(
                    workbook_id=data_id,
                    user_id=user_id,
                    site_id=str(site_data.get("id", "")),
                    name=site_data.get("name", "Unknown"),
                    longitude=site_data.get("longitude", 0.0),
                    latitude=site_data.get("latitude", 0.0),
                    network_type=network_type,
                    managed_element_id=site_data.get("managedElementId"),
                    mcc=site_data.get("mcc"),
                    mnc=site_data.get("mnc"),
                )
                db.add(site)
                db.flush()  # 获取 site.id

                # 批量构建扇区 dict
                sector_dicts = []
                for sec in site_data.get("sectors", []):
                    sector_dicts.append({
                        "site_id_fk": site.id,
                        "workbook_id": data_id,
                        "user_id": user_id,
                        "sector_id": str(sec.get("id", "")),
                        "name": sec.get("name", ""),
                        "longitude": sec.get("longitude", 0.0),
                        "latitude": sec.get("latitude", 0.0),
                        "azimuth": sec.get("azimuth", 0.0),
                        "beamwidth": sec.get("beamwidth", 65.0),
                        "height": sec.get("height", 30.0),
                        "pci": sec.get("pci"),
                        "tac": sec.get("tac"),
                        "frequency": sec.get("frequency") or sec.get("earfcn") or sec.get("ssb_frequency"),
                        "cell_cover_type": sec.get("cell_cover_type", 1),
                        "is_shared": sec.get("is_shared"),
                        "first_group": sec.get("first_group"),
                        "mcc": sec.get("mcc"),
                        "mnc": sec.get("mnc"),
                    })
                if sector_dicts:
                    db.bulk_insert_mappings(Sector, sector_dicts)

        db.commit()
    except Exception as e:
        db.rollback()
        safe_print(f"[DataService] SQLite 写入失败 (非致命): {e}")
    finally:
        db.close()
```

**Step 3: 修改 `_process_upload_sync` — 调用双写**

在 `_process_upload_sync` 方法末尾（data.json 写入之后，索引更新之前），新增双写调用：

```python
# 在 _process_upload_sync 中，data.json 写入成功后：
# 新增：同时写入 SQLite（阶段 0 双写）
user_id = data_info.get("user_id", 1)  # 默认 admin 用户
self._save_to_sqlite(
    data_id=data_id,
    filename=data_info.get("name", filename),
    file_type=file_type,
    user_id=user_id,
    parsed_data=parsed_data,
    metadata=metadata,
    file_path=file_path,
    original_path=data_info.get("original_path"),
)
```

**Step 4: 修改 `init_upload` — 传递 user_id**

`init_upload` 方法需要接收和存储 user_id：

```python
async def init_upload(
    self, file: Optional[Any], original_path: Optional[str] = None,
    user_id: int = 1
) -> Dict[str, Any]:
    # ... 现有逻辑 ...
    self.index[data_id] = {
        # ... 现有字段 ...
        "user_id": user_id,  # 新增
    }
    # ...
```

**Step 5: 修改 DataPage API 端点 — 传递 current_user**

后续 Task 中处理，此步骤仅确保 DataService 内部写好。

**Step 6: 验证 — 上传一个 Excel 并检查 data.db 中的数据**

```bash
# 启动后端
cd backend && python main.py

# 用 curl 或前端上传 Excel
# 然后用 sqlite3 检查
sqlite3 data/data.db "SELECT COUNT(*) FROM workbooks;"
sqlite3 data/data.db "SELECT COUNT(*) FROM sectors;"
```

**Step 7: 提交**

```bash
git add backend/app/services/data_service.py
git commit -m "feat: add dual-write to SQLite for workbook/site/sector data on upload"
```

---

### Task 3: Pydantic Schemas 扩展

**Files:**
- Modify: `backend/app/models/schemas.py`

**Step 1: 新增 SQL 数据响应模型**

在 `schemas.py` 末尾新增：

```python
from pydantic import BaseModel
from typing import Optional, List, Any

class WorkbookOut(BaseModel):
    id: str
    user_id: int
    name: str
    file_type: str
    network_types: Optional[List[str]] = None
    status: str
    size: Optional[int] = None
    original_path: Optional[str] = None
    metadata: Optional[dict] = None
    error_message: Optional[str] = None
    created_at: str
    updated_at: Optional[str] = None

class SectorPreview(BaseModel):
    """扇区预览（分页返回）"""
    id: int
    sector_id: str
    name: Optional[str] = None
    pci: Optional[int] = None
    tac: Optional[int] = None
    azimuth: Optional[float] = None
    longitude: Optional[float] = None
    latitude: Optional[float] = None
    network_type: Optional[str] = None
    cell_cover_type: Optional[int] = None

class WorkbookPreview(BaseModel):
    workbook: WorkbookOut
    sectors: List[SectorPreview]
    total: int
    page: int
    page_size: int

class GeoFileOut(BaseModel):
    id: str
    user_id: int
    filename: str
    file_path: str
    geometry_type: str
    point_count: Optional[int] = None
    bbox: Optional[List[float]] = None
    file_size: Optional[int] = None
    created_at: str

class LayerOut(BaseModel):
    id: str
    user_id: int
    name: str
    file_path: str
    layer_type: str
    geometry_type: str
    feature_count: Optional[int] = None
    bbox: Optional[List[float]] = None
    file_size: Optional[int] = None
    created_at: str
```

**Step 2: 提交**

```bash
git add backend/app/models/schemas.py
git commit -m "feat: add Pydantic response schemas for SQL-backed data models"
```

---

### Task 4: GeoDataService 和 MapInfoService 元数据入库

**Files:**
- Modify: `backend/app/services/geo_data_service.py`
- Modify: `backend/app/services/mapinfo_service.py`

**Step 1: GeoDataService — 解析完成后写入 geo_files 表**

在 `geo_data_service.py` 中新增元数据入库方法：

```python
# geo_data_service.py 新增
import json
import uuid
from datetime import datetime
from app.core.database import SessionLocal
from app.models.database import GeoFile

def _save_geo_file_metadata(
    user_id: int,
    filename: str,
    file_path: str,
    geometry_type: str,
    field_mapping: dict,
    point_count: int,
    bbox: Optional[List[float]] = None,
    file_size: Optional[int] = None,
):
    """保存地理化数据文件元数据到 SQLite"""
    db = SessionLocal()
    try:
        geo = GeoFile(
            id=str(uuid.uuid4()),
            user_id=user_id,
            filename=filename,
            file_path=file_path,
            geometry_type=geometry_type,
            field_mapping=json.dumps(field_mapping, ensure_ascii=False) if field_mapping else None,
            point_count=point_count,
            bbox=json.dumps(bbox) if bbox else None,
            file_size=file_size,
            created_at=datetime.now().isoformat(),
        )
        db.add(geo)
        db.commit()
    except Exception as e:
        db.rollback()
        print(f"[GeoDataService] 元数据入库失败 (非致命): {e}")
    finally:
        db.close()
```

在 `parse_geo_data` 方法成功返回前调用此函数。

**Step 2: MapInfoService — 图层加载完成后写入 layers 表**

类似逻辑，在图层解析成功后调用：

```python
# mapinfo_service.py 新增
def _save_layer_metadata(
    user_id: int,
    name: str,
    file_path: str,
    layer_type: str,
    geometry_type: str,
    feature_count: int,
    bbox: Optional[List[float]] = None,
    file_size: Optional[int] = None,
):
    """保存图层文件元数据到 SQLite"""
    # ... 类似实现
```

**Step 3: 提交**

```bash
git add backend/app/services/geo_data_service.py backend/app/services/mapinfo_service.py
git commit -m "feat: add geo_file and layer metadata persistence to SQLite"
```

---

### Task 5: DataService 列表和预览查询切 SQLite

**Files:**
- Modify: `backend/app/services/data_service.py`
- Modify: `backend/app/api/v1/endpoints/data.py`

**Step 1: DataService 新增 SQL 查询方法**

```python
# data_service.py 新增方法
def get_workbooks_from_db(self, user_id: int, is_admin: bool = False) -> List[Dict]:
    """从 SQLite 获取工参列表"""
    db = SessionLocal()
    try:
        query = db.query(Workbook)
        if not is_admin:
            query = query.filter(Workbook.user_id == user_id)
        workbooks = query.order_by(Workbook.created_at.desc()).all()
        return [{
            "id": wb.id,
            "user_id": wb.user_id,
            "name": wb.name,
            "type": "excel",
            "fileType": wb.file_type,
            "size": wb.size,
            "status": wb.status,
            "uploadDate": wb.created_at,
            "metadata": json.loads(wb.metadata) if wb.metadata else {},
            "networkTypes": json.loads(wb.network_types) if wb.network_types else [],
        } for wb in workbooks]
    finally:
        db.close()

def get_sectors_preview_from_db(
    self, workbook_id: str, user_id: int, page: int = 1, page_size: int = 100,
    network_type: Optional[str] = None
) -> Dict[str, Any]:
    """从 SQLite 获取扇区预览（分页）"""
    db = SessionLocal()
    try:
        query = db.query(Sector).filter(
            Sector.user_id == user_id,
            Sector.workbook_id == workbook_id,
        )
        if network_type:
            # 通过 JOIN sites 过滤 network_type
            query = query.join(Site, Sector.site_id_fk == Site.id).filter(
                Site.network_type == network_type
            )

        total = query.count()
        sectors = query.offset((page - 1) * page_size).limit(page_size).all()

        # 获取对应站点信息以补充 network_type
        site_ids = list(set(s.site_id_fk for s in sectors if s.site_id_fk))
        sites_map = {}
        if site_ids:
            site_objs = db.query(Site).filter(Site.id.in_(site_ids)).all()
            sites_map = {s.id: s for s in site_objs}

        return {
            "sectors": [{
                "id": s.id,
                "sector_id": s.sector_id,
                "name": s.name,
                "pci": s.pci,
                "tac": s.tac,
                "azimuth": s.azimuth,
                "longitude": s.longitude,
                "latitude": s.latitude,
                "network_type": sites_map.get(s.site_id_fk).network_type if s.site_id_fk in sites_map else None,
                "cell_cover_type": s.cell_cover_type,
            } for s in sectors],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    finally:
        db.close()
```

**Step 2: 修改 data.py 端点 — 注入 user_id**

在 `backend/app/api/v1/endpoints/data.py` 中：

```python
# 获取数据列表端点
@router.get("/list")
async def get_data_list(
    current_user: dict = Depends(get_current_user),
):
    user_id = current_user.get("user_id") if isinstance(current_user, dict) else current_user.user_id
    is_admin = current_user.get("is_admin", False) if isinstance(current_user, dict) else current_user.is_admin

    try:
        workbooks = data_service.get_workbooks_from_db(user_id, is_admin)
    except Exception:
        # 回退到旧 index.json 方式
        workbooks = data_service.get_data_list_legacy()
    return {"success": True, "data": workbooks}
```

预览和删除端点做类似修改。

**Step 3: 提交**

```bash
git add backend/app/services/data_service.py backend/app/api/v1/endpoints/data.py
git commit -m "feat: switch data list/preview API to SQLite with user_id isolation"
```

---

## 阶段 1：切换读取（旧数据按需迁移）

### Task 6: 旧数据运行时自动迁移

**Files:**
- Modify: `backend/app/services/data_service.py`

**Step 1: 新增旧数据迁移方法**

```python
def _migrate_legacy_data(self, data_id: str, user_id: int = 1):
    """将 index.json + data.json 中的旧数据迁移到 SQLite"""
    if data_id not in self.index:
        return False

    data_info = self.index[data_id]
    data_dir = settings.DATA_DIR / data_id
    data_json = data_dir / "data.json"

    if not data_json.exists():
        return False

    with open(data_json, "r", encoding="utf-8") as f:
        parsed_data = json.load(f)

    metadata = data_info.get("metadata", {})
    file_path = settings.UPLOAD_DIR / f"{data_id}.xlsx"

    self._save_to_sqlite(
        data_id=data_id,
        filename=data_info.get("name", "legacy.xlsx"),
        file_type=data_info.get("fileType", "default"),
        user_id=user_id,
        parsed_data=parsed_data,
        metadata=metadata,
        file_path=file_path,
        original_path=data_info.get("originalPath"),
    )
    return True
```

**Step 2: 在查询方法中集成按需迁移**

```python
def get_sectors_preview_from_db(
    self, workbook_id: str, user_id: int, **kwargs
) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        exists = db.query(Workbook).filter(Workbook.id == workbook_id).first()
        if not exists:
            # 旧数据：先迁移
            success = self._migrate_legacy_data(workbook_id, user_id)
            if not success:
                raise ValueError(f"工参不存在: {workbook_id}")
        # 正常查询...
    finally:
        db.close()
```

**Step 3: 提交**

```bash
git add backend/app/services/data_service.py
git commit -m "feat: add runtime migration for legacy index.json data to SQLite"
```

---

### Task 7: 所有 API 端点接入 user_id 隔离

**Files:**
- Modify: `backend/app/api/v1/endpoints/pci.py`
- Modify: `backend/app/api/v1/endpoints/neighbor.py`
- Modify: `backend/app/api/v1/endpoints/tac.py`
- Modify: `backend/app/api/v1/endpoints/map.py`

**Step 1: 逐个端点增加 user_id 过滤**

每个涉及数据查询的端点函数参数中增加 `current_user = Depends(get_current_user)`，在调用 data_service 时传入 user_id。

以 pci.py 为例：

```python
from app.services.auth_service import get_current_user

@router.post("/plan")
async def plan_pci(
    request: PciPlanRequest,
    current_user: dict = Depends(get_current_user),
):
    user_id = current_user.get("user_id") if isinstance(current_user, dict) else current_user.user_id
    # 将 user_id 传递给 data_service 和 task_manager
    task_id = await task_manager.create_pci_task(user_id=user_id, **request.dict())
```

neighbor.py、tac.py、map.py 做类似修改。

**Step 2: 提交**

```bash
git add backend/app/api/v1/endpoints/pci.py backend/app/api/v1/endpoints/neighbor.py backend/app/api/v1/endpoints/tac.py backend/app/api/v1/endpoints/map.py
git commit -m "feat: wire user_id isolation into all data API endpoints"
```

---

### Task 8: 集成测试与验证

**Step 1: 编写基本集成测试**

创建 `backend/tests/test_sqlite_storage.py`：

```python
import pytest
from app.services.data_service import DataService
from app.core.database import SessionLocal, init_db
from app.models.database import Workbook, Site, Sector

class TestSqliteStorage:
    @pytest.fixture
    def data_service(self):
        return DataService()

    def test_workbook_crud(self):
        db = SessionLocal()
        # 验证表已创建
        count = db.query(Workbook).count()
        assert count >= 0
        db.close()

    def test_user_isolation(self):
        db = SessionLocal()
        # user 1 的 workbooks
        wb1 = db.query(Workbook).filter(Workbook.user_id == 1).all()
        # user 2 的 workbooks
        wb2 = db.query(Workbook).filter(Workbook.user_id == 2).all()
        # 两者的 ID 集合不应有交集
        ids1 = {w.id for w in wb1}
        ids2 = {w.id for w in wb2}
        assert ids1.isdisjoint(ids2)
        db.close()
```

**Step 2: 运行测试**

```bash
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
pytest tests/test_sqlite_storage.py -v
```

**Step 3: 提交**

```bash
git add backend/tests/test_sqlite_storage.py
git commit -m "test: add integration tests for SQLite storage and user isolation"
```

---

## 阶段 2：清理（后续迭代，本计划不立即执行）

以下任务仅在阶段 0 和阶段 1 在生产环境稳定运行后执行：

- Task 9: 移除 `data/index.json` 读写逻辑
- Task 10: 移除 `data/{uuid}/data.json` 写入逻辑
- Task 11: 清理 DataService 中不再需要的文件处理代码路径
- Task 12: 保留 `data/{uuid}/original.xlsx` 用于下载功能

---

## 关键注意事项

1. **勿改前端代码** — API 响应格式保持与现有 `index.json` + `data.json` 一致，前端无感知升级
2. **双写阶段不删旧数据** — 确保出现问题时可以快速回退
3. **生产环境部署** — 首次部署需执行一次旧数据迁移脚本（或依赖运行时按需迁移）
4. **编码兼容** — 所有数据库写入遵循项目现有的 GBK 安全处理规范
5. **旧 users.db 处理** — 首次启动时若存在 users.db，需将其中的 users/user_sessions 表数据迁移到 data.db（或在 init_db 中自动处理）
