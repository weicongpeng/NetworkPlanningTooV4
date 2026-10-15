import { describe, it, expect } from 'vitest'
import {
  MAP_SOURCE_OPTIONS,
  DEFAULT_TIANDITU_KEY,
  amapTileUrl,
  tiandituTileUrl,
  engineOf,
  layerKindOf,
  isCesiumSource,
  lngToTileX,
  latToTileY,
  tileXToLng,
  tileYToLat,
  tiandituTileSource,
  isAnnotationApplicable,
  tiandituBaseLayerOf,
  TIANDITU_MAX_ZOOM,
  TIANDITU_NATIVE_MAX_ZOOM,
  amapAnnotationTileUrl,
  isAmapAnnotationApplicable,
} from '../mapSources'
import { gcj02ToWgs84 } from '../../utils/coordinate'

describe('地图源枚举', () => {
  it('下拉顺序覆盖六项且不重复', () => {
    expect(MAP_SOURCE_OPTIONS).toHaveLength(6)
    expect(new Set(MAP_SOURCE_OPTIONS).size).toBe(6)
    expect(MAP_SOURCE_OPTIONS).toContain('cesium')
    expect(MAP_SOURCE_OPTIONS).toContain('none')
  })

  it('2D 引擎与底图类型解析正确', () => {
    expect(engineOf('amap-vector')).toBe('amap')
    expect(engineOf('amap-satellite')).toBe('amap')
    expect(engineOf('tdt-vector')).toBe('tianditu')
    expect(engineOf('tdt-satellite')).toBe('tianditu')
    expect(engineOf('cesium')).toBeNull()
    expect(engineOf('none')).toBeNull()

    expect(layerKindOf('amap-vector')).toBe('vector')
    expect(layerKindOf('amap-satellite')).toBe('satellite')
    expect(layerKindOf('tdt-vector')).toBe('vector')
    expect(layerKindOf('tdt-satellite')).toBe('satellite')
    expect(layerKindOf('none')).toBeNull()
  })

  it('只有 cesium 是 3D 源', () => {
    for (const s of MAP_SOURCE_OPTIONS) {
      expect(isCesiumSource(s)).toBe(s === 'cesium')
    }
  })
})

describe('天地图注记只与匹配的底图同显', () => {
  it('矢量图只放矢量注记', () => {
    expect(isAnnotationApplicable('cva', 'tdt-vector')).toBe(true)
    expect(isAnnotationApplicable('cia', 'tdt-vector')).toBe(false)
    expect(isAnnotationApplicable('cta', 'tdt-vector')).toBe(false)
  })

  it('卫星图只放影像注记', () => {
    expect(isAnnotationApplicable('cia', 'tdt-satellite')).toBe(true)
    expect(isAnnotationApplicable('cva', 'tdt-satellite')).toBe(false)
    expect(isAnnotationApplicable('cta', 'tdt-satellite')).toBe(false)
  })

  it('无地形底图 → 地形注记不适用', () => {
    for (const s of MAP_SOURCE_OPTIONS) {
      expect(isAnnotationApplicable('cta', s)).toBe(false)
    }
  })

  it('非天地图底图（高德/3D/空地图）不放任何天地图注记', () => {
    for (const s of ['amap-vector', 'amap-satellite', 'cesium', 'none'] as const) {
      expect(isAnnotationApplicable('cva', s)).toBe(false)
      expect(isAnnotationApplicable('cia', s)).toBe(false)
    }
  })

  it('任一底图下最多只匹配一类注记（默认全开也不会叠加）', () => {
    for (const s of MAP_SOURCE_OPTIONS) {
      const matched = (['cva', 'cia', 'cta'] as const)
        .filter((c) => isAnnotationApplicable(c, s))
      expect(matched.length).toBeLessThanOrEqual(1)
    }
  })

  it('tiandituBaseLayerOf 只认天地图矢量/卫星', () => {
    expect(tiandituBaseLayerOf('tdt-vector')).toBe('vec')
    expect(tiandituBaseLayerOf('tdt-satellite')).toBe('img')
    expect(tiandituBaseLayerOf('amap-vector')).toBeNull()
    expect(tiandituBaseLayerOf('cesium')).toBeNull()
    expect(tiandituBaseLayerOf('none')).toBeNull()
  })
})

describe('瓦片 URL', () => {
  it('高德矢量/卫星走不同 style', () => {
    expect(amapTileUrl('satellite')).toContain('style=6')
    expect(amapTileUrl('vector')).toContain('style=8')
    expect(amapTileUrl('vector')).toContain('{x}')
  })

  it('天地图 URL 带图层编码、Key 与占位符', () => {
    const url = tiandituTileUrl('vec', 'MY_KEY')
    expect(url).toContain('vec_w/wmts')
    expect(url).toContain('LAYER=vec')
    expect(url).toContain('tk=MY_KEY')
    expect(url).toContain('TILEMATRIX={z}')
    expect(url).toContain('TILEROW={y}')
    expect(url).toContain('TILECOL={x}')
    expect(url).toContain('{s}')
  })

  it('Key 为空时回退到内置默认 Key', () => {
    expect(tiandituTileUrl('img', '')).toContain(`tk=${DEFAULT_TIANDITU_KEY}`)
  })
})

describe('Web Mercator 瓦片坐标换算', () => {
  it('经纬度 → 瓦片 → 经纬度 可逆（瓦片中心）', () => {
    const z = 12
    const lng = 114.6974
    const lat = 23.7433
    const cx = lngToTileX(lng, z)
    const cy = latToTileY(lat, z)
    expect(tileXToLng(cx, z)).toBeCloseTo(lng, 6)
    expect(tileYToLat(cy, z)).toBeCloseTo(lat, 6)
  })

  it('z=0 时整幅世界只有一个瓦片', () => {
    expect(lngToTileX(-180, 0)).toBe(0)
    expect(lngToTileX(180, 0)).toBe(1)
    expect(latToTileY(0, 0)).toBeCloseTo(0.5, 6)
  })
})

describe('天地图纠偏：瓦片重投影源', () => {
  // 河源市附近（GCJ02 显示链路下的典型工作区域）
  const z = 15
  const x = Math.floor(lngToTileX(114.6974, z))
  const y = Math.floor(latToTileY(23.7433, z))

  it('偏移量恒在半张瓦片内（这正是"取整到整瓦片"方案残留错位的量级）', () => {
    for (const zz of [10, 12, 15, 18]) {
      const xx = Math.floor(lngToTileX(114.6974, zz))
      const yy = Math.floor(latToTileY(23.7433, zz))
      const src = tiandituTileSource(zz, xx, yy)
      expect(src.offX).toBeGreaterThanOrEqual(0)
      expect(src.offX).toBeLessThan(256)
      expect(src.offY).toBeGreaterThanOrEqual(0)
      expect(src.offY).toBeLessThan(256)
    }
  })

  it('亚像素余量真的被用上（不是退化成整瓦片对齐）', () => {
    const src = tiandituTileSource(z, x, y)
    // 基准差在 z=15 约 0.4~0.5 张瓦片，因此偏移既非 0 也不会是整数瓦片
    expect(src.offX).toBeGreaterThan(0)
    expect(src.offY).toBeGreaterThan(0)
  })

  it('绘制原点 = 该 GCJ02 瓦片左上角对应的 WGS84 像素（画到画布 0,0）', () => {
    const src = tiandituTileSource(z, x, y)
    const [latW, lngW] = gcj02ToWgs84(tileYToLat(y, z), tileXToLng(x, z))
    // WGS84 网格像素 = 起始瓦片原点 + 偏移
    expect(src.wx * 256 + src.offX).toBeCloseTo(lngToTileX(lngW, z) * 256, 6)
    expect(src.wy * 256 + src.offY).toBeCloseTo(latToTileY(latW, z) * 256, 6)
  })

  it('纬度/经度参数顺序正确：写反会得到完全不同的瓦片', () => {
    const src = tiandituTileSource(z, x, y)
    // 正确实现的起始瓦片与请求瓦片相差不超过 1 张
    expect(Math.abs(src.wx - x)).toBeLessThanOrEqual(1)
    expect(Math.abs(src.wy - y)).toBeLessThanOrEqual(1)
  })

  it('不做纠偏就是整体偏移（该点的 GCJ02 与 WGS84 不在同一张瓦片）', () => {
    const lngW = gcj02ToWgs84(23.7433, 114.6974)[1]
    expect(Math.floor(lngToTileX(lngW, z))).not.toBe(Math.floor(lngToTileX(114.6974, z)))
  })

  it('起始瓦片允许越界（由调用方按 2^z 取模处理）', () => {
    const src = tiandituTileSource(3, 0, 0)
    expect(Number.isFinite(src.wx)).toBe(true)
    expect(Number.isFinite(src.wy)).toBe(true)
  })
})

describe('天地图缩放上限：可缩放到 20，但只请求真实存在的层级', () => {
  it('可缩放上限 = 20（与高德侧 maxZoom 拉齐，用户要求能再放大底图）', () => {
    expect(TIANDITU_MAX_ZOOM).toBe(20)
  })

  it('取瓦片层级上限 = 18（服务端真实级别；19-20 由客户端拉伸 18 级瓦片）', () => {
    // 服务端没有 19/20 级瓦片：请求它们会得到空白/错位底图
    expect(TIANDITU_NATIVE_MAX_ZOOM).toBe(18)
    expect(TIANDITU_NATIVE_MAX_ZOOM).toBeLessThan(TIANDITU_MAX_ZOOM)
  })
})

describe('高德注记叠加层', () => {
  it('注记瓦片 URL：style=8 透明路网注记，且带 {x}/{y}/{z} 占位符', () => {
    const url = amapAnnotationTileUrl()
    expect(url).toContain('style=8')
    expect(url).toContain('{x}').valueOf()
    expect(url).toContain('{y}')
    expect(url).toContain('{z}')
    // 与卫星底图（style=6）必须是两张不同的瓦片，否则叠加没有意义
    expect(url).not.toBe(amapTileUrl('satellite'))
    expect(amapTileUrl('satellite')).toContain('style=6')
  })

  it('注记只在与它匹配的高德底图上生效（与天地图同口径）', () => {
    expect(isAmapAnnotationApplicable('image', 'amap-satellite')).toBe(true)
    expect(isAmapAnnotationApplicable('image', 'amap-vector')).toBe(false)
    expect(isAmapAnnotationApplicable('vector', 'amap-vector')).toBe(true)
    expect(isAmapAnnotationApplicable('vector', 'amap-satellite')).toBe(false)
  })

  it('天地图与 3D / 空地图上不叠加高德注记', () => {
    for (const src of ['tdt-vector', 'tdt-satellite', 'cesium', 'none'] as const) {
      expect(isAmapAnnotationApplicable('image', src)).toBe(false)
      expect(isAmapAnnotationApplicable('vector', src)).toBe(false)
    }
  })
})
