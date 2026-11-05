// ==================== 缓存元数据类型 ====================

export interface CacheMeta {
  /** 最后刷新时间 ISO 字符串 */
  lastRefreshAt: string | null;
  /** 各数据类型缓存状态 */
  dataTypes: {
    fullParams: boolean;
    geoData: boolean;
    layers: boolean;
  };
  /** 各数据类型具体信息 */
  fullParamsInfo: FullParamsCacheInfo | null;
  geoDataInfo: GeoDataCacheInfo | null;
  layersInfo: LayersCacheInfo | null;
}

export interface FullParamsCacheInfo {
  /** 源文件名称（后端缓存或本地导入的文件名） */
  sourceFileName: string;
  lteSiteCount: number;
  lteSectorCount: number;
  nrSiteCount: number;
  nrSectorCount: number;
  cachedAt: string;
  /** 数据是否来自手机本地导入 */
  fromPhone?: boolean;
}

export interface GeoDataCacheInfo {
  /** 每条地理化数据的缓存信息 */
  items: GeoDataItem[];
  cachedAt: string;
  /** 数据是否来自手机本地导入 */
  fromPhone?: boolean;
}

export interface GeoDataItem {
  name: string;
  pointCount: number;
  geometryType: string;
  filePath: string;
  cachedAt: string;
}

export interface LayersCacheInfo {
  items: LayerItem[];
  cachedAt: string;
  /** 数据是否来自手机本地导入 */
  fromPhone?: boolean;
}

export interface LayerItem {
  name: string;
  layerType: string;
  filePath: string;
  cachedAt: string;
}

// ==================== 导入相关类型 ====================

export type DataFileType = 'fullParams' | 'geoData' | 'layers';

export interface ImportResult {
  success: boolean;
  fileType: DataFileType;
  fileName: string;
  message: string;
  data?: any;
  count?: number;
  skipStats?: {
    lte: SkipStats;
    nr: SkipStats;
  };
}

/** 异常行详情 */
export interface SkipDetail {
  /** 数据行号（从1开始，不含表头） */
  rowNumber: number;
  /** 小区名称（可能为空） */
  sectorName: string;
  /** 跳过原因 */
  reason: string;
}

/** 数据行跳过原因统计 */
export interface SkipStats {
  /** 表头之后的数据行总数 */
  totalDataRows: number;
  /** 空行 */
  emptyRow: number;
  /** 基站标识为空 */
  missingSiteId: number;
  /** 小区标识为空 */
  missingSectorId: number;
  /** 经纬度无效（非数字或空） */
  invalidLatLng: number;
  /** 经纬度不在中国范围 73-135 / 18-53 */
  outOfRange: number;
  /** (siteId, sectorId) 重复行 */
  duplicate: number;
  /** 异常行详情列表 */
  skipDetails: SkipDetail[];
}

export interface ImportProgress {
  fileName: string;
  progress: number;
  status: 'parsing' | 'processing' | 'done' | 'error';
  message: string;
}

// ==================== 解析中间类型 ====================

/** 解析后的站点数据 */
export interface ParsedSite {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  networkType: 'LTE' | 'NR';
  sectors: ParsedSector[];
}

/** 解析后的小区数据 */
export interface ParsedSector {
  id: string;
  siteId: string;
  name: string;
  longitude: number;
  latitude: number;
  azimuth?: number;
  beamwidth?: number;
  height?: number;
  pci?: number;
  earfcn?: number;
  ssbFrequency?: number;
  tac?: number;
  cell_cover_type?: number | string;
  is_shared?: string;
  mcc?: string;
  mnc?: string;
}

/** GeoJSON Feature */
export interface GeoJsonFeature {
  type: 'Feature';
  geometry: {
    type: 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon';
    coordinates: number[] | number[][] | number[][][];
  };
  properties: Record<string, any>;
}

/** GeoJSON FeatureCollection */
export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

// ==================== MIF 解析相关类型 ====================

export interface MifGeometry {
  type: 'Point' | 'Line' | 'Polyline' | 'Region' | 'Text' | 'None';
  coordinates: number[] | number[][] | number[][][];
}

export interface MifFeature {
  geometry: MifGeometry;
  properties: Record<string, any>;
}

export interface MifParseResult {
  success: boolean;
  features: GeoJsonFeature[];
  columnNames: string[];
  message?: string;
}
