# Tasks

- [x] Task 1: 小区搜索结果自动弹出 SectorInfoPanel
  - [x] SubTask 1.1: 在 `app/(tabs)/index.tsx` 的 `handleResultSelect` 中,为 `parameter` 模式分支追加:根据 `result.sectorId` 在 `lteSectors + nrSectors` 中查找对应 `SectorData`,调用 `setSelectedSector(sector)` 弹出属性面板
  - [x] SubTask 1.2: 调整 `NavControl` 渲染条件:通过在 `parameter` 分支不再调用 `setSelectedLocation` 来抑制 `NavControl` 显示(因为 NavControl 渲染条件依赖 selectedLocation);地点/坐标/打点/重叠扇区场景下 `NavControl` 行为不变
- [x] Task 2: SectorInfoPanel 新增"收藏"按钮
  - [x] SubTask 2.1: 在 `src/components/Map/SectorInfoPanel.tsx` 底部 `buttonRow` 中新增"收藏"按钮(排在"导航"之后),按钮样式与现有按钮一致
  - [x] SubTask 2.2: 实现收藏逻辑:`selectedSector.latitude/longitude`(已是 WGS84)直接用于比较/存储;`favorites.some(...)` 判断已收藏(容差 0.00001);点击调用 `addFavorite` 或 `removeFavorite`;按钮文案在"收藏"/"已收藏"间切换,配色橙系 `#FF9500`/灰系 `#888`
- [x] Task 3: SectorInfoPanel 新增"搜索"按钮与属性模糊搜索
  - [x] SubTask 3.1: 在 `buttonRow` 末尾新增"搜索"按钮(蓝色系 `#007AFF`)
  - [x] SubTask 3.2: 实现点击"搜索"按钮弹出输入框(条件渲染在 buttonRow 上方)
  - [x] SubTask 3.3: 实现模糊匹配逻辑:遍历 `lteSectors + nrSectors` 的所有字段(含 `extraFields`),大小写不敏感子串匹配,`slice(0, 30)`
  - [x] SubTask 3.4: 渲染结果列表(FlatList, maxHeight 200),展示扇区名 + 关键属性摘要;无匹配显示"无匹配结果"
  - [x] SubTask 3.5: 选中结果:`setSelectedSector(sector)` + `setFocusLocation({ lat, lng })`(WGS84→GCJ02)跳转地图,关闭搜索区
- [x] Task 4: 深色模式适配与 UI 一致性校验
  - [x] SubTask 4.1: `LIGHT_COLORS`/`DARK_COLORS` 均新增 6 个 attr* 字段,深色主题下颜色正确
  - [x] SubTask 4.2: 4 个按钮(复制 | 导航 | 收藏 | 搜索)在 `buttonRow` 中等宽排列(`flex:1` + `gap:8`)
  - [x] SubTask 4.3: 属性搜索输入框与结果列表在浅色/深色主题下颜色均正确

# Task Dependencies

- Task 2、Task 3 依赖 Task 1 完成(因为 Task 1 决定了 `SectorInfoPanel` 的弹出时机)
- Task 4 依赖 Task 2、Task 3 完成后统一做主题适配与一致性校验
- Task 2 与 Task 3 之间无强依赖,可并行实现
