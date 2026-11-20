# 专题图层（Thematic Layer）功能设计

## Context

为地图工具新增"专题图层"功能：用户为"图层文件"/"地理化数据"下的图层选择一个属性字段，按字段值进行分段配色渲染（数值类：连续区间分段配色；文本类：按文本值配色），并在地图上显示悬浮图例框。由 scout（代码侦察）+ reviewer（方案审查）两个专家 agent 参与设计验证。

## 现状梳理（专家侦察结论）

- **入口**：右键图层或点击图层左侧图标 → `LabelSettingsModal`（双 Tab：标签设置 / 图层颜色设置）；color tab 现有四项基础配置（`LayerColorSettings`），链路：`LayerControl.onColorSettingsChange` → `MapPage.handleColorSettingsChange` → `OnlineMap.setLayerColorSettings` → 图层实例 `setStyleOverrides()`
- **两类渲染器**（数据模型不同，取值方式必须分治）：
  - `MapInfoLayer`（图层文件 tab/mif/kml）：Leaflet GeoJSON，`style` 回调（L470）能读扁平 `feature.properties`（含 `_style`），点要素走 `pointToLayer`（L432）；**无 this.data**；`setStyleOverrides`（L620）整层统一改色 + `resetStyle`
  - `GeoDataLayer`（地理化数据 Excel）：自管渲染，`_mergeStyleOverrides`（L1242）整层统一覆盖；**字段值在嵌套 `item.properties.properties.<field>`**（OnlineMap 把整条 item 塞进 properties）；`setStyleOverrides`（L1263）→ `_reRenderGeometries()`（L1466）全量重建
- **字段 API 已存在**：`layerApi.getLayerColumns`（`/data/{id}/layers/{lid}/columns` 返回 fields）；`layerApi.getLayerData`（GeoJSON FeatureCollection，600s 超时）
- **前端已有数据缓存**：MapInfo GeoJSON 在 `useMapDataCacheStore.layers[layerId].geojson`（prefetchLayerData 写入）；Excel 在 `pointFileData` prop / `prefetchedExcelDataRef` / `dataApi.get` 结果
- **持久化**：`mapStore.mapSettings`（zustand persist + 后端 user_settings 全量 dict 同步，后端无需改动）
- **图例先例**：PCILegend/TACLegend/NeighborLegend 均在**业务页面**与 OnlineMap 平级挂载（不在 OnlineMap 内部）；OnlineMap 内部不挂任何图例
- **i18n**：zh map 段 131 keys / en 130 keys 结构一致，新增 key 必须双语言同步

## Approach

### 1. 数据模型（LabelSettingsModal.tsx 内新增）

```ts
export type ThematicFieldType = 'numeric' | 'text'

export interface ThematicRange { min: number; max: number; color: string }  // 区间语义：min 含、max 不含；末段 max 含
export interface ThematicCategory { value: string; color: string }

export interface ThematicSettings {
  enabled: boolean
  field: string
  fieldType: ThematicFieldType
  pointSize: number                                   // 图形大小（点要素半径，数值类页面设置）
  ranges: ThematicRange[]                             // 数值类：连续区间
  categories: ThematicCategory[]                      // 文本类
}
```

### 2. 存储

`mapStore.ts`：`mapSettings` 新增 `thematicSettingsMap: Record<string, ThematicSettings>` + `setThematicSettings(layerId, settings)`，`partialize`/`merge` 同步（同 `colorSettingsMap` 模式，merge 兜底 `?? {}`）。图层删除后残留与现有 colorSettingsMap 行为一致（接受，不做额外清理）。

### 3. 弹窗 UI（LabelSettingsModal.tsx）

- 新增 prop `showThematicTab: boolean`（仅 `node.type === 'layer-file'` 时为 true；**sector-layer 与 decoration-layer 均不显示**，gate 在 LayerControl.handleContextMenu 统一按类型控制）
- color tab 内部改两个子页（复用现有 tab 按钮样式）：**基础配置**（现有四项原样搬入）/ **专题图层**（新增）：
  - "启用专题图层"开关
  - 属性字段下拉（复用 `fieldOptions` 机制与缓存）
  - 字段类型自动检测：字段值样本扫描，**先排除 `''`/`null`/`undefined`/纯空白**，剩余全部可转数字 → 数值类（避免 `Number('')===0` 误判）
  - 数值类：区间列表（每行 min~max 输入 + 颜色选择器，可增删行）；"推荐默认区间"按钮（min~max 等分 5 段 + 预设色带）；图形大小滑块（点半径，仅点要素生效）
  - 文本类：字段唯一值列表（自动提取，**前 20 个** + 其余合并为"其他"灰色）
  - **字段切换时重置 ranges/categories**（旧区间套新字段无意义）
  - 弹窗加 `max-h-[80vh] overflow-y-auto`（w-96 现有内容 + 两子页必然超高）
- **保存**：`handleSave` 在 color tab 下**总是同时保存基础配置 + 专题配置**（两套独立状态互不覆盖；专题启用时基础控件禁用并提示"专题图层激活中"）
- **互斥**（UI 层）：启用专题 → 基础配置页控件禁用；关闭 → 恢复

### 4. 渲染（互斥在样式管线层实现，非仅 UI）

**核心原则：两渲染器各保留独立字段（`styleOverrides` 基础配置 + `thematicSettings` 专题配置），有效样式 = thematic 优先、base 次之，单一入口计算。**

#### MapInfoLayer.tsx
- 新增私有字段 `thematicSettings: ThematicSettings | null`
- **把专题色并入样式计算源头**（不是仿 setStyleOverrides 逐要素 setStyle）：
  - `style` 回调（L470）与 `pointToLayer`（L432）内：若 `thematicSettings?.enabled` 且有匹配，用专题色覆盖该要素的 fillColor/color（按 `feature.properties[field]` 匹配区间/文本，未匹配/空值 → 灰 `#9ca3af`）；否则走现有逻辑
  - 这样 `resetStyle`（L675/734，框选清除/高亮重应用路径）天然带专题色，**不会**被还原成基础色
- `setThematicOverrides(settings | null)`：存字段；已渲染则 `eachLayer` 重应用（点 setStyle/setIcon、线面 resetStyle，同 setStyleOverrides 末尾强制重绘兜底）
- `setStyleOverrides` 保持不变（只写 base 字段），与专题字段互不覆盖

#### GeoDataLayer.tsx
- 新增私有字段 `thematicSettings: ThematicSettings | null`
- `setThematicOverrides(settings | null)`：存字段；已渲染可见则 `_reRenderGeometries()`（全量重建，天然安全）
- 渲染循环（`_renderPoints`/`_renderSectors`/`_renderPolygons`）创建几何时：新增 `_thematicStyleFor(item, baseStyle)` 辅助——专题启用时按字段值返回 { fillColor, color, radius? } 覆盖 base；未匹配/空值 → 灰。点半径：`pointSize` 替换现有半径计算（仅点要素；扇区不调大小）
- `_mergeStyleOverrides` 保持 base 语义不变

#### 字段取值（S3：检测与渲染共用同一 lookup）
- 抽取 `getFieldValue(props, field)` 工具函数（新建 `frontend/src/renderer/utils/fieldValue.ts`）：`props[field]` → 嵌套 `props.properties?.[field]` → `props.attributes?.[field]` → undefined（兼容 GeoDataLayer 嵌套结构与 MapInfoLayer 扁平结构；`_getLabelContent` 改为复用此函数）
- 类型检测 / 唯一值提取 / 渲染取值全部走此函数

#### OnlineMap.tsx
- `OnlineMapRef` 新增 `setLayerThematicSettings(fileId, settings | null)`（分发到 GeoDataLayerManager / mapInfoLayerRefsRef，同 setLayerColorSettings 模式）
- **创建时恢复顺序（B2，必须固定）**：两条创建路径（GeoDataLayer L2805 / MapInfoLayer L2935）在 `setStyleOverrides(savedColor)` **之后**执行 `setThematicOverrides(savedThematic)`，确保刷新/切页后专题优先
- 恢复时从 `useMapStore.getState().mapSettings.thematicSettingsMap` 读取

#### MapPage.tsx
- 新增 `handleThematicSettingsChange(node, settings | null)`：同 handleColorSettingsChange 链路（setThematicSettingsMap 本地 + storeSetThematicSettings + onlineMapRef.setLayerThematicSettings + 强制显示图层）
- `LayerControl` 新增 prop `onThematicSettingsChange` + `thematicSettingsMap` 透传

### 5. 字段值样本提取（S2：cache-first，不开新请求）

打开弹窗进入专题页时，取样本值用于类型检测/推荐区间/唯一值列表：
- MapInfo 图层：优先 `useMapDataCacheStore.layers[layerId]?.geojson.features`（prefetch 已有）；冷缓存才回退 `layerApi.getLayerData`
- Excel 点文件：优先 `pointFileData[fileId]` / `prefetchedExcelDataRef`；回退现有 `dataApi.get` 流程（LayerControl 取字段的 async 流程顺带提取样本）
- 取前 500 条样本足够（类型检测/唯一值统计/推荐区间用）

### 6. 图例框（ThematicLegend.tsx，挂 MapPage，参照 PCILegend 先例）

- 新组件 `ThematicLegend.tsx`（样式仿 PCILegend：absolute 悬浮框）
- **挂载位置：MapPage 地图容器内、与 OnlineMap 平级**（符合现有图例模式，不把专题逻辑塞进 4 页面共用的 OnlineMap）
- 数据来源：`layerFiles`/`pointFiles` 的 visible + `mapSettings.thematicSettingsMap`（MapPage 已有响应式订阅）
- 渲染：每个**已勾选可见**且启用专题的图层一个图例块：图层名 + 色块列表（数值：`min~max`；文本：值；含"其他"灰块；空值/未匹配条目）
- 无启用专题的可见图层时隐藏

### 7. i18n

`locales/zh.json` + `en.json` 同步新增：专题图层、启用专题图层、属性字段、字段类型、推荐默认区间、添加区间、图形大小、基础配置、专题图层激活中提示、其他等。

## Files to modify

| 文件 | 改动 |
|------|------|
| `frontend/src/renderer/components/Map/LabelSettingsModal.tsx` | 类型定义 + showThematicTab prop + color tab 两子页 + 滚动 |
| `frontend/src/renderer/components/Map/LayerControl.tsx` | gate 条件、样本提取（cache-first）、onThematicSettingsChange 接线 |
| `frontend/src/renderer/components/Map/MapInfoLayer.tsx` | `thematicSettings` 字段 + style/pointToLayer 并入 + `setThematicOverrides` |
| `frontend/src/renderer/components/Map/GeoDataLayer.tsx` | `thematicSettings` 字段 + `_thematicStyleFor` + `setThematicOverrides` |
| `frontend/src/renderer/components/Map/OnlineMap.tsx` | `setLayerThematicSettings` + 创建时恢复（顺序固定） |
| `frontend/src/renderer/components/Map/ThematicLegend.tsx` | 新增图例组件 |
| `frontend/src/renderer/pages/MapPage.tsx` | `handleThematicSettingsChange` + ThematicLegend 挂载 |
| `frontend/src/renderer/store/mapStore.ts` | `thematicSettingsMap` 持久化 |
| `frontend/src/renderer/utils/fieldValue.ts` | 新增：共用字段取值函数 |
| `frontend/src/renderer/locales/zh.json` / `en.json` | 新 key |

## Reuse

- `fieldOptionsCacheRef` / `fetchLayerFileFieldOptions` / Excel 字段提取流程（LayerControl.tsx）
- `setStyleOverrides` 全量重渲染机制（GeoDataLayer `_reRenderGeometries`、MapInfoLayer eachLayer 重应用）
- `useMapDataCacheStore`（MapInfo GeoJSON 缓存）、`pointFileData` / `prefetchedExcelDataRef`
- `PCILegend.tsx` 悬浮图例样式
- `mapStore` persist/merge 模式（colorSettingsMap 同款）
- `ColorField` 颜色选择器（LabelSettingsModal 内部）

## 设计决策（专家审查后定稿）

| 决策点 | 方案 |
|--------|------|
| 互斥实现层 | 样式管线层：thematic 优先、base 次之，单一入口（B3） |
| 专题样式与 resetStyle | 并入 style/pointToLayer 源头，resetStyle 天然带专题色（B1） |
| 创建恢复顺序 | 基础色 → 专题色，固定顺序（B2） |
| 支持范围 | 仅 `layer-file`（图层文件 + 地理化数据）；sector-layer / decoration-layer 不显示专题页（S1） |
| 样本来源 | cache-first，冷缓存才回退 API（S2） |
| 取值函数 | 抽共用 `getFieldValue`，检测/渲染同源（S3） |
| 空值/非法值 | 排除空白后再判数值；未匹配/空值渲染为灰色 `#9ca3af`（S4） |
| 字段切换 | 重置 ranges/categories（S5） |
| 区间重叠/缺口 | 重叠取首个匹配（按列表顺序）；缺口落灰；不做强制重排（S6） |
| 图层删除 | 配置残留（与现有 colorSettingsMap 行为一致）（S7） |
| 文本值 >20 | 前 20 + "其他"灰显，图例含"其他"灰块（O4） |
| 图形大小 | 统一滑块（数值类页面），仅点要素半径生效；扇区不调大小（O5） |

## Steps

- [x] 1. `getFieldValue` 工具 + mapStore `thematicSettingsMap` 持久化
- [x] 2. LabelSettingsModal：类型 + showThematicTab + color tab 两子页（开关/字段下拉/区间编辑/文本配色/推荐区间/图形大小）+ 滚动
- [x] 3. LayerControl：gate 条件 + cache-first 样本提取 + 弹窗接线
- [x] 4. GeoDataLayer `setThematicOverrides` + `_thematicStyleFor`
- [x] 5. MapInfoLayer `setThematicOverrides` + style/pointToLayer 并入
- [x] 6. OnlineMap `setLayerThematicSettings` + 创建恢复（顺序）
- [x] 7. ThematicLegend + MapPage 接线挂载
- [x] 8. i18n 双语言
- [x] 9. 联调验证

## Verification

- `npm run type-check` / `npm run lint` 通过
- 手动验证（Web 模式 `npm run dev:web` + 后端）：
  - 数值字段：推荐区间 → 保存 → 地图按区间着色；改阈值/颜色即时生效；空值灰显；区间连续无遗漏
  - 文本字段：唯一值列表配色 → 保存生效；>20 值截断为"其他"
  - 互斥：启用专题后基础配置不生效；关闭后恢复基础配置
  - 框选高亮清除后专题色不丢（B1 回归）
  - 刷新页面后专题配置保持且渲染正确（B2 回归）
  - 图例框随图层勾选/取消实时增减；多图层图例堆叠
  - 扇区图层/装饰图层右键无专题页

## Open Questions（已给默认方案，可推翻）

1. 图形大小：统一滑块、仅点要素生效（默认）——还是每个区间单独设置大小？
2. 文本字段唯一值 >20：前 20 + "其他"灰显（默认）——还是全部列出？
3. 图例框位置：MapPage 右下/右上（仿 PCILegend 右上）——具体角位偏好？
