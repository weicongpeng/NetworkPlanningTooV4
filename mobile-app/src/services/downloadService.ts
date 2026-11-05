/**
 * APK 下载服务
 *
 * 优化策略：
 *  - 优先走 Tailscale 地址（https://armbian.tail362392.ts.net）绕过 Cloudflare Tunnel 单连接限速
 *  - 使用 createDownloadResumable 流式下载到磁盘，避免大文件 OOM
 *  - 提供进度回调，UI 可实时显示下载百分比
 *  - Tailscale 不可达时自动回退到原始 URL，保证可用性
 *  - 下载完成后通过 expo-sharing 调起系统 APK 安装器
 *
 * 注：未采用「Range 请求分块并行下载」方案，原因：
 *  1. expo-file-system 不支持二进制文件原生拼接，base64 拼接对大 APK 会 OOM
 *  2. 即便 4 路并行，仍走同一条 CF Tunnel，瓶颈无法消除
 *  3. Tailscale 直连已能彻底绕过 Tunnel 限速，复杂度低且更稳定
 */

import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform, Linking, Alert } from 'react-native';

/** Tailscale 直连地址（绕过 Cloudflare Tunnel） */
const TAILSCALE_BASE = 'https://armbian.tail362392.ts.net';

/** 已知的服务器域名，用于 URL 替换 */
const KNOWN_HOSTS = [
  'https://app.pengwc.asia',
  'https://apk.pengwc.asia',
];

/** 下载进度信息 */
export interface DownloadProgressInfo {
  /** 文件总大小（字节），未知为 0 */
  totalBytes: number;
  /** 已下载字节 */
  downloadedBytes: number;
  /** 进度百分比 0-100 */
  percent: number;
}

/** 下载结果 */
export type DownloadResult =
  | { ok: true; uri: string; fromUrl: string }
  | { ok: false; error: string };

/**
 * 将原始下载 URL 转换为 Tailscale 直连 URL
 * 仅替换已知域名，保留路径与查询参数
 */
export function buildTailscaleUrl(downloadUrl: string): string | null {
  for (const host of KNOWN_HOSTS) {
    if (downloadUrl.startsWith(host)) {
      return TAILSCALE_BASE + downloadUrl.substring(host.length);
    }
  }
  return null;
}

/**
 * 构造下载候选 URL 列表
 * 顺序：Tailscale 优先 → 原始 URL 兜底
 */
function buildCandidateUrls(downloadUrl: string, currentBaseUrl: string): string[] {
  const urls: string[] = [];

  // 1) 优先 Tailscale
  const tailscaleUrl = buildTailscaleUrl(downloadUrl);
  if (tailscaleUrl && tailscaleUrl !== downloadUrl) {
    urls.push(tailscaleUrl);
  }

  // 2) 若下载 URL 基于当前 baseUrl，且当前 baseUrl 非 Tailscale，也尝试 Tailscale + 当前路径
  if (currentBaseUrl && downloadUrl.startsWith(currentBaseUrl)) {
    const path = downloadUrl.substring(currentBaseUrl.length);
    const tsViaCurrent = TAILSCALE_BASE + path;
    if (!urls.includes(tsViaCurrent)) {
      urls.push(tsViaCurrent);
    }
  }

  // 3) 原始 URL 兜底
  if (!urls.includes(downloadUrl)) {
    urls.push(downloadUrl);
  }

  return urls;
}

/** 确保目录存在 */
async function ensureDir(dir: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

/**
 * 下载 APK 文件到本地
 *
 * @param downloadUrl 后端返回的 APK 下载 URL
 * @param currentBaseUrl 当前生效的 API 基础地址
 * @param onProgress 进度回调（可选）
 */
export async function downloadApk(
  downloadUrl: string,
  currentBaseUrl: string,
  onProgress?: (info: DownloadProgressInfo) => void,
): Promise<DownloadResult> {
  if (!downloadUrl) {
    return { ok: false, error: '下载地址为空' };
  }

  const apkDir = `${FileSystem.documentDirectory}apk/`;
  const apkPath = `${apkDir}update.apk`;

  try {
    await ensureDir(apkDir);
  } catch {
    return { ok: false, error: '无法创建下载目录' };
  }

  // 清理旧的临时分片和 APK
  for (let i = 0; i < 4; i++) {
    await FileSystem.deleteAsync(`${apkDir}part_${i}.apk`, { idempotent: true }).catch(() => {});
  }
  await FileSystem.deleteAsync(apkPath, { idempotent: true }).catch(() => {});

  const candidates = buildCandidateUrls(downloadUrl, currentBaseUrl);
  const errors: string[] = [];

  for (const url of candidates) {
    try {
      const result = await downloadSingle(url, apkPath, onProgress);
      if (result.ok) {
        return { ok: true, uri: apkPath, fromUrl: url };
      }
      errors.push(`${url}: ${result.error}`);
    } catch (e: any) {
      errors.push(`${url}: ${e?.message || String(e)}`);
    }
    // 失败后清理半成品文件，准备下一个候选
    await FileSystem.deleteAsync(apkPath, { idempotent: true }).catch(() => {});
  }

  return { ok: false, error: `所有下载源均失败\n${errors.join('\n')}` };
}

/** 单源下载（带进度回调） */
async function downloadSingle(
  url: string,
  fileUri: string,
  onProgress?: (info: DownloadProgressInfo) => void,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const resumable = FileSystem.createDownloadResumable(
      url,
      fileUri,
      {
        headers: {
          // 模拟浏览器 UA，避免被 CF/nginx 拦截
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.159 Mobile Safari/537.36',
          'Accept': 'application/vnd.android.package-archive, application/octet-stream, */*',
        },
      },
      (downloadProgress) => {
        if (onProgress) {
          const total = downloadProgress.totalBytesExpectedToWrite || 0;
          const written = downloadProgress.totalBytesWritten || 0;
          const percent = total > 0 ? Math.min(100, (written / total) * 100) : 0;
          onProgress({ totalBytes: total, downloadedBytes: written, percent });
        }
      },
    );

    resumable
      .downloadAsync()
      .then((result) => {
        if (!result) {
          resolve({ ok: false, error: '下载返回空结果' });
          return;
        }
        if (result.status >= 200 && result.status < 300) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: `HTTP ${result.status}` });
        }
      })
      .catch((e: any) => {
        resolve({ ok: false, error: e?.message || String(e) });
      });
  });
}

/**
 * 调起系统 APK 安装器
 * 失败时回退到 Linking.openURL（浏览器下载）
 */
export async function installApk(fileUri: string): Promise<void> {
  if (Platform.OS !== 'android') {
    throw new Error('仅支持 Android 平台');
  }

  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error('系统不支持分享，无法安装');
  }

  await Sharing.shareAsync(fileUri, {
    mimeType: 'application/vnd.android.package-archive',
    dialogTitle: '安装网优伴侣更新',
  });
}

/**
 * 一键下载并安装 APK（含错误兜底）
 * 下载失败时自动回退到浏览器打开
 */
export async function downloadAndInstall(
  downloadUrl: string,
  currentBaseUrl: string,
  onProgress?: (info: DownloadProgressInfo) => void,
): Promise<void> {
  const result = await downloadApk(downloadUrl, currentBaseUrl, onProgress);

  if (!result.ok) {
    // 兜底：浏览器打开原始 URL
    Alert.alert(
      '应用内下载失败',
      '是否使用浏览器下载？\n\n错误信息：' + (result as any).error,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '浏览器下载',
          onPress: () => {
            Linking.openURL(downloadUrl).catch(() => {
              Alert.alert('提示', '无法打开下载链接');
            });
          },
        },
      ],
    );
    return;
  }

  try {
    await installApk(result.uri);
  } catch (e: any) {
    Alert.alert(
      '安装失败',
      'APK 已下载但无法直接安装，是否用浏览器打开？\n\n' + (e?.message || ''),
      [
        { text: '取消', style: 'cancel' },
        {
          text: '浏览器打开',
          onPress: () => {
            Linking.openURL(downloadUrl).catch(() => {});
          },
        },
      ],
    );
  }
}
