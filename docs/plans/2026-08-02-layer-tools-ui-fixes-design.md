# 图层制作 UI 修复 设计文档

> 日期：2026-08-02
> 范围：图层制作 4 项修复（下载交叉、色块+线宽、点形状+点大小、点 KML 显示）

## 1. 问题与根因

| # | 问题 | 根因 |
|---|------|------|
| 1 | 切换扇区/点图层 Tab 时，下载图层按钮交叉显示旧 Tab 的文件 | Tab 切换时旧 `result`（下载按钮+统计）未清空 |
| 2 | 颜色选择器无常用色块；无图形线宽设置 | 颜色选择器只有原生 `<input type="color">`；扇区描边无线宽参数 |
| 3 | 点图层"点大小"设置无效 | `pointSize` 全链路缺失：前端 `handleGenerate` 未传、`api.ts` `generatePoint` 未发送 formData、后端 `/point` 端点无 `point_size` 参数、服务层未应用 |
| 4 | 点图层 KML 导入软件无法显示图形（扇区正常） | 点 KML 只有 `<IconStyle><color>`，无 `<Icon><href>` 图标定义。GDAL 默认点无图标，部分 GIS 软件（MapInfo/Global Mapper）对无 Icon 的 IconStyle Placemark 不渲染 |

## 2. 方案

### 2.1 问题 1：切换 Tab 清空旧结果

`onValueChange` 切换 Tab 时，清空非激活 Tab 的 `result`（下载按钮+统计随之消失），保留各 Tab 配置（字段映射、参数）。

```tsx
const handleTabChange = (v: 'sector' | 'point') => {
  setActiveTab(v)
  if (v === 'point') setSectorState(s => ({ ...s, result: null }))
  else setPointState(s => ({ ...s, result: null }))
}
```

### 2.2 问题 2：常用色块 + 扇区线宽

**色块**：颜色选择器旁加 8 个常用色块预设，点击即选中：

```ts
const PRESET_COLORS = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#000000', '#FFFFFF']
```

- 扇区：边框色、填充色各一组
- 点图：边框色一组

**线宽**（仅扇区）：新增 `lineWidth` 参数（数字，默认 2，范围 1-7）：
- KML 扇区 `LineStyle <width>`
- MIF 扇区 `Pen` 第 3 参数

### 2.3 问题 3：点形状 + 点大小修复

**点形状**：7 种预设（圆形、正方形、菱形、正三角、倒三角、地标、图钉），下拉选择带 SVG 样例。

| 形状 | KML (SVG Data URI) | MIF Symbol shape |
|------|-----|------|
| 圆形 | 圆形 SVG | 35 |
| 正方形 | 方形 SVG | 33 |
| 菱形 | 菱形 SVG | 36 |
| 正三角 | 正三角 SVG | 40 |
| 倒三角 | 倒三角 SVG | 41 |
| 地标 | 旗帜 SVG | 42 |
| 图钉 | 图钉 SVG | 38 |

- KML：内嵌 SVG Data URI 作为 `<Icon><href>`（完全离线可用），颜色=边框色、透明度=opacity
- MIF：`Symbol (shape, color, size)`
- TAB：保持默认点符号（形状/颜色仅 MIF/KML 生效，与现有 `colorTabHint` 一致）

**点大小修复**（全链路补上）：
1. 前端 `handleGenerate` base 加 `pointSize`
2. `api.ts` `generatePoint` 发 `point_size`
3. 后端 `/point` 端点加 `point_size`
4. 服务层应用到 KML `IconStyle <scale>` 和 MIF `Symbol` size

### 2.4 问题 4：点 KML 补充 Icon 定义

为点 Placemark 注入完整 `<Style><IconStyle><color>…</color><scale>…</scale><Icon><href>data:image/svg+xml,…</href></Icon></IconStyle></Style>`。

SVG Data URI 完全离线可用（已验证 XML 合法）。点大小 → `scale`（基准 1.0）。

## 3. 前端 UI 布局

参数网格（右栏）：
- **扇区**：半径、波瓣夹角、边框色(+色块)、填充色(+色块)、线宽、透明度、输出格式
- **点图**：点大小、点形状(下拉带样例)、边框色(+色块，标签改"填充颜色")、透明度、输出格式

点图"边框颜色"改标签为"填充颜色"（点图无边框，颜色即填充）。

## 4. 兼容性与错误处理

- 新参数均可选（旧请求不带也能生成）
- 点大小默认 8，线宽默认 2，范围 1-7
- `colorTabHint` 文案扩展为"TAB 不支持形状/颜色/透明度，样式仅 MIF/KML 生效"

## 5. 测试

- 后端服务：点形状映射、KML Icon href、MIF Symbol shape、点大小 scale、线宽注入
- 后端 API：`point_size`/`point_shape`/`line_width` 端到端
- 前端：构建通过、TS 零新增错误
