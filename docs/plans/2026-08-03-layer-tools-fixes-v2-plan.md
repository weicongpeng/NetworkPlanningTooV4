# 图层制作问题修复 v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复图层制作 3 项问题：扇区 MIF 报错（Pen 参数顺序）、点图符号错误（编号纠正+下拉图标化）、上传进度跨页+取消按钮、点图透明度隐藏。

**Architecture:** 后端 FastAPI + pyogrio（修 MIF 样式注入）；前端 React 18 + TypeScript（模块级上传 store + 订阅、点形状下拉图标化、点图透明度隐藏）。

**Tech Stack:** Python 3.12 / FastAPI / pyogrio；React 18 / TypeScript / Tailwind / Radix UI / i18next。

**设计文档:** `docs/plans/2026-08-03-layer-tools-fixes-v2-design.md`（已提交 b0a0797）

---

### Task 1: 后端扇区 MIF Pen 参数顺序修正 + 点形状符号编号纠正

**Files:**
- Modify: `backend/app/services/layer_service.py:27-31,403-412`
- Test: `backend/tests/test_layer_service.py`

**背景**: 两个根因：
1. **Pen 参数错位**：`_apply_style` 扇区 Pen 注入 `Pen ({m.group(1)},{mif_border},{pen_width})` 把颜色塞进 pattern 位（合法 0-71）、线宽塞进 color 位。白色边框 `16777215` 进 pattern → MapInfo 报 `Invalid stylevalue`。MapInfo `Pen (width, pattern, color)`。
2. **符号编号错误**：`POINT_SHAPE_MIF` 的 circle=35（实为 Star）、square=33（实为 Diamond）、diamond=36（应 33）。已确认 circle=34、square=32、diamond=33。

**Step 1: 写失败测试（RED）**

在 `test_layer_service.py` 新增/修改：

```python
def test_mif_sector_pen_parameter_order(service, sample_excel):
    """扇区 MIF Pen 参数顺序：(width, pattern, color)，颜色进 color 位、线宽进 width 位。
    白色边框 #FFFFFF=16777215 不应进入 pattern 位（0-71），否则 MapInfo 报 Invalid stylevalue"""
    result, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="mif",
        border_color="#FFFFFF", fill_color="#4A90D9", line_width=4,
    )
    text = result.read_text(encoding="gbk", errors="replace")
    # Pen (width=4, pattern=2(GDAL默认), color=16777215) —— 颜色在第三位
    assert "Pen (4,2,16777215)" in text
    # pattern 位绝不出现颜色值（<=71）
    import re
    for m in re.finditer(r'Pen \((\d+),(\d+),(\d+)\)', text):
        assert int(m.group(2)) <= 71, f"pattern 位越界: {m.group(0)}"


def test_mif_point_shape_codes_corrected(service, sample_excel):
    """点形状符号编号纠正：circle=34、square=32、diamond=33"""
    # circle
    r1, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="mif",
        border_color="#FF0000", point_shape="circle", point_size=10,
    )
    assert "Symbol (34,16711680,10)" in r1.read_text(encoding="gbk", errors="replace")
    # square
    r2, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="mif",
        border_color="#FF0000", point_shape="square", point_size=10,
    )
    assert "Symbol (32,16711680,10)" in r2.read_text(encoding="gbk", errors="replace")
    # diamond
    r3, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="mif",
        border_color="#FF0000", point_shape="diamond", point_size=10,
    )
    assert "Symbol (33,16711680,10)" in r3.read_text(encoding="gbk", errors="replace")
```

> 注意：`test_mif_point_shape_applied`（现有）断言 `Symbol (33,16711680,10)`（square）需更新为 `Symbol (32,...)`。`test_mif_point_color_injected` 断言 `Symbol (35,4886745,` 需更新为 `Symbol (34,4886745,`（circle）。

**Step 2: 运行测试确认失败**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && source .venv/bin/activate && .venv/bin/python -m pytest tests/test_layer_service.py -k "pen or shape or color" -v`
Expected: 新测试 FAIL（当前 Pen 顺序错、符号编号错）

**Step 3: 实现修复**

`layer_service.py:27-31` 纠正符号表：
```python
# 点形状 → MapInfo Symbol shape 编号（MapInfo 3.0 Symbols：34=Circle 32=Square 33=Diamond 35=Star）
POINT_SHAPE_MIF = {
    "circle": 34, "square": 32, "diamond": 33,
    "triangle": 40, "triangle_down": 41, "landmark": 42, "pin": 38,
}
```

`layer_service.py:403-412` Pen 注入修正：
```python
if mif_border is not None:
    # MapInfo Pen (width, pattern, color)：线宽进 width、保留原 pattern、颜色进 color
    # 修复前错误写为 (1, mif_border, pen_width) → 颜色进 pattern 位（0-71）导致 Invalid stylevalue
    text = re.sub(
        r'Pen \((\d+),(\d+),(\d+)\)',
        lambda m: f'Pen ({pen_width},{m.group(2)},{mif_border})', text,
    )
```

**Step 4: 运行测试确认通过**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && source .venv/bin/activate && .venv/bin/python -m pytest tests/test_layer_service.py -q`
Expected: 全绿（含更新的现有断言）

**Step 5: Commit**

```bash
git add backend/app/services/layer_service.py backend/tests/test_layer_service.py
git commit -m "fix: 扇区MIF Pen参数顺序修正 + 点形状符号编号纠正

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 前端点形状下拉图标化 + 点图透明度隐藏

**Files:**
- Modify: `frontend/src/renderer/pages/LayerToolsPage.tsx`
- Modify: `frontend/src/renderer/locales/zh.json` / `en.json`

**背景**: 点形状下拉当前是 `<select>` + 文字标签（`POINT_SHAPES` 数组 `{value, label}`）。用户要求每个选项显示形状图标。点图透明度当前未区分扇区/点图渲染。

**Step 1: 前端 POINT_SHAPES 扩展 icon 字段**

```tsx
// 点形状选项（KML SVG / MIF Symbol shape 编号一致；icon 为形状预览 SVG）
const POINT_SHAPES = [
  { value: 'circle', label: t('layer.shapeCircle'),
    icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5"><circle cx="8" cy="8" r="6" fill="currentColor" /></svg> },
  { value: 'square', label: t('layer.shapeSquare'),
    icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5"><rect x="2" y="2" width="12" height="12" fill="currentColor" /></svg> },
  { value: 'diamond', label: t('layer.shapeDiamond'),
    icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5"><polygon points="8,2 14,8 8,14 2,8" fill="currentColor" /></svg> },
  { value: 'triangle', label: t('layer.shapeTriangle'),
    icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5"><polygon points="8,2 14,14 2,14" fill="currentColor" /></svg> },
  { value: 'triangle_down', label: t('layer.shapeTriangleDown'),
    icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5"><polygon points="2,2 14,2 8,14" fill="currentColor" /></svg> },
  { value: 'landmark', label: t('layer.shapeLandmark'),
    icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5"><rect x="3" y="6" width="10" height="8" fill="currentColor" /><rect x="4" y="2" width="8" height="2" fill="currentColor" /></svg> },
  { value: 'pin', label: t('layer.shapePin'),
    icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5"><path d="M8 1c-3 0-5 2-5 5 0 3 5 9 5 9s5-6 5-9c0-3-2-5-5-5z" fill="currentColor" /></svg> },
]
```

**Step 2: 下拉改为带图标**

把 `<select>` 的 option 渲染改成：
```tsx
<select value={ts.pointShape} onChange={...} className="...">
  {POINT_SHAPES.map(s => (
    <option key={s.value} value={s.value}>{s.label}</option>
  ))}
</select>
```
改为自定义渲染（`<option>` 里可嵌 SVG 不可靠，部分浏览器不渲染 option 内 HTML）。推荐方案：**用当前选中项旁显示图标 + 下拉列表项也显示图标**。若 `<option>` 内 SVG 不兼容，退化为：select 上方显示选中形状图标，右侧显示形状。

更稳妥：用 `<select>` 的 value 匹配显示当前形状图标 + 下拉保持文字（因 option 内 HTML 跨浏览器不可靠）。但用户明确要"下拉直接加载图标"。用 `option` 内嵌 SVG 实测 Chrome/Firefox 支持（现代浏览器渲染 option 内 SVG）。采用 `<option>` 内嵌 SVG：
```tsx
<option key={s.value} value={s.value} className="flex items-center gap-2">
  <span className="inline-flex items-center gap-2">{s.icon}{s.label}</span>
</option>
```

**Step 3: 点图透明度隐藏**

`renderParams` 透明度 input 区块（第 356-363 行）加 `isSector` 条件：
```tsx
{isSector && (
  <div className="col-span-2">
    <label className="block text-xs font-medium mb-1">{t('layer.opacity')}</label>
    <input {...numberInput(ts.opacity, (v) => setTab(s => ({ ...s, opacity: v })))}
      placeholder="0" className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
    <p className="text-[10px] text-muted-foreground mt-1">{t('layer.opacityHint')}</p>
  </div>
)}
```

**Step 4: 翻译 key 确认**

检查 `zh.json`/`en.json` 的 `shapeCircle`/`shapeSquare` 等 label 是否存在（已有）。新增 `opacityHint` 是否已存在（上轮已加）。无需新增 key。

**Step 5: 验证 + Commit**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit`（改动文件无新错误）+ `npm run build:vite`

```bash
git add frontend/src/renderer/pages/LayerToolsPage.tsx
git commit -m "feat: 点形状下拉图标化 + 点图透明度隐藏

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 上传进度跨页 + 取消按钮（模块级 store + 订阅）

**Files:**
- Create: `frontend/src/renderer/store/uploadStore.ts`
- Modify: `frontend/src/renderer/services/api.ts`（chunkedUpload 暴露会话 id + 取消 + 模块级进度）
- Modify: `frontend/src/renderer/pages/LayerToolsPage.tsx`（订阅 + 取消按钮）
- Modify: `frontend/src/renderer/locales/zh.json` / `en.json`（取消按钮文案）

**背景**: 上传进度当前是组件本地 state，切页丢失。chunkedUpload 是 async 函数，组件卸载后 promise 后台继续跑但进度无处显示。

**Step 1: 新建模块级 uploadStore**

`frontend/src/renderer/store/uploadStore.ts`：
```ts
// 模块级上传进度单例（非 React store）：chunkedUpload 后台更新，组件订阅实时渲染
// 切页不丢失：上传任务在组件卸载后仍在后台执行，模块级 store 记录进度，组件重挂载时恢复

export interface UploadProgress {
  active: boolean
  percent: number        // 0-100
  step: string           // 'uploading' | 'reading' | 'done'
  sessionId: string      // 分块上传会话 id（用于取消）
  fileName: string       // 上传文件名
}

type Listener = (p: UploadProgress) => void

let current: UploadProgress = { active: false, percent: 0, step: '', sessionId: '', fileName: '' }
let cancelFn: (() => void) | null = null
const listeners = new Set<Listener>()

export const uploadStore = {
  get(): UploadProgress { return current },
  subscribe(l: Listener): () => void {
    listeners.add(l)
    return () => { listeners.delete(l) }
  },
  _set(p: Partial<UploadProgress>) {
    current = { ...current, ...p }
    listeners.forEach(l => l(current))
  },
  _setCancel(fn: (() => void) | null) { cancelFn = fn },
  cancel() { cancelFn?.() },
}
```

**Step 2: chunkedUpload 改造**

`api.ts` 的 `chunkedUpload` 增加：
- 参数 `onProgress` 已存在（percent），额外在 start 后调 `uploadStore._set({ active: true, sessionId: dataId, step: 'uploading' })`，progress 更新时调 `uploadStore._set({ percent })`，complete 后 `uploadStore._set({ active: false, step: 'done' })`。
- 暴露取消：在 `dataId` 获取后设置取消句柄：
  ```ts
  uploadStore._setCancel(() => {
    // 中止后续分块 + 调后端取消
    uploadStore._set({ active: false })
    try { uploadClient.post(`${basePath}/${dataId}/cancel`) } catch { /* ignore */ }
  })
  ```
  分块循环里检查一个 `cancelled` 标志，取消后 `break`。
- 返回 `{ sessionId: dataId }`（供 LayerToolsPage 用）。

具体：`chunkedUpload` 内部加局部 `let cancelled = false`；`uploadStore._setCancel` 设置 `cancelled = true` 并调 `/cancel`；每块前 `if (cancelled) break`。complete 阶段 `if (cancelled) throw new Error('已取消')`。

> 注意：`chunkedUpload` 被 `dataApi.uploadExcel`/`uploadGeoData`/`layerToolsApi.uploadLayerFile` 复用。模块级进度写入应只对 layer 上传生效（避免其他上传也写入全局进度）。加参数 `trackProgress?: boolean`，仅 `layerToolsApi.uploadLayerFile` 传 true。

**Step 3: LayerToolsPage 订阅 + 取消按钮**

- 移除本地 `uploading`/`progress` state，改用模块级：
  ```tsx
  const [uploadProgress, setUploadProgress] = useState(uploadStore.get())
  useEffect(() => {
    return uploadStore.subscribe(setUploadProgress)
  }, [])
  ```
- `processFile` 里 `uploadLayerFile` 调 `layerToolsApi.uploadLayerFile(f, cb, true)`（trackProgress）。cb 更新模块级。
- 进度条渲染：`uploadProgress.active && uploadProgress.percent > 0` 时显示。右侧加取消按钮：
  ```tsx
  <button onClick={() => uploadStore.cancel()} className="...">
    {t('layer.cancelUpload')}
  </button>
  ```
- 上传完成/失败时 `uploadStore._set({ active: false })`。

**Step 4: 翻译 key**

`zh.json`/`en.json` 新增：
- `cancelUpload`: "取消" / "Cancel"

**Step 5: 验证 + Commit**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit`（改动文件无新错误）+ `npm run build:vite`

```bash
git add frontend/src/renderer/store/uploadStore.ts frontend/src/renderer/services/api.ts frontend/src/renderer/pages/LayerToolsPage.tsx frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json
git commit -m "feat: 图层制作上传进度跨页恢复 + 取消按钮（模块级store+订阅）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 全量回归验证

**Files:**
- 无新增改动，验证为主

**Step 1: 后端全量测试**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && source .venv/bin/activate && .venv/bin/python -m pytest -q`
Expected: 全部通过（131+ 含新增断言）

**Step 2: 前端构建**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npm run build:vite`
Expected: 成功

**Step 3: 手工验证**

1. 扇区 MIF 白色边框 → MapInfo 导入正常、线宽生效（不再报 Invalid stylevalue）
2. 点图 MIF circle → 圆形、square → 方形、点大小按设置
3. 上传进度条切页后回来实时恢复，取消按钮生效
4. 点图 Tab 无透明度项

**Step 4: 无遗留 TODO / test.skip**

Run: `grep -rn "test.skip\|\.only\b" frontend/src/renderer/pages/LayerToolsPage.tsx backend/app/services/layer_service.py backend/app/api/v1/endpoints/layer.py`
Expected: 无新增遗留

---

## 验证清单（总）

- [ ] 后端 `pytest tests/test_layer_service.py tests/test_layer_api.py` 全绿
- [ ] 后端全量 `pytest -q` 全绿
- [ ] 前端 `npx tsc --noEmit` 无新错误
- [ ] 前端 `npm run build:vite` 成功
- [ ] 手工：扇区 MIF 导入 / 点形状符号 / 上传跨页+取消 / 点图透明度隐藏
