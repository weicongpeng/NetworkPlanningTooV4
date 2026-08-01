# 图层制作功能 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 新增"图层制作"功能，用户通过侧边栏"实用工具"→"图层制作"进入扇区/点图层页面，导入 Excel 工参文件后生成 tab / mif / kml 格式图层文件并下载。

**Architecture:** 后端 FastAPI 新增 `layer.py` 端点 + `layer_service.py` 服务。服务用 `pyogrio`（已在 venv 内，内置 GDAL/OGR 绑定）把 geopandas GeoDataFrame 写入 MapInfo TAB/MIF 和 KML。扇区几何用 Flat-Earth 近似算法（移植自前端 `SectorRendererSVG.tsx`）。前端新增两个页面（`/layer/sector`、`/layer/point`），侧边栏新增"实用工具"分组，首页新增卡片。文件保存到 `backend/uploads/layers/`，通过 `/static` 挂载提供下载。

**Tech Stack:** Python (FastAPI, pandas, geopandas, shapely, pyogrio) / TypeScript (React 18, React Router, Zustand, Tailwind, lucide-react, i18next)

---

## Task 1: 后端服务 `layer_service.py` — 扇区/点几何生成 + pyogrio 写入

**Files:**
- Create: `backend/app/services/layer_service.py`
- Test: `backend/tests/test_layer_service.py`

### Step 1: Write the failing test

`backend/tests/test_layer_service.py`：

```python
"""
图层制作服务测试
遵循TDD方法论: RED → GREEN → REFACTOR
"""
import pytest
import pandas as pd
from pathlib import Path
from app.services.layer_service import (
    fast_destination,
    sector_polygon,
    LayerService,
)

SAMPLE_DATA = {
    "NAME": ["CellA", "CellB"],
    "LONGITUDE": [116.3, 116.4],
    "LATITUDE": [39.9, 40.0],
    "AZIMUTH": [0.0, 120.0],
    "PCI": [100, 200],
}


@pytest.fixture
def sample_excel(tmp_path: Path) -> Path:
    """创建包含经纬度/方位角的示例 Excel"""
    path = tmp_path / "sample.xlsx"
    df = pd.DataFrame(SAMPLE_DATA)
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    return path


@pytest.fixture
def service(tmp_path: Path) -> LayerService:
    return LayerService(output_dir=tmp_path)


def test_fast_destination_returns_expected_offset():
    """测试 Flat-Earth 终点计算"""
    lat, lng = fast_destination(39.9, 116.3, azimuth_deg=0.0, distance_m=1000)
    # 正北方向 1000m ≈ 0.00898 纬度（111319.9 m/度）
    assert abs(lat - 39.9 - 1000 / 111319.9) < 1e-5
    assert abs(lng - 116.3) < 1e-5


def test_sector_polygon_geometry():
    """测试扇形多边形：含中心点、包含在半径圆内"""
    poly = sector_polygon(39.9, 116.3, azimuth=0.0, beamwidth=40.0, radius_m=1000)
    assert poly.geom_type == "Polygon"
    assert poly.area > 0
    # 所有顶点在中心点 1000m 半径内（Flat-Earth 近似）
    from shapely.geometry import Point
    center = Point(116.3, 39.9)
    assert poly.distance(center) < 1000 / 111319.9 * 1.1


def test_generate_point_layer(service, sample_excel):
    """生成点图层并断言可读回"""
    result = service.generate_point_layer(
        file_path=str(sample_excel),
        sheet_name="LTE",
        name_col="NAME",
        lon_col="LONGITUDE",
        lat_col="LATITUDE",
        attributes=["NAME", "PCI"],
        output_format="tab",
    )
    assert result.exists()
    import geopandas as gpd
    gdf = gpd.read_file(result)
    assert len(gdf) == 2
    assert list(gdf.columns) == ["NAME", "PCI", "geometry"]
    assert gdf.crs.to_epsg() == 4326


def test_generate_sector_layer(service, sample_excel):
    """生成扇区图层并断言几何为多边形"""
    result = service.generate_sector_layer(
        file_path=str(sample_excel),
        sheet_name="LTE",
        name_col="NAME",
        lon_col="LONGITUDE",
        lat_col="LATITUDE",
        azimuth_col="AZIMUTH",
        radius_m=3000,
        beamwidth=40.0,
        attributes=["NAME", "PCI"],
        output_format="mif",
    )
    assert result.exists()
    import geopandas as gpd
    gdf = gpd.read_file(result)
    assert len(gdf) == 2
    assert all(g.geom_type == "Polygon" for g in gdf.geometry)


def test_generate_sector_layer_kml(service, sample_excel):
    """扇区图层输出 KML 格式"""
    result = service.generate_sector_layer(
        file_path=str(sample_excel),
        sheet_name="LTE",
        name_col="NAME",
        lon_col="LONGITUDE",
        lat_col="LATITUDE",
        azimuth_col="AZIMUTH",
        radius_m=3000,
        beamwidth=40.0,
        attributes=["NAME"],
        output_format="kml",
    )
    assert result.exists()
    assert result.suffix == ".kml"
    content = result.read_text(encoding="utf-8")
    assert "<kml" in content.lower()


def test_invalid_coordinates_raises(service, tmp_path):
    """非法经纬度（如 999）应抛异常"""
    path = tmp_path / "bad.xlsx"
    df = pd.DataFrame({"NAME": ["X"], "LONGITUDE": [999], "LATITUDE": [999]})
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="S", index=False)
    with pytest.raises(ValueError, match="经纬度"):
        service.generate_point_layer(
            file_path=str(path), sheet_name="S",
            name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
            attributes=["NAME"], output_format="tab",
        )
```

### Step 2: Run test to verify it fails

```bash
cd backend && .venv/bin/python -m pytest tests/test_layer_service.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.layer_service'`

### Step 3: Write minimal implementation

`backend/app/services/layer_service.py`：

```python
"""
图层制作服务

根据 Excel 工参文件生成 MapInfo (TAB/MIF) 和 KML 格式的图层文件。
使用 pyogrio + geopandas 写入（内置 GDAL/OGR 绑定，无需安装 GDAL）。
扇区几何使用 Flat-Earth 近似算法（与前端 SectorRendererSVG 一致）。
"""
import math
import uuid
from pathlib import Path
from typing import List, Optional

import pandas as pd
import geopandas as gpd
from shapely.geometry import Point, Polygon

from app.services.geo_field_detector import GeoFieldDetector

# 输出格式 → pyogrio driver 名
DRIVER_MAP = {
    "tab": "MapInfo File",
    "mif": "MapInfo File",
    "kml": "KML",
}
# 扩展名
EXT_MAP = {"tab": ".tab", "mif": ".mif", "kml": ".kml"}


def fast_destination(lat: float, lng: float, azimuth_deg: float, distance_m: float) -> tuple:
    """快速计算终点坐标 (Flat-Earth Approximation)
    移植自前端 SectorRendererSVG._fastDestination
    """
    rad = azimuth_deg * math.pi / 180
    meters_per_lat = 111319.9
    meters_per_lng = 111319.9 * math.cos(math.radians(lat))
    dlat = distance_m * math.cos(rad) / meters_per_lat
    dlng = distance_m * math.sin(rad) / meters_per_lng
    return lat + dlat, lng + dlng


def sector_polygon(lat: float, lng: float, azimuth: float, beamwidth: float,
                   radius_m: float, arc_points: int = 30) -> Polygon:
    """生成扇形（楔形）多边形
    角度以正北为 0，顺时针。azimuth ± beamwidth/2 构成扇区两边界，弧线 arc_points 段。
    """
    half = beamwidth / 2
    start, end = azimuth - half, azimuth + half
    pts = [(lng, lat)]
    for i in range(1, arc_points):
        a = start + (end - start) * i / arc_points
        lat2, lng2 = fast_destination(lat, lng, a, radius_m)
        pts.append((lng2, lat2))
    lat2, lng2 = fast_destination(lat, lng, end, radius_m)
    pts.append((lng2, lat2))
    pts.append((lng, lat))
    return Polygon(pts)


class LayerService:
    """图层制作服务"""

    def __init__(self, output_dir: Optional[Path] = None):
        from app.core.config import settings
        self.output_dir = output_dir or (settings.UPLOAD_DIR / "layers")
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._detector = GeoFieldDetector()

    def _read_sheet(self, file_path: str, sheet_name: str) -> pd.DataFrame:
        """读取指定 sheet，返回 DataFrame"""
        try:
            return pd.read_excel(file_path, sheet_name=sheet_name)
        except ValueError as e:
            raise ValueError(f"Sheet 不存在: {sheet_name}") from e

    def _coerce_coords(self, df: pd.DataFrame, lon_col: str, lat_col: str):
        """校验经纬度合法，非法抛异常"""
        lon = pd.to_numeric(df[lon_col], errors="coerce")
        lat = pd.to_numeric(df[lat_col], errors="coerce")
        valid = lon.between(-180, 180) & lat.between(-90, 90) & lon.notna() & lat.notna()
        if valid.sum() == 0:
            raise ValueError("经纬度数据无效，请检查经纬度列选择")
        if valid.sum() < len(df) * 0.5:
            raise ValueError(f"有效坐标少于50%（{valid.sum()}/{len(df)}），请检查数据质量")
        return lon, lat, valid

    def _build_gdf(self, df: pd.DataFrame, lon: pd.Series, lat: pd.Series,
                   valid: pd.Series, attributes: List[str], geometry_cols) -> gpd.GeoDataFrame:
        """构建 GeoDataFrame，仅保留有效坐标行和勾选属性列"""
        sub = df.loc[valid].copy()
        for col in list(sub.columns):
            if col not in attributes:
                sub = sub.drop(columns=[col])
        gdf = gpd.GeoDataFrame(sub, geometry=geometry_cols, crs="EPSG:4326")
        return gdf

    def _write(self, gdf: gpd.GeoDataFrame, output_format: str) -> Path:
        """写入文件，返回路径"""
        if output_format not in DRIVER_MAP:
            raise ValueError(f"不支持的输出格式: {output_format}")
        fname = f"layer_{uuid.uuid4().hex[:12]}{EXT_MAP[output_format]}"
        out_path = self.output_dir / fname
        gdf.to_file(out_path, driver=DRIVER_MAP[output_format])
        return out_path

    def generate_point_layer(self, file_path: str, sheet_name: str,
                             name_col: str, lon_col: str, lat_col: str,
                             attributes: List[str], output_format: str) -> Path:
        """生成点图层，返回输出文件路径"""
        df = self._read_sheet(file_path, sheet_name)
        lon, lat, valid = self._coerce_coords(df, lon_col, lat_col)
        geoms = [Point(x, y) for x, y in zip(lon[valid], lat[valid])]
        gdf = self._build_gdf(df, lon, lat, valid, attributes, geoms)
        return self._write(gdf, output_format)

    def generate_sector_layer(self, file_path: str, sheet_name: str,
                              name_col: str, lon_col: str, lat_col: str,
                              azimuth_col: str, radius_m: float, beamwidth: float,
                              attributes: List[str], output_format: str) -> Path:
        """生成扇区图层，返回输出文件路径"""
        df = self._read_sheet(file_path, sheet_name)
        lon, lat, valid = self._coerce_coords(df, lon_col, lat_col)
        azi = pd.to_numeric(df[azimuth_col], errors="coerce")
        azi_ok = azi.between(0, 360) & azi.notna()
        valid = valid & azi_ok
        if valid.sum() == 0:
            raise ValueError("方位角数据无效，请检查方位角列选择（0-360度）")
        geoms = [
            sector_polygon(y, x, a, beamwidth, radius_m)
            for x, y, a in zip(lon[valid], lat[valid], azi[valid])
        ]
        gdf = self._build_gdf(df, lon, lat, valid, attributes, geoms)
        return self._write(gdf, output_format)

    def get_sheet_info(self, file_path: str) -> dict:
        """读取 Excel 的 sheet 列表和各 sheet 列名"""
        xls = pd.ExcelFile(file_path, engine="calamine")
        sheets = xls.sheet_names
        columns = {}
        for s in sheets:
            df = pd.read_excel(xls, sheet_name=s, nrows=1)
            columns[s] = [str(c) for c in df.columns]
        return {"sheets": sheets, "columns": columns}
```

> 注意：`_coerce_coords` 里 `lon`/`lat` 是按原 DataFrame 索引对齐的 Series；`_build_gdf` 用 `valid` 布尔掩码过滤。经度/纬度传入点/扇区时用 `lon[valid]`/`lat[valid]` 保证与 `sub` 行数一致。

### Step 4: Run test to verify it passes

```bash
cd backend && .venv/bin/python -m pytest tests/test_layer_service.py -v
```

Expected: PASS（6 个测试）

### Step 5: Commit

```bash
git add backend/app/services/layer_service.py backend/tests/test_layer_service.py
git commit -m "feat: 图层制作服务（pyogrio 生成 tab/mif/kml）"
```

---

## Task 2: 后端端点 `layer.py` + 路由注册 + 下载

**Files:**
- Create: `backend/app/api/v1/endpoints/layer.py`
- Modify: `backend/app/api/v1/__init__.py:6`（导入）、`:23` 后（注册路由）
- Modify: `backend/app/api/__init__.py`（可选：/static 已挂载到 OUTPUT_DIR，若 layers 放 UPLOAD_DIR 需新增挂载或用 FileResponse）

### Step 1: Write the failing test (API 冒烟)

追加到 `backend/tests/test_layer_service.py`（或用 `TestClient`）：

```python
from fastapi.testclient import TestClient
from app.api import create_app


def test_excel_info_endpoint(tmp_path):
    """excel-info 端点读取 sheet/列信息"""
    import pandas as pd
    path = tmp_path / "sample.xlsx"
    pd.DataFrame({"A": [1], "B": [2]}).to_excel(path, sheet_name="S1", index=False)
    app = create_app()
    client = TestClient(app)
    with open(path, "rb") as f:
        resp = client.post("/api/v1/layer/excel-info", files={"file": ("s.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert "S1" in body["data"]["sheets"]
    assert body["data"]["columns"]["S1"] == ["A", "B"]
```

> 若 `create_app()` 涉及 lifespan 启动成本高，可只测 service 层（Task 1 已覆盖），本测试作为可选增强；端点逻辑在 Step 3 后手动 curl 验证。

### Step 2: Run test to verify it fails

```bash
cd backend && .venv/bin/python -m pytest tests/test_layer_service.py -k excel_info -v
```

Expected: FAIL — 404 Not Found（路由未注册）

### Step 3: Write minimal implementation

`backend/app/api/v1/endpoints/layer.py`：

```python
"""
图层制作 API 端点
"""
import shutil
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, Form
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from app.core.security import require_data_import
from app.services.layer_service import LayerService

router = APIRouter()
layer_service = LayerService()


def _save_upload(file: Optional[UploadFile], file_path: Optional[str]) -> Path:
    """保存上传文件到临时目录，返回本地路径"""
    if not file and not file_path:
        raise HTTPException(status_code=400, detail="未提供文件")
    tmp_dir = Path(__file__).parent.parent.parent.parent.parent / "uploads" / "layers" / "_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    if file:
        name = f"src_{uuid.uuid4().hex[:8]}{Path(file.filename or 'src.xlsx').suffix}"
        dest = tmp_dir / name
        with open(dest, "wb") as f:
            f.write(file.file.read())
        return dest
    # file_path 模式（Electron 本地路径）
    src = Path(str(file_path).strip("\"'"))
    if not src.exists():
        raise HTTPException(status_code=400, detail=f"文件不存在: {src}")
    dest = tmp_dir / f"src_{uuid.uuid4().hex[:8]}{src.suffix}"
    shutil.copy2(src, dest)
    return dest


def _config_from_form(prefix: str, common: dict) -> dict:
    """组装配置（扇区/点通用字段 + 各自专有字段）"""
    ...


@router.post("/excel-info")
async def excel_info(
    file: Optional[UploadFile] = None,
    file_path: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
):
    """读取 Excel 的 sheet 列表和各 sheet 列名"""
    try:
        src = _save_upload(file, file_path)
        result = await run_in_threadpool(layer_service.get_sheet_info, str(src))
        return {"success": True, "data": result}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"解析失败: {str(e)}")


@router.post("/point")
async def generate_point(
    file: Optional[UploadFile] = None,
    file_path: Optional[str] = Form(None),
    sheet_name: str = Form(...),
    name_col: str = Form(...),
    lon_col: str = Form(...),
    lat_col: str = Form(...),
    attributes: str = Form("[]"),  # JSON 数组字符串
    output_format: str = Form("tab"),
    current_user=Depends(require_data_import),
):
    """生成点图层，返回下载 URL"""
    import json
    try:
        src = _save_upload(file, file_path)
        attr_list = json.loads(attributes) if attributes else []
        out = await run_in_threadpool(
            layer_service.generate_point_layer,
            str(src), sheet_name, name_col, lon_col, lat_col, attr_list, output_format,
        )
        return {"success": True, "data": {"filename": out.name, "download_url": f"/static/{out.name}"}}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"生成失败: {str(e)}")


@router.post("/sector")
async def generate_sector(
    file: Optional[UploadFile] = None,
    file_path: Optional[str] = Form(None),
    sheet_name: str = Form(...),
    name_col: str = Form(...),
    lon_col: str = Form(...),
    lat_col: str = Form(...),
    azimuth_col: str = Form(...),
    radius_m: float = Form(3000.0),
    beamwidth: float = Form(40.0),
    attributes: str = Form("[]"),
    output_format: str = Form("tab"),
    current_user=Depends(require_data_import),
):
    """生成扇区图层，返回下载 URL"""
    import json
    try:
        src = _save_upload(file, file_path)
        attr_list = json.loads(attributes) if attributes else []
        out = await run_in_threadpool(
            layer_service.generate_sector_layer,
            str(src), sheet_name, name_col, lon_col, lat_col, azimuth_col,
            radius_m, beamwidth, attr_list, output_format,
        )
        return {"success": True, "data": {"filename": out.name, "download_url": f"/static/{out.name}"}}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"生成失败: {str(e)}")
```

`backend/app/api/v1/__init__.py` 修改：
- 第 6 行 import 增加 `layer`：
```python
from app.api.v1.endpoints import license, data, pci, neighbor, tac, map, geo_data, system, auth, admin_users, user_settings, websocket, app_versions, layer
```
- 末尾注册：
```python
api_router.include_router(layer.router, prefix="/layer", tags=["图层制作"])
```

`backend/app/api/__init__.py` 修改（下载 URL 通过 /static 提供服务，需挂载 UPLOAD_DIR 下 layers）：
- 第 232 行附近，在现有 `app.mount("/static", ...)` 后增加：
```python
app.mount("/layer-files", StaticFiles(directory=str(settings.UPLOAD_DIR / "layers")), name="layer-files")
```
- 端点返回的 `download_url` 改为 `/layer-files/{filename}`。

> 下载 URL 方式有两种，二选一：
> 1. **`/static` 挂载 `OUTPUT_DIR`**（已存在）—— 需把 layers 输出到 OUTPUT_DIR，或新增 `LAYER_DIR` 配置。
> 2. **新增 `/layer-files` 挂载** `UPLOAD_DIR/layers` —— 更清晰，见上。
> 推荐方案 2。若不想改挂载，可把 `LayerService.output_dir` 默认设为 `settings.OUTPUT_DIR / "layers"`，直接复用 `/static`。

### Step 4: Run test / manual verify

```bash
cd backend && .venv/bin/python -m pytest tests/test_layer_service.py -v
# 手动验证端点（可选）
.venv/bin/python -c "
from fastapi.testclient import TestClient
from app.api import create_app
import pandas as pd, tempfile, os
tmp = tempfile.mktemp(suffix='.xlsx')
pd.DataFrame({'NAME':['A'],'LONGITUDE':[116.3],'LATITUDE':[39.9]}).to_excel(tmp, sheet_name='S', index=False)
c = TestClient(create_app())
with open(tmp,'rb') as f:
    r = c.post('/api/v1/layer/excel-info', files={'file':('a.xlsx', f, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')})
print(r.status_code, r.json())
os.remove(tmp)
"
```

Expected: 全部 PASS；excel-info 返回 `{"success": true, "data": {"sheets": ["S"], "columns": {"S": ["NAME","LONGITUDE","LATITUDE"]}}}`

### Step 5: Commit

```bash
git add backend/app/api/v1/endpoints/layer.py backend/app/api/v1/__init__.py backend/app/api/__init__.py
git commit -m "feat: 图层制作 API 端点（excel-info/point/sector）"
```

---

## Task 3: 前端侧边栏 + 首页入口

**Files:**
- Modify: `frontend/src/renderer/components/Layout/MainLayout.tsx`
- Modify: `frontend/src/renderer/pages/HomePage.tsx`
- Modify: `frontend/src/renderer/App.tsx`
- Modify: `frontend/src/renderer/locales/zh.json`、`frontend/src/renderer/locales/en.json`

### Step 1: 翻译 key（zh.json + en.json 同步）

`zh.json` 的 `nav` 对象增加：
```json
"tools": "实用工具",
"layerTools": "图层制作"
```
`en.json` 的 `nav` 对象增加：
```json
"tools": "Utilities",
"layerTools": "Layer Tools"
```
`zh.json` / `en.json` 的 `home` 对象各增加 `layerToolsDesc`：
- zh: `"layerToolsDesc": "根据工参文件制作扇区/点图层 (tab/mif/kml)"`
- en: `"layerToolsDesc": "Create sector/point layers (tab/mif/kml) from params"`

### Step 2: 侧边栏加"实用工具"分组

`MainLayout.tsx`：
- import 增加 `Wrench`：
```typescript
import { ..., Wrench } from 'lucide-react'
```
- `navigation` 数组在地图工具链接（`{ type: 'link', name: t('nav.map'), ... }`）之后插入：
```typescript
{
  type: 'group',
  name: t('nav.tools'),
  icon: Wrench,
  children: [
    { type: 'link', name: t('nav.layerTools'), href: '/layer/sector' },
  ],
},
```

### Step 3: 首页加卡片

`HomePage.tsx`：
- import 增加 `Wrench`：
```typescript
import { ..., Wrench } from 'lucide-react'
```
- 在 `nav.config` 卡片前插入：
```tsx
<FeatureCard
  title={t('nav.layerTools')}
  description={t('home.layerToolsDesc')}
  icon={Wrench}
  link="/layer/sector"
  iconColor="text-blue-600"
/>
```

### Step 4: 路由注册

`App.tsx` 中 `path="/map"` 路由后增加两个路由（包在 `ProtectedRoute` 内）：
```tsx
<Route
  path="/layer/sector"
  element={
    <ProtectedRoute>
      <LayerSectorPage />
    </ProtectedRoute>
  }
/>
<Route
  path="/layer/point"
  element={
    <ProtectedRoute>
      <LayerPointPage />
    </ProtectedRoute>
  }
/>
```
import 增加：
```typescript
import LayerSectorPage from './pages/LayerSectorPage'
import LayerPointPage from './pages/LayerPointPage'
```
（页面组件将在 Task 4 创建，此步会暂时缺文件——先做页面再注册路由，或注册时用占位导出。）

> **顺序建议**：先完成 Task 4 创建页面文件，再改 App.tsx 路由，避免编译错误。

### Step 5: 验证

```bash
cd frontend && npm run type-check
```

Expected: PASS

### Step 6: Commit

```bash
git add frontend/src/renderer/components/Layout/MainLayout.tsx frontend/src/renderer/pages/HomePage.tsx frontend/src/renderer/App.tsx frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json
git commit -m "feat: 侧边栏实用工具分组+首页卡片+路由（图层制作）"
```

---

## Task 4: 前端 API 服务 + 公共配置组件

**Files:**
- Modify: `frontend/src/renderer/services/api.ts`
- Create: `frontend/src/renderer/components/layer/LayerAttributeConfig.tsx`
- Create: `frontend/src/renderer/config/layer-config.ts`（常量：关键字匹配、默认参数）

### Step 1: 写公共配置常量

`frontend/src/renderer/config/layer-config.ts`：
```typescript
// 关键字匹配规则：字段类型 → 候选列名模式（与后端 GeoFieldDetector 保持一致）
export interface LayerFieldMatch {
  type: 'name' | 'longitude' | 'latitude' | 'azimuth'
  labelKey: string
  patterns: string[]
}

export const LAYER_FIELD_MATCHES: LayerFieldMatch[] = [
  { type: 'name', labelKey: 'layer.fieldName', patterns: ['名称', 'name', '小区名', '站名', 'cell_name', 'site_name'] },
  { type: 'longitude', labelKey: 'layer.fieldLongitude', patterns: ['经度', 'longitude', 'lng', 'lon', 'x'] },
  { type: 'latitude', labelKey: 'layer.fieldLatitude', patterns: ['纬度', 'latitude', 'lat', 'y'] },
  { type: 'azimuth', labelKey: 'layer.fieldAzimuth', patterns: ['方位角', '方向角', 'azimuth', 'azi', 'azim', 'bearing'] },
]

// 自动匹配：对给定列名列表，找出每个字段最匹配的列
export function autoMatchFields(columns: string[], includeAzimuth: boolean): Record<string, string> {
  const result: Record<string, string> = {}
  const lowerCols = columns.map(c => c.toLowerCase())
  for (const match of LAYER_FIELD_MATCHES) {
    if (match.type === 'azimuth' && !includeAzimuth) continue
    let found: string | null = null
    // 精确匹配优先
    for (let i = 0; i < columns.length; i++) {
      if (match.patterns.some(p => p.toLowerCase() === lowerCols[i])) { found = columns[i]; break }
    }
    // 否则模糊匹配
    if (!found) {
      for (let i = 0; i < columns.length; i++) {
        if (match.patterns.some(p => lowerCols[i].includes(p.toLowerCase()))) { found = columns[i]; break }
      }
    }
    if (found) result[match.type] = found
  }
  return result
}

// 默认参数
export const LAYER_DEFAULT_PARAMS = {
  sector: { radiusM: 3000, beamwidth: 40, color: '#4A90D9', arcPoints: 30 },
  point: { pointSize: 8, color: '#FF0000' },
}
```

### Step 2: 公共列勾选 + 关键字匹配组件

`frontend/src/renderer/components/layer/LayerAttributeConfig.tsx`：
```tsx
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { autoMatchFields, LayerFieldMatch } from '../../config/layer-config'

interface Props {
  columns: string[]
  includeAzimuth: boolean
  selectedFields: Record<string, string>      // 已选属性列名 → 列名
  onSelectedFieldsChange: (f: Record<string, string>) => void
  fieldMappings: Record<string, string>       // type → 列名
  onFieldMappingsChange: (m: Record<string, string>) => void
}

/**
 * 图层属性配置：列勾选 + 关键字匹配下拉
 * 勾选的列进入图层属性；name/lon/lat/azimuth 四类关键字必选映射。
 */
export function LayerAttributeConfig({
  columns, includeAzimuth, selectedFields, onSelectedFieldsChange,
  fieldMappings, onFieldMappingsChange,
}: Props) {
  const { t } = useTranslation()
  const fieldTypes: LayerFieldMatch[] = useMemo(
    () => LAYER_FIELD_MATCHES.filter(m => includeAzimuth || m.type !== 'azimuth'),
    [includeAzimuth],
  )

  // 列变化时自动匹配关键字
  useEffect(() => {
    if (!columns.length) return
    const matched = autoMatchFields(columns, includeAzimuth)
    onFieldMappingsChange({ ...matched })
    // 默认全选作为属性列（除关键字列外自动保留）
    const all: Record<string, string> = {}
    columns.forEach(c => { all[c] = c })
    onSelectedFieldsChange(all)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns.join('|'), includeAzimuth])

  const toggleAttribute = (col: string, checked: boolean) => {
    const next = { ...selectedFields }
    if (checked) next[col] = col
    else delete next[col]
    onSelectedFieldsChange(next)
  }

  return (
    <div className="space-y-4">
      {/* 列勾选 */}
      <div>
        <p className="text-xs font-medium mb-2">{t('layer.selectAttributes')}</p>
        <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto border border-border rounded-lg p-3">
          {columns.map(col => (
            <label key={col} className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={!!selectedFields[col]}
                onChange={e => toggleAttribute(col, e.target.checked)}
              />
              <span className="truncate">{col}</span>
            </label>
          ))}
        </div>
      </div>

      {/* 关键字匹配 */}
      <div className="space-y-2">
        <p className="text-xs font-medium">{t('layer.keywordMatch')}</p>
        {fieldTypes.map(f => (
          <div key={f.type} className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-20">{t(f.labelKey)}</span>
            <select
              value={fieldMappings[f.type] || ''}
              onChange={e => onFieldMappingsChange({ ...fieldMappings, [f.type]: e.target.value })}
              className="flex-1 h-8 px-2 text-xs border border-border rounded bg-card"
            >
              <option value="">{t('layer.selectColumn')}</option>
              {columns.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  )
}
```

### Step 3: 前端 API 函数

`frontend/src/renderer/services/api.ts` 增加（放在 uploadGeoData 附近）：

```typescript
// ===== 图层制作 =====
export interface LayerExcelInfo {
  sheets: string[]
  columns: Record<string, string[]>
}

export async function getLayerExcelInfo(file: File): Promise<LayerExcelInfo> {
  const formData = new FormData()
  formData.append('file', file)
  const res = await uploadClient.post('/layer/excel-info', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data?.data
}

export interface GenerateLayerParams {
  file: File
  sheetName: string
  nameCol: string
  lonCol: string
  latCol: string
  azimuthCol?: string
  attributes: string[]
  outputFormat: 'tab' | 'mif' | 'kml'
  radiusM?: number
  beamwidth?: number
}

export async function generateSectorLayer(params: GenerateLayerParams): Promise<{ filename: string; download_url: string }> {
  const formData = new FormData()
  formData.append('file', params.file)
  formData.append('sheet_name', params.sheetName)
  formData.append('name_col', params.nameCol)
  formData.append('lon_col', params.lonCol)
  formData.append('lat_col', params.latCol)
  formData.append('azimuth_col', params.azimuthCol || '')
  formData.append('attributes', JSON.stringify(params.attributes))
  formData.append('output_format', params.outputFormat)
  if (params.radiusM) formData.append('radius_m', String(params.radiusM))
  if (params.beamwidth) formData.append('beamwidth', String(params.beamwidth))
  const res = await uploadClient.post('/layer/sector', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data?.data
}

export async function generatePointLayer(params: GenerateLayerParams): Promise<{ filename: string; download_url: string }> {
  const formData = new FormData()
  formData.append('file', params.file)
  formData.append('sheet_name', params.sheetName)
  formData.append('name_col', params.nameCol)
  formData.append('lon_col', params.lonCol)
  formData.append('lat_col', params.latCol)
  formData.append('attributes', JSON.stringify(params.attributes))
  formData.append('output_format', params.outputFormat)
  const res = await uploadClient.post('/layer/point', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data?.data
}
```

> 注：`uploadClient` 是文件上传专用实例（已有 auth token 拦截器）。生产环境 baseURL 为 `/api/v1`，与后端 `/layer/*` 匹配。

### Step 4: 验证

```bash
cd frontend && npm run type-check
```

Expected: PASS

### Step 5: Commit

```bash
git add frontend/src/renderer/services/api.ts frontend/src/renderer/components/layer/LayerAttributeConfig.tsx frontend/src/renderer/config/layer-config.ts
git commit -m "feat: 图层制作 API 客户端 + 属性配置组件"
```

---

## Task 5: 前端扇区/点图层页面

**Files:**
- Create: `frontend/src/renderer/pages/LayerSectorPage.tsx`
- Create: `frontend/src/renderer/pages/LayerPointPage.tsx`

### Step 1: 扇区图层页面

`frontend/src/renderer/pages/LayerSectorPage.tsx`：

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, Loader2, Download, CheckCircle2 } from 'lucide-react'
import { getLayerExcelInfo, generateSectorLayer } from '../services/api'
import { LayerAttributeConfig } from '../components/layer/LayerAttributeConfig'
import { LAYER_DEFAULT_PARAMS } from '../config/layer-config'

export default function LayerSectorPage() {
  const { t } = useTranslation()
  const [file, setFile] = useState<File | null>(null)
  const [sheets, setSheets] = useState<string[]>([])
  const [columns, setColumns] = useState<string[]>([])
  const [sheetName, setSheetName] = useState('')
  const [selectedFields, setSelectedFields] = useState<Record<string, string>>({})
  const [fieldMappings, setFieldMappings] = useState<Record<string, string>>({})
  const [radiusM, setRadiusM] = useState(LAYER_DEFAULT_PARAMS.sector.radiusM)
  const [beamwidth, setBeamwidth] = useState(LAYER_DEFAULT_PARAMS.sector.beamwidth)
  const [color, setColor] = useState(LAYER_DEFAULT_PARAMS.sector.color)
  const [format, setFormat] = useState<'tab' | 'mif' | 'kml'>('tab')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ filename: string; download_url: string } | null>(null)
  const [error, setError] = useState('')

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    setResult(null); setError('')
    try {
      const info = await getLayerExcelInfo(f)
      setSheets(info.sheets)
      setSheetName(info.sheets[0] || '')
      setColumns(info.columns[info.sheets[0]] || [])
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || String(err))
    }
  }

  const handleSheetChange = (s: string) => {
    setSheetName(s)
    // 需重新获取该 sheet 的列（excel-info 已返回所有 sheet 列，可从缓存取）
    // 简单实现：重新解析（若列未缓存），此处列集已固定为首个 sheet——见下方改进
  }

  const handleGenerate = async () => {
    if (!file || !sheetName) return
    if (!fieldMappings.name || !fieldMappings.longitude || !fieldMappings.latitude || !fieldMappings.azimuth) {
      setError(t('layer.errMissingFields')); return
    }
    setLoading(true); setError('')
    try {
      const data = await generateSectorLayer({
        file, sheetName,
        nameCol: fieldMappings.name,
        lonCol: fieldMappings.longitude,
        latCol: fieldMappings.latitude,
        azimuthCol: fieldMappings.azimuth,
        attributes: Object.values(selectedFields),
        outputFormat: format,
        radiusM, beamwidth,
      })
      setResult(data)
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-base font-bold mb-6">{t('nav.layerTools')} · {t('layer.sectorLayer')}</h1>

      {/* ① 导入 */}
      <label className="block p-6 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary transition-colors text-center">
        <FileUp className="mx-auto mb-2 text-muted-foreground" size={24} />
        <p className="text-sm">{file ? file.name : t('layer.uploadExcel')}</p>
        <p className="text-xs text-muted-foreground mt-1">{t('layer.acceptExcel')}</p>
        <input type="file" className="hidden" accept=".xlsx,.xls" onChange={handleFile} />
      </label>

      {/* ② Sheet 选择 */}
      {sheets.length > 0 && (
        <div className="mt-6 space-y-2">
          <p className="text-xs font-medium">{t('layer.selectSheet')}</p>
          <select value={sheetName} onChange={e => handleSheetChange(e.target.value)}
            className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
            {sheets.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      )}

      {/* ③ 属性配置 */}
      {columns.length > 0 && (
        <div className="mt-6 p-4 bg-card border border-border rounded-lg">
          <LayerAttributeConfig
            columns={columns}
            includeAzimuth
            selectedFields={selectedFields}
            onSelectedFieldsChange={setSelectedFields}
            fieldMappings={fieldMappings}
            onFieldMappingsChange={setFieldMappings}
          />
        </div>
      )}

      {/* ④ 参数设置 */}
      {columns.length > 0 && (
        <div className="mt-6 p-4 bg-card border border-border rounded-lg grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium mb-1">{t('layer.radius')} (m)</label>
            <input type="number" value={radiusM} onChange={e => setRadiusM(Number(e.target.value))}
              className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">{t('layer.beamwidth')} (°)</label>
            <input type="number" value={beamwidth} onChange={e => setBeamwidth(Number(e.target.value))}
              className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">{t('layer.fillColor')}</label>
            <input type="color" value={color} onChange={e => setColor(e.target.value)}
              className="w-full h-9 cursor-pointer" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">{t('layer.outputFormat')}</label>
            <select value={format} onChange={e => setFormat(e.target.value as any)}
              className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
              <option value="tab">TAB</option>
              <option value="mif">MIF</option>
              <option value="kml">KML</option>
            </select>
          </div>
        </div>
      )}

      {error && <p className="mt-4 text-xs text-red-500">{error}</p>}

      {/* 生成 + 下载 */}
      <div className="mt-6 flex items-center gap-4">
        <button onClick={handleGenerate} disabled={loading || !file || !sheetName}
          className="px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium">
          {loading ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
          {t('layer.generate')}
        </button>
        {result && (
          <a href={result.download_url} download
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-green-600 text-white rounded-lg hover:opacity-90 text-sm">
            <Download size={16} /> {t('layer.download')}
          </a>
        )}
        {result && <CheckCircle2 className="text-green-500" size={18} />}
      </div>
    </div>
  )
}
```

> **改进点（sheet 切换列名）**：`excel-info` 返回了所有 sheet 的列（`columns: Record<sheet, string[]>`），页面应保存整个 `info` 而不是只存首个 sheet 的列。`handleSheetChange` 从 `info.columns[s]` 取列。请保存 `info` 状态并在切换时更新 columns。

### Step 2: 点图层页面

`frontend/src/renderer/pages/LayerPointPage.tsx`：
- 与扇区页同构，差异：
  - `LayerAttributeConfig` 的 `includeAzimuth={false}`（不需要方向角）
  - 参数为 `pointSize`（点大小）和 `color`（填充颜色），无 radius/beamwidth
  - 调 `generatePointLayer`，不传 `azimuth_col`/`radiusM`/`beamwidth`
  - 标题 `t('layer.pointLayer')`

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, Loader2, Download, CheckCircle2 } from 'lucide-react'
import { getLayerExcelInfo, generatePointLayer } from '../services/api'
import { LayerAttributeConfig } from '../components/layer/LayerAttributeConfig'
import { LAYER_DEFAULT_PARAMS } from '../config/layer-config'

export default function LayerPointPage() {
  const { t } = useTranslation()
  const [file, setFile] = useState<File | null>(null)
  const [info, setInfo] = useState<{ sheets: string[]; columns: Record<string, string[]> } | null>(null)
  const [columns, setColumns] = useState<string[]>([])
  const [sheetName, setSheetName] = useState('')
  const [selectedFields, setSelectedFields] = useState<Record<string, string>>({})
  const [fieldMappings, setFieldMappings] = useState<Record<string, string>>({})
  const [pointSize, setPointSize] = useState(LAYER_DEFAULT_PARAMS.point.pointSize)
  const [color, setColor] = useState(LAYER_DEFAULT_PARAMS.point.color)
  const [format, setFormat] = useState<'tab' | 'mif' | 'kml'>('tab')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ filename: string; download_url: string } | null>(null)
  const [error, setError] = useState('')

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f); setResult(null); setError('')
    try {
      const data = await getLayerExcelInfo(f)
      setInfo(data)
      setSheetName(data.sheets[0] || '')
      setColumns(data.columns[data.sheets[0]] || [])
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || String(err))
    }
  }

  const handleSheetChange = (s: string) => {
    setSheetName(s)
    if (info) setColumns(info.columns[s] || [])
  }

  const handleGenerate = async () => {
    if (!file || !sheetName) return
    if (!fieldMappings.name || !fieldMappings.longitude || !fieldMappings.latitude) {
      setError(t('layer.errMissingFields')); return
    }
    setLoading(true); setError('')
    try {
      const data = await generatePointLayer({
        file, sheetName,
        nameCol: fieldMappings.name,
        lonCol: fieldMappings.longitude,
        latCol: fieldMappings.latitude,
        attributes: Object.values(selectedFields),
        outputFormat: format,
      })
      setResult(data)
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || String(err))
    } finally {
      setLoading(false)
    }
  }

  // JSX 与扇区页同构；参数区改为 点大小 + 填充颜色
  // ...（省略重复 JSX，字段与扇区页一致，参数区为 pointSize + color）
}
```

> 点大小 `pointSize` 仅用于 KML 图标大小；MapInfo TAB/MIF 的点样式由用户在 GIS 软件中设置。若需 KML 内嵌颜色/大小样式，可在 `LayerService._write` 生成 KML 前为 gdf 添加 `IconStyle` 扩展字段（后续增强，当前 YAGNI）。

### Step 3: 补全翻译 key

`zh.json` / `en.json` 新增 `layer` 对象：
- zh:
```json
"layer": {
  "sectorLayer": "扇区图层",
  "pointLayer": "点图层",
  "uploadExcel": "点击或拖拽导入 Excel 工参文件",
  "acceptExcel": "支持 .xlsx / .xls",
  "selectSheet": "数据来源 (Sheet)",
  "selectAttributes": "图层属性 (勾选列)",
  "keywordMatch": "关键字匹配",
  "fieldName": "标签名称",
  "fieldLongitude": "经度",
  "fieldLatitude": "纬度",
  "fieldAzimuth": "方向角",
  "selectColumn": "请选择列",
  "radius": "扇区半径",
  "beamwidth": "波瓣夹角",
  "fillColor": "填充颜色",
  "pointSize": "点大小",
  "outputFormat": "输出格式",
  "generate": "生成图层",
  "download": "下载图层",
  "errMissingFields": "请确保标签名称、经度、纬度、方向角均已正确匹配",
  "errSheet": "请先选择 Sheet"
}
```
- en:
```json
"layer": {
  "sectorLayer": "Sector Layer",
  "pointLayer": "Point Layer",
  "uploadExcel": "Click or drag to import Excel params",
  "acceptExcel": "Supports .xlsx / .xls",
  "selectSheet": "Data Source (Sheet)",
  "selectAttributes": "Layer Attributes (check columns)",
  "keywordMatch": "Keyword Match",
  "fieldName": "Label Name",
  "fieldLongitude": "Longitude",
  "fieldLatitude": "Latitude",
  "fieldAzimuth": "Azimuth",
  "selectColumn": "Select column",
  "radius": "Sector Radius",
  "beamwidth": "Beamwidth",
  "fillColor": "Fill Color",
  "pointSize": "Point Size",
  "outputFormat": "Output Format",
  "generate": "Generate Layer",
  "download": "Download Layer",
  "errMissingFields": "Please ensure label name, longitude, latitude, azimuth are matched",
  "errSheet": "Please select a Sheet first"
}
```

### Step 4: 验证

```bash
cd frontend && npm run type-check
```

Expected: PASS

### Step 5: Commit

```bash
git add frontend/src/renderer/pages/LayerSectorPage.tsx frontend/src/renderer/pages/LayerPointPage.tsx frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json
git commit -m "feat: 图层制作页面（扇区/点）"
```

---

## Task 6: 集成验证 + 回归

**Files:**
- 无新增

### Step 1: 后端全量测试

```bash
cd backend && .venv/bin/python -m pytest -v
```

Expected: 所有既有测试 + 新测试全部 PASS

### Step 2: 前端 type-check + lint

```bash
cd frontend && npm run type-check && npm run lint
```

Expected: PASS

### Step 3: 手动端到端验证

1. 启动后端：`cd backend && .venv/bin/python main.py`
2. 启动前端：`cd frontend && npm run dev:web`
3. 浏览器访问 http://localhost:5173
4. 侧边栏确认"实用工具"分组 → "图层制作"可见
5. 首页确认"图层制作"卡片可点
6. 进入扇区页面，导入含 `NAME/LONGITUDE/LATITUDE/AZIMUTH` 的 xlsx
7. 确认 sheet 下拉、列勾选、关键字自动匹配
8. 设半径 3000、夹角 40、格式 tab → 生成 → 下载
9. 用 QGIS / MapInfo 打开 .tab 验证扇区几何正确
10. 重复验证 mif、kml 两种格式
11. 进入点图层页面，导入数据 → 生成 → 验证点图层

### Step 4: Commit（若有遗留修复）

```bash
git add -A
git commit -m "fix: 图层制作集成修复"
```

---

## 风险与注意事项

1. **`UploadArea` 未导出**：DataPage 的 `UploadArea` 是内部组件，图层页面自建简化导入栏（见 Task 5），不强行复用。
2. **pyogrio driver 依赖**：已实测 `MapInfo File` 和 `KML` 驱动可用（pyogrio 0.13.0）。若某环境缺驱动，`gdf.to_file` 会抛 `ValueError`，端点会捕获为 500 并提示。
3. **扇区几何坐标顺序**：pyogrio/geopandas 用 `(x=lng, y=lat)` 顺序（Point/坐标元组都是 lng 在前），`sector_polygon` 返回的 Polygon 顶点已按 `(lng, lat)` 顺序生成（Task 1 实现里 `pts` 用 `(lng, lat)`），不要写反。
4. **中文列名**：属性列名保持原样（中文），MapInfo TAB 支持 UTF-8 中文列名。若遇编码问题，可在写入前把列名统一转 ASCII（后续增强）。
5. **`attributes` 传参**：前端 `Object.values(selectedFields)` 传勾选的列名数组；后端 `_build_gdf` 用 `attributes` 白名单过滤。
6. **Sheet 切换列**：前端必须保存 `excel-info` 返回的完整 `columns`（所有 sheet），切换 sheet 时更新列，否则列名是首个 sheet 的（Task 5 扇区页改进点）。

## 范围外（YAGNI，已在设计文档列明）

- 多 sheet 批量生成
- MapInfo 图层样式内嵌颜色
- MIF/TAB 样式差异处理
- Electron 本地路径直接写入
