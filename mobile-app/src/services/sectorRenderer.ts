/**
 * 扇区渲染器 - Native 侧扇区数据管线
 *
 * 职责:
 * 1. 订阅 store 中的扇区数据,构建空间索引(RBush)与聚类索引(Supercluster)
 * 2. 根据 zoom + bounds 返回需要渲染的扇区子集(LOD 分级)
 * 3. 提供命中查询能力,支持点击地图查找扇区
 *
 * 设计要点:
 * - 复用 viewportFilter (RBush) 和 clusterManager (Supercluster) 单例
 * - 所有几何计算在 Native 侧完成,WebView 只负责 Canvas 绘制
 * - 万级扇区下只传输视窗内子集(~数百),避免 JSON.stringify 全量序列化
 * - 三档 LOD:circle(聚类圆点)/ triangle(三角形简形)/ polygon(完整扇区)
 *
 * 性能对比(万级扇区,低端机):
 *   旧方案:全量 JSON.stringify + AMap.Polygon 创建,首屏 ~5s
 *   新方案:RBush 视窗查询 + Canvas 批量绘制,首屏 < 1.5s
 */

import { getViewportFilter, ViewportFilter, ViewportBounds } from '../utils/viewportFilter';
import { getClusterManager, ClusterManager, ClusterPoint } from '../utils/clusterManager';
import { SectorData } from '../store/mapStore';
import { GeoJsonFeature } from '../types/data';
import { wgs84ToGcj02, gcj02ToWgs84 } from '../utils/coordinate';

/** LOD 级别 */
export type LodLevel = 'circle' | 'triangle' | 'polygon';

/** 渲染用扇区数据(预计算 GCJ02 坐标,避免热路径中重复转换) */
export interface RenderSector extends SectorData {
  /** GCJ02 纬度(地图显示用) */
  gcjLat: number;
  /** GCJ02 经度(地图显示用) */
  gcjLng: number;
}

/** 命中类型(与 MapView.tsx _hitTest 的 4 级优先级对应) */
export type HitReason = 'inside' | 'bearing' | 'near' | 'nearest';

/** 命中查询结果项 */
export interface HitTestResult {
  sector: SectorData;
  /** 扇区中心到点击点的距离(米) */
  distance: number;
  /** 命中原因 */
  reason: HitReason;
  /** 方位角差(仅 bearing 命中时有意义,0-180 度) */
  angleDiff?: number;
}

/**
 * 一次性全量注入 WebView 的最大扇区数
 * 超出此阈值回退桥模式(moveend → postMessage → computeRender → injectJS)
 */
const LOCAL_INDEX_MAX_SECTORS = 50000;

/** 注入 WebView 的精简扇区(字段裁剪 + GCJ02 预转 + 扇形顶点预计算) */
export interface InjectedSector {
  id: string;
  name: string;
  networkType: 'LTE' | 'NR';
  cell_cover_type?: number | string;
  /** WGS84 原始坐标(hitTest 结果回传后供详情/导航使用) */
  latitude: number;
  longitude: number;
  /** GCJ02 坐标(渲染用) */
  gcjLat: number;
  gcjLng: number;
  azimuth: number;
  beamwidth: number;
  /** 是否室分扇区 */
  indoor: boolean;
  /**
   * 室外扇区预计算弧边顶点的米偏移 [dx东, dy北](不含中心点),室分为 null。
   * WebView 用"中心点投影 + 米/像素比"直接换算像素,避免逐顶点投影。
   */
  pts: [number, number][] | null;
}

/** 一次性注入载荷,通过 injectJS 传给 WebView 的 setSectorData 函数 */
export interface SectorInjectionPayload {
  version: 1;
  count: number;
  /** false 表示数据量超阈值,WebView 应回退桥模式 */
  useLocalIndex: boolean;
  sectors: InjectedSector[];
}

/** 渲染指令,通过 injectJS 传给 WebView 的 drawSectors 函数 */
export interface RenderCommand {
  /** 'full' 全量重绘,'delta' 增量更新(初版统一用 full,后续可优化) */
  type: 'full' | 'delta';
  /** 当前缩放级别 */
  zoom: number;
  /** 视窗范围(WGS84) */
  bounds: ViewportBounds;
  /** 视窗内可见扇区(已预计算 GCJ02 坐标,WebView 直接用) */
  sectors: RenderSector[];
  /** 聚类点(低缩放级别时使用,WGS84 坐标) */
  clusters?: ClusterPoint[];
  /** LOD 级别 */
  lod: LodLevel;
}

/**
 * 单次视窗查询的最大扇区数
 * 超出此阈值则采样显示,防止 Canvas 一次绘制过多图元导致卡顿
 */
const MAX_VIEWPORT_SECTORS = 8000;

/** LOD 阈值:zoom < 13 用 triangle,zoom >= 13 用 polygon(不使用聚类) */
const LOD_THRESHOLD_TRIANGLE = 13;
const LOD_THRESHOLD_POLYGON = 15;

/**
 * 命中查询的默认搜索半径(米)
 * 与 MapView.tsx _hitTest 的 fallback 阈值一致(800m 是 _nearestSector 的上限,
 * 300m 是 bearing 判断的距离阈值)
 */
const DEFAULT_HIT_TEST_RADIUS = 800;

/** 命中查询返回的最大扇区数 */
const MAX_HIT_TEST_RESULTS = 10;

/** 室分扇区 Circle 命中的最大距离(米),与 MapView.tsx L153 一致 */
const INDOOR_NEAR_MAX_DISTANCE = 150;

/** 方位角命中判断的最大距离(米),与 MapView.tsx L163 一致 */
const BEARING_MAX_DISTANCE = 300;

/** 室分扇区判断的 cell_cover_type 值 */
const INDOOR_COVER_TYPES: Array<number | string> = [4, '室分', '室内'];

/** 扇区波束默认方位角(azimuth 缺失时),与 MapView.tsx L94 一致 */
const DEFAULT_AZIMUTH = 0;

/** 扇区波束默认宽度(beamwidth 缺失时),与 MapView.tsx L95 一致 */
const DEFAULT_BEAMWIDTH = 65;

/** 室分扇区固定半径(米),与 MapView.tsx L92 一致 */
const INDOOR_RADIUS = 30;

/** 扇区波束地理半径(米),与 MapView.tsx L99 一致 */
const SECTOR_RADIUS_METERS = 60;

/** 扇区多边形角度步长(度),与 MapView.tsx L98 一致 */
const POLYGON_STEP_DEG = 5;

class SectorRenderer {
  private viewportFilter: ViewportFilter;
  private clusterManager: ClusterManager;
  private indexedSectors: SectorData[] = [];
  /** 上次渲染的 key,用于判断是否可以走 delta 路径 */
  private lastRenderKey: string = '';
  /** 标记是否已建立索引 */
  private indexed: boolean = false;

  constructor() {
    // 复用单例,避免多次重建
    // 注意:maxZoom 设为 LOD_THRESHOLD_TRIANGLE,意味着 zoom >= 12 时不再聚类
    this.viewportFilter = getViewportFilter();
    this.clusterManager = getClusterManager({
      radius: 60,
      maxZoom: LOD_THRESHOLD_TRIANGLE,
      minPoints: 2,
      extent: 512,
      nodeSize: 64,
    });
  }

  /**
   * 当 store 中扇区数据变化时调用
   * 重建空间索引和聚类索引
   *
   * @param lte LTE 扇区数组
   * @param nr NR 扇区数组
   */
  updateSectors(lte: SectorData[], nr: SectorData[]): void {
    const all = [...lte, ...nr];
    this.indexedSectors = all;

    if (all.length === 0) {
      this.viewportFilter.clear();
      this.clusterManager.clear();
      this.indexed = false;
      this.lastRenderKey = '';
      return;
    }

    // 转换为 GeoJSON Feature 格式(RBush 和 Supercluster 都需要)
    // coordinates 使用 [lng, lat] 顺序(GeoJSON 标准)
    const features: GeoJsonFeature[] = all.map(s => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [s.longitude, s.latitude],
      },
      properties: s,
    }));

    // 构建空间索引(RBush,O(n log n),万级数据 ~30ms)
    this.viewportFilter.buildIndex(features);

    // 构建聚类索引(Supercluster)
    this.clusterManager.loadData(features);

    this.indexed = true;
    this.lastRenderKey = '';
  }

  /** 调试用:返回索引状态和扇区数量 */
  getIndexedStatus(): string {
    return `indexed=${this.indexed} sectors=${this.indexedSectors.length}`;
  }

  /**
   * 根据 zoom + bounds 计算渲染指令
   *
   * @param zoom 当前缩放级别
   * @param bounds 视窗范围(WGS84)
   * @returns 渲染指令,可直接传给 WebView 的 drawSectors
   */
  computeRender(zoom: number, bounds: ViewportBounds): RenderCommand {
    // 索引未就绪时返回空指令,避免绘制错误
    if (!this.indexed) {
      return {
        type: 'full',
        zoom,
        bounds,
        sectors: [],
        lod: 'circle',
      };
    }

    // bounds 来自 map.getBounds() 是 GCJ02 坐标,索引是 WGS84,需转换
    // 转换视窗四角的 GCJ02 → WGS84,取外包络
    const swWgs = gcj02ToWgs84(bounds.south, bounds.west);
    const neWgs = gcj02ToWgs84(bounds.north, bounds.east);
    const wgsBounds: ViewportBounds = {
      west: swWgs[1],
      south: swWgs[0],
      east: neWgs[1],
      north: neWgs[0],
    };

    const lod = this.getLod(zoom);

    // 所有缩放级别都查询视窗内单扇区(不使用聚类)
    const features = this.viewportFilter.queryViewportWithLimit(wgsBounds, MAX_VIEWPORT_SECTORS);

    // 视窗内扇区过多时,queryViewportWithLimit 会自动采样,但仍返回扇区(非聚类)
    const sectors: RenderSector[] = features.map(f => {
      const s = f.properties as SectorData;
      const [gcjLat, gcjLng] = wgs84ToGcj02(s.latitude, s.longitude);
      return { ...s, gcjLat, gcjLng };
    });

    // 计算 render key 用于判断是否可走 delta 路径
    const renderKey = this.computeRenderKey(zoom, bounds);
    const type = this.canUseDelta(this.lastRenderKey, renderKey) ? 'delta' : 'full';
    this.lastRenderKey = renderKey;

    return {
      type,
      zoom,
      bounds,
      sectors,
      lod,
    };
  }

  /**
   * 构建一次性全量注入载荷(供 MapView 通过 injectJS 下发给 WebView setSectorData)
   *
   * 字段裁剪 + WGS84→GCJ02 预转 + 扇形弧边顶点预计算(米偏移),
   * WebView 拿到后建本地网格索引,视窗查询/重绘不再需要桥接往返。
   *
   * @returns 注入载荷;数据量超阈值时 useLocalIndex=false 且 sectors 为空(回退桥模式)
   */
  buildInjectionPayload(): SectorInjectionPayload {
    const all = this.indexedSectors;
    if (all.length === 0) {
      return { version: 1, count: 0, useLocalIndex: true, sectors: [] };
    }
    if (all.length > LOCAL_INDEX_MAX_SECTORS) {
      console.warn(`[sectorRenderer] 扇区数 ${all.length} 超过本地索引阈值 ${LOCAL_INDEX_MAX_SECTORS},回退桥模式`);
      return { version: 1, count: all.length, useLocalIndex: false, sectors: [] };
    }

    const sectors: InjectedSector[] = [];
    for (const s of all) {
      if (s.latitude == null || s.longitude == null) continue;
      const [gcjLat, gcjLng] = wgs84ToGcj02(s.latitude, s.longitude);
      const indoor = this.isIndoorSector(s);

      let pts: [number, number][] | null = null;
      if (!indoor) {
        const az = s.azimuth == null ? DEFAULT_AZIMUTH : Number(s.azimuth);
        const bw = s.beamwidth == null ? DEFAULT_BEAMWIDTH : Number(s.beamwidth);
        const sa = 90 - az - bw / 2;
        const ea = 90 - az + bw / 2;
        pts = [];
        // 与模板内弧边生成一致:角度从正东起逆时针,dx 东向、dy 北向(米)
        // 保留 1 位小数(0.1m 精度,远小于 1 像素),控制注入体积
        for (let a = sa; a <= ea; a += POLYGON_STEP_DEG) {
          const rad = a * Math.PI / 180;
          const dx = Math.round(SECTOR_RADIUS_METERS * Math.cos(rad) * 10) / 10;
          const dy = Math.round(SECTOR_RADIUS_METERS * Math.sin(rad) * 10) / 10;
          pts.push([dx, dy]);
        }
      }

      sectors.push({
        id: s.id,
        name: s.name,
        networkType: s.networkType,
        cell_cover_type: s.cell_cover_type,
        latitude: s.latitude,
        longitude: s.longitude,
        gcjLat,
        gcjLng,
        azimuth: s.azimuth == null ? DEFAULT_AZIMUTH : Number(s.azimuth),
        beamwidth: s.beamwidth == null ? DEFAULT_BEAMWIDTH : Number(s.beamwidth),
        indoor,
        pts,
      });
    }

    return { version: 1, count: sectors.length, useLocalIndex: true, sectors };
  }

  /**
   * 命中查询:返回指定坐标命中的扇区,按 4 级优先级排序
   *
   * 与 MapView.tsx _hitTest 逻辑完全对齐,作为 WebView 侧 _hitTest 的备用:
   * 1. inside  - 点击点在扇区多边形内(室分则为圆内)
   * 2. bearing - 方位角在波束内且距离 ≤ 300m
   * 3. near    - 近距离匹配(室分 ≤ 150m,室外 ≤ 300m)
   * 4. nearest - 最近扇区回退(≤ 800m)
   *
   * 使用场景:
   * - 主用:WebView 侧 _hitTest 在 window._viewportSectors 上跑(同步,低延迟)
   * - 备用:本方法在 WebView 侧未命中或数据不可靠时调用,从完整 RBush 索引查询
   *
   * @param lat WGS84 纬度
   * @param lng WGS84 经度
   * @param maxDistance 最大搜索半径(米),默认 800m(与 _nearestSector 一致)
   * @returns 命中结果列表,按优先级 + 距离排序,最多 MAX_HIT_TEST_RESULTS 个
   */
  queryAt(lat: number, lng: number, maxDistance: number = DEFAULT_HIT_TEST_RADIUS): HitTestResult[] {
    if (!this.indexed) return [];

    // 用一个稍大的范围查询周边扇区(覆盖 maxDistance + 安全余量)
    // 1 度约 111km
    const deg = maxDistance / 111000;
    const bounds: ViewportBounds = {
      west: lng - deg,
      south: lat - deg,
      east: lng + deg,
      north: lat + deg,
    };

    const features = this.viewportFilter.queryViewport(bounds);
    if (features.length === 0) return [];

    // 4 级优先级候选
    let bestInside: HitTestResult | null = null;
    let bestBearing: HitTestResult | null = null;
    let bestNear: HitTestResult | null = null;
    let bestNearest: HitTestResult | null = null;

    const candidates: HitTestResult[] = [];

    for (const f of features) {
      const sector = f.properties as SectorData;
      const d = this.distance(lat, lng, sector.latitude, sector.longitude);
      // 超出最大搜索半径的直接跳过
      if (d > maxDistance) continue;

      const isIndoor = this.isIndoorSector(sector);

      if (isIndoor) {
        // 室分扇区:Circle 命中判断
        if (d <= INDOOR_RADIUS) {
          // 命中圆内 → inside 优先级
          if (!bestInside || d < bestInside.distance) {
            bestInside = { sector, distance: d, reason: 'inside' };
          }
        } else if (d <= INDOOR_NEAR_MAX_DISTANCE) {
          // 圆外但 ≤ 150m → near 优先级
          if (!bestNear || d < bestNear.distance) {
            bestNear = { sector, distance: d, reason: 'near' };
          }
        }
      } else {
        // 室外扇区:多边形 + 方位角命中判断
        const poly = this.buildSectorPolygon(sector);
        if (poly && this.inPoly(lng, lat, poly)) {
          // 点击点在多边形内 → inside 优先级
          if (!bestInside || d < bestInside.distance) {
            bestInside = { sector, distance: d, reason: 'inside' };
          }
        } else {
          // 不在多边形内,检查方位角
          const azimuth = sector.azimuth == null ? DEFAULT_AZIMUTH : Number(sector.azimuth);
          const beamwidth = sector.beamwidth == null ? DEFAULT_BEAMWIDTH : Number(sector.beamwidth);
          const bearing = this.bearing(lat, lng, sector.latitude, sector.longitude);
          const aDiff = this.angleDiff(bearing, azimuth);
          if (aDiff <= beamwidth / 2 && d <= BEARING_MAX_DISTANCE) {
            // 方位角在波束内且距离 ≤ 300m → bearing 优先级
            if (
              !bestBearing ||
              aDiff < (bestBearing.angleDiff ?? Infinity) ||
              (aDiff === (bestBearing.angleDiff ?? Infinity) && d < bestBearing.distance)
            ) {
              bestBearing = { sector, distance: d, reason: 'bearing', angleDiff: aDiff };
            }
          } else if (d <= BEARING_MAX_DISTANCE) {
            // 距离 ≤ 300m 但方位角不在波束内 → near 优先级
            if (!bestNear || d < bestNear.distance) {
              bestNear = { sector, distance: d, reason: 'near' };
            }
          }
        }
      }

      // 所有候选都加入最近扇区回退池
      if (!bestNearest || d < bestNearest.distance) {
        bestNearest = { sector, distance: d, reason: 'nearest' };
      }
      candidates.push({ sector, distance: d, reason: 'nearest' });
    }

    // 按优先级组装结果:inside > bearing > near > nearest
    const results: HitTestResult[] = [];
    if (bestInside) results.push(bestInside);
    if (bestBearing) results.push(bestBearing);
    if (bestNear) results.push(bestNear);
    if (bestNearest) results.push(bestNearest);

    // 去重(同一扇区可能命中多个优先级,保留最高优先级)
    const seen = new Set<string>();
    const deduped = results.filter(r => {
      if (seen.has(r.sector.id)) return false;
      seen.add(r.sector.id);
      return true;
    });

    return deduped.slice(0, MAX_HIT_TEST_RESULTS);
  }

  /**
   * 判断扇区是否为室分扇区
   * 与 MapView.tsx L90 一致:cell_cover_type === 4 或 字符串 '室分'/'室内'
   */
  private isIndoorSector(sector: SectorData): boolean {
    const ct = sector.cell_cover_type;
    if (ct == null) return false;
    return INDOOR_COVER_TYPES.includes(ct);
  }

  /**
   * 构建扇区多边形顶点(地理坐标 [lng, lat] 数组)
   * 与 MapView.tsx L94-L104 makeSectorOverlay 完全一致
   *
   * @param sector 扇区数据
   * @returns 多边形顶点数组,或 null(数据无效时)
   */
  private buildSectorPolygon(sector: SectorData): [number, number][] | null {
    if (sector.latitude == null || sector.longitude == null) return null;

    const lat = sector.latitude;
    const lng = sector.longitude;
    const az = sector.azimuth == null ? DEFAULT_AZIMUTH : Number(sector.azimuth);
    const bw = sector.beamwidth == null ? DEFAULT_BEAMWIDTH : Number(sector.beamwidth);

    const pts: [number, number][] = [[lng, lat]];
    const sa = 90 - az - bw / 2;
    const ea = 90 - az + bw / 2;
    const cosLat = Math.cos(lat * Math.PI / 180);

    for (let a = sa; a <= ea; a += POLYGON_STEP_DEG) {
      const rad = a * Math.PI / 180;
      const dx = SECTOR_RADIUS_METERS * Math.cos(rad);
      const dy = SECTOR_RADIUS_METERS * Math.sin(rad);
      // 与 MapView.tsx L100-L101 一致:经度方向除以 cos(lat)
      const dLng = dx / (111320 * cosLat);
      const dLat = dy / 110540;
      pts.push([lng + dLng, lat + dLat]);
    }
    pts.push([lng, lat]);
    return pts;
  }

  /**
   * 射线法判断点是否在多边形内
   * 与 MapView.tsx L107-L115 _inPoly 完全一致
   *
   * @param lng 点经度
   * @param lat 点纬度
   * @param poly 多边形顶点数组 [[lng, lat], ...]
   * @returns 是否在多边形内
   */
  private inPoly(lng: number, lat: number, poly: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      if (yj === yi) continue;
      if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * 计算从点 A 到点 B 的罗盘方位角(0=正北,顺时针)
   * 与 MapView.tsx L117-L123 _bearing 完全一致
   */
  private bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const la1 = lat1 * Math.PI / 180;
    const la2 = lat2 * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  /**
   * 计算两个方位角的夹角(0-180 度)
   * 与 MapView.tsx L125-L128 _angleDiff 完全一致
   */
  private angleDiff(b1: number, b2: number): number {
    const d = Math.abs(b1 - b2);
    return d > 180 ? 360 - d : d;
  }

  /**
   * 根据 zoom 级别返回 LOD
   *
   * - circle:zoom < 12,省级视野,扇区密度极高,用聚类圆点
   * - triangle:12 <= zoom < 15,街区视野,扇区形状开始可辨,用简化三角形
   * - polygon:zoom >= 15,街道视野,视窗内扇区少,画完整扇区
   *
   * @param zoom 当前缩放级别
   * @returns LOD 级别
   */
  getLod(zoom: number): LodLevel {
    // 不使用 circle 聚类模式,所有缩放级别都显示扇区
    if (zoom < LOD_THRESHOLD_TRIANGLE) return 'triangle';
    if (zoom < LOD_THRESHOLD_POLYGON) return 'triangle';
    return 'polygon';
  }

  /**
   * 是否已建立索引
   */
  isIndexed(): boolean {
    return this.indexed;
  }

  /**
   * 已索引的扇区总数
   */
  getTotalCount(): number {
    return this.indexedSectors.length;
  }

  /**
   * 清除所有数据
   */
  clear(): void {
    this.viewportFilter.clear();
    this.clusterManager.clear();
    this.indexedSectors = [];
    this.indexed = false;
    this.lastRenderKey = '';
  }

  /**
   * 计算渲染 key,用于判断是否可以走 delta 路径
   * 如果 zoom 不变且 bounds 仅小幅平移,理论上可以走 delta
   *
   * @param zoom 当前缩放级别
   * @param bounds 视窗范围
   * @returns 渲染 key 字符串
   */
  private computeRenderKey(zoom: number, bounds: ViewportBounds): string {
    // 保留 3 位小数(约 100m 精度),避免小幅平移频繁触发全量
    return `${zoom.toFixed(0)}|${bounds.west.toFixed(3)},${bounds.south.toFixed(3)},${bounds.east.toFixed(3)},${bounds.north.toFixed(3)}`;
  }

  /**
   * 判断是否可以走 delta 渲染
   *
   * 初版统一返回 false,所有渲染走 'full' 路径,简化逻辑。
   * 后续可优化:zoom 不变且 bounds 仅小幅平移时走 delta,
   * 只传输新增/移除的扇区,减少 JSON.stringify 开销。
   *
   * @param prevKey 上次渲染的 key
   * @param currKey 当前渲染的 key
   * @returns 是否可以走 delta 路径
   */
  private canUseDelta(prevKey: string, currKey: string): boolean {
    // 初版:统一全量渲染,简化逻辑
    // TODO: 后续实现 delta 渲染,根据 prevKey/currKey 差异判断
    return false;
  }

  /**
   * Haversine 距离公式(米)
   * 用于命中查询时按距离排序
   *
   * @param lat1 起点纬度
   * @param lng1 起点经度
   * @param lat2 终点纬度
   * @param lng2 终点经度
   * @returns 距离(米)
   */
  private distance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000; // 地球半径(米)
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}

// 导出单例
// 业务模块直接 import 使用,不要重复实例化(与 apiService、cacheService 约定一致)
export const sectorRenderer = new SectorRenderer();
