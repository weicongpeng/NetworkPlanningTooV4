# Frontend Worker Task - Geographic Data Rendering

## Task Overview
修复前端地理化数据渲染问题。

## Project Path
`d:\mycode\NetworkPlanningTooV3`

## Files to Modify

### 1. `frontend/src/renderer/components/Map/GeoDataLayer.tsx`

#### Issue 1: 点状渲染半径错误
- **当前问题**: 点状渲染半径是 6 米
- **修复要求**: 应该是 10 米
- **修改位置**: 第48行

**当前代码**:
```typescript
const DEFAULT_POINT_STYLE = {
  radius: 6,
  fillColor: '#ffffff',
  color: '#000000',
  weight: 2,
  opacity: 1,
  fillOpacity: 1
}
```

**修改为**:
```typescript
const DEFAULT_POINT_STYLE = {
  radius: 10,
  fillColor: '#ffffff',
  color: '#000000',
  weight: 2,
  opacity: 1,
  fillOpacity: 1
}
```

#### Issue 2: 扇形渲染使用数据中的 beamwidth
- **当前问题**: 扇形渲染使用数据中的 `beamwidth`（第210行），但要求应该是固定的 45 度
- **修复要求**: 扇形使用固定的 45 度扇形，方向以方位角为中心
- **修改位置**: `_renderSectors()` 方法

**找到以下代码**（约第224-231行）:
```typescript
} else {
  // 室外小区且高缩放级别 → 扇形
  // 半径根据缩放级别调整
  const baseRadius = 50 // 米
  const radius = baseRadius * Math.pow(2, Math.max(0, this.currentZoom - 12))

  const points = createSectorPolygon(displayLat, displayLng, azimuth, beamwidth, radius)
```

**修改为**:
```typescript
} else {
  // 室外小区且高缩放级别 → 扇形
  // 固定45度扇形，半径20米
  const SECTOR_BEAMWIDTH = 45 // 固定45度扇形
  const SECTOR_RADIUS = 20 // 米

  const points = createSectorPolygon(displayLat, displayLng, azimuth, SECTOR_BEAMWIDTH, SECTOR_RADIUS)
```

**同时删除** `const beamwidth = item.beamwidth || 65;` 这一行（在第210行附近）

#### Issue 3: 扇形方向计算可能有问题
- **当前问题**: 方位角应该以中心朝向，需要正确计算
- **修复要求**: 以方位角为中心向两侧各 22.5 度（即固定 45 度扇形）
- **修改位置**: `createSectorPolygon()` 函数

**找到以下代码**（约第78-104行）:
```typescript
function createSectorPolygon(
  lat: number,
  lng: number,
  azimuth: number,
  beamwidth: number,
  radius: number
): L.LatLngExpression[] {
  const beamRad = (beamwidth / 2) * (Math.PI / 180)
  const aziRad = (azimuth - 90) * (Math.PI / 180)
```

**修改为**:
```typescript
function createSectorPolygon(
  lat: number,
  lng: number,
  azimuth: number,
  beamwidth: number,
  radiusMeters: number
): L.LatLngExpression[] {
  // 将米转换为经纬度距离
  // 1度纬度 ≈ 111,320 米
  // 1度经度 ≈ 111,320 * cos(纬度) 米
  const latDeg = radiusMeters / 111320
  const lngDeg = radiusMeters / (111320 * Math.cos(lat * Math.PI / 180))

  const beamRad = (beamwidth / 2) * (Math.PI / 180)
  // 方位角是以正北为0度，顺时针增加
  // 转换为数学角度（以东为0度，逆时针增加）
  const aziRad = (azimuth - 90) * (Math.PI / 180)

  // 计算扇形边界点
  const points: L.LatLngExpression[] = [[lat, lng]]

  const startAngle = aziRad - beamRad
  const endAngle = aziRad + beamRad
  const numPoints = Math.max(6, Math.ceil(beamwidth / 5)) // 每5度一个点，最少6个

  for (let i = 0; i <= numPoints; i++) {
    const angle = startAngle + (endAngle - startAngle) * (i / numPoints)
    const x = lng + lngDeg * Math.cos(angle)
    const y = lat + latDeg * Math.sin(angle)
    points.push([y, x])
  }

  points.push([lat, lng]) // 闭合
  return points
}
```

#### Issue 4: LOD策略调整（可选）
- **当前问题**: LOD_THRESHOLD 是 9，可能需要调整
- **修复要求**: 确保在高缩放级别时显示扇形，低缩放级别显示圆点
- **检查并确认**: 第213-224行的LOD逻辑

## Verification Checklist

1. [ ] 点状渲染半径改为 10 米
2. [ ] 扇形渲染使用固定 45 度 beamwidth
3. [ ] 扇形半径固定为 20 米
4. [ ] 扇形方向以方位角为中心
5. [ ] 坐标转换正确（米转换为经纬度）

## Implementation Notes

1. 保持其他功能不变（点击事件、标签显示等）
2. 确保样式统一（白色填充黑边框）
3. 测试验证修改后的功能

## Testing Steps

1. 导入点状数据文件 - 验证显示 10 米半径的圆点
2. 导入扇形数据文件（方位角为弧度） - 验证显示 45 度扇形
3. 导入多边形数据文件（WKT 格式） - 验证正确绘制多边形边界
