# 地图工具修复设计

日期: 2026-08-04
分支: layer-tools

## 背景

地图工具模块存在三个关联 bug，均位于 `frontend/src/renderer/components/Map/OnlineMap.tsx`：

1. **框选图形切页后无法清除**：使用"选择"工具框选后，切换到其他页面再切回地图，点击"清除"无法移除框选轨迹（需切回测量绘制窗口轨迹才消失或按清除键）
2. **测量删除按钮残余轨迹**：测距后点击结束点的删除按钮，未完全清除，结束点附近有残余轨迹
3. **双击结束测量出现两个总长标签**：测距到结束点双击结束测量后，结束点出现两次同样的测量结果

## 根因分析

### Bug 1 — 框选图形切页后无法清除

页面切换时的地图缓存清理区（`OnlineMap.tsx:3195-3217`）清理了测量痕迹（`measurementLinesRef`/`measurementMarkersRef`/`shadowLineRef`）和搜索标记，但**遗漏了框选图形**（`selectionShapeRef`/`selectionRectRef`/`polygonTempLayerRef`/`dragPreviewRectRef`/`dragPreviewCircleRef`）。

组件卸载时 ref 被重置为 null，但 Leaflet 图形是图层，仍留在缓存的 map 实例（`__sharedMapCache.map`）上。切回时 ref 为 null，点"清除"调用 `clearSelectionHighlight()`（1341 行）遍历 null ref，无法移除残留图形。

### Bug 2 — 测量删除按钮残余轨迹

双击结束测量时，Leaflet 会触发两次 `click`，每次 click 都 `push` 一条 polyline（1951-1961）。双击第二次 click 产生的线含重复点 `[pt1, pt2, pt2]`。

`finishMeasurement`（1976-2144）的去重块（1987-1999）只 pop 掉 `points` 数组的重复点和对应的 marker/label，但**没有移除含重复点的 polyline**。其后的线清理（2022-2033）只保留最后一条线——这条含重复点的线被保留 → 结束点附近残余轨迹。

### Bug 3 — 双击后两个总长标签

用户已确认双击结束测量后测距模式**保持激活**（便于连续测量）。在此前提下，双击结束测量后若再次点击/双击（误触或习惯性连续操作），会在同一位置生成第二条几乎重叠的测量 → 两个总长标签。

`finishMeasurement` 内部不调用 `onMeasureModeEnd`，测量模式不退出，重复触发的窗口长期存在。且去重依赖坐标**精确相等**（1991 行 `p1.lat === p2.lat && p1.lng === p2.lng`），浏览器事件坐标微抖会导致去重失效。

## 修复方案

### Bug 1 — 缓存清理时同时移除框选图形

在缓存清理区（`OnlineMap.tsx:3195-3217`）补充框选图形的清理，与测量痕迹一致：

```typescript
// 5. 清理框选图形（圆形/多边形/矩形框选、拖拽预览），避免跨页面残留且无法清除
[selectionShapeRef, selectionRectRef, polygonTempLayerRef, dragPreviewRectRef, dragPreviewCircleRef].forEach(ref => {
  try { if (ref.current) map.removeLayer(ref.current) } catch (e) { /* ignore */ }
  ref.current = null
})
selectionStartPointRef.current = null
selectionPointsRef.current = []
selectionDrawingRef.current = false
pointModeIsDragging.current = false
```

### Bug 2 — 双击去重时同步清理重复线 + 源头去抖

**改 1**：`finishMeasurement` 去重块（1987-1999）检测到重复点时，同步移除最后一条含重复点的线：

```typescript
if (points.length >= 2) {
  const p1 = points[points.length - 1]
  const p2 = points[points.length - 2]
  if (p1.lat === p2.lat && p1.lng === p2.lng) {
    points.pop()
    // 移除重复点产生的冗余 label 和 marker
    const redundantLabel = measurementMarkersRef.current.pop()
    if (redundantLabel) map.removeLayer(redundantLabel)
    const redundantMarker = measurementMarkersRef.current.pop()
    if (redundantMarker) map.removeLayer(redundantMarker)
    // 移除最后一条含重复点的线（它包含重复顶点）
    const redundantLine = measurementLinesRef.current.pop()
    if (redundantLine) map.removeLayer(redundantLine)
  }
}
```

**改 2**：`handleMapClick` 源头去抖（在 1905 行后）：新点与最后一个点坐标差小于阈值则丢弃，从源头防止重复点产生。

### Bug 3 — finishMeasurement 时间戳防抖

新增 ref `measurementFinishTimeRef`，`finishMeasurement` 开头检查 500ms 内重复调用则忽略。

## 验证

- Bug 1: 框选后切页→切回→地图无残留图形；点"清除"无报错
- Bug 2: 双击结束测量→删除按钮→无残余轨迹
- Bug 3: 快速双击结束测量→只有一个总长标签；测量模式仍激活可继续下一段

## 影响范围

仅 `frontend/src/renderer/components/Map/OnlineMap.tsx`，约 30 行改动，无后端/类型改动。
