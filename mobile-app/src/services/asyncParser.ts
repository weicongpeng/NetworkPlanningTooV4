/**
 * 异步解析器 - 在React Native环境中避免主线程阻塞
 * 使用InteractionManager和分片执行来保持UI响应
 */

import { InteractionManager } from 'react-native';
import * as XLSX from 'xlsx';
import * as Papa from 'papaparse';
import { wgs84ToGcj02 } from '../utils/coordinate';
import { GeoJsonFeature } from '../types/data';

export interface AsyncParseOptions {
  onProgress?: (progress: { processed: number; total: number; percentage: number }) => void;
  chunkSize?: number;
  yieldInterval?: number;
}

// 让出主线程 - 使用Promise.resolve确保异步执行
const yieldToMainThread = () => new Promise<void>(resolve => {
  // 使用setImmediate在React Native中让出主线程
  if (typeof setImmediate !== 'undefined') {
    setImmediate(resolve);
  } else {
    setTimeout(resolve, 0);
  }
});

// 等待交互空闲
const waitForInteraction = () => new Promise<void>(resolve => {
  if (InteractionManager && typeof InteractionManager.runAfterInteractions === 'function') {
    InteractionManager.runAfterInteractions(() => resolve());
  } else {
    setTimeout(resolve, 16); // 约一帧的时间
  }
});

/**
 * 分片处理数组
 */
export async function processInChunks<T, R>(
  items: T[],
  processor: (item: T, index: number) => R | null,
  options: AsyncParseOptions = {}
): Promise<R[]> {
  const { chunkSize = 100, yieldInterval = 50 } = options;
  const results: R[] = [];

  for (let i = 0; i < items.length; i++) {
    const result = processor(items[i], i);
    if (result !== null) {
      results.push(result);
    }

    // 定期让出主线程
    if (i % yieldInterval === 0 && i > 0) {
      await yieldToMainThread();
    }

    // 进度回调
    if (i % chunkSize === 0 && options.onProgress) {
      options.onProgress({
        processed: i,
        total: items.length,
        percentage: Math.round((i / items.length) * 100),
      });
    }
  }

  // 最终进度
  options.onProgress?.({
    processed: items.length,
    total: items.length,
    percentage: 100,
  });

  return results;
}

/**
 * 异步解析Excel文件
 */
export async function parseExcelAsync(
  arrayBuffer: ArrayBuffer,
  options: AsyncParseOptions = {}
): Promise<{ features: GeoJsonFeature[]; totalCount: number }> {
  // 第一步：在工作线程中解析工作簿结构
  await waitForInteraction();

  const workbook = XLSX.read(arrayBuffer, { type: 'array' });

  if (!workbook.SheetNames.length) {
    throw new Error('Excel文件中没有工作表');
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  if (!sheet) {
    throw new Error(`无法读取工作表: ${sheetName}`);
  }

  await yieldToMainThread();

  // 读取所有数据
  const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as any[][];

  if (rawData.length < 2) {
    return { features: [], totalCount: 0 };
  }

  // 检测表头
  const headers = rawData[0].map((h: any) => String(h).trim());

  // 查找经纬度字段
  const lonCol = headers.findIndex(h => /经度|longitude|lng|lon/i.test(String(h)));
  const latCol = headers.findIndex(h => /纬度|latitude|lat/i.test(String(h)));
  const nameCol = headers.findIndex(h => /名称|name|小区名|站名/i.test(String(h)));

  if (lonCol < 0 || latCol < 0) {
    throw new Error('无法识别经纬度字段');
  }

  // 异步处理数据行
  const dataRows = rawData.slice(1);

  const features = await processInChunks(
    dataRows,
    (row, index) => {
      const lon = parseFloat(row[lonCol]);
      const lat = parseFloat(row[latCol]);

      if (isNaN(lon) || isNaN(lat)) return null;
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;

      // 坐标转换
      const [gcjLat, gcjLng] = wgs84ToGcj02(lat, lon);

      // 构建属性
      const props: Record<string, any> = {};
      for (let i = 0; i < headers.length; i++) {
        if (i !== lonCol && i !== latCol) {
          props[headers[i]] = row[i];
        }
      }

      const name = nameCol >= 0 ? String(row[nameCol] || '') : `点_${index + 1}`;
      props.name = name || `点_${index + 1}`;
      props.label = props.name;

      return {
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [gcjLng, gcjLat],
        },
        properties: props,
      };
    },
    options
  );

  return { features, totalCount: features.length };
}

/**
 * 异步解析CSV文件
 */
export async function parseCsvAsync(
  csvContent: string,
  options: AsyncParseOptions = {}
): Promise<{ features: GeoJsonFeature[]; totalCount: number }> {
  return new Promise((resolve, reject) => {
    Papa.parse(csvContent, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      complete: async (results) => {
        try {
          if (!results.data || results.data.length === 0) {
            resolve({ features: [], totalCount: 0 });
            return;
          }

          const headers = results.meta.fields || [];

          // 查找经纬度字段
          const lonCol = headers.find(h => /经度|longitude|lng|lon/i.test(String(h)));
          const latCol = headers.find(h => /纬度|latitude|lat/i.test(String(h)));
          const nameCol = headers.find(h => /名称|name|小区名|站名/i.test(String(h)));

          if (!lonCol || !latCol) {
            reject(new Error('无法识别经纬度字段'));
            return;
          }

          const data = results.data as any[];

          const features = await processInChunks(
            data,
            (row, index) => {
              const lon = parseFloat(row[lonCol]);
              const lat = parseFloat(row[latCol]);

              if (isNaN(lon) || isNaN(lat)) return null;
              if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;

              // 坐标转换
              const [gcjLat, gcjLng] = wgs84ToGcj02(lat, lon);

              // 构建属性
              const props: Record<string, any> = {};
              for (const key of headers) {
                if (key !== lonCol && key !== latCol) {
                  props[key] = row[key];
                }
              }

              const name = nameCol ? String(row[nameCol] || '') : `点_${index + 1}`;
              props.name = name || `点_${index + 1}`;
              props.label = props.name;

              return {
                type: 'Feature' as const,
                geometry: {
                  type: 'Point' as const,
                  coordinates: [gcjLng, gcjLat],
                },
                properties: props,
              };
            },
            options
          );

          resolve({ features, totalCount: features.length });
        } catch (error) {
          reject(error);
        }
      },
      error: (error) => {
        reject(new Error(`CSV解析错误: ${error.message}`));
      },
    });
  });
}

/**
 * 智能异步解析
 */
export async function parseFileAsync(
  arrayBuffer: ArrayBuffer,
  filename: string,
  options: AsyncParseOptions = {}
): Promise<{ features: GeoJsonFeature[]; totalCount: number }> {
  const ext = filename.split('.').pop()?.toLowerCase();

  if (ext === 'csv') {
    const textContent = new TextDecoder('utf-8').decode(arrayBuffer);
    return parseCsvAsync(textContent, options);
  }

  if (ext === 'xlsx' || ext === 'xls') {
    return parseExcelAsync(arrayBuffer, options);
  }

  throw new Error(`不支持的文件格式: .${ext}`);
}

// ==================== 全量工参异步解析 ====================

/**
 * 全量工参异步解析结果
 */
export interface FullParamsAsyncResult {
  lteSectors: any[];
  nrSectors: any[];
  lteSiteCount: number;
  nrSiteCount: number;
  lteSectorCount: number;
  nrSectorCount: number;
}

/**
 * 异步分片解析全量工参 sheet 数据
 * 使用 processInChunks 分片处理，避免大文件阻塞主线程
 *
 * @param rows 已解析的二维数组（sheet_to_json 结果，header:1）
 * @param headers 表头数组
 * @param networkType 'LTE' | 'NR'
 * @param options 异步解析选项
 */
export async function parseFullParamsSheetAsync(
  rows: any[][],
  headers: string[],
  networkType: 'LTE' | 'NR',
  options: AsyncParseOptions = {}
): Promise<{ sectors: any[]; siteCount: number; sectorCount: number }> {
  await waitForInteraction();

  if (!rows || rows.length < 2) {
    return { sectors: [], siteCount: 0, sectorCount: 0 };
  }

  // 检测字段映射
  const fields = detectFullParamsFields(headers);
  if (!fields) {
    return { sectors: [], siteCount: 0, sectorCount: 0 };
  }

  const dataRows = rows.slice(1); // 跳过表头

  // 分片处理每行数据，定期让出主线程
  const sectorResults = await processInChunks(
    dataRows,
    (row: any[], index: number) => {
      const sector = mapRowToSector(row, headers, fields, networkType);
      return sector;
    },
    { ...options, chunkSize: options.chunkSize || 200, yieldInterval: options.yieldInterval || 100 }
  );

  // 过滤掉 null 结果并统计
  const sectors = sectorResults.filter((s: any) => s !== null);
  const siteIds = new Set<string>();
  for (const s of sectors) {
    if (s.siteId) siteIds.add(s.siteId);
  }

  return {
    sectors,
    siteCount: siteIds.size,
    sectorCount: sectors.length,
  };
}

/**
 * 完整的全量工参文件异步解析入口
 * 对 LTE 和 NR 两个 sheet 分别进行异步分片解析
 */
export async function parseFullParamsFileAsync(
  arrayBuffer: ArrayBuffer,
  options: AsyncParseOptions & {
    lteSheetName?: string;
    nrSheetName?: string;
    onSheetProgress?: (sheet: 'LTE' | 'NR', progress: number) => void;
  } = {}
): Promise<FullParamsAsyncResult> {
  await waitForInteraction();

  // 读取工作簿（不传 sheetRows，使用默认行为读取全部数据）
  // 注意：xlsx@0.18.x 中 sheetRows:0 在某些场景下行为异常，可能导致 !ref 范围不正确
  const workbook = XLSX.read(arrayBuffer, {
    type: 'array',
  });

  if (!workbook.SheetNames.length) {
    throw new Error('Excel文件中没有工作表');
  }

  const lteSheetName = options.lteSheetName ||
    workbook.SheetNames.find((s: string) => s.toLowerCase().includes('lte project parameters'));
  const nrSheetName = options.nrSheetName ||
    workbook.SheetNames.find((s: string) => s.toLowerCase().includes('nr project parameters'));

  let lteSectors: any[] = [];
  let nrSectors: any[] = [];
  let lteSiteCount = 0;
  let nrSiteCount = 0;
  let lteSectorCount = 0;
  let nrSectorCount = 0;

  // 计算总进度基数，用于全局进度（避免 LTE 100% → NR 0% 回退）
  const lteSheet = lteSheetName ? workbook.Sheets[lteSheetName] : undefined;
  const nrSheet  = nrSheetName  ? workbook.Sheets[nrSheetName]  : undefined;
  const lteRowCount = lteSheet ? (XLSX.utils.decode_range(lteSheet['!ref'] || 'A1').e.r + 1) : 0;
  const nrRowCount  = nrSheet  ? (XLSX.utils.decode_range(nrSheet['!ref']  || 'A1').e.r + 1) : 0;
  const totalRows = lteRowCount + nrRowCount;
  let processedRows = 0;

  const emitGlobalProgress = () => {
    if (options.onProgress && totalRows > 0) {
      const pct = Math.round((processedRows / totalRows) * 100);
      options.onProgress({ processed: processedRows, total: totalRows, percentage: pct });
    }
  };

  // ===== 异步解析 LTE / NR sheet =====
  // 辅助函数：从 sheet_to_json 行数据解析（回退路径，需定义在 parseSheetDirect 之前）
  const parseSheetFromRows = (rows: any[][], netType: 'LTE' | 'NR') => {
    if (rows.length < 2) return null;
    const headerRow = (rows[0] || []).map((c: any) => String(c !== undefined ? c : '').trim().split('\n')[0].trim());
    const fields = detectFullParamsFields(headerRow);
    if (!fields) return null;
    const siteIds = new Set<string>();
    const sectors: any[] = [];
    let sectorCount = 0;
    for (let i = 1; i < rows.length; i++) {
      const sector = mapRowToSector(rows[i], headerRow, fields, netType);
      if (sector) {
        sectors.push(sector);
        if (sector.siteId) siteIds.add(sector.siteId);
        sectorCount++;
      }
    }
    return { sectors, siteIds, sectorCount };
  };

  // 辅助函数：直接迭代 sheet 行（高性能路径，无 yield）
  const parseSheetDirect = (sheet: XLSX.WorkSheet, _sheetName: string, netType: 'LTE' | 'NR') => {
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    // 防御：range 无数据行时（e.r <= s.r），回退到 sheet_to_json
    if (range.e.r <= range.s.r) {
      const fallbackRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as any[][];
      if (fallbackRows.length >= 2) {
        return parseSheetFromRows(fallbackRows, netType);
      }
      return null;
    }

    const headerRow: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c })];
      headerRow.push(cell ? String(cell.v).trim().split('\n')[0].trim() : '');
    }
    const fields = detectFullParamsFields(headerRow);
    const siteIds = new Set<string>();
    const sectors: any[] = [];
    let sectorCount = 0;

    for (let r = range.s.r + 1; r <= range.e.r; r++) {
      const row: any[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        row.push(cell !== undefined ? cell.v : '');
      }
      if (fields) {
        const sector = mapRowToSector(row, headerRow, fields, netType);
        if (sector) {
          sectors.push(sector);
          if (sector.siteId) siteIds.add(sector.siteId);
          sectorCount++;
        }
      }
    }
    return { sectors, siteIds, sectorCount };
  };

  if (lteSheet) {
    options.onSheetProgress?.('LTE', 0);
    const lteResult = parseSheetDirect(lteSheet, lteSheetName || 'LTE', 'LTE');
    if (lteResult) {
      lteSectors = lteResult.sectors;
      lteSiteCount = lteResult.siteIds.size;
      lteSectorCount = lteResult.sectorCount;
    }
    processedRows += lteRowCount;
    options.onSheetProgress?.('LTE', 100);
  }

  await yieldToMainThread();

  // ===== 异步解析 NR sheet =====
  if (nrSheet) {
    options.onSheetProgress?.('NR', 0);
    const nrResult = parseSheetDirect(nrSheet, nrSheetName || 'NR', 'NR');
    if (nrResult) {
      nrSectors = nrResult.sectors;
      nrSiteCount = nrResult.siteIds.size;
      nrSectorCount = nrResult.sectorCount;
    }
    processedRows += nrRowCount;
    options.onSheetProgress?.('NR', 100);
  }

  emitGlobalProgress();

  return {
    lteSectors,
    nrSectors,
    lteSiteCount,
    nrSiteCount,
    lteSectorCount,
    nrSectorCount,
  };
}

// ==================== 全量工参字段检测与行映射辅助函数 ====================

/**
 * 检测全量工参的字段映射（siteId / sectorId / longitude / latitude / name）
 */
function detectFullParamsFields(headers: string[]): {
  siteId: string;
  sectorId: string;
  longitude: string;
  latitude: string;
  name?: string;
} | null {
  const headersLower = headers.map(h => String(h).toLowerCase().trim());

  // ---- 站点ID ----
  let siteId = -1;
  const siteIdExact = ['enodeb id', 'gnodeb id', '基站id', '网元id', 'site id', '基站标识', '网元标识', 'cgi'];
  for (const p of siteIdExact) {
    siteId = headersLower.indexOf(p);
    if (siteId >= 0) break;
  }
  if (siteId < 0) {
    for (let i = 0; i < headersLower.length; i++) {
      if (/enodeb|gnodeb|基站id|网元id|site.*id|cgi/.test(headersLower[i])) { siteId = i; break; }
    }
  }

  // ---- 小区ID ----
  let sectorId = -1;
  const sectorIdExact = ['cell id', '小区id', '小区标识', 'sector id', 'cellid', 'cellid(local)'];
  for (const p of sectorIdExact) {
    sectorId = headersLower.indexOf(p);
    if (sectorId >= 0) break;
  }
  if (sectorId < 0) {
    for (let i = 0; i < headersLower.length; i++) {
      if (/cell.*id|小区id|sector.*id|小区标识/i.test(headersLower[i])) { sectorId = i; break; }
    }
  }

  // ---- 经度 ----
  let longitude = -1;
  for (const p of ['经度', 'longitude', 'lng', 'lon', '经度x', 'lngx', 'longx']) {
    longitude = headersLower.indexOf(p);
    if (longitude >= 0) break;
  }

  // ---- 纬度 ----
  let latitude = -1;
  for (const p of ['纬度', 'latitude', 'lat', '纬度y', 'laty']) {
    latitude = headersLower.indexOf(p);
    if (latitude >= 0) break;
  }

  // ---- 名称（可选） ----
  let name = -1;
  for (const p of ['name', '名称', '小区名', '站名', 'cell name', 'site name', '小区名称', '站点名称']) {
    name = headersLower.indexOf(p);
    if (name >= 0) break;
  }

  if (siteId < 0 || sectorId < 0 || longitude < 0 || latitude < 0) {
    return null;
  }

  return {
    siteId: headers[siteId],
    sectorId: headers[sectorId],
    longitude: headers[longitude],
    latitude: headers[latitude],
    name: name >= 0 ? headers[name] : undefined,
  };
}

/**
 * 将一行数据映射为扇区对象（与 parseRowsToFlatSectors 产出格式一致）
 */
function mapRowToSector(
  row: any[],
  headers: string[],
  fields: { siteId: string; sectorId: string; longitude: string; latitude: string; name?: string },
  networkType: 'LTE' | 'NR'
): any | null {
  const siteIdIdx = headers.indexOf(fields.siteId);
  const sectorIdIdx = headers.indexOf(fields.sectorId);
  const lonIdx = headers.indexOf(fields.longitude);
  const latIdx = headers.indexOf(fields.latitude);
  const nameIdx = fields.name ? headers.indexOf(fields.name) : -1;

  // 使用 ?? 避免 0 被 || 误判为空（cell.v 返回数字时，0 || '' → '' 会丢失有效值）
  const siteId = siteIdIdx >= 0 ? String(row[siteIdIdx] ?? '').trim() : '';
  const sectorId = sectorIdIdx >= 0 ? String(row[sectorIdIdx] ?? '').trim() : '';
  const lon = lonIdx >= 0 ? parseFloat(row[lonIdx]) : NaN;
  const lat = latIdx >= 0 ? parseFloat(row[latIdx]) : NaN;

  if (!siteId || !sectorId || isNaN(lon) || isNaN(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;

  const [gcjLat, gcjLng] = wgs84ToGcj02(lat, lon);

  const name = nameIdx >= 0 && row[nameIdx]
    ? String(row[nameIdx]).trim()
    : `${siteId}-${sectorId}`;

  // 构建扇区对象
  const sector: any = {
    siteId,
    sectorId,
    name,
    longitude: gcjLng,
    latitude: gcjLat,
    networkType,
  };

  // 保留其他列数据作为附加属性
  for (let i = 0; i < headers.length; i++) {
    if (i !== siteIdIdx && i !== sectorIdIdx && i !== lonIdx && i !== latIdx && i !== nameIdx) {
      const key = headers[i];
      if (key && row[i] !== undefined && row[i] !== '') {
        sector[key] = row[i];
      }
    }
  }

  return sector;
}
