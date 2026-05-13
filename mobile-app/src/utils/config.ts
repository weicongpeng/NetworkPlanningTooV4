import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

const AMAP_CONFIG = {
  androidKey: 'YOUR_ANDROID_SDK_KEY',
  webJsKey: '9fa8b08372c3c764fd14d0bc74862ad1',
};

const API_PREFIX = '/api/v1';

// AsyncStorage 存储键名
const STORAGE_KEY_CUSTOM_API_URL = '@npt_custom_api_url';

/**
 * 保存用户手动设置的自定义后端地址
 * 用户可在 App 设置页输入，如：https://apk.pengwc.asia
 */
async function setCustomApiUrl(url: string): Promise<void> {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed) {
    await AsyncStorage.setItem(STORAGE_KEY_CUSTOM_API_URL, trimmed);
  } else {
    await AsyncStorage.removeItem(STORAGE_KEY_CUSTOM_API_URL);
  }
}

/**
 * 清除自定义地址，恢复自动发现
 */
async function resetCustomApiUrl(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY_CUSTOM_API_URL);
}

/**
 * 获取用户手动设置的自定义后端地址
 */
async function getCustomApiUrl(): Promise<string | null> {
  return AsyncStorage.getItem(STORAGE_KEY_CUSTOM_API_URL);
}

/**
 * 获取当前生效的后端基础地址
 * 优先级：自定义地址 > 环境变量 > LAN IP > localhost
 */
async function getEffectiveApiBaseUrl(): Promise<string> {
  // 1. 用户手动设置（最高优先级，支持运行时切换）
  const customUrl = await getCustomApiUrl();
  if (customUrl) {
    return customUrl;
  }

  // 2. 环境变量（可用于生产或自定义配置）
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl) {
    return envUrl;
  }

  // 3. 从 Expo 调试主机推导电脑的局域网 IP
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const ip = hostUri.split(':')[0];
    return `http://${ip}:8000`;
  }

  // 4. 回退到 localhost（仅适用于模拟器或本机调试）
  return 'http://localhost:8000';
}

/**
 * 获取当前生效的完整 API 地址（基础地址 + /api/v1）
 */
async function getEffectiveApiUrl(): Promise<string> {
  const baseUrl = await getEffectiveApiBaseUrl();
  return `${baseUrl}${API_PREFIX}`;
}

/**
 * 测试后端连接是否可用
 */
async function testApiConnection(url: string): Promise<{ ok: boolean; message: string }> {
  try {
    const testUrl = url.replace(/\/+$/, '') + '/api/v1/system/info';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(testUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (response.ok) {
      return { ok: true, message: '连接成功' };
    }
    return { ok: false, message: `服务器返回状态码 ${response.status}` };
  } catch (error: any) {
    return { ok: false, message: `连接失败: ${error.message || '未知错误'}` };
  }
}

// 保留 BACKEND_CONFIG 向后兼容（静态值，仅用于模块加载时的初始回退）
const BACKEND_CONFIG = {
  baseUrl: (() => {
    const envUrl = process.env.EXPO_PUBLIC_API_URL;
    if (envUrl) return envUrl;
    const hostUri = Constants.expoConfig?.hostUri;
    if (hostUri) {
      const ip = hostUri.split(':')[0];
      return `http://${ip}:8000`;
    }
    return 'http://localhost:8000';
  })(),
  apiPrefix: API_PREFIX,
};

export {
  AMAP_CONFIG,
  BACKEND_CONFIG,
  API_PREFIX,
  getEffectiveApiBaseUrl,
  getEffectiveApiUrl,
  setCustomApiUrl,
  resetCustomApiUrl,
  getCustomApiUrl,
  testApiConnection,
};
