import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { wgs84ToGcj02 } from '../utils/coordinate';
import {
  ParsedSite, ParsedSector, GeoJsonFeature, GeoJsonFeatureCollection,
  MifParseResult, DataFileType
} from '../types/data';

// ==================== 字段检测器 ====================

const FIELD_PATTERNS: Record<string, string[]> = {
  longitude: ['经度', 'longitude', 'lng', 'lon', 'long', 'Coord_X', '经度x', 'lngx', 'longx'],
  latitude: ['纬度', 'latitude', 'lat', 'Coord_Y', '纬度y', 'laty'],
  azimuth: ['方位角', 'azimuth', 'azi', 'azim', '方向角', '方向', 'Angle', '角度',
    'azimuthangle', 'bearing', 'direction', 'heading', '扇区方向', '扇区方位', '天线方位', '天线方向'],
  beamwidth: ['波束宽度', 'beamwidth', 'beam_width', '水平波束角', '水平波束宽度', '水平波束', '波束角',
    '扇区角度', '扇区宽度', 'sectorwidth', 'sector_width'],
  cell_cover_type: ['覆盖类型', 'cell_cover_type', '小区覆盖类型', '小区类型', 'indoor', 'outdoor', 'is_indoor'],
  name: ['名称', 'name', '小区名', '站名', 'SiteName', 'CellName', '站点名称', '小区名称',
    'cell_name', 'site_name', '小区标识', '站点标识', 'cellid', 'siteid'],
  polygon: ['polygon'],
};

const LTE_COLUMN_MAP: Record<string, string[]> = {
  site_id: ['eNodeB标识', 'eNodeBID', 'eNodeB ID', 'eNodeB标识ID', '基站ID', '网元ID', 'CGI', 'CGI\n', 'Site ID', 'SiteID', 'Site Id'],
  site_name: ['基站名称', 'eNodeB Name', 'Site Name'],
  longitude: ['基站经度', '经度', '小区经度', 'Longitude', 'Long', 'Lng', 'Lon', 'Coord X', 'Coord_X', 'X坐标'],
  latitude: ['基站纬度', '纬度', '小区纬度', 'Latitude', 'Lat', 'Coord Y', 'Coord_Y', 'Y坐标'],
  sector_id: ['小区标识', '小区ID', 'Cell ID', 'CellID', 'Cell Id', 'Sector ID', 'SectorID', 'CGI', 'CGI\n'],
  sector_name: ['小区名称', 'Cell Name', 'Sector Name'],
  azimuth: ['天线方向角', '方位角', 'Azimuth', 'Bearing', 'Direction'],
  height: ['天线挂高', '挂高', 'Height', 'Antenna Height'],
  pci: ['物理小区识别码', 'PCI', 'PCI分组编号', 'Physical Cell ID'],
  earfcn: ['下行链路的中心载频', 'EARFCN', 'Center Frequency', 'CenterFrequency', 'Earfcn'],
  tac: ['跟踪区码', 'TAC', 'Tracking Area Code', 'TAC码'],
  cell_cover_type: ['小区覆盖类型', 'Coverage Type', 'CellCoverType'],
  is_shared: ['是否共享', 'Is Shared', 'Shared'],
  first_group: ['第一分组', 'First Group', 'GroupI'],
};

const NR_COLUMN_MAP: Record<string, string[]> = {
  site_id: ['gNodeB标识', 'gNodeBID', 'gNodeB ID', 'gNodeB标识ID', '基站ID', '管理网元ID', '网元ID', 'CGI', 'CGI\n', 'Site ID', 'SiteID'],
  site_name: ['基站名称', 'gNodeB Name', 'Site Name'],
  longitude: ['基站经度', 'gNodeB Longitude', '经度', '小区经度', 'Longitude', 'Long', 'Lng', 'Lon', 'Coord X', 'X坐标'],
  latitude: ['基站纬度', 'gNodeB Latitude', '纬度', '小区纬度', 'Latitude', 'Lat', 'Coord Y', 'Y坐标'],
  sector_id: ['小区标识', '小区ID', 'Cell ID', 'CellID', 'Cell Id', 'Sector ID', 'SectorID', 'CGI', 'CGI\n'],
  sector_name: ['小区名称', 'Cell Name', 'Sector Name'],
  azimuth: ['天线方向角', '方位角', 'Azimuth', 'Bearing', 'Direction'],
  height: ['天线挂高', '挂高', 'Height', 'Antenna Height'],
  pci: ['物理小区识别码', 'PCI', 'PCI分组编号', 'Physical Cell ID'],
  ssb_frequency: ['填写SSB频点', 'SSB频点', 'SSB Frequency', 'SSB Frequency\nLong', 'SSB Freq', 'SSB ARFCN', 'NR Frequency'],
  tac: ['跟踪区码', 'TAC', 'Tracking Area Code', 'TAC码'],
  cell_cover_type: ['小区覆盖类型', 'Coverage Type', 'CellCoverType'],
  is_shared: ['是否共享', 'Is Shared', 'Shared'],
  mcc: ['移动国家码', 'MCC', 'Mobile Country Code'],
  mnc: ['移动网络码', 'MNC', 'Mobile Network Code'],
  first_group: ['第一分组', 'First Group', 'GroupI'],
};

// ==================== 工具函数 ====================

function findColumn(headers: string[], possibleNames: string[]): string | null {
  const lowered = headers.map(h => h.trim().toLowerCase().split('\n')[0].trim());
  for (const pn of possibleNames) {
    const pnLower = pn.toLowerCase().trim();
    // Exact match first
    const idx = lowered.indexOf(pnLower);
    if (idx >= 0) return headers[idx];
    // Try partial match (header contains pattern or pattern contains header base)
    // 关键:空字符串 header 不应被当作"匹配任何 pattern",否则所有列都会映射到空 header
    for (let i = 0; i < lowered.length; i++) {
      const headerBase = lowered[i];
      if (!headerBase) continue; // 跳过空 header
      if (headerBase.includes(pnLower) || pnLower.includes(headerBase)) {
        return headers[i];
      }
    }
  }
  return null;
}

function classifyFile(filename: string): 'full_params' | 'default';
function classifyFile(filename: string, sheetNames?: string[]): 'full_params' | 'default';
function classifyFile(filename: string, sheetNames?: string[]): 'full_params' | 'default' {
  const lower = filename.toLowerCase();

  // 待规划小区
  if (lower.startsWith('cell-tree-export')) return 'default';

  // 方式1: 检查 sheet 名称（与桌面端一致）
  if (sheetNames && sheetNames.length > 0) {
    const hasLteParams = sheetNames.some(s =>
      s.toLowerCase().includes('lte project parameters')
    );
    const hasNrParams = sheetNames.some(s =>
      s.toLowerCase().includes('nr project parameters')
    );
    if (hasLteParams || hasNrParams) return 'full_params';
  }

  // 方式2: 检查文件名特征
  const hasProjectParam = lower.includes('projectparameter') || lower.includes('mongoose');
  const hasTimestamp = /\d{10,}/.test(lower);
  if (hasProjectParam || hasTimestamp) return 'full_params';

  return 'default';
}

function detectFields(headers: string[]): Record<string, string | null> {
  const detected: Record<string, string | null> = {};
  for (const [fieldName, patterns] of Object.entries(FIELD_PATTERNS)) {
    let found: string | null = null;
    for (const col of headers) {
      const colLower = col.toLowerCase();
      for (const p of patterns) {
        if (colLower.includes(p.toLowerCase())) {
          found = col;
          break;
        }
      }
      if (found) break;
    }
    detected[fieldName] = found;
  }
  // Determine geometry type
  if (detected.polygon) {
    detected.geometry_type = 'polygon';
  } else if (detected.azimuth) {
    detected.geometry_type = 'sector';
  } else {
    detected.geometry_type = 'point';
  }
  return detected;
}

function safeParseFloat(val: any): number | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  const n = Number(val);
  return isNaN(n) ? undefined : n;
}

// ==================== 全量工参解析 ====================

export function parseFullParamsExcel(arrayBuffer: ArrayBuffer, filename: string): {
  lteSites: ParsedSite[];
  nrSites: ParsedSite[];
  lteCount: { sites: number; sectors: number };
  nrCount: { sites: number; sectors: number };
} {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetNames = workbook.SheetNames;

  const lteSheet = sheetNames.find(s => s.toLowerCase().includes('lte project parameters'));
  const nrSheet = sheetNames.find(s => s.toLowerCase().includes('nr project parameters'));

  const lteSites = lteSheet ? parseFullParamsSheet(workbook, lteSheet, 'LTE') : [];
  const nrSites = nrSheet ? parseFullParamsSheet(workbook, nrSheet, 'NR') : [];

  return {
    lteSites,
    nrSites,
    lteCount: {
      sites: lteSites.length,
      sectors: lteSites.reduce((sum, s) => sum + s.sectors.length, 0),
    },
    nrCount: {
      sites: nrSites.length,
      sectors: nrSites.reduce((sum, s) => sum + s.sectors.length, 0),
    },
  };
}

export function parseFullParamsSheet(
  workbook: XLSX.WorkBook,
  sheetName: string,
  networkType: 'LTE' | 'NR',
  preparsedRows?: any[][]
): ParsedSite[] {
  // 当 preparsedRows 已提供时（手动 XML 回退路径），跳过 workbook.Sheets 检查
  if (!preparsedRows) {
    if (!workbook || !workbook.Sheets) {
      console.warn('[DataParser] parseFullParamsSheet: workbook or workbook.Sheets is undefined');
      return [];
    }
  }

  const sheet = preparsedRows ? undefined : workbook.Sheets[sheetName];
  if (!sheet && !preparsedRows) {
    console.warn('[DataParser] Sheet not found:', sheetName, 'Available sheets:', Object.keys(workbook?.Sheets || {}));
    return [];
  }

  // Get raw data to analyze header structure
  let rawData: any[][];
  if (preparsedRows) {
    rawData = preparsedRows;
  } else {
    if (!sheet || typeof sheet !== 'object') {
      console.warn('[DataParser] Sheet is not an object:', typeof sheet);
      return [];
    }
    try {
      rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    } catch (e: any) {
      console.error('[DataParser] sheet_to_json failed:', e);
      return [];
    }
  }

  if (__DEV__) {
    console.log(`[DataParser] parseFullParamsSheet sheet="${sheetName}" rawData rows: ${rawData.length}, cols: ${rawData[0]?.length || 0}`);
    console.log(`[DataParser] parseFullParamsSheet sheet="${sheetName}" first row:`, JSON.stringify(rawData[0]?.slice(0, 10) || []));
  }

  if (rawData.length < 2) return [];

  // 标准化表头:同时按 \n 和 &#10;(HTML entity,十进制换行符)切,取首段作为主标题
  // xlsx 共享字符串里大量使用 &#10; 编码多行字段描述,只 split('\n') 切不动
  const cleanHeader = (c: any) => {
    const s = String(c ?? '').trim();
    return s.split(/\n|&#10;|\r/i)[0].trim();
  };

  // Detect header row: 要求同一行同时包含经度/纬度/站点ID特征列
  // 扩展到前 10 行(有些工参文件前几行是元数据,表头在 row[2] 或更后)
  const HEADER_SCAN_LIMIT = 10;
  let headerRow = -1;

  for (let i = 0; i < Math.min(HEADER_SCAN_LIMIT, rawData.length); i++) {
    const row = rawData[i].map(cleanHeader);
    if (__DEV__) console.log(`[DataParser] parseFullParamsSheet sheet="${sheetName}" row[${i}]:`, JSON.stringify(row.slice(0, 8)));
    const hasLon = row.some(h => /经度|longitude|lng|lon/i.test(h));
    const hasLat = row.some(h => /纬度|latitude|lat/i.test(h));
    const hasId = row.some(h => /eNodeB|gNodeB|基站ID|网元ID|CGI|site.*id|cell.*id|小区ID|小区标识/i.test(h));
    if (hasLon && hasLat && hasId) {
      headerRow = i;
      break;
    }
  }

  if (headerRow < 0) {
    // Fallback: 在前 HEADER_SCAN_LIMIT 行中找匹配列数最多的行
    // 关键加权:lat/lng 命中额外 +100 分,避免纯描述行(中文"是否现网"等)赢得胜利
    // (mongoose 工参 row[0] 描述行中文多,row[2] 英文列名含 "Latitude" 等更准确)
    const columnMap = networkType === 'LTE' ? LTE_COLUMN_MAP : NR_COLUMN_MAP;
    let bestRow = 0;
    let bestScore = -1;
    for (let i = 0; i < Math.min(HEADER_SCAN_LIMIT, rawData.length); i++) {
      const row = rawData[i].map(cleanHeader);
      let count = 0;
      let latLngHits = 0;
      for (const [key, patterns] of Object.entries(columnMap)) {
        if (findColumn(row, patterns)) {
          count++;
          if (key === 'longitude' || key === 'latitude') latLngHits++;
        }
      }
      // lat/lng 命中权重大(100 分),其他列匹配 1 分;这样 row[2] 含 "Latitude" 会比 row[0] 描述行优先
      const score = count + latLngHits * 100;
      if (score > bestScore) { bestScore = score; bestRow = i; }
    }
    if (bestScore <= 0) {
      if (__DEV__) console.warn(`[DataParser] parseFullParamsSheet sheet="${sheetName}" fallback 未找到任何匹配列,返回空`);
      return [];
    }
    if (__DEV__) console.log(`[DataParser] parseFullParamsSheet sheet="${sheetName}" fallback 选中 row[${bestRow}] (score=${bestScore})`);
    const cleaned = mergeHeadersWithDescriptionRow(rawData[0], rawData[bestRow]);
    return parseRowsWithHeaders(rawData.slice(bestRow + 1), cleaned, networkType);
  }

  // mongoose 工参文件的表头由多行组成:
  // row[0] 是中文描述行(基站名称、是否共享等),row[2] 是英文列名(eNodeB ID、Cell ID 等)。
  // 偶数 col (0,2,4,...) 由 row[0] 提供中文,奇数 col (1,3,5,...) 由 row[headerRow] 提供英文。
  // 必须把两行合并,row[headerRow] 优先级高(row[0] 只补空缺)
  const headers = mergeHeadersWithDescriptionRow(rawData[0], rawData[headerRow]);
  const dataRows = rawData.slice(headerRow + 1);
  return parseRowsWithHeaders(dataRows, headers, networkType);
}

/**
 * 把 row[0] (中文描述行) 和 row[headerRow] (英文列名行) 合并成完整的 headers 数组。
 * row[headerRow] 优先级高,只在它该位置是空字符串时才用 row[0] 的值补上。
 * 这样 mongoose 工参那种"交错列定义"的结构能被正确识别。
 */
function mergeHeadersWithDescriptionRow(descriptionRow: any[], headerRow: any[]): string[] {
  const maxLen = Math.max(descriptionRow?.length || 0, headerRow?.length || 0);
  const merged: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const d = descriptionRow?.[i] ?? '';
    const h = headerRow?.[i] ?? '';
    const ds = String(d).trim();
    const hs = String(h).trim();
    if (hs) {
      merged.push(hs);
    } else if (ds) {
      merged.push(ds);
    } else {
      merged.push('');
    }
  }
  if (__DEV__) {
    console.log(`[DataParser] mergeHeadersWithDescriptionRow 合并前 description:`, JSON.stringify((descriptionRow || []).slice(0, 12)));
    console.log(`[DataParser] mergeHeadersWithDescriptionRow 合并前 headerRow:`, JSON.stringify((headerRow || []).slice(0, 12)));
    console.log(`[DataParser] mergeHeadersWithDescriptionRow 合并后:`, JSON.stringify(merged.slice(0, 12)));
  }
  return merged;
}

function parseRowsWithHeaders(rows: any[][], headers: string[], networkType: 'LTE' | 'NR'): ParsedSite[] {
  const columnMap = networkType === 'LTE' ? LTE_COLUMN_MAP : NR_COLUMN_MAP;

  if (__DEV__) {
    console.log(`[DataParser] parseRowsWithHeaders networkType=${networkType} headers:`, JSON.stringify(headers.slice(0, 10)));
  }

  const colIndices: Record<string, number> = {};
  for (const [key, patterns] of Object.entries(columnMap)) {
    const found = findColumn(headers, patterns);
    // 必须 found 非空字符串且非 null:之前用 !== null 会让空 header 被当成"找到",错误把所有列映射到 column 1
    if (found != null && found !== '') {
      colIndices[key] = headers.indexOf(found);
      if (__DEV__) console.log(`[DataParser] parseRowsWithHeaders found colIndices["${key}"] = ${colIndices[key]} (header: "${found}")`);
    }
  }
  if (__DEV__) console.log(`[DataParser] parseRowsWithHeaders colIndices:`, JSON.stringify(colIndices));

  // DEBUG: 打印前 3 个 data row 的关键列值,定位为什么 siteId/lng/lat 全是空
  if (__DEV__) {
    for (let i = 0; i < Math.min(3, rows.length); i++) {
      const r: any[] = rows[i];
      const sample: Record<string, any> = {
        rowLen: r.length,
        siteId_cell9: r[colIndices.site_id],
        lon_cell10: r[colIndices.longitude],
        lat_cell20: r[colIndices.latitude],
        // 扩大 fullRow 显示范围到 50 cells,看真正的 lat 在 col 35-50 哪里
        fullRow: r.slice(0, 50),
      };
      console.log(`[DataParser] parseRowsWithHeaders dataRow[${i}]:`, JSON.stringify(sample));
    }
  }

  const siteMap = new Map<string, ParsedSite>();

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    // mongoose 工参文件 eNodeB ID 列经常是空的,实际标识在 site_name 列(如"F河源东源船塘流石")
    // 兜底顺序:site_id → site_name → sector_id → sector_name → rowIndex
    const siteId = String(
      row[colIndices.site_id]
      || row[colIndices.site_name]
      || row[colIndices.sector_id]
      || row[colIndices.sector_name]
      || `auto_${rowIdx}`
    ).trim();
    if (!siteId) continue;

    const siteName = String(row[colIndices.site_name] || row[colIndices.site_id] || '').trim();
    let lng = safeParseFloat(row[colIndices.longitude]);
    let lat = safeParseFloat(row[colIndices.latitude]);

    // Sanity check:如果 lat 看起来像经度(> 90)或超出有效纬度范围,可能是列错位
    // (e.g. col 20 header 是 "eNodeB Latitude" 但实际数据存的是经度 114.96)
    // 这种情况 lat > 90 一定是错位,跟 lng 互换
    if (lat !== undefined && Math.abs(lat) > 90) {
      const tmp = lng;
      lng = lat;
      lat = tmp;
    }

    // 兜底:经纬度列错位 ±N 时,扫附近几列找有效值
    // 关键:azimuth 是整数(0/30/60/120/...),lat 几乎都是小数(23.5/39.8/...)
    // 用 v !== Math.floor(v) 排除整数 azimuth,避免 col 23 (azimuth=40) 被误判为 lat
    // 范围扩到 ±50,覆盖 col 25-50 区域(本文件中真 lat 可能在 col 35+ 之外)
    if (lng === undefined || lat === undefined) {
      for (let dx of [-1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -7, 7, -10, 10, -15, 15, -20, 20, -25, 25, -30, 30, -40, 40, -50, 50]) {
        if (lng === undefined && colIndices.longitude !== undefined) {
          const v = safeParseFloat(row[colIndices.longitude + dx]);
          if (v !== undefined && Math.abs(v) > 50 && Math.abs(v) <= 180) lng = v;
        }
        if (lat === undefined && colIndices.latitude !== undefined) {
          const v = safeParseFloat(row[colIndices.latitude + dx]);
          if (v !== undefined && v !== Math.floor(v) && Math.abs(v) > 15 && Math.abs(v) <= 60) lat = v;
        }
        if (lng !== undefined && lat !== undefined) break;
      }
    }
    // 最后兜底:扫整行找非整数、范围 15-60 的值当 lat
    // 排除:已用作 lng/lat 的列、site/sector ID/Name 列(可能含数字串如"5G")
    if (lat === undefined) {
      const skipCols = new Set<number>();
      for (const key of ['site_id', 'site_name', 'sector_id', 'sector_name', 'longitude', 'latitude'] as const) {
        const c = colIndices[key];
        if (c !== undefined) skipCols.add(c);
      }
      for (let i = 0; i < row.length; i++) {
        if (skipCols.has(i)) continue;
        const v = safeParseFloat(row[i]);
        if (v !== undefined && v !== Math.floor(v) && Math.abs(v) > 15 && Math.abs(v) <= 60) {
          lat = v;
          break;
        }
      }
    }

    if (lng === undefined || lat === undefined) continue;

    // 范围校验:经度必须 73-135,纬度必须 18-53 (中国范围,排除 azimuth/其他数字误判)
    if (lng < 73 || lng > 135 || lat < 18 || lat > 53) continue;

    let site = siteMap.get(siteId);
    if (!site) {
      site = {
        id: siteId,
        name: siteName,
        longitude: lng,
        latitude: lat,
        networkType,
        sectors: [],
      };
      siteMap.set(siteId, site);
    }

    const sectorId = String(row[colIndices.sector_id] || '').trim();
    const sectorName = String(row[colIndices.sector_name] || '').trim();

    const sector: ParsedSector = {
      id: sectorId,
      siteId,
      name: sectorName || `${siteName}_${sectorId}`,
      longitude: lng,
      latitude: lat,
      azimuth: safeParseFloat(row[colIndices.azimuth]),
      height: safeParseFloat(row[colIndices.height]),
      pci: safeParseFloat(row[colIndices.pci]),
      earfcn: safeParseFloat(row[colIndices.earfcn]),
      ssbFrequency: safeParseFloat(row[colIndices.ssb_frequency]),
      tac: safeParseFloat(row[colIndices.tac]),
      cell_cover_type: safeParseFloat(row[colIndices.cell_cover_type]),
      is_shared: String(row[colIndices.is_shared] || '').trim(),
      mcc: String(row[colIndices.mcc] || '').trim(),
      mnc: String(row[colIndices.mnc] || '').trim(),
    };

    site.sectors.push(sector);
  }

  return Array.from(siteMap.values());
}

/**
 * 解析工参行数据，直接产出扁平扇区数组（跳过 ParsedSite 中间结构）
 * 大文件优化：避免构建 siteMap → ParsedSite[] → flattenSectors 的多层拷贝
 * @returns sectors — 扁平扇区数组，siteIds — 去重站点 ID 集合（用于计数）
 */
export function parseRowsToFlatSectors(
  rows: any[][],
  headers: string[],
  networkType: 'LTE' | 'NR'
): { sectors: any[]; siteIds: Set<string> } {
  const columnMap = networkType === 'LTE' ? LTE_COLUMN_MAP : NR_COLUMN_MAP;

  const colIndices: Record<string, number> = {};
  for (const [key, patterns] of Object.entries(columnMap)) {
    const found = findColumn(headers, patterns);
    if (found != null && found !== '') {
      colIndices[key] = headers.indexOf(found);
    }
  }

  const sectors: any[] = [];
  const siteIds = new Set<string>();

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];

    // siteId 兜底: site_id → site_name → sector_id → sector_name → auto_index
    // 与 parseRowsWithHeaders 保持一致，避免空 siteId 导致整行被跳过
    const siteId = String(
      row[colIndices.site_id]
      || row[colIndices.site_name]
      || row[colIndices.sector_id]
      || row[colIndices.sector_name]
      || `auto_${rowIdx}`
    ).trim();
    if (!siteId || siteId === `auto_${rowIdx}` && !row[colIndices.site_id] && !row[colIndices.site_name] && !row[colIndices.sector_id] && !row[colIndices.sector_name]) continue;

    let lng = safeParseFloat(row[colIndices.longitude]);
    let lat = safeParseFloat(row[colIndices.latitude]);

    // 列错位检测: lat > 90 一定是错位，跟 lng 互换
    if (lat !== undefined && Math.abs(lat) > 90) {
      const tmp = lng;
      lng = lat;
      lat = tmp;
    }

    // 兜底: 经纬度列错位 ±N 时，扫附近几列找有效值
    // 与 parseRowsWithHeaders 保持一致
    if (lng === undefined || lat === undefined) {
      for (let dx of [-1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -7, 7, -10, 10, -15, 15, -20, 20, -25, 25, -30, 30, -40, 40, -50, 50]) {
        if (lng === undefined && colIndices.longitude !== undefined) {
          const v = safeParseFloat(row[colIndices.longitude + dx]);
          if (v !== undefined && Math.abs(v) > 50 && Math.abs(v) <= 180) lng = v;
        }
        if (lat === undefined && colIndices.latitude !== undefined) {
          const v = safeParseFloat(row[colIndices.latitude + dx]);
          if (v !== undefined && v !== Math.floor(v) && Math.abs(v) > 15 && Math.abs(v) <= 60) lat = v;
        }
        if (lng !== undefined && lat !== undefined) break;
      }
    }

    // 最后兜底: 扫整行找非整数、范围 15-60 的值当 lat
    if (lat === undefined) {
      const skipCols = new Set<number>();
      for (const key of ['site_id', 'site_name', 'sector_id', 'sector_name', 'longitude', 'latitude'] as const) {
        const c = colIndices[key];
        if (c !== undefined) skipCols.add(c);
      }
      for (let i = 0; i < row.length; i++) {
        if (skipCols.has(i)) continue;
        const v = safeParseFloat(row[i]);
        if (v !== undefined && v !== Math.floor(v) && Math.abs(v) > 15 && Math.abs(v) <= 60) {
          lat = v;
          break;
        }
      }
    }

    if (lng === undefined || lat === undefined) continue;

    // 范围校验: 经度 73-135，纬度 18-53 (中国范围)
    if (lng < 73 || lng > 135 || lat < 18 || lat > 53) continue;

    siteIds.add(siteId);

    const siteName = String(row[colIndices.site_name] || row[colIndices.site_id] || '').trim();
    const sectorId = String(row[colIndices.sector_id] || '').trim();
    const sectorName = String(row[colIndices.sector_name] || '').trim();

    sectors.push({
      id: sectorId,
      siteId,
      name: sectorName || `${siteName}_${sectorId}`,
      longitude: lng,
      latitude: lat,
      azimuth: safeParseFloat(row[colIndices.azimuth]),
      height: safeParseFloat(row[colIndices.height]),
      pci: safeParseFloat(row[colIndices.pci]),
      earfcn: safeParseFloat(row[colIndices.earfcn]),
      ssbFrequency: safeParseFloat(row[colIndices.ssb_frequency]),
      tac: safeParseFloat(row[colIndices.tac]),
      cell_cover_type: safeParseFloat(row[colIndices.cell_cover_type]),
      is_shared: String(row[colIndices.is_shared] || '').trim(),
      mcc: String(row[colIndices.mcc] || '').trim(),
      mnc: String(row[colIndices.mnc] || '').trim(),
      networkType,
    });
  }

  return { sectors, siteIds };
}

// ==================== 地理化数据解析 ====================

export function parseGeoDataExcel(arrayBuffer: ArrayBuffer, filename: string): {
  features: GeoJsonFeature[];
  pointCount: number;
  geometryType: string;
} {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const jsonData: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (jsonData.length === 0) {
    return { features: [], pointCount: 0, geometryType: 'point' };
  }

  const headers = Object.keys(jsonData[0]);
  const fields = detectFields(headers);

  // Validate coordinates
  const lonCol = fields.longitude;
  const latCol = fields.latitude;
  const polygonCol = fields.polygon;

  if (fields.geometry_type === 'polygon' && polygonCol) {
    return parsePolygonData(jsonData, fields, headers);
  }

  if (!lonCol || !latCol) {
    // Try to detect from the actual column names more aggressively
    const fallbackLon = headers.find(h => /经|long|lng|lon|x/i.test(h));
    const fallbackLat = headers.find(h => /纬|lat|y/i.test(h));
    if (fallbackLon && fallbackLat) {
      return parsePointData(jsonData, { ...fields, longitude: fallbackLon, latitude: fallbackLat }, headers);
    }
    return { features: [], pointCount: 0, geometryType: 'point' };
  }

  return parsePointData(jsonData, fields, headers);
}

function parsePointData(
  data: Record<string, any>[],
  fields: Record<string, string | null>,
  allHeaders: string[]
): { features: GeoJsonFeature[]; pointCount: number; geometryType: string } {
  const features: GeoJsonFeature[] = [];
  const lonCol = fields.longitude!;
  const latCol = fields.latitude!;
  const aziCol = fields.azimuth;
  const nameCol = fields.name;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const lng = safeParseFloat(row[lonCol]);
    const lat = safeParseFloat(row[latCol]);

    if (lng === undefined || lat === undefined) continue;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) continue;

    const props: Record<string, any> = {};
    for (const h of allHeaders) {
      if (h !== lonCol && h !== latCol && h !== polygonCol(h, fields)) {
        props[h] = row[h];
      }
    }

    // Add computed fields
    if (aziCol && safeParseFloat(row[aziCol]) !== undefined) {
      props.azimuth = safeParseFloat(row[aziCol]);
    }

    const name = nameCol && row[nameCol] ? String(row[nameCol]) : `点_${i + 1}`;
    props.name = name;
    props.label = name;

    // Coordinate conversion for display
    const [displayLat, displayLng] = wgs84ToGcj02(lat, lng);

    const feature: GeoJsonFeature = {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [displayLng, displayLat],
      },
      properties: props,
    };

    features.push(feature);
  }

  const geometryType = aziCol && features.length > 0 ? 'sector' : 'point';
  return { features, pointCount: features.length, geometryType };
}

function polygonCol(col: string, fields: Record<string, string | null>): string {
  return fields.polygon || '';
}

function parsePolygonData(
  data: Record<string, any>[],
  fields: Record<string, string | null>,
  allHeaders: string[]
): { features: GeoJsonFeature[]; pointCount: number; geometryType: string } {
  const features: GeoJsonFeature[] = [];
  const polygonColName = fields.polygon;
  const nameCol = fields.name;

  if (!polygonColName) {
    return { features: [], pointCount: 0, geometryType: 'polygon' };
  }

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const polygonStr = String(row[polygonColName] || '').trim();
    if (!polygonStr) continue;

    // Parse "lng lat, lng lat, ..." format
    const coordPairs = polygonStr.match(/(\d+\.?\d*)\s+(\d+\.?\d*)/g);
    if (!coordPairs || coordPairs.length < 3) continue;

    const coordinates: number[][] = [];
    for (const pair of coordPairs) {
      const parts = pair.match(/(\d+\.?\d*)\s+(\d+\.?\d*)/);
      if (parts) {
        const lng = parseFloat(parts[1]);
        const lat = parseFloat(parts[2]);
        const [gcjLat, gcjLng] = wgs84ToGcj02(lat, lng);
        coordinates.push([gcjLng, gcjLat]);
      }
    }

    if (coordinates.length < 3) continue;

    // Close the polygon
    coordinates.push(coordinates[0]);

    const props: Record<string, any> = {};
    for (const h of allHeaders) {
      if (h !== polygonColName) props[h] = row[h];
    }
    props.name = nameCol && row[nameCol] ? String(row[nameCol]) : `多边形_${i + 1}`;

    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [coordinates],
      },
      properties: props,
    });
  }

  return { features, pointCount: features.length, geometryType: 'polygon' };
}

// ==================== CSV 解析 ====================

export function parseCsvData(
  csvContent: string,
  filename: string
): { features: GeoJsonFeature[]; pointCount: number; geometryType: string } {
  const result = Papa.parse(csvContent, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });

  if (result.errors.length > 0) {
    console.warn('[DataParser] CSV parse warnings:', result.errors);
  }

  if (!result.data || result.data.length === 0) {
    return { features: [], pointCount: 0, geometryType: 'point' };
  }

  const headers = Object.keys(result.data[0] as Record<string, any>);
  const fields = detectFields(headers);

  const lonCol = fields.longitude;
  const latCol = fields.latitude;

  if (!lonCol || !latCol) {
    return { features: [], pointCount: 0, geometryType: 'point' };
  }

  // Use the same point parsing logic
  return parsePointData(result.data as Record<string, any>[], fields, headers);
}

// ==================== GeoJSON 解析 ====================

export function parseGeoJsonFile(
  jsonContent: string
): GeoJsonFeatureCollection | null {
  try {
    const parsed = JSON.parse(jsonContent);

    // Validate structure
    if (parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
      return parsed as GeoJsonFeatureCollection;
    }

    // Single feature wrapping
    if (parsed.type === 'Feature') {
      return {
        type: 'FeatureCollection',
        features: [parsed as GeoJsonFeature],
      };
    }

    // Array of features
    if (Array.isArray(parsed)) {
      return {
        type: 'FeatureCollection',
        features: parsed as GeoJsonFeature[],
      };
    }

    return null;
  } catch (e) {
    console.error('[DataParser] GeoJSON parse error:', e);
    return null;
  }
}

// ==================== MIF 解析器 ====================

export function parseMifMidFile(
  mifContent: string,
  midContent?: string
): MifParseResult {
  try {
    const lines = mifContent.split('\n');
    let i = 0;

    // Skip header
    const columnNames: string[] = [];
    let inColumns = false;
    let inData = false;
    const rawFeatures: { geomType: string; geomLines: string[]; props: string[] }[] = [];

    while (i < lines.length) {
      const line = lines[i].trim();

      if (line.startsWith('COLUMNS') || line.startsWith('Columns')) {
        inColumns = true;
        i++;
        continue;
      }

      if (inColumns) {
        if (line.startsWith('DATA') || line.startsWith('data')) {
          inColumns = false;
          inData = true;
          i++;
          continue;
        }
        // Parse column definition: "name type"
        const colMatch = line.match(/^(\S+)\s/);
        if (colMatch) {
          columnNames.push(colMatch[1]);
        }
        i++;
        continue;
      }

      if (inData) {
        if (/^(POINT|LINE|PLINE|REGION|TEXT|NONE)\s/i.test(line) || line === '') {
          if (line === '') {
            i++;
            continue;
          }
          // Start of a new geometry
          const geomType = line.split(/\s+/)[0].toUpperCase();
          const feature: { geomType: string; geomLines: string[]; props: string[] } = {
            geomType,
            geomLines: [line],
            props: [],
          };
          i++;

          // Collect geometry lines until next geometry or end
          while (i < lines.length) {
            const nextLine = lines[i].trim();
            if (/^(POINT|LINE|PLINE|REGION|TEXT|NONE)\s/i.test(nextLine) || nextLine === '') {
              break;
            }
            feature.geomLines.push(nextLine);
            i++;
          }
          rawFeatures.push(feature);
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    // Parse MID data if available
    const midValues: string[][] = [];
    if (midContent) {
      const midLines = midContent.split('\n').filter(l => l.trim());
      for (const midLine of midLines) {
        // MID values are separated by commas
        const vals = midLine.split(',');
        midValues.push(vals.map(v => v.trim().replace(/^"|"$/g, '')));
      }
    }

    // Convert parsed features to GeoJSON
    const features: GeoJsonFeature[] = [];

    for (let fi = 0; fi < rawFeatures.length; fi++) {
      const rf = rawFeatures[fi];
      const geoJson = mifGeometryToGeoJson(rf.geomType, rf.geomLines);
      if (!geoJson) continue;

      // Apply MID properties if available
      const props: Record<string, any> = {};
      if (fi < midValues.length && columnNames.length > 0) {
        for (let ci = 0; ci < columnNames.length && ci < midValues[fi].length; ci++) {
          props[columnNames[ci]] = midValues[fi][ci];
        }
      }

      features.push({
        type: 'Feature',
        geometry: geoJson,
        properties: props,
      });
    }

    return {
      success: true,
      features,
      columnNames,
    };
  } catch (e: any) {
    console.error('[DataParser] MIF parse error:', e);
    return {
      success: false,
      features: [],
      columnNames: [],
      message: `MIF解析失败: ${e.message}`,
    };
  }
}

function mifGeometryToGeoJson(
  geomType: string,
  lines: string[]
): { type: 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon'; coordinates: any } | null {
  switch (geomType) {
    case 'POINT': {
      // POINT x y
      const parts = lines[0].split(/\s+/);
      if (parts.length >= 3) {
        return {
          type: 'Point',
          coordinates: [parseFloat(parts[1]), parseFloat(parts[2])],
        };
      }
      return null;
    }

    case 'LINE': {
      // LINE x1 y1 x2 y2
      const parts = lines[0].split(/\s+/);
      if (parts.length >= 5) {
        return {
          type: 'LineString',
          coordinates: [
            [parseFloat(parts[1]), parseFloat(parts[2])],
            [parseFloat(parts[3]), parseFloat(parts[4])],
          ],
        };
      }
      return null;
    }

    case 'PLINE': {
      // PLINE [MULTIPLE] \n numSections \n numPoints \n x1 y1 ...
      // Default single section
      let lineIdx = 1; // skip "PLINE"
      const isMultiple = lines[0].toLowerCase().includes('multiple');
      if (isMultiple) {
        const numSections = parseInt(lines[lineIdx] || '1');
        lineIdx++;
        let allCoords: number[][][] = [];
        for (let s = 0; s < numSections; s++) {
          const numPoints = parseInt(lines[lineIdx] || '0');
          lineIdx++;
          const coords: number[][] = [];
          for (let p = 0; p < numPoints && lineIdx < lines.length; p++) {
            const [, x, y] = lines[lineIdx].match(/(-?\d+\.?\d*)\s+(-?\d+\.?\d*)/) || [];
            if (x && y) {
              coords.push([parseFloat(x), parseFloat(y)]);
            }
            lineIdx++;
          }
          if (coords.length > 0) allCoords.push(coords);
        }
        if (allCoords.length === 1) {
          return { type: 'LineString', coordinates: allCoords[0] };
        }
        return { type: 'MultiLineString', coordinates: allCoords };
      } else {
        // Single PLINE
        const numPoints = parseInt(lines[1] || '0');
        const coords: number[][] = [];
        for (let p = 0; p < numPoints && p + 2 < lines.length; p++) {
          const [, x, y] = lines[p + 2].match(/(-?\d+\.?\d*)\s+(-?\d+\.?\d*)/) || [];
          if (x && y) coords.push([parseFloat(x), parseFloat(y)]);
        }
        return { type: 'LineString', coordinates: coords };
      }
    }

    case 'REGION': {
      // REGION \n numPolygons \n numPoints \n x1 y1 ...
      const numPolygons = parseInt(lines[1] || '1');
      let lineIdx = 2;
      const allCoords: number[][][] = [];
      for (let p = 0; p < numPolygons; p++) {
        const numPoints = parseInt(lines[lineIdx] || '0');
        lineIdx++;
        const coords: number[][] = [];
        for (let pt = 0; pt < numPoints && lineIdx < lines.length; pt++) {
          const [, x, y] = lines[lineIdx].match(/(-?\d+\.?\d*)\s+(-?\d+\.?\d*)/) || [];
          if (x && y) coords.push([parseFloat(x), parseFloat(y)]);
          lineIdx++;
        }
        // Close polygon
        if (coords.length > 0) {
          coords.push(coords[0]);
          allCoords.push(coords);
        }
      }
      if (allCoords.length === 1) {
        return { type: 'Polygon', coordinates: allCoords };
      }
      return { type: 'MultiPolygon', coordinates: [allCoords] };
    }

    case 'NONE':
      return { type: 'Point', coordinates: [0, 0] };

    default:
      return null;
  }
}

// ==================== 入口函数 ====================

export async function parseImportedFile(
  arrayBuffer: ArrayBuffer,
  filename: string
): Promise<{
  fileType: DataFileType;
  data: any;
  count: number;
  message: string;
}> {
  const ext = filename.split('.').pop()?.toLowerCase();
  const nameLower = filename.toLowerCase();

  if (ext === 'xlsx' || ext === 'xls') {
    // 先读取 workbook 获取 sheet 名称（与桌面端一致）
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const sheetNames = workbook.SheetNames;

    // 使用 sheet 名称判断文件类型（与桌面端完全一致）
    const fileType = classifyFile(filename, sheetNames);
    if (fileType === 'full_params') {
      const result = parseFullParamsExcel(arrayBuffer, filename);
      return {
        fileType: 'fullParams',
        data: result,
        count: result.lteCount.sites + result.nrCount.sites,
        message: `全量工参解析完成：LTE ${result.lteCount.sites}站/${result.lteCount.sectors}小区，NR ${result.nrCount.sites}站/${result.nrCount.sectors}小区`,
      };
    }

    // Geo data
    const geoResult = parseGeoDataExcel(arrayBuffer, filename);
    if (geoResult.features.length > 0) {
      return {
        fileType: 'geoData',
        data: geoResult,
        count: geoResult.pointCount,
        message: `地理化数据解析完成：${geoResult.pointCount}个${geoResult.geometryType === 'polygon' ? '多边形' : geoResult.geometryType === 'sector' ? '扇区' : '点'}`,
      };
    }

    return {
      fileType: 'geoData',
      data: null,
      count: 0,
      message: '未能解析文件内容，请确认文件格式与桌面端一致',
    };
  }

  if (ext === 'csv') {
    const textContent = new TextDecoder('utf-8').decode(arrayBuffer);
    const csvResult = parseCsvData(textContent, filename);
    return {
      fileType: 'geoData',
      data: csvResult,
      count: csvResult.pointCount,
      message: `CSV解析完成：${csvResult.pointCount}个点`,
    };
  }

  if (ext === 'geojson') {
    const textContent = new TextDecoder('utf-8').decode(arrayBuffer);
    const geojson = parseGeoJsonFile(textContent);
    if (geojson) {
      return {
        fileType: 'layers',
        data: geojson,
        count: geojson.features.length,
        message: `GeoJSON解析完成：${geojson.features.length}个要素`,
      };
    }
    return {
      fileType: 'layers',
      data: null,
      count: 0,
      message: 'GeoJSON格式无效',
    };
  }

  if (ext === 'mif') {
    const mifContent = new TextDecoder('utf-8').decode(arrayBuffer);
    const result = parseMifMidFile(mifContent);
    if (result.success) {
      return {
        fileType: 'layers',
        data: { type: 'FeatureCollection', features: result.features },
        count: result.features.length,
        message: `MIF解析完成：${result.features.length}个要素`,
      };
    }
    return {
      fileType: 'layers',
      data: null,
      count: 0,
      message: result.message || 'MIF解析失败',
    };
  }

  if (ext === 'mid') {
    return {
      fileType: 'layers',
      data: null,
      count: 0,
      message: 'MID文件需要与对应的MIF文件一起使用',
    };
  }

  return {
    fileType: 'layers',
    data: null,
    count: 0,
    message: `不支持的文件格式: .${ext}`,
  };
}

export function sectorsToGeoJson(sites: ParsedSite[], networkType: 'LTE' | 'NR'): GeoJsonFeatureCollection {
  const features: GeoJsonFeature[] = [];

  for (const site of sites) {
    for (const sector of site.sectors) {
      const [gcjLat, gcjLng] = wgs84ToGcj02(sector.latitude, sector.longitude);
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [gcjLng, gcjLat],
        },
        properties: {
          id: sector.id,
          name: sector.name,
          siteId: sector.siteId,
          networkType,
          azimuth: sector.azimuth,
          pci: sector.pci,
          earfcn: sector.earfcn,
          tac: sector.tac,
          height: sector.height,
        },
      });
    }
  }

  return { type: 'FeatureCollection', features };
}

export { detectFields, classifyFile };
