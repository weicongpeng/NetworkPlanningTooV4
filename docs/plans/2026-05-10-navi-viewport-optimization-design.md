# 导航视图优化设计文档

## 日期
2026-05-10

## 背景
当前导航功能存在两个视图问题：
1. 路线规划完成后，地图视图范围可能过大或过小，无法最佳展示起点到终点的完整路线
2. 导航过程中地图 zoom 值不合理，用户难以看清近端路线细节

## 需求

### 需求1：规划路线完成展示完整视图
- 路线规划完成后，地图应展示起点到终点的完整路线
- 视图范围应根据实际路线距离动态匹配 zoom 值
- 确保起点和终点都在可视区域内

### 需求2：导航过程视图优化
- 导航开始后，切换到用户当前位置附近视图
- 默认 zoom = 18（固定值，不再根据剩余距离动态变化）
- 支持用户手动缩放/拖拽地图
- 用户手动操作后，3秒自动恢复到当前位置 + zoom=18

## 方案设计

### 阶段1：规划路线视图（已有基础，优化调整）

**当前实现**：`fitRouteBounds` 已根据 `totalDistance` 动态调整 zoom

**优化点**：
- 保持 `fitRouteBounds` 逻辑不变（已优化过 zoom 值）
- 确保路线预览和导航开始前的视图都调用 `fitRouteBounds`

### 阶段2：导航中视图（核心改造）

**当前实现**：
- `startAutoFit` 启用 auto-fit，5秒无操作后恢复视图
- 恢复时使用 `getNavZoom` 根据剩余距离动态计算 zoom
- 位置更新时调用 `startAutoFit()` 重新计时

**改造方案**：

#### MapView (WebView JS层)
1. **新增 `_navDefaultZoom = 18`** 常量
2. **修改 `startAutoFitTimer`**：
   - 恢复视图时固定使用 `_navDefaultZoom` (18)
   - 超时时间从 5秒 改为 **3秒**
   - 中心点始终跟随 `_currentUserPos`（用户当前位置）
3. **保留用户交互检测**：
   - `dragstart` / `zoomstart` 时清除计时器
   - `dragend` / `zoomend` 时重新启动 3秒计时器
   - 通过 `_programmaticMove` 标记区分程序移动和用户操作

#### NavigationPanel (React Native层)
1. **移除 `moveCamera` 调用**：导航开始后不再主动移动相机到起点
2. **保留 `startAutoFit()` 调用**：导航开始时启用 auto-fit
3. **位置更新时**：继续调用 `startAutoFit()` 重置计时器

#### 状态流转
```
路线规划完成 → fitRouteBounds(完整路线视图)
     ↓
点击开始导航 → startAutoFit() 启用跟随
     ↓
位置更新 → updateUserLocation() + startAutoFit() 重置3秒计时
     ↓
用户手动缩放/拖拽 → 清除计时器 → 操作结束 → 3秒后恢复 zoom=18 + 当前位置
     ↓
导航结束 → stopAutoFit() + clearRoute()
```

## 接口变更

### MapViewRef 不变
现有接口已满足需求：
- `startAutoFit()` / `stopAutoFit()` - 控制跟随模式
- `updateUserLocation()` - 更新用户位置
- `fitRouteBounds()` - 完整路线视图

### WebView JS层变更
- `startAutoFitTimer`：超时 5s → 3s，zoom 固定 18
- 移除 `getNavZoom` 动态计算（或保留但不使用）
- 移除 `_navRemainingDistance` 相关逻辑

## 文件变更清单

1. **MapView.tsx** - WebView JS层：修改 auto-fit 逻辑
2. **NavigationPanel.tsx** - 移除导航开始时的 moveCamera 调用

## 测试验证

1. 路线规划完成后，地图显示完整路线（起点终点都在可视区）
2. 点击开始导航后，地图切换到当前位置附近，zoom=18
3. 用户双指缩放地图后，3秒内无操作自动恢复到当前位置+zoom=18
4. 用户拖拽地图后，3秒内无操作自动恢复
5. 导航过程中位置更新时，地图跟随用户移动
