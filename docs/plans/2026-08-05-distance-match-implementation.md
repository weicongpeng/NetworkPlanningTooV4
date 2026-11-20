# 批量距离匹配 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在项目中新增「批量距离匹配」功能：用户上传匹配站点清单（或从数据管理选全量工参），按 km 距离门限输出 8 列 xlsx 匹配结果。

**Architecture:** 后端新增 `distance_match_service.py`（网格预筛 + haversine 匹配 + xlsx 输出）和 `distance_match.py` 端点（`/api/v1/distance-match`: `/parse` `/match` `/template`），复用现有分块上传（`file_type="layer"`）与 `/static/` 静态挂载。前端新增 `DistanceMatchPage.tsx`（文件导入/参数设置/开始匹配/结果下载），路由 `/distance-match`，侧边栏 + 首页入口，i18n 双语。

**Tech Stack:** Python/FastAPI/pandas/openpyxl、React 18/TypeScript/Zustand/Radix UI、i18next

---

## 前置：模板文件与共享类型

### Task 0: 复制模板文件到 backend/template

**Files:**
- Create: `backend/template/站点匹配清单-模板.xlsx`（从 `/home/pwc/NetworkPlanningTooV3/批量距离匹配脚本/站点匹配清单-模板.xlsx` 复制）

**Step 1: 复制模板**

```bash
mkdir -p /home/pwc/NetworkPlanningTooV3/backend/template
cp "/home/pwc/NetworkPlanningTooV3/批量距离匹配脚本/站点匹配清单-模板.xlsx" "/home/pwc/NetworkPlanningTooV3/backend/template/站点匹配清单-模板.xlsx"
```

**Step 2: 验证可解析**

```bash
python3 -c "import openpyxl; wb=openpyxl.load_workbook('/home/pwc/NetworkPlanningTooV3/backend/template/站点匹配清单-模板.xlsx'); print(wb.sheetnames)"
```
Expected: `['全量站点', '匹配站点']`

**Step 3: Commit**

```bash
git add backend/template/站点匹配清单-模板.xlsx
git commit -m "feat: 添加批量距离匹配模板文件"
```

---

## 后端

### Task 1: 距离匹配服务（核心算法 + 校验 + xlsx）

**Files:**
- Create: `backend/app/services/distance_match_service.py`
- Test: `backend/tests/test_distance_match_service.py`

**Step 1: 写失败测试**

```python
# backend/tests/test_distance_match_service.py
import math
import os
import pandas as pd
import tempfile
from openpyxl import load_workbook

from app.services.distance_match_service import (
    haversine_km,
    match_sites,
    validate_sheet,
    build_output_excel,
)


def _df(data):
    return pd.DataFrame(data, columns=["CELL", "LON", "LAT"])


def test_haversine_known_distance():
    """北京天安门 (116.397, 39.908) → 向北 1 度 (116.397, 40.908) 约 111.2 km"""
    d = haversine_km(116.397, 39.908, 116.397, 40.908)
    assert 110.0 < d < 113.0, f"实际 {d}"


def test_haversine_zero():
    assert haversine_km(116.0, 39.0, 116.0, 39.0) == 0.0


def test_match_basic():
    match = _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}])
    full = _df([
        {"CELL": "F1", "LON": 116.001, "LAT": 39.0},   # ~0.1km
        {"CELL": "F2", "LON": 116.1, "LAT": 39.0},      # ~11km
    ])
    results, unmatched = match_sites(match, full, max_distance_km=1.0)
    assert len(results) == 1
    assert results[0][0] == "M1" and results[0][3] == "F1"
    assert results[0][6] < 1.0
    assert unmatched == []


def test_match_multiple_hits():
    match = _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}])
    full = _df([
        {"CELL": "F1", "LON": 116.0005, "LAT": 39.0},
        {"CELL": "F2", "LON": 116.001, "LAT": 39.0},
    ])
    results, unmatched = match_sites(match, full, max_distance_km=1.0)
    assert len(results) == 2  # 多命中全部输出


def test_match_unmatched_note():
    match = _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}])
    full = _df([{"CELL": "F1", "LON": 116.5, "LAT": 39.5}])
    results, unmatched = match_sites(match, full, max_distance_km=1.0)
    assert results == []
    assert unmatched == ["M1"]


def test_match_boundary():
    """恰好在门限上（≈门限）应命中；门外不应命中"""
    match = _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}])
    # 1 度纬度 ≈ 111.19 km，0.01 度 ≈ 1.1119 km
    full = _df([{"CELL": "F1", "LON": 116.0, "LAT": 39.005}])  # ~0.556km
    results, _ = match_sites(match, full, max_distance_km=0.6)
    assert len(results) == 1
    results2, _ = match_sites(match, full, max_distance_km=0.5)
    assert len(results2) == 0


def test_validate_sheet_ok():
    df = _df([{"CELL": "A", "LON": 116.0, "LAT": 39.0}])
    errors = validate_sheet(df, "匹配站点")
    assert errors == []


def test_validate_sheet_invalid_lon():
    df = _df([{"CELL": "A", "LON": 999.0, "LAT": 39.0}])
    errors = validate_sheet(df, "匹配站点")
    assert len(errors) == 1
    assert "经度" in errors[0]["reason"]


def test_validate_sheet_non_numeric():
    df = _df([{"CELL": "A", "LON": "abc", "LAT": 39.0}])
    errors = validate_sheet(df, "匹配站点")
    assert len(errors) == 1
    assert "无效" in errors[0]["reason"]


def test_validate_sheet_empty_cell():
    df = _df([{"CELL": None, "LON": 116.0, "LAT": 39.0}])
    errors = validate_sheet(df, "匹配站点")
    assert len(errors) == 1
    assert "名称" in errors[0]["reason"]


def test_build_output_excel_columns_and_unmatched():
    """输出列名 8 列；无命中行备注正确；文件可解析"""
    match = _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}])
    full = _df([{"CELL": "F1", "LON": 116.001, "LAT": 39.0}])
    results, unmatched = match_sites(match, full, max_distance_km=1.0)
    out = tempfile.mktemp(suffix=".xlsx")
    build_output_excel(out, match, results, unmatched)
    wb = load_workbook(out)
    ws = wb["匹配结果"]
    headers = [c.value for c in ws[1]]
    assert headers == [
        "匹配站点名称", "匹配站点经度", "匹配站点纬度",
        "全量站点名称", "全量站点经度", "全量站点纬度",
        "距离（km）", "备注",
    ]
    assert ws.max_row == 2  # 1 头 + 1 命中
    os.unlink(out)


def test_build_output_excel_unmatched_row():
    match = _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}])
    full = _df([{"CELL": "F1", "LON": 116.5, "LAT": 39.5}])
    results, unmatched = match_sites(match, full, max_distance_km=1.0)
    out = tempfile.mktemp(suffix=".xlsx")
    build_output_excel(out, match, results, unmatched)
    wb = load_workbook(out)
    ws = wb["匹配结果"]
    row2 = [c.value for c in ws[2]]
    assert row2[0] == "M1"
    assert row2[3] is None and row2[6] is None
    assert row2[7] == "无匹站点匹配"
    os.unlink(out)
```

**Step 2: 运行确认失败**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && python -m pytest tests/test_distance_match_service.py -v`
Expected: FAIL（`ModuleNotFoundError: No module named 'app.services.distance_match_service'`）

**Step 3: 实现服务**

```python
# backend/app/services/distance_match_service.py
"""批量距离匹配服务：网格预筛 + haversine + xlsx 输出"""
import math
from typing import List, Dict, Tuple

import numpy as np
import pandas as pd
from openpyxl import Workbook

# 输出列名（固定，含备注）
OUTPUT_COLUMNS = [
    "匹配站点名称", "匹配站点经度", "匹配站点纬度",
    "全量站点名称", "全量站点经度", "全量站点纬度",
    "距离（km）", "备注",
]
UNMATCHED_NOTE = "无匹站点匹配"

# 校验常量
LON_MIN, LON_MAX = -180.0, 180.0
LAT_MIN, LAT_MAX = -90.0, 90.0
# 名称列识别（模板固定列名，含必要容错）
NAME_ALIASES = ["CELL", "小区名称", "小区名", "NAME", "站点名称"]
LON_ALIASES = ["LON", "经度", "LONGITUDE"]
LAT_ALIASES = ["LAT", "纬度", "LATITUDE"]


def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    """列名归一化：把常见变体映射到 CELL/LON/LAT。缺列抛 ValueError。"""
    cols = {str(c).strip().upper(): c for c in df.columns}
    name_col = next((cols.get(a.upper()) for a in NAME_ALIASES if a.upper() in cols), None)
    lon_col = next((cols.get(a.upper()) for a in LON_ALIASES if a.upper() in cols), None)
    lat_col = next((cols.get(a.upper()) for a in LAT_ALIASES if a.upper() in cols), None)
    missing = []
    if name_col is None:
        missing.append("CELL")
    if lon_col is None:
        missing.append("LON")
    if lat_col is None:
        missing.append("LAT")
    if missing:
        raise ValueError(f"缺少必需列: {', '.join(missing)}")
    out = df[[name_col, lon_col, lat_col]].copy()
    out.columns = ["CELL", "LON", "LAT"]
    return out


def read_match_file(file_path: str) -> Dict[str, pd.DataFrame]:
    """读取清单 Excel 的两个 sheet，返回 {'匹配站点': df, '全量站点': df}（已归一化列名）。
    缺 sheet 抛 ValueError。"""
    xls = pd.ExcelFile(file_path, engine="calamine")
    sheets = {s.strip(): s for s in xls.sheet_names}
    required = {"匹配站点", "全量站点"}
    missing_sheets = [s for s in required if s not in sheets]
    if missing_sheets:
        raise ValueError(f"缺少工作表: {', '.join(missing_sheets)}")
    result = {}
    for key in required:
        df = pd.read_excel(xls, sheet_name=sheets[key])
        result[key] = _normalize_columns(df)
    return result


def validate_sheet(df: pd.DataFrame, sheet_name: str) -> List[Dict[str, object]]:
    """校验经纬度格式/有效性/CELL 非空，返回 [{sheet,row,reason}]"""
    errors: List[Dict[str, object]] = []
    lon = pd.to_numeric(df["LON"], errors="coerce")
    lat = pd.to_numeric(df["LAT"], errors="coerce")
    for i in range(len(df)):
        row_no = i + 2  # Excel 行号（含表头）
        cell = df.iloc[i]["CELL"]
        if cell is None or (isinstance(cell, str) and not cell.strip()):
            errors.append({"sheet": sheet_name, "row": row_no, "reason": "站点名称为空"})
        if lon.isna().iloc[i]:
            errors.append({"sheet": sheet_name, "row": row_no, "reason": "经度格式无效"})
        elif not (LON_MIN <= lon.iloc[i] <= LON_MAX):
            errors.append({"sheet": sheet_name, "row": row_no, "reason": "经度超出有效范围"})
        if lat.isna().iloc[i]:
            errors.append({"sheet": sheet_name, "row": row_no, "reason": "纬度格式无效"})
        elif not (LAT_MIN <= lat.iloc[i] <= LAT_MAX):
            errors.append({"sheet": sheet_name, "row": row_no, "reason": "纬度超出有效范围"})
    return errors


def validate_all(match_df: pd.DataFrame, full_df: pd.DataFrame) -> List[Dict[str, object]]:
    return validate_sheet(match_df, "匹配站点") + validate_sheet(full_df, "全量站点")


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Haversine 球面距离，返回 km"""
    r = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def match_sites(
    match_df: pd.DataFrame,
    full_df: pd.DataFrame,
    max_distance_km: float,
) -> Tuple[List[tuple], List[str]]:
    """返回 (results, unmatched)。
    results: [(匹配CELL, 匹配LON, 匹配LAT, 全量CELL, 全量LON, 全量LAT, 距离km), ...]
    unmatched: [匹配CELL, ...]（无命中）"""
    if max_distance_km <= 0:
        raise ValueError("相邻距离门限必须大于 0")
    # 数值化，忽略非法行（已由校验保证）
    match_df = match_df.copy()
    full_df = full_df.copy()
    match_df["LON"] = pd.to_numeric(match_df["LON"], errors="coerce")
    match_df["LAT"] = pd.to_numeric(match_df["LAT"], errors="coerce")
    full_df["LON"] = pd.to_numeric(full_df["LON"], errors="coerce")
    full_df["LAT"] = pd.to_numeric(full_df["LAT"], errors="coerce")

    full_lon = full_df["LON"].to_numpy()
    full_lat = full_df["LAT"].to_numpy()
    full_cell = full_df["CELL"].to_numpy()

    results: List[tuple] = []
    unmatched: List[str] = []
    for _, row in match_df.iterrows():
        lon, lat, cell = row["LON"], row["LAT"], row["CELL"]
        if pd.isna(lon) or pd.isna(lat):
            continue  # 校验已拦截，防御
        dlat = max_distance_km / 110.574
        dlon = max_distance_km / (111.320 * math.cos(math.radians(lat)))
        # 向量化网格预筛
        mask = (
            (full_lon >= lon - dlon) & (full_lon <= lon + dlon) &
            (full_lat >= lat - dlat) & (full_lat <= lat + dlat)
        )
        idxs = np.where(mask)[0]
        hits = []
        for j in idxs:
            d = haversine_km(lon, lat, full_lon[j], full_lat[j])
            if d <= max_distance_km:
                hits.append((cell, lon, lat, full_cell[j], full_lon[j], full_lat[j], round(d, 4)))
        if hits:
            results.extend(hits)
        else:
            unmatched.append(cell)
    return results, unmatched


def build_output_excel(
    out_path: str,
    match_df: pd.DataFrame,
    results: List[tuple],
    unmatched: List[str],
) -> str:
    """生成输出 xlsx（8 列），返回 out_path。匹配站点全部保留，无命中行备注。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "匹配结果"
    ws.append(OUTPUT_COLUMNS)

    unmatched_set = set(unmatched)
    for _, row in match_df.iterrows():
        cell = row["CELL"]
        if cell in unmatched_set:
            ws.append([cell, row["LON"], row["LAT"], None, None, None, None, UNMATCHED_NOTE])
    for (c1, lon1, lat1, c2, lon2, lat2, d) in results:
        ws.append([c1, lon1, lat1, c2, lon2, lat2, d, None])

    wb.save(out_path)
    return out_path


def build_output_filename() -> str:
    """返回 匹配结果{YYYYMMDD_HHMMSS}.xlsx"""
    from datetime import datetime
    return f"匹配结果{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"


def load_full_params_from_data(
    data_id: str,
    network_type: str,
    name_col: str,
    lon_col: str,
    lat_col: str,
) -> pd.DataFrame:
    """从数据管理已导入工参读取全量站点（LTE/NR 分表），归一化列名。
    返回 df 列 = [CELL, LON, LAT]。"""
    from app.services.data_service import data_service
    data = data_service.get_data(data_id)
    if not isinstance(data, dict):
        raise ValueError("数据不存在或无法读取")
    key = network_type.upper()
    rows = data.get(key, [])
    if not rows:
        raise ValueError(f"数据中不存在网络类型 {key} 的数据")
    df = pd.DataFrame(rows)
    for col in (name_col, lon_col, lat_col):
        if col not in df.columns:
            raise ValueError(f"列 {col} 不存在于该工参数据")
    out = df[[name_col, lon_col, lat_col]].copy()
    out.columns = ["CELL", "LON", "LAT"]
    return out
```

**Step 4: 运行确认通过**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && python -m pytest tests/test_distance_match_service.py -v`
Expected: PASS（16 个测试全过）

**Step 5: Commit**

```bash
git add backend/app/services/distance_match_service.py backend/tests/test_distance_match_service.py
git commit -m "feat: 批量距离匹配核心服务（网格预筛+haversine+xlsx输出+校验）"
```

---

### Task 2: 距离匹配 API 端点

**Files:**
- Create: `backend/app/api/v1/endpoints/distance_match.py`
- Modify: `backend/app/api/v1/__init__.py`（注册路由）
- Test: `backend/tests/test_distance_match_api.py`

**Step 1: 写失败测试**

```python
# backend/tests/test_distance_match_api.py
import os
import tempfile
import pandas as pd
from fastapi.testclient import TestClient

from app.api import create_app
from app.core.config import settings
from app.core.security import require_data_import


def _make_client():
    app = create_app()
    app.dependency_overrides[require_data_import] = lambda: None
    return TestClient(app)


def _make_list_excel() -> str:
    """创建含「匹配站点」「全量站点」两个 sheet 的清单文件"""
    tmp = tempfile.mktemp(suffix=".xlsx")
    with pd.ExcelWriter(tmp) as w:
        pd.DataFrame([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}]).to_excel(w, sheet_name="匹配站点", index=False)
        pd.DataFrame([{"CELL": "F1", "LON": 116.001, "LAT": 39.0}]).to_excel(w, sheet_name="全量站点", index=False)
    return tmp


def test_template_download():
    client = _make_client()
    resp = client.get("/api/v1/distance-match/template")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert len(resp.content) > 0


def test_parse_valid():
    path = _make_list_excel()
    client = _make_client()
    with open(path, "rb") as f:
        resp = client.post(
            "/api/v1/distance-match/parse",
            files={"file": ("list.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["data"]["match_total"] == 1
    assert body["data"]["full_total"] == 1
    assert body["data"]["errors"] == []


def test_parse_missing_sheet():
    tmp = tempfile.mktemp(suffix=".xlsx")
    pd.DataFrame([{"CELL": "A", "LON": 116.0, "LAT": 39.0}]).to_excel(tmp, sheet_name="匹配站点", index=False)
    client = _make_client()
    with open(tmp, "rb") as f:
        resp = client.post(
            "/api/v1/distance-match/parse",
            files={"file": ("list.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is False
    assert len(body["data"]["errors"]) == 1
    assert "全量站点" in str(body["data"]["errors"][0]["reason"]) or body["data"]["errors"][0]["reason"]


def test_match_valid():
    path = _make_list_excel()
    client = _make_client()
    with open(path, "rb") as f:
        resp = client.post(
            "/api/v1/distance-match/match",
            data={"max_distance_km": "1.0"},
            files={"file": ("list.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["data"]["filename"].startswith("匹配结果")
    assert body["data"]["filename"].endswith(".xlsx")
    assert body["data"]["download_url"].startswith("/static/")


def test_match_invalid_threshold():
    path = _make_list_excel()
    client = _make_client()
    with open(path, "rb") as f:
        resp = client.post(
            "/api/v1/distance-match/match",
            data={"max_distance_km": "0"},
            files={"file": ("list.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        )
    assert resp.status_code == 400
```

**Step 2: 运行确认失败**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && python -m pytest tests/test_distance_match_api.py -v`
Expected: FAIL（404/ImportError）

**Step 3: 实现端点**

```python
# backend/app/api/v1/endpoints/distance_match.py
"""批量距离匹配 API 端点"""
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from app.core.config import settings
from app.core.security import require_data_import
from app.services.distance_match_service import (
    build_output_excel,
    build_output_filename,
    load_full_params_from_data,
    match_sites,
    read_match_file,
    validate_all,
)

router = APIRouter()


def _save_upload_file(file: UploadFile) -> str:
    """保存上传文件到临时目录，返回路径。调用方 finally 删除。"""
    suffix = Path(file.filename or "list.xlsx").suffix.lower()
    if suffix not in (".xlsx", ".xls", ".csv", ".txt"):
        raise HTTPException(status_code=400, detail="仅支持 Excel/CSV/TXT 文件")
    tmp_dir = settings.UPLOAD_DIR / "distance_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    dest = tmp_dir / f"src_{datetime.now().strftime('%Y%m%d%H%M%S%f')}{suffix}"
    with open(dest, "wb") as f:
        f.write(file.file.read())
    return str(dest)


@router.post("/parse")
async def parse(
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
):
    """解析并校验上传的清单（含「匹配站点」「全量站点」两个 sheet）"""
    tmp = None
    try:
        if file:
            tmp = _save_upload_file(file)
        elif file_path:
            tmp = file_path.strip("\"'")
            if not Path(tmp).is_file():
                raise HTTPException(status_code=400, detail=f"文件不存在: {Path(tmp).name}")
        else:
            raise HTTPException(status_code=400, detail="未提供文件")

        sheets = await run_in_threadpool(read_match_file, tmp)
        errors = validate_all(sheets["匹配站点"], sheets["全量站点"])
        return {
            "success": len(errors) == 0,
            "data": {
                "match_total": len(sheets["匹配站点"]),
                "full_total": len(sheets["全量站点"]),
                "errors": errors,
            },
        }
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"解析失败: {str(e)}")
    finally:
        if tmp and file:  # 仅删除本端点自建临时文件；file_path 模式不动原文件
            Path(tmp).unlink(missing_ok=True)


@router.post("/match")
async def match(
    file: Optional[UploadFile] = File(None),
    match_file_path: Optional[str] = Form(None),
    max_distance_km: float = Form(...),
    full_file_path: Optional[str] = Form(None),
    full_data_id: Optional[str] = Form(None),
    full_network_type: Optional[str] = Form(None),
    full_name_col: Optional[str] = Form(None),
    full_lon_col: Optional[str] = Form(None),
    full_lat_col: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
):
    """执行批量距离匹配，返回下载 URL"""
    tmp = None
    try:
        if max_distance_km <= 0:
            raise HTTPException(status_code=400, detail="相邻距离门限必须大于 0")

        # 匹配站点清单（上传文件）
        if file:
            tmp = _save_upload_file(file)
            match_file = tmp
        elif match_file_path:
            match_file = match_file_path.strip("\"'")
            if not Path(match_file).is_file():
                raise HTTPException(status_code=400, detail=f"文件不存在: {Path(match_file).name}")
        else:
            raise HTTPException(status_code=400, detail="未提供匹配站点清单")

        # 读取 + 校验匹配站点
        sheets = await run_in_threadpool(read_match_file, match_file)
        match_df = sheets["匹配站点"]
        full_df = sheets["全量站点"]

        # 全量站点来源二选一：上传文件 或 数据管理工参
        if full_file_path:
            full_tmp = Path(full_file_path.strip("\"'"))
            if not full_tmp.is_file():
                raise HTTPException(status_code=400, detail=f"全量站点文件不存在: {full_tmp.name}")
            # 读取全量 sheet 覆盖默认
            full_sheets = await run_in_threadpool(read_match_file, str(full_tmp))
            full_df = full_sheets["全量站点"]
        elif full_data_id:
            if not (full_name_col and full_lon_col and full_lat_col):
                raise HTTPException(status_code=400, detail="从数据管理读取全量站点需提供列映射")
            full_df = await run_in_threadpool(
                load_full_params_from_data,
                full_data_id, full_network_type or "LTE",
                full_name_col, full_lon_col, full_lat_col,
            )
        # 否则用清单内的「全量站点」sheet

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
        if tmp and file:
            Path(tmp).unlink(missing_ok=True)


@router.get("/template")
async def template(current_user=Depends(require_data_import)):
    """下载站点匹配清单模板"""
    template_path = settings.TEMPLATE_DIR / "站点匹配清单-模板.xlsx"
    if not template_path.is_file():
        raise HTTPException(status_code=404, detail="模板文件不存在")
    return FileResponse(
        path=str(template_path),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="站点匹配清单-模板.xlsx",
    )
```

**Step 4: 注册路由**

修改 `backend/app/api/v1/__init__.py`：
- import 行（第 6 行）追加 `, distance_match`
- 末尾追加 `api_router.include_router(distance_match.router, prefix="/distance-match", tags=["批量距离匹配"])`

**Step 5: 运行确认通过**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && python -m pytest tests/test_distance_match_api.py -v`
Expected: PASS（6 个测试全过）

**Step 6: 全量回归**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && python -m pytest -q`
Expected: 全部通过（含既有测试）

**Step 7: Commit**

```bash
git add backend/app/api/v1/endpoints/distance_match.py backend/app/api/v1/__init__.py backend/tests/test_distance_match_api.py
git commit -m "feat: 批量距离匹配 API 端点（parse/match/template）"
```

---

## 前端

### Task 3: API 封装 + 共享类型

**Files:**
- Modify: `frontend/src/renderer/services/api.ts`（追加 `distanceMatchApi`）

**Step 1: 追加封装**

在 `frontend/src/renderer/services/api.ts` 末尾（`layerToolsApi` 之后）追加：

```typescript
// ===== 批量距离匹配 =====
export interface DistanceMatchParseError {
  sheet: string
  row: number
  reason: string
}

export interface DistanceMatchParseResult {
  success: boolean
  data: {
    match_total: number
    full_total: number
    errors: DistanceMatchParseError[]
  }
}

export interface DistanceMatchResult {
  success: boolean
  data: {
    filename: string
    download_url: string
    errors?: DistanceMatchParseError[]
  }
}

export const distanceMatchApi = {
  // 解析 + 校验清单
  parse: async (filePath: string): Promise<DistanceMatchParseResult> => {
    const formData = new FormData()
    formData.append('file_path', filePath)
    const res = await uploadClient.post('/distance-match/parse', formData)
    return res.data
  },

  // 执行匹配
  match: async (params: {
    matchFilePath: string
    maxDistanceKm: number
    fullFilePath?: string
    fullDataId?: string
    fullNetworkType?: 'LTE' | 'NR'
    fullNameCol?: string
    fullLonCol?: string
    fullLatCol?: string
  }): Promise<DistanceMatchResult> => {
    const formData = new FormData()
    formData.append('match_file_path', params.matchFilePath)
    formData.append('max_distance_km', String(params.maxDistanceKm))
    if (params.fullFilePath) formData.append('full_file_path', params.fullFilePath)
    if (params.fullDataId) {
      formData.append('full_data_id', params.fullDataId)
      formData.append('full_network_type', params.fullNetworkType || 'LTE')
      formData.append('full_name_col', params.fullNameCol || '')
      formData.append('full_lon_col', params.fullLonCol || '')
      formData.append('full_lat_col', params.fullLatCol || '')
    }
    const res = await uploadClient.post('/distance-match/match', formData)
    return res.data
  },

  // 模板下载
  templateUrl: '/api/v1/distance-match/template',
}
```

**Step 2: 类型检查**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit`
Expected: PASS（无新增类型错误）

**Step 3: Commit**

```bash
git add frontend/src/renderer/services/api.ts
git commit -m "feat: 批量距离匹配前端 API 封装"
```

---

### Task 4: 距离匹配页面

**Files:**
- Create: `frontend/src/renderer/pages/DistanceMatchPage.tsx`

**Step 1: 实现页面**（对齐 `LayerToolsPage` 模式，参考其上传/进度/错误处理结构）

```tsx
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, Loader2, Download, CheckCircle2, AlertCircle, Ruler, Database, UploadCloud } from 'lucide-react'
import { distanceMatchApi, dataApi } from '../services/api'
import { uploadStore } from '../store/uploadStore'
import { layerToolsApi } from '../services/api'

type FullSource = 'upload' | 'data'

interface ParseError { sheet: string; row: number; reason: string }

export default function DistanceMatchPage() {
  const { t } = useTranslation()

  // ===== 匹配站点清单文件 =====
  const [matchFilePath, setMatchFilePath] = useState('')
  const [matchFileName, setMatchFileName] = useState('')

  // ===== 全量站点来源 =====
  const [fullSource, setFullSource] = useState<FullSource>('upload')
  const [fullFilePath, setFullFilePath] = useState('')
  const [fullFileName, setFullFileName] = useState('')
  const [dataItems, setDataItems] = useState<any[]>([])
  const [fullDataId, setFullDataId] = useState('')
  const [networkType, setNetworkType] = useState<'LTE' | 'NR'>('LTE')
  const [columns, setColumns] = useState<string[]>([])
  const [nameCol, setNameCol] = useState('')
  const [lonCol, setLonCol] = useState('')
  const [latCol, setLatCol] = useState('')

  // ===== 参数 =====
  const [maxDistanceKm, setMaxDistanceKm] = useState('')

  // ===== 状态 =====
  const [uploading, setUploading] = useState(false)
  const [matching, setMatching] = useState(false)
  const [parseErrors, setParseErrors] = useState<ParseError[]>([])
  const [result, setResult] = useState<{ filename: string; download_url: string } | null>(null)
  const [error, setError] = useState('')

  // 数据管理下拉加载
  useEffect(() => {
    dataApi.list(1, 100, true).then(res => {
      if (res.success && res.data) {
        const items = res.data.filter((d: any) => d.type === 'excel' && d.status === 'ready')
        setDataItems(items)
        // 默认高亮全量工参
        const full = items.find((d: any) => (d.name || '').toLowerCase().includes('projectparameter_mongoose'))
        if (full) setFullDataId(full.id)
        else if (items[0]) setFullDataId(items[0].id)
      }
    }).catch(() => setError(t('distanceMatch.loadDataErr') || '加载数据列表失败'))
  }, [])

  // 数据文件 → 列加载 + 自动预选
  useEffect(() => {
    if (!fullDataId) { setColumns([]); return }
    dataApi.getColumns(fullDataId, networkType).then(res => {
      if (res.success && res.data?.columns) {
        const cols = res.data.columns
        setColumns(cols)
        // GeoFieldDetector 同源规则自动预选
        const pick = (patterns: string[]) => {
          const lower = cols.map(c => c.toLowerCase())
          for (const p of patterns) {
            const idx = lower.indexOf(p.toLowerCase())
            if (idx >= 0) return cols[idx]
          }
          // 包含匹配
          for (const p of patterns) {
            const idx = lower.findIndex(c => c.includes(p.toLowerCase()))
            if (idx >= 0) return cols[idx]
          }
          return ''
        }
        setNameCol(pick(['cell_name', 'sector_name', 'name', 'cellname', '小区名称', '小区名']) || cols[0] || '')
        setLonCol(pick(['longitude', 'lon', 'long', '经度']) || '')
        setLatCol(pick(['latitude', 'lat', '纬度']) || '')
      }
    }).catch(() => setColumns([]))
  }, [fullDataId, networkType])

  const handleMatchFile = async (f: File) => {
    setUploading(true); setParseErrors([]); setError(''); setResult(null)
    try {
      const up = await layerToolsApi.uploadLayerFile(f)
      setMatchFilePath(up.file_path)
      setMatchFileName(f.name)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally { setUploading(false) }
  }

  const handleFullFile = async (f: File) => {
    setUploading(true); setError('')
    try {
      const up = await layerToolsApi.uploadLayerFile(f)
      setFullFilePath(up.file_path)
      setFullFileName(f.name)
    } catch (e: any) { setError(e?.message || String(e)) }
    finally { setUploading(false) }
  }

  const handleMatch = async () => {
    setError(''); setResult(null); setParseErrors([])
    const km = parseFloat(maxDistanceKm)
    if (!matchFilePath) { setError(t('distanceMatch.errNoFile') || '请先导入匹配站点清单'); return }
    if (!(km > 0)) { setError(t('distanceMatch.errThreshold') || '请输入大于 0 的距离门限'); return }
    if (fullSource === 'data' && (!fullDataId || !nameCol || !lonCol || !latCol)) {
      setError(t('distanceMatch.errMapping') || '请选择数据文件并配置完整列映射'); return
    }

    setMatching(true)
    try {
      const res = await distanceMatchApi.match({
        matchFilePath,
        maxDistanceKm: km,
        fullFilePath: fullSource === 'upload' ? fullFilePath : undefined,
        fullDataId: fullSource === 'data' ? fullDataId : undefined,
        fullNetworkType: networkType,
        fullNameCol: nameCol, fullLonCol: lonCol, fullLatCol: latCol,
      })
      if (res.success && res.data?.download_url) {
        setResult({ filename: res.data.filename, download_url: res.data.download_url })
      } else if (res.data?.errors?.length) {
        setParseErrors(res.data.errors)
      } else {
        setError(t('distanceMatch.errUnknown') || '匹配失败，请重试')
      }
    } catch (e: any) {
      // 校验错误（400）结构化透传
      const detail = e?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : (e?.message || String(e)))
    } finally { setMatching(false) }
  }

  return (
    <div className="p-8 max-w-6xl">
      <h1 className="text-base font-bold mb-6 flex items-center gap-2">
        <Ruler size={18} /> {t('nav.distanceMatch')}
      </h1>

      {/* ① 文件导入 */}
      <div className="mb-6 p-4 bg-card border border-border rounded-lg">
        <p className="text-xs font-medium mb-3 flex items-center gap-2">
          <FileUp size={14} /> {t('distanceMatch.fileImport')}
          <a href={distanceMatchApi.templateUrl} download
            className="ml-auto text-xs text-primary hover:underline">
            {t('distanceMatch.templateDownload')}
          </a>
        </p>

        {/* 匹配站点清单 */}
        <p className="text-xs text-muted-foreground mb-1">{t('distanceMatch.matchFile')}</p>
        <label className="block flex items-center gap-3 px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer hover:border-primary transition-colors">
          <UploadCloud className="text-muted-foreground shrink-0" size={20} />
          <span className="text-sm truncate flex-1">{matchFileName || t('distanceMatch.uploadHint')}</span>
          <input type="file" className="hidden" accept=".xlsx,.xls,.csv,.txt"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleMatchFile(f) }} disabled={uploading} />
        </label>

        {/* 全量站点来源切换 */}
        <div className="mt-4">
          <p className="text-xs font-medium mb-2">{t('distanceMatch.fullSource')}</p>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" checked={fullSource === 'upload'} onChange={() => setFullSource('upload')} />
              {t('distanceMatch.fullUpload')}
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" checked={fullSource === 'data'} onChange={() => setFullSource('data')} />
              {t('distanceMatch.fullData')}
            </label>
          </div>

          {fullSource === 'upload' ? (
            <label className="mt-2 block flex items-center gap-3 px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer hover:border-primary transition-colors">
              <UploadCloud className="text-muted-foreground shrink-0" size={20} />
              <span className="text-sm truncate flex-1">{fullFileName || t('distanceMatch.uploadHint')}</span>
              <input type="file" className="hidden" accept=".xlsx,.xls,.csv,.txt"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFullFile(f) }} disabled={uploading} />
            </label>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">{t('distanceMatch.dataFile')}</label>
                <select value={fullDataId} onChange={e => setFullDataId(e.target.value)}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
                  {dataItems.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{t('distanceMatch.networkType')}</label>
                <select value={networkType} onChange={e => setNetworkType(e.target.value as 'LTE' | 'NR')}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
                  <option value="LTE">LTE</option>
                  <option value="NR">NR</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{t('distanceMatch.nameCol')}</label>
                <select value={nameCol} onChange={e => setNameCol(e.target.value)}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
                  {columns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{t('distanceMatch.lonCol')}</label>
                <select value={lonCol} onChange={e => setLonCol(e.target.value)}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
                  {columns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{t('distanceMatch.latCol')}</label>
                <select value={latCol} onChange={e => setLatCol(e.target.value)}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
                  {columns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ② 参数设置 */}
      <div className="mb-6 p-4 bg-card border border-border rounded-lg">
        <p className="text-xs font-medium mb-3">{t('distanceMatch.params')}</p>
        <div className="max-w-xs">
          <label className="block text-xs font-medium mb-1">{t('distanceMatch.maxDistance')} (km)</label>
          <input value={maxDistanceKm} inputMode="decimal"
            onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setMaxDistanceKm(e.target.value) }}
            placeholder="1.0" className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
        </div>
      </div>

      {/* ③ 开始匹配 */}
      <div className="mb-6 p-4 bg-card border border-border rounded-lg">
        <button onClick={handleMatch} disabled={matching || uploading}
          className="w-full px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium">
          {matching ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
          {t('distanceMatch.start')}
        </button>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-xs text-red-600 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* 校验错误明细 */}
      {parseErrors.length > 0 && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg text-xs">
          <p className="text-amber-700 font-medium mb-2 flex items-center gap-1">
            <AlertCircle size={14} /> {t('distanceMatch.invalidData')}
          </p>
          <div className="max-h-40 overflow-y-auto">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-amber-50">
                <tr className="border-b border-amber-200">
                  <th className="px-2 py-1 font-medium">{t('distanceMatch.sheet')}</th>
                  <th className="px-2 py-1 font-medium">{t('distanceMatch.row')}</th>
                  <th className="px-2 py-1 font-medium">{t('distanceMatch.reason')}</th>
                </tr>
              </thead>
              <tbody>
                {parseErrors.slice(0, 100).map((e, i) => (
                  <tr key={i} className="border-b border-amber-100">
                    <td className="px-2 py-1">{e.sheet}</td>
                    <td className="px-2 py-1">{e.row}</td>
                    <td className="px-2 py-1">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parseErrors.length > 100 && (
              <p className="px-2 py-1 text-amber-600">
                {t('distanceMatch.more').replace('{count}', String(parseErrors.length - 100))}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ④ 匹配结果下载 */}
      {result && (
        <div className="p-4 bg-card border border-border rounded-lg">
          <a href={result.download_url + '?_t=' + Date.now()} download
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-green-600 text-white rounded-lg hover:opacity-90 text-sm">
            <Download size={16} /> {t('distanceMatch.download')} ({result.filename})
          </a>
          <p className="mt-2 text-xs text-green-600 flex items-center gap-1">
            <CheckCircle2 size={14} /> {t('distanceMatch.matchDone')}
          </p>
        </div>
      )}
    </div>
  )
}
```

**Step 2: 类型检查**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add frontend/src/renderer/pages/DistanceMatchPage.tsx
git commit -m "feat: 批量距离匹配页面（导入/参数/匹配/下载）"
```

---

### Task 5: 路由 + 侧边栏 + 首页入口 + i18n

**Files:**
- Modify: `frontend/src/renderer/App.tsx`（路由）
- Modify: `frontend/src/renderer/components/Layout/MainLayout.tsx`（侧边栏）
- Modify: `frontend/src/renderer/pages/HomePage.tsx`（首页卡片）
- Modify: `frontend/src/renderer/locales/zh.json`（中文）
- Modify: `frontend/src/renderer/locales/en.json`（英文）

**Step 1: App.tsx 注册路由**

```tsx
// import 追加
import DistanceMatchPage from './pages/DistanceMatchPage'
// Routes 内新增（放在 LayerTools 路由后）
<Route
  path="/distance-match"
  element={
    <ProtectedRoute>
      <DistanceMatchPage />
    </ProtectedRoute>
  }
/>
```

**Step 2: MainLayout.tsx 侧边栏**

```tsx
// import 追加 Ruler
import { ..., Ruler } from 'lucide-react'
// navigation 数组，LayerTools 之后追加
{ type: 'link', name: t('nav.distanceMatch'), href: '/distance-match', icon: Ruler },
```

**Step 3: HomePage.tsx 首页卡片**

```tsx
// import 追加 Ruler
import { ..., Ruler } from 'lucide-react'
// 在 LayerTools 卡片之后追加
<FeatureCard
  title={t('nav.distanceMatch')}
  description={t('home.distanceMatchDesc')}
  icon={Ruler}
  link="/distance-match"
  iconColor="text-emerald-600"
/>
```

**Step 4: i18n 文案**

`zh.json`：
```json
// nav 追加
"distanceMatch": "批量距离匹配",
// home 追加
"distanceMatchDesc": "按距离门限批量匹配站点",
// 新增顶层 distanceMatch 对象
"distanceMatch": {
  "fileImport": "文件导入",
  "templateDownload": "模版下载",
  "matchFile": "匹配站点清单",
  "fullSource": "全量站点来源",
  "fullUpload": "上传清单文件",
  "fullData": "从数据管理选择",
  "dataFile": "数据文件",
  "networkType": "网络类型",
  "nameCol": "站点名称列",
  "lonCol": "经度列",
  "latCol": "纬度列",
  "uploadHint": "点击或拖拽文件到此处上传",
  "params": "参数设置",
  "maxDistance": "相邻距离门限",
  "start": "开始匹配",
  "download": "下载匹配结果",
  "matchDone": "匹配完成，可下载结果文件",
  "invalidData": "导入数据存在异常，请调整后重新导入：",
  "sheet": "工作表",
  "row": "行号",
  "reason": "原因",
  "more": "（还有 {count} 条）",
  "loadDataErr": "加载数据列表失败",
  "errNoFile": "请先导入匹配站点清单",
  "errThreshold": "请输入大于 0 的距离门限",
  "errMapping": "请选择数据文件并配置完整列映射",
  "errUnknown": "匹配失败，请重试"
}
```

`en.json` 对应英文：
```json
"distanceMatch": "Batch Distance Match",
"distanceMatchDesc": "Batch-match sites by distance threshold",
"distanceMatch": {
  "fileImport": "File Import",
  "templateDownload": "Download Template",
  "matchFile": "Match Site List",
  "fullSource": "Full Site Source",
  "fullUpload": "Upload List File",
  "fullData": "From Data Management",
  "dataFile": "Data File",
  "networkType": "Network Type",
  "nameCol": "Site Name Column",
  "lonCol": "Longitude Column",
  "latCol": "Latitude Column",
  "uploadHint": "Click or drag file to upload",
  "params": "Parameters",
  "maxDistance": "Max Distance Threshold",
  "start": "Start Matching",
  "download": "Download Result",
  "matchDone": "Matching complete, download available",
  "invalidData": "Invalid import data, please fix and re-import:",
  "sheet": "Sheet",
  "row": "Row",
  "reason": "Reason",
  "more": "({count} more)",
  "loadDataErr": "Failed to load data list",
  "errNoFile": "Please import match site list first",
  "errThreshold": "Please enter a distance threshold greater than 0",
  "errMapping": "Please select data file and configure full column mapping",
  "errUnknown": "Matching failed, please retry"
}
```

**Step 5: 类型检查 + 构建**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit && npm run lint`
Expected: PASS（无类型错误，无 lint 错误）

**Step 6: Commit**

```bash
git add frontend/src/renderer/App.tsx frontend/src/renderer/components/Layout/MainLayout.tsx frontend/src/renderer/pages/HomePage.tsx frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json
git commit -m "feat: 批量距离匹配路由/侧边栏/首页入口 + i18n"
```

---

## 验证与收尾

### Task 6: 端到端验证

**Step 1: 后端测试全绿**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && python -m pytest -q`
Expected: 全部通过

**Step 2: 前端类型检查**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit`
Expected: PASS

**Step 3: 手工冒烟（可选，需要运行环境）**

- `cd backend && python main.py` 启动后端，访问 `http://127.0.0.1:8000/docs` 验证 3 个端点存在
- 前端 `npm run dev:web` 访问 `/distance-match`，上传模板文件，设置门限，执行匹配，下载结果
- 验证输出 xlsx 8 列、无命中行备注「无匹站点匹配」

---

## 计划核对清单

| 需求 | 对应 Task |
|---|---|
| 模板下载 | Task 0 + Task 2（`/template`）+ Task 4（前端按钮） |
| 前端四区块页面 | Task 4 |
| 侧边栏 + 首页入口 | Task 5 |
| 距离门限(km) 单一参数 | Task 1 `match_sites` + Task 4 输入 |
| 全量站点双来源（上传/数据管理） | Task 1 `load_full_params_from_data` + Task 2 `/match` + Task 4 来源切换 |
| 输出 8 列 + 无命中备注 | Task 1 `build_output_excel` |
| 匹配结果{时间戳}.xlsx 命名 | Task 1 `build_output_filename` |
| 后台智能校验 | Task 1 `validate_sheet` + Task 2 `/parse` + Task 4 错误明细 |
| i18n 双语 | Task 5 |
