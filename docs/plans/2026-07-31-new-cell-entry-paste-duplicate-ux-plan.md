# 新站录入功能调整 Implementation Plan（粘贴录入 / 制式分离查重 / 导入即时反馈）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 新站录入支持默认 3 行 + 多行多列粘贴自动扩充、按制式分离查重（含跨制式"请检查"提示）、一键导入即时反馈。

**Architecture:** 后端 `data_service` 是查重与逐行消息的唯一事实来源。`check_cell_duplicates` 重构为返回每 CGI 的 `{lte, nr}` 双制式标记；`batch_add_cells_to_full_params` 的 `existing_cell_keys` 从 set 改为 `key→制式` 字典，用统一的 `_duplicate_message` 生成同制式覆盖/跨制式提示。前端在 DataPage 加默认 3 行、`onPaste` 粘贴解析、组件级 `importing` 状态即时反馈，并用 `duplicateMap` 分类红/橙高亮。

**Tech Stack:** FastAPI + SQLAlchemy (backend), React 18 + TypeScript + Zustand (frontend), openpyxl (Excel).

---

## Task 1: 后端——新增 `_duplicate_message` 纯函数 + 测试（TDD）

**Files:**
- Modify: `backend/app/services/data_service.py`（在 `check_cell_duplicates` 上方新增 static 方法）
- Create: `backend/tests/test_cell_duplicates.py`

**Step 1: Write the failing test**

`backend/tests/test_cell_duplicates.py`:

```python
"""制式分离查重与新站录入重复消息测试"""
import pytest
from app.services.data_service import data_service


@pytest.fixture()
def dup_env():
    """构造含 LTE/NR 小区的全量工参环境（纯 DB fixture，供后续任务复用）"""
    import uuid
    from app.core.database import SessionLocal
    from app.models.database import Workbook, Site, Sector

    db = SessionLocal()
    wb_id = f"test-{uuid.uuid4()}"
    db.add(Workbook(
        id=wb_id, user_id=1, name="dup-test", file_type="full_params",
        status="completed", created_at="2026-07-31",
    ))
    site_lte = Site(
        workbook_id=wb_id, user_id=1, site_id="111", name="LTE站",
        network_type="LTE", longitude=1.0, latitude=1.0,
    )
    db.add(site_lte)
    db.flush()
    db.add(Sector(
        site_id_fk=site_lte.id, workbook_id=wb_id, user_id=1,
        sector_id="111_1", name="LTE小区", longitude=1.0, latitude=1.0, azimuth=0,
    ))
    db.commit()

    # 注入 index，让 data_service 能定位 full_params 文件
    saved_index = dict(data_service.index)
    data_service.index[wb_id] = {"fileType": "full_params"}
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
    data_service.index.clear()
    data_service.index.update(saved_index)


def test_duplicate_message_same_type():
    """同制式重复 → '已重复，信息已更新覆盖'"""
    assert data_service._duplicate_message("NR", "NR", "X") == "[NR]小区 X 已重复，信息已更新覆盖"
    assert data_service._duplicate_message("LTE", "LTE", "Y") == "[LTE]小区 Y 已重复，信息已更新覆盖"


def test_duplicate_message_cross_type():
    """跨制式重复 → '已在[其他制式]工参中存在，请检查'"""
    assert data_service._duplicate_message("LTE", "NR", "X") == "[LTE]小区 X 已在[NR]工参中存在，请检查"
    assert data_service._duplicate_message("NR", "LTE", "Y") == "[NR]小区 Y 已在[LTE]工参中存在，请检查"
```

**Step 2: Run test to verify it fails**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_cell_duplicates.py -v`
Expected: FAIL with `AttributeError: 'DataService' object has no attribute '_duplicate_message'`

**Step 3: Implement the helper**（放在 `check_cell_duplicates` 方法定义之前）

```python
    @staticmethod
    def _duplicate_message(panel_type: str, existing_type: Optional[str], cell_name: str) -> str:
        """生成重复小区逐行提示。

        panel_type: 录入面板制式（LTE/NR）
        existing_type: 库中已有小区的制式（None/未知视为同制式）
        同制式 → "[LTE]小区 X 已重复，信息已更新覆盖"
        跨制式 → "[LTE]小区 X 已在[NR]工参中存在，请检查"
        """
        if existing_type is None or existing_type == panel_type:
            return f"[{panel_type}]小区 {cell_name} 已重复，信息已更新覆盖"
        return f"[{panel_type}]小区 {cell_name} 已在[{existing_type}]工参中存在，请检查"
```

**Step 4: Run test to verify it passes**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_cell_duplicates.py -v`
Expected: 2 PASSED

**Step 5: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add backend/tests/test_cell_duplicates.py backend/app/services/data_service.py
git commit -m "feat: 新增小区重复消息生成函数（同制式覆盖/跨制式请检查）"
```

---

## Task 2: 后端——`check_cell_duplicates` 重构为双制式返回（TDD）

**Files:**
- Modify: `backend/app/services/data_service.py:1398`（`check_cell_duplicates` 整体替换）
- Modify: `backend/tests/test_cell_duplicates.py`（追加测试）

**Step 1: Write the failing test**（追加到测试文件）

```python
def test_check_duplicates_returns_network_type_flags(dup_env):
    """同一 CGI 返回 {lte, nr} 双制式标记"""
    result = data_service.check_cell_duplicates([
        {"siteId": "111", "cellId": "1", "networkType": "NR"},   # 库中为 LTE → lte=True
        {"siteId": "999", "cellId": "9", "networkType": "NR"},   # 不存在
    ])
    assert result["exists"]["111_1"] == {"lte": True, "nr": False}
    assert result["exists"]["999_9"] == {"lte": False, "nr": False}
    assert "111_1" in result["duplicates"]
    assert "999_9" not in result["duplicates"]
```

**Step 2: Run test to verify it fails**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_cell_duplicates.py::test_check_duplicates_returns_network_type_flags -v`
Expected: FAIL（现实现以 `cgi_list: List[str]` 为参，`exists[key]` 为 bool）

**Step 3: Implement**——用下面实现**整体替换** `data_service.py:1398-1451` 的 `check_cell_duplicates`：

```python
    def check_cell_duplicates(self, cells: List[Dict]) -> Dict[str, Any]:
        """按制式检查 CGI (siteId_cellId) 是否已存在于数据库

        通过 join sites 表按 site_id + cell_id 匹配 Sector.sector_id，
        兼容纯 cellId 与 siteId_cellId 两种存储格式，并带出该小区的制式。

        cells: [{ siteId, cellId, networkType }]
        返回: {
            "duplicates": ["siteId_cellId", ...],
            "exists": { "siteId_cellId": {"lte": bool, "nr": bool}, ... },
        }
        """
        if not cells:
            return {"duplicates": [], "exists": {}}

        # 定位全量工参文件
        full_params_id = None
        for _id, _info in self.index.items():
            if _info.get("fileType") == "full_params":
                full_params_id = _id
                break
        if not full_params_id:
            safe_print("[DataService] 查重失败: 未找到全量工参文件")
            return {"duplicates": [], "exists": {}}

        db = SessionLocal()
        try:
            exists: Dict[str, Dict[str, bool]] = {}
            for cell in cells:
                site_id = str(cell.get("siteId", "")).strip()
                cell_id = str(cell.get("cellId", "")).strip()
                if not site_id or not cell_id:
                    continue
                key = f"{site_id}_{cell_id}"
                flags = {"lte": False, "nr": False}
                row = db.query(Site.network_type).join(
                    Sector, Sector.site_id_fk == Site.id
                ).filter(
                    Site.workbook_id == full_params_id,
                    Site.site_id == str(site_id),
                    Sector.sector_id.in_([str(cell_id), f"{str(site_id)}_{str(cell_id)}"]),
                ).first()
                if row and row[0]:
                    nt = str(row[0]).upper()
                    if nt in ("LTE", "NR"):
                        flags[nt.lower()] = True
                exists[key] = flags
            duplicates = [k for k, v in exists.items() if v["lte"] or v["nr"]]
            return {
                "duplicates": duplicates,
                "exists": exists,
            }
        except Exception as e:
            safe_print(f"[DataService] 查重失败: {e}")
            return {"duplicates": [], "exists": {}}
        finally:
            db.close()
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_cell_duplicates.py -v`
Expected: 3 PASSED

**Step 5: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add backend/app/services/data_service.py backend/tests/test_cell_duplicates.py
git commit -m "feat: check_cell_duplicates 按制式返回 {lte,nr} 双标记"
```

---

## Task 3: 后端——新增查重 schema 并修复 check-duplicates 端点（422 隐患）

**Files:**
- Modify: `backend/app/models/schemas.py`（在 `CellBatchCreateRequest` 附近新增）
- Modify: `backend/app/api/v1/endpoints/data.py:260-279`

**Step 1: Add schema**（`backend/app/models/schemas.py`，`CellBatchCreateRequest` 定义之后）

```python
class CellDupCheckItem(BaseModel):
    """批量查重单项：siteId + cellId + 面板制式"""

    siteId: str
    cellId: str
    networkType: NetworkType = NetworkType.LTE


class CellDupCheckRequest(BaseModel):
    """批量查重请求"""

    cells: List[CellDupCheckItem]
```

**Step 2: Update endpoint**——用下面实现**整体替换** `data.py:260-279` 的 `check_cell_duplicates`：

```python
@router.post("/full-params/cells/check-duplicates", response_model=Dict[str, Any])
async def check_cell_duplicates(
    request: CellDupCheckRequest,
    current_user=Depends(require_cell_entry),
) -> Dict[str, Any]:
    """检查小区是否重复：按制式区分（siteId_cellId 匹配数据库已有记录）"""
    if not request.cells:
        return {"success": True, "data": {"duplicates": [], "exists": {}}}

    try:
        from app.services.data_service import data_service
        cells = [
            {
                "siteId": c.siteId,
                "cellId": c.cellId,
                "networkType": c.networkType.value,
            }
            for c in request.cells
        ]
        result = await run_in_threadpool(
            data_service.check_cell_duplicates, cells
        )
        return {"success": True, "data": result}
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
```

**Step 3: Import the new schema**——确认 `data.py` 顶部已从 `app.models.schemas` 导入 `CellDupCheckRequest`（若没有则加入 import）。

**Step 4: Verify**（旧前端 `{siteId, cellId}` 请求现在因缺少 `networkType` 仍会 422——这是预期，Task 6 前端会带上该字段）

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_sqlite_storage.py -q`
Expected: PASS（确认 schema/端点改动未破坏现有导入）

**Step 5: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add backend/app/models/schemas.py backend/app/api/v1/endpoints/data.py
git commit -m "feat: check-duplicates 端点改用制式感知 schema（修复 422 隐患）"
```

---

## Task 4: 后端——`batch_add_cells_to_full_params` 制式分离查重 + 新消息 + 跨制式跳过

**Files:**
- Modify: `backend/app/services/data_service.py:1050-1093`（预加载 + 过滤循环）
- Modify: `backend/app/services/data_service.py`（`results[idx]` 消息赋值处）

**Step 1: 预加载 existing_cell_keys 从 set 改字典**——替换 `data_service.py:1052-1071` 的块：

```python
        # 预加载数据库中已有小区 key（site_id + cell_id）→ 制式，用于 Excel 追加前查重
        # 兼容两种 Sector.sector_id 存储格式：纯 cellId 与 siteId_cellId
        existing_cell_keys: Dict[str, str] = {}
        try:
            db = SessionLocal()
            try:
                rows = db.query(Site.site_id, Sector.sector_id, Site.network_type).join(
                    Sector, Sector.site_id_fk == Site.id
                ).filter(Site.workbook_id == full_params_id).all()
                for site_id_val, sector_id_val, net_type in rows:
                    sid = str(sector_id_val)
                    if "_" not in sid:
                        # 纯 cellId 格式（如 '61'）：key = siteId_cellId
                        key = f"{site_id_val}_{sid}"
                    else:
                        # 组合格式（如 '541379_61'）：取最后一段作为 cellId
                        cell_part = sid.rsplit("_", 1)[-1]
                        key = f"{site_id_val}_{cell_part}"
                    existing_cell_keys[key] = str(net_type or "").upper()
            finally:
                db.close()
        except Exception as e:
            safe_print(f"[DataService] 预加载已有小区失败 (非致命): {e}")
```

**Step 2: 过滤循环改字典 + 新消息 + 跨制式跳过**——替换 `data_service.py:1076-1093` 的循环：

```python
        # 过滤重复行：与数据库中已有 (site_id, cell_id) 相同的小区跳过
        # 同制式重复 → "已重复，信息已更新覆盖"；跨制式重复 → "已在[其他制式]工参中存在，请检查"（均不导入）
        filtered_cells = []
        skip_map = {}  # orig_idx -> 原因
        for idx, cell in enumerate(cells):
            site_id_val = str(cell.get("siteId", "")).strip()
            cell_id_val = str(cell.get("cellId", "")).strip()
            key = f"{site_id_val}_{cell_id_val}"
            if key in existing_cell_keys:
                panel_type = str(cell.get("networkType", "")).upper()
                db_type = existing_cell_keys[key]
                skip_map[idx] = "已存在"
                results[idx] = {
                    "index": idx,
                    "networkType": panel_type,
                    "cellName": cell.get("cellName", ""),
                    "siteId": site_id_val,
                    "cellId": cell_id_val,
                    "success": True,
                    "message": self._duplicate_message(panel_type, db_type, cell.get("cellName", "")),
                }
            else:
                filtered_cells.append((idx, cell))
                existing_cell_keys[key] = str(cell.get("networkType", "")).upper()  # 批内后续行查重
```

**Step 3: Run the full backend test suite to confirm no regressions**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/ -q 2>&1 | tail -3`
Expected: `passed`（无回归）

**Step 4: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add backend/app/services/data_service.py
git commit -m "feat: 批量新站录入按制式分离查重，跨制式重复跳过并提示请检查"
```

---

## Task 5: 后端——单条 `add_cell_to_full_params` 消息对齐（可选，口径统一）

**Files:**
- Modify: `backend/app/services/data_service.py:813-820`（`_sector_exists` 命中分支）

**Step 1: Implement**

将 `data_service.py:814-820` 的返回块替换为（复用 `_duplicate_message`，查库中制式）：

```python
        # 查重：在追加 Excel 之前检查该小区是否已存在，避免重复导入
        if self._sector_exists(full_params_id, site_id, cell_id):
            safe_print(f"[DataService] 小区已存在，跳过导入: {site_id}_{cell_id}")
            db_type = self._get_sector_network_type(full_params_id, site_id, cell_id)
            return {
                "success": True,
                "message": self._duplicate_message(
                    str(network_type).upper(), db_type, cell_name
                ),
                "cellId": f"{site_id}_{cell_id}",
            }
```

并在 `_sector_exists` 方法（`data_service.py:1372`）之后新增：

```python
    def _get_sector_network_type(self, workbook_id: str, site_id: Any, cell_id: Any) -> Optional[str]:
        """查询指定 (site_id, cell_id) 已有小区的制式（无则 None）"""
        if not site_id or not cell_id:
            return None
        db = SessionLocal()
        try:
            row = db.query(Site.network_type).join(
                Sector, Sector.site_id_fk == Site.id
            ).filter(
                Site.workbook_id == workbook_id,
                Site.site_id == str(site_id),
                Sector.sector_id.in_([str(cell_id), f"{str(site_id)}_{str(cell_id)}"]),
            ).first()
            return str(row[0]).upper() if row and row[0] else None
        except Exception:
            return None
        finally:
            db.close()
```

**Step 2: Run backend suite**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/ -q 2>&1 | tail -3`
Expected: `passed`

**Step 3: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add backend/app/services/data_service.py
git commit -m "feat: 单条新站录入重复消息与批量口径对齐"
```

---

## Task 6: 前端——`checkCellDuplicates` API 类型与请求体更新

**Files:**
- Modify: `frontend/src/renderer/services/api.ts:698-700`

**Step 1: Replace** `api.ts:698-700` 的 `checkCellDuplicates`：

```typescript
  // 批量查重：按制式检查 CGI (siteId_cellId) 是否已存在于数据库
  checkCellDuplicates: async (cells: Array<{ siteId: string; cellId: string; networkType?: 'LTE' | 'NR' }>): Promise<ApiResponse<{ duplicates: string[]; exists: Record<string, { lte: boolean; nr: boolean }> }>> => {
    return apiClient.post('/data/full-params/cells/check-duplicates', { cells })
  },
```

**Step 2: Type-check**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: 与基线 259 一致（`api.ts` 不应新增错误）

**Step 3: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/services/api.ts
git commit -m "feat: checkCellDuplicates 请求带 networkType，响应类型双制式"
```

---

## Task 7: 前端——默认 3 行 + `createEmptyRows` 辅助

**Files:**
- Modify: `frontend/src/renderer/pages/DataPage.tsx`
  - `:1389-1392`（rows 初始值）
  - `:1401-1417`（`createEmptyRow` 旁新增 `createEmptyRows`）
  - `:1516-1524`（`resetAll`）
  - `:1619-1620`、`:1641-1642`（导入成功后清空）

**Step 1: Implement**

1. 初始值（`:1389-1392`）改为：

```typescript
  const [rows, setRows] = useState<{ LTE: CellRow[]; NR: CellRow[] }>({
    LTE: Array.from({ length: 3 }, () => createEmptyRow()),
    NR: Array.from({ length: 3 }, () => createEmptyRow()),
  })
```

2. 在 `createEmptyRow` 定义（`:1417`）之后新增：

```typescript
  /** 创建 n 行空行（默认 3 行） */
  function createEmptyRows(n = 3): CellRow[] {
    return Array.from({ length: n }, () => createEmptyRow())
  }
```

3. `resetAll`（`:1516-1524`）改为 3 行：

```typescript
  const resetAll = () => {
    setRows({ LTE: createEmptyRows(), NR: createEmptyRows() })
    setSelectedRowIds(new Set())
    setBatchResults(null)
    setBatchError(null)
    setDuplicateMap({})
  }
```

4. 导入成功后的清空（`:1619-1620`、`:1641-1642` 两处 `setRows({ LTE: [createEmptyRow()], NR: [createEmptyRow()] })`）改为：

```typescript
          setRows({ LTE: createEmptyRows(), NR: createEmptyRows() })
```

> 注：Task 9 会把 `duplicateCgiSet` 重命名为 `duplicateMap`。此处 `resetAll` 先行引用 `setDuplicateMap({})`，若 Task 9 未完成会编译失败——请与 Task 9 合并提交或先临时保留 `setDuplicateCgiSet(new Set())`，二选一。

**Step 2: Type-check**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep "DataPage.tsx"`
Expected: 仅基线 4 处已知错误（397/477/478/581 行），无新增

**Step 3: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/pages/DataPage.tsx
git commit -m "feat: 新站录入默认 3 行"
```

---

## Task 8: 前端——多行多列粘贴自动扩充

**Files:**
- Modify: `frontend/src/renderer/pages/DataPage.tsx`
  - `:1730`（表格外层 div 挂 `onPaste`）
  - `:1761`（`<tr>` 加 `data-row-id`）
  - `:1475-1494` 附近（新增 `handlePaste`）

**Step 1: Implement**

1. 在 `updateRow` 定义（`:1494`）之后新增：

```typescript
  // 多行多列粘贴：从 Excel/文本复制 tab 分隔内容，按列顺序填充并自动扩充行数
  const handlePaste = (e: React.ClipboardEvent) => {
    if (!hasFullParams) return
    const text = e.clipboardData.getData('text/plain')
    if (!text.includes('\t') && !text.includes('\n')) return // 单格粘贴交给浏览器默认
    e.preventDefault()

    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim() !== '')
    if (lines.length === 0) return

    // 粘贴锚点：优先取当前聚焦输入所在行，否则从第 0 行开始
    let anchor = 0
    const activeTr = (document.activeElement as HTMLElement | null)?.closest?.('tr') as HTMLTableRowElement | null
    const anchorId = activeTr?.dataset?.rowId
    if (anchorId) {
      const idx = rows[activeTab].findIndex(r => r.id === anchorId)
      if (idx >= 0) anchor = idx
    }

    // 列顺序：网元ID、基站ID、小区ID、小区名称、MCC、MNC、经度、纬度、方向角、频点、覆盖类型
    const nextRows = rows[activeTab].map(r => ({ ...r }))
    let rowIdx = anchor
    for (const line of lines) {
      const cols = line.split('\t')
      const get = (i: number) => (cols[i] ?? '').trim()
      const base = nextRows[rowIdx] ?? createEmptyRow()
      const next: CellRow = {
        ...base,
        managedElementId: get(0) ? filterDigits(get(0)) : base.managedElementId,
        siteId: get(1) ? filterDigits(get(1)) : base.siteId,
        cellId: get(2) ? filterDigits(get(2)) : base.cellId,
        cellName: get(3) || base.cellName,
        mcc: get(4) || base.mcc || '460',
        mnc: get(5) || base.mnc || '11',
        longitude: get(6) ? filterNumeric(get(6)) : base.longitude,
        latitude: get(7) ? filterNumeric(get(7)) : base.latitude,
        azimuth: get(8) ? filterDigits(get(8)) : base.azimuth,
        frequency: isLte && get(9) ? filterNumeric(get(9)) : base.frequency,
        ssbFrequency: !isLte && get(9) ? filterNumeric(get(9)) : base.ssbFrequency,
        cellCoverType: get(10) ? (parseInt(get(10), 10) === 4 ? 4 : 1) : base.cellCoverType,
      }
      if (rowIdx < nextRows.length) nextRows[rowIdx] = next
      else nextRows.push(next)
      rowIdx++
    }
    setRows(prev => ({ ...prev, [activeTab]: nextRows }))
  }
```

2. 表格外层 div（`:1730`）加 `onPaste`：

```tsx
      <div className={expanded ? 'overflow-x-auto' : 'overflow-x-auto'} onPaste={handlePaste}>
```

3. 行 `<tr>`（`:1761`）加 `data-row-id`：

```tsx
                <tr key={row.id} data-row-id={row.id} className={...}>
```

> 注意：`isLte` 在 `:1659` 定义，`handlePaste` 需在其后或通过 `activeTab === 'LTE'` 内联判断。建议在 `handlePaste` 内用 `const isLte = activeTab === 'LTE'`（函数体内局部变量，避免闭包顺序问题）。

**Step 2: Type-check**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep "DataPage.tsx"`
Expected: 仅基线 4 处已知错误，无新增

**Step 3: Manual sanity**（粘贴解析逻辑无自动化测试，靠 type-check + 手工验证）

**Step 4: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/pages/DataPage.tsx
git commit -m "feat: 新站录入支持多行多列粘贴并自动扩充行数"
```

---

## Task 9: 前端——`duplicateMap` 制式分类高亮 + 预查重逻辑

**Files:**
- Modify: `frontend/src/renderer/pages/DataPage.tsx`
  - `:1397`（`duplicateCgiSet` 状态 → `duplicateMap`）
  - `:1591-1626`（`handleBatchImport` 预查重块）
  - `:1761`（行背景色）
  - `:1712`（tab 切换重置）
  - `:1578`、`:1623`（`handleBatchImport` 重置/清空）

**Step 1: Implement**

1. 状态声明（`:1397`）改为：

```typescript
  const [duplicateMap, setDuplicateMap] = useState<Record<string, 'same' | 'cross'>>({})
```

2. `handleBatchImport` 预查重块（`:1591-1626`）替换为：

```typescript
    // 查重：按制式检查 CGI (siteId_cellId) 是否已存在于数据库
    try {
      const dupCheck = await dataApi.checkCellDuplicates(
        validRows.map(r => ({ siteId: r.siteId, cellId: r.cellId, networkType: r.networkType }))
      )
      const exists = dupCheck?.data?.exists
      if (exists && Object.keys(exists).length > 0) {
        // 分类：same=同制式重复(红)，cross=跨制式重复(橙)
        const dupMap: Record<string, 'same' | 'cross'> = {}
        for (const r of validRows) {
          const key = `${r.siteId}_${r.cellId}`
          const hit = exists[key]
          if (!hit) continue
          const panel = r.networkType.toLowerCase()
          const other = r.networkType === 'LTE' ? 'nr' : 'lte'
          if (hit[panel]) dupMap[key] = 'same'
          else if (hit[other]) dupMap[key] = 'cross'
        }
        setDuplicateMap(dupMap)
        const dupKeys = new Set(Object.keys(dupMap))

        if (dupKeys.size > 0) {
          const crossNames = validRows
            .filter(r => dupMap[`${r.siteId}_${r.cellId}`] === 'cross')
            .map(r => r.cellName)
            .join('、')
          if (crossNames) {
            setBatchError(`跨制式重复，已跳过请检查：${crossNames}`)
            setTimeout(() => setBatchError(null), 8000)
          }
          // 过滤掉重复行（同制式 + 跨制式），只导入不重复的
          const uniqueRows = validRows.filter(r => !dupMap[`${r.siteId}_${r.cellId}`])
          if (uniqueRows.length === 0) {
            return // 全部重复
          }
          addLog('upload', `批量新站录入: ${uniqueRows.length} 条（跳过 ${validRows.length - uniqueRows.length} 条重复）`, 'running', undefined, batchOpKey)
          const result = await batchAddCells(uniqueRows)
          if (result?.success && result?.data?.results) {
            const results = result.data.results as Array<{ index: number; networkType: string; cellName: string; siteId: string; cellId: string; success: boolean; message: string }>
            setBatchResults(results)
            const successCount = results.filter(r => r.success).length
            addLog('upload', `批量新站录入完成: 成功 ${successCount}/${results.length}`, successCount === results.length ? 'success' : 'warning', undefined, batchOpKey)
            setRows({ LTE: createEmptyRows(), NR: createEmptyRows() })
            setSelectedRowIds(new Set())
            setDuplicateMap({})
          }
          return
        }
      }
    } catch (_) {
      // 查重失败不影响导入
    }
```

3. 行背景色（`:1761`）改为按类型区分：

```tsx
              className={`${selectedRowIds.has(row.id) ? 'bg-blue-50/50' : ''} ${
                duplicateMap[`${row.siteId}_${row.cellId}`] === 'same' ? 'bg-red-50' :
                duplicateMap[`${row.siteId}_${row.cellId}`] === 'cross' ? 'bg-amber-50' : ''
              }`}
```

4. 其余 `setDuplicateCgiSet` 引用（`:1578` 重置、`:1712` tab 切换）统一改为 `setDuplicateMap({})` / `setDuplicateMap({})`。检查文件内所有 `duplicateCgiSet` 出现点逐一替换。

**Step 2: Type-check**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep "DataPage.tsx"`
Expected: 仅基线 4 处已知错误，无新增（`dataApi` 已在 `:4` 导入）

**Step 3: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/pages/DataPage.tsx
git commit -m "feat: 新站录入按制式分类高亮重复行（同制式红/跨制式橙）"
```

---

## Task 10: 前端——一键导入即时反馈（`importing` 状态）

**Files:**
- Modify: `frontend/src/renderer/pages/DataPage.tsx`
  - `:1397` 附近（新增 `importing` state）
  - `:1573-1574`（`handleBatchImport` 入口/`finally`）
  - `:1869-1877`（按钮）

**Step 1: Implement**

1. 新增状态（在 `expanded` state 之后）：

```typescript
  const [importing, setImporting] = useState(false) // 一键导入进行中（覆盖预查重阶段，保证即时反馈）
```

2. `handleBatchImport` 加 `importing` 守卫与 `try/finally`（`:1573-1574` 起始）：

```typescript
  const handleBatchImport = async () => {
    if (!hasFullParams || importing) return

    setImporting(true)
    try {
      // ... 现有 handleBatchImport 全部逻辑（含预查重、批量导入、各 return 分支）...
    } finally {
      setImporting(false)
    }
  }
```

> 注意：现有函数体的所有 `return` 都在 `try` 块内，`finally` 保证任何分支都会复位 `importing`。

3. 按钮（`:1869-1877`）改用 `importing` 驱动：

```tsx
          <button
            onClick={handleBatchImport}
            disabled={totalRows === 0 || importing || !hasFullParams}
            className="px-4 py-1.5 text-xs font-medium rounded-md bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
          >
            {importing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            {importing ? (t('data.saving') || '录入中...') : (t('newCellEntry.batchImport') || '一键导入')}
            {totalRows > 0 && !importing && <span className="text-blue-100">({totalRows})</span>}
          </button>
```

**Step 2: Type-check**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep "DataPage.tsx"`
Expected: 仅基线 4 处已知错误，无新增

**Step 3: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/pages/DataPage.tsx
git commit -m "feat: 一键导入即时反馈（importing 状态覆盖预查重阶段）"
```

---

## Task 11: 前端——i18n 文案（zh/en 同步）

**Files:**
- Modify: `frontend/src/renderer/locales/zh.json`
- Modify: `frontend/src/renderer/locales/en.json`

**Step 1: Add keys**（在 `newCellEntry` 区块内追加）

zh.json：

```json
  "pasteHint": "支持从 Excel 复制多行多列直接粘贴，行数不足自动扩充",
  "crossTypeDuplicate": "跨制式重复，已跳过请检查",
  "fieldMCC": "MCC",
  "fieldMNC": "MNC"
```

en.json：

```json
  "pasteHint": "Copy rows from Excel and paste directly — rows auto-extend",
  "crossTypeDuplicate": "Cross-type duplicate, skipped — please check",
  "fieldMCC": "MCC",
  "fieldMNC": "MNC"
```

> 若 `fieldMCC`/`fieldMNC` 已存在（zh 现有 key 清单已含），则仅新增 `pasteHint` 与 `crossTypeDuplicate`。

**Step 2: Verify keys balanced**（zh/en 的 `newCellEntry` 子集数量一致）

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && node -e "const z=require('./src/renderer/locales/zh.json'),e=require('./src/renderer/locales/en.json');const d=k=>Object.keys(k.newCellEntry).sort().join(',');console.log(d(z)===d(e)?'MATCH':('DIFF\nzh:'+d(z)+'\nen:'+d(e)))"`
Expected: `MATCH`

**Step 3: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json
git commit -m "feat: 新站录入粘贴/跨制式提示多语言文案"
```

---

## Task 12: 最终验证

**Step 1: Backend full suite**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/ -q 2>&1 | tail -3`
Expected: `passed`

**Step 2: Frontend type-check（相对基线）**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: 与基线一致（259），且 `grep "DataPage.tsx"` 仅 397/477/478/581 四行已知错误

**Step 3: 手工验证清单**（前端启动后 `npm run dev:web`）

1. 录入面板 LTE/NR 各默认 3 行
2. 从 Excel 复制 5 行 11 列粘贴 → 自动扩到 5 行、字段正确
3. 在 NR 面板录入已存在于 NR 工参的 CGI → 导入结果 `[NR]小区 X 已重复，信息已更新覆盖`
4. 在 LTE 面板录入已存在于 NR 工参的 CGI → 行橙框高亮，导入结果 `[LTE]小区 X 已在[NR]工参中存在，请检查`，且不导入
5. 点击一键导入 → 按钮立即进入 spinner/录入中，无延迟感
