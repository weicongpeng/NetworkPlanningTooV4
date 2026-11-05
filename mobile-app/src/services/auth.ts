// ==================== 用户认证服务 ====================
//
// 后端契约（与 /admin/app-users 管理页面对接）：
//   POST /api/v1/auth/login
//     body:   { username, password, client_type: "app" }   ← 登录必须带 client_type
//     resp:   { success, message, data: { token, user } }
//
//   POST /api/v1/auth/register
//     body:   { username, password, confirm_password, city, operator }
//     说明:   注册后自动开通 PC + APP 双重访问权，不需要再传 user_type
//     resp:   { success, message, data: { token, user } }
//
//   POST /api/v1/auth/logout
//     header: Authorization: Bearer <token>
//     resp:   { success: true, message: "已退出登录" }
//     说明:   主动调用让后端立即将会话标记为离线；不调用也无所谓，5 分钟
//            内 last_activity 过期后后端会自动判定离线
//
//   POST /api/v1/auth/ping
//     header: Authorization: Bearer <token>
//     说明:   每 5 分钟调用一次保持 last_activity 刷新，在线状态不中断
//            调用失败不抛错（网络差时仅日志），由 useHeartbeat 钩子自动调度
//
//   GET  /api/v1/auth/me   (可选)
//     resp:   { success, message, data: { ...user } }
//
// 用户登录后所有请求会通过 apiService 拦截器自动附带：
//   Authorization: Bearer <token>
//   X-Client: app        (帮助后端 /admin/app-users 识别客户端类型)

import AsyncStorage from '@react-native-async-storage/async-storage';
import axios, { AxiosInstance } from 'axios';
import { getEffectiveApiUrl } from '../utils/config';

// ==================== 存储键 ====================

const STORAGE_KEY_TOKEN = '@auth_token';
const STORAGE_KEY_USER = '@auth_user';

// ==================== 类型定义 ====================

export interface AuthUser {
  id?: number | string;
  username: string;
  email?: string;
  avatar?: string;
  user_type?: string;
  [k: string]: any;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

interface BackendEnvelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
  // 容错：部分后端直接返回 { token, user }，没包一层
  [k: string]: any;
}

// ==================== 独立 axios 实例（不走 apiService 的拦截器，避免循环） ====================

function createAuthClient(): AxiosInstance {
  const client = axios.create({
    timeout: 15000,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.159 Mobile Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'X-Client': 'app',  // 告诉后端这是移动 App 端（与 web 后台区分）
    },
  });
  // 每次请求前解析最新 baseURL
  client.interceptors.request.use(async (config) => {
    config.baseURL = await getEffectiveApiUrl();
    // 如果本地有 token，也附加上（部分接口如 /me 需要）
    const token = await getToken();
    if (token) {
      config.headers = config.headers || ({} as any);
      (config.headers as any).Authorization = `Bearer ${token}`;
    }
    return config;
  });
  return client;
}

const client = createAuthClient();

// ==================== Token 管理 ====================

export async function getToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(STORAGE_KEY_TOKEN);
  } catch {
    return null;
  }
}

export async function setToken(token: string): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY_TOKEN, token);
}

export async function clearToken(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY_TOKEN);
}

export async function getStoredUser(): Promise<AuthUser | null> {
  try {
    const s = await AsyncStorage.getItem(STORAGE_KEY_USER);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export async function setStoredUser(user: AuthUser): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
}

export async function clearStoredUser(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY_USER);
}

// ==================== 响应解析（兼容 {success,data} 与平铺两种格式） ====================

/** 从任意对象中按多个候选键名取值 */
function pick<T = any>(obj: any, keys: string[]): T | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function pickAuthPayload(raw: any): AuthResponse {
  console.log('[Auth] 原始响应:', JSON.stringify(raw));
  // 1) 标准信封：{ success, message, data: { token/user/... } }
  if (raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object') {
    const token = pick<string>(raw.data, ['token', 'access_token', 'accessToken', 'auth_token', 'authToken', 'jwt']);
    const user = pick(raw.data, ['user', 'profile', 'account', 'me']) || raw.data;
    if (token) {
      return { token, user };
    }
  }
  // 2) 平铺：{ token, user } 或 { access_token, user }
  const flatToken = pick<string>(raw, ['token', 'access_token', 'accessToken', 'auth_token', 'authToken', 'jwt']);
  if (flatToken) {
    const user = pick(raw, ['user', 'profile', 'account', 'me']) || { username: raw.username };
    return { token: flatToken, user };
  }
  // 3) 响应里完全没有 token —— 后端可能用 cookie/session 而非 token
  // 此时我们拿不到任何长期凭证，但响应里通常包含 user 信息
  const flatUser = pick(raw, ['user', 'profile', 'account', 'me'])
    || (raw.username ? raw : null)
    || (raw.data && typeof raw.data === 'object' ? raw.data : null);
  if (flatUser && (flatUser.username || flatUser.id)) {
    throw new Error('后端登录成功但未返回 token 字段。请确认后端 /api/v1/auth/login 在响应 JSON 中返回 token（或 access_token）字段，否则无法维持登录态。');
  }
  throw new Error('响应格式错误：未找到 token / user。原始响应: ' + JSON.stringify(raw).slice(0, 200));
}

// ==================== 错误信息提取 ====================

function extractError(e: any, fallback: string): Error {
  if (e?.response?.data) {
    const d = e.response.data;
    if (typeof d === 'string') return new Error(d);
    if (d.message) return new Error(d.message);
    if (d.error) return new Error(d.error);
    if (d.detail) return new Error(d.detail);
  }
  if (e?.message) return new Error(e.message);
  return new Error(fallback);
}

// ==================== 业务 API ====================

/**
 * 登录
 * 请求体：{ username, password, client_type: 'app' }
 *   - client_type: 告诉后端这是 APP 端登录，会在 /admin/app-users 中显示登录记录
 */
export async function login(username: string, password: string): Promise<AuthResponse> {
  try {
    console.log('[Auth] login →', username, 'client_type=app');
    const resp = await client.post<BackendEnvelope<AuthResponse>>('/auth/login', {
      username,
      password,
      client_type: 'app',  // 关键字段：后端用于区分客户端类型
    });
    const payload = pickAuthPayload(resp.data);
    if (!payload.token) throw new Error('登录成功但未返回 token');
    await setToken(payload.token);
    await setStoredUser(payload.user);
    console.log('[Auth] login ok, user:', payload.user?.username);
    return payload;
  } catch (e: any) {
    console.warn('[Auth] login failed:', e?.response?.status, e?.response?.data || e?.message);
    throw extractError(e, '登录失败，请稍后重试');
  }
}

/**
 * 注册
 * 请求体：{ username, password, confirm_password, city, operator }
 *   - 不再传 user_type：后端自动赋予 PC + APP 双重访问权
 *   - city: 地市（与 PC 端对齐）
 *   - operator: 运营商（与 PC 端下拉列表对齐，取值 移动/电信/联通/广电）
 */
export async function register(
  username: string,
  password: string,
  extra: { city?: string; operator?: string; email?: string } = {},
): Promise<AuthResponse> {
  try {
    console.log('[Auth] register →', username, 'city=', extra.city, 'operator=', extra.operator);
    const body: Record<string, any> = {
      username,
      password,
      confirm_password: password,
    };
    if (extra.city) body.city = extra.city;
    if (extra.operator) body.operator = extra.operator;
    if (extra.email) body.email = extra.email;
    const resp = await client.post<BackendEnvelope<AuthResponse>>('/auth/register', body);
    const payload = pickAuthPayload(resp.data);
    if (!payload.token) throw new Error('注册成功但未返回 token，请尝试手动登录');
    await setToken(payload.token);
    await setStoredUser(payload.user);
    console.log('[Auth] register ok, user:', payload.user?.username);
    return payload;
  } catch (e: any) {
    console.warn('[Auth] register failed:', e?.response?.status, e?.response?.data || e?.message);
    throw extractError(e, '注册失败，请稍后重试');
  }
}

/** 获取当前登录用户信息（用于 token 有效性校验） */
export async function fetchMe(): Promise<AuthUser> {
  try {
    const resp = await client.get<BackendEnvelope<{ user: AuthUser }>>('/auth/me');
    const raw: any = resp.data;
    const user = raw?.data?.user || raw?.data || raw;
    await setStoredUser(user);
    return user;
  } catch (e: any) {
    throw extractError(e, '获取用户信息失败');
  }
}

/**
 * 退出登录
 * 1) 调用后端 /api/v1/auth/logout（带当前 token），让后端立即将会话标记为已登出
 * 2) 不管后端是否成功，清除本地 token + user
 *
 * 失败兜底：后端调用失败不阻塞本地清理，5 分钟后后端也会通过 last_activity 自动判定离线
 */
export async function logout(): Promise<void> {
  try {
    const token = await getToken();
    if (token) {
      // 调用后端登出接口，立即标记为离线
      // 注：不使用全局 apiClient，避免和 apiService 的业务接口混在一起；走独立 client
      const baseURL = await getEffectiveApiUrl();
      await fetch(`${baseURL}/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client': 'app',
          'Authorization': `Bearer ${token}`,
        },
      }).catch((e) => {
        console.warn('[Auth] 后端 logout 调用失败（不影响本地清理）:', e?.message);
      });
    }
  } catch (e) {
    console.warn('[Auth] logout 异常:', e);
  }
  // 无论后端调用结果如何，都清本地
  await clearToken();
  await clearStoredUser();
}

/**
 * 心跳保活
 * 调用后端 /api/v1/auth/ping 刷新 last_activity，保持 APP 会话在线
 * 失败不抛错（仅日志），由 useHeartbeat 钩子每 5 分钟调用一次
 */
export async function ping(): Promise<void> {
  const token = await getToken();
  if (!token) return;
  try {
    const baseURL = await getEffectiveApiUrl();
    await fetch(`${baseURL}/auth/ping`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client': 'app',
        'Authorization': `Bearer ${token}`,
      },
    });
    // console.log('[Auth] ping ok');
  } catch (e: any) {
    console.warn('[Auth] ping failed（不影响）:', e?.message);
  }
}

/** 是否已登录（有 token） */
export async function isAuthenticated(): Promise<boolean> {
  return !!(await getToken());
}
