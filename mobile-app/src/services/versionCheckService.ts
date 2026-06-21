/**
 * APP 版本检查服务
 * 提供版本比较、检查间隔管理等工具函数
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY_LAST_CHECK = '@npt_version_last_check';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 小时

/**
 * 语义化版本比较
 * @returns 1 = v1 > v2, -1 = v1 < v2, 0 = 相等
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const a = parts1[i] || 0;
    const b = parts2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

/**
 * 判断 latest 是否为比 current 更新的版本
 */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

/**
 * 检查是否到了需要检查版本的时间
 */
export async function shouldCheckVersion(): Promise<boolean> {
  try {
    const lastCheck = await AsyncStorage.getItem(STORAGE_KEY_LAST_CHECK);
    if (!lastCheck) return true;
    return Date.now() - parseInt(lastCheck, 10) > CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

/**
 * 标记本次版本检查时间
 */
export async function markVersionChecked(): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY_LAST_CHECK, String(Date.now()));
  } catch {
    // ignore
  }
}
