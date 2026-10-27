/**
 * 流式Excel/CSV解析器 - 大文件优化
 * 支持分块读取、渐进解析、内存优化
 */

import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { wgs84ToGcj02 } from '../utils/coordinate';
import { GeoJsonFeature } from '../types/data';

// 批处理大小配置
const BATCH_SIZE = 2000; // 每批处理的行数
const YIELD_INTERVAL = 100; // 每处理多少行让出一次主线程

export interface ParseProgress {
  totalRows: number;
  processedRows: number;
  percentage: number;
  currentBatch: number;
  totalBatches: number;
}

export interface StreamingParseOptions {
  onProgress?: (progress: ParseProgress) => void;
  onBatch?: (features: GeoJsonFeature[], batchIndex: number) => Promise<void> | void;
  batchSize?: number;
  coordinateFields?: {
    longitude: string[];
    latitude: string[];
    name?: string[];
  };
}

export interface StreamingParseResult {
  features: GeoJsonFeature[];
  totalCount: number;
  geometryType: 'point' | 'sector' | 'polygon';
  headers: string[];
}

// 让出主线程
const yieldToUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * 检测字段映射
 */
function detectCoordinateFields(headers: string[]): { longitude: string; latitude: string; name?: string } | null {
  const lonPatterns = ['经度', 'longitude', 'lng', 'lon', 'long', 'coord_x', 'x', '经度x', 'lngx', 'longx'];
  const latPatterns = ['纬度', 'latitude', 'lat', 'coord_y', 'y', '纬度y', 'laty'];
  const namePatterns = ['名称', 'name', '小区名', '站名', 'sitename', 'cellname', '站点名称', '小区名称', 'cell_name', 'site_name', '小区标识', '站点标识', 'cellid', 'siteid'];

  const headersLower = headers.map(h => String(h).toLowerCase().trim());

  let longitude: string | undefined;
  let latitude: string | undefined;
  let name: string | undefined;

  // 查找经度字段
  for (const pattern of lonPatterns) {
    const idx = headersLower.findIndex(h => h.includes(pattern));
    if (idx >= 0) {
      longitude = headers[idx];
      break;
    }
  }

  // 查找纬度字段
  for (const pattern of latPatterns) {
    const idx = headersLower.findIndex(h => h.includes(pattern));
    if (idx >= 0) {
      latitude = headers[idx];
      break;
    }
  }

  // 查找名称字段
  for (const pattern of namePatterns) {
    const idx = headersLower.findIndex(h => h.includes(pattern));
    if (idx >= 0) {
      name = headers[idx];
      break;
    }
  }

  if (!longitude || !latitude) {
    return null;
  }

  return { longitude, latitude, name };
}

/**
 * 安全解析浮点数
 */
function safeParseFloat(val: any): number | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  const n = Number(val);
  return isNaN(n) ? undefined : n;
}

/**
 * 将一行数据转换为GeoJSON Feature
 */
function rowToFeature(
  row: any,
  headers: string[],
  fields: { longitude: string; latitude: string; name?: string },
  rowIndex: number
): GeoJsonFeature | null {
  const lonIdx = headers.indexOf(fields.longitude);
  const latIdx = headers.indexOf(fields.latitude);

  if (lonIdx < 0 || latIdx < 0) return null;

  const lon = safeParseFloat(row[lonIdx]);
  const lat = safeParseFloat(row[latIdx]);

  if (lon === undefined || lat === undefined) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;

  // 坐标转换 WGS84 -> GCJ-02
  const [gcjLat, gcjLng] = wgs84ToGcj02(lat, lon);

  // 构建属性对象
  const props: Record<string, any> = {};
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    if (header !== fields.longitude && header !== fields.latitude) {
      props[header] = row[i];
    }
  }

  // 设置名称
  if (fields.name) {
    const nameIdx = headers.indexOf(fields.name);
    if (nameIdx >= 0 && row[nameIdx]) {
      props.name = String(row[nameIdx]);
      props.label = String(row[nameIdx]);
    }
  }
  if (!props.name) {
    props.name = `点_${rowIndex + 1}`;
    props.label = `点_${rowIndex + 1}`;
  }

  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [gcjLng, gcjLat],
    },
    properties: props,
  };
}

/**
 * 流式解析Excel文件 - 按批次处理
 */
export async function parseExcelStreaming(
  arrayBuffer: ArrayBuffer,
  options: StreamingParseOptions = {}
): Promise<StreamingParseResult> {
  const { onProgress, onBatch, batchSize = BATCH_SIZE } = options;

  // 第一步：读取工作簿结构（只读元数据，不读内容）
  const workbook = XLSX.read(arrayBuffer, {
    type: 'array',
    sheetRows: 0, // 不预读行数据
  });

  if (!workbook.SheetNames.length) {
    throw new Error('Excel文件中没有工作表');
  }

  // 选择第一个工作表
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  if (!sheet) {
    throw new Error(`无法读取工作表: ${sheetName}`);
  }

  // 读取表头（前5行）
  const headerData = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    range: 0,
    defval: '',
  }) as any[][];

  if (headerData.length < 1) {
    throw new Error('工作表为空');
  }

  // 检测表头行
  let headerRowIndex = 0;
  let headers: string[] = [];

  for (let i = 0; i < Math.min(5, headerData.length); i++) {
    const row = headerData[i].map((c: any) => String(c).trim());
    const hasLon = row.some(h => /经度|longitude|lng|lon/i.test(h));
    const hasLat = row.some(h => /纬度|latitude|lat/i.test(h));

    if (hasLon && hasLat) {
      headerRowIndex = i;
      headers = row;
      break;
    }
  }

  if (headers.length === 0) {
    headers = headerData[0].map((c: any) => String(c).trim());
  }

  // 检测坐标字段
  const fields = detectCoordinateFields(headers);
  if (!fields) {
    throw new Error('无法识别经纬度字段，请确保文件包含经度/纬度列');
  }

  // 获取数据行范围(0-based)与最大列号
  // decode_range 返回的 s.r/e.r 都是 0-based 行索引,直接用 e.r 作为末行
  const ref = sheet['!ref'];
  let firstDataRow = headerRowIndex + 1; // 数据起始行(0-based)
  let lastDataRow = firstDataRow;        // 数据末行(0-based,含),下面会修正
  let maxCol = 0;
  if (ref) {
    const rangeInfo = XLSX.utils.decode_range(ref);
    // e.r 是 ref 的最后一行(0-based),header 不一定在 s.r(可能被空行隔开)
    // 我们仍然只读取 header 之后的数据,这样最保守
    lastDataRow = Math.max(rangeInfo.e.r, firstDataRow);
    maxCol = rangeInfo.e.c;
  }

  // 如果没有 ref(空 sheet),尝试完整读取一次获取真实范围(小文件回退)
  if (!ref) {
    const fullData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
    if (fullData.length > headerRowIndex) {
      lastDataRow = fullData.length - 1;
      // 用实际行长度推断列数
      maxCol = Math.max(...fullData.slice(headerRowIndex + 1).map(r => r.length)) - 1;
    }
  }

  const dataRowCount = Math.max(0, lastDataRow - firstDataRow + 1);
  const totalBatches = Math.max(1, Math.ceil(dataRowCount / batchSize));
  const allFeatures: GeoJsonFeature[] = [];

  // 分块读取数据
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const startRow = firstDataRow + batchIndex * batchSize;
    const endRow = Math.min(startRow + batchSize - 1, lastDataRow);

    // 关键修复:用 {s,e} 范围对象限定本次读取的行列边界,
    // 避免每次都从 startRow 读到 sheet 末尾(O(N²) 内存分配)
    const batchData = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      range: { s: { r: startRow, c: 0 }, e: { r: endRow, c: maxCol } },
      defval: '',
    }) as any[][];

    // 转换为GeoJSON Features
    const batchFeatures: GeoJsonFeature[] = [];
    for (let i = 0; i < batchData.length; i++) {
      const row = batchData[i];
      const globalRowIndex = batchIndex * batchSize + i;

      const feature = rowToFeature(row, headers, fields, globalRowIndex);
      if (feature) {
        batchFeatures.push(feature);
      }

      // 定期让出主线程
      if (i % YIELD_INTERVAL === 0 && i > 0) {
        await yieldToUI();
      }
    }

    allFeatures.push(...batchFeatures);

    // 回调通知
    const processedRows = (batchIndex + 1) * batchSize;
    const progress: ParseProgress = {
      totalRows: lastDataRow - firstDataRow + 1,
      processedRows: Math.min(processedRows, lastDataRow - firstDataRow + 1),
      percentage: Math.min(100, Math.round(((batchIndex + 1) / totalBatches) * 100)),
      currentBatch: batchIndex + 1,
      totalBatches,
    };

    onProgress?.(progress);

    if (onBatch) {
      await onBatch(batchFeatures, batchIndex);
    }

    // 每批处理后让出主线程(batchData 会在下一轮迭代被覆盖,旧引用自然不可达)
    await yieldToUI();
  }

  return {
    features: allFeatures,
    totalCount: allFeatures.length,
    geometryType: 'point',
    headers,
  };
}

/**
 * 流式解析CSV文件 - 使用PapaParse的chunk模式
 */
export async function parseCsvStreaming(
  csvContent: string,
  options: StreamingParseOptions = {}
): Promise<StreamingParseResult> {
  const { onProgress, onBatch, batchSize = BATCH_SIZE } = options;

  return new Promise((resolve, reject) => {
    const allFeatures: GeoJsonFeature[] = [];
    let headers: string[] = [];
    let fields: { longitude: string; latitude: string; name?: string } | null = null;
    let totalRows = 0;
    let currentBatch: GeoJsonFeature[] = [];
    let batchIndex = 0;

    Papa.parse(csvContent, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      chunkSize: 1024 * 64, // 64KB chunks
      chunk: async (results, parser) => {
        // 第一次获取表头
        if (headers.length === 0 && results.meta.fields) {
          headers = results.meta.fields;
          fields = detectCoordinateFields(headers);

          if (!fields) {
            parser.abort();
            reject(new Error('无法识别经纬度字段'));
            return;
          }
        }

        const rows = results.data as any[];

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          totalRows++;

          // 将对象转换为数组格式
          const rowArray = headers.map(h => row[h]);
          const feature = rowToFeature(rowArray, headers, fields!, totalRows - 1);

          if (feature) {
            currentBatch.push(feature);
          }

          // 批次满了就处理
          if (currentBatch.length >= batchSize) {
            allFeatures.push(...currentBatch);

            if (onBatch) {
              await onBatch([...currentBatch], batchIndex);
            }

            batchIndex++;
            currentBatch = [];

            // 让出主线程
            await yieldToUI();
          }
        }

        // 进度回调
        onProgress?.({
          totalRows: totalRows + rows.length, // 预估
          processedRows: totalRows,
          percentage: -1, // 未知总进度
          currentBatch: batchIndex,
          totalBatches: -1,
        });
      },
      complete: async () => {
        // 处理最后一批
        if (currentBatch.length > 0) {
          allFeatures.push(...currentBatch);
          if (onBatch) {
            await onBatch(currentBatch, batchIndex);
          }
        }

        resolve({
          features: allFeatures,
          totalCount: allFeatures.length,
          geometryType: 'point',
          headers,
        });
      },
      error: (error) => {
        reject(new Error(`CSV解析错误: ${error.message}`));
      },
    });
  });
}

/**
 * 智能解析 - 根据文件类型自动选择解析方式
 */
export async function parseFileStreaming(
  arrayBuffer: ArrayBuffer,
  filename: string,
  options: StreamingParseOptions = {}
): Promise<StreamingParseResult> {
  const ext = filename.split('.').pop()?.toLowerCase();

  if (ext === 'csv') {
    const textContent = new TextDecoder('utf-8').decode(arrayBuffer);
    return parseCsvStreaming(textContent, options);
  }

  if (ext === 'xlsx' || ext === 'xls') {
    return parseExcelStreaming(arrayBuffer, options);
  }

  throw new Error(`不支持的文件格式: .${ext}`);
}

/**
 * 估算文件是否为"大文件"（需要流式处理）
 */
export function isLargeFile(fileSize: number, rowEstimate?: number): boolean {
  // 文件大于5MB或预估行数超过5000视为大文件
  if (fileSize > 5 * 1024 * 1024) return true;
  if (rowEstimate && rowEstimate > 5000) return true;
  return false;
}
