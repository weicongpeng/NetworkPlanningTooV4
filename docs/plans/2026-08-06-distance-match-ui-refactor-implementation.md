# 批量距离匹配 UI 重构与修复 — 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 重构批量距离匹配页面为「顶层单一文件导入 + 匹配站点/全量站点各选 sheet + 数据管理读真实 sheet」，修复「匹配失败请重试」根因（`/match` 按所选 sheet 读取），并实测修复模板下载。

**Architecture:** 前端 `DistanceMatchPage.tsx` 改为单一导入框；后端 `/match` 参数从「固定两 sheet」改为 `match_sheet_name + full_source + full_sheet_name`；新增 `/data-sheets` 接口读取数据管理工参原始 Excel 的真实 sheet。匹配算法不变（网格预筛 + 向量化 haversine 已验证正确）。

**Tech Stack:** FastAPI (Python) + React 18 (TS) + pandas/calamine + openpyxl + Zustand uploadStore + axios (uploadClient)

**前置基线（已验证）:** 后端 `tests/test_distance_match_api.py` + `tests/test_distance_match_service.py` 共 51 测试全绿；前端 `DistanceMatchPage.tsx` 无 tsc 错误。

---

### Task 1: 后端 — 新增 `read_data_sheets` 服务函数 + `load_full_sites_from_data_sheet`

**Files:**
- Modify: `backend/app/services/distance_match_service.py`
- Test: `backend/tests/test_distance_match_service.py`

**Step 1: 写失败测试**

在 `backend/tests/test_distance_match_service.py` 追加：

```python
import tempfile
from pathlib import Path
import pandas as pd


def test_read_data_sheets_from_original_excel(tmp_path):
    """original.xlsx 存在时返回真实 sheet 列表"""
    from app.services.distance_match_service import read_data_sheets
    excel = tmp_path / "original.xlsx"
    with pd.ExcelWriter(excel) as w:
        pd.DataFrame({"CELL": ["A"], "LON": [1.0], "LAT": [1.0]}).to_excel(w, sheet_name="LTE Project Parameters", index=False)
        pd.DataFrame({"CELL": ["B"], "LON": [1.0], "LAT": [1.0]}).to_excel(w, sheet_name="NR Project Parameters", index=False)
    sheets, source = read_data_sheets(str(excel))
    assert source == "excel"
    assert "LTE Project Parameters" in sheets
    assert "NR Project Parameters" in sheets


def test_read_data_sheets_fallback_network(monkeypatch, tmp_path):
    """original.xlsx 缺失时兜底返回网络分表键 (LTE/NR)"""
    from app.services.distance_match_service import read_data_sheets
    from app.services import data_service as ds_mod
    monkeypatch.setattr(ds_mod.data_service, "get_data", lambda data_id: {"LTE": [{"CELL": "A"}], "NR": [{"CELL": "B"}]})
    sheets, source = read_data_sheets("non_existent_id")
    assert source == "network"
    assert sheets == ["LTE", "NR"]
```

**Step 2: 运行确认失败**

Run: `cd backend && .venv/bin/python -m pytest tests/test_distance_match_service.py::test_read_data_sheets_from_original_excel tests/test_distance_match_service.py::test_read_data_sheets_fallback_network -q`
Expected: FAIL — `ImportError: cannot import name 'read_data_sheets'`

**Step 3: 实现**

在 `backend/app/services/distance_match_service.py` 追加（放在 `read_full_sheet_only` 之后）：

```python
def read_data_sheets(excel_path: str) -> Tuple[List[str], str]:
    """读取数据管理工参原始 Excel 的真实 sheet 列表。

    返回 (sheets, source)：
    - original.xlsx 存在 → (真实 sheet 名列表, "excel")
    - 否则 → (网络分表键列表, "network")  # 兜底：data.json 已解析成 LTE/NR 分表
    """
    p = Path(excel_path)
    if p.is_file() and p.suffix.lower() in (".xlsx", ".xls"):
        try:
            xls = pd.ExcelFile(p, engine="calamine")
        except Exception:
            xls = pd.ExcelFile(p)
        return list(xls.sheet_names), "excel"
    # 兜底：网络分表键（get_data 的 dict key）
    from app.services.data_service import data_service
    data = data_service.get_data(Path(excel_path).parent.name)
    if isinstance(data, dict):
        keys = [k for k in data.keys() if isinstance(k, str) and k not in ("id", "name", "fileType", "status", "errorMessage", "message")]
        if keys:
            return keys, "network"
    return ["LTE", "NR"], "network"
```

在 `backend/app/services/distance_match_service.py` 追加（放在 `load_full_sites_from_data` 之后）：

```python
def load_full_sites_from_data_sheet(
    data_id: str,
    sheet_name: str,
    name_col: str = None,
    lon_col: str = None,
    lat_col: str = None,
) -> pd.DataFrame:
    """从数据管理工参的原始 Excel 读取指定 sheet 作为全量站点。

    优先 data/{data_id}/original.xlsx 的真实 sheet；文件缺失时回退
    load_full_sites_from_data（JSON 分表 + 列映射）。返回 [CELL, LON, LAT] 去重。"""
    data_dir = settings.DATA_DIR / data_id
    original = data_dir / "original.xlsx"
    if original.is_file():
        # 列名以所选 sheet 的列名为准（覆盖 load_full_sites 的自动识别）
        return read_arbitrary_sheet(str(original), sheet_name, name_col, lon_col, lat_col)
    # 回退：网络类型分表（sheet_name 即网络类型，如 LTE/NR）
    return load_full_sites_from_data(data_id, sheet_name, name_col, lon_col, lat_col)
```

注意：需在文件顶部确认 `settings` 已导入（当前服务文件未 import settings，`load_full_sites_from_data_sheet` 需要）。若未导入，加 `from app.core.config import settings`。

**Step 4: 运行确认通过**

Run: `cd backend && .venv/bin/python -m pytest tests/test_distance_match_service.py -q`
Expected: PASS（新增 2 个 + 原有全部）

**Step 5: Commit**

```bash
git add backend/app/services/distance_match_service.py backend/tests/test_distance_match_service.py
git commit -m "feat: 距离匹配服务新增数据管理原始Excel sheet读取 + 兜底网络分表"
```

---

### Task 2: 后端 — 新增 `/data-sheets` 端点

**Files:**
- Modify: `backend/app/api/v1/endpoints/distance_match.py`
- Test: `backend/tests/test_distance_match_api.py`

**Step 1: 写失败测试**

在 `backend/tests/test_distance_match_api.py` 追加：

```python
def test_data_sheets_endpoint(tmp_path, monkeypatch):
    """data-sheets 返回原始 Excel 真实 sheet"""
    client = _make_client()
    from app.core.config import settings
    from app.services import distance_match_service as dms

    excel = tmp_path / "original.xlsx"
    with pd.ExcelWriter(excel) as w:
        pd.DataFrame({"CELL": ["A"], "LON": [1.0], "LAT": [1.0]}).to_excel(w, sheet_name="LTE Project Parameters", index=False)
        pd.DataFrame({"CELL": ["B"], "LON": [1.0], "LAT": [1.0]}).to_excel(w, sheet_name="NR Project Parameters", index=False)
    monkeypatch.setattr(dms.settings.DATA_DIR, "__truediv__", lambda self, other: excel.parent if str(other) == "d1" else settings.DATA_DIR / other)
    # 更直接：monkeypatch DATA_DIR 子路径读取
    resp = client.post("/api/v1/distance-match/data-sheets", data={"data_id": "d1"})
    # 该测试需 mock DATA_DIR；简化断言路径在 Step 3 实现后重写
```

> 注：由于 `DATA_DIR` 是 Settings 属性且子路径构造较绕，此测试改为 **monkeypatch `data_service.get_data` 返回分表 + 直接调服务函数** 验证兜底，真实 sheet 读取用 Task 1 的服务层测试覆盖。端点测试如下：

```python
def test_data_sheets_endpoint_fallback(monkeypatch):
    """data-sheets 在 original 缺失时兜底返回网络分表"""
    client = _make_client()
    from app.services import data_service as ds_mod
    from app.services import distance_match_service as dms
    monkeypatch.setattr(ds_mod.data_service, "get_data", lambda data_id: {"LTE": [{"CELL": "A"}], "NR": [{"CELL": "B"}]})
    monkeypatch.setattr(dms.settings, "DATA_DIR", None)  # 强制走兜底路径（服务内部再判断）
    resp = client.post("/api/v1/distance-match/data-sheets", data={"data_id": "d1"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["data"]["source"] == "network"
    assert set(body["data"]["sheets"]) == {"LTE", "NR"}
```

**Step 2: 运行确认失败**

Run: `cd backend && .venv/bin/python -m pytest tests/test_distance_match_api.py::test_data_sheets_endpoint_fallback -q`
Expected: FAIL — 404 (路由不存在)

**Step 3: 实现**

在 `backend/app/api/v1/endpoints/distance_match.py` 的 router 定义后追加：

```python
@router.post("/data-sheets")
async def data_sheets(
    data_id: str = Form(...),
    current_user=Depends(require_data_import),
):
    """返回数据管理工参原始 Excel 的真实 sheet 列表（缺失时兜底网络分表）"""
    try:
        data_dir = settings.DATA_DIR / data_id
        original = data_dir / "original.xlsx"
        if original.is_file():
            sheets = await run_in_threadpool(_sheet_names_of, str(original))
            return {"success": True, "data": {"sheets": sheets, "source": "excel"}}
        # 兜底：网络分表键
        from app.services.data_service import data_service
        data = data_service.get_data(data_id)
        if isinstance(data, dict):
            keys = [k for k in data.keys() if isinstance(k, str) and k not in ("id", "name", "fileType", "status", "errorMessage", "message")]
            if keys:
                return {"success": True, "data": {"sheets": keys, "source": "network"}}
        return {"success": True, "data": {"sheets": ["LTE", "NR"], "source": "network"}}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取数据工作表失败: {str(e)}")
```

并在模块内加辅助函数（复用服务层读取逻辑，避免重复）：

```python
def _sheet_names_of(excel_path: str) -> list:
    import pandas as pd
    try:
        xls = pd.ExcelFile(excel_path, engine="calamine")
    except Exception:
        xls = pd.ExcelFile(excel_path)
    return list(xls.sheet_names)
```

**Step 4: 运行确认通过**

Run: `cd backend && .venv/bin/python -m pytest tests/test_distance_match_api.py -q`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/api/v1/endpoints/distance_match.py backend/tests/test_distance_match_api.py
git commit -m "feat: 距离匹配新增 data-sheets 端点（数据管理原始Excel真实sheet）"
```

---

### Task 3: 后端 — `/match` 端点参数改造（按所选 sheet 读取）

**Files:**
- Modify: `backend/app/api/v1/endpoints/distance_match.py`
- Test: `backend/tests/test_distance_match_api.py`

**Step 1: 写失败测试**

替换 `test_match_valid` 为按所选 sheet 的调用，并新增单 sheet 自匹配测试。在文件末尾追加：

```python
def test_match_by_sheet_upload():
    """full_source=file：匹配站点与全量站点从同一导入文件各选 sheet"""
    tmp = tempfile.mktemp(suffix=".xlsx")
    with pd.ExcelWriter(tmp) as w:
        pd.DataFrame([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}]).to_excel(w, sheet_name="匹配站点", index=False)
        pd.DataFrame([{"CELL": "F1", "LON": 116.001, "LAT": 39.0}]).to_excel(w, sheet_name="全量站点", index=False)
    client = _make_client()
    try:
        resp = client.post(
            "/api/v1/distance-match/match",
            data={
                "max_distance_km": "1.0",
                "file_path": tmp,
                "match_sheet_name": "匹配站点",
                "full_source": "file",
                "full_sheet_name": "全量站点",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["data"]["filename"].startswith("匹配结果")
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def test_match_by_sheet_single_sheet():
    """单 sheet 文件：匹配站点与全量站点指向同一 sheet（匹配清单即全量池）"""
    tmp = tempfile.mktemp(suffix=".xlsx")
    with pd.ExcelWriter(tmp) as w:
        pd.DataFrame([{"CELL": "A", "LON": 116.0, "LAT": 39.0},
                      {"CELL": "B", "LON": 116.001, "LAT": 39.0}]).to_excel(w, sheet_name="工参", index=False)
    client = _make_client()
    try:
        resp = client.post(
            "/api/v1/distance-match/match",
            data={
                "max_distance_km": "1.0",
                "file_path": tmp,
                "match_sheet_name": "工参",
                "full_source": "file",
                "full_sheet_name": "工参",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["success"] is True
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def test_match_by_sheet_data_source(monkeypatch):
    """full_source=data：从数据管理原始Excel读指定 sheet（mock original.xlsx 存在）"""
    tmp = tempfile.mktemp(suffix=".xlsx")
    with pd.ExcelWriter(tmp) as w:
        pd.DataFrame([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}]).to_excel(w, sheet_name="匹配站点", index=False)
    client = _make_client()
    from app.services import distance_match_service as dms
    import pathlib
    original = tempfile.mktemp(suffix=".xlsx")
    with pd.ExcelWriter(original) as w:
        pd.DataFrame([{"CELL": "F1", "LON": 116.001, "LAT": 39.0}]).to_excel(w, sheet_name="LTE工参", index=False)
    # mock settings.DATA_DIR / data_id / original.xlsx 存在
    monkeypatch.setattr(dms.settings, "DATA_DIR", pathlib.Path(original).parent)
    monkeypatch.setattr(dms.settings.DATA_DIR, "__truediv__", lambda self, other: pathlib.Path(original) if other == "d1/original.xlsx" else pathlib.Path(original).parent / other)
    try:
        resp = client.post(
            "/api/v1/distance-match/match",
            data={
                "max_distance_km": "1.0",
                "file_path": tmp,
                "match_sheet_name": "匹配站点",
                "full_source": "data",
                "full_data_id": "d1",
                "full_sheet_name": "LTE工参",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["success"] is True
    finally:
        for p in (tmp, original):
            if os.path.exists(p):
                os.unlink(p)
```

> 注：`test_match_by_sheet_data_source` 对 `DATA_DIR / "d1/original.xlsx"` 的 mock 较绕。若实现阶段 mock 复杂，可改为直接 monkeypatch `load_full_sites_from_data_sheet` 返回构造 df，断言端点正确调用。以最简实现为准。

**Step 2: 运行确认失败**

Run: `cd backend && .venv/bin/python -m pytest tests/test_distance_match_api.py::test_match_by_sheet_upload -q`
Expected: FAIL — 400 (缺少 file 或旧签名参数未提供)

**Step 3: 实现 — 重写 `/match` 端点**

将 `distance_match.py` 的 `/match` 端点改为：

```python
@router.post("/match")
async def match(
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    match_sheet_name: Optional[str] = Form(None),
    max_distance_km: float = Form(...),
    full_source: str = Form("file"),
    full_sheet_name: Optional[str] = Form(None),
    full_data_id: Optional[str] = Form(None),
    full_name_col: Optional[str] = Form(None),
    full_lon_col: Optional[str] = Form(None),
    full_lat_col: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
):
    """执行批量距离匹配，返回下载 URL（按所选 sheet 读取）"""
    tmp, is_tmp = None, False
    try:
        if max_distance_km <= 0:
            raise HTTPException(status_code=400, detail="相邻距离门限必须大于 0")
        if not match_sheet_name:
            raise HTTPException(status_code=400, detail="请选择匹配站点工作表")
        if not full_sheet_name:
            raise HTTPException(status_code=400, detail="请选择全量站点工作表")

        # 导入文件（匹配站点来源）
        tmp, is_tmp = _resolve_list_file(file, file_path)
        match_df = await run_in_threadpool(read_arbitrary_sheet, tmp, match_sheet_name)

        # 全量站点来源
        if full_source == "data":
            if not full_data_id:
                raise HTTPException(status_code=400, detail="数据管理来源需选择数据文件")
            full_df = await run_in_threadpool(
                load_full_sites_from_data_sheet,
                full_data_id, full_sheet_name,
                full_name_col, full_lon_col, full_lat_col,
            )
        else:
            # file：从同一导入文件选 sheet
            full_df = await run_in_threadpool(read_arbitrary_sheet, tmp, full_sheet_name)

        # 校验（两种来源统一）
        errors = validate_all(match_df, full_df)
        if errors:
            return {"success": False, "data": {"errors": errors}}

        results, unmatched = await run_in_threadpool(match_sites, match_df, full_df, max_distance_km)

        settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        filename = build_output_filename()
        out_path = settings.OUTPUT_DIR / filename
        await run_in_threadpool(build_output_excel, str(out_path), match_df, results, unmatched)

        return {"success": True, "data": {"filename": filename, "download_url": f"/static/{filename}"}}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"匹配失败: {str(e)}")
    finally:
        if is_tmp and tmp:
            Path(tmp).unlink(missing_ok=True)
```

更新导入语句：`read_full_sheet_only` 可保留（未用）或移除；`load_full_sites_from_data` 保留（`load_full_sites_from_data_sheet` 内部调用）；新增 `load_full_sites_from_data_sheet` 导入。

**Step 4: 运行确认通过 + 全量回归**

Run: `cd backend && .venv/bin/python -m pytest tests/test_distance_match_api.py tests/test_distance_match_service.py -q`
Expected: PASS（新增测试 + 原有 51 个——注意旧的 `test_match_full_file_path` / `test_match_full_data_id` 等测试的旧参数签名不再匹配，需在 Task 4 迁移或删除）

**Step 5: Commit**

```bash
git add backend/app/api/v1/endpoints/distance_match.py backend/tests/test_distance_match_api.py
git commit -m "feat: 距离匹配 /match 按所选sheet读取（修复固定sheet名根因）"
```

---

### Task 4: 后端 — 迁移/删除旧的固定-sheet 测试

**Files:**
- Modify: `backend/tests/test_distance_match_api.py`

**Step 1: 审查旧测试**

旧测试使用 `file`（含两 sheet 的清单）+ 无 `match_sheet_name` 的调用，Task 3 改造后不再匹配新签名。逐项处理：
- `test_match_valid` → 改为新签名（`file_path` + `match_sheet_name="匹配站点"` + `full_source="file"` + `full_sheet_name="全量站点"`）
- `test_match_invalid_threshold` → 保留（门限校验不变）
- `test_match_full_file_path` → **删除**（`full_file_path` 参数已被 `full_source` 取代）
- `test_match_full_data_id` → **改为** `full_source="data"` + `full_sheet_name="LTE"`（mock `get_data` 返回分表，走兜底路径）
- `test_match_file_path_non_upload` → 改为新签名
- `test_match_output_file_written` → 改为新签名
- `test_match_full_file_path_with_sheet` → **改为** `full_source="file"` + `full_sheet_name="LTE工参"`（读同一导入文件任意 sheet）
- `test_match_full_data_id_sector_expand` / `test_match_full_data_id_geo_list` → 改为 `full_source="data"` + 相应 `full_sheet_name`
- `test_parse_*` → 保留（`/parse` 端点向后兼容）

**Step 2: 逐个修改测试断言新签名**

Run: `cd backend && .venv/bin/python -m pytest tests/test_distance_match_api.py -q`
Expected: 逐个 FAIL 后逐一修复，最终 PASS

**Step 3: Commit**

```bash
git add backend/tests/test_distance_match_api.py
git commit -m "test: 迁移距离匹配测试到按所选sheet的新签名"
```

---

### Task 5: 前端 — api.ts 改造（match 新签名 + getDataSheets）

**Files:**
- Modify: `frontend/src/renderer/services/api.ts`

**Step 1: 改 `match` 签名**

将 `distanceMatchApi.match` 参数改为：

```ts
match: async (params: {
  filePath: string
  matchSheetName: string
  maxDistanceKm: number
  fullSource: 'file' | 'data'
  fullSheetName: string
  fullDataId?: string
  fullNameCol?: string
  fullLonCol?: string
  fullLatCol?: string
}): Promise<DistanceMatchResult> => {
  const formData = new FormData()
  formData.append('file_path', params.filePath)
  formData.append('match_sheet_name', params.matchSheetName)
  formData.append('max_distance_km', String(params.maxDistanceKm))
  formData.append('full_source', params.fullSource)
  formData.append('full_sheet_name', params.fullSheetName)
  if (params.fullDataId) {
    formData.append('full_data_id', params.fullDataId)
    formData.append('full_name_col', params.fullNameCol || '')
    formData.append('full_lon_col', params.fullLonCol || '')
    formData.append('full_lat_col', params.fullLatCol || '')
  }
  const res = await uploadClient.post('/distance-match/match', formData)
  return res.data
}
```

**Step 2: 新增 `getDataSheets`**

在 `distanceMatchApi` 对象内加：

```ts
// 读取数据管理工参原始 Excel 的真实 sheet 列表（缺失时兜底网络分表）
getDataSheets: async (dataId: string): Promise<ApiResponse<{ sheets: string[]; source: 'excel' | 'network' }>> => {
  const formData = new FormData()
  formData.append('data_id', dataId)
  const res = await uploadClient.post('/distance-match/data-sheets', formData)
  return res.data
},
```

**Step 3: 类型检查**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -E "DistanceMatchPage|api\.ts"`
Expected: 无新增 error（`api.ts` 既有 2 个 error 与本次改动无关）

**Step 4: Commit**

```bash
git add frontend/src/renderer/services/api.ts
git commit -m "feat: 距离匹配前端 API 改造（按所选sheet + data-sheets）"
```

---

### Task 6: 前端 — DistanceMatchPage 重构

**Files:**
- Modify: `frontend/src/renderer/pages/DistanceMatchPage.tsx`
- Modify: `frontend/src/renderer/locales/zh.json`、`frontend/src/renderer/locales/en.json`

**Step 1: 重构页面 JSX（顶层单一导入 + 匹配站点/全量站点 sheet 下拉）**

整体结构：

```tsx
// ① 文件导入（顶层）
<div className="mb-6 p-4 bg-card border border-border rounded-lg">
  <p className="text-xs font-medium mb-3 flex items-center gap-2">
    <FileUp size={14} /> {t('distanceMatch.fileImport')}
    <button onClick={handleDownloadTemplate} className="ml-auto text-xs text-primary hover:underline">
      {t('distanceMatch.templateDownload')}
    </button>
  </p>
  {/* 单一上传框 */}
  <label className="block flex items-center gap-3 px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer hover:border-primary transition-colors">
    <UploadCloud className="text-muted-foreground shrink-0" size={20} />
    <span className="text-sm truncate flex-1">{fileName || t('distanceMatch.uploadHint')}</span>
    <input type="file" className="hidden" accept=".xlsx,.xls"
      onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} disabled={uploading} />
  </label>
  {/* 上传进度条（复用 uploadStore） */}
  {uploading && uploadProgress.percent > 0 && (
    <div className="mt-2">
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className="h-full bg-primary transition-all duration-300" style={{ width: `${uploadProgress.percent}%` }} />
      </div>
      <p className="text-xs text-muted-foreground mt-1">{progressText()}</p>
    </div>
  )}
</div>

{/* ② 数据选择 */}
<div className="mb-6 p-4 bg-card border border-border rounded-lg">
  <p className="text-xs font-medium mb-3 flex items-center gap-2">
    <Database size={14} /> {t('distanceMatch.dataSelect')}
  </p>

  {/* 匹配站点 */}
  <div className="mb-4">
    <p className="text-xs font-medium mb-2">{t('distanceMatch.matchSite')}</p>
    {sheetList.length > 0 && (
      <div className="max-w-xs">
        <label htmlFor="dm-match-sheet" className="block text-xs text-muted-foreground mb-1">{t('distanceMatch.sheetName')}</label>
        <select id="dm-match-sheet" value={matchSheet} onChange={e => setMatchSheet(e.target.value)}
          className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
          {sheetList.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
    )}
  </div>

  {/* 全量站点 */}
  <div>
    <p className="text-xs font-medium mb-2 flex items-center gap-1.5">
      <Database size={13} /> {t('distanceMatch.fullSite')}
    </p>
    <div className="flex gap-4 mb-3">
      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
        <input type="radio" checked={fullSource === 'file'} onChange={() => setFullSource('file')} />
        {t('distanceMatch.fullSourceFile')}
      </label>
      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
        <input type="radio" checked={fullSource === 'data'} onChange={() => setFullSource('data')} />
        {t('distanceMatch.fullSourceData')}
      </label>
    </div>

    {fullSource === 'file' ? (
      sheetList.length > 0 && (
        <div className="max-w-xs">
          <label htmlFor="dm-full-sheet" className="block text-xs text-muted-foreground mb-1">{t('distanceMatch.sheetName')}</label>
          <select id="dm-full-sheet" value={fullSheet} onChange={e => setFullSheet(e.target.value)}
            className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
            {sheetList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      )
    ) : (
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="dm-data-file" className="block text-xs font-medium mb-1">{t('distanceMatch.dataFile')}</label>
          <select id="dm-data-file" value={fullDataId} onChange={e => { setFullDataId(e.target.value); setDataSheets([]) }}
            className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
            {dataItems.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="dm-data-sheet" className="block text-xs font-medium mb-1">{t('distanceMatch.sheetName')}</label>
          <select id="dm-data-sheet" value={fullSheet} onChange={e => setFullSheet(e.target.value)}
            className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
            {dataSheets.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="dm-name-col" className="block text-xs font-medium mb-1">{t('distanceMatch.nameCol')}</label>
          <select id="dm-name-col" value={nameCol} onChange={e => setNameCol(e.target.value)}
            className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
            {columns.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="dm-lon-col" className="block text-xs font-medium mb-1">{t('distanceMatch.lonCol')}</label>
          <select id="dm-lon-col" value={lonCol} onChange={e => setLonCol(e.target.value)}
            className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
            {columns.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="dm-lat-col" className="block text-xs font-medium mb-1">{t('distanceMatch.latCol')}</label>
          <select id="dm-lat-col" value={latCol} onChange={e => setLatCol(e.target.value)}
            className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
            {columns.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
    )}
  </div>
</div>
```

**Step 2: 实现处理函数**

```tsx
const handleFile = async (f: File) => {
  setParseErrors([]); setError(''); setResult(null)
  setSheetList([]); setMatchSheet(''); setFullSheet('')
  uploadStore._set({ active: true, percent: 1, step: 'uploading', sessionId: '', fileName: f.name })
  try {
    const up = await layerToolsApi.uploadLayerFile(f)
    setFilePath(up.file_path)
    setFileName(f.name)
    uploadStore._set({ active: true, percent: 100, step: 'reading', sessionId: '', fileName: f.name })
    const info = await layerToolsApi.getExcelInfo(up.file_path, f.name)
    if (info?.sheets?.length) {
      setSheetList(info.sheets)
      // 默认预选：匹配站点←含「匹配站点」，全量站点←含「全量站点」或 sheets[1]||sheets[0]
      const find = (kw: string, fallbackIdx: number) =>
        info.sheets.find(s => s.includes(kw)) || info.sheets[fallbackIdx] || info.sheets[0] || ''
      setMatchSheet(find('匹配站点', 0))
      setFullSheet(find('全量站点', 1))
    }
  } catch (e: any) {
    if (e?.message === '已取消') { uploadStore._set({ active: false }); return }
    setError(e?.message || String(e))
  } finally { uploadStore._set({ active: false }) }
}
```

数据管理来源 sheet 加载（`fullSource === 'data'` 且 `fullDataId` 变化时）：

```tsx
useEffect(() => {
  if (fullSource !== 'data' || !fullDataId) { setDataSheets([]); setFullSheet(''); return }
  let cancelled = false
  distanceMatchApi.getDataSheets(fullDataId).then(res => {
    if (cancelled) return
    if (res.success && res.data?.sheets?.length) {
      setDataSheets(res.data.sheets)
      const pre = res.data.source === 'network'
        ? res.data.sheets.find(s => s.toUpperCase() === networkType.toUpperCase()) || res.data.sheets[0]
        : res.data.sheets[0]
      setFullSheet(pre || '')
    }
  }).catch(() => { if (!cancelled) { setDataSheets([]); setFullSheet('') } })
  return () => { cancelled = true }
}, [fullSource, fullDataId])
```

数据文件列加载（复用现有 `dataApi.getColumns` + `autoPick`，在 data 来源时）：

```tsx
useEffect(() => {
  if (fullSource !== 'data' || !fullDataId) { setColumns([]); resetMapping(); return }
  const reqId = ++colReqRef.current
  const fileChanged = autoPickFileRef.current !== fullDataId
  dataApi.getColumns(fullDataId, networkType).then(res => {
    if (reqId !== colReqRef.current) return
    if (res.success && res.data?.columns) {
      setColumns(res.data.columns)
      if (fileChanged) { autoPick(res.data.columns); autoPickFileRef.current = fullDataId }
    } else { setColumns([]); resetMapping() }
  }).catch(() => { if (reqId === colReqRef.current) { setColumns([]); resetMapping() } })
}, [fullSource, fullDataId, networkType])
```

`handleMatch` 改造：

```tsx
const handleMatch = async () => {
  setError(''); setResult(null)
  const km = parseFloat(maxDistanceKm)
  if (!filePath) { setError(t('distanceMatch.errNoFile') || '请先导入文件'); return }
  if (!matchSheet) { setError(t('distanceMatch.errSheet') || '请选择匹配站点工作表'); return }
  if (!(km > 0)) { setError(t('distanceMatch.errThreshold') || '请输入大于 0 的距离门限'); return }
  if (fullSource === 'file' && !fullSheet) { setError(t('distanceMatch.errSheet') || '请选择全量站点工作表'); return }
  if (fullSource === 'data' && (!fullDataId || !fullSheet)) {
    setError(t('distanceMatch.errMapping') || '请选择数据文件并选择工作表'); return
  }

  setMatching(true)
  try {
    const res = await distanceMatchApi.match({
      filePath,
      matchSheetName: matchSheet,
      maxDistanceKm: km,
      fullSource,
      fullSheetName: fullSheet,
      fullDataId: fullSource === 'data' ? fullDataId : undefined,
      fullNameCol: fullSource === 'data' ? nameCol : undefined,
      fullLonCol: fullSource === 'data' ? lonCol : undefined,
      fullLatCol: fullSource === 'data' ? latCol : undefined,
    })
    if (res.success && res.data?.download_url) {
      setResult({ filename: res.data.filename, download_url: res.data.download_url })
    } else if (res.data?.errors?.length) {
      setParseErrors(res.data.errors)
    } else {
      setError(t('distanceMatch.errUnknown') || '匹配失败，请重试')
    }
  } catch (e: any) {
    setError(e?.message || String(e))
  } finally { setMatching(false) }
}
```

**Step 3: i18n 同步**

`zh.json` 的 `distanceMatch` 对象调整：
- 保留：`fileImport`、`templateDownload`、`uploadHint`、`params`、`maxDistance`、`start`、`download`、`matchDone`、`invalidData`、`sheet`、`row`、`reason`、`more`、`loadDataErr`、`errNoFile`、`errThreshold`、`errMapping`、`errFixImport`、`errUnknown`、`dataSelect`、`fullSite`、`matchSite`、`sheetName`、`dataFile`、`networkType`、`nameCol`、`lonCol`、`latCol`、`templateDownloadErr`、`errSheet`
- 新增：`fullSourceFile`: "导入文件"、`fullSourceData`: "数据管理"
- 移除（不再使用）：`matchFile`、`fullSource`、`fullUpload`、`fullData`、`uploadTab`、`dataTab`、`errNoFullFile`

`en.json` 同步英文：
- `fullSourceFile`: "Imported File"、`fullSourceData`: "Data Manager"

**Step 4: 类型检查 + 验证**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -E "DistanceMatchPage|api\.ts"`
Expected: 无新增 error

Run: `cd frontend && npm run lint 2>&1 | grep -E "DistanceMatchPage"`（如有 lint）
Expected: 无 error

**Step 5: Commit**

```bash
git add frontend/src/renderer/pages/DistanceMatchPage.tsx frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json
git commit -m "feat: 距离匹配页面重构（顶层单一导入+按sheet选择+数据管理sheet）"
```

---

### Task 7: 前端 — 实测模板下载并修复（如仍无反应）

**Files:**
- Modify: `frontend/src/renderer/services/api.ts`（可能）
- 无测试（前端手动验证）

**Step 1: 检查现有 blob 下载链路**

当前 `downloadTemplate` 用 `uploadClient.get(..., {responseType:'blob'})`，其响应拦截器返回 `response.data`（blob 响应时即 Blob）。理论上可行。若用户环境仍「无反应」，常见原因：
1. blob URL 未触发下载（`link.click()` 在微任务外）
2. 认证失败静默（401 → 拦截器 reject，但 `catch` 里 `setError` 应显示）

**Step 2: 加固实现（防御性重写）**

```ts
downloadTemplate: async (): Promise<void> => {
  const res = await uploadClient.get('/distance-match/template', { responseType: 'blob' })
  // uploadClient 拦截器返回 response.data（blob 响应时即 Blob）；兼容 res 可能是完整响应
  const blob = (res as any)?.data instanceof Blob ? (res as any).data : (res as Blob)
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error('模板下载失败：文件内容为空')
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = '站点匹配清单-模板.xlsx'
  document.body.appendChild(link)
  link.click()
  setTimeout(() => {
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
  }, 100)
}
```

**Step 3: 手动验证**

启动后端 + 前端，点击「模版下载」，确认浏览器下载 `站点匹配清单-模板.xlsx`。若仍失败，检查浏览器 Network 面板该请求的状态码/响应体。

**Step 4: Commit**

```bash
git add frontend/src/renderer/services/api.ts
git commit -m "fix: 距离匹配模板下载 blob 链路加固"
```

---

### Task 8: 全量回归验证

**Files:** 无（仅验证）

**Step 1: 后端全量测试**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: 全部 PASS（含新增 + 迁移）

**Step 2: 前端类型检查**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -E "DistanceMatchPage|api\.ts"`
Expected: 无新增 error

**Step 3: 手动端到端验证**

1. 打开「批量距离匹配」页面
2. 点「模版下载」→ 浏览器下载模板
3. 导入含「匹配站点」「全量站点」两 sheet 的文件 → 预选 sheet 正确
4. 切换全量站点来源为「数据管理」→ 选数据文件 → sheet 下拉出现真实 sheet
5. 填门限 1.0 → 开始匹配 → 成功 → 下载结果 xlsx 可打开
6. 导入只有单个 sheet 的文件 → 匹配站点/全量站点都选该 sheet → 匹配成功

**Step 4: 报告结果**

汇总测试结果与手动验证结论。

---

## 完成标准

- 后端 `pytest -q` 全绿（51 原有 + 新增/迁移）
- 前端 `tsc --noEmit` 无 DistanceMatchPage/api.ts 新增错误
- 手动验证：模板下载、导入预选 sheet、数据管理 sheet 选择、匹配、下载 全流程
- 设计文档 `docs/plans/2026-08-06-distance-match-ui-refactor-design.md` 已与实现一致
