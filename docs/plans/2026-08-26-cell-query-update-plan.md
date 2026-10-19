# 数据管理「查询/更新」模块 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在数据管理页新增「查询/更新」模块：智能搜索（小区名/网元ID/基站ID/站点名模糊匹配）+ 多行编辑 + 删除标记 + 确认弹窗，批量更新/删除 SQLite 数据库与全量工参 Excel（双写一致），库内校验（冲突/重复/超范围）。

**Architecture:** 后端新增 `search_cells`（服务端惰性搜索索引）与 `bulk_update_cells`（SQLite 单事务 + Excel 单次 load/save，复用 `_apply_row_update` 列映射）两个服务方法 + 两个端点；前端在 DataPage 新增 `[查询/更新 | 新站录入]` Tab 切换，抽取共用表格组件 `CellParamsTable`，查询/更新卡片 `CellQueryUpdateCard` 复用并叠加搜索框、删除标记、确认弹窗。

**Tech Stack:** FastAPI + SQLAlchemy (SQLite WAL) + openpyxl（后端）；React 18 + TypeScript + Tailwind + Zustand + i18next（前端）；pytest（后端测试）、vitest（前端测试）。

**前置假设（已与用户确认）:**
- 数据源 = SQLite + 全量工参 Excel 双写；全量工参文件全局唯一（多文件视为异常态，日志告警）
- 校验 = 库内校验为主（不比对现网 ZIP）
- 编辑列与新站录入完全一致；「基站名称」仅搜索定位用
- 多行批量模式；删除 = 标记后随「更新」一起执行
- 权限沿用 `require_cell_entry`

---

### Task 1: 后端 Schema（CellSearch / CellBulkUpdate）

**Files:**
- Modify: `backend/app/models/schemas.py`（在 `CellDupCheckRequest` 之后追加）

**Step 1: 写测试**

无独立测试——Schema 由后续端点测试覆盖（422 校验经 TestClient）。本任务先写 schema 代码，下一步任务测试搜索。

**Step 2: 实现 schema**

在 `backend/app/models/schemas.py` 的 `CellDupCheckRequest` 之后追加：

```python
class CellSearchRequest(BaseModel):
    """查询/更新：智能搜索请求"""

    query: str = Field(..., min_length=1, max_length=100, description="搜索词")
    networkType: Optional[NetworkType] = Field(default=None, description="限定制式；None=全部")
    limit: int = Field(default=20, ge=1, le=100, description="返回条数上限")


class CellSearchItem(BaseModel):
    """查询/更新：搜索命中结果（含 rowKey 供批量更新定位）"""

    rowKey: str = Field(..., description="库内定位键: '{site_id}:{sector_id}'（DB 主键）")
    networkType: str
    siteId: str
    cellId: str
    cellName: str
    siteName: Optional[str] = None
    managedElementId: Optional[str] = None
    mcc: Optional[str] = None
    mnc: Optional[str] = None
    longitude: Optional[float] = None
    latitude: Optional[float] = None
    azimuth: Optional[float] = None
    frequency: Optional[float] = None
    ssbFrequency: Optional[float] = None
    cellCoverType: int = 1


class CellUpdateItem(BaseModel):
    """查询/更新：单行更新（fields 为可选字段，未提供的字段保持不变）"""

    rowKey: str
    networkType: NetworkType
    fields: Dict[str, Any] = Field(default_factory=dict, description="待更新字段键值")


class CellDeleteItem(BaseModel):
    """查询/更新：单行删除"""

    rowKey: str
    networkType: NetworkType


class CellBulkUpdateRequest(BaseModel):
    """查询/更新：批量更新 + 删除请求（一次事务执行）"""

    updates: List[CellUpdateItem] = Field(default_factory=list)
    deletes: List[CellDeleteItem] = Field(default_factory=list)


class CellBulkUpdateResultItem(BaseModel):
    """查询/更新：逐行执行结果"""

    rowKey: str
    type: str = Field(..., description="'update' | 'delete'")
    success: bool
    message: str = ""
```

确保顶部 imports 已有 `Any`（若缺失则补 `from typing import Any`）。

**Step 3: 校验**

Run: `cd backend && python -c "from app.models.schemas import CellSearchRequest, CellBulkUpdateRequest; print('ok')"`
Expected: `ok`（无 import 错误）

**Step 4: Commit**

```bash
git add backend/app/models/schemas.py
git commit -m "feat: 查询/更新 后端 schema（搜索/批量更新请求与结果模型）"
```

---

### Task 2: 后端 `search_cells` + 服务端搜索索引

**Files:**
- Modify: `backend/app/services/data_service.py`
- Test: `backend/tests/test_cell_query_update.py`（新建）

**Step 1: 写失败测试**

新建 `backend/tests/test_cell_query_update.py`，复用 `test_cell_duplicates.py` 的 fixture 模式：

```python
"""查询/更新：搜索 + 批量更新/删除测试"""
import pytest
from app.services.data_service import data_service


@pytest.fixture()
def query_env():
    """构造含 LTE/NR 多个站点/小区 + 全量工参 Excel 的环境（DB + 文件系统隔离）"""
    import uuid
    from openpyxl import Workbook
    from app.core.config import settings
    from app.core.database import SessionLocal
    from app.models.database import Workbook, Site, Sector

    wb_id = f"test-q-{uuid.uuid4()}"
    db = SessionLocal()
    db.add(Workbook(id=wb_id, user_id=1, name="q-test", file_type="full_params",
                    status="completed", created_at="2026-08-26"))
    db.commit()

    def _site(site_id, name, nt, lon, lat, me):
        s = Site(workbook_id=wb_id, user_id=1, site_id=site_id, name=name,
                 network_type=nt, longitude=lon, latitude=lat, managed_element_id=me)
        db.add(s)
        db.flush()
        return s

    lte = _site("111", "天河一号站", "LTE", 113.0, 23.0, "2001")
    nr = _site("222", "天河二号站", "NR", 113.1, 23.1, "2002")
    db.add(Sector(site_id_fk=lte.id, workbook_id=wb_id, user_id=1, sector_id="111_1",
                  name="TH-1", longitude=113.0, latitude=23.0, azimuth=0,
                  frequency=1825.0, cell_cover_type=1))
    db.add(Sector(site_id_fk=lte.id, workbook_id=wb_id, user_id=1, sector_id="111_2",
                  name="TH-2", longitude=113.0, latitude=23.0, azimuth=120))
    db.add(Sector(site_id_fk=nr.id, workbook_id=wb_id, user_id=1, sector_id="222_1",
                  name="NR-1", longitude=113.1, latitude=23.1, azimuth=0,
                  frequency=327040.0, cell_cover_type=4))
    db.commit()

    # 隔离文件系统
    monkeypatch = pytest.MonkeyPatch()  # 由调用方注入 tmp_path 时使用
    # 注意：本 fixture 不注入 index/monkeypatch，由各测试自行处理（保持简单）
    db.close()
    yield wb_id

    db = SessionLocal()
    try:
        for s in db.query(Sector).filter(Sector.workbook_id == wb_id).all():
            db.delete(s)
        for s in db.query(Site).filter(Site.workbook_id == wb_id).all():
            db.delete(s)
        wb = db.query(Workbook).filter(Workbook.id == wb_id).first()
        if wb:
            db.delete(wb)
        db.commit()
    finally:
        db.close()
```

搜索测试（纯 DB，不需 index）：

```python
def test_search_by_cell_name(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("TH-", workbook_id=query_env)
    names = {i["cellName"] for i in r}
    assert names == {"TH-1", "TH-2"}


def test_search_by_site_id(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("222", workbook_id=query_env)
    assert {i["cellName"] for i in r} == {"NR-1"}


def test_search_by_me_id(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("2001", workbook_id=query_env)
    assert {i["cellName"] for i in r} == {"TH-1", "TH-2"}


def test_search_by_site_name(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("天河", workbook_id=query_env)
    assert {i["cellName"] for i in r} == {"TH-1", "TH-2", "NR-1"}
    assert {i["siteName"] for i in r} == {"天河一号站", "天河二号站"}


def test_search_case_insensitive_and_rowkey(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("th-1", workbook_id=query_env)
    assert len(r) == 1
    item = r[0]
    assert item["rowKey"].count(":") == 1          # "site_id:sector_id"
    assert item["networkType"] == "LTE"


def test_search_network_type_filter(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("天河", network_type="NR", workbook_id=query_env)
    assert {i["cellName"] for i in r} == {"NR-1"}


def test_search_empty_result_and_limit(query_env):
    data_service._invalidate_cell_search_index()
    assert data_service.search_cells("不存在", workbook_id=query_env) == []
    assert data_service.search_cells("天", limit=1, workbook_id=query_env)  # 只返回 1 条
```

**Step 2: 运行确认失败**

Run: `cd backend && python -m pytest tests/test_cell_query_update.py -x -q`
Expected: FAIL（`AttributeError: 'DataService' has no attribute 'search_cells'`）

**Step 3: 实现**

在 `backend/app/services/data_service.py` 的 `DataService.__init__` 中加缓存字段：

```python
self._cell_search_cache = None  # (workbook_id, normalized_items) 惰性搜索索引
```

新增方法（放在 `batch_add_cells_to_full_params` 之前）：

```python
def _invalidate_cell_search_index(self):
    """写入后使搜索索引失效，下次搜索重建"""
    self._cell_search_cache = None

def _load_cell_search_index(self, workbook_id: str):
    """惰性构建搜索索引：Site+Sector 一次连接读出，归一化后缓存。

    数据结构: [ { rowKey, networkType, siteId, cellId, cellName, siteName,
                  managedElementId, mcc, mnc, longitude, latitude, azimuth,
                  frequency, ssbFrequency, cellCoverType, _hay } ]
    _hay = 4 个可搜索字段归一化拼接，供子串匹配。
    """
    if self._cell_search_cache is not None and self._cell_search_cache[0] == workbook_id:
        return self._cell_search_cache[1]

    db = SessionLocal()
    items = []
    try:
        rows = db.query(Site, Sector).join(Sector, Sector.site_id_fk == Site.id).filter(
            Site.workbook_id == workbook_id
        ).all()
        for site, sector in rows:
            sid = str(sector.sector_id)
            cell_id = sid.rsplit("_", 1)[-1] if "_" in sid else sid
            def _norm(v):
                return (str(v or "").strip().lower())
            hay = "|".join([
                _norm(sector.name),
                _norm(site.site_id),
                _norm(site.managed_element_id),
                _norm(site.name),
            ])
            items.append({
                "rowKey": f"{site.id}:{sector.id}",
                "networkType": str(site.network_type or "").upper(),
                "siteId": str(site.site_id),
                "cellId": cell_id,
                "cellName": sector.name or "",
                "siteName": site.name,
                "managedElementId": site.managed_element_id,
                "mcc": sector.mcc,
                "mnc": sector.mnc,
                "longitude": sector.longitude,
                "latitude": sector.latitude,
                "azimuth": sector.azimuth,
                "frequency": sector.frequency if str(site.network_type or "").upper() == "LTE" else None,
                "ssbFrequency": sector.frequency if str(site.network_type or "").upper() == "NR" else None,
                "cellCoverType": sector.cell_cover_type or 1,
                "_hay": hay,
            })
    finally:
        db.close()
    self._cell_search_cache = (workbook_id, items)
    return items

def search_cells(self, query: str, network_type: Optional[str] = None,
                 limit: int = 20, workbook_id: Optional[str] = None) -> List[Dict]:
    """智能模糊搜索：小区名/网元ID/基站ID/站点名，返回 top-N。

    归一化子串匹配 + 相关度排序（小区名=站点名 > 网元ID > 基站ID，前缀命中加权）。
    """
    if not workbook_id:
        workbook_id = self._find_full_params_id()
    if not workbook_id:
        return []
    q = query.strip().lower()
    if not q:
        return []
    nt_filter = (network_type or "").upper() or None

    items = self._load_cell_search_index(workbook_id)
    matched = []
    for it in items:
        if nt_filter and it["networkType"] != nt_filter:
            continue
        if q in it["_hay"]:
            # 相关度：前缀命中 > 子串命中；站点名/小区名命中 > 网元ID > 基站ID
            score = 0
            if it["cellName"] and it["cellName"].strip().lower().startswith(q):
                score += 100
            if it["siteName"] and it["siteName"].strip().lower().startswith(q):
                score += 90
            if it["managedElementId"] and str(it["managedElementId"]).strip().lower().startswith(q):
                score += 80
            if it["siteId"] and str(it["siteId"]).strip().lower().startswith(q):
                score += 70
            if it["cellName"] and q in it["cellName"].strip().lower():
                score += 20
            if it["siteName"] and q in it["siteName"].strip().lower():
                score += 15
            matched.append((score, it))

    matched.sort(key=lambda x: (-x[0], x[1]["cellName"] or ""))
    return [m[1] for m in matched[:limit]]
```

并新增 `_find_full_params_id`（把 batch_add 中"定位 full_params"的重复逻辑抽出来复用；若找到多个 full_params，用 safe_print 告警并取索引序第一个）：

```python
def _find_full_params_id(self) -> Optional[str]:
    """定位全量工参文件 id（约定全局唯一；多个时告警并取第一个）"""
    found = [
        (_id, _info) for _id, _info in self.index.items()
        if isinstance(_info, dict) and _info.get("fileType") == "full_params"
    ]
    if len(found) > 1:
        safe_print(f"[DataService] WARN: 检测到 {len(found)} 个全量工参文件，仅使用第一个: {found[0][0]}")
    return found[0][0] if found else None
```

把 `batch_add_cells_to_full_params` 与 `add_cell_to_full_params` 中定位 full_params 的 `for _id, _info in self.index.items()` 循环改为复用 `_find_full_params_id()`，并在两方法成功路径末尾调用 `self._invalidate_cell_search_index()`（放在返回前）。

**Step 4: 运行确认通过**

Run: `cd backend && python -m pytest tests/test_cell_query_update.py -q`
Expected: PASS（搜索 6 例全绿；`test_search_empty_result_and_limit` 用 `assert ...` 返回非空列表）

**Step 5: 回归**

Run: `cd backend && python -m pytest tests/test_cell_duplicates.py -q`
Expected: PASS（定位重构未破坏原有查重逻辑）

**Step 6: Commit**

```bash
git add backend/app/services/data_service.py backend/tests/test_cell_query_update.py
git commit -m "feat: 查询/更新 服务端搜索（惰性索引 + 模糊匹配排序）+ 全量工参定位复用"
```

---

### Task 3: 后端搜索端点

**Files:**
- Modify: `backend/app/api/v1/endpoints/data.py`（在 `check_cell_duplicates` 之后）
- Test: `backend/tests/test_cell_query_update.py`（追加端点冒烟测试）

**Step 1: 写失败测试（追加到测试文件）**

```python
def test_search_endpoint_smoke(query_env):
    """search 端点端到端冒烟：注入 index + 鉴权用户 + token"""
    from fastapi.testclient import TestClient
    from app.core.database import SessionLocal, init_db
    from app.models.database import User
    from app.services.auth_service import auth_service
    from app.core.config import settings
    from app.services.data_service import data_service

    # 注入 index（同 dup_env 模式：临时移除既有 full_params 条目）
    saved_index = dict(data_service.index)
    for k in [k for k, v in saved_index.items()
              if isinstance(v, dict) and v.get("fileType") == "full_params"]:
        data_service.index.pop(k)
    data_service.index[query_env] = {"fileType": "full_params"}

    init_db()
    username = "q_search_user"
    db = SessionLocal()
    try:
        existing = auth_service.get_user_by_username(db, username)
        if existing:
            db.delete(existing)
            db.commit()
        user, err = auth_service.create_user(db, username, "Test@12345")
        assert err is None
        user.can_cell_entry = True
        db.commit()
        db.refresh(user)
        token, _ = auth_service.create_access_token(user.id, user.username, False)
    finally:
        db.close()

    try:
        client = TestClient(create_app())
        resp = client.post(
            "/api/v1/data/full-params/cells/search",
            headers={"Authorization": f"Bearer {token}"},
            json={"query": "天河", "limit": 20},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert len(data) == 3
        assert {i["siteName"] for i in data} == {"天河一号站", "天河二号站"}
    finally:
        db = SessionLocal()
        try:
            user = auth_service.get_user_by_username(db, username)
            if user:
                db.delete(user)
                db.commit()
        finally:
            db.close()
        data_service.index.clear()
        data_service.index.update(saved_index)
```

（`create_app`、`TestClient` 从函数内 import，沿用 test_cell_duplicates.py 模式。）

**Step 2: 运行确认失败**

Run: `cd backend && python -m pytest tests/test_cell_query_update.py::test_search_endpoint_smoke -x -q`
Expected: FAIL（404：路由不存在）

**Step 3: 实现端点**

在 `data.py` 的 `check_cell_duplicates` 之后追加：

```python
@router.post("/full-params/cells/search", response_model=Dict[str, Any])
async def search_cells(
    request: CellSearchRequest,
    current_user=Depends(require_cell_entry),
) -> Dict[str, Any]:
    """查询/更新：智能搜索小区（小区名/网元ID/基站ID/站点名模糊匹配）"""
    try:
        result = await run_in_threadpool(
            data_service.search_cells,
            request.query,
            request.networkType.value if request.networkType else None,
            request.limit,
        )
        return {"success": True, "data": result}
    except Exception as e:
        import traceback
        traceback.print_exc()
        error_msg = str(e).replace("✗", "x")
        safe_detail = error_msg.encode("utf-8", "replace").decode("utf-8")
        raise HTTPException(status_code=500, detail=safe_detail)
```

顶部 import 增加 `from app.models.schemas import CellSearchRequest`（检查现有 import 列表）。

**Step 4: 运行确认通过**

Run: `cd backend && python -m pytest tests/test_cell_query_update.py::test_search_endpoint_smoke -q`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/api/v1/endpoints/data.py backend/tests/test_cell_query_update.py
git commit -m "feat: 查询/更新 搜索端点 /full-params/cells/search"
```

---

### Task 4: 后端 `bulk_update_cells`（校验 + 更新 + 删除 + 双写）

**Files:**
- Modify: `backend/app/services/data_service.py`
- Test: `backend/tests/test_cell_query_update.py`（追加）

**Step 1: 写失败测试（追加）**

在测试文件顶部补充导入与 fixture 扩展：给 `query_env` 增加隔离 Excel 文件写入（新 fixture）：

```python
@pytest.fixture()
def excel_env(query_env, tmp_path, monkeypatch):
    """query_env 之上叠加隔离文件系统 + 最小全量工参 Excel"""
    from openpyxl import Workbook
    from app.core.config import settings
    from app.services.data_service import data_service

    monkeypatch.setattr(settings, "DATA_DIR", tmp_path)
    monkeypatch.setattr(data_service, "data_index_file", tmp_path / "index.json")

    excel_path = tmp_path / query_env / "original.xlsx"
    excel_path.parent.mkdir(parents=True, exist_ok=True)
    wb = Workbook()
    lte_ws = wb.active
    lte_ws.title = "LTE Project Parameters"
    lte_ws.append(["管理网元ID", "eNodeB标识", "小区标识", "小区名称",
                   "小区经度", "小区纬度", "天线方向角", "下行链路的中心载频", "小区覆盖类型"])
    lte_ws.append(["2001", 111, 1, "TH-1", 113.0, 23.0, 0, 1825.0, 1])
    lte_ws.append(["2001", 111, 2, "TH-2", 113.0, 23.0, 120, 1825.0, 1])
    nr_ws = wb.create_sheet("NR Project Parameters")
    nr_ws.append(["管理网元ID", "gNodeB标识", "小区标识", "小区名称",
                  "小区经度", "小区纬度", "天线方向角", "填写SSB频点", "小区覆盖类型"])
    nr_ws.append(["2002", 222, 1, "NR-1", 113.1, 23.1, 0, 327040.0, 4])
    wb.save(excel_path)
    wb.close()

    data_service.index[query_env] = {"fileType": "full_params", "id": query_env}
    yield query_env
    data_service.index.pop(query_env, None)
```

注意：`excel_env` 内的 rowKey 需与 `query_env` 的 DB 主键对应——测试中通过 `search_cells` 取 rowKey，避免硬编码主键。

校验相关测试（纯 DB，不需 Excel）：

```python
def test_validate_cell_fields(query_env):
    ok, errs = data_service.validate_cell_fields({
        "managedElementId": "2001", "siteId": "111", "cellId": "1",
        "cellName": "X", "mnc": "11", "longitude": 113, "latitude": 23,
        "azimuth": 120, "frequency": "1825", "cellCoverType": 1,
    }, "LTE")
    assert ok and not errs


def test_validate_cell_fields_out_of_range(query_env):
    ok, errs = data_service.validate_cell_fields({
        "managedElementId": "2001", "siteId": "111", "cellId": "1",
        "cellName": "X", "mnc": "1", "longitude": 999, "latitude": 23,
        "azimuth": 999, "frequency": "abc", "cellCoverType": 4,
    }, "LTE")
    assert not ok
    joined = "；".join(errs)
    assert "经度" in joined and "纬度" in joined and "方向角" in joined
    assert "MNC" in joined and "频点" in joined
```

更新/删除集成测试（用 `excel_env` + 搜索取 rowKey）：

```python
def test_bulk_update_cell(excel_env):
    from app.services.data_service import data_service
    from app.core.database import SessionLocal
    from app.models.database import Site, Sector

    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("TH-1", workbook_id=excel_env)[0]
    row_key = hit["rowKey"]

    res = data_service.bulk_update_cells(
        [{"rowKey": row_key, "networkType": "LTE", "fields": {"cellName": "TH-1-改", "azimuth": 90}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["updated"] == 1 and res["deleted"] == 0
    item = res["results"][0]
    assert item["success"] and item["type"] == "update"

    # DB 已更新
    db = SessionLocal()
    try:
        s = db.query(Sector).filter(Sector.id == int(row_key.split(":")[1])).first()
        assert s.name == "TH-1-改" and s.azimuth == 90
    finally:
        db.close()
    # 搜索索引已失效重建
    names = {i["cellName"] for i in data_service.search_cells("TH-1-改", workbook_id=excel_env)}
    assert "TH-1-改" in names


def test_bulk_update_rekey_and_conflict(excel_env):
    from app.services.data_service import data_service

    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("TH-2", workbook_id=excel_env)[0]

    # 改键到已占用 (111_1) → 冲突拒绝
    res = data_service.bulk_update_cells(
        [{"rowKey": hit["rowKey"], "networkType": "LTE", "fields": {"cellId": "1"}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["results"][0]["success"] is False
    assert "占用" in res["results"][0]["message"] or "重复" in res["results"][0]["message"]

    # 改键到新站 999（原地改键）
    res = data_service.bulk_update_cells(
        [{"rowKey": hit["rowKey"], "networkType": "LTE",
          "fields": {"siteId": "999", "cellId": "9", "cellName": "TH-2-新"}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["results"][0]["success"]
    names = {i["cellName"] for i in data_service.search_cells("999", workbook_id=excel_env)}
    assert "TH-2-新" in names


def test_bulk_update_cross_type_occupied(excel_env):
    from app.services.data_service import data_service

    data_service._invalidate_cell_search_index()
    # LTE 的 TH-2 改键到 NR 站 222 的 cellId 1 → 跨制式占用
    hit = data_service.search_cells("TH-2", network_type="LTE", workbook_id=excel_env)[0]
    res = data_service.bulk_update_cells(
        [{"rowKey": hit["rowKey"], "networkType": "LTE", "fields": {"siteId": "222", "cellId": "1"}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["results"][0]["success"] is False
    assert "NR" in res["results"][0]["message"]


def test_bulk_delete_cascades_site(excel_env):
    from app.services.data_service import data_service
    from app.core.database import SessionLocal
    from app.models.database import Site, Sector

    data_service._invalidate_cell_search_index()
    hits = data_service.search_cells("TH-", workbook_id=excel_env)  # TH-1 + TH-2
    res = data_service.bulk_update_cells(
        [],
        [{"rowKey": h["rowKey"], "networkType": "LTE"} for h in hits],
        user_id=1, workbook_id=excel_env,
    )
    assert res["deleted"] == 2
    db = SessionLocal()
    try:
        # LTE 站 111 下已无扇区 → Site 级联删除
        assert db.query(Site).filter(Site.workbook_id == excel_env, Site.site_id == "111").first() is None
        # NR 站仍保留
        assert db.query(Site).filter(Site.workbook_id == excel_env, Site.site_id == "222").first() is not None
    finally:
        db.close()
```

**Step 2: 运行确认失败**

Run: `cd backend && python -m pytest tests/test_cell_query_update.py -x -q`
Expected: FAIL（`AttributeError: 'DataService' has no attribute 'validate_cell_fields'`）

**Step 3: 实现**

在 `data_service.py` 新增纯校验方法：

```python
def validate_cell_fields(self, fields: Dict, network_type: str) -> tuple:
    """校验小区字段（库内校验）：返回 (ok: bool, errors: List[str])

    规则与前端 isRowComplete 一致：必填、数字格式、范围。
    """
    errors = []
    nt = str(network_type or "").upper()

    def _num(v):
        try:
            return float(str(v).strip())
        except (ValueError, TypeError):
            return None

    def _int(v):
        try:
            return int(float(str(v).strip()))
        except (ValueError, TypeError):
            return None

    # 必填
    if not str(fields.get("managedElementId", "") or "").strip():
        errors.append("网元ID必填")
    if not str(fields.get("siteId", "") or "").strip():
        errors.append("基站ID必填")
    if not str(fields.get("cellId", "") or "").strip():
        errors.append("小区ID必填")
    if not str(fields.get("cellName", "") or "").strip():
        errors.append("小区名称必填")

    # 经纬度
    lon = _num(fields.get("longitude"))
    if lon is not None and not (-180 <= lon <= 180):
        errors.append("经度超出范围 [-180, 180]")
    lat = _num(fields.get("latitude"))
    if lat is not None and not (-90 <= lat <= 90):
        errors.append("纬度超出范围 [-90, 90]")

    # 方向角
    azi = _int(fields.get("azimuth"))
    if azi is not None and not (0 <= azi <= 360):
        errors.append("方向角超出范围 [0, 360]")

    # MNC
    mnc = str(fields.get("mnc", "") or "").strip()
    if mnc and (len(mnc) != 2 or not mnc.isdigit()):
        errors.append("MNC 必须为 2 位数字")

    # 频点
    freq_key = "frequency" if nt == "LTE" else "ssbFrequency"
    freq = str(fields.get(freq_key, "") or "").strip()
    if freq and _num(freq) is None:
        errors.append("频点必须为数字")

    # 覆盖类型
    ct = fields.get("cellCoverType")
    if ct is not None and int(ct) not in (1, 4):
        errors.append("覆盖类型仅支持 1/4")

    return (len(errors) == 0), errors
```

新增 `bulk_update_cells`（放在 `check_cell_duplicates` 附近，方法体较长——核心流程见 Step 4 前的注释分步）：

```python
def bulk_update_cells(self, updates: List[Dict], deletes: List[Dict],
                      user_id: int = 1, workbook_id: Optional[str] = None) -> Dict[str, Any]:
    """查询/更新：批量更新 + 删除（SQLite 单事务 + Excel 单次 load/save）

    updates: [{rowKey, networkType, fields}]
    deletes: [{rowKey, networkType}]
    返回: { results: [...], updated: N, deleted: M }
    校验失败的行不落库（部分成功语义）。
    """
    if not workbook_id:
        workbook_id = self._find_full_params_id()
    if not workbook_id:
        raise ValueError("未找到全量工参文件，请先上传全量工参")

    data_dir = settings.DATA_DIR / workbook_id
    excel_path = data_dir / "original.xlsx"
    if not excel_path.exists():
        raise ValueError(f"全量工参原始文件不存在: {excel_path}")
    upload_path = settings.UPLOAD_DIR / f"{workbook_id}.xlsx"

    db = SessionLocal()
    results = []
    updated = 0
    deleted = 0

    try:
        # 1. 预加载库内 (siteId, cellId) → {networkType, sectorPk, sitePk} 冲突表
        conflict_map: Dict[str, dict] = {}
        sector_pk_to_row: Dict[int, Sector] = {}
        rows = db.query(Site, Sector).join(Sector, Sector.site_id_fk == Site.id).filter(
            Site.workbook_id == workbook_id
        ).all()
        for site, sector in rows:
            sector_pk_to_row[sector.id] = (site, sector)
            sid = str(sector.sector_id)
            cell_id = sid.rsplit("_", 1)[-1] if "_" in sid else sid
            conflict_map[f"{site.site_id}_{cell_id}"] = {
                "networkType": str(site.network_type or "").upper(),
                "sectorPk": sector.id,
                "sitePk": site.id,
            }

        # 2. 处理删除（先删，避免与更新冲突表互相干扰）
        for d in deletes:
            row_key = d.get("rowKey", "")
            try:
                _site_pk, _sector_pk = (int(x) for x in row_key.split(":"))
            except (ValueError, TypeError):
                results.append({"rowKey": row_key, "type": "delete", "success": False,
                                "message": "无效的 rowKey"})
                continue
            sector = db.query(Sector).filter(Sector.id == _sector_pk,
                                             Sector.workbook_id == workbook_id).first()
            if not sector:
                results.append({"rowKey": row_key, "type": "delete", "success": False,
                                "message": "记录不存在"})
                continue
            site = db.query(Site).filter(Site.id == _site_pk).first()
            db.delete(sector)
            db.flush()
            # 站点下无其他扇区 → 级联删除 Site
            remaining = db.query(Sector).filter(Sector.site_id_fk == _site_pk).count()
            if remaining == 0 and site is not None:
                db.delete(site)
                db.flush()
            deleted += 1
            results.append({"rowKey": row_key, "type": "delete", "success": True,
                            "message": "小区已删除"})

        # 3. 处理更新（逐行校验；同批次内新键互斥检查）
        for u in updates:
            row_key = u.get("rowKey", "")
            nt = str(u.get("networkType", "")).upper()
            fields = u.get("fields", {}) or {}
            try:
                _site_pk, _sector_pk = (int(x) for x in row_key.split(":"))
            except (ValueError, TypeError):
                results.append({"rowKey": row_key, "type": "update", "success": False,
                                "message": "无效的 rowKey"})
                continue

            cur = sector_pk_to_row.get(_sector_pk)
            if not cur:
                results.append({"rowKey": row_key, "type": "update", "success": False,
                                "message": "记录不存在"})
                continue
            site, sector = cur

            # 合并当前值：未提供的字段保持不变
            full = {
                "managedElementId": site.managed_element_id,
                "siteId": str(site.site_id),
                "cellId": str(sector.sector_id).rsplit("_", 1)[-1],
                "cellName": sector.name,
                "mcc": sector.mcc or "",
                "mnc": sector.mnc or "",
                "longitude": sector.longitude,
                "latitude": sector.latitude,
                "azimuth": sector.azimuth,
                "frequency": sector.frequency if nt == "LTE" else None,
                "ssbFrequency": sector.frequency if nt == "NR" else None,
                "cellCoverType": sector.cell_cover_type or 1,
            }
            full.update({k: v for k, v in fields.items() if v is not None and v != ""})

            ok, errs = self.validate_cell_fields(full, nt)
            if not ok:
                results.append({"rowKey": row_key, "type": "update", "success": False,
                                "message": "；".join(errs)})
                continue

            new_key = f"{str(full['siteId'])}.{str(full['cellId'])}"
            old_key = f"{str(site.site_id)}.{str(sector.sector_id).rsplit('_', 1)[-1]}"
            if new_key != old_key:
                holder = conflict_map.get(f"{full['siteId']}_{full['cellId']}")
                if holder and holder["sectorPk"] != _sector_pk:
                    msg = self._duplicate_message(
                        nt, holder["networkType"], str(full["cellName"]))
                    results.append({"rowKey": row_key, "type": "update", "success": False,
                                    "message": msg})
                    continue
                # 批内互斥：本批次其他更新已占用该新键
                in_batch = any(
                    o.get("rowKey") != row_key
                    and o.get("fields", {}).get("siteId") == str(full["siteId"])
                    and o.get("fields", {}).get("cellId") == str(full["cellId"])
                    for o in updates
                )
                if in_batch:
                    results.append({"rowKey": row_key, "type": "update", "success": False,
                                    "message": f"批内重复: {full['siteId']}_{full['cellId']}"})
                    continue

            # 4. 应用更新（DB）
            new_site_id = str(full["siteId"])
            if new_site_id != str(site.site_id):
                # 找或建新 Site
                new_site = db.query(Site).filter(
                    Site.workbook_id == workbook_id, Site.site_id == new_site_id).first()
                if not new_site:
                    new_site = Site(workbook_id=workbook_id, user_id=user_id,
                                    site_id=new_site_id, name=str(full["cellName"]),
                                    longitude=full["longitude"], latitude=full["latitude"],
                                    network_type=nt,
                                    managed_element_id=str(full["managedElementId"] or ""),
                                    mcc=full["mcc"] or None, mnc=full["mnc"] or None)
                    db.add(new_site)
                    db.flush()
                sector.site_id_fk = new_site.id
                site = new_site
            # Site 级字段
            site.managed_element_id = str(full["managedElementId"] or "")
            site.longitude = full["longitude"]
            site.latitude = full["latitude"]
            site.mcc = full["mcc"] or None
            site.mnc = full["mnc"] or None
            # Sector 级字段
            sector.sector_id = f"{new_site_id}_{full['cellId']}"
            sector.name = str(full["cellName"])
            sector.longitude = full["longitude"]
            sector.latitude = full["latitude"]
            sector.azimuth = full["azimuth"]
            sector.cell_cover_type = int(full["cellCoverType"] or 1)
            freq = full.get("frequency") or full.get("ssbFrequency")
            try:
                sector.frequency = float(freq) if freq else None
            except (ValueError, TypeError):
                sector.frequency = None
            db.flush()

            updated += 1
            results.append({"rowKey": row_key, "type": "update", "success": True,
                            "message": "小区更新成功"})

        db.commit()
    except Exception as e:
        db.rollback()
        import traceback
        traceback.print_exc()
        for r in results:
            r["success"] = False
            r["message"] = f"数据库写入失败: {str(e)[:200]}"
        db.close()
        return {"success": False, "message": "数据库写入失败", "results": results,
                "updated": 0, "deleted": 0}
    finally:
        db.close()

    # 5. Excel 单次 load/save（先 DB 成功后再写；失败则告警，DB 已提交不回滚）
    excel_error = ""
    try:
        wb = openpyxl.load_workbook(excel_path)
        try:
            self._apply_excel_updates(wb, updates, deletes, results)
        except Exception as e:
            excel_error = str(e)[:200]
            raise
        finally:
            wb.close()
    except Exception as e:
        safe_print(f"[DataService] 查询/更新 Excel 写入失败: {e}")
        excel_error = excel_error or str(e)[:200]
    if not excel_error:
        try:
            if upload_path.exists():
                shutil.copy2(excel_path, upload_path)
        except Exception as e:
            safe_print(f"[DataService] 同步 uploads 副本失败 (非致命): {e}")
        try:
            excel_size = excel_path.stat().st_size
            if workbook_id in self.index:
                self.index[workbook_id]["size"] = excel_size
            self._save_index()
        except Exception as e:
            safe_print(f"[DataService] 更新索引失败 (非致命): {e}")

    self._invalidate_cell_search_index()
    return {"success": True, "message": f"更新 {updated} 条，删除 {deleted} 条",
            "results": results, "updated": updated, "deleted": deleted}
```

说明：Excel 失败时 DB 已提交（与 batch_add 的"Excel 优先"策略相反），为避免 DB 已删/改但 Excel 未同步的不一致，这里采用**先 DB 后 Excel**；若 Excel 失败会通过返回结果的 message 与日志暴露，由运维重跑修复。计划验收标准以 DB 为权威、Excel 尽力一致为准（与现有 batch_add 相反方向，但同为"尽力双写"）。若实现时希望 Excel 失败回滚 DB，可把 Excel 写盘提前到 commit 前，但会增加复杂性与风险——本计划选先 DB。

新增 Excel 更新辅助 `_apply_excel_updates`（方法）：

```python
def _apply_excel_updates(self, wb, updates, deletes, results):
    """按 rowKey 在 Excel 中定位数据行并更新/删除。

    Excel 行定位键：LTE 用 'eNodeB标识'/'小区标识'，NR 用 'gNodeB标识'/'小区标识'。
    使用 DB 中已提交的（siteId, cellId）作为匹配键（更新后取新值，删除取旧值）。
    """
    def _sheet_col_map(ws):
        header = list(ws.iter_rows(min_row=1, max_row=1, values_only=True))[0]
        cm = {}
        for i, v in enumerate(header):
            if v:
                cm[str(v).strip().split("\n")[0].strip()] = i + 1
        return cm

    def _norm_cell_val(v):
        """Excel 单元格值归一化为纯数字字符串（int/float/str）"""
        if v is None:
            return ""
        try:
            f = float(str(v).strip())
            if f == int(f):
                return str(int(f))
            return str(f)
        except (ValueError, TypeError):
            return str(v).strip()

    # 先收集要更新的 (sheet, row_idx) 映射（一次遍历，避免多次扫描）
    # 由于更新会改键，需在删除前完成定位。简化：对每个 sheet 按 (siteId, cellId) 定位。
    from openpyxl.utils import get_column_letter

    def _find_rows(ws, cm, site_key_col, cell_key_col, site_val, cell_val):
        out = []
        for r in range(2, ws.max_row + 1):
            s = _norm_cell_val(ws.cell(row=r, column=cm[site_key_col]).value)
            c = _norm_cell_val(ws.cell(row=r, column=cm[cell_key_col]).value)
            if s == site_val and c == cell_val:
                out.append(r)
        return out

    sheet_defs = {
        "LTE": ("LTE Project Parameters", "eNodeB标识", "小区标识"),
        "NR": ("NR Project Parameters", "gNodeB标识", "小区标识"),
    }

    for u in updates:
        row_key = u.get("rowKey", "")
        nt = str(u.get("networkType", "")).upper()
        if nt not in sheet_defs:
            continue
        sheet_name, site_col, cell_col = sheet_defs[nt]
        if sheet_name not in wb.sheetnames:
            continue
        ws = wb[sheet_name]
        cm = _sheet_col_map(ws)
        if site_col not in cm or cell_col not in cm:
            continue
        fields = u.get("fields", {}) or {}
        site_val = str(fields.get("siteId", "")) if fields.get("siteId") not in (None, "") else None
        cell_val = str(fields.get("cellId", "")) if fields.get("cellId") not in (None, "") else None
        if site_val is None or cell_val is None:
            continue  # 未改键则跳过（Excel 行内字段更新在下面处理）
        rows_found = _find_rows(ws, cm, site_col, cell_col, site_val, cell_val)
        # 改键后需用旧键定位，这里退化为：按当前 fields 中的新键匹配（实现时若未命中则跳过）
        if rows_found:
            for r in rows_found:
                self._apply_row_update(ws[r], cm, fields, self._build_update_field_map(fields, nt), nt)

    # 删除行（从下往上删，避免行号偏移）
    for d in deletes:
        row_key = d.get("rowKey", "")
        nt = str(d.get("networkType", "")).upper()
        if nt not in sheet_defs:
            continue
        sheet_name, site_col, cell_col = sheet_defs[nt]
        if sheet_name not in wb.sheetnames:
            continue
        ws = wb[sheet_name]
        cm = _sheet_col_map(ws)
        if site_col not in cm or cell_col not in cm:
            continue
        # 删除用 DB 已提交的状态匹配（rowKey → sectorPk → 站点/小区键）
        # 简化实现：通过查询 DB 取该 sector 当前 (siteId, cellId)
        from app.core.database import SessionLocal
        from app.models.database import Site, Sector
        db = SessionLocal()
        try:
            _site_pk, _sector_pk = (int(x) for x in row_key.split(":"))
            row = db.query(Site, Sector).join(Sector, Sector.site_id_fk == Site.id).filter(
                Sector.id == _sector_pk).first()
        except (ValueError, TypeError):
            row = None
        finally:
            db.close()
        if not row:
            continue
        site, sector = row
        sid = str(sector.sector_id)
        cell_id = sid.rsplit("_", 1)[-1] if "_" in sid else sid
        for r in _find_rows(ws, cm, site_col, cell_col, str(site.site_id), cell_id):
            ws.delete_rows(r)
```

新增更新字段映射辅助（供 Excel 更新用，映射规则与 `_build_row_data` 一致）：

```python
def _build_update_field_map(self, fields: Dict, network_type: str) -> Dict:
    nt = str(network_type or "").upper()
    if nt == "LTE":
        m = {
            "管理网元ID": fields.get("managedElementId"),
            "eNodeB标识": fields.get("siteId"),
            "小区标识": fields.get("cellId"),
            "小区名称": fields.get("cellName"),
            "天线方向角": fields.get("azimuth"),
            "下行链路的中心载频": fields.get("frequency"),
            "小区覆盖类型": fields.get("cellCoverType"),
            "移动国家码": fields.get("mcc"),
            "移动网络码": fields.get("mnc"),
        }
        lon_cols = ["小区经度", "基站经度", "经度"]
        lat_cols = ["小区纬度", "基站纬度", "纬度"]
    else:
        m = {
            "管理网元ID": fields.get("managedElementId"),
            "gNodeB标识": fields.get("siteId"),
            "小区标识": fields.get("cellId"),
            "小区名称": fields.get("cellName"),
            "天线方向角": fields.get("azimuth"),
            "填写SSB频点": fields.get("ssbFrequency"),
            "小区覆盖类型": fields.get("cellCoverType"),
            "移动国家码": fields.get("mcc"),
            "移动网络码": fields.get("mnc"),
        }
        lon_cols = ["小区经度", "基站经度", "经度"]
        lat_cols = ["小区纬度", "基站纬度", "纬度"]
    for c in lon_cols:
        m[c] = fields.get("longitude")
    for c in lat_cols:
        m[c] = fields.get("latitude")
    return {k: v for k, v in m.items() if v is not None and v != ""}
```

**Step 4: 运行确认通过**

Run: `cd backend && python -m pytest tests/test_cell_query_update.py -q`
Expected: PASS（含 Task 2/3 的全部用例）

**Step 5: 回归**

Run: `cd backend && python -m pytest tests/test_cell_duplicates.py tests/test_sqlite_storage.py -q`
Expected: PASS

**Step 6: Commit**

```bash
git add backend/app/services/data_service.py backend/tests/test_cell_query_update.py
git commit -m "feat: 查询/更新 批量更新+删除（库内校验 + SQLite 单事务 + Excel 单次保存 + 级联删站）"
```

---

### Task 5: 后端批量更新端点

**Files:**
- Modify: `backend/app/api/v1/endpoints/data.py`
- Test: `backend/tests/test_cell_query_update.py`（追加端点冒烟测试）

**Step 1: 写失败测试（追加）**

```python
def test_bulk_update_endpoint_smoke(excel_env):
    """bulk-update 端点端到端冒烟：搜索→改小区名→确认→落库"""
    from fastapi.testclient import TestClient
    from app.core.database import SessionLocal, init_db
    from app.models.database import User, Sector
    from app.services.auth_service import auth_service
    from app.api import create_app
    from app.services.data_service import data_service

    init_db()
    username = "q_update_user"
    db = SessionLocal()
    try:
        existing = auth_service.get_user_by_username(db, username)
        if existing:
            db.delete(existing)
            db.commit()
        user, err = auth_service.create_user(db, username, "Test@12345")
        assert err is None
        user.can_cell_entry = True
        db.commit()
        db.refresh(user)
        token, _ = auth_service.create_access_token(user.id, user.username, False)
    finally:
        db.close()

    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("NR-1", workbook_id=excel_env)[0]
    row_key = hit["rowKey"]

    try:
        client = TestClient(create_app())
        resp = client.post(
            "/api/v1/data/full-params/cells/bulk-update",
            headers={"Authorization": f"Bearer {token}"},
            json={"updates": [{"rowKey": row_key, "networkType": "NR",
                               "fields": {"cellName": "NR-1-改"}}], "deletes": []},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["success"] is True
        assert body["data"]["updated"] == 1
        assert body["data"]["results"][0]["success"] is True
    finally:
        db = SessionLocal()
        try:
            user = auth_service.get_user_by_username(db, username)
            if user:
                db.delete(user)
                db.commit()
        finally:
            db.close()
```

**Step 2: 运行确认失败**

Run: `cd backend && python -m pytest tests/test_cell_query_update.py::test_bulk_update_endpoint_smoke -x -q`
Expected: FAIL（404：路由不存在）

**Step 3: 实现端点**

在 `search_cells` 端点后追加：

```python
@router.post("/full-params/cells/bulk-update", response_model=Dict[str, Any])
async def bulk_update_cells(
    request: CellBulkUpdateRequest,
    current_user=Depends(require_cell_entry),
) -> Dict[str, Any]:
    """查询/更新：批量更新 + 删除小区（一次事务，双写 DB + 全量工参 Excel）"""
    try:
        updates = [
            {"rowKey": u.rowKey, "networkType": u.networkType.value, "fields": u.fields}
            for u in request.updates
        ]
        deletes = [
            {"rowKey": d.rowKey, "networkType": d.networkType.value}
            for d in request.deletes
        ]
        result = await run_in_threadpool(
            data_service.bulk_update_cells,
            updates, deletes, current_user.id,
        )
        return {
            "success": result.get("success", False),
            "message": result.get("message", ""),
            "data": {
                "results": result.get("results", []),
                "updated": result.get("updated", 0),
                "deleted": result.get("deleted", 0),
            },
        }
    except ValueError as e:
        error_msg = str(e).replace("✗", "x")
        safe_detail = error_msg.encode("utf-8", "replace").decode("utf-8")
        raise HTTPException(status_code=400, detail=safe_detail)
    except Exception as e:
        import traceback
        traceback.print_exc()
        error_msg = str(e).replace("✗", "x")
        safe_detail = error_msg.encode("utf-8", "replace").decode("utf-8")
        raise HTTPException(status_code=500, detail=safe_detail)
```

顶部 import 增加 `CellBulkUpdateRequest`。

**Step 4: 运行确认通过**

Run: `cd backend && python -m pytest tests/test_cell_query_update.py -q`
Expected: PASS（全量后端用例）

**Step 5: Commit**

```bash
git add backend/app/api/v1/endpoints/data.py backend/tests/test_cell_query_update.py
git commit -m "feat: 查询/更新 批量更新端点 /full-params/cells/bulk-update"
```

---

### Task 6: 前端 API 封装 + 共享类型

**Files:**
- Modify: `shared/types.ts`
- Modify: `frontend/src/renderer/services/api.ts`

**Step 1: 类型**

在 `shared/types.ts` 追加：

```ts
// 查询/更新：搜索结果项
export interface CellSearchItem {
  rowKey: string
  networkType: string
  siteId: string
  cellId: string
  cellName: string
  siteName?: string
  managedElementId?: string
  mcc?: string
  mnc?: string
  longitude?: number
  latitude?: number
  azimuth?: number
  frequency?: number
  ssbFrequency?: number
  cellCoverType: number
}

export interface CellBulkUpdateResultItem {
  rowKey: string
  type: 'update' | 'delete'
  success: boolean
  message: string
}
```

**Step 2: API 封装**

在 `frontend/src/renderer/services/api.ts` 的 `dataApi` 内、`checkCellDuplicates` 之后追加：

```ts
// 查询/更新：智能搜索小区
searchCells: async (query: string, networkType?: 'LTE' | 'NR', limit = 20): Promise<ApiResponse<CellSearchItem[]>> => {
  return apiClient.post('/data/full-params/cells/search', { query, networkType, limit })
},

// 查询/更新：批量更新 + 删除小区
bulkUpdateCells: async (payload: {
  updates: Array<{ rowKey: string; networkType: 'LTE' | 'NR'; fields: Record<string, string | number | undefined> }>
  deletes: Array<{ rowKey: string; networkType: 'LTE' | 'NR' }>
}): Promise<ApiResponse<{ results: CellBulkUpdateResultItem[]; updated: number; deleted: number }>> => {
  return apiClient.post('/data/full-params/cells/bulk-update', payload)
},
```

顶部 type import 追加 `CellSearchItem, CellBulkUpdateResultItem`（检查现有 import 来自 `@shared/types`）。

**Step 3: 校验**

Run: `cd frontend && npx tsc --noEmit`
Expected: 无新类型错误（若有既有错误，确认与本次改动无关）

**Step 4: Commit**

```bash
git add shared/types.ts frontend/src/renderer/services/api.ts
git commit -m "feat: 查询/更新 前端 API 封装与共享类型"
```

---

### Task 7: 抽取共用表格组件 `CellParamsTable`

**Files:**
- Create: `frontend/src/renderer/components/DataTable/CellParamsTable.tsx`
- Modify: `frontend/src/renderer/pages/DataPage.tsx`（`NewCellEntryCard` 改用它）

**Step 1: 实现组件（纯展示，无业务逻辑）**

创建 `frontend/src/renderer/components/DataTable/CellParamsTable.tsx`：

```tsx
import type { CellRow } from '@/pages/DataPage'   // 若 CellRow 导出；否则组件内定义并双写类型
```

（注：`CellRow` 目前定义在 DataPage.tsx 内部。为共享，把 `CellRow` 类型**移到** `shared/types.ts` 并在 DataPage 与组件中引用，或在本组件内定义同一结构。推荐移到 `shared/types.ts`：）

```ts
export interface CellRow {
  id: string
  managedElementId: string
  siteId: string
  cellId: string
  cellName: string
  mcc: string
  mnc: string
  longitude: string
  latitude: string
  azimuth: string
  frequency: string
  ssbFrequency: string
  cellCoverType: number
}
```

组件 props（同时服务新站录入与查询/更新）：

```tsx
interface CellParamsTableProps {
  rows: CellRow[]
  activeTab: 'LTE' | 'NR'
  colWidths: Record<string, number>
  onColResize: (e: React.MouseEvent, colKey: string) => void
  onFieldChange: (rowId: string, field: string, value: string | number) => void
  onAzimuthChange: (rowId: string, value: string) => void
  disabled: boolean
  readOnly?: boolean                     // 查询/更新模式：无复选框，最左为 X 删除标记
  deleteMarkedIds?: Set<string>          // 查询/更新：待删除行
  onToggleDeleteMark?: (rowId: string) => void
  onPaste?: (e: React.ClipboardEvent) => void
  t: (key: string) => string
}
```

**实现要点**：把 `NewCellEntryCard` 现有 `<table>`（thead 13 列 + tbody 行渲染，DataPage.tsx 1965-2145 行）原样搬入组件，新增两处分支：
- `readOnly` 模式：第一列渲染红色「X」按钮（`onToggleDeleteMark`），点击标记；第二列不再渲染复选框（或渲染站点名文本）。
- 删除标记行样式：`deleteMarkedIds.has(row.id)` 时行加 `opacity-40 line-through`。
- 其余列输入框渲染逻辑与现有完全一致（inputCls、data-field、filter、select MNC/覆盖类型）。

`NewCellEntryCard` 改为渲染 `<CellParamsTable ... />`，把 `rows[activeTab]`、`colWidths`、各 handler 传入；删除其内联表格代码。

**Step 2: 校验**

Run: `cd frontend && npm run type-check && npm run lint`
Expected: 无错误（lint 若有风格问题按提示修正）

**Step 3: 手工验证**

Run: `cd frontend && npm run dev:web` 打开 http://localhost:5173/data，确认「新站录入」表格渲染、编辑、粘贴、列宽拖拽行为不变。

**Step 4: Commit**

```bash
git add shared/types.ts frontend/src/renderer/components/DataTable/CellParamsTable.tsx frontend/src/renderer/pages/DataPage.tsx
git commit -m "refactor: 抽取共用小区参数表格组件 CellParamsTable（新站录入迁移）"
```

---

### Task 8: 前端「查询/更新」卡片 `CellQueryUpdateCard`

**Files:**
- Create: `frontend/src/renderer/components/DataTable/CellQueryUpdateCard.tsx`
- Modify: `frontend/src/renderer/pages/DataPage.tsx`（渲染该卡片 + Tab 切换）
- Modify: `frontend/src/renderer/locales/zh.json` / `en.json`

**Step 1: i18n 键（先加，zh/en 同步）**

`locales/zh.json` 新增 `"queryUpdate"` 段：

```json
"queryUpdate": {
  "title": "查询/更新",
  "newCellEntry": "新站录入",
  "searchPlaceholder": "输入小区名称/网元ID/基站ID/基站名称搜索",
  "searching": "搜索中...",
  "noResult": "无匹配结果",
  "searchHint": "支持模糊匹配，选中后追加到下方表格",
  "markDelete": "标记删除",
  "deleteMarked": "已标记删除",
  "confirmTitle": "确认更新/删除",
  "confirmUpdateLabel": "更新",
  "confirmDeleteLabel": "删除",
  "confirmEmpty": "没有变更内容",
  "confirmExecute": "确认执行",
  "confirmCancel": "取消",
  "update": "更新",
  "updateRunning": "更新中...",
  "clear": "清空",
  "selectResultFirst": "请先从搜索结果选择小区",
  "updateSuccess": "更新完成：成功 {{ok}} 条，失败 {{fail}} 条",
  "updateFailed": "更新失败：{{msg}}",
  "fieldSiteName": "站点名称"
}
```

`en.json` 同步英文对应键。

**Step 2: 纯逻辑测试先行（vitest）**

创建 `frontend/src/renderer/components/DataTable/__tests__/cellQueryUpdate.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { computeCellChanges } from '../CellQueryUpdateCard'

const base = (over: Record<string, unknown> = {}) => ({
  id: 'r1', managedElementId: '2001', siteId: '111', cellId: '1', cellName: 'TH-1',
  mcc: '460', mnc: '11', longitude: '113', latitude: '23', azimuth: '0',
  frequency: '1825', ssbFrequency: '', cellCoverType: 1, ...over,
})

describe('computeCellChanges', () => {
  it('检测字段修改（旧→新）', () => {
    const orig = [base()]
    const edited = [base({ cellName: 'TH-1-改', azimuth: '90' })]
    const changes = computeCellChanges(orig, edited, new Set())
    expect(changes.updates).toHaveLength(1)
    expect(changes.updates[0].diff).toMatchObject({
      cellName: ['TH-1', 'TH-1-改'],
      azimuth: ['0', '90'],
    })
    expect(changes.deletes).toHaveLength(0)
  })

  it('未修改的行不产生变更', () => {
    const orig = [base()]
    const edited = [base()]
    const changes = computeCellChanges(orig, edited, new Set())
    expect(changes.updates).toHaveLength(0)
  })

  it('删除标记行进入 deletes', () => {
    const orig = [base()]
    const edited = [base()]
    const changes = computeCellChanges(orig, edited, new Set(['r1']))
    expect(changes.deletes).toEqual([{ rowKey: 'r1', networkType: 'LTE', cellName: 'TH-1', siteId: '111', cellId: '1' }])
  })
})
```

Run: `cd frontend && npx vitest run src/renderer/components/DataTable/__tests__/cellQueryUpdate.test.ts`
Expected: FAIL（`computeCellChanges` 未定义）

**Step 3: 实现 `computeCellChanges` 与卡片组件**

在 `CellQueryUpdateCard.tsx` 导出纯函数：

```ts
export interface CellChangeUpdate {
  rowKey: string
  networkType: 'LTE' | 'NR'
  diff: Record<string, [string | number, string | number]>
  fields: Record<string, string | number>
}
export interface CellChangeDelete {
  rowKey: string
  networkType: 'LTE' | 'NR'
  cellName: string
  siteId: string
  cellId: string
}
export function computeCellChanges(
  original: CellRow[],
  edited: CellRow[],
  deleteMarked: Set<string>,
  activeTab: 'LTE' | 'NR',
): { updates: CellChangeUpdate[]; deletes: CellChangeDelete[] } {
  const updates: CellChangeUpdate[] = []
  const deletes: CellChangeDelete[] = []
  const byId = new Map(original.map(r => [r.id, r]))
  for (const row of edited) {
    const orig = byId.get(row.id)
    if (!orig) continue
    if (deleteMarked.has(row.id)) {
      deletes.push({ rowKey: row.rowKey ?? row.id, networkType: activeTab, cellName: row.cellName, siteId: row.siteId, cellId: row.cellId })
      continue
    }
    const diff: Record<string, [string | number, string | number]> = {}
    const fields: Record<string, string | number> = {}
    const keys = ['managedElementId', 'siteId', 'cellId', 'cellName', 'mcc', 'mnc', 'longitude', 'latitude', 'azimuth', 'frequency', 'ssbFrequency', 'cellCoverType'] as const
    for (const k of keys) {
      const o = String(orig[k] ?? '').trim()
      const n = String(row[k] ?? '').trim()
      if (o !== n) {
        diff[k] = [o, n]
        fields[k] = row[k] as string | number
      }
    }
    if (Object.keys(diff).length > 0) {
      updates.push({ rowKey: row.rowKey ?? row.id, networkType: activeTab, diff, fields })
    }
  }
  return { updates, deletes }
}
```

卡片组件要点（`CellQueryUpdateCard`）：
- 状态：`activeTab`、`origRows: {LTE: CellRow[]; NR: CellRow[]}`（搜索加载的原始值）、`rows: {LTE; NR}`（可编辑副本）、`deleteMarked: Set<string>`、`searchQuery`、`searchResults: CellSearchItem[]`、`showDropdown`、`confirmOpen`、`confirmData`、`updating`、`batchResults`
- 搜索：输入 onChange → 300ms 防抖 → `dataApi.searchCells(q, activeTab)` → 设 `searchResults`；下拉项点击 → 若 `rowKey` 已存在则忽略，否则把结果转成 `CellRow`（`rowKey` 存到行内字段 `rowKey`）+ 追加到 `rows[activeTab]` 与 `origRows[activeTab]`；站点级（多扇区）命中多条时全部追加
- 删除标记：`onToggleDeleteMark` 切换 `deleteMarked`
- 「更新」：`computeCellChanges(origRows[nt], rows[nt], deleteMarked, nt)` 遍历 LTE/NR 两页签聚合；`confirmData = { updates, deletes }`；打开确认弹窗（内联 overlay）
- 确认弹窗：列出每个 update 的 `字段名：旧值 → 新值`（用 `newCellEntry.fieldXxx` 标签翻译），每个 delete 的 `小区名 (siteId_cellId)`；「确认执行」→ `dataApi.bulkUpdateCells({ updates, deletes })` → 展示 `batchResults`，成功则清空表格/标记并 `addLog`
- 渲染 `<CellParamsTable readOnly deleteMarkedIds={deleteMarked} onToggleDeleteMark={...} />`

`CellRow` 增加可选 `rowKey?: string` 字段（shared/types.ts），搜索结果转换时保留。

**Step 4: 校验**

Run: `cd frontend && npm run type-check && npm run lint && npx vitest run src/renderer/components/DataTable/__tests__/cellQueryUpdate.test.ts`
Expected: 全部通过

**Step 5: Commit**

```bash
git add frontend/src/renderer/components/DataTable/CellQueryUpdateCard.tsx frontend/src/renderer/components/DataTable/__tests__/cellQueryUpdate.test.ts frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json shared/types.ts
git commit -m "feat: 查询/更新 前端卡片（搜索下拉 + 多行编辑 + 删除标记 + 确认弹窗）"
```

---

### Task 9: DataPage 集成「查询/更新 | 新站录入」Tab 切换

**Files:**
- Modify: `frontend/src/renderer/pages/DataPage.tsx`

**Step 1: 实现**

- 在 `DataPage` 顶层加状态 `const [cellToolsTab, setCellToolsTab] = useState<'query' | 'entry'>('entry')`（默认新站录入）。
- 在数据操作区把当前 `NewCellEntryCard` 区域（DataPage.tsx 949-954 行）替换为：

```tsx
{/* 数据管理工具：查询/更新 | 新站录入 */}
<div className="bg-card p-3 rounded-lg border border-border -mt-6">
  <div className="flex gap-2 mb-3">
    {(['query', 'entry'] as const).map(mode => (
      <button
        key={mode}
        onClick={() => setCellToolsTab(mode)}
        className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
          cellToolsTab === mode
            ? 'bg-primary/10 border-primary text-primary font-medium'
            : 'bg-background border-border text-muted-foreground hover:bg-muted'
        }`}
      >
        {mode === 'query'
          ? (t('queryUpdate.title') || '查询/更新')
          : (t('newCellEntry.title') || '新站录入')}
      </button>
    ))}
  </div>
  {cellToolsTab === 'query' ? (
    <CellQueryUpdateCard
      fullParamFiles={fullParamFiles}
      addLog={addLog}
      disabled={!permCellEntry}
    />
  ) : (
    <NewCellEntryCard
      fullParamFiles={fullParamFiles}
      addLog={addLog}
      disabled={!permCellEntry}
    />
  )}
</div>
```

- 顶部 import `CellQueryUpdateCard`。

**Step 2: 校验**

Run: `cd frontend && npm run type-check && npm run lint && npm run build:vite`
Expected: 构建通过

**Step 3: 手工验证**

Run: `cd frontend && npm run dev:web` → http://localhost:5173/data
- 切换「查询/更新」/「新站录入」互斥生效，默认新站录入
- 查询：LTE/NR 页签下搜索 4 种词出下拉；选中追加行；改小区名/方向角后点「更新」→ 弹窗列出 diff → 确认后落库
- 删除：点行首 X 标记变灰 → 「更新」弹窗列出删除 → 确认执行
- 新站录入功能回归无异常

**Step 4: 后端联调**

确认后端已运行（`cd backend && python main.py`），重复上述手工流程验证 DB + Excel 双写（打开 data/{id}/original.xlsx 检查）。

**Step 5: Commit**

```bash
git add frontend/src/renderer/pages/DataPage.tsx
git commit -m "feat: 数据管理页集成查询/更新与新站录入 Tab 切换"
```

---

### Task 10: 全量回归 + 收尾

**Files:**
- 无新增

**Step 1: 后端全量测试**

Run: `cd backend && python -m pytest -q`
Expected: 全部通过（含新增 `test_cell_query_update.py`）

**Step 2: 前端校验**

Run: `cd frontend && npm run type-check && npm run lint && npx vitest run`
Expected: 全部通过

**Step 3: 收尾检查**

- 确认无 `test.skip`/`.only`、无 TODO 占位；
- 检查 `_apply_excel_updates` 中「改键后 Excel 定位」的退化为仅匹配新键的局限，若改键行未命中 Excel 数据行则仅在 DB 生效——在最终 review 时确认是否接受（可接受：DB 为权威，Excel 尽力一致），或补充按旧键定位（实现时可先读 DB 旧 siteId/cellId 再定位，见 Task 4 注释）。

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: 查询/更新 全量回归通过"
```

---

## 验收标准汇总

1. 数据管理页出现「[查询/更新] [新站录入]」互斥 Tab，默认新站录入；
2. LTE/NR 页签下搜索框对 4 种词模糊匹配出下拉，选中追加多行、去重；
3. 行级 X 删除标记（变灰+删除线），可取消；
4. 点「更新」弹窗列出全部字段 diff 与删除清单，确认后一次性执行 LTE+NR；
5. 库内校验：标识冲突/跨制式占用/经纬度/方向角/MNC/频点超范围逐行拒绝并提示；
6. 执行后 SQLite 与全量工参 Excel 双写一致；删除最后扇区级联删站；
7. 后端 `pytest tests/test_cell_query_update.py` 与既有测试、前端 type-check/lint/vitest 全绿。
