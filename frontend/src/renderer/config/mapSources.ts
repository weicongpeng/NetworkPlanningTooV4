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
import { gcj02ToWgs84, wgs84ToGcj02 } from '../utils/coordinate'

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

/**
 * 高德栅格瓦片 URL。
 *
 * - 卫星 `style=6`：**纯影像，不含任何注记**（实测返回 JPEG）。底图本身没有注记，
 *   地名靠叠加**天地图影像注记 cia**（见 `isAnnotationApplicable`——影像注记跨底图共用）。
 * - 矢量：走**高德官方标准矢量**（`style=8`，注记已烘进底图，参数写法与官方
 *   `webrd?lang=zh_cn&size=1&scale=1&style=8` 一致）。关掉「矢量注记」时改取
 *   `ltype=11` 的**无注记**矢量底图（实测道路/绿地/水系都在、一个文字都没有），
 *   于是开关仍然有效：开=官方原生观感，关=干净底图。
 *
 * 注：`scl=1` 与官方的 `scale=1` 返回同一张瓦片（实测 md5 一致），这里用官方写法。
 */
export function amapTileUrl(
  kind: 'vector' | 'satellite',
  opts?: { vectorAnnotations?: boolean },
): string {
  if (kind === 'satellite') {
    return 'https://webst02.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}'
  }
  const base = 'https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8'
  return opts?.vectorAnnotations === false ? `${base}&ltype=11&x={x}&y={y}&z={z}` : `${base}&x={x}&y={y}&z={z}`
}

/**
 * 高德底图的注记开关。
 *
 * 两项都不是高德自己的注记层（高德矢量已把注记烘进官方 style=8 底图），而是控制
 * **天地图 cia 影像注记**要不要叠在高德卫星影像之上：
 * - `vector`：矢量底图取官方 style=8（自带注记）还是 ltype=11 无注记版
 * - `image`：卫星影像上是否叠加天地图影像注记
 */
export interface AmapAnnotations {
  /** 矢量注记：开=官方 style=8 底图（自带注记），关=ltype=11 无注记底图 */
  vector: boolean
  /** 影像注记：天地图 cia 叠在高德卫星影像上 */
  image: boolean
}

// ===== 天地图瓦片 =====

/** 内置默认天地图 Key（浏览器端 Key，出厂值，UI 脱敏展示、用户可更换） */
export const DEFAULT_TIANDITU_KEY = 'ceab5b4113db5f37b5338361a7ab3fb4'

/** 天地图 WMTS 图层编码 */
export type TiandituLayer = 'vec' | 'cva' | 'img' | 'cia' | 'ter' | 'cta' | 'eva'

/** 天地图 WMTS 子域（t0~t7） */
export const TIANDITU_SUBDOMAINS = ['0', '1', '2', '3', '4', '5', '6', '7']

/**
 * 天地图 WMTS 声明的最大级别（可缩放到的最深层级）。
 *
 * 设成 20（而不是官方文档写的 18）是为了与高德拉齐：高德的栅格瓦片实际可下到 z20，
 * 本项目把最大缩放统一到 20 后，两边"放到最大"的观感一致。
 * 但**取瓦片**的层级仍受 `TIANDITU_NATIVE_MAX_ZOOM` 限制（见下），
 * 19-20 级由客户端拉伸 18 级瓦片显示 —— 与高德分支的 `maxNativeZoom: 18` 同一口径。
 */
export const TIANDITU_MAX_ZOOM = 20

/**
 * 天地图服务端**真实存在瓦片**的最大级别 = 18（官方文档口径，实测超过 18 级：
 * 矢量图会错位、影像图直接提示"此级别下，该区域无影像"）。
 *
 * 所以它只约束"请求哪一级瓦片"（2D `maxNativeZoom`、3D `maximumLevel`），
 * 不约束可缩放到的最深层级（那是 `TIANDITU_MAX_ZOOM`）。
 * 若把它也设成 20，19/20 级会去请求不存在的瓦片 → 底图整片空白/报错。
 */
export const TIANDITU_NATIVE_MAX_ZOOM = 18

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
 * 天地图注记图层（按当前底图类型叠加）。
 *
 * 影像注记 cia 是**跨底图共用**的：不论底下是高德卫星还是天地图影像，叠加的都是这同一张
 * 天地图 cia（2D 侧靠 `tiandituTileSource` 做 WGS84→GCJ02 纠偏，与底图来源无关；
 * 3D 侧 Cesium 本身就是 WGS84，直接加层无需纠偏）。
 * cva 只给天地图矢量用（高德矢量底图自带官方注记，不需要再叠）；cta 没有匹配底图。
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

/** 该注记是否适用于当前地图源（不适用则不渲染，避免多套注记叠加） */
export function isAnnotationApplicable(
  code: 'cva' | 'cia' | 'cta', source: MapSource,
): boolean {
  // 影像注记：凡是卫星/影像类底图都叠（高德卫星、天地图卫星）
  if (code === 'cia') return layerKindOf(source) === 'satellite'
  // 其余注记只服务天地图自己的底图
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

/**
 * 高德瓦片纠偏（3D 用）：一张 **WGS84** 瓦片应当从哪张 **GCJ02** 瓦片的哪个像素开始绘制。
 *
 * 与 `tiandituTileSource` **互为反向**：那边解决"2D 显示链路是 GCJ02、天地图是 WGS84"，
 * 这边解决"3D（Cesium）是 WGS84、高德是 GCJ02"。不纠偏的话，高德底图会相对工参/图层
 * 整体偏 100~700 米。
 *
 * 同 2D 的做法：取 WGS84 瓦片左上角换算到 GCJ02 网格 → 落在哪张 GCJ02 瓦片的哪个像素，
 * 把该 GCJ02 瓦片按这个偏移画到画布 (0,0)，整张瓦片就与 WGS84 数据对齐了。
 * （GCJ02 偏移在一张瓦片范围内变化只有几米，远小于 1 像素，所以按左上角取整张偏移即可。）
 */
export function amapTileSourceForWgsTile(
  z: number,
  x: number,
  y: number,
  tileSize = 256,
): TiandituTileSource {
  const lngW = tileXToLng(x, z)
  const latW = tileYToLat(y, z)
  const [latG, lngG] = wgs84ToGcj02(latW, lngW)
  const px = lngToTileX(lngG, z) * tileSize
  const py = latToTileY(latG, z) * tileSize
  const gx = Math.floor(px / tileSize)
  const gy = Math.floor(py / tileSize)
  return { wx: gx, wy: gy, offX: px - gx * tileSize, offY: py - gy * tileSize }
}
