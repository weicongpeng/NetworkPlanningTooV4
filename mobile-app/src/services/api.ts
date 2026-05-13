import axios, { AxiosInstance } from 'axios';
import { getEffectiveApiUrl, getEffectiveApiBaseUrl, setCustomApiUrl, resetCustomApiUrl, testApiConnection } from '../utils/config';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

class ApiService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: 30000,
    });

    // 请求拦截器：每次请求前动态获取当前生效的 API 地址
    // 这样在 App 设置页修改后端地址后，后续所有请求自动使用新地址
    this.client.interceptors.request.use(async (config) => {
      config.baseURL = await getEffectiveApiUrl();
      return config;
    });
  }

  // ==================== 运行时地址切换 ====================

  /**
   * 更新后端 API 地址（立即生效，无需重装 App）
   * @param url 完整的后端基础地址，如 https://apk.pengwc.asia
   */
  async updateApiUrl(url: string): Promise<void> {
    await setCustomApiUrl(url);
  }

  /**
   * 切换回自动发现模式（LAN IP / localhost）
   */
  async resetApiUrl(): Promise<void> {
    await resetCustomApiUrl();
  }

  /**
   * 获取当前生效的后端基础地址
   */
  async getCurrentBaseUrl(): Promise<string> {
    return getEffectiveApiBaseUrl();
  }

  async getFullApiUrl(): Promise<string> {
    return getEffectiveApiUrl();
  }

  /**
   * 测试指定的后端地址是否可达
   */
  async testConnection(url: string): Promise<{ ok: boolean; message: string }> {
    return testApiConnection(url);
  }

  // ==================== API 方法 ====================

  async getSystemInfo() {
    const response = await this.client.get('/system/info');
    return response.data;
  }

  async getMapData() {
    const response = await this.client.get('/map/data');
    return response.data;
  }

  /**
   * 获取扇区数据（移动端轻量版）
   * 返回扁平化的扇区数组，数据量约为 getMapData 的 15-20%
   * 后端端点: GET /api/v1/map/sectors
   */
  async getSectors(timeoutMs = 60000) {
    const response = await this.client.get('/map/sectors', { timeout: timeoutMs });
    return response.data;
  }

  async getLayers(dataId: string) {
    const response = await this.client.get(`/data/${dataId}/layers`);
    return response.data;
  }

  async getLayerData(dataId: string, layerId: string) {
    const response = await this.client.get(`/data/${dataId}/layers/${layerId}/data`);
    return response.data;
  }

  // 获取移动端渲染数据（坐标已转换GCJ02，可直接渲染）
  async getMobileRenderData(dataId: string) {
    const response = await this.client.get(`/data/${dataId}/render-mobile`);
    return response.data;
  }

  async getDataList() {
    const response = await this.client.get('/data/list');
    return response.data;
  }

  async searchParameter(keyword: string) {
    const response = await this.client.get('/map/data', { params: { limit: 10000 } });
    if (response.data.success && response.data.data) {
      const sites = response.data.data.sites || [];
      const lowerKeyword = keyword.toLowerCase();
      const results: any[] = [];

      sites.forEach((site: any) => {
        if (!site.sectors || !Array.isArray(site.sectors)) return;
        site.sectors.forEach((sector: any) => {
          const sectorName = sector.name || '';
          const siteId = site.id || site.siteId || '';
          const sectorId = sector.id || sector.cellId || '';
          if (
            sectorName.toLowerCase().includes(lowerKeyword) ||
            siteId.toLowerCase().includes(lowerKeyword) ||
            sectorId.toLowerCase().includes(lowerKeyword)
          ) {
            results.push({
              name: sectorName,
              siteId: siteId,
              sectorId: sectorId,
              latitude: sector.latitude ?? site.latitude,
              longitude: sector.longitude ?? site.longitude,
              networkType: site.networkType,
              pci: sector.pci,
              azimuth: sector.azimuth,
            });
          }
        });
      });

      return results.slice(0, 20);
    }
    return [];
  }

  async searchPlace(keyword: string) {
    const apiKey = '9fa8b08372c3c764fd14d0bc74862ad1';
    const url = `https://restapi.amap.com/v3/place/text?key=${apiKey}&keywords=${encodeURIComponent(keyword)}&output=json`;
    const response = await fetch(url);
    return response.json();
  }

  async downloadData(dataId: string, filename: string): Promise<{ success: boolean; message: string }> {
    try {
      // 每次下载前获取最新的 API 地址
      const currentUrl = await getEffectiveApiUrl();
      const url = `${currentUrl}/data/${dataId}/download`;
      
      // 构建本地文件路径
      const localUri = `${FileSystem.cacheDirectory}${filename}`;
      
      // 下载文件到本地缓存目录
      const downloadResult = await FileSystem.downloadAsync(url, localUri);
      
      if (downloadResult.status === 200) {
        // 使用 Sharing 分享/保存文件
        await Sharing.shareAsync(localUri);
        return { success: true, message: '文件已下载' };
      } else {
        throw new Error(`下载失败: ${downloadResult.status}`);
      }
    } catch (error: any) {
      console.error('[downloadData] 下载失败:', error);
      throw error;
    }
  }

  async deleteData(dataId: string, force = false) {
    const response = await this.client.delete(`/data/${dataId}`, { params: { force } });
    return response.data;
  }

  async getDataPreview(dataId: string) {
    const response = await this.client.get(`/data/${dataId}`);
    return response.data;
  }
}

export const apiService = new ApiService();
