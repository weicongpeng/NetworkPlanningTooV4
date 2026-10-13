/**
 * 地图源（底图）配置——纯函数，不依赖 Leaflet / Cesium。
 *
 * 六选一的地图源由工具栏「地图切换」下拉决定（store 的 `mapSource`）：
 *   高德矢量图 / 高德卫星图 / 天地图矢量图 / 天地图卫星图 / 3D地图（CesiumJS）/ 空地图
 *
 * 坐标系注意：
 * - 高德瓦片是 GCJ02，本项目的显示链路（工参 displayLat/Lng、图层文件、装饰要素）整体也是 GCJ02，
 *   两者直接对齐。
 * - 天地图是 CGCS2000≈WGS84，与 GCJ02 有 100~700 米整体偏移。2D 侧用 `wgs84TileCoords()`
 *   做瓦片偏移补偿（把 GCJ02 网格的瓦片换算成 WGS84 网格的瓦片再取图）；3D 侧 Cesium 本身
 *   就是 WGS84，无需补偿。
 */
import { gcj02ToWgs84 } from '../utils/coordinate'

/** 地图源 */
export type MapSource =
  | 'amap-vector'
  | 'amap-satellite'
  | 'tdt-vector'
  | 'tdt-satellite'
  | 'cesium'
  | 'none'

/** 下拉顺序即此数组顺序 */
export const MAP_SOURCE_OPTIONS: MapSource[] = [
  'amap-vector',
  'amap-satellite',
  'tdt-vector',
  'tdt-satellite',
  'cesium',
  'none',
]

/** 2D 引擎（决定用高德还是天地图的瓦片） */
export type Map2dEngine = 'amap' | 'tianditu'

/** 当前地图源对应的 2D 引擎；3D / 空地图返回 null */
export function engineOf(source: MapSource): Map2dEngine | null {
  if (source === 'amap-vector' || source === 'amap-satellite') return 'amap'
  if (source === 'tdt-vector' || source === 'tdt-satellite') return 'tianditu'
  return null
}

/** 当前地图源对应的底图类型；3D / 空地图返回 null */
export function layerKindOf(source: MapSource): 'vector' | 'satellite' | null {
  if (source === 'amap-vector' || source === 'tdt-vector') return 'vector'
  if (source === 'amap-satellite' || source === 'tdt-satellite') return 'satellite'
  return null
}

/** 是否 3D（CesiumJS） */
export function isCesiumSource(source: MapSource): boolean {
  return source === 'cesium'
}

// ===== 高德瓦片 =====

/** 高德栅格瓦片 URL（style=8 矢量 / style=6 卫星） */
export function amapTileUrl(kind: 'vector' | 'satellite'): string {
  return kind === 'satellite'
    ? 'https://webst02.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}'
    : 'https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}'
}

// ===== 天地图瓦片 =====

/** 内置默认天地图 Key（浏览器端 Key，出厂值，UI 脱敏展示、用户可更换） */
export const DEFAULT_TIANDITU_KEY = 'ceab5b4113db5f37b5338361a7ab3fb4'

/** 天地图 WMTS 图层编码 */
export type TiandituLayer = 'vec' | 'cva' | 'img' | 'cia' | 'ter' | 'cta' | 'eva'

/** 天地图 WMTS 子域（t0~t7） */
export const TIANDITU_SUBDOMAINS = ['0', '1', '2', '3', '4', '5', '6', '7']

/** 天地图 WMTS 原生最大级别 */
export const TIANDITU_MAX_ZOOM = 18

/**
 * 天地图 WMTS 瓦片 URL 模板（球面墨卡托 `_w`）。
 * 占位符 `{s}` `{z}` `{x}` `{y}` 同时兼容 Leaflet 与 Cesium 的模板替换。
 */
export function tiandituTileUrl(layer: TiandituLayer, key: string): string {
  const tk = key || DEFAULT_TIANDITU_KEY
  return (
    `https://t{s}.tianditu.gov.cn/${layer}_w/wmts` +
    '?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
    `&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles` +
    `&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${tk}`
  )
}

/**
 * 天地图注记与底图的对应关系。
 *
 * 三类注记各自只服务一种底图：矢量注记 cva 叠在矢量图 vec 上、影像注记 cia 叠在卫星（影像）图 img 上、
 * 地形注记 cta 叠在地形晕渲 ter 上。当前下拉里没有"地形图"底图，所以 cta 无匹配底图、不会渲染。
 *
 * 渲染规则：**只渲染与当前底图匹配的那一类注记**（且该注记的开关为开）。这样默认全开时，
 * 矢量图只显示矢量注记、卫星图只显示影像注记，不会三套注记互相叠加。
 */
export const TIANDITU_ANNOTATION_BASE: Record<'cva' | 'cia' | 'cta', TiandituLayer> = {
  cva: 'vec', cia: 'img', cta: 'ter',
}

/** 当前地图源对应的天地图底图编码；非天地图/空地图返回 null */
export function tiandituBaseLayerOf(source: MapSource): TiandituLayer | null {
  if (source === 'tdt-vector') return 'vec'
  if (source === 'tdt-satellite') return 'img'
  return null
}

/** 该注记是否适用于当前地图源（不适用则不渲染，避免三套注记叠加） */
export function isAnnotationApplicable(
  code: 'cva' | 'cia' | 'cta', source: MapSource,
): boolean {
  const base = tiandituBaseLayerOf(source)
  return base !== null && TIANDITU_ANNOTATION_BASE[code] === base
}

/** 天地图注记图层（按当前底图类型叠加） */
export interface TiandituAnnotations {
  /** 矢量注记 cva */
  vector: boolean
  /** 影像注记 cia */
  image: boolean
  /** 地形注记 cta */
  terrain: boolean
}

// ===== 瓦片坐标换算（Web Mercator） =====

/** 经度 → 瓦片列号（浮点） */
export function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * Math.pow(2, z)
}

/** 纬度 → 瓦片行号（浮点） */
export function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z)
}

/** 瓦片列号 → 经度 */
export function tileXToLng(x: number, z: number): number {
  return (x / Math.pow(2, z)) * 360 - 180
}

/** 瓦片行号 → 纬度 */
export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z)
  return (180 / Math.PI) * Math.atan(Math.sinh(n))
}

/** 天地图瓦片重投影源：应从哪张 WGS84 瓦片的哪个像素偏移开始绘制 */
export interface TiandituTileSource {
  /** WGS84 瓦片列号（起始，可能为负/越界，调用方需按 2^z 取模） */
  wx: number
  /** WGS84 瓦片行号（起始） */
  wy: number
  /** 起始瓦片内的像素偏移（0 ≤ off < tileSize） */
  offX: number
  offY: number
}

/**
 * 天地图瓦片纠偏：一张 GCJ02 瓦片对应的 WGS84 重投影源。
 *
 * 天地图瓦片是 WGS84，而本页显示链路整体是 GCJ02（工参已转 GCJ02、高德瓦片也是 GCJ02），
 * 直接按同 z/x/y 铺会整体偏移 100~700 米。
 *
 * 做法：取该 GCJ02 瓦片**左上角**，换算到 WGS84 后落在 WGS84 网格的哪个像素；
 * 把这个 WGS84 像素画到画布的 (0,0)，整张瓦片就与 GCJ02 数据对齐了。
 *
 * 关键：**偏移必须烘进瓦片位图，不能用"平移瓦片层容器"实现**——容器平移量随缩放级别
 * 翻倍，而 Leaflet 的缩放动画期间只按旧 zoom 的平移量渲染，动画中底图会整幅漂移。
 * 也不能像更早的实现那样把整张瓦片取整到一张 WGS84 瓦片（残留最多半张瓦片错位）。
 */
export function tiandituTileSource(
  z: number,
  x: number,
  y: number,
  tileSize = 256,
): TiandituTileSource {
  const lngG = tileXToLng(x, z)
  const latG = tileYToLat(y, z)
  const [latW, lngW] = gcj02ToWgs84(latG, lngG)
  const px = lngToTileX(lngW, z) * tileSize
  const py = latToTileY(latW, z) * tileSize
  const wx = Math.floor(px / tileSize)
  const wy = Math.floor(py / tileSize)
  return { wx, wy, offX: px - wx * tileSize, offY: py - wy * tileSize }
}
