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
  let trimmed = url.trim().replace(/\/+$/, '');
  // 自动去除用户可能输入的 /api/v1 后缀，避免双重前缀
  if (trimmed.endsWith('/api/v1')) {
    trimmed = trimmed.slice(0, -7);
  }
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
    console.log('[Config] 使用自定义地址:', customUrl);
    return customUrl;
  }

  // 2. 环境变量（可用于生产或自定义配置）
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl) {
    console.log('[Config] 使用环境变量:', envUrl);
    return envUrl;
  }

  // 3. 从 Expo 调试主机推导电脑的局域网 IP
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const ip = hostUri.split(':')[0];
    const url = `http://${ip}:8000`;
    console.log('[Config] 使用LAN IP:', url);
    return url;
  }

  // 4. 回退到 localhost（仅适用于模拟器或本机调试）
  console.log('[Config] 回退到 localhost');
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
  const baseUrl = url.replace(/\/+$/, '');
  const testUrl = `${baseUrl}/api/v1/system/info`;

  // 尝试多种方式连接，兼容 React Native 不同版本的 fetch 实现
  for (const attempt of [
    { label: 'fetch', fn: () => fetchWithTimeout(testUrl, 15000) },
    { label: 'fetch-no-signal', fn: () => fetch(testUrl, { headers: { Accept: 'application/json' } }) },
  ]) {
    try {
      const response = await attempt.fn();
      if (response.ok) {
        return { ok: true, message: '连接成功' };
      }
      const body = await response.text().catch(() => '');
      // 只要服务器有响应（即使不是 200），说明网络是通的，只是端点问题
      return { ok: false, message: `服务器已响应，但返回状态码 ${response.status}\n路径: ${testUrl}` };
    } catch (e: any) {
      const errMsg = e.message || '';
      console.log(`[Config] 连接尝试(${attempt.label})失败:`, errMsg.slice(0, 200));
      // 如果是 abort（超时），继续尝试下一个方式
      if (errMsg.includes('aborted') || errMsg.includes('Abort')) continue;
      // 如果是 DNS 解析失败，继续尝试下一个
      if (errMsg.includes('resolve') || errMsg.includes('DNS')) continue;
      // 网络不通直接返回
      if (errMsg.includes('Network request failed') || errMsg.includes('ERR_CONNECTION')) {
        return { ok: false, message: `无法连接到 ${baseUrl}\n请确认：\n1. 手机与服务器网络互通\n2. 地址正确（注意是 apk.pengwc.asia 不是 app）\n3. 后端服务已启动` };
      }
    }
  }

  return {
    ok: false,
    message: `连接测试均失败\n地址: ${testUrl}\n\n请确认：\n1. 后端服务是否正常运行\n2. 地址是否正确（建议用手机浏览器打开上面的地址验证）`,
  };
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  // 用 Promise.race 替代 AbortController，兼容性更好
  return Promise.race([
    fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.159 Mobile Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('aborted')), ms)
    ),
  ]);
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
