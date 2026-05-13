/**
 * 坐标转换工具 - WGS84 (GPS) ↔ GCJ02 (高德/腾讯地图)
 *
 * 坐标系说明:
 * - WGS84: GPS原始坐标系，国际上通用的坐标系
 * - GCJ02: 火星坐标系，高德、腾讯等中国地图服务使用
 * - BD09: 百度坐标系，在GCJ02基础上再次加密
 *
 * 转换场景:
 * 1. GPS设备获取的坐标(WGS84) → 需要显示在高德地图 → 转换为GCJ02
 * 2. 高德API返回的坐标(GCJ02) → 需要存储为标准坐标 → 转换为WGS84
 * 3. 高德Place API搜索结果(GCJ02) → 存储或与其他数据对比 → 转换为WGS84
 */

/**
 * WGS84坐标
 */
export interface WGS84Coordinate {
  latitude: number
  longitude: number
}

/**
 * GCJ02坐标 (火星坐标系)
 */
export interface GCJ02Coordinate {
  latitude: number
  longitude: number
}

/**
 * 坐标转换器类
 */
export class CoordinateTransformer {
  // WGS84 转 GCJ02 的常数
  private static readonly X_PI = (Math.PI * 3000.0) / 180.0
  private static readonly A = 6378245.0 // 长半轴
  private static readonly EE = 0.00669342162296594323 // 扁率

  /**
   * 判断是否在中国境内（粗略判断）
   * 不在中国境内不需要转换
   */
  private static isInChina(lat: number, lng: number): boolean {
    return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271
  }

  /**
   * WGS84 转 GCJ02 变换算法
   */
  private static transformLat(x: number, y: number): number {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0
    ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0) / 3.0
    ret += ((160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0) / 3.0
    return ret
  }

  private static transformLon(x: number, y: number): number {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0
    ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0) / 3.0
    ret += ((150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0) / 3.0
    return ret
  }

  /**
   * 将 WGS84 坐标转换为 GCJ02 坐标
   *
   * 使用场景:
   * - GPS设备获取的坐标需要显示在高德地图上
   * - 标准WGS84坐标数据需要在地图上渲染
   *
   * @param wgsLat WGS84 纬度
   * @param wgsLng WGS84 经度
   * @returns GCJ02 坐标 [纬度, 经度]
   */
  static wgs84ToGcj02(wgsLat: number, wgsLng: number): [number, number] {
    // 不在中国境内不需要转换
    if (!this.isInChina(wgsLat, wgsLng)) {
      return [wgsLat, wgsLng]
    }

    let dLat = this.transformLat(wgsLng - 105.0, wgsLat - 35.0)
    let dLng = this.transformLon(wgsLng - 105.0, wgsLat - 35.0)
    const radLat = (wgsLat / 180.0) * Math.PI
    let magic = Math.sin(radLat)
    magic = 1 - this.EE * magic * magic
    const sqrtMagic = Math.sqrt(magic)
    dLat = (dLat * 180.0) / (((this.A * (1 - this.EE)) / (magic * sqrtMagic)) * Math.PI)
    dLng = (dLng * 180.0) / (this.A / sqrtMagic * Math.cos(radLat) * Math.PI)
    const mgLat = wgsLat + dLat
    const mgLng = wgsLng + dLng

    return [mgLat, mgLng]
  }

  /**
   * 将 GCJ02 坐标转换为 WGS84 坐标
   *
   * 使用场景:
   * - 高德API返回的坐标需要存储为标准坐标
   * - 高德Place API搜索结果需要与其他WGS84数据对比
   *
   * 注意: 这是近似算法，精度约1-2米
   *
   * @param gcjLat GCJ02 纬度
   * @param gcjLng GCJ02 经度
   * @returns WGS84 坐标 [纬度, 经度]
   */
  static gcj02ToWgs84(gcjLat: number, gcjLng: number): [number, number] {
    // 不在中国境内不需要转换
    if (!this.isInChina(gcjLat, gcjLng)) {
      return [gcjLat, gcjLng]
    }

    let dLat = this.transformLat(gcjLng - 105.0, gcjLat - 35.0)
    let dLng = this.transformLon(gcjLng - 105.0, gcjLat - 35.0)
    const radLat = (gcjLat / 180.0) * Math.PI
    let magic = Math.sin(radLat)
    magic = 1 - this.EE * magic * magic
    const sqrtMagic = Math.sqrt(magic)
    dLat = (dLat * 180.0) / (((this.A * (1 - this.EE)) / (magic * sqrtMagic)) * Math.PI)
    dLng = (dLng * 180.0) / (this.A / sqrtMagic * Math.cos(radLat) * Math.PI)
    const mgLat = gcjLat + dLat
    const mgLng = gcjLng + dLng

    // 逆向转换: WGS84 = GCJ02 - 偏移
    return [gcjLat * 2 - mgLat, gcjLng * 2 - mgLng]
  }

  /**
   * 批量转换 WGS84 坐标数组到 GCJ02
   *
   * @param coords WGS84坐标数组
   * @returns GCJ02坐标数组
   */
  static batchWgs84ToGcj02(coords: WGS84Coordinate[]): GCJ02Coordinate[] {
    return coords.map(coord => {
      const [lat, lng] = this.wgs84ToGcj02(coord.latitude, coord.longitude)
      return { latitude: lat, longitude: lng }
    })
  }

  /**
   * 🔥 性能优化版：批量 WGS84 转 GCJ02
   *
   * 使用场景: GeoJSON 图层加载时批量转换坐标
   *
   * @param coords 坐标数组 [[lat, lng], ...]
   * @returns 转换后的坐标数组 [[lat, lng], ...]
   *
   * 性能优势:
   * - 减少 is 检查开销（直接在数组上操作）
   * - 减少对象创建和销毁（直接操作基本类型数组）
   * - 可以被进一步优化（如 WebAssembly 或 Worker 线程）
   */
  static batchWgs84ToGcj02Optimized(coords: Array<[number, number]>): Array<[number, number]> {
    const results: Array<[number, number]> = new Array(coords.length)

    for (let i = 0; i < coords.length; i++) {
      const [wgsLat, wgsLng] = coords[i]

      // 不在中国境内不需要转换（提前退出，减少计算）
      if (!this.isInChina(wgsLat, wgsLng)) {
        results[i] = [wgsLat, wgsLng]
        continue
      }

      // WGS84 转 GCJ02 变换（内联以减少函数调用）
      let dLat = this.transformLat(wgsLng - 105.0, wgsLat - 35.0)
      let dLng = this.transformLon(wgsLng - 105.0, wgsLat - 35.0)
      const radLat = (wgsLat / 180.0) * Math.PI
      let magic = Math.sin(radLat)
      magic = 1 - this.EE * magic * magic
      const sqrtMagic = Math.sqrt(magic)
      dLat = (dLat * 180.0) / (((this.A * (1 - this.EE)) / (magic * sqrtMagic)) * Math.PI)
      dLng = (dLng * 180.0) / (this.A / sqrtMagic * Math.cos(radLat) * Math.PI)

      results[i] = [wgsLat + dLat, wgsLng + dLng]
    }

    return results
  }

  /**
   * 🔥 性能优化版：批量 GCJ02 转 WGS84
   *
   * @param coords 坐标数组 [[lat, lng], ...]
   * @returns 转换后的坐标数组 [[lat, lng], ...]
   */
  static batchGcj02ToWgs84Optimized(coords: Array<[number, number]>): Array<[number, number]> {
    const results: Array<[number, number]> = new Array(coords.length)

    for (let i = 0; i < coords.length; i++) {
      const [gcjLat, gcjLng] = coords[i]

      // 不在中国境内不需要转换
      if (!this.isInChina(gcjLat, gcjLng)) {
        results[i] = [gcjLat, gcjLng]
        continue
      }

      // GCJ02 转 WGS84 变换（内联以减少函数调用）
      let dLat = this.transformLat(gcjLng - 105.0, gcjLat - 35.0)
      let dLng = this.transformLon(gcjLng - 105.0, gcjLat - 35.0)
      const radLat = (gcjLat / 180.0) * Math.PI
      let magic = Math.sin(radLat)
      magic = 1 - this.EE * magic * magic
      const sqrtMagic = Math.sqrt(magic)
      dLat = (dLat * 180.0) / (((this.A * (1 - this.EE)) / (magic * sqrtMagic)) * Math.PI)
      dLng = (dLng * 180.0) / (this.A / sqrtMagic * Math.cos(radLat) * Math.PI)
      const mgLat = gcjLat + dLat
      const mgLng = gcjLng + dLng

      // 逆向转换: WGS84 = GCJ02 - 偏移
      results[i] = [gcjLat * 2 - mgLat, gcjLng * 2 - mgLng]
    }

    return results
  }

  /**
   * 批量转换 GCJ02 坐标数组到 WGS84
   *
   * @param coords GCJ02坐标数组
   * @returns WGS84坐标数组
   */
  static batchGcj02ToWgs84(coords: GCJ02Coordinate[]): WGS84Coordinate[] {
    return coords.map(coord => {
      const [lat, lng] = this.gcj02ToWgs84(coord.latitude, coord.longitude)
      return { latitude: lat, longitude: lng }
    })
  }

  /**
   * 高德Place API返回的location字段格式转换
   * 高德API返回格式: "lng,lat" (经度,纬度)
   * 需要转换为 WGS84 存储或其他用途
   *
   * @param locationString "116.305134,39.962734" 格式
   * @returns WGS84坐标 { latitude, longitude }
   */
  static amapLocationToWgs84(locationString: string): WGS84Coordinate | null {
    const parts = locationString.split(',')
    if (parts.length !== 2) return null

    const lng = parseFloat(parts[0])
    const lat = parseFloat(parts[1])

    if (isNaN(lng) || isNaN(lat)) return null

    const [wgsLat, wgsLng] = this.gcj02ToWgs84(lat, lng)
    return { latitude: wgsLat, longitude: wgsLng }
  }
}

/**
 * 便捷函数: WGS84 转 GCJ02
 */
export function wgs84ToGcj02(lat: number, lng: number): [number, number] {
  return CoordinateTransformer.wgs84ToGcj02(lat, lng)
}

/**
 * 便捷函数: GCJ02 转 WGS84
 */
export function gcj02ToWgs84(lat: number, lng: number): [number, number] {
  return CoordinateTransformer.gcj02ToWgs84(lat, lng)
}

/**
 * 计算两点之间的距离（使用Haversine公式）
 * 
 * @param lat1 第一个点的纬度
 * @param lng1 第一个点的经度
 * @param lat2 第二个点的纬度
 * @param lng2 第二个点的经度
 * @returns 两点之间的距离（米）
 */
export function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6378137 // 地球半径（米）
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}
