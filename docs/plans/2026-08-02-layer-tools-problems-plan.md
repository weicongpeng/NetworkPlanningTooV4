# 图层制作问题修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复图层制作 5 项问题：共享导入、UI 统一、默认全勾选、TAB/MIF 字段名清洗+读回验证、历史清理+打包去重。

**Architecture:** 前端把文件导入从 TabState 提升为页面级共享状态 sharedFile；后端在写出 TAB/MIF 前清洗 MapInfo 非法字段名字符（空格→下划线），生成后读回验证文件可解析；`_cleanup_old_outputs` 清理列表补 `.kml`，`_finalize_outputs` 改用精确配套文件收集避免 glob 混入历史残留。

**Tech Stack:** React 18 + TypeScript + Zustand + Tailwind + Radix；FastAPI + pyogrio/geopandas + pandas。

**设计文档:** `docs/plans/2026-08-02-layer-tools-problems-design.md`

---

### Task 1: 字段名清洗（问题 4 根因）

**Files:**
- Modify: `backend/app/services/layer_service.py`（新增 `_sanitize_field_name`、`_dedupe_field_names`，`_mapinfo_postprocess` 应用清洗）
- Test: `backend/tests/test_layer_service.py`

**Step 1: 写失败测试（含空格列名）**

```python
def test_mapinfo_field_name_sanitized(service, tmp_path):
    """含空格列名（SITE ID/CELL ID）→ TAB 生成后可读，字段名转下划线"""
    path = tmp_path / "工参.xlsx"
    df = pd.DataFrame({"SITE ID": ["A"], "CELL ID": ["B"], "经度": [116.4], "纬度": [39.9]})
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, _ = service.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="SITE ID", lon_col="经度", lat_col="纬度",
        attributes=["SITE ID", "CELL ID"], output_format="tab",
    )
    import geopandas as gpd
    gdf = gpd.read_file(out)  # 修复前：Failed to parse field definition
    assert "SITE_ID" in gdf.columns
    assert "CELL_ID" in gdf.columns


def test_mapinfo_field_name_dedupe(service, tmp_path):
    """清洗后重名（SITE ID 与 SITE_ID）→ 自动加序号去重，不崩溃"""
    path = tmp_path / "d.xlsx"
    df = pd.DataFrame({"SITE ID": ["A"], "SITE_ID": ["B"], "经度": [116.4], "纬度": [39.9]})
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, _ = service.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="SITE ID", lon_col="经度", lat_col="纬度",
        attributes=["SITE ID", "SITE_ID"], output_format="tab",
    )
    import geopandas as gpd
    gdf = gpd.read_file(out)
    assert len(gdf.columns) == 3  # 两个字段 + geometry
```

**Step 2: 运行测试确认失败**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_service.py::test_mapinfo_field_name_sanitized -q`
Expected: FAIL — `Failed to parse field definition at line ...`

**Step 3: 实现字段名清洗**

在 `layer_service.py` 顶部（`DRIVER_MAP` 附近）加常量与函数：

```python
# MapInfo 非法字段名字符（非字母数字/下划线/中文）
_MAPINFO_INVALID = re.compile(r"[^\w一-鿿]+")


def _sanitize_field_name(name: str) -> str:
    """MapInfo 字段名清洗：非法字符（空格等）→ 下划线，合并相邻下划线，去首尾。"""
    cleaned = _MAPINFO_INVALID.sub("_", name)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return cleaned


def _dedupe_field_names(names: list) -> list:
    """清洗后字段名去重：重名追加 _2/_3 序号，保持相对顺序。"""
    seen = {}
    result = []
    for n in names:
        if n not in seen:
            seen[n] = 1
            result.append(n)
        else:
            seen[n] += 1
            result.append(f"{n}_{seen[n]}")
    return result
```

**Step 4: 在 `_mapinfo_postprocess` 恢复列名时清洗**

修改 `_write` 调用 `_mapinfo_postprocess` 前，先把 `orig_cols` 清洗去重：

```python
# 在 _write 中，orig_cols 取出后：
orig_cols = list(gdf.columns)
sanitized_cols = _dedupe_field_names([_sanitize_field_name(c) for c in orig_cols])
# _mapinfo_postprocess 接收 sanitized_cols（而非 orig_cols）
```

修改 `_mapinfo_postprocess` 签名：`original_columns: list` → `sanitized_cols: list`，函数体内 `original_columns` 全部替换为 `sanitized_cols`。KML 路径（`_ensure_kml_name`）的 `Name` 列不受影响。

**Step 5: 运行测试确认通过**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_service.py::test_mapinfo_field_name_sanitized tests/test_layer_service.py::test_mapinfo_field_name_dedupe -q`
Expected: PASS

**Step 6: 回归全量服务测试**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_service.py -q`
Expected: 全部 PASS（现有中文列名测试 `test_tab_chinese_fields_readable` 应仍通过，中文不含空格）

**Step 7: 提交**

```bash
git add backend/app/services/layer_service.py backend/tests/test_layer_service.py
git commit -m "fix: MapInfo字段名非法字符清洗（空格→下划线）+去重，修复TAB/MIF打不开"
```

---

### Task 2: 读回验证（问题 4 用户核心诉求）

**Files:**
- Modify: `backend/app/services/layer_service.py`（新增 `_verify_readable`，`generate_point_layer`/`generate_sector_layer` 调用）
- Test: `backend/tests/test_layer_service.py`

**Step 1: 写失败测试**

```python
def test_verify_readable_rejects_corrupt(service, tmp_path):
    """读回验证：损坏文件 → 抛 ValueError"""
    out = tmp_path / "bad.tab"
    out.write_text("!table\n!version 300\n", encoding="gbk")  # 缺字段定义
    with pytest.raises(ValueError, match="校验失败"):
        service._verify_readable(out, 1, "tab")


def test_generate_point_layer_readback_ok(service, sample_excel):
    """生成后读回验证通过：行数 = 成功数"""
    out, stats = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME", "PCI"], output_format="tab",
    )
    assert stats["success"] == 2
    # 生成流程内部已调用 _verify_readable，未抛错即通过
    assert out.exists()
```

**Step 2: 运行测试确认失败**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_service.py::test_verify_readable_rejects_corrupt -q`
Expected: FAIL — `AttributeError: 'LayerService' object has no attribute '_verify_readable'`

**Step 3: 实现读回验证**

```python
def _verify_readable(self, out_path: Path, expected_rows: int, output_format: str):
    """生成后读回验证：文件可解析且行数一致，否则抛 ValueError。"""
    try:
        if output_format == "kml":
            import xml.etree.ElementTree as ET
            ET.fromstring(out_path.read_text(encoding="utf-8", errors="replace"))
            return
        import pyogrio
        info = pyogrio.read_info(str(out_path))
        if info["features"] != expected_rows:
            raise ValueError(
                f"读回行数不一致（期望 {expected_rows}，实际 {info['features']}）"
            )
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"生成文件校验失败（{output_format} 不可读）: {str(e)}") from e
```

**Step 4: 在 generate 函数末尾调用**

在 `generate_point_layer` 和 `generate_sector_layer` 的 `out = self._apply_color(...)` 之后加：

```python
self._verify_readable(out, int(valid.sum()), output_format)
```

**Step 5: 运行测试确认通过**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_service.py::test_verify_readable_rejects_corrupt tests/test_layer_service.py::test_generate_point_layer_readback_ok -q`
Expected: PASS

**Step 6: 回归全量服务测试**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_service.py -q`
Expected: 全部 PASS（KML 读回用 XML 解析，颜色注入后仍合法）

**Step 7: 提交**

```bash
git add backend/app/services/layer_service.py backend/tests/test_layer_service.py
git commit -m "fix: 图层生成后读回验证（TAB/MIF行数+KML XML），确保剔除失败行后文件可用"
```

---

### Task 3: 历史清理补 .kml + 打包精确配套收集（问题 4b/5）

**Files:**
- Modify: `backend/app/services/layer_service.py`（`_cleanup_old_outputs` 后缀补 `.kml`）
- Modify: `backend/app/api/v1/endpoints/layer.py`（`_finalize_outputs` 精确配套收集）
- Test: `backend/tests/test_layer_service.py`、`backend/tests/test_layer_api.py`

**Step 1: 写失败测试（服务层清理含 .kml）**

```python
def test_cleanup_old_outputs_removes_kml_history(tmp_path):
    """_cleanup_old_outputs 补删 .kml 历史（-1/-2 后缀）"""
    svc = LayerService(output_dir=tmp_path)
    (tmp_path / "源_LTE-1.kml").write_text("x")
    (tmp_path / "源_LTE-2.kml").write_text("x")
    svc._cleanup_old_outputs("源_LTE")
    assert not (tmp_path / "源_LTE-1.kml").exists()
    assert not (tmp_path / "源_LTE-2.kml").exists()
```

**Step 2: 运行测试确认失败**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_service.py::test_cleanup_old_outputs_removes_kml_history -q`
Expected: FAIL — `源_LTE-1.kml` 仍存在（当前清理列表不含 .kml）

**Step 3: 实现清理列表补 .kml**

修改 `_cleanup_old_outputs`：

```python
_CLEANUP_SUFFIXES = (".tab", ".dat", ".id", ".map", ".mif", ".mid", ".zip", ".kml")

def _cleanup_old_outputs(self, base: str):
    for f in self.output_dir.glob(f"{base}*"):
        if f.suffix in _CLEANUP_SUFFIXES:
            f.unlink(missing_ok=True)
```

**Step 4: 写失败测试（API zip 无重复序号文件）**

在 `test_layer_api.py` 新增：

```python
def test_multi_format_zip_excludes_historical_suffixed_files():
    """预置 -1.kml/-2.kml 历史残留 → 新生成多格式 zip 不含它们（精确配套收集）"""
    layers_dir = settings.UPLOAD_DIR / "layers"
    layers_dir.mkdir(parents=True, exist_ok=True)
    # 预置历史残留（模拟之前清理失败留下的）
    hist = layers_dir / "残留_LTE-1.kml"
    hist.write_text("x")
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("残留.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE", "name_col": "NAME",
                    "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                    "attributes": '["NAME"]', "output_formats": "tab,kml",
                    "source_filename": "残留.xlsx",
                },
            )
        assert resp.status_code == 200
        dl = client.get(resp.json()["data"]["download_url"])
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            names = zf.namelist()
        # 不含历史序号文件
        assert not any("-1." in n or "-2." in n for n in names), f"历史残留进zip: {names}"
        # 含本次 tab+kml
        suffixes = {Path(n).suffix for n in names}
        assert {".tab", ".kml"}.issubset(suffixes)
    finally:
        os.remove(path)
        if hist.exists():
            hist.unlink()
```

**Step 5: 运行测试确认失败**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_api.py::test_multi_format_zip_excludes_historical_suffixed_files -q`
Expected: FAIL — zip 内含 `残留_LTE-1.kml`（glob 前缀匹配）

**Step 6: 实现精确配套收集**

在 `layer.py` 新增辅助函数并改写 `_finalize_outputs`：

```python
def _companion_files(out: Path) -> list:
    """TAB/MIF 的精确配套文件（不含历史序号残留）。TAB: .tab/.dat/.id/.map；MIF: .mif/.mid；KML: .kml 单文件。"""
    stem = out.stem
    if out.suffix == ".tab":
        return [out.parent / f"{stem}{s}" for s in (".tab", ".dat", ".id", ".map") if (out.parent / f"{stem}{s}").exists()]
    if out.suffix == ".mif":
        return [out.parent / f"{stem}{s}" for s in (".mif", ".mid") if (out.parent / f"{stem}{s}").exists()]
    return [out]


def _finalize_outputs(outs: list, formats: list) -> dict:
    if len(outs) == 1:
        return _finalize_output(outs[0], formats[0])
    base = outs[0].stem
    zip_path = outs[0].parent / f"{base}.zip"
    written = set()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for out in outs:
            for f in _companion_files(out):
                if f.name != zip_path.name and f.name not in written:
                    zf.write(f, arcname=f.name)
                    written.add(f.name)
    return {"filename": zip_path.name, "download_url": f"/layer-files/{zip_path.name}"}
```

**Step 7: 运行测试确认通过**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_api.py::test_multi_format_zip_excludes_historical_suffixed_files -q`
Expected: PASS

**Step 8: 回归 API 测试**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_api.py -q`
Expected: 全部 PASS（现有 `test_multi_format_zip_no_duplicate_names`、`test_repeat_generate_via_endpoint_keeps_latest_only` 应仍通过）

**Step 9: 提交**

```bash
git add backend/app/services/layer_service.py backend/app/api/v1/endpoints/layer.py backend/tests/test_layer_service.py backend/tests/test_layer_api.py
git commit -m "fix: 清理补.kml+打包精确配套收集，杜绝历史序号文件进zip"
```

---

### Task 4: 前端共享导入（问题 1）

**Files:**
- Modify: `frontend/src/renderer/pages/LayerToolsPage.tsx`
- Modify: `frontend/src/renderer/locales/zh.json`、`frontend/src/renderer/locales/en.json`

**Step 1: 重构页面级共享状态**

在 `LayerToolsPage` 组件内新增 `SharedFile` 类型与状态：

```ts
interface SharedFile {
  filePath: string
  sourceFilename: string
  fileName: string
  sheetName: string
  info: LayerExcelInfo | null
  columns: string[]
}
```

- 从 `TabState` 中**移除** `filePath/sourceFilename/fileName/sheetName/info/columns` 字段（只保留 `selectedFields/fieldMappings/radiusM/beamwidth/pointSize/color/formats/result/error`）
- 新增 `const [sharedFile, setSharedFile] = useState<SharedFile>(() => loadSharedFile())`
- `handleFile` 改为写 `sharedFile`（不再写 `setState`）
- 新增 `loadSharedFile`/`saveSharedFile`（sessionStorage key `layerTools.shared`）
- `renderTabContent` 接收 `sharedFile` 作为 props；sheet 选择写 `sharedFile`
- `handleGenerate` 的 `base` 从 `sharedFile` 取 `filePath/sourceFilename/sheetName`

**Step 2: 运行 type-check**

Run: `cd frontend && npm run type-check`
Expected: 0 错误

**Step 3: 提交**

```bash
git add frontend/src/renderer/pages/LayerToolsPage.tsx
git commit -m "feat: 文件导入提升为页面级共享状态，一份文件同时作用于扇区/点图"
```

---

### Task 5: 前端 UI 统一 + 默认全勾选（问题 2/3）

**Files:**
- Modify: `frontend/src/renderer/pages/LayerToolsPage.tsx`
- Modify: `frontend/src/renderer/locales/zh.json`、`frontend/src/renderer/locales/en.json`

**Step 1: 默认格式全勾选**

在 `emptyTabState`：

```ts
formats: ['tab', 'mif', 'kml'],
```

**Step 2: 导入区 UI 卡片化**

导入区外层从 `<div className="mb-6">` 改为卡片容器：

```tsx
<div className="mb-6 p-4 bg-card border border-border rounded-lg">
  <p className="text-xs font-medium mb-2">{t('layer.fileImport')}</p>
  <div className="grid grid-cols-5 gap-6">
    <div className="col-span-3">
      {/* 保留虚线上传区，尺寸对齐 */}
      <label className="block flex items-center gap-3 px-4 py-3 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary transition-colors">
        ...
      </label>
    </div>
  </div>
</div>
```

**Step 3: 运行 type-check + build**

Run: `cd frontend && npm run type-check && npm run build:vite`
Expected: 0 错误，构建成功

**Step 4: 提交**

```bash
git add frontend/src/renderer/pages/LayerToolsPage.tsx
git commit -m "feat: 导入区卡片化UI统一+输出格式默认全勾选"
```

---

### Task 6: 全量回归验证

**Files:** 无新增

**Step 1: 后端全量测试**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_service.py tests/test_layer_api.py -q`
Expected: 全部 PASS

**Step 2: 前端类型检查**

Run: `cd frontend && npm run type-check`
Expected: 0 错误

**Step 3: 手动验证清单**

- 导入一次文件 → 切扇区/点图 Tab，两页都能看到文件并独立配置
- 输出格式默认 tab+mif+kml 全勾选
- 含 `SITE ID` 列名的源文件 → 生成 TAB 在 MapInfo 打开正常
- 连续生成两次 → 下载 zip 只有一套文件，无 `-1/-2` 序号
- 生成失败条目剔除后，下载文件在 MapInfo/GIS 工具可正常打开

**Step 4: 部署（如生产需要）**

```bash
cd /DATA/AppData/NetworkPlanningTooV3
# 一次清理历史残留（释放磁盘，可选）
rm -rf uploads/layers/*
cd frontend && npm run build:vite
systemctl restart npt-backend
```

**Step 5: 提交**

```bash
git add -A
git commit -m "chore: 图层制作问题修复全量回归验证"
```
