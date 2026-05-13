# 移动APP导航体验优化设计文档

**日期**: 2026-05-08
**目标**: 优化移动APP的导航标记样式、导航模式UI控制和路线方向指示

---

## 1. 导航定位标记样式统一

### 1.1 问题描述
当前APP中存在多种标记样式,视觉不一致:
- 目的地标记: 红色水滴SVG图标 + 白色背景名称标签
- 打点标记: 红色圆点 + 红色半透明背景标签
- 搜索定位标记: 红色圆点 + 红色半透明背景标签

同时,从工参、打点、搜索等外部来源获取的WGS84经纬度可能未正确转换为高德适配的GCJ-02坐标,导致定位偏移。

### 1.2 设计方案

#### 标记样式
所有标记统一为:
- **小圆点**: 8px半径,红色填充(#E53935),白色描边2px
- **文字标签**: 圆点正上方直接显示黑色文字,不带背景框,字号12px,加粗

#### 坐标转换
确保以下场景的坐标转换正确:
1. **目的地标记** (`showDestinationMarker`): 接收GCJ-02坐标,直接使用
2. **打点标记** (`updateMarkers`): 存储为WGS84,显示前转换为GCJ-02
3. **搜索定位标记** (`updateSearchMarker`): 
   - place模式(高德POI): 返回GCJ-02,直接使用
   - coordinate模式(用户输入WGS84): 转换为GCJ-02后使用
   - parameter模式(后端返回WGS84): 转换为GCJ-02后使用
4. **TAB/地理化图层**: 后端已预处理为GCJ-02,无需转换

#### 实现位置
- `mobile-app/src/components/Map/MapView.tsx`: HTML模板中的标记渲染逻辑
  - `showDestinationMarker` 函数: 修改目的地标记样式
  - `updateMarkers` 函数: 修改打点标记标签样式
  - `updateSearchMarker` 函数: 修改搜索标记标签样式

---

## 2. 导航模式下隐藏UI控件

### 2.1 问题描述
当前导航模式下,以下UI控件仍然可见,影响导航体验:
- 搜索框及"地点""小区""坐标"模式切换
- 底部工具栏:"测距""清除""图层""打点""卫星"按钮
- 移动地图按钮(📍定位按钮)
- 图层子菜单

### 2.2 设计方案

#### 隐藏逻辑
- 导航开始时(`startNavigation`),`navUiHidden`设为`true`
- 导航结束(`stopNavigation`)或到达目的地自动结束时,`navUiHidden`恢复为`false`
- `navUiHidden`已在`mapStore`中定义,只需正确使用

#### 需要隐藏的控件
1. **搜索栏区域** (`renderSearchBar()` + 工具栏): 已有`{!navUiHidden && ...}`条件包裹
2. **移动地图按钮** (📍): 新增条件`{!navUiHidden && ...}`
3. **测距控件** (`MeasureControl`): 已有内部隐藏逻辑,无需修改
4. **打点列表** (`MarkerList`): 已有内部隐藏逻辑,无需修改
5. **扇区信息面板** (`SectorInfoPanel`): 已有内部隐藏逻辑,无需修改

#### 实现位置
- `mobile-app/app/(tabs)/index.tsx`: 主页面渲染逻辑
  - 移动地图按钮添加`{!navUiHidden && ...}`条件
  - 确认搜索栏区域已正确隐藏(已有逻辑,验证即可)

---

## 3. 导航路线方向箭头标记

### 3.1 问题描述
当前导航路线仅显示为蓝色实线,缺乏方向指示,用户难以直观判断行进方向。

### 3.2 设计方案

#### 箭头放置策略
- 每隔约**200米**放置一个">"方向标记
- 箭头根据路线走向自动旋转,始终指向行进方向

#### 技术实现
在高德地图JS API中,通过以下方式实现:

1. **计算箭头位置**: 沿路线polyline累积计算距离,每隔约200米取一个点
2. **计算箭头方向**: 使用当前点和下一个点的坐标计算方位角
3. **创建箭头标记**: 使用`AMap.Marker`配合自定义content(旋转的">"文字或SVG)
4. **统一管理**: 箭头标记存入routeOverlayGroup,在`clearRoute`时一并清除

#### 实现位置
- `mobile-app/src/components/Map/MapView.tsx`: HTML模板
  - `addRoute` 函数: 添加箭头标记计算和渲染逻辑
  - `clearRoute` 函数: 确保清除箭头标记
  - 新增辅助函数:
    - `calculateArrowPositions(polyline, interval)`: 计算箭头位置数组
    - `getBearing(point1, point2)`: 计算两点间方位角(已有类似函数)

---

## 4. 影响范围总结

### 修改文件
| 文件 | 修改内容 |
|------|----------|
| `mobile-app/src/components/Map/MapView.tsx` | 标记样式统一、路线箭头标记 |
| `mobile-app/app/(tabs)/index.tsx` | 导航模式UI隐藏逻辑 |

### 不需要修改的文件
- `navigationService.ts`: 导航状态管理已完善
- `coordinate.ts`: 坐标转换函数已存在
- `mapStore.ts`: navUiHidden状态已存在
- `NavigationPanel.tsx`: 导航面板本身无需修改
