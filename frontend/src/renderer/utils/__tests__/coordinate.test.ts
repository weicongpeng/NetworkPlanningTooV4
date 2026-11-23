import { describe, it, expect } from 'vitest'
import { CoordinateTransformer, calculateDistance } from '../coordinate'

describe('CoordinateTransformer GCJ02/WGS84 往返精度', () => {
  // 截图场景及若干国内城市点：搜索定位走正向 wgs84ToGcj02，
  // 提取坐标走逆向 gcj02ToWgs84，两者必须严格互逆，否则同一坐标落点差约 2 米。
  const points: Array<[number, number]> = [
    [23.846863, 114.808300], // 截图点
    [39.962734, 116.305134], // 北京
    [31.230416, 121.473701], // 上海
    [23.129163, 113.264435], // 广州
    [30.572815, 104.066801], // 成都
  ]

  it('单点往返应恢复到原始 WGS84（误差 < 0.1 毫米）', () => {
    for (const [wgsLat, wgsLng] of points) {
      const [gcjLat, gcjLng] = CoordinateTransformer.wgs84ToGcj02(wgsLat, wgsLng)
      const [backLat, backLng] = CoordinateTransformer.gcj02ToWgs84(gcjLat, gcjLng)
      // 0.1 毫米 ≈ 1e-9 度
      expect(Math.abs(backLat - wgsLat)).toBeLessThan(1e-9)
      expect(Math.abs(backLng - wgsLng)).toBeLessThan(1e-9)
    }
  })

  it('批量逆向与单点逆向结果一致', () => {
    const gcj = points.map(([lat, lng]) => CoordinateTransformer.wgs84ToGcj02(lat, lng))
    const batch = CoordinateTransformer.batchGcj02ToWgs84Optimized(gcj)
    for (let i = 0; i < points.length; i++) {
      const [singleLat, singleLng] = CoordinateTransformer.gcj02ToWgs84(gcj[i][0], gcj[i][1])
      expect(batch[i][0]).toBeCloseTo(singleLat, 12)
      expect(batch[i][1]).toBeCloseTo(singleLng, 12)
      expect(Math.abs(batch[i][0] - points[i][0])).toBeLessThan(1e-9)
      expect(Math.abs(batch[i][1] - points[i][1])).toBeLessThan(1e-9)
    }
  })

  it('搜索定位与提取坐标两条链路落点一致（同一 WGS84 输入）', () => {
    const [wgsLat, wgsLng] = [23.846863, 114.808300]
    // 搜索定位：WGS84 → GCJ02 → 落图
    const [searchLat, searchLng] = CoordinateTransformer.wgs84ToGcj02(wgsLat, wgsLng)
    // 提取坐标：点击落图点(GCJ02) → 反算 WGS84 → 再次正向落图
    const [shownLat, shownLng] = CoordinateTransformer.gcj02ToWgs84(searchLat, searchLng)
    const [replotLat, replotLng] = CoordinateTransformer.wgs84ToGcj02(shownLat, shownLng)
    // 两次落图的物理距离应远小于 1 米
    expect(calculateDistance(searchLat, searchLng, replotLat, replotLng)).toBeLessThan(0.001)
  })

  it('境外坐标不做转换', () => {
    const outside: [number, number] = [35.689487, 139.691706] // 东京
    expect(CoordinateTransformer.wgs84ToGcj02(outside[0], outside[1])).toEqual(outside)
    expect(CoordinateTransformer.gcj02ToWgs84(outside[0], outside[1])).toEqual(outside)
  })
})
