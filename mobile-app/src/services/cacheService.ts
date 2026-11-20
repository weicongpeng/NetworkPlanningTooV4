import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiService } from './api';
import {
  CacheMeta, FullParamsCacheInfo, GeoDataCacheInfo, LayersCacheInfo,
  GeoDataItem, LayerItem, ImportResult, ImportProgress, GeoJsonFeatureCollection,
  DataFileType, SkipDetail
} from '../types/data';
import { parseImportedFile, parseFullParamsExcel, parseGeoDataExcel, parseFullParamsSheet, parseRowsToFlatSectors, detectFields } from './dataParser';
import { parseFileStreaming, isLargeFile, StreamingParseResult } from './streamingParser';
import { parseFileAsync } from './asyncParser';
import { wgs84ToGcj02 } from '../utils/coordinate';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

// JS 线程让出（防止大文件解析时 UI 卡死 / ANR）
const yieldToUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const CACHE_ROOT = `${FileSystem.documentDirectory}cache/`;
const CACHE_DIRS = {
  fullParams: `${FileSystem.documentDirectory}cache/fullParams/`,
  geoData: `${FileSystem.documentDirectory}cache/geoData/`,
  layers: `${FileSystem.documentDirectory}cache/layers/`,
  meta: `${FileSystem.documentDirectory}cache/meta/`,
};

const META_KEY = '@npt_cache_meta';
const FIRST_LAUNCH_KEY = '@npt_first_launch_done';

function formatDate(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// 跳过原因统计类型
type SkipStats = {
  totalDataRows: number;      // 表头之后的数据行总数
  emptyRow: number;            // 空行
  missingSiteId: number;       // 基站标识为空
  missingSectorId: number;     // 小区标识为空
  invalidLatLng: number;       // 经纬度无效（非数字或空）
  outOfRange: number;          // 经纬度不在中国范围 73-135 / 18-53
  duplicate: number;           // (siteId, sectorId) 重复
  skipDetails: SkipDetail[];   // 异常行详情
};

function createSkipStats(): SkipStats {
  return {
    totalDataRows: 0,
    emptyRow: 0,
    missingSiteId: 0,
    missingSectorId: 0,
    invalidLatLng: 0,
    outOfRange: 0,
    duplicate: 0,
    skipDetails: [],
  };
}

class CacheService {
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    // Create all cache directories
    for (const dir of Object.values(CACHE_DIRS)) {
      const info = await FileSystem.getInfoAsync(dir);
      if (!info.exists) {
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      }
    }
    this.initialized = true;
  }

  async isFirstLaunch(): Promise<boolean> {
    const val = await AsyncStorage.getItem(FIRST_LAUNCH_KEY);
    return val !== 'true';
  }

  async markFirstLaunchDone(): Promise<void> {
    await AsyncStorage.setItem(FIRST_LAUNCH_KEY, 'true');
  }

  async getMeta(): Promise<CacheMeta> {
    try {
      const json = await AsyncStorage.getItem(META_KEY);
      if (json) {
        return JSON.parse(json) as CacheMeta;
      }
    } catch (e) {
      console.error('[CacheService] Failed to read meta:', e);
    }
    return this.getDefaultMeta();
  }

  private getDefaultMeta(): CacheMeta {
    return {
      lastRefreshAt: null,
      dataTypes: { fullParams: false, geoData: false, layers: false },
      fullParamsInfo: null,
      geoDataInfo: null,
      layersInfo: null,
    };
  }

  async updateMeta(updater: (meta: CacheMeta) => CacheMeta): Promise<CacheMeta> {
    const meta = await this.getMeta();
    const updated = updater(meta);
    await AsyncStorage.setItem(META_KEY, JSON.stringify(updated));
    return updated;
  }

  // ==================== 首次启动缓存 ====================

  async cacheAllFromBackend(onProgress?: (msg: string) => void): Promise<boolean> {
    try {
      await this.init();

      // 1. Cache full params (sectors)
      onProgress?.('正在下载全量工参...');
      await this.cacheFullParamsFromBackend();
      onProgress?.('全量工参缓存完成');

      // 2. Cache geo data
      onProgress?.('正在下载地理化数据...');
      await this.cacheGeoDataFromBackend();
      onProgress?.('地理化数据缓存完成');

      // 3. Cache layers
      onProgress?.('正在下载图层文件...');
      await this.cacheLayersFromBackend();
      onProgress?.('图层文件缓存完成');

      return true;
    } catch (e) {
      console.error('[CacheService] Initial cache failed:', e);
      return false;
    }
  }

  // ==================== 后端下载缓存 ====================

  async cacheFullParamsFromBackend(): Promise<boolean> {
    try {
      const response = await apiService.getSectors(120000);
      if (!response.success || !response.data) return false;

      const data = {
        lte: response.data.lte || [],
        nr: response.data.nr || [],
      };

      const lteSectors = data.lte.length;
      const nrSectors = data.nr.length;

      // Save to file
      const jsonStr = JSON.stringify(data);
      await FileSystem.writeAsStringAsync(
        `${CACHE_DIRS.fullParams}sectors.json`,
        jsonStr
      );

      const lteSites = this.countSites(data.lte);
      const nrSites = this.countSites(data.nr);

      // 从数据列表中取源文件名
      let sourceFileName = '后端同步';
      try {
        const listResp = await apiService.getDataList();
        if (listResp.success) {
          const items = Array.isArray(listResp.data) ? listResp.data : listResp.data?.items || [];
          const fpItem = items.find((i: any) => i.fileType === 'full_params');
          if (fpItem?.name) sourceFileName = fpItem.name;
        }
      } catch { /* 忽略，使用默认名称 */ }

      await this.updateMeta(meta => ({
        ...meta,
        dataTypes: { ...meta.dataTypes, fullParams: true },
        lastRefreshAt: new Date().toISOString(),
        fullParamsInfo: {
          sourceFileName,
          lteSiteCount: lteSites,
          lteSectorCount: lteSectors,
          nrSiteCount: nrSites,
          nrSectorCount: nrSectors,
          cachedAt: new Date().toISOString(),
          fromPhone: false,
        },
      }));

      return true;
    } catch (e) {
      console.error('[CacheService] cacheFullParams failed:', e);
      return false;
    }
  }

  async cacheGeoDataFromBackend(): Promise<boolean> {
    try {
      const response = await apiService.getDataList();
      if (!response.success || !response.data) return false;

      const list = Array.isArray(response.data) ? response.data : response.data.items || [];
      const geoItems: GeoDataItem[] = [];
      let anyCached = false;

      for (const item of list) {
        if (item.fileType === 'geo_data' || item.geometryType != null) {
          try {
            const renderData = await apiService.getMobileRenderData(item.id);
            if (renderData.success && renderData.data) {
              const filename = `geo_${item.id}.json`;
              await FileSystem.writeAsStringAsync(
                `${CACHE_DIRS.geoData}${filename}`,
                JSON.stringify(renderData.data)
              );

              geoItems.push({
                name: item.name || item.id,
                pointCount: renderData.data.features?.length || 0,
                geometryType: renderData.data.dataType || item.geometryType || 'point',
                filePath: filename,
                cachedAt: new Date().toISOString(),
              });
              anyCached = true;
            }
          } catch (e) {
            console.warn(`[CacheService] Failed to cache geo item ${item.id}:`, e);
          }
        }
      }

      if (anyCached) {
        await this.updateMeta(meta => ({
          ...meta,
          dataTypes: { ...meta.dataTypes, geoData: true },
          lastRefreshAt: new Date().toISOString(),
          geoDataInfo: {
            items: geoItems,
            cachedAt: new Date().toISOString(),
            fromPhone: false,
          },
        }));
      }

      return anyCached;
    } catch (e) {
      console.error('[CacheService] cacheGeoData failed:', e);
      return false;
    }
  }

  async cacheLayersFromBackend(): Promise<boolean> {
    try {
      // Get layers info from data list
      const response = await apiService.getDataList();
      if (!response.success || !response.data) return false;

      const list = Array.isArray(response.data) ? response.data : response.data.items || [];
      const layerFiles = list.filter((item: any) =>
        item.type === 'map' || item.subType === 'mapinfo'
      );

      const layerItems: LayerItem[] = [];
      let anyCached = false;

      for (const file of layerFiles) {
        try {
          const layers = await apiService.getLayers(file.id);
          if (layers.success && layers.data) {
            const layerList = Array.isArray(layers.data) ? layers.data : [];
            for (const layer of layerList) {
              try {
                const layerData = await apiService.getLayerData(file.id, layer.id);
                if (layerData.success && layerData.data) {
                  const filename = `layer_${file.id}_${layer.id}.json`;
                  await FileSystem.writeAsStringAsync(
                    `${CACHE_DIRS.layers}${filename}`,
                    JSON.stringify(layerData.data)
                  );

                  layerItems.push({
                    name: layer.name || layer.id || filename,
                    layerType: layer.type || 'unknown',
                    filePath: filename,
                    cachedAt: new Date().toISOString(),
                  });
                  anyCached = true;
                }
              } catch (e) {
                console.warn(`[CacheService] Failed to cache layer ${layer.id}:`, e);
              }
            }
          }
        } catch (e) {
          console.warn(`[CacheService] Failed to cache layer file ${file.id}:`, e);
        }
      }

      if (anyCached) {
        await this.updateMeta(meta => ({
          ...meta,
          dataTypes: { ...meta.dataTypes, layers: true },
          lastRefreshAt: new Date().toISOString(),
          layersInfo: {
            items: layerItems,
            cachedAt: new Date().toISOString(),
            fromPhone: false,
          },
        }));
      }

      return anyCached;
    } catch (e) {
      console.error('[CacheService] cacheLayers failed:', e);
      return false;
    }
  }

  async refreshAllFromBackend(onProgress?: (msg: string) => void): Promise<boolean> {
    onProgress?.('正在刷新全量工参...');
    await this.cacheFullParamsFromBackend();

    onProgress?.('正在刷新地理化数据...');
    await this.cacheGeoDataFromBackend();

    onProgress?.('正在刷新图层文件...');
    await this.cacheLayersFromBackend();

    onProgress?.('刷新完成');
    return true;
  }

  // ==================== 本地读取 ====================

  async getCachedSectors(): Promise<{ lte: any[]; nr: any[] } | null> {
    try {
      const path = `${CACHE_DIRS.fullParams}sectors.json`;
      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists) return null;

      const jsonStr = await FileSystem.readAsStringAsync(path);
      return JSON.parse(jsonStr);
    } catch (e) {
      console.error('[CacheService] getCachedSectors failed:', e);
      return null;
    }
  }

  async getCachedGeoDataList(): Promise<{ name: string; features: any[] }[]> {
    try {
      const meta = await this.getMeta();
      if (!meta.geoDataInfo) return [];

      const results: { name: string; features: any[] }[] = [];
      for (const item of meta.geoDataInfo.items) {
        try {
          const jsonStr = await FileSystem.readAsStringAsync(
            `${CACHE_DIRS.geoData}${item.filePath}`
          );
          const data = JSON.parse(jsonStr);
          results.push({
            name: item.name,
            features: data.features || data || [],
          });
        } catch (e) {
          console.warn(`[CacheService] Failed to read geo data ${item.filePath}:`, e);
        }
      }
      return results;
    } catch (e) {
      console.error('[CacheService] getCachedGeoDataList failed:', e);
      return [];
    }
  }

  async getCachedLayerList(): Promise<{ name: string; features: any[] }[]> {
    try {
      const meta = await this.getMeta();
      if (!meta.layersInfo) return [];

      const results: { name: string; features: any[] }[] = [];
      for (const item of meta.layersInfo.items) {
        try {
          const jsonStr = await FileSystem.readAsStringAsync(
            `${CACHE_DIRS.layers}${item.filePath}`
          );
          const data = JSON.parse(jsonStr);
          const features = data.type === 'FeatureCollection' ? data.features : (data || []);
          results.push({
            name: item.name,
            features: Array.isArray(features) ? features : [],
          });
        } catch (e) {
          console.warn(`[CacheService] Failed to read layer ${item.filePath}:`, e);
        }
      }
      return results;
    } catch (e) {
      console.error('[CacheService] getCachedLayerList failed:', e);
      return [];
    }
  }

  // ==================== 文件导入 ====================

  async importFile(
    fileUri: string,
    fileName: string,
    onProgress?: (progress: ImportProgress) => void
  ): Promise<ImportResult> {
    const ext = fileName.split('.').pop()?.toLowerCase();

    console.log('[CacheService] importFile called:', fileName, 'ext:', ext);

    // ===================================================================
    // 校验 1: 文件扩展名必须为 xlsx 或 xls
    // ===================================================================
    if (ext !== 'xlsx' && ext !== 'xls') {
      return {
        success: false,
        fileType: 'fullParams',
        fileName,
        message: '仅支持 Excel 文件（.xlsx / .xls）',
      };
    }

    onProgress?.({ fileName, progress: 0, status: 'parsing', message: '正在读取文件...' });

    try {
      const fileInfo = await FileSystem.getInfoAsync(fileUri);
      if (!fileInfo.exists) {
        return { success: false, fileType: 'fullParams', fileName, message: '文件不存在' };
      }

      // ===== 读取文件为 base64 =====
      let base64Content = '';

      const SAF = (FileSystem as any).StorageAccessFramework;
      if (SAF && typeof SAF.readAsStringAsync === 'function') {
        try {
          const safResult = await SAF.readAsStringAsync(fileUri, FileSystem.EncodingType.Base64);
          if (safResult) {
            base64Content = typeof safResult === 'string' ? safResult : uint8ArrayToBase64(safResult as Uint8Array);
          }
        } catch (safReadErr) {
          console.warn('[CacheService] SAF read failed:', safReadErr);
        }
      }

      if (!base64Content) {
        try {
          const tempUri = FileSystem.cacheDirectory + 'temp_import.' + (ext || 'xlsx');
          await FileSystem.copyAsync({ from: fileUri, to: tempUri });
          base64Content = await FileSystem.readAsStringAsync(tempUri, { encoding: FileSystem.EncodingType.Base64 });
          FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
        } catch (copyErr: any) {
          console.warn('[CacheService] copyAsync fallback failed:', copyErr);
        }
      }

      if (!base64Content) {
        try {
          base64Content = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64 });
        } catch (readErr: any) {
          return { success: false, fileType: 'fullParams', fileName, message: `文件读取失败: ${readErr.message}` };
        }
      }

      onProgress?.({ fileName, progress: 30, status: 'parsing', message: '正在解析工参文件...' });
      await yieldToUI();

      // 清理 BOM
      if (base64Content.startsWith('77u/')) base64Content = base64Content.substring(4);

      // ===================================================================
      // 手动 XML 解析（parseXlsxManually）— 绕过 XLSX.read 的 !ref 截断问题
      // ===================================================================
      const manualSheets = await parseXlsxManually(base64Content, []);
      base64Content = ''; // 释放内存

      if (!manualSheets || manualSheets.size === 0) {
        return { success: false, fileType: 'fullParams', fileName, message: 'Excel 文件解析失败，未读取到工作表' };
      }

      if (__DEV__) {
        const sheetSummary = Array.from(manualSheets.entries()).map(([n, r]) => `${n}(${r.length}行)`).join(', ');
        console.log('[CacheService] Manual XML 解析出 sheet:', sheetSummary);
      }

      // ===================================================================
      // 使用独立解析函数 parseAppProjectParams（与后端缓存逻辑完全隔离）
      // ===================================================================
      const parseResult = parseAppProjectParams(manualSheets, fileName);

      if (!parseResult.success) {
        return { success: false, fileType: 'fullParams', fileName, message: parseResult.message };
      }

      onProgress?.({ fileName, progress: 65, status: 'processing', message: '正在序列化数据...' });
      await yieldToUI();

      // 写入缓存
      const saveData = { lte: parseResult.lteSectors, nr: parseResult.nrSectors };
      const jsonContent = JSON.stringify(saveData);
      onProgress?.({ fileName, progress: 85, status: 'processing', message: '正在写入缓存文件...' });
      await FileSystem.writeAsStringAsync(`${CACHE_DIRS.fullParams}sectors.json`, jsonContent);

      await this.updateMeta(meta => {
        const updated = { ...meta };
        updated.dataTypes = { ...meta.dataTypes, fullParams: true };
        updated.lastRefreshAt = new Date().toISOString();
        updated.fullParamsInfo = {
          sourceFileName: fileName,
          lteSiteCount: parseResult.lteSiteIds.size,
          lteSectorCount: parseResult.lteSectors.length,
          nrSiteCount: parseResult.nrSiteIds.size,
          nrSectorCount: parseResult.nrSectors.length,
          cachedAt: new Date().toISOString(),
          fromPhone: true,
        };
        return updated;
      });

      const totalSectors = parseResult.lteSectors.length + parseResult.nrSectors.length;
      let msg = `全量工参解析完成: LTE ${parseResult.lteSiteIds.size}站/${parseResult.lteSectors.length}小区, NR ${parseResult.nrSiteIds.size}站/${parseResult.nrSectors.length}小区`;

      // 拼接跳过原因统计(若存在数据丢失)
      if (parseResult.skipStats) {
        const s = parseResult.skipStats;
        // 用户的对账口径:总行数 - 经纬度无效行 = 期望导入数
        // 期望导入数 - 实际导入数 = 未知原因缺失(其他跳过原因的总和)
        const lteExpected = s.lte.totalDataRows - s.lte.invalidLatLng;
        const lteUnexpectedMissing = lteExpected - parseResult.lteSectors.length;
        const nrExpected = s.nr.totalDataRows - s.nr.invalidLatLng;
        const nrUnexpectedMissing = nrExpected - parseResult.nrSectors.length;

        if (lteUnexpectedMissing > 0 || nrUnexpectedMissing > 0) {
          const warnParts: string[] = [];
          if (lteUnexpectedMissing > 0) warnParts.push(`LTE 缺失${lteUnexpectedMissing}个`);
          if (nrUnexpectedMissing > 0) warnParts.push(`NR 缺失${nrUnexpectedMissing}个`);
          msg += `\n⚠️ 除经纬度空值外仍有${warnParts.join('、')}`;
        }
        if (__DEV__) {
          console.log('[CacheService] 跳过统计 LTE:', JSON.stringify(s.lte));
          console.log('[CacheService] 跳过统计 NR:', JSON.stringify(s.nr));
        }
      }

      onProgress?.({ fileName, progress: 100, status: 'done', message: msg });

      return {
        success: true,
        fileType: 'fullParams',
        fileName,
        message: msg,
        count: totalSectors,
        skipStats: parseResult.skipStats,
      };
    } catch (e: any) {
      const errMsg = `导入失败: ${e.message}`;
      onProgress?.({ fileName, progress: 0, status: 'error', message: errMsg });
      return { success: false, fileType: 'fullParams', fileName, message: errMsg };
    }
  }

  /**
   * 从缓存重新加载扇区数据并返回（导入或刷新后调用）
   */
  async reloadSectorsFromCache(): Promise<{ lte: any[]; nr: any[] } | null> {
    return this.getCachedSectors();
  }

  // ==================== 数据导出/下载 ====================

  /**
   * 将缓存数据导出为 JSON 文件，使用 expo-sharing 分享/保存到手机
   */
  async exportCachedData(type: DataFileType): Promise<string | null> {
    try {
      await this.init();
      const meta = await this.getMeta();

      if (type === 'fullParams' && meta.fullParamsInfo) {
        const path = `${CACHE_DIRS.fullParams}sectors.json`;
        const info = await FileSystem.getInfoAsync(path);
        if (!info.exists) return null;

        const tmpPath = `${FileSystem.cacheDirectory}全量工参_${formatDate()}.json`;
        await FileSystem.copyAsync({ from: path, to: tmpPath });
        return tmpPath;
      }

      if (type === 'geoData' && meta.geoDataInfo) {
        const items = meta.geoDataInfo.items;
        if (items.length === 0) return null;
        // 合并所有地理化数据为一个 JSON
        const allFeatures: any[] = [];
        for (const item of items) {
          try {
            const jsonStr = await FileSystem.readAsStringAsync(
              `${CACHE_DIRS.geoData}${item.filePath}`
            );
            const data = JSON.parse(jsonStr);
            if (data.features) allFeatures.push(...data.features);
            else allFeatures.push(data);
          } catch (e) { /* skip */ }
        }
        const tmpPath = `${FileSystem.cacheDirectory}地理化数据_${formatDate()}.json`;
        await FileSystem.writeAsStringAsync(tmpPath, JSON.stringify({
          type: 'FeatureCollection', features: allFeatures,
        }));
        return tmpPath;
      }

      if (type === 'layers' && meta.layersInfo) {
        const items = meta.layersInfo.items;
        if (items.length === 0) return null;
        // 导出第一个图层文件
        const item = items[0];
        const tmpPath = `${FileSystem.cacheDirectory}${item.name}_${formatDate()}.json`;
        await FileSystem.copyAsync({
          from: `${CACHE_DIRS.layers}${item.filePath}`,
          to: tmpPath,
        });
        return tmpPath;
      }

      return null;
    } catch (e) {
      console.error('[CacheService] exportCachedData failed:', e);
      return null;
    }
  }

  /** 清除指定类型的所有缓存数据 */
  async clearDataType(type: DataFileType): Promise<void> {
    const dir = CACHE_DIRS[type];
    try {
      await FileSystem.deleteAsync(dir, { idempotent: true });
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    } catch (e) {
      console.error(`[CacheService] Failed to clear ${type}:`, e);
    }
    await this.updateMeta(meta => {
      const updated = { ...meta };
      updated.dataTypes = { ...meta.dataTypes, [type]: false };
      if (type === 'fullParams') updated.fullParamsInfo = null;
      else if (type === 'geoData') updated.geoDataInfo = null;
      else updated.layersInfo = null;
      return updated;
    });
  }

  // ==================== 杂项 ====================

  async clearCache(): Promise<void> {
    for (const dir of Object.values(CACHE_DIRS)) {
      try {
        await FileSystem.deleteAsync(dir, { idempotent: true });
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      } catch (e) {
        console.error('[CacheService] Failed to clear dir:', dir, e);
      }
    }
    await AsyncStorage.removeItem(META_KEY);
    await AsyncStorage.removeItem(FIRST_LAUNCH_KEY);
  }

  async getCacheSize(): Promise<number> {
    let totalSize = 0;
    try {
      for (const dir of Object.values(CACHE_DIRS)) {
        const content = await FileSystem.readDirectoryAsync(dir);
        for (const file of content) {
          const info = await FileSystem.getInfoAsync(`${dir}${file}`);
          if (info.exists && info.size) {
            totalSize += info.size;
          }
        }
      }
    } catch (e) {
      console.error('[CacheService] Failed to calculate cache size:', e);
    }
    return totalSize;
  }

  private countSites(sectors: any[]): number {
    const siteIds = new Set<string>();
    for (const s of sectors) {
      if (s.siteId) siteIds.add(s.siteId);
    }
    return siteIds.size;
  }
}

// ==================== Excel workbook 直接解析辅助函数 ====================

function parseFullParamsExcelBytes(workbook: XLSX.WorkBook, lteSheet: string | null, nrSheet: string | null) {
  // Validate workbook structure
  if (!workbook || !workbook.Sheets || !workbook.SheetNames) {
    console.error('[CacheService] Invalid workbook structure:', Object.keys(workbook || {}));
    return { lteSites: [], nrSites: [], lteCount: { sites: 0, sectors: 0 }, nrCount: { sites: 0, sectors: 0 } };
  }

  console.log('[CacheService] parseFullParamsExcelBytes workbook valid, sheets:', workbook.SheetNames);
  const lteSites = lteSheet ? parseFullParamsSheet(workbook, lteSheet, 'LTE') : [];
  const nrSites = nrSheet ? parseFullParamsSheet(workbook, nrSheet, 'NR') : [];
  return {
    lteSites, nrSites,
    lteCount: { sites: lteSites.length, sectors: lteSites.reduce((s: number, si: any) => s + (si.sectors?.length || 0), 0) },
    nrCount: { sites: nrSites.length, sectors: nrSites.reduce((s: number, si: any) => s + (si.sectors?.length || 0), 0) },
  };
}

function parseGeoDataExcelBytes(workbook: XLSX.WorkBook, filename: string) {
  return parseGeoDataExcelBytesAllSheets(workbook);
}

function parseGeoDataExcelBytesAllSheets(workbook: XLSX.WorkBook) {
  const features: any[] = [];

  if (!workbook || !workbook.Sheets || !workbook.SheetNames) {
    console.warn('[CacheService] parseGeoDataExcelBytesAllSheets: invalid workbook');
    return { features: [], pointCount: 0, geometryType: 'point' };
  }

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (sheet) {
      ensureSheetRef(sheet);
    }
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (rows.length < 2) continue;
    const headers = (rows[0] || []).map((h: any) => String(h).trim());
    if (!headers.some(h => ['经度', 'longitude', 'lng', '纬度', 'latitude', 'lat'].includes(h.toLowerCase()))) continue;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const obj: Record<string, any> = {};
      headers.forEach((h: string, idx: number) => obj[h] = row[idx]);
      const fields = detectFields(headers);
      const lonIdx = fields.longitude ? headers.indexOf(fields.longitude) : -1;
      const latIdx = fields.latitude ? headers.indexOf(fields.latitude) : -1;
      if (lonIdx >= 0 && latIdx >= 0) {
        const lon = parseFloat(row[lonIdx]);
        const lat = parseFloat(row[latIdx]);
        if (!isNaN(lon) && !isNaN(lat)) {
          const coords = wgs84ToGcj02(lat, lon);
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [coords[1], coords[0]] },
            properties: { ...obj, name: row[fields.name ? headers.indexOf(fields.name) : -1] || '' },
          });
        }
      }
    }
  }
  return { features, pointCount: features.length, geometryType: 'point' };
}

/**
 * 确保 sheet 有 !ref 属性，如果缺失则从实际 cell key 推算
 * 解决某些 xlsx 库解析后 !ref 丢失但 cell 数据仍在的问题
 */
function ensureSheetRef(sheet: any): boolean {
  // 已经有 !ref，不需要修复
  const ref = (sheet as any)['!ref'];
  if (ref && typeof ref === 'string' && ref.includes(':')) return true;

  // 找出所有 cell key（非 ! 开头的，匹配单元格引用格式的）
  const cellKeys = Object.keys(sheet).filter(k => /^[A-Z]+[0-9]+$/.test(k));
  if (cellKeys.length === 0) return false;

  // 计算行列范围
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const key of cellKeys) {
    const match = key.match(/^([A-Z]+)([0-9]+)$/);
    if (!match) continue;
    // 列字母转索引 (A=0, B=1, ..., Z=25, AA=26, ...)
    let col = 0;
    for (let i = 0; i < match[1].length; i++) {
      col = col * 26 + match[1].charCodeAt(i) - 64;
    }
    col -= 1; // 0-based
    const row = parseInt(match[2], 10) - 1; // 0-based
    minR = Math.min(minR, row);
    maxR = Math.max(maxR, row);
    minC = Math.min(minC, col);
    maxC = Math.max(maxC, col);
  }

  if (minR === Infinity) return false;

  // 列索引转字母
  const encodeCol = (c: number): string => {
    let s = '';
    c += 1; // 1-based for encoding
    while (c > 0) {
      c--;
      s = String.fromCharCode((c % 26) + 65) + s;
      c = Math.floor(c / 26);
    }
    return s;
  };

  const newRef = `${encodeCol(minC)}${minR + 1}:${encodeCol(maxC)}${maxR + 1}`;
  if (__DEV__) console.log(`[CacheService] ensureSheetRef: setting !ref="${newRef}" from ${cellKeys.length} cell keys`);
  (sheet as any)['!ref'] = newRef;
  return true;
}

/**
 * 尝试逐个 sheet 检测是否为全量工参（通过列名匹配）
 * 用于 sheet 名称不标准但内容是全量工参的情况
 * @param lteSheetName / nrSheetName — 标准 sheet 名称（用于匹配 pre-parsed rows）
 * @param lteRows / nrRows — 预解析的行数据，避免大文件重复 sheet_to_json
 */
function tryParseAllSheetsAsFullParams(
  workbook: XLSX.WorkBook,
  lteSheetName?: string,
  nrSheetName?: string,
  lteRows?: any[][] | null,
  nrRows?: any[][] | null,
) {
  const lteSectors: any[] = [];
  const nrSectors: any[] = [];
  const lteSiteIds = new Set<string>();
  const nrSiteIds = new Set<string>();

  if (!workbook || !workbook.SheetNames || !workbook.Sheets) {
    return { lteSites: [], nrSites: [], lteCount: { sites: 0, sectors: 0 }, nrCount: { sites: 0, sectors: 0 } };
  }

  // 快速路径：如果提供了预解析行，直接处理标准 sheet（产出扁平扇区，跳过 ParsedSite 中间结构）
  if (lteRows && lteSheetName) {
    _tryParseSheetFlat(workbook, lteSheetName, lteRows, lteSectors, lteSiteIds);
  }
  if (nrRows && nrSheetName) {
    _tryParseSheetFlat(workbook, nrSheetName, nrRows, nrSectors, nrSiteIds);
  }

  // 兼容路径：遍历所有 sheet，对未被预解析覆盖的标准 sheet 做解析
  for (const sheetName of workbook.SheetNames) {
    if (lteRows && sheetName === lteSheetName) continue;
    if (nrRows && sheetName === nrSheetName) continue;
    const isStandardSheet = sheetName.toLowerCase().includes('lte project parameters') ||
      sheetName.toLowerCase().includes('nr project parameters');
    if (!isStandardSheet) continue;
    const sheet = workbook.Sheets[sheetName];
    if (sheet) ensureSheetRef(sheet);
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (rows.length < 2) continue;
    if (sheetName.toLowerCase().includes('lte')) {
      _tryParseSheetFlat(workbook, sheetName, rows, lteSectors, lteSiteIds);
    } else {
      _tryParseSheetFlat(workbook, sheetName, rows, nrSectors, nrSiteIds);
    }
  }

  return {
    lteSites: lteSectors,  // 已扁平化，直接是扇区数组
    nrSites: nrSectors,
    lteCount: { sites: lteSiteIds.size, sectors: lteSectors.length },
    nrCount: { sites: nrSiteIds.size, sectors: nrSectors.length },
  };
}

// ==================== APP 手动导入专用解析（与后端缓存逻辑完全隔离） ====================

/**
 * APP 手动导入工参解析：使用固定列名映射
 *
 * 规则：
 * 1. 文件名不限，只要包含必填字段即可解析
 * 2. Sheet 名称含 NR/5G → NR 网络类型；含 LTE/4G → LTE 网络类型；否则通过列名特征自动判断
 * 3. 必需列：基站标识、小区标识、经度、纬度、天线方向角、小区覆盖类型
 * 4. 可选列：基站名称、小区名称、天线挂高、PCI、下行链路的中心载频、CenterARFCN、TAC、是否共享
 * 5. 未映射的列保存到 extraFields，在属性弹框中完整显示
 */
function parseAppProjectParams(
  manualSheets: Map<string, any[][]>,
  fileName: string,
): {
  success: boolean;
  message: string;
  lteSectors: any[];
  nrSectors: any[];
  lteSiteIds: Set<string>;
  nrSiteIds: Set<string>;
  skipStats?: {
    lte: SkipStats;
    nr: SkipStats;
  };
} {
  // ===== 固定列名映射 =====
  // ===== 必填列模糊匹配映射 =====
  // 每个必填字段对应多个可能的列名模式（不区分大小写）
  const REQUIRED_COLUMN_PATTERNS: Record<string, string[]> = {
    '基站标识': ['基站标识', '基站ID', '4G基站ID', '5G基站ID', 'SITE ID', 'SITE', '基站', 'enodeB', 'gnodeB', 'enodeBid', 'enodeB id'],
    '小区标识': ['小区标识', '小区ID', 'cellid', 'cell id'],
    '小区名称': ['小区名称', '小区名', 'CELL NAME', '网管小区名'],
    '经度': ['经度', 'longitude'],
    '纬度': ['纬度', 'latitude'],
    '天线方向角': ['方向角', '方位角', 'azimuth', '朝向角'],
    '小区覆盖类型': ['覆盖方式', '覆盖类型', '室分/室外', 'coverage', '站型', '覆盖场景', '场景'],
  };

  const LTE_OPTIONAL_COLUMNS: Record<string, string> = {
    '基站名称': 'siteName',
    '厂家': 'vendor',
    '天线挂高': 'height',
    'PCI': 'pci',
    '下行链路的中心载频': 'earfcn',
    'TAC': 'tac',
    '是否共享': 'is_shared',
  };

  const NR_OPTIONAL_COLUMNS: Record<string, string> = {
    '基站名称': 'siteName',
    '厂家': 'vendor',
    '天线挂高': 'height',
    'PCI': 'pci',
    'CenterARFCN': 'ssbFrequency',
    'TAC': 'tac',
    '是否共享': 'is_shared',
  };

  const lteSectors: any[] = [];
  const nrSectors: any[] = [];
  const lteSiteIds = new Set<string>();
  const nrSiteIds = new Set<string>();
  const lteSkipStats = createSkipStats();
  const nrSkipStats = createSkipStats();
  // 记录已存在的 (siteId+sectorId) 用于去重统计
  const lteSeenKeys = new Set<string>();
  const nrSeenKeys = new Set<string>();
  let matchedSheetCount = 0;

  for (const [sheetName, rows] of manualSheets) {
    // ===== 判断网络类型 =====
    // 优先通过 Sheet 名称判断；名称不含 LTE/4G/NR/5G 时，通过列名特征自动判断
    const isNr = /\bnr\b|5g/i.test(sheetName);
    const isLte = /\blte\b|4g/i.test(sheetName);

    if (rows.length < 2) {
      if (__DEV__) console.log(`[parseAppProjectParams] sheet="${sheetName}" 数据行不足`);
      continue;
    }

    // 先解析表头，用于自动判断网络类型
    // 使用模糊匹配识别表头行：包含任一必填字段模式即可
    const allRequiredPatterns = Object.values(REQUIRED_COLUMN_PATTERNS).flat();
    let headerRowIndex = -1;
    let headers: string[] = [];
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const row = (rows[i] || []).map((c: any) => String(c).trim());
      const headerLower = row.map(h => h.toLowerCase());
      if (headerLower.some(h => allRequiredPatterns.some(p => h.includes(p.toLowerCase())))) {
        headerRowIndex = i;
        headers = row;
        break;
      }
    }

    if (headerRowIndex < 0) {
      if (__DEV__) console.log(`[parseAppProjectParams] sheet="${sheetName}" 未找到表头行`);
      continue;
    }

    // 去除表头中的"(必填)"后缀（模板文件中必填列名带此后缀标识，解析时需去除）
    headers = headers.map(h => h.replace(/\(必填\)/g, '').trim());

    // 自动判断网络类型：Sheet 名称优先，否则通过列名特征判断
    let networkType: 'LTE' | 'NR';
    if (isNr) {
      networkType = 'NR';
    } else if (isLte) {
      networkType = 'LTE';
    } else {
      // 通过列名特征自动判断
      const hasNrColumn = headers.some(h => h.includes('CenterARFCN') || h.includes('SSB'));
      const hasLteColumn = headers.some(h => h.includes('下行链路的中心载频') || h.includes('EARFCN'));
      networkType = hasNrColumn && !hasLteColumn ? 'NR' : 'LTE';
      if (__DEV__) console.log(`[parseAppProjectParams] sheet="${sheetName}" 名称未匹配，通过列名自动判断为 ${networkType}`);
    }

    matchedSheetCount++;
    const currentStats = networkType === 'NR' ? nrSkipStats : lteSkipStats;
    const seenKeys = networkType === 'NR' ? nrSeenKeys : lteSeenKeys;

    if (__DEV__) {
      console.log(`[parseAppProjectParams] sheet="${sheetName}" headerRow=${headerRowIndex} headers:`, JSON.stringify(headers));
    }

    // ===== 校验 4: 必需列必须存在 =====
    // 使用模糊匹配：每个必填字段有多个可能的列名模式，不区分大小写
    const headersLower = headers.map(h => h.toLowerCase());
    const findHeaderIndex = (target: string): number => {
      const targetLower = target.toLowerCase();
      for (let i = 0; i < headers.length; i++) {
        if (headers[i] === target || headersLower[i].includes(targetLower)) return i;
      }
      return -1;
    };

    // 多模式模糊匹配：遍历每个必填字段的所有模式，找到第一个匹配的列
    const findHeaderIndexByPatterns = (patterns: string[]): number => {
      for (const pattern of patterns) {
        const idx = findHeaderIndex(pattern);
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const requiredColIndices: Record<string, number> = {};
    const missingColumns: string[] = [];
    for (const [fieldKey, patterns] of Object.entries(REQUIRED_COLUMN_PATTERNS)) {
      const idx = findHeaderIndexByPatterns(patterns);
      if (idx === -1) {
        missingColumns.push(fieldKey);
      } else {
        requiredColIndices[fieldKey] = idx;
      }
    }

    if (missingColumns.length > 0) {
      // 输出详细调试信息：表头的每个值及其 Unicode 码点
      console.warn(`[parseAppProjectParams] sheet="${sheetName}" 缺少必需列: ${missingColumns.join(',')}`);
      console.warn(`[parseAppProjectParams] 实际表头(${headers.length}列):`, JSON.stringify(headers));
      for (let i = 0; i < headers.length; i++) {
        const h = headers[i];
        if (h.length > 0 && h.length < 20) {
          const codes = Array.from(h).map(c => `${c}(U+${c.charCodeAt(0).toString(16).padStart(4, '0')})`).join(' ');
          console.warn(`  [${i}] = "${codes}"`);
        }
      }
      return {
        success: false,
        message: `${networkType} 工参表头缺少必需列: ${missingColumns.join('、')}`,
        lteSectors: [],
        nrSectors: [],
        lteSiteIds: new Set(),
        nrSiteIds: new Set(),
        skipStats: { lte: lteSkipStats, nr: nrSkipStats },
      };
    }

    // ===== 构建可选列索引映射 =====
    const optionalColumns = networkType === 'LTE' ? LTE_OPTIONAL_COLUMNS : NR_OPTIONAL_COLUMNS;
    const optionalColIndices: Record<string, { colName: string; idx: number }> = {};
    for (const [colName, fieldName] of Object.entries(optionalColumns)) {
      const idx = findHeaderIndex(colName);
      if (idx !== -1) {
        optionalColIndices[fieldName] = { colName, idx };
      }
    }

    // ===== 解析数据行 =====
    const dataRows = rows.slice(headerRowIndex + 1);
    const outSectors = networkType === 'NR' ? nrSectors : lteSectors;
    const outSiteIds = networkType === 'NR' ? nrSiteIds : lteSiteIds;

    for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
      const row = dataRows[rowIdx];
      currentStats.totalDataRows++;
      // 行号：表头行之后的第几行（从1开始）
      const displayRowNum = headerRowIndex + rowIdx + 2;
      // 提前读取小区名称，用于异常详情展示
      const sectorNameForRow = String(row[requiredColIndices['小区名称']] || '').trim();

      if (!row || row.length === 0) {
        currentStats.emptyRow++;
        currentStats.skipDetails.push({ rowNumber: displayRowNum, sectorName: '', reason: '空行' });
        continue;
      }

      const siteId = String(row[requiredColIndices['基站标识']] || '').trim();
      if (!siteId) {
        currentStats.missingSiteId++;
        currentStats.skipDetails.push({ rowNumber: displayRowNum, sectorName: sectorNameForRow, reason: '基站标识为空' });
        continue;
      }

      const sectorId = String(row[requiredColIndices['小区标识']] || '').trim();
      if (!sectorId) {
        currentStats.missingSectorId++;
        currentStats.skipDetails.push({ rowNumber: displayRowNum, sectorName: sectorNameForRow, reason: '小区标识为空' });
        continue;
      }

      const lngStr = String(row[requiredColIndices['经度']] || '').trim();
      const latStr = String(row[requiredColIndices['纬度']] || '').trim();
      const lng = parseFloat(lngStr);
      const lat = parseFloat(latStr);

      if (isNaN(lng) || isNaN(lat)) {
        currentStats.invalidLatLng++;
        currentStats.skipDetails.push({ rowNumber: displayRowNum, sectorName: sectorNameForRow, reason: `经纬度无效(${lngStr},${latStr})` });
        continue;
      }
      if (lng < 73 || lng > 135 || lat < 18 || lat > 53) {
        currentStats.outOfRange++;
        currentStats.skipDetails.push({ rowNumber: displayRowNum, sectorName: sectorNameForRow, reason: `经纬度超范围(${lng.toFixed(4)},${lat.toFixed(4)})` });
        continue;
      }

      // 去重:同一网络类型下 (siteId, sectorId) 已存在则视为重复
      const dupKey = `${siteId}__${sectorId}`;
      if (seenKeys.has(dupKey)) {
        currentStats.duplicate++;
        currentStats.skipDetails.push({ rowNumber: displayRowNum, sectorName: sectorNameForRow, reason: `重复(siteId=${siteId},sectorId=${sectorId})` });
        continue;
      }
      seenKeys.add(dupKey);

      const azimuthRaw = parseFloat(String(row[requiredColIndices['天线方向角']] || ''));
      // azimuth 容错: 缺失/异常时按 0 处理,MapView 会用 0 朝北
      // 但 0 度与 360 度等价,会出现"全部朝北"问题,这里对 0 不做特殊处理(后端数据也常见 0 度)
      const azimuth = isNaN(azimuthRaw) ? 0 : azimuthRaw;
      // cell_cover_type 必须是数字(MapView 中 === 4 判断室内覆盖渲染为 30m 圆,字符串 "4" === 4 为 false 会走多边形)
      const cellCoverTypeStr = String(row[requiredColIndices['小区覆盖类型']] || '').trim();
      const cellCoverTypeNum = parseFloat(cellCoverTypeStr);
      const cellCoverType = isNaN(cellCoverTypeNum) ? cellCoverTypeStr : cellCoverTypeNum;

      outSiteIds.add(siteId);

      // 构建扇区对象
      const siteNameInfo = optionalColIndices['siteName'];
      // 小区名称从必填列取值
      const sectorName = String(row[requiredColIndices['小区名称']] || '').trim();
      // id 唯一化: 原 id=sectorId 会在 LTE/NR 之间重复(小区标识"1"可能 LTE 和 NR 都有)
      // 组合 networkType+siteId+sectorId 保证唯一,避免 MapView 中 sectorOverlayMap 覆盖
      const sector: any = {
        id: `${networkType}_${siteId}_${sectorId}`,
        siteId,
        sectorId,
        // 小区名称作为弹框标题
        name: sectorName || (siteNameInfo ? String(row[siteNameInfo.idx] || '').trim() : ''),
        siteName: siteNameInfo ? String(row[siteNameInfo.idx] || '').trim() : '',
        longitude: lng,
        latitude: lat,
        azimuth,
        networkType,
        cell_cover_type: cellCoverType,
        // 显式设置 beamwidth,避免 MapView 全部用默认 65° 误判
        beamwidth: 65,
      };

      // 填充可选字段
      for (const [fieldName, info] of Object.entries(optionalColIndices)) {
        if (['siteName'].includes(fieldName)) continue; // 已处理
        const val = row[info.idx];
        if (val !== undefined && val !== '') {
          if (['height', 'pci', 'earfcn', 'ssbFrequency', 'tac'].includes(fieldName)) {
            const num = parseFloat(String(val));
            if (!isNaN(num)) sector[fieldName] = num;
          } else {
            sector[fieldName] = String(val).trim();
          }
        }
      }

      // 收集未映射到已知字段的原始列，保存到 extraFields
      // 这样属性弹框可以显示导入工参文件表格的所有列名内容
      const knownColIndices = new Set<number>();
      for (const idx of Object.values(requiredColIndices)) knownColIndices.add(idx);
      for (const info of Object.values(optionalColIndices)) knownColIndices.add(info.idx);
      const extraFields: Record<string, any> = {};
      for (let i = 0; i < headers.length; i++) {
        if (knownColIndices.has(i)) continue;
        const headerName = headers[i];
        if (!headerName) continue;
        const val = row[i];
        if (val !== undefined && val !== null && val !== '') {
          extraFields[headerName] = typeof val === 'string' ? val.trim() : val;
        }
      }
      if (Object.keys(extraFields).length > 0) {
        sector.extraFields = extraFields;
      }

      outSectors.push(sector);
    }

    if (__DEV__) {
      console.log(`[parseAppProjectParams] sheet="${sheetName}" ${networkType} 解析: ${outSectors.length} 扇区, ${outSiteIds.size} 站`);
    }
  }

  // ===== 校验: 至少有一个 sheet 匹配 =====
  if (matchedSheetCount === 0) {
    return {
      success: false,
      message: '未找到 LTE/4G 或 NR/5G 工参工作表',
      lteSectors: [],
      nrSectors: [],
      lteSiteIds: new Set(),
      nrSiteIds: new Set(),
      skipStats: { lte: lteSkipStats, nr: nrSkipStats },
    };
  }

  if (lteSectors.length === 0 && nrSectors.length === 0) {
    return {
      success: false,
      message: '工参解析完成但未产出有效扇区数据',
      lteSectors: [],
      nrSectors: [],
      lteSiteIds: new Set(),
      nrSiteIds: new Set(),
      skipStats: { lte: lteSkipStats, nr: nrSkipStats },
    };
  }

  return {
    success: true,
    message: '解析成功',
    lteSectors,
    nrSectors,
    lteSiteIds,
    nrSiteIds,
    skipStats: { lte: lteSkipStats, nr: nrSkipStats },
  };
}

function _tryParseSheetFlat(
  workbook: XLSX.WorkBook, sheetName: string, rows: any[][],
  outSectors: any[], outSiteIds: Set<string>,
  nrOutSectors?: any[], nrOutSiteIds?: Set<string>,
) {
  if (rows.length < 2) {
    if (__DEV__) console.log(`[CacheService] _tryParseSheetFlat sheet="${sheetName}" rows < 2, skip`);
    return;
  }

  // 扫描前 10 行寻找真正的表头行(扩展范围,因为有些工参文件前几行是元数据描述,
  // 表头在 row[2] 或更后;同时处理 &#10; HTML entity 换行)
  const HEADER_SCAN_LIMIT = 10;
  let headerRowIndex = -1;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(HEADER_SCAN_LIMIT, rows.length); i++) {
    const row = (rows[i] || []).map((c: any) => String(c).trim().split(/\n|&#10;|\r/i)[0].trim());
    const hasLonCandidate = row.some((h: string) => /经度|longitude|lng|lon/i.test(h));
    const hasLatCandidate = row.some((h: string) => /纬度|latitude|lat/i.test(h));
    const hasIdCandidate = row.some((h: string) => /eNodeB|gNodeB|基站ID|网元ID|CGI|site.*id|cell.*id|小区ID|小区标识/i.test(h));
    if (__DEV__) console.log(`[CacheService] _tryParseSheetFlat row[${i}] first cols:`, JSON.stringify(row.slice(0, 8)));
    if (hasLonCandidate && hasLatCandidate && hasIdCandidate) {
      headerRowIndex = i;
      headers = row;
      break;
    }
  }
  if (headerRowIndex < 0) {
    headers = (rows[0] || []).map((h: any) => String(h).trim().split(/\n|&#10;|\r/i)[0].trim());
    if (__DEV__) console.log(`[CacheService] _tryParseSheetFlat sheet="${sheetName}" no header row detected, using row[0] as headers:`, JSON.stringify(headers.slice(0, 8)));
  } else if (headerRowIndex > 0) {
    // mongoose 工参文件的表头由多行组成:
    // row[0] 是中文描述行,row[headerRowIndex] 是英文列名行。
    // 合并两行，英文列名优先级高，中文描述行补空缺
    const descriptionRow = (rows[0] || []).map((c: any) => String(c).trim().split(/\n|&#10;|\r/i)[0].trim());
    const headerRow = headers;
    const maxLen = Math.max(descriptionRow.length, headerRow.length);
    const merged: string[] = [];
    for (let i = 0; i < maxLen; i++) {
      const d = descriptionRow[i] || '';
      const h = headerRow[i] || '';
      merged.push(h || d || '');
    }
    headers = merged;
    if (__DEV__) console.log(`[CacheService] _tryParseSheetFlat sheet="${sheetName}" merged headers:`, JSON.stringify(headers.slice(0, 12)));
  }

  const fields = detectFields(headers);
  const hasSiteId = headers.some(h => /eNodeB|gNodeB|基站ID|网元ID|site.*id|CGI|cell.*id/i.test(h));
  const hasSectorId = headers.some(h => /小区ID|sector.*id|cell.*id|CGI|小区标识/i.test(h));
  const hasLon = fields.longitude != null;
  const hasLat = fields.latitude != null;

  if (!hasSiteId || !hasSectorId || !hasLon || !hasLat) {
    if (__DEV__) console.log(`[CacheService] _tryParseSheetFlat sheet="${sheetName}" field detection FAILED: hasSiteId=${hasSiteId} hasSectorId=${hasSectorId} hasLon=${hasLon} hasLat=${hasLat} headers:`, JSON.stringify(headers.slice(0, 10)));
    return;
  }

  // 自动检测网络类型：优先按 sheet 名称，其次按列名特征
  const isLte = sheetName.toLowerCase().includes('lte') ||
    headers.some(h => /lte|fdd|earfcn|eNodeB/i.test(h));
  const isNr = sheetName.toLowerCase().includes('nr') ||
    headers.some(h => /nr|ssb|5G|gNodeB/i.test(h));

  const dataRows = headerRowIndex >= 0 ? rows.slice(headerRowIndex + 1) : rows.slice(1);

  // 如果同时提供了 nrOutSectors，则根据检测结果分别输出 LTE/NR
  // 否则按原有逻辑：LTE 优先，不确定时默认 LTE
  if (nrOutSectors && nrOutSiteIds) {
    // 新模式：自动分流到 LTE 或 NR 输出数组
    if (isNr && !isLte) {
      const { sectors, siteIds } = parseRowsToFlatSectors(dataRows, headers, 'NR');
      if (__DEV__) console.log(`[CacheService] _tryParseSheetFlat sheet="${sheetName}" NR sectors: ${sectors.length}, sites: ${siteIds.size}`);
      for (const s of sectors) nrOutSectors.push(s);
      for (const id of siteIds) nrOutSiteIds.add(id);
    } else {
      // 默认走 LTE（包括 isLte 或无法确定的情况）
      const { sectors, siteIds } = parseRowsToFlatSectors(dataRows, headers, 'LTE');
      if (__DEV__) console.log(`[CacheService] _tryParseSheetFlat sheet="${sheetName}" LTE sectors: ${sectors.length}, sites: ${siteIds.size}`);
      for (const s of sectors) outSectors.push(s);
      for (const id of siteIds) outSiteIds.add(id);
    }
  } else {
    // 旧模式：兼容 tryParseAllSheetsAsFullParams 的调用方式
    const networkType: 'LTE' | 'NR' = isLte ? 'LTE' : 'NR';
    const { sectors, siteIds } = parseRowsToFlatSectors(dataRows, headers, networkType);
    if (__DEV__) console.log(`[CacheService] _tryParseSheetFlat sheet="${sheetName}" ${networkType} sectors: ${sectors.length}, sites: ${siteIds.size}`);
    for (const s of sectors) outSectors.push(s);
    for (const id of siteIds) outSiteIds.add(id);
  }
}

// ==================== 手动 XLSX XML 解析（回退方案） ====================

/**
 * Uint8Array → base64 分块转换
 * 避免 String.fromCharCode.apply 的参数数量限制（≈65536）导致大文件截断
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32768 — 安全的参数数量上限
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    parts.push(String.fromCharCode.apply(null, chunk as unknown as number[]));
  }
  return btoa(parts.join(''));
}

/**
 * 重新读取文件为 base64（仅用于手动 XML 回退路径）
 */
async function reReadFileBase64(fileUri: string): Promise<string | null> {
  try {
    const SAF = (FileSystem as any).StorageAccessFramework;
    if (SAF && typeof SAF.readAsStringAsync === 'function') {
      const safResult = await SAF.readAsStringAsync(fileUri, FileSystem.EncodingType.Base64);
      if (safResult) {
        if (typeof safResult === 'string') return safResult;
        // Uint8Array → base64（分块转换）
        return uint8ArrayToBase64(safResult as Uint8Array);
      }
    }
    return await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64 });
  } catch (e) {
    console.warn('[CacheService] reReadFileBase64 failed:', e);
    return null;
  }
}

/**
 * 手动从 xlsx 的 ZIP 中提取 XML 数据
 * 用于 SheetJS 无法解析某些 sheet 时的回退方案
 */
async function parseXlsxManually(base64Content: string, sheetNames: string[]): Promise<Map<string, any[][]> | null> {
  try {
    // base64 转 Uint8Array
    const binaryStr = atob(base64Content);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    // JSZip 加载 ZIP
    const zip = await JSZip.loadAsync(bytes);

    // 共享字符串
    let sharedStrings: string[] = [];
    const ssFile = zip.file('xl/sharedStrings.xml');
    if (ssFile) {
      const ssXml = await ssFile.async('string');
      sharedStrings = parseSharedStringsXml(ssXml);
      if (__DEV__) console.log(`[CacheService] Manual XML: ${sharedStrings.length} shared strings`);
    }

    // workbook.xml -> sheet 名称与 r:id 映射
    const wbFile = zip.file('xl/workbook.xml');
    if (!wbFile) {
      console.warn('[CacheService] Manual XML: no workbook.xml');
      return null;
    }
    const wbXml = await wbFile.async('string');
    const sheetInfoList = parseWorkbookXml(wbXml);

    // workbook.xml.rels -> r:id 与目标文件路径映射
    let sheetPathMap: Record<string, string> = {};
    const relsFile = zip.file('xl/_rels/workbook.xml.rels');
    if (relsFile) {
      const relsXml = await relsFile.async('string');
      sheetPathMap = parseWorkbookRelsXml(relsXml);
    } else {
      console.warn('[CacheService] Manual XML: no workbook.xml.rels');
    }

    // 读取目标 sheet 的 XML
    const targetSheetNamesLower = sheetNames.map(s => s.toLowerCase());
    const readAll = sheetNames.length === 0; // 空数组 = 读所有 sheet
    const result = new Map<string, any[][]>();
    for (const si of sheetInfoList) {
      // 只解析调用方指定的 sheet(空数组 = 读所有)
      if (!readAll && !targetSheetNamesLower.includes(si.name.toLowerCase())) {
        console.log(`[CacheService] Manual XML: skipping "${si.name}" (not in target list)`);
        continue;
      }
      const relPath = sheetPathMap[si.relId] || `worksheets/sheet${sheetInfoList.indexOf(si) + 1}.xml`;
      const sheetFile = zip.file('xl/' + relPath);
      if (!sheetFile) {
        console.warn(`[CacheService] Manual XML: no file for sheet "${si.name}" at xl/${relPath}`);
        continue;
      }
      const sheetXml = await sheetFile.async('string');
      const rows = parseSheetXmlToRows(sheetXml, sharedStrings);
      result.set(si.name, rows);
      console.log(`[CacheService] Manual XML sheet "${si.name}": ${rows.length} rows, ${rows[0]?.length || 0} cols`);
    }

    return result;

  } catch (e) {
    console.error('[CacheService] parseXlsxManually error:', e);
    return null;
  }
}

function parseWorkbookXml(xml: string): { name: string; relId: string }[] {
  const sheets: { name: string; relId: string }[] = [];
  const sheetRegex = /<sheet\s+([^>]+)\/?>/g;
  let sheetMatch;
  while ((sheetMatch = sheetRegex.exec(xml)) !== null) {
    const attrs = sheetMatch[1];
    const nameMatch = attrs.match(/name="([^"]*)"/);
    const ridMatch = attrs.match(/r:id="([^"]*)"/);
    if (nameMatch && ridMatch) {
      sheets.push({ name: nameMatch[1], relId: ridMatch[1] });
    }
  }
  return sheets;
}

function parseWorkbookRelsXml(xml: string): Record<string, string> {
  const map: Record<string, string> = {};
  const relRegex = /<Relationship\s+([^>]+)\/?>/g;
  let relMatch;
  while ((relMatch = relRegex.exec(xml)) !== null) {
    const attrs = relMatch[1];
    const idMatch = attrs.match(/Id="([^"]*)"/);
    const targetMatch = attrs.match(/Target="([^"]*)"/);
    if (idMatch && targetMatch) {
      map[idMatch[1]] = targetMatch[1];
    }
  }
  return map;
}

function parseSharedStringsXml(xml: string): string[] {
  const strings: string[] = [];
  let pos = 0;
  while ((pos = xml.indexOf('<si', pos)) !== -1) {
    // 跳过 <si 或 <si> 的开始标签
    const siOpenEnd = xml.indexOf('>', pos);
    if (siOpenEnd === -1) break;
    const siEnd = xml.indexOf('</si>', siOpenEnd);
    if (siEnd === -1) break;
    const siContent = xml.substring(siOpenEnd + 1, siEnd);

    // 支持两种格式:
    // 1. 简单格式: <si><t>value</t></si>
    // 2. 富文本格式: <si><r><t>part1</t></r><r><t>part2</t></r></si>
    // 统一做法: 收集所有 <t>...</t> 的文本并拼接
    let textParts: string[] = [];
    let tPos = 0;
    while ((tPos = siContent.indexOf('<t', tPos)) !== -1) {
      const tTagEnd = siContent.indexOf('>', tPos);
      if (tTagEnd === -1) break;
      // 检查是否是自闭合标签 <t/>
      if (tTagEnd > 0 && siContent[tTagEnd - 1] === '/') {
        textParts.push('');
        tPos = tTagEnd + 1;
        continue;
      }
      const tClose = siContent.indexOf('</t>', tTagEnd);
      if (tClose !== -1) {
        textParts.push(siContent.substring(tTagEnd + 1, tClose));
        tPos = tClose + 4;
      } else {
        break;
      }
    }

    strings.push(textParts.join(''));
    pos = siEnd + 5;
  }
  return strings;
}

function colLettersToIndex(colStr: string): number {
  let index = 0;
  for (let i = 0; i < colStr.length; i++) {
    index = index * 26 + colStr.charCodeAt(i) - 64;
  }
  return index - 1;
}

function parseSheetXmlToRows(xml: string, sharedStrings: string[]): any[][] {
  // 用 cellIndex（按行分组 + 按列序）替代二维稀疏网格，性能远优于正则
  const rowCells = new Map<number, { colIdx: number; value: any }[]>();
  const maxColPerRow = new Map<number, number>();
  let maxRow = 0;

  // indexOf 扫描替代正则 [\s\S]*?，避免灾难性回溯
  let pos = 0;
  while ((pos = xml.indexOf('<c ', pos)) !== -1) {
    // 定位 <c ...> 的闭合 >
    const tagEnd = xml.indexOf('>', pos);
    if (tagEnd === -1) { pos += 3; continue; }

    const cTag = xml.substring(pos + 3, tagEnd);

    // 提取 r="ColRow"
    const rIdx = cTag.indexOf('r="');
    if (rIdx === -1) { pos += 3; continue; }
    const rStart = rIdx + 3;
    const rEnd = cTag.indexOf('"', rStart);
    if (rEnd === -1) { pos += 3; continue; }
    const cellRef = cTag.substring(rStart, rEnd);

    // 拆分列字母与行号
    let colStr = '';
    let rowStr = '';
    for (let i = 0; i < cellRef.length; i++) {
      const ch = cellRef[i];
      if (ch >= '0' && ch <= '9') {
        colStr = cellRef.substring(0, i);
        rowStr = cellRef.substring(i);
        break;
      }
    }
    if (!colStr || !rowStr) { pos += 3; continue; }

    const colIdx = colLettersToIndex(colStr);
    const rowNum = parseInt(rowStr, 10);

    // 提取 t 属性
    const tIdx = cTag.indexOf('t="');
    let cellType = '';
    if (tIdx !== -1) {
      const tValEnd = cTag.indexOf('"', tIdx + 3);
      cellType = tValEnd !== -1 ? cTag.substring(tIdx + 3, tValEnd) : '';
    }

    // 检查是否是自闭合标签: <c r="B1" s="3"/>
    // 自闭合标签没有 <v> 或 <is> 内容,但仍然需要记录 colIdx 以便下游按列索引取数据
    const isSelfClosing = cTag.endsWith('/');
    if (isSelfClosing) {
      if (!rowCells.has(rowNum)) rowCells.set(rowNum, []);
      rowCells.get(rowNum)!.push({ colIdx, value: '' });
      const curMax = maxColPerRow.get(rowNum) ?? -1;
      maxColPerRow.set(rowNum, Math.max(curMax, colIdx));
      maxRow = Math.max(maxRow, rowNum);
      pos = tagEnd + 2; // 跳过 "/>"
      continue;
    }

    // 定位 </c>
    const closeTag = xml.indexOf('</c>', tagEnd);
    if (closeTag === -1) { pos += 3; continue; }
    const innerXml = xml.substring(tagEnd + 1, closeTag);

    // 提取单元格值
    let cellValue: any = '';
    if (cellType === 's' || cellType === 'str' || cellType === 'b' || !cellType) {
      const vIdx = innerXml.indexOf('<v>');
      if (vIdx !== -1) {
        const vEnd = innerXml.indexOf('</v>', vIdx);
        if (vEnd !== -1) {
          const rawVal = innerXml.substring(vIdx + 3, vEnd);
          if (cellType === 's') {
            cellValue = sharedStrings[parseInt(rawVal, 10)] ?? '';
          } else if (cellType === 'b') {
            cellValue = rawVal === '1' ? 'TRUE' : 'FALSE';
          } else {
            cellValue = rawVal;
          }
        }
      }
    } else if (cellType === 'inlineStr') {
      const tIdx2 = innerXml.indexOf('<t');
      if (tIdx2 !== -1) {
        const tTagEnd = innerXml.indexOf('>', tIdx2);
        const tEnd = innerXml.indexOf('</t>', tTagEnd);
        if (tTagEnd !== -1 && tEnd !== -1) {
          cellValue = innerXml.substring(tTagEnd + 1, tEnd);
        }
      }
    }

    // 按行分组，不构建完整稀疏网格
    if (!rowCells.has(rowNum)) rowCells.set(rowNum, []);
    rowCells.get(rowNum)!.push({ colIdx, value: cellValue });
    maxRow = Math.max(maxRow, rowNum);
    const curMax = maxColPerRow.get(rowNum) ?? -1;
    maxColPerRow.set(rowNum, Math.max(curMax, colIdx));

    pos = closeTag + 4; // 跳过 "</c>" 4 个字符
  }

  if (maxRow === 0) return [];

  // 计算整个 sheet 的最大列索引
  // 关键:必须用 sheet 级别的 maxCol(而不是每行单独的 maxCol)作为统一行长度
  // 否则 data row 只填前几列、col 9/19 等位置的 row[i] 会越界变 undefined,
  // 导致 parseRowsWithHeaders 的 siteId/lng/lat 全部读到 undefined,所有行被 skip → 0 sectors
  let sheetMaxCol = 0;
  for (const mc of maxColPerRow.values()) {
    if (mc > sheetMaxCol) sheetMaxCol = mc;
  }

  // 构建二维数组:每行统一长度 = sheetMaxCol + 1,空 cell 填充空字符串
  const result: any[][] = [];
  for (let r = 1; r <= maxRow; r++) {
    const cells = rowCells.get(r);
    const row: any[] = new Array(sheetMaxCol + 1).fill('');
    if (cells) {
      for (const cell of cells) {
        row[cell.colIdx] = cell.value;
      }
    }
    result.push(row);
  }
  return result;
}

// ====================

/**
 * 将站点-扇区嵌套结构转换为扁平扇区列表
 * 如果传入数据已是扁平结构（无 .sectors 属性），则直接透传
 */
function flattenSectors(lteSites: any[], nrSites: any[]): { lte: any[]; nr: any[] } {
  // 检测是否已是扁平结构（tryParseAllSheetsAsFullParams 新路径产出）
  const firstLte = lteSites[0];
  if (firstLte && !firstLte.sectors) {
    // 已是扁平扇区，直接透传
    for (const s of lteSites) s.networkType = 'LTE';
    for (const s of nrSites) s.networkType = 'NR';
    return { lte: lteSites, nr: nrSites };
  }
  // 传统路径：展开嵌套 ParsedSite[].sectors
  const flatLte: any[] = [];
  const flatNr: any[] = [];
  for (const site of lteSites) {
    for (const sec of site.sectors || []) {
      flatLte.push({
        ...sec,
        // 扇区本身没有经纬度，优先用扇区的，其次用站点的
        longitude: sec.longitude !== undefined ? sec.longitude : site.longitude,
        latitude: sec.latitude !== undefined ? sec.latitude : site.latitude,
        name: sec.name || site.name,
        networkType: 'LTE',
      });
    }
  }
  for (const site of nrSites) {
    for (const sec of site.sectors || []) {
      flatNr.push({
        ...sec,
        longitude: sec.longitude !== undefined ? sec.longitude : site.longitude,
        latitude: sec.latitude !== undefined ? sec.latitude : site.latitude,
        name: sec.name || site.name,
        networkType: 'NR',
      });
    }
  }
  return { lte: flatLte, nr: flatNr };
}

export const cacheService = new CacheService();
