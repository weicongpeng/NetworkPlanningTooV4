import axios, { AxiosInstance } from 'axios';
import { getEffectiveApiUrl, getEffectiveApiBaseUrl, setCustomApiUrl, resetCustomApiUrl, testApiConnection } from '../utils/config';
import { getToken } from './auth';

class ApiService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: 30000,
      headers: {
        // 模拟浏览器请求头，避免被 Cloudflare/nginx 等代理拦截（返回 502）
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.159 Mobile Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'X-Client': 'app',  // 标识为移动 APP 端，便于后端 /admin/app-users 区分
      },
    });

    // 请求拦截器：每次请求前动态获取当前生效的 API 地址 + 附加登录 token
    this.client.interceptors.request.use(async (config) => {
      config.baseURL = await getEffectiveApiUrl();
      // 若用户已登录，自动附带 JWT，后续受保护接口无需手动加 header
      const token = await getToken();
      if (token) {
        config.headers = config.headers || ({} as any);
        (config.headers as any).Authorization = `Bearer ${token}`;
      }
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

  // ==================== 核心数据 API（用于缓存拉取） ====================

  async getSystemInfo() {
    const response = await this.client.get('/system/info');
    return response.data;
  }

  /**
   * 获取扇区数据（移动端轻量版）
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

  /**
   * 直接从后端 URL 下载 JSON 数据到本地文件
   * 用于缓存 GeoJSON/TAB 渲染数据
   */
  async downloadRawJson(path: string): Promise<any> {
    const response = await this.client.get(path);
    return response.data;
  }

  // ==================== 搜索 API ====================

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

  // ==================== 应用版本 API ====================

  /**
   * 检查最新 APP 版本
   * 后端端点: GET /api/v1/system/app-version
   * 返回: { version, download_url, file_size_display, changelog }
   */
  async checkAppVersion(): Promise<{
    version?: string;
    download_url?: string;
    file_size_display?: string;
    changelog?: string;
  } | null> {
    try {
      const response = await this.client.get('/system/app-version', { timeout: 10000 });
      return response.data?.data ?? response.data ?? null;
    } catch {
      return null;
    }
  }
}

export const apiService = new ApiService();
