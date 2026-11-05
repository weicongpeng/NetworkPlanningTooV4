# 优化小区搜索 UI 逻辑 Spec

## Why

当前小区搜索结果选中后,会同时弹出两个底栏:一是 `NavControl`(显示"收藏"和"导航到这里"),二是地图上的 `SectorInfoPanel` 仅在点击扇区图形时才出现。这种交互割裂——用户搜索小区后,需要再点开属性才能查看完整工参,而收藏入口与属性信息分离在两处,体验不连贯。

本次优化将"小区搜索 → 定位 → 查看属性 → 收藏/二次搜索"整合到 `SectorInfoPanel` 内,使属性面板成为小区搜索后的统一操作入口,提升工作流一致性。

## What Changes

- **小区搜索结果选中后,不再显示底部 `NavControl`(收藏/导航到这里 标签)**:仅 `parameter`(小区)模式受影响,`place`(地点)与 `coordinate`(坐标)模式行为不变
- **小区搜索结果选中后,自动弹出 `SectorInfoPanel`**:在跳转地图定位的同时,根据 `result.sectorId` 查找对应的 `SectorData` 并 `setSelectedSector()`,触发属性面板
- **`SectorInfoPanel` 底部新增两个按钮:"收藏" 与 "搜索"**:保留现有"复制"和"导航"按钮不动(未提及不调整),最终底部按钮区为:复制 | 导航 | 收藏 | 搜索
- **新增"收藏"按钮逻辑**:复用现有 `NavControl` 中的收藏实现(基于 `selectedSector.latitude/longitude` 经 `gcj02ToWgs84` 转换后写入 `favorites`,重复点击切换收藏/取消)
- **新增"搜索"按钮逻辑**:点击后在属性面板顶部展开输入框,用户输入关键字(如 "PCI"、"TAC"、"室内")对**当前属性框中显示的属性字段**做模糊过滤——匹配属性名(如"PCI"、"覆盖类型")或属性值;ScrollView 实时只显示匹配的字段,无匹配时显示"无匹配属性";关闭搜索或清空关键字后恢复显示全部属性
- **UI 风格一致性**:新增按钮的视觉风格(配色、圆角、字号、间距)与现有"复制/导航"按钮完全一致;浅色/深色主题均支持

## Impact

- **Affected specs**: 无既定 spec,本次为新增
- **Affected code**:
  - `app/(tabs)/index.tsx` — `handleResultSelect` 中 `parameter` 分支需追加 `setSelectedSector()`;`NavControl` 渲染条件需排除小区搜索结果场景
  - `src/components/Map/SectorInfoPanel.tsx` — 新增"收藏"和"搜索"按钮及相关交互逻辑(属性字段过滤输入框 + ScrollView 过滤渲染)
  - `src/components/Search/SearchBar.tsx` — 无需修改(地点/坐标搜索行为不变)
  - `src/components/Navigation/NavControl.tsx` — 无需修改(仅渲染条件由父组件控制)
  - `src/store/mapStore.ts` — 无需修改(已有 `setSelectedSector`、`addFavorite`、`removeFavorite`、`lteSectors`、`nrSectors`)

## ADDED Requirements

### Requirement: 小区搜索后自动弹出属性面板

系统 SHALL 在小区(`parameter`)模式搜索结果被选中后,除了跳转地图定位外,同时自动弹出对应扇区的 `SectorInfoPanel`。

#### Scenario: 选中小区搜索结果
- **WHEN** 用户在小区模式下选中一条搜索结果
- **THEN** 地图移动到该扇区位置(GCJ-02 坐标,缩放级别 16)
- **AND** `SectorInfoPanel` 自动弹出,展示该扇区完整工参
- **AND** 底部 `NavControl`(收藏/导航到这里)不显示

#### Scenario: 地点或坐标搜索不受影响
- **WHEN** 用户在 `place` 或 `coordinate` 模式下选中搜索结果
- **THEN** 现有行为保持不变(显示 `NavControl`,不自动弹出 `SectorInfoPanel`)

### Requirement: SectorInfoPanel 底部新增"收藏"按钮

系统 SHALL 在 `SectorInfoPanel` 底部按钮区新增"收藏"按钮,与现有"复制"、"导航"按钮并排。

#### Scenario: 收藏当前扇区
- **WHEN** 用户点击"收藏"按钮且当前扇区位置未被收藏
- **THEN** 扇区的 WGS84 坐标(由 `gcj02ToWgs84` 转换得到)与扇区名称被写入 `favorites`
- **AND** 按钮文案变为"已收藏"

#### Scenario: 取消收藏
- **WHEN** 用户点击"已收藏"按钮
- **THEN** 系统从 `favorites` 中移除坐标匹配的收藏点
- **AND** 按钮文案恢复为"收藏"

#### Scenario: 收藏逻辑与 NavControl 一致
- **WHEN** 比较是否已收藏
- **THEN** 使用 WGS84 坐标进行匹配,容差 `0.00001` 度,与原 `NavControl` 实现一致

### Requirement: SectorInfoPanel 底部新增"搜索"按钮(属性字段过滤)

系统 SHALL 在 `SectorInfoPanel` 底部按钮区新增"搜索"按钮,点击后在面板顶部展开输入框,允许用户输入关键字对**当前属性框中的字段**做模糊过滤(而非搜索其他小区)。

#### Scenario: 打开属性过滤输入
- **WHEN** 用户点击"搜索"按钮
- **THEN** 在面板 header 下方展开输入框
- **AND** 输入框获得焦点(autoFocus)
- **AND** placeholder 提示"输入属性名或值过滤(如 PCI、TAC、室内)..."

#### Scenario: 实时过滤当前扇区属性
- **WHEN** 用户在输入框中输入关键字
- **THEN** 系统对当前 `selectedSector` 的全部属性字段(包括 `name`/`siteName`/`siteId`/`sectorId`/`vendor`/`pci`/`tac`/`azimuth`/`beamwidth`/`height`/`earfcn`/`ssbFrequency`/`frequency`/`mcc`/`mnc`/`is_shared`/`cell_cover_type`/纬度/经度/覆盖类型 以及 `extraFields` 中的所有键值)执行大小写不敏感的子串匹配
- **AND** 匹配同时作用于**属性名(label,如"PCI"、"覆盖类型")**和**属性值(value)**
- **AND** ScrollView 实时只显示匹配的字段,其余字段被隐藏

#### Scenario: 无匹配字段
- **WHEN** 用户输入的关键字在当前扇区属性中无任何匹配
- **THEN** ScrollView 区域显示"无匹配属性"提示

#### Scenario: 清空关键字或关闭搜索
- **WHEN** 用户点击输入框右侧 ×(清空关键字)
- **THEN** 关键字清空,ScrollView 恢复显示全部属性
- **WHEN** 用户点击"关闭"按钮
- **THEN** 关闭整个属性过滤输入区,关键字清空,ScrollView 恢复全部属性

#### Scenario: 再次点击搜索按钮切换
- **WHEN** 属性过滤输入区已展开,用户再次点击"搜索"按钮
- **THEN** 切换为收起状态(等同"关闭"行为)

### Requirement: UI 风格一致性

系统 SHALL 保持 `SectorInfoPanel` 底部按钮区的视觉一致性。

#### Scenario: 按钮样式
- **WHEN** 渲染"收藏"和"搜索"按钮
- **THEN** 按钮高度、圆角、内边距、字号、字重与现有"复制"、"导航"按钮一致
- **AND** 配色采用与现有按钮同体系的强调色(收藏使用橙系 `#FF9500` 与原 `NavControl` 一致;搜索使用蓝色系 `#007AFF` 与导航按钮同体系)
- **AND** 浅色/深色主题下文字与背景色均正确适配

#### Scenario: 按钮排列
- **WHEN** 底部按钮区渲染
- **THEN** 4 个按钮等宽并排(复制 | 导航 | 收藏 | 搜索),`gap: 8`,与现有 `buttonRow` 样式一致

## MODIFIED Requirements

### Requirement: NavControl 显示条件

`NavControl` 的渲染条件 SHALL 在小区搜索结果场景下不触发。

#### Scenario: 小区搜索后不显示 NavControl
- **WHEN** 用户通过小区搜索选中结果,`selectedLocation` 被设置
- **THEN** `NavControl` 不渲染(因为 `SectorInfoPanel` 已提供收藏与导航功能)

#### Scenario: 地图点击/打点/地点搜索/坐标搜索仍显示 NavControl
- **WHEN** `selectedLocation` 通过非小区搜索途径被设置(地图长按打点、重叠扇区弹窗、地点搜索、坐标搜索)
- **THEN** `NavControl` 正常渲染,行为不变

## REMOVED Requirements

无删除需求(现有功能均保留,仅调整触发场景)。
