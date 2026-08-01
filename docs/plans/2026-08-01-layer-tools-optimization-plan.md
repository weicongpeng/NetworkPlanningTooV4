# 图层制作功能优化 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复图层制作 8 项问题（上传效率、中文编码、持久化、进度、输入框、命名、UI 合并、生成统计）

**Architecture:** 后端 `layer_service.py` 改造逐行校验+GBK 编码写入+TAB/MIF 后处理；`layer.py` 支持多格式打包+统计返回；前端合并两页为 `LayerToolsPage` 用 Radix Tabs，状态存 sessionStorage 实现持久化；`api.ts` 分块上传改 512KB+块级超时+即时进度。

**Tech Stack:** FastAPI + geopandas/pyogrio + React + Radix Tabs + Zustand + sessionStorage

**设计文档:** `docs/plans/2026-08-01-layer-tools-optimization-design.md`（已提交 `f2980ce`）

---

## 全局约定

- **测试命令**：`cd backend && .venv/bin/python -m pytest tests/test_layer_service.py tests/test_layer_api.py -q 2>&1 | tail -5`
- **类型检查**：`cd frontend && npx tsc --noEmit 2>&1 | grep -E "api.ts|LayerToolsPage|LayerSectorPage|LayerPointPage" || echo "NO_TYPE_ERRORS_IN_TOUCHED_FILES"`
- **提交规范**：`Co-Authored-By: Claude <noreply@anthropic.com>`
- 分支：`layer-tools`（当前）

---

### Task 1: 后端逐行校验 + 生成统计（核心重构）

**Files:**
- Modify: `backend/app/services/layer_service.py:102-120`（`_read_sheet`/`_coerce_coords` 改造）
- Modify: `backend/app/services/layer_service.py:152-262`（`_write`/`generate_*` 返回 stats）
- Test: `backend/tests/test_layer_service.py`

**Step 1: 写失败测试（逐行校验统计）**

在 `test_layer_service.py` 末尾追加：

```python
def test_row_validation_skips_invalid_rows_and_reports_stats(service, tmp_path):
    """部分无效行 → 跳过无效行不阻断，返回 stats 统计"""
    path = tmp_path / "mixed.xlsx"
    df = pd.DataFrame({
        "NAME": ["A", "B", "C", "D", "E"],
        "LONGITUDE": [116.3, None, 999, 116.4, 116.5],   # B缺坐标 C超范围
        "LATITUDE": [39.9, 39.8, 39.7, 40.0, 40.1],
        "AZIMUTH": [0.0, 120.0, 240.0, 360.0, 500.0],    # E方位角无效
        "PCI": [1, 2, 3, 4, None],
    })
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, stats = service.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME", "PCI"], output_format="tab",
    )
    assert stats["total"] == 5
    assert stats["success"] == 3        # A, C, D 通过（C 坐标在范围外? 实际 C 被 invalid_coord）
    assert stats["failed"] == 2
    assert stats["failures"]["missing_coord"] == 1   # B
    assert stats["failures"]["invalid_coord"] == 1   # C
    import geopandas as gpd
    gdf = gpd.read_file(out)
    assert len(gdf) == 3
```

> 说明：C (999, 39.7) 经度 999 超 [-180,180] → `invalid_coord`；E (116.5,40.1,500) 方位角 500 超 [0,360]。E 是扇区才有方位角校验，此测试是 **point**，故 E 通过。此测试重点验证 point 的坐标校验：B(missing_coord) + C(invalid_coord) 失败，A/D/E 成功 = 3。若想覆盖 azimuth，见下个测试。

```python
def test_sector_azimuth_validation_stats(service, tmp_path):
    """扇区方位角无效行被跳过并计入 invalid_azimuth"""
    path = tmp_path / "azi.xlsx"
    df = pd.DataFrame({
        "NAME": ["A", "B"],
        "LONGITUDE": [116.3, 116.4],
        "LATITUDE": [39.9, 40.0],
        "AZIMUTH": [120.0, 500.0],     # B 方位角无效
    })
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, stats = service.generate_sector_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=50, beamwidth=50,
        attributes=["NAME"], output_format="tab",
    )
    assert stats["total"] == 2
    assert stats["success"] == 1
    assert stats["failed"] == 1
    assert stats["failures"]["invalid_azimuth"] == 1
```

**Step 2: 运行测试验证失败**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_service.py -q 2>&1 | tail -8`
Expected: FAIL — 现有 `generate_point_layer` 返回单个 Path，`out, stats = ...` 解包报错 / 无 stats 属性

**Step 3: 实现逐行校验 + stats 返回**

在 `layer_service.py` 改造：

```python
def _coerce_coords(self, df: pd.DataFrame, lon_col: str, lat_col: str):
    """逐行校验经纬度，返回 (lon, lat, valid_mask, failures)
    failures: dict 分类计数（missing_coord / invalid_coord）
    不再整列报错，改为跳过无效行。
    """
    raw_lon = df[lon_col].astype(object) if lon_col in df.columns else pd.Series([None] * len(df))
    raw_lat = df[lat_col].astype(object) if lat_col in df.columns else pd.Series([None] * len(df))
    failures = {"missing_coord": 0, "invalid_coord": 0}
    lon = pd.to_numeric(df[lon_col], errors="coerce")
    lat = pd.to_numeric(df[lat_col], errors="coerce")
    missing = raw_lon.isna() | raw_lat.isna() | lon.isna() | lat.isna()
    failures["missing_coord"] += int(missing.sum())
    invalid = ~missing & (~lon.between(-180, 180) | ~lat.between(-90, 90))
    failures["invalid_coord"] += int(invalid.sum())
    valid = ~missing & ~invalid
    return lon, lat, valid, failures
```

在 `generate_point_layer` / `generate_sector_layer` 中：

```python
def generate_point_layer(self, ...) -> tuple:
    """返回 (Path, stats_dict)。逐行校验跳过无效行，输出统计。"""
    df = self._read_sheet(file_path, sheet_name)
    lon, lat, valid, failures = self._coerce_coords(df, lon_col, lat_col)
    # 标签名缺失
    missing_name = pd.Series(False, index=df.index)
    if name_col in df.columns:
        missing_name = df[name_col].isna() & valid
        failures["missing_name"] = int(missing_name.sum())
    else:
        failures["missing_name"] = int(valid.sum())
    valid = valid & ~missing_name
    if valid.sum() == 0:
        raise ValueError(f"全部行校验失败（成功 0/{len(df)}），请检查数据")
    geoms = [Point(x, y) for x, y in zip(lon[valid], lat[valid])]
    gdf = self._build_gdf(df, lon, lat, valid, attributes, geoms, keep_cols_extra=[name_col])
    if output_format == "kml":
        gdf = self._ensure_kml_name(gdf, name_col)
    out = self._write(gdf, output_format,
                      source_filename=source_filename or Path(file_path).name,
                      sheet_name=sheet_name)
    out = self._apply_color(out, output_format, color, is_point=True)
    stats = {
        "total": int(len(df)),
        "success": int(valid.sum()),
        "failed": int(len(df) - valid.sum()),
        "failures": {k: int(v) for k, v in failures.items()},
    }
    return out, stats
```

扇区版本增加方位角校验：

```python
def generate_sector_layer(self, ...) -> tuple:
    df = self._read_sheet(file_path, sheet_name)
    lon, lat, valid, failures = self._coerce_coords(df, lon_col, lat_col)
    # 方位角校验
    azi = pd.to_numeric(df[azimuth_col], errors="coerce") if azimuth_col in df.columns else pd.Series([float("nan")] * len(df))
    azi_bad = valid & (azi.isna() | ~azi.between(0, 360))
    failures["invalid_azimuth"] = int(azi_bad.sum())
    valid = valid & ~azi_bad
    # 全零方位角 → 抛错（保留原行为）
    nonzero = valid & (azi > 0)
    if valid.sum() > 0 and nonzero.sum() == 0:
        raise ValueError("方位角列全为 0 或空值，无法生成有效扇区，请检查方位角列选择")
    # 标签名缺失（同上 point）
    ...
    if valid.sum() == 0:
        raise ValueError(f"全部行校验失败（成功 0/{len(df)}），请检查数据")
    geoms = [sector_polygon(y, x, a, beamwidth, radius_m)
             for x, y, a in zip(lon[valid], lat[valid], azi[valid])]
    ...
    stats = {..., "failures": {...failures}}
    return out, stats
```

**注意**：`missing_attrs`（勾选属性列该行全空）暂不强制校验 —— 设计文档列了但实现复杂度高（需逐行检查所有勾选列）。**YAGNI 取舍**：首版只校验坐标/方位角/标签名三类，`missing_attrs` 分类计数始终为 0，前端不显示。测试也只断言这三类。

**Step 4: 运行测试验证通过**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_service.py -q 2>&1 | tail -8`
Expected: PASS（含新增 2 个 + 原有全部）

> 注意：原有测试 `test_invalid_coordinates_raises` 现在不成立 —— 999 坐标改为跳过而非报错。**此测试需更新**：把整列非法（`[999,999]`）改为**全部行失败**场景（所有行 missing_coord）仍抛 ValueError。

**Step 5: 更新受影响的旧测试**

```python
def test_all_rows_invalid_raises(service, tmp_path):
    """所有行坐标无效 → 仍抛 ValueError（success=0）"""
    path = tmp_path / "bad.xlsx"
    df = pd.DataFrame({"NAME": ["X"], "LONGITUDE": [999], "LATITUDE": [999]})
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="S", index=False)
    with pytest.raises(ValueError, match="校验失败"):
        service.generate_point_layer(
            file_path=str(path), sheet_name="S",
            name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
            attributes=["NAME"], output_format="tab",
        )
```

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_service.py -q 2>&1 | tail -8`
Expected: PASS

**Step 6: Commit**

```bash
git add backend/app/services/layer_service.py backend/tests/test_layer_service.py
git commit -m "feat: 图层逐行校验跳过无效行+输出统计（total/success/failed/failures）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: TAB/MIF 中文编码修复（GBK + charset 补丁 + 列名恢复）

**Files:**
- Modify: `backend/app/services/layer_service.py`（`_write`/`_apply_color` + 新增 `_write_mapinfo_gbk`）
- Test: `backend/tests/test_layer_service.py`

**背景**（已验证）：GDAL MapInfo 驱动写 UTF-8 字节但声明 `Charset "Neutral"` → MapInfo 按 Windows-1252 解析乱码。解法：写前重命名字段为 ASCII，写时 `encoding='GBK'`，写后补丁 charset + 恢复中文列名。

**Step 1: 写失败测试（中文 TAB 回读完整）**

```python
def test_tab_chinese_fields_readable(service, tmp_path):
    """中文列名+中文值 → TAB 输出回读完整（字段名与值均中文）"""
    path = tmp_path / "工参.xlsx"
    df = pd.DataFrame({"小区名称": ["基站A"], "经度": [116.4], "纬度": [39.9]})
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, _ = service.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="小区名称", lon_col="经度", lat_col="纬度",
        attributes=["小区名称"], output_format="tab",
    )
    import geopandas as gpd
    gdf = gpd.read_file(out)
    assert "小区名称" in gdf.columns
    assert gdf["小区名称"].tolist() == ["基站A"]
    # TAB 声明 charset 为 WindowsSimpChinese
    tab = out.read_text(encoding="gbk", errors="replace")
    assert "WindowsSimpChinese" in tab


def test_mif_chinese_fields_readable(service, tmp_path):
    """中文列名+值 → MIF 输出回读完整"""
    path = tmp_path / "工参.xlsx"
    df = pd.DataFrame({"小区名称": ["基站A"], "经度": [116.4], "纬度": [39.9]})
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, _ = service.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="小区名称", lon_col="经度", lat_col="纬度",
        attributes=["小区名称"], output_format="mif",
    )
    import geopandas as gpd
    gdf = gpd.read_file(out)
    assert "小区名称" in gdf.columns
    assert gdf["小区名称"].tolist() == ["基站A"]
    mif = out.read_text(encoding="gbk", errors="replace")
    assert "WindowsSimpChinese" in mif
```

**Step 2: 运行验证失败**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_service.py -q 2>&1 | tail -8`
Expected: FAIL — TAB 声明 Neutral，GDAL 回读乱码列名

**Step 3: 实现 GBK 写入 + 后处理**

在 `layer_service.py` 新增：

```python
def _mapinfo_postprocess(self, out_path: Path, output_format: str,
                         original_columns: list) -> Path:
    """MapInfo TAB/MIF 后处理：修正 charset + 恢复中文字段名。
    写入时用 f0/f1... ASCII 占位名 + encoding='GBK'，此处按顺序恢复原名。
    """
    enc = "gbk"
    if output_format == "tab":
        tab_path = out_path
        text = tab_path.read_text(encoding=enc, errors="replace")
        text = text.replace("!charset Neutral", "!charset WindowsSimpChinese")
        text = text.replace('Charset "Neutral"', 'Charset "WindowsSimpChinese"')
        # 恢复字段名：匹配 '  f\d+ Type;' 行，按顺序映射回 original_columns
        idx = {"n": 0}
        def _restore(m):
            i = idx["n"]; idx["n"] += 1
            if i < len(original_columns):
                return f"  {original_columns[i]} {m.group(1)}"
            return m.group(0)
        text = re.sub(r"  f\d+ (Char \(\d+\) ;|Float ;|Integer ;|Smallint ;)", _restore, text)
        tab_path.write_text(text, encoding=enc)
    elif output_format == "mif":
        mif_path = out_path
        text = mif_path.read_text(encoding=enc, errors="replace")
        text = text.replace('Charset "Neutral"', 'Charset "WindowsSimpChinese"')
        # 恢复 Columns 块字段名
        lines = text.splitlines()
        out_lines, in_cols, ci = [], False, 0
        for ln in lines:
            m = re.match(r"^  f\d+( Char\(\d+\)| Float| Integer| Smallint| Character)", ln)
            if m and in_cols and ci < len(original_columns):
                ln = f"  {original_columns[ci]}{m.group(1)}"; ci += 1
            if ln.startswith("Columns"): in_cols = True
            elif in_cols and ln.strip() == "Data": in_cols = False
            out_lines.append(ln)
        mif_path.write_text("\n".join(out_lines), encoding=enc)
    return out_path
```

改造 `_write`：写入前重命名中文列 → ASCII，写 `encoding='GBK'`，写后调 `_mapinfo_postprocess`：

```python
def _write(self, gdf: gpd.GeoDataFrame, output_format: str,
           source_filename: str, sheet_name: str) -> Path:
    if output_format not in DRIVER_MAP:
        raise ValueError(f"不支持的输出格式: {output_format}")
    base = _truncate_bytes(Path(source_filename).stem, 100)
    safe_sheet = _truncate_bytes(re.sub(r'[<>:"/\\|?*]', "_", sheet_name), 50)
    fname = f"{base}_{safe_sheet}{EXT_MAP[output_format]}"   # 去 uuid
    out_path = self.output_dir / fname
    if output_format in ("tab", "mif"):
        # 重命名中文列为 ASCII 占位 → GBK 写入 → 后处理恢复
        orig_cols = list(gdf.columns)
        rename = {c: f"f{i}" for i, c in enumerate(orig_cols)}
        gdf_ascii = gdf.rename(columns=rename)
        gdf_ascii.to_file(out_path, driver=DRIVER_MAP[output_format], encoding="GBK")
        self._mapinfo_postprocess(out_path, output_format, orig_cols)
    else:
        gdf.to_file(out_path, driver=DRIVER_MAP[output_format])
    return out_path
```

**冲突加序号**（问题 6）：

```python
def _unique_path(self, path: Path) -> Path:
    if not path.exists():
        return path
    stem, ext = path.stem, path.suffix
    i = 1
    while (self.output_dir / f"{stem}-{i}{ext}").exists():
        i += 1
    return self.output_dir / f"{stem}-{i}{ext}"
```

在 `_write` 中 `out_path = self._unique_path(out_path)`。

**Step 4: 运行验证通过**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_service.py -q 2>&1 | tail -8`
Expected: PASS

> **注意**：`_apply_color` 对 MIF 读取需改用 `encoding="gbk"` 而非 utf-8。原 `test_mif_point_color_injected` 用 `read_text(encoding="utf-8", errors="replace")` 断言 `Symbol (35,4886745,` —— MIF 现在 GBK 编码，utf-8 读取 ASCII 部分仍正确（Symbol/Brush 是 ASCII），此断言仍通过。但保险起见检查颜色注入是否在 `_mapinfo_postprocess` 之后运行（顺序：`_write`→`_apply_color`，颜色补丁在 GBK 后处理之后，需用 gbk 读写）。

**Step 5: 更新命名测试**

原有 `test_output_filename_uses_source_and_sheet` 断言 `out.stem.startswith("工参2026_LTE_")` —— 现在去 uuid 变成 `工参2026_LTE`。更新断言：

```python
def test_output_filename_uses_source_and_sheet(tmp_path):
    """导出文件名 = 源文件名 + sheet 名（无 uuid）"""
    ...
    assert out.stem == "工参2026_LTE"
    assert out.suffix == ".tab"
```

新增冲突测试：

```python
def test_output_filename_conflict_appends_suffix(tmp_path):
    """同名文件已存在 → 追加 -1/-2 序号"""
    path = tmp_path / "源.xlsx"
    df = pd.DataFrame({"NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9]})
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    svc = LayerService(output_dir=tmp_path)
    (tmp_path / "源_LTE.tab").write_text("x")   # 预置冲突
    out1 = svc.generate_point_layer(str(path), "LTE", "NAME", "LONGITUDE", "LATITUDE", ["NAME"], "tab")
    out2 = svc.generate_point_layer(str(path), "LTE", "NAME", "LONGITUDE", "LATITUDE", ["NAME"], "tab")
    assert out1.name == "源_LTE-1.tab"
    assert out2.name == "源_LTE-2.tab"
```

**Step 6: Commit**

```bash
git add backend/app/services/layer_service.py backend/tests/test_layer_service.py
git commit -m "feat: TAB/MIF中文编码修复（GBK写入+charset补丁+列名恢复）+ 命名去uuid冲突加序号
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 后端多格式打包 + stats 返回（layer.py 端点）

**Files:**
- Modify: `backend/app/api/v1/endpoints/layer.py`
- Test: `backend/tests/test_layer_api.py`

**Step 1: 写失败测试**

```python
def test_point_endpoint_multi_format_zip():
    """output_formats=tab,mif → 一次生成两格式打包 zip，返回 stats"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE", "name_col": "NAME",
                    "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                    "attributes": '["NAME"]', "output_formats": "tab,mif",
                },
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["data"]["filename"].endswith(".zip")
        assert "stats" in body["data"]
        assert body["data"]["stats"]["total"] == 2
        assert body["data"]["stats"]["success"] == 2
        dl = client.get(body["data"]["download_url"])
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            names = zf.namelist()
        assert any(n.endswith(".tab") for n in names)
        assert any(n.endswith(".mif") for n in names)
    finally:
        os.remove(path)


def test_point_endpoint_stats_with_failures():
    """含无效行 → 端点返回 stats.failed>0，文件仍生成"""
    path = tempfile.mktemp(suffix=".xlsx")
    pd.DataFrame({
        "NAME": ["A", "B"], "LONGITUDE": [116.3, None], "LATITUDE": [39.9, 40.0],
    }).to_excel(path, sheet_name="S", index=False)
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("s.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={"sheet_name": "S", "name_col": "NAME",
                      "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                      "attributes": '["NAME"]', "output_formats": "kml"},
            )
        assert resp.status_code == 200
        stats = resp.json()["data"]["stats"]
        assert stats["total"] == 2
        assert stats["success"] == 1
        assert stats["failed"] == 1
        assert stats["failures"]["missing_coord"] == 1
    finally:
        os.remove(path)
```

**Step 2: 运行验证失败**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_api.py -q 2>&1 | tail -8`
Expected: FAIL — `output_formats` 参数不存在（当前是 `output_format`），端点返回无 stats

**Step 3: 实现多格式打包**

在 `layer.py` 改造：

```python
@router.post("/point")
async def generate_point(
    file: Optional[UploadFile] = None,
    file_path: Optional[str] = Form(None),
    sheet_name: str = Form(...),
    name_col: str = Form(...),
    lon_col: str = Form(...),
    lat_col: str = Form(...),
    attributes: str = Form("[]"),
    output_formats: str = Form("tab"),     # 逗号分隔多选，默认 tab
    color: Optional[str] = Form(None),
    source_filename: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
):
    """生成点图层（支持多格式打包），返回下载 URL + stats"""
    src = None
    try:
        src, original_name = _save_upload(file, file_path, source_filename)
        attr_list = json.loads(attributes) if attributes else []
        fmt_list = [f.strip() for f in output_formats.split(",") if f.strip()] or ["tab"]
        outs, stats = [], None
        for fmt in fmt_list:
            out, stats = await run_in_threadpool(
                layer_service.generate_point_layer,
                str(src), sheet_name, name_col, lon_col, lat_col,
                attr_list, fmt, color or None, original_name,
            )
            outs.append(out)
        return {"success": True, "data": {**_finalize_outputs(outs, fmt_list), "stats": stats}}
    ...
    finally:
        if src is not None:
            src.unlink(missing_ok=True)
```

新增 `_finalize_outputs`（支持单/多格式）：

```python
def _finalize_outputs(outs: list, formats: list) -> dict:
    """单格式：TAB/MIF 打包 zip，KML 单文件；多格式：统一打包 zip"""
    if len(outs) == 1:
        return _finalize_output(outs[0], formats[0])
    # 多格式 → 统一打包 zip
    base = outs[0].stem          # 各格式同源同名
    zip_path = outs[0].parent / f"{base}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for out in outs:
            if out.is_dir():
                for f in out.glob(f"{out.name}.*"):
                    zf.write(f, arcname=f.name)
            else:
                zf.write(out, arcname=out.name)
    return {"filename": zip_path.name, "download_url": f"/layer-files/{zip_path.name}"}
```

`/sector` 端点同样改 `output_formats`（含 azimuth 参数）。

**注意兼容**：`output_format`（旧）保留兼容 —— 若传 `output_format` 则等价 `output_formats=单值`。为避免破坏现有测试 `test_point_endpoint_returns_download_url` 等仍传 `output_format`，端点需同时接受两者（`output_formats: str = Form(None)`，若 None 则用 `output_format`）。

**Step 4: 运行验证通过**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_api.py -q 2>&1 | tail -8`
Expected: PASS（含新增 2 + 原有全部）

**Step 5: Commit**

```bash
git add backend/app/api/v1/endpoints/layer.py backend/tests/test_layer_api.py
git commit -m "feat: 图层端点支持多格式一次生成打包zip+返回stats（兼容旧output_format）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 上传效率（512KB 分块 + 块级超时 + 即时进度）

**Files:**
- Modify: `frontend/src/renderer/services/api.ts:325-459`（calcChunkSize/chunkedUpload）

**Step 1: 修改 calcChunkSize**

```typescript
function calcChunkSize(fileSize: number): number {
  if (fileSize < 3 * 1024 * 1024) {
    return 512 * 1024               // < 3MB → 512KB（小文件仍分块，避免单请求超时）
  }
  return 512 * 1024                  // 所有 ≥3MB → 512KB（Cloudflare Tunnel 下最稳）
}
```

> 原逻辑 3-50MB 用 1MB、>50MB 用 512KB。现在统一 512KB：ARM 软加密 Tunnel 吞吐 ~1-2MB/s，512KB 块 ~0.3-0.5s 完成，远低于任何超时窗口。3MB 以下也用 512KB（最多 6 块，开销可忽略）避免小块数量差异。

**Step 2: 块级超时（chunk 请求独立 60s 超时）**

在 `chunkedUpload` 中给 chunk 请求加超时，不用全局 300s：

```typescript
await uploadClient.post(`${basePath}/${dataId}/chunk`, chunkForm, {
  timeout: 60000,          // 单块 60s，超时即触发重试
})
```

> `uploadClient` 全局 timeout 300000，此处每块显式覆盖为 60s。若 512KB 块在 60s 内传不完（极端弱网），重试 3 次 + 退避 2/4/8s。总重试窗口 ~90s，可接受。

**Step 3: 即时进度（start 前显示 1%，首块完成即跳转）**

在 `chunkedUpload` 开头加：

```typescript
async function chunkedUpload(file, basePath, fileType?, onProgress?) {
  onProgress?.(1)                     // 立即显示 1%，start 网络往返前就有反馈
  const chunkSize = calcChunkSize(file.size)
  ...
  // start 阶段
  onProgress?.(2)                     // start 请求发起中
  const startResp = await uploadClient.post(...)
  ...
  // 每块完成
  onProgress?.(Math.round(((i + 1) / totalChunks) * 99))
```

**Step 4: 验证（type-check）**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -E "api.ts" || echo "NO_TYPE_ERRORS_IN_TOUCHED_FILES"`
Expected: NO_TYPE_ERRORS_IN_TOUCHED_FILES

**Step 5: Commit**

```bash
git add frontend/src/renderer/services/api.ts
git commit -m "fix: 分块上传统一512KB+单块60s超时+start即时进度反馈
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 前端页面合并 + Tab 布局（LayerToolsPage）

**Files:**
- Create: `frontend/src/renderer/pages/LayerToolsPage.tsx`
- Modify: `frontend/src/renderer/pages/LayerSectorPage.tsx`（删除）
- Modify: `frontend/src/renderer/pages/LayerPointPage.tsx`（删除）
- Modify: `frontend/src/renderer/App.tsx:96-109`（路由）
- Modify: `frontend/src/renderer/components/Layout/MainLayout.tsx:63-69`（菜单）
- Modify: `frontend/src/renderer/pages/HomePage.tsx`（卡片）

**Step 1: 创建 LayerToolsPage.tsx**

骨架（合并两页，Radix Tabs 切换）：

```tsx
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import * as Tabs from '@radix-ui/react-tabs'
import { FileUp, Loader2, Download, CheckCircle2 } from 'lucide-react'
import { layerToolsApi, type LayerExcelInfo, type GenerateLayerResult } from '../services/api'
import { LayerAttributeConfig } from '../components/layer/LayerAttributeConfig'
import { LAYER_DEFAULT_PARAMS } from '../config/layer-config'

// 每 Tab 完整状态（持久化到 sessionStorage）
interface TabState {
  filePath: string; sourceFilename: string; fileName: string
  sheetName: string
  info: LayerExcelInfo | null
  selectedFields: Record<string, string>
  fieldMappings: Record<string, string>
  params: { radiusM: string; beamwidth: string; pointSize: string; color: string; formats: string[] }
  result: GenerateLayerResult | null
  error: string
}

function emptyState(): TabState { ... }

const STORAGE_KEY = { sector: 'layerTools.sector', point: 'layerTools.point' }

export default function LayerToolsPage() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'sector' | 'point'>('sector')
  const [sectorState, setSectorState] = useState<TabState>(() => loadState('sector'))
  const [pointState, setPointState] = useState<TabState>(() => loadState('point'))
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<{ percent: number; step: string } | null>(null)

  // 持久化
  useEffect(() => saveState('sector', sectorState), [sectorState])
  useEffect(() => saveState('point', pointState), [pointState])

  // 上传/生成 handler（按 activeTab 操作对应 state）
  ...
}
```

**关键点**：
- 两 Tab state 独立，`setState(activeTab === 'sector' ? ... : ...)` 更新对应对象
- 共用导入区 + 进度条 + Sheet + 属性配置（`LayerAttributeConfig`，sector 传 `includeAzimuth`）
- 参数区按 Tab 不同：sector 显示 半径/波瓣，point 显示 点大小；都显示 颜色 + 格式勾选
- 格式勾选 checkbox（tab/mif/kml），`formats` 数组，至少选 1

**Step 2: 更新 App.tsx 路由**

```tsx
import LayerToolsPage from './pages/LayerToolsPage'
...
<Route path="/layer" element={<ProtectedRoute><LayerToolsPage /></ProtectedRoute>} />
// 删除 /layer/sector 与 /layer/point 两个 Route
```

**Step 3: 更新 MainLayout 菜单**

```tsx
{ type: 'link', name: t('nav.layerTools'), href: '/layer', icon: Wrench },
```
（删除 `nav.layerSector`/`nav.layerPoint` 两项，用 `nav.layerTools`）

**Step 4: 更新 HomePage 卡片**

两张卡片（`/layer/sector`、`/layer/point`）→ 一张：

```tsx
<FeatureCard
  title={t('nav.layerTools')}
  description={t('home.layerToolsDesc')}
  icon={Wrench}
  link="/layer"
  color="from-purple-500 to-indigo-500"
/>
```

**Step 5: 删除旧页面**

`git rm frontend/src/renderer/pages/LayerSectorPage.tsx frontend/src/renderer/pages/LayerPointPage.tsx`

**Step 6: 验证**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -E "api.ts|LayerToolsPage" || echo "NO_TYPE_ERRORS_IN_TOUCHED_FILES"`
Expected: NO_TYPE_ERRORS_IN_TOUCHED_FILES

**Step 7: Commit**

```bash
git add -A frontend/src/renderer
git commit -m "feat: 图层制作两页合并为LayerToolsPage（Radix Tabs切换+独立状态）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 持久化（sessionStorage）+ 输入框修复 + 默认 50/50

**Files:**
- Modify: `frontend/src/renderer/pages/LayerToolsPage.tsx`（持久化逻辑 + 输入框）
- Modify: `frontend/src/renderer/config/layer-config.ts`（默认值）
- Modify: `frontend/src/renderer/locales/zh.json` / `en.json`

**Step 1: sessionStorage 读写**

```typescript
function loadState(key: string): TabState {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? { ...emptyState(), ...JSON.parse(raw) } : emptyState()
  } catch { return emptyState() }
}
function saveState(key: string, s: TabState) {
  try { sessionStorage.setItem(key, JSON.stringify(s)) } catch { /* ignore */ }
}
```

**Step 2: 默认参数 50/50**

`layer-config.ts`:

```typescript
export const LAYER_DEFAULT_PARAMS = {
  sector: { radiusM: 50, beamwidth: 50, color: '#4A90D9' },
  point: { pointSize: 8, color: '#FF0000' },
}
```

**Step 3: 输入框改字符串受控**

```tsx
<input type="text" inputMode="numeric" value={params.radiusM}
  onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value))
    setParam('radiusM', e.target.value) }} />
```

提交时 `parseFloat(params.radiusM) || LAYER_DEFAULT_PARAMS.sector.radiusM`。

**Step 4: i18n keys**

`zh.json`:
```json
"nav": { "layerTools": "图层制作" },
"home": { "layerToolsDesc": "根据工参制作扇区/点图层 (tab/mif/kml)" },
"layer": {
  "formats": "输出格式",
  "selectAll": "全选",
  "statsTotal": "总量",
  "statsSuccess": "成功",
  "statsFailed": "失败",
  "statsFailures": "失败原因",
  "fileExpired": "文件已过期，请重新导入"
}
```
`en.json` 同步。

**Step 5: 过期提示**

生成时 catch 到 400 "文件不存在" → 显示 `t('layer.fileExpired')` + 清空该 Tab state。

**Step 6: 验证**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -E "api.ts|LayerToolsPage" || echo "NO_TYPE_ERRORS_IN_TOUCHED_FILES"`
Expected: NO_TYPE_ERRORS_IN_TOUCHED_FILES

**Step 7: Commit**

```bash
git add frontend/src/renderer/pages/LayerToolsPage.tsx frontend/src/renderer/config/layer-config.ts frontend/src/renderer/locales/
git commit -m "feat: 图层制作持久化(sessionStorage)+输入框修复+默认50/50
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 前端多格式勾选 + 统计展示 + 进度优化

**Files:**
- Modify: `frontend/src/renderer/pages/LayerToolsPage.tsx`
- Modify: `frontend/src/renderer/services/api.ts`（layerToolsApi 传 output_formats）

**Step 1: layerToolsApi 支持多格式**

`api.ts` `generateSector`/`generatePoint` 改：

```typescript
formData.append('output_formats', (params.outputFormats || ['tab']).join(','))
// 兼容：若只选 1 个仍传 output_formats（去掉原 output_format 单值）
```

类型 `GenerateLayerParams` 增加 `outputFormats?: string[]`。

**Step 2: 格式勾选 UI**

```tsx
<div className="flex gap-3">
  {(['tab','mif','kml'] as const).map(f => (
    <label key={f} className="flex items-center gap-1 text-xs">
      <input type="checkbox" checked={params.formats.includes(f)}
        onChange={e => toggleFormat(f, e.target.checked)} />
      {f.toUpperCase()}
    </label>
  ))}
</div>
```

`toggleFormat` 保证至少选 1（取消最后一个时拒绝或自动勾选 tab）。

**Step 3: 统计展示**

生成完成后在结果区：

```tsx
{result?.stats && (
  <div className="mt-3 text-xs space-y-1">
    <p className="text-green-600">
      {t('layer.statsTotal')} {result.stats.total} | {t('layer.statsSuccess')} {result.stats.success}
      {result.stats.failed > 0 && ` | ${t('layer.statsFailed')} ${result.stats.failed}`}
    </p>
    {result.stats.failed > 0 && (
      <p className="text-amber-600">{t('layer.statsFailures')}: {formatFailures(result.stats.failures, t)}</p>
    )}
  </div>
)}
```

**Step 4: 进度优化**

上传时 progress 从 1% 起步（Task 4 已做），`LayerToolsPage` 的 `progressText` 增加 `step==='preparing'` 状态。

**Step 5: 验证**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -E "api.ts|LayerToolsPage" || echo "NO_TYPE_ERRORS_IN_TOUCHED_FILES"`
Expected: NO_TYPE_ERRORS_IN_TOUCHED_FILES

**Step 6: Commit**

```bash
git add frontend/src/renderer/pages/LayerToolsPage.tsx frontend/src/renderer/services/api.ts frontend/src/renderer/locales/
git commit -m "feat: 图层制作多格式勾选+生成统计展示
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: 回归验证 + 收尾

**Step 1: 后端全量测试**

Run: `cd backend && .venv/bin/python -m pytest tests/test_layer_service.py tests/test_layer_api.py -q 2>&1 | tail -10`
Expected: 全部 PASS

**Step 2: 前端全量类型检查**

Run: `cd frontend && npx tsc --noEmit 2>&1 | tail -5`
Expected: 无新增类型错误

**Step 3: 检查无遗留引用**

Run: `grep -rn "LayerSectorPage\|LayerPointPage\|/layer/sector\|/layer/point" frontend/src/`
Expected: 无引用（旧路由/页面已删）

Run: `grep -rn "output_format" backend/app/ frontend/src/renderer/services/api.ts | grep -v "output_formats" | head`
Expected: 旧 `output_format` 仅在测试/兼容分支出现

**Step 4: 前端构建验证**

Run: `cd frontend && npm run build:vite 2>&1 | tail -5`
Expected: build 成功

**Step 5: Commit（如有收尾改动）**

```bash
git add -A
git commit -m "chore: 图层制作优化回归验证
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 执行顺序与依赖

```
Task 1 (后端校验统计) ──→ Task 2 (后端编码/命名) ──→ Task 3 (端点多格式) ──→ Task 4 (上传效率)
                                                                              ↓
Task 5 (前端合并) ──→ Task 6 (持久化/输入框) ──→ Task 7 (多格式UI/统计) ──→ Task 8 (回归)
```

Task 1-3 是后端依赖，Task 4-7 是前端，Task 8 收尾。可前后端并行（Task 4 独立于 1-3，可提前）。

## 风险与注意

- **`_apply_color` 编码**：MIF 颜色注入需改 `encoding="gbk"` 读取（原来 utf-8）。写入顺序 `_write`(GBK) → `_apply_color`(GBK 读写)。
- **旧测试破坏**：`test_invalid_coordinates_raises`（999 坐标改跳过）、`test_output_filename_uses_source_and_sheet`（去 uuid）需更新。
- **`output_format` 兼容**：旧前端/测试传单值 `output_format`，端点需兼容。
- **KML 不变**：KML 天然 UTF-8，不经过 `_mapinfo_postprocess`，中文正常。
- **`_finalize_outputs` 多格式 zip**：TAB 目录结构（4 文件）需用 `out.glob` 收集，MIF 单文件直接写。
