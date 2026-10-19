# 图层制作问题修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复图层制作 5 项问题：TAB 样式提示、透明度逻辑反转、点图颜色标签、拖拽导入、多格式导出旧文件缓存。

**Architecture:** 后端 FastAPI + pyogrio/geopandas（GDAL mitab 驱动不支持写 TAB 样式 → 接受 TAB 无样式）；前端 React 18 + TypeScript。后端改透明度语义 + zip 文件名加格式组合；前端改透明度 0-100 语义 + 点图标签 + 拖拽 + 下载 cache-bust。

**Tech Stack:** Python 3.12 / FastAPI / pyogrio 0.13 / geopandas；React 18 / TypeScript / Tailwind / Radix UI / i18next。

**设计文档:** `docs/plans/2026-08-03-layer-tools-fixes-design.md`（已提交 0904d48）

---

### Task 1: 后端透明度逻辑反转（`_kml_color_with_alpha`）

**Files:**
- Modify: `backend/app/services/layer_service.py:141-153`
- Test: `backend/tests/test_layer_service.py`

**背景**: `opacity` 参数当前语义是"不透明度"（`alpha = opacity*255`，0.6→60% 不透明）。需改为"透明度"：`alpha = (1 - transparency)*255`。前端提交 `(100 - v)/100`，则 v=0 时 transparency=1 → alpha=0（全透明）？**不对**——需要仔细推演。

**推演**:
- 设计文档定：前端 0-100，0=完全不透明，100=全透明。
- 后端要 `alpha`：0=全透明，255=不透明。
- 前端传 `transparency = v/100`（v=100→1=全透明，v=0→0=不透明）。
- 后端 `alpha = round((1 - transparency) * 255)`：transparency=0→255（不透明），transparency=1→0（全透明）。✅
- 所以前端提交 `v/100`，后端参数语义为"透明度"。

**Step 1: 更新既有测试并新增反转断言**

修改 `tests/test_layer_service.py::test_kml_sector_opacity_applied` 与 `test_kml_point_opacity_applied`：

```python
def test_kml_sector_opacity_applied(service, sample_excel):
    """扇区 KML：透明度 opacity=0.5（全透明=1）→ PolyStyle color 首字节 alpha=80 (128)
    语义为透明度：0.5 透明度 → alpha = (1-0.5)*255 = 128"""
    ...
    assert "<LineStyle><color>800000ff</color>" in text
    assert "<PolyStyle><color>8000ff00</color>" in text
```

> 注意：原断言 `800000ff`/`8000ff00` 在 alpha=128 时**不变**（0.5 透明度 = 0.5 不透明度）。但需新增边界断言：

```python
def test_kml_sector_opacity_semantics(service, sample_excel):
    """透明度语义：0=不透明(ff)、1=全透明(00)"""
    # opacity=0 → alpha=255=ff
    result, _ = service.generate_sector_layer(..., border_color="#FF0000", fill_color="#00FF00", opacity=0.0)
    text = result.read_text(encoding="utf-8")
    assert "<LineStyle><color>ff0000ff</color>" in text   # alpha=ff
    assert "<PolyStyle><color>ff00ff00</color>" in text
    # opacity=1 → alpha=0=00
    result, _ = service.generate_sector_layer(..., border_color="#FF0000", fill_color="#00FF00", opacity=1.0)
    text = result.read_text(encoding="utf-8")
    assert "<LineStyle><color>000000ff</color>" in text   # alpha=00
    assert "<PolyStyle><color>0000ff00</color>" in text
```

**Step 2: 运行测试确认失败（红线）**

Run: `pytest tests/test_layer_service.py -k "opacity" -v`
Expected: `test_kml_sector_opacity_semantics` FAIL（当前 opacity=0→`ff...`，opacity=1→`ff...`，不会变 alpha）

**Step 3: 实现反转**

```python
def _kml_color_with_alpha(color: Optional[str], transparency: float) -> Optional[str]:
    """KML aabbggrr + 透明度 transparency(0-1，0=不透明 1=全透明)。非法颜色/透明度返回 None"""
    c = hex_to_kml_color(color)
    if c is None:
        return None
    try:
        t = float(transparency)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(t):
        return None
    t = max(0.0, min(1.0, t))
    alpha = int(round((1 - t) * 255))
    return f"{alpha:02x}{c[2:]}"
```

并把 `_apply_style` 内 `kml_opacity` 变量名改为 `kml_transparency`（3 处调用 `_kml_color_with_alpha(border_color, kml_opacity)` / `(fill_color, kml_opacity)` 同步改）。

**Step 4: 运行测试确认通过**

Run: `pytest tests/test_layer_service.py -k "opacity" -v`
Expected: PASS（新旧断言全绿，因为 0.5 语义下 alpha 值不变，边界断言验证反转）

**Step 5: Commit**

```bash
git add backend/app/services/layer_service.py backend/tests/test_layer_service.py
git commit -m "fix: 图层透明度逻辑反转（数值越大越透明，alpha=(1-t)*255）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 后端 zip 文件名加格式组合（缓存隔离）

**Files:**
- Modify: `backend/app/api/v1/endpoints/layer.py:36-70`
- Test: `backend/tests/test_layer_api.py`

**背景**: `_finalize_output`（单格式）与 `_finalize_outputs`（多格式）的 zip 名 = `outs[0].stem`，不含格式组合。同一 stem 下 tab / tab+mif / tab+mif+kml 共享 URL → 浏览器缓存旧 zip。修复：文件名加格式组合后缀。

**Step 1: 新增格式后缀逻辑**

`_finalize_outputs(outs, formats)` 中 base 用 `outs[0].stem`，追加格式后缀：

```python
def _fmt_tag(formats: list) -> str:
    """格式组合后缀：['tab']→'_tab'，['tab','mif']→'_tab-mif'，['kml']→'_kml'"""
    return "-" + "-".join(sorted(formats))

def _finalize_output(out: Path, output_format: str) -> dict:
    if output_format in ("tab", "mif"):
        zip_path = _zip_layer(out)  # 此处命名需带格式标记
        ...
```

> 更简洁：把格式标记作为参数传入 `_zip_layer`/`_finalize_output`，构造 `{stem}{fmt_tag}.zip`。但 `_zip_layer` 用 `out.parent / f"{base}.zip"`，需要把 zip 路径改为 `out.parent / f"{out.stem}{fmt_tag}.zip"`。注意：**zip 文件名变化后，`_companion_files` 的精确 stem 收集不受影响**（zip 不入 zip，`f.name != zip_path.name` 保护已存在）。

**实现方案**：
```python
def _fmt_tag(formats: list) -> str:
    return "-" + "-".join(sorted(f for f in formats if f))

def _zip_layer(out_path: Path, fmt_tag: str = "") -> Path:
    base = out_path.stem
    zip_path = out_path.parent / f"{base}{fmt_tag}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in _companion_files(out_path):
            if f.name != zip_path.name:
                zf.write(f, arcname=f.name)
    return zip_path

def _finalize_output(out: Path, output_format: str, fmt_tag: str = "") -> dict:
    if output_format in ("tab", "mif"):
        zip_path = _zip_layer(out, fmt_tag)
        return {"filename": zip_path.name, "download_url": f"/layer-files/{zip_path.name}"}
    return {"filename": out.name, "download_url": f"/layer-files/{out.name}"}

def _finalize_outputs(outs: list, formats: list) -> dict:
    fmt_tag = _fmt_tag(formats)
    if len(outs) == 1:
        return _finalize_output(outs[0], formats[0], fmt_tag)
    base = outs[0].stem
    zip_path = outs[0].parent / f"{base}{fmt_tag}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for out in outs:
            for f in _companion_files(out):
                if f.name != zip_path.name:
                    zf.write(f, arcname=f.name)
    return {"filename": zip_path.name, "download_url": f"/layer-files/{zip_path.name}"}
```

**Step 2: 更新受影响的测试断言**

修改 `tests/test_layer_api.py` 中所有断言 zip 文件名的地方：
- `test_point_endpoint_returns_download_url`：`sample_LTE_point_tab.zip`
- `test_sector_endpoint`：`sample_LTE_sector_mif.zip`
- `test_layer_point_endpoint_uses_source_filename_in_download_name`：`工参2026_LTE_point_tab.zip`
- `test_repeat_generate_via_endpoint_keeps_latest_only`：`工参_LTE_point_tab.zip`（两次相同）
- `test_point_endpoint_multi_format_zip`：zip 名含 `_tab-mif`

新增格式组合隔离测试：

```python
def test_multi_format_zip_name_includes_formats():
    """多格式 zip 文件名含格式组合（tab+mif+kml）→ URL 不同，避免浏览器缓存旧文件"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post("/api/v1/layer/point", ... output_formats="tab,mif,kml")
        fname = resp.json()["data"]["filename"]
        assert "_tab-mif-kml" in fname
        assert fname.endswith(".zip")
    finally:
        os.remove(path)
```

**Step 3: 运行测试确认**

Run: `pytest tests/test_layer_api.py -v`
Expected: 全绿

**Step 4: Commit**

```bash
git add backend/app/api/v1/endpoints/layer.py backend/tests/test_layer_api.py
git commit -m "fix: 图层制作 zip 文件名加格式组合，隔离浏览器缓存

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 前端透明度 0-100 语义 + 点图颜色标签 + 拖拽导入 + 下载 cache-bust

**Files:**
- Modify: `frontend/src/renderer/pages/LayerToolsPage.tsx`
- Modify: `frontend/src/renderer/config/layer-config.ts`
- Modify: `frontend/src/renderer/locales/zh.json`
- Modify: `frontend/src/renderer/locales/en.json`

**背景**: 4 项前端改动：
1. 透明度输入 0-1 → 0-100（0=不透明 100=全透明），提交 `(100-v)/100`，默认 0。
2. 点图"边框颜色"标签 → "填充颜色"（`layer.fillColor`）。
3. 拖拽文件到导入框。
4. 下载链接 cache-bust `?_t=Date.now()`。

**Step 1: 写前端类型/逻辑（TDD 由后端测试覆盖，前端用 tsc + build 验证）**

`LayerToolsPage.tsx` 改动：

```tsx
// 1. 透明度语义
// emptyTabState: opacity: '0'（默认完全不透明，等价旧 0.6 语义的"更实心"，见设计文档迁移）
// handleGenerate: opacity: parseFloat(state.opacity) / 100  // 0-100 → 0-1 透明度
//   const v = Number.isFinite(parseFloat(state.opacity)) ? parseFloat(state.opacity) : 0
//   opacity: v / 100
// 渲染:
// <input {...numberInput(ts.opacity, ...)} placeholder="0" ... />
// 标签仍用 t('layer.opacity')，但提示语更新
// 迁移（loadState）: 旧 opacity 0-1 → 新 opacity 0-100
//   if (saved.opacity && Number(saved.opacity) <= 1 && saved.opacity !== '') {
//     saved.opacity = String(Math.round((1 - Number(saved.opacity)) * 100))
//   }

// 2. 点图颜色标签
// renderParams 中点图分支的边框颜色：
//   <label>{isSector ? t('layer.borderColor') : t('layer.fillColor')}</label>
//   且 state 字段 pointState 用 fillColor 存颜色（borderColor 保留扇区用）
//   onChange: setTab(s => ({ ...s, fillColor: e.target.value }))
//   handleGenerate: 点图时 borderColor: state.fillColor（后端点图参数名仍 border_color）

// 3. 拖拽
// 新增 state: const [dragActive, setDragActive] = useState(false)
// processFile 抽取：
//   const processFile = async (f: File) => { ...原 handleFile 主体... }
//   const handleFile = (e) => { const f = e.target.files?.[0]; if (f) processFile(f) }
// 导入 label 加事件：
//   <label onDragOver={(e)=>{e.preventDefault(); setDragActive(true)}}
//          onDragLeave={()=>setDragActive(false)}
//          onDrop={(e)=>{e.preventDefault(); setDragActive(false); const f=e.dataTransfer.files?.[0]; if(f) processFile(f)}}
//          className={`... ${dragActive ? 'border-primary bg-primary/5' : 'border-border'}`}>
// 提示语: {sharedFile.fileName || (dragActive ? t('layer.dropHere') : t('layer.uploadExcel'))}

// 4. 下载 cache-bust
// renderResult: <a href={ts.result.download_url + '?_t=' + Date.now()} download ...>
```

`layer-config.ts`：`LAYER_DEFAULT_PARAMS` 的 `opacity` 从 `0.6` 改 `0`（点/扇区）。

`locales/zh.json` + `en.json`：
- `opacity` 文案："透明度（0不透明-100全透明）"
- 新增 `dropHere`: "松开导入文件"
- `colorTabHint` 更新："TAB 格式不支持样式（颜色/线宽/透明度/点大小/点形状），仅 MIF/KML 生效"

**Step 2: 类型检查 + 构建**

Run: `cd frontend && npx tsc --noEmit`
Expected: 无错误

Run: `cd frontend && npm run build:vite`
Expected: 成功

**Step 3: Commit**

```bash
git add frontend/src/renderer/pages/LayerToolsPage.tsx frontend/src/renderer/config/layer-config.ts frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json
git commit -m "fix: 图层制作前端-透明度0-100语义/点图标签/拖拽导入/下载cache-bust

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 全量回归验证 + 手工验证清单

**Files:**
- 无新增改动，验证为主

**Step 1: 后端全量测试**

Run: `cd backend && source .venv/bin/activate && .venv/bin/python -m pytest -q`
Expected: 全部通过（原先 122+，现含新增断言）

**Step 2: 前端构建**

Run: `cd frontend && npm run build:vite`
Expected: 成功

**Step 3: 手工验证（无法自动化，需真实浏览器）**

1. **透明度**：扇区 KML 透明度滑块 0/50/100 → 导出检查 `<color>` alpha 首字节（ff/80/00）。0=实心，100=全透明。
2. **点图标签**：点图 Tab 颜色项显示"填充颜色"。
3. **拖拽**：拖 Excel 到导入框 → 高亮 → 松开 → 正常解析。
4. **多格式缓存**：勾选 tab → 导出 `_tab.zip`；勾选 tab+mif → 导出 `_tab-mif.zip`；勾选 tab+mif+kml → 导出 `_tab-mif-kml.zip`。URL 不同，浏览器每次强制拉新，文件时间戳为当前时间。
5. **TAB 提示**：仅勾选 TAB 时显示"TAB 格式不支持样式"提示。

**Step 4: 无遗留 TODO / test.skip**

Run: `grep -rn "test.skip\|TODO\|FIXME" frontend/src/renderer/pages/LayerToolsPage.tsx backend/app/services/layer_service.py backend/app/api/v1/endpoints/layer.py`
Expected: 无新增遗留

---

## 验证清单（总）

- [ ] 后端 `pytest tests/test_layer_service.py tests/test_layer_api.py` 全绿
- [ ] 后端全量 `pytest -q` 全绿
- [ ] 前端 `npx tsc --noEmit` 无错误
- [ ] 前端 `npm run build:vite` 成功
- [ ] 手工：透明度反转 / 点图标签 / 拖拽 / 多格式缓存 / TAB 提示
