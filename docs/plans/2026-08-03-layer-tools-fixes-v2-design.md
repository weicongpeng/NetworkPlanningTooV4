# 图层制作问题修复 v2 设计文档

**日期**: 2026-08-03
**范围**: 3 项新问题（扇区 MIF 报错、点图符号错误、上传进度跨页+取消、点图透明度隐藏）

---

## 1. 问题与根因

### 1.1 扇区 MIF 在 MapInfo 导入报 `Invalid stylevalue 1.6777e+007`

**现象**: 扇区图层制作的 MIF 在 MapInfo 导入无法生成 tab，报错 `(projectparameter_河源电联_nr_sector.mif:61) Invalid stylevalue 1.6777e+007.`。点图层 MIF 正常。

**根因（已复现 + 权威确认）**: `_apply_style` 里扇区 Pen 注入**参数顺序错位**。

MapInfo `Pen` 语法是 `(width, pattern, color)`：
- width: 线宽（1-7）
- pattern: 填充图案（0-71）
- color: 24-bit RGB 颜色

当前代码（`backend/app/services/layer_service.py:403-407`）：
```python
text = re.sub(r'Pen \((\d+),(\d+),(\d+)\)',
    lambda m: f'Pen ({m.group(1)},{mif_border},{pen_width})', text)
#             width=1    pattern=颜色值!  color=线宽!
```

GDAL 默认 `Pen (1,2,0)` → 注入后 `Pen (1, {mif_border}, {pen_width})`。当边框色是**白色**（`#FFFFFF` = 16777215）时变成 `Pen (1, 16777215, 2)` —— 颜色值 16777215 被塞进 pattern 位（合法 0-71）→ **`Invalid stylevalue 1.6777e+007`**（`16777215` 的科学计数法）。

点图正常是因为 `Symbol (shape, color, size)` 参数顺序写对了。**线宽 `pen_width` 也被错误塞进 color 位**，所以线宽设置实际从未生效。

### 1.2 点图 MIF 始终五角星、大小固定

**现象**: 点图层颜色按设置填充，但点形状和点大小不生效，始终生成五角星、大小固定。

**根因（权威确认）**: `POINT_SHAPE_MIF` 符号编号**映射错误**：
```python
POINT_SHAPE_MIF = {"circle": 35, "square": 33, "diamond": 36, ...}
```
- MapInfo 3.0 Symbols 字体中 **code 34 = Circle**（MapBasic 参考文档明示，`MakeSymbol(34, RED, 18)` 显示圆形）
- **code 35 = Star**（用户实测五角星正是 35）
- **code 33 = Diamond**（Precisely 社区文档明示 `Symbol(33,0,72)` = Diamond）

所以 `circle: 35` 渲染成五角星，`square: 33` 渲染成菱形。**大小固定**：GDAL 默认 `Symbol (35,0,12)`，注入后 `Symbol (35, 颜色, 12)` 保留 size=12，但 shape 是错的（五角星），且前端 `pointSize` 映射的 size 值可能未正确应用。

### 1.3 上传进度跨页面不显示 + 无取消按钮

**现象**: 文件上传的实时动态进度在切换不同页面后回来不再显示。

**根因**: `uploading`/`progress` 是 `LayerToolsPage` **组件本地 state**（`LayerToolsPage.tsx:116,118`）。React Router 路由切换卸载组件，本地 state 丢失。`chunkedUpload`（`api.ts:342`）是 async 函数，**组件卸载后 promise 仍在后台继续执行**（只丢 state 更新），但进度无处显示。`chunkedUpload` 内部有 `/cancel` 调用（重试超限时 `api.ts:393`），但**未暴露外部取消接口**，会话 id 也未传出。

### 1.4 点图层透明度删除

**现象**: 点图层制作页面有"透明度"参数项。

**根因**: `renderParams` 透明度 input（`LayerToolsPage.tsx:356-363`）未区分扇区/点图，点图也渲染。

---

## 2. 修复方案

### 2.1 扇区 MIF Pen 参数顺序修正

`_apply_style` 扇区分支 Pen 注入改为：
```python
# MapInfo Pen (width, pattern, color) → 线宽进 width、保留原 pattern、颜色进 color
lambda m: f'Pen ({pen_width},{m.group(2)},{mif_border})'
```
保留 GDAL 原始 pattern（`m.group(2)`），线宽进 width 位，颜色进 color 位。Brush 参数顺序已正确（`Brush (pattern, forecolor, backcolor)`），不动。

**验证**：白色边框不再报 `Invalid stylevalue`；线宽参数真正生效。

### 2.2 点形状符号编号纠正 + 下拉图标化

**纠正 `POINT_SHAPE_MIF`**（已确认值）：
```python
POINT_SHAPE_MIF = {
    "circle": 34,      # 原 35（Star）→ 34（Circle）
    "square": 32,      # 原 33（Diamond）→ 32（Square）
    "diamond": 33,     # 原 36 → 33（Diamond）
    "triangle": 40,    # 维持
    "triangle_down": 41,  # 维持
    "landmark": 42,    # 维持
    "pin": 38,         # 维持
}
```
仅纠正 circle/square/diamond（已权威确认），其余维持现有编号。

**点形状下拉图标化**：`LayerToolsPage` 的点形状 `<select>` 从纯文字标签改为**每个选项内联渲染 SVG 形状图标**：
- circle → 圆形 SVG
- square → 方形 SVG
- diamond → 菱形 SVG
- triangle → 三角形 SVG
- 等

用 `option` 内嵌 SVG 或自定义下拉组件渲染。前端 `POINT_SHAPES` 数组扩展 `icon` 字段（SVG JSX 或 data-uri）。

### 2.3 上传进度跨页 + 取消 → 模块级 store + 订阅

**方案**: 新建 `frontend/src/renderer/store/uploadStore.ts`（**模块级单例，非 React 全局 store**）：

```ts
// 模块级上传进度单例（非 React store，chunkedUpload 后台更新，组件订阅）
interface UploadProgress {
  active: boolean
  percent: number       // 0-100
  step: string          // 'uploading' | 'reading' | 'done'
  sessionId: string     // 分块上传会话 id
  cancel: () => void    // 取消回调
}
```

- `chunkedUpload` 改造（`api.ts`）：
  - 新增可选 `onSessionId?(id)` 或返回 `{ sessionId }`
  - 暴露取消：返回一个 `cancel` 函数（中止后续分块 + 调 `/cancel`）
  - 后台更新模块级 progress（不依赖组件 state）
- `LayerToolsPage`：
  - 挂载时订阅模块级 store（`useEffect` + `subscribe`）→ 实时渲染进度条
  - 卸载时取消订阅（上传继续后台跑）
  - 切回页面自动恢复实时进度
  - 进度条右侧"取消"按钮 → 调模块级 `cancel()` + 清理进度
- **仅图层制作页内恢复**（不在全局 header）

**关键点**：模块级 store 不是 React state，chunkedUpload 后台运行时即使组件卸载也能更新它；组件重新挂载订阅后立即读到最新进度并实时渲染。

### 2.4 点图层透明度删除

`LayerToolsPage` 的透明度 input 加 `isSector` 条件：
```tsx
{isSector && (
  <div className="col-span-2">
    {/* 透明度 input */}
  </div>
)}
```
后端 point 端点仍接受 `opacity` 参数（兼容），前端点图不传 → 点图始终不透明。**不删后端参数**（避免破坏 API 契约）。

---

## 3. 影响文件

| 文件 | 改动 |
|------|------|
| `backend/app/services/layer_service.py` | `POINT_SHAPE_MIF` 纠正；`_apply_style` 扇区 Pen 参数顺序 |
| `backend/tests/test_layer_service.py` | 更新符号编号断言；新增 Pen 顺序断言 |
| `backend/tests/test_layer_api.py` | 更新 MIF 样式断言 |
| `frontend/src/renderer/services/api.ts` | `chunkedUpload` 暴露会话 id + 取消 + 模块级进度 |
| `frontend/src/renderer/store/uploadStore.ts` | 新建模块级上传进度单例 |
| `frontend/src/renderer/pages/LayerToolsPage.tsx` | 订阅模块级进度 + 取消按钮 + 点图透明度隐藏 + 点形状下拉图标化 |
| `frontend/src/renderer/locales/zh.json` / `en.json` | 新增取消按钮文案等 |

## 4. 验证

- 后端测试全绿（新增 Pen 顺序、符号编号断言）
- 前端 `npx tsc --noEmit` 无新错误、`npm run build:vite` 成功
- 手工验证：
  1. 扇区 MIF 白色边框 → MapInfo 导入正常、线宽生效
  2. 点图 MIF circle → 圆形、square → 方形，点大小按设置
  3. 上传进度条切页后回来实时恢复，取消按钮生效
  4. 点图 Tab 无透明度项
