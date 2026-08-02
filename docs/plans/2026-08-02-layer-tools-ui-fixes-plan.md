# 图层制作 UI 修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复图层制作 4 项问题：切换 Tab 清空旧下载结果、常用色块+扇区线宽、点形状选择+点大小全链路修复、点 KML 补充 Icon 定义。

**Architecture:** 前端 `LayerToolsPage` 的 TabState 加 `lineWidth`/`pointShape` 字段，切换 Tab 时清空非激活 Tab 的 result；`api.ts` 透传 `point_size`/`point_shape`/`line_width`；后端 `/point`/`/sector` 端点加参数，服务层 `_apply_style` 扩展：点 KML 注入 SVG Data URI 图标、MIF Symbol 用 shape 编号、扇区线宽写入 LineStyle/Pen。

**Tech Stack:** React 18 + TypeScript + Tailwind + Radix；FastAPI + pyogrio/geopandas + pandas。

**设计文档:** `docs/plans/2026-08-02-layer-tools-ui-fixes-design.md`

---

### Task 1: 切换 Tab 清空旧下载结果

**Files:**
- Modify: `frontend/src/renderer/pages/LayerToolsPage.tsx`

**Step 1: 写 `handleTabChange` 并在 Tabs.Root 使用**

当前 `Tabs.Root` 用 `onValueChange={(v) => setActiveTab(v as 'sector' | 'point')}`（约 442 行）。改为调用新函数：

```tsx
const handleTabChange = (v: 'sector' | 'point') => {
  setActiveTab(v)
  // 清空非激活 Tab 的旧下载结果（按钮+统计），避免交叉显示
  if (v === 'point') setSectorState(s => ({ ...s, result: null }))
  else setPointState(s => ({ ...s, result: null }))
}
```

在组件顶部（`handleGenerate` 附近）定义，然后把 `Tabs.Root onValueChange` 改为 `onValueChange={(v) => handleTabChange(v as 'sector' | 'point')}`。

**Step 2: 验证**

Run: `cd frontend && npx tsc --noEmit`（确认 LayerToolsPage 无新增错误）

**Step 3: 提交**

```bash
git add frontend/src/renderer/pages/LayerToolsPage.tsx
git commit -m "fix: 切换图层Tab时清空旧下载结果，避免交叉显示"
```

---

### Task 2: 常用色块 + 扇区线宽参数

**Files:**
- Modify: `frontend/src/renderer/pages/LayerToolsPage.tsx`
- Modify: `frontend/src/renderer/config/layer-config.ts`
- Modify: `frontend/src/renderer/locales/zh.json`
- Modify: `frontend/src/renderer/locales/en.json`

**Step 1: 在 layer-config.ts 加预设色块**

```ts
// 常用色块预设
export const PRESET_COLORS = [
  '#FF0000', '#00FF00', '#0000FF', '#FFFF00',
  '#FF00FF', '#00FFFF', '#000000', '#FFFFFF',
]
```

并在 `LAYER_DEFAULT_PARAMS.sector` 加 `lineWidth: 2`。

**Step 2: TabState 加 `lineWidth` 字段**

`LayerToolsPage.tsx` 的 `TabState` 加 `lineWidth: string`；`emptyTabState` 加 `lineWidth: type === 'sector' ? String(LAYER_DEFAULT_PARAMS.sector.lineWidth) : ''`。

**Step 3: 色块组件 + 线宽输入框**

在 `renderParams` 里，边框色/填充色 input 下方各加一排色块；扇区参数区加线宽输入：

```tsx
const colorSwatches = (value: string, onChange: (v: string) => void) => (
  <div className="flex flex-wrap gap-1 mt-1">
    {PRESET_COLORS.map(c => (
      <button key={c} type="button"
        onClick={() => onChange(c)}
        className={`w-5 h-5 rounded-sm border ${value.toLowerCase() === c.toLowerCase() ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
        style={{ backgroundColor: c }} />
    ))}
  </div>
)
```

扇区参数区（`isSector` 分支内）加：
```tsx
<div>
  <label className="block text-xs font-medium mb-1">{t('layer.lineWidth')}</label>
  <input {...numberInput(ts.lineWidth, (v) => setTab(s => ({ ...s, lineWidth: v })))}
    placeholder="2" className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
</div>
```

**Step 4: locale 加 `lineWidth` 键**

zh.json: `"lineWidth": "线宽"`；en.json: `"lineWidth": "Line Width"`

**Step 5: 提交**

```bash
git add frontend/src/renderer/pages/LayerToolsPage.tsx frontend/src/renderer/config/layer-config.ts frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json
git commit -m "feat: 图层颜色选择器加常用色块+扇区线宽参数"
```

---

### Task 3: 点大小全链路修复 + 点形状参数

**Files:**
- Modify: `frontend/src/renderer/pages/LayerToolsPage.tsx`
- Modify: `frontend/src/renderer/services/api.ts`
- Modify: `frontend/src/renderer/config/layer-config.ts`
- Modify: `frontend/src/renderer/locales/zh.json`
- Modify: `frontend/src/renderer/locales/en.json`
- Modify: `backend/app/api/v1/endpoints/layer.py`
- Modify: `backend/app/services/layer_service.py`

**Step 1: 后端服务层加 `point_size`/`point_shape`**

`layer_service.py` 的 `generate_point_layer` 签名加 `point_size: Optional[float] = None`、`point_shape: Optional[str] = None`；把 `point_size`、`point_shape` 传给 `_apply_style`。

**Step 2: `_apply_style` 扩展**

签名加 `point_size: Optional[float] = None`、`point_shape: Optional[str] = None`、`line_width: Optional[int] = None`。点 KML 分支注入 SVG Data URI 图标（见 Task 4），点 MIF 分支用 `point_shape` 的 Symbol shape 编号：

```python
# MIF 点
POINT_SHAPE_MIF = {"circle": 35, "square": 33, "diamond": 36, "triangle": 40, "triangle_down": 41, "landmark": 42, "pin": 38}
shape = POINT_SHAPE_MIF.get(point_shape or "circle", 35)
text = re.sub(
    r'Symbol \((\d+),(\d+),(\d+)\)',
    lambda m: f'Symbol ({shape},{m.group(2)},{point_size or m.group(3)})', text,
)
```

扇区 KML LineStyle width 用 `line_width`（Task 5）。

**Step 3: 后端 `/point` 端点加参数**

`layer.py` 的 `generate_point` 加：
```python
point_size: Optional[float] = Form(None),
point_shape: Optional[str] = Form(None),
```
并传入服务调用。

**Step 4: 前端 api.ts 透传**

`GenerateLayerParams` 加 `pointSize?: number`、`pointShape?: string`、`lineWidth?: number`；`generatePoint` 的 formData 加：
```ts
if (params.pointSize) formData.append('point_size', String(params.pointSize))
if (params.pointShape) formData.append('point_shape', params.pointShape)
```
`generateSector` 的 formData 加：
```ts
if (params.lineWidth) formData.append('line_width', String(params.lineWidth))
```

**Step 5: 前端 handleGenerate 传参**

`base` 加 `pointSize: parseFloat(state.pointSize) || LAYER_DEFAULT_PARAMS.point.pointSize`、`pointShape: state.pointShape`、`lineWidth: parseInt(state.lineWidth) || 2`。注意 `pointSize`/`pointShape` 仅在非扇区时传（点图），`lineWidth` 仅在扇区时传。

**Step 6: TabState 加 `pointShape` 字段 + 点形状下拉**

```tsx
// TabState
pointShape: string
// emptyTabState
pointShape: type === 'point' ? LAYER_DEFAULT_PARAMS.point.pointShape : ''
```

点图参数区加形状下拉（带 SVG 样例）：
```tsx
const POINT_SHAPES = [
  { value: 'circle', label: t('layer.shapeCircle') },
  { value: 'square', label: t('layer.shapeSquare') },
  { value: 'diamond', label: t('layer.shapeDiamond') },
  { value: 'triangle', label: t('layer.shapeTriangle') },
  { value: 'triangle_down', label: t('layer.shapeTriangleDown') },
  { value: 'landmark', label: t('layer.shapeLandmark') },
  { value: 'pin', label: t('layer.shapePin') },
]
// renderParams 点图分支
<div className="col-span-2">
  <label className="block text-xs font-medium mb-1">{t('layer.pointShape')}</label>
  <select value={ts.pointShape} onChange={e => setTab(s => ({ ...s, pointShape: e.target.value }))}
    className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
    {POINT_SHAPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
  </select>
</div>
```

**Step 7: locale 加键**

zh/en 各加：`pointShape`、`shapeCircle`、`shapeSquare`、`shapeDiamond`、`shapeTriangle`、`shapeTriangleDown`、`shapeLandmark`、`shapePin`。

**Step 8: layer-config.ts 的 point 默认加 `pointShape: 'circle'`**

**Step 9: 提交**

```bash
git add frontend/src/renderer/pages/LayerToolsPage.tsx frontend/src/renderer/services/api.ts frontend/src/renderer/config/layer-config.ts frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json backend/app/api/v1/endpoints/layer.py backend/app/services/layer_service.py
git commit -m "feat: 点大小全链路修复+点形状参数(7种预设)"
```

---

### Task 4: 点 KML 补充 Icon (SVG Data URI) 定义

**Files:**
- Modify: `backend/app/services/layer_service.py`

**Step 1: 加 SVG 生成函数**

`layer_service.py` 顶部加：

```python
def svg_point_icon(shape: str, color: str, size_px: int = 32) -> str:
    """生成点形状的 SVG Data URI（KML Icon href，完全离线可用）。
    shape: circle/square/diamond/triangle/triangle_down/landmark/pin
    color: #RRGGBB
    """
    import base64
    from urllib.parse import quote
    fill = color or "#FF0000"
    # 各形状 SVG（32x32 viewBox，白色描边增强可见性）
    svgs = {
        "circle": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="12" fill="{fill}" stroke="#fff" stroke-width="2"/></svg>',
        "square": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="4" y="4" width="24" height="24" rx="2" fill="{fill}" stroke="#fff" stroke-width="2"/></svg>',
        "diamond": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="16,3 29,16 16,29 3,16" fill="{fill}" stroke="#fff" stroke-width="2"/></svg>',
        "triangle": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="16,3 29,29 3,29" fill="{fill}" stroke="#fff" stroke-width="2"/></svg>',
        "triangle_down": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="3,3 29,3 16,29" fill="{fill}" stroke="#fff" stroke-width="2"/></svg>',
        "landmark": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M16 3 L28 10 L16 17 L4 10 Z" fill="{fill}" stroke="#fff" stroke-width="2"/><rect x="4" y="12" width="24" height="4" fill="{fill}" stroke="#fff" stroke-width="1"/><rect x="12" y="16" width="8" height="10" fill="{fill}" stroke="#fff" stroke-width="1"/></svg>',
        "pin": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M16 2 C9 2 4 7 4 14 C4 23 16 30 16 30 C16 30 28 23 28 14 C28 7 23 2 16 2 Z" fill="{fill}" stroke="#fff" stroke-width="2"/><circle cx="16" cy="13" r="4" fill="#fff"/></svg>',
    }
    svg = svgs.get(shape, svgs["circle"])
    return "data:image/svg+xml," + quote(svg, safe='')
```

**Step 2: 点 KML 分支注入 Icon**

`_apply_style` 的点 KML 分支改为：

```python
if is_point:
    if hex_to_kml_color(border_color) is None:
        return out_path
    href = svg_point_icon(point_shape or "circle", border_color)
    scale = 1.0
    if point_size is not None:
        # 点大小 8 → scale≈0.6；16 → ≈1.2（基准）
        scale = max(0.3, min(3.0, point_size / 8 * 0.6))
    style = (
        f'<Style><IconStyle>'
        f'<color>{_kml_color_with_alpha(border_color, kml_opacity)}</color>'
        f'<scale>{scale:.2f}</scale>'
        f'<Icon><href>{href}</href></Icon>'
        f'</IconStyle></Style>'
    )
    text = re.sub(
        r'(<Placemark[^>]*>)',
        lambda m: m.group(1) + '\n' + style,
        text,
    )
```

注意：防御标记 `<IconStyle><color>` 现在仍有效（新注入的也有此标记），保持原判断。

**Step 3: 测试**

`test_layer_service.py` 加：
```python
def test_kml_point_icon_injected(service, sample_excel):
    """点 KML + 形状 → IconStyle 含 Icon/href (SVG Data URI)"""
    result, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="kml",
        border_color="#FF0000", point_shape="square", point_size=12,
    )
    text = result.read_text(encoding="utf-8")
    assert "data:image/svg+xml," in text
    assert "<Icon><href>" in text
    assert "<scale>0.90</scale>" in text  # 12/8*0.6=0.9
    import xml.etree.ElementTree as ET
    root = ET.fromstring(text)  # XML 合法

def test_mif_point_shape_applied(service, sample_excel):
    """点 MIF + 形状 → Symbol shape 编号替换"""
    result, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="mif",
        border_color="#FF0000", point_shape="square", point_size=10,
    )
    text = result.read_text(encoding="gbk", errors="replace")
    assert "Symbol (33," in text  # square=33
```

**Step 4: 提交**

```bash
git add backend/app/services/layer_service.py backend/tests/test_layer_service.py
git commit -m "feat: 点KML注入SVG图标+点形状MIF符号映射"
```

---

### Task 5: 扇区线宽后端生效

**Files:**
- Modify: `backend/app/services/layer_service.py`
- Modify: `backend/app/api/v1/endpoints/layer.py`

**Step 1: `_apply_style` 扇区 KML LineStyle width 用 line_width**

```python
width = line_width or 2
parts.append(f'<LineStyle><color>...</color><width>{width}</width></LineStyle>')
```

**Step 2: 扇区 MIF Pen 第 3 参数用 line_width**

```python
# Pen (1,color,width) — width 范围 1-7
pen_width = max(1, min(7, int(line_width or 2)))
text = re.sub(
    r'Pen \((\d+),(\d+),(\d+)\)',
    lambda m: f'Pen ({m.group(1)},{mif_border},{pen_width})', text,
)
```

**Step 3: `/sector` 端点加 `line_width` 参数并传入**

```python
line_width: Optional[int] = Form(None),
```

服务调用加 `None, None, None, line_width`（对应 border_color, fill_color, opacity 后的新参）。

**Step 4: 测试**

```python
def test_kml_sector_line_width(service, sample_excel):
    """扇区 KML + line_width → LineStyle width"""
    result, _ = service.generate_sector_layer(..., output_format="kml",
        border_color="#4A90D9", fill_color="#4A90D9", line_width=4)
    text = result.read_text(encoding="utf-8")
    assert "<width>4</width>" in text

def test_mif_sector_line_width(service, sample_excel):
    """扇区 MIF + line_width → Pen 第3参数"""
    result, _ = service.generate_sector_layer(..., output_format="mif",
        border_color="#4A90D9", fill_color="#4A90D9", line_width=4)
    text = result.read_text(encoding="gbk", errors="replace")
    assert "Pen (1,4886745,4)" in text  # #4A90D9 → 4886745
```

**Step 5: 提交**

```bash
git add backend/app/services/layer_service.py backend/app/api/v1/endpoints/layer.py backend/tests/test_layer_service.py
git commit -m "feat: 扇区线宽后端生效(KML LineStyle width + MIF Pen)"
```

---

### Task 6: 全量回归 + 文档

**Files:**
- Modify: `backend/tests/test_layer_service.py`
- Modify: `backend/tests/test_layer_api.py`

**Step 1: 后端全量测试**

Run: `cd backend && source .venv/bin/activate && .venv/bin/python -m pytest -q`
Expected: 全部 PASS（若 API 测试因新参数签名受影响，补充 `point_size`/`point_shape`/`line_width` 断言）

**Step 2: API 端到端测试**

`test_layer_api.py` 加：
```python
def test_point_endpoint_with_shape_and_size():
    """点图层 + point_shape/point_size → KML 含 Icon 图标"""
    ... # 构造请求带 point_shape='square', point_size='12'
    # 断言 KML 含 data:image/svg+xml 和 scale
```

**Step 3: 前端构建**

Run: `cd frontend && npm run build:vite`
Expected: 构建成功，无 TS 错误（LayerToolsPage/api.ts 相关）

**Step 4: 提交**

```bash
git add backend/tests/test_layer_service.py backend/tests/test_layer_api.py
git commit -m "test: 点形状/大小/线宽 API 与构建回归"
```
