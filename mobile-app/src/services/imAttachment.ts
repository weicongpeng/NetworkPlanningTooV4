/** IM 附件：拍照/相册/文件选择、分片上传、图片直链与 Bearer 回退下载。 */
import * as FileSystem from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';

import { imApi } from './imApi';
import { getToken } from './auth';
import type { ImAttachmentBrief, PendingAttachment } from '../types/im';

/**
 * expo-image-picker 是新增的原生模块：旧 APK 里没有编译进 ExponentImagePicker，
 * 顶层 import 会让整个 App 启动崩溃。这里改成可失败加载，缺模块时拍照给出提示、
 * 相册降级到已存在的文档选择器，重新出包后自动恢复完整能力。
 */
type ImagePickerModule = typeof import('expo-image-picker');
let ImagePicker: ImagePickerModule | null = null;
try {
  ImagePicker = require('expo-image-picker') as ImagePickerModule;
} catch {
  ImagePicker = null;
}

const CHUNK_SIZE = 2 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel', csv: 'text/csv', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain', zip: 'application/zip',
};

export function newClientMsgId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function mimeOf(name: string, fallback?: string | null): string {
  if (fallback) return fallback;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

async function infoOf(uri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists && typeof info.size === 'number' ? info.size : 0;
}

/** 拍照：拒绝权限时返回 null，由 UI 提示用户改用相册。 */
export async function pickFromCamera(square = false): Promise<PendingAttachment | null> {
  if (!ImagePicker) {
    throw new Error('当前安装包未包含相机模块，请重新安装新版 APK；也可先用「件」从文件里选图片');
  }
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error('未获得相机权限，请在系统设置中开启');
  const result = await ImagePicker.launchCameraAsync({
    quality: square ? 0.5 : 0.6,
    allowsEditing: square,
    ...(square ? { aspect: [1, 1] as [number, number] } : {}),
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  const name = asset.fileName || `photo-${Date.now()}.jpg`;
  return {
    uri: asset.uri, name,
    mime: mimeOf(name, asset.mimeType),
    size: typeof asset.fileSize === 'number' ? asset.fileSize : await infoOf(asset.uri),
  };
}

export async function pickFromLibrary(square = false): Promise<PendingAttachment | null> {
  if (!ImagePicker) return pickFromFile();
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error('未获得相册权限，请在系统设置中开启');
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: square ? 0.5 : 0.6,
    allowsEditing: square,
    ...(square ? { aspect: [1, 1] as [number, number] } : {}),
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  const name = asset.fileName || `image-${Date.now()}.jpg`;
  return {
    uri: asset.uri, name,
    mime: mimeOf(name, asset.mimeType),
    size: typeof asset.fileSize === 'number' ? asset.fileSize : await infoOf(asset.uri),
  };
}

export async function pickFromFile(): Promise<PendingAttachment | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = (result as any).assets?.[0] || (result as any);
  if (!asset?.uri) return null;
  const name = asset.name || `file-${Date.now()}`;
  return {
    uri: asset.uri, name,
    mime: mimeOf(name, asset.mimeType),
    size: typeof asset.size === 'number' ? asset.size : await infoOf(asset.uri),
  };
}

/** 三步分片上传；取消时清掉服务端临时分片。 */
export async function uploadAttachment(
  conversationId: number,
  attachment: PendingAttachment,
  onProgress?: (percent: number) => void,
  isCancelled?: () => boolean,
): Promise<ImAttachmentBrief> {
  const size = await infoOf(attachment.uri) || attachment.size;
  if (!size) throw new Error('文件为空或无法读取');
  const started = await imApi.attachmentStart(conversationId, attachment.name, attachment.mime, size);
  const chunkSize = started.chunk_size > 0 ? started.chunk_size : CHUNK_SIZE;
  const uploadId = started.upload_id;
  const total = started.total_chunks;
  try {
    // 后端 write_chunk 带锁按 offset 写入，分片顺序无关；并发 3 片把公网 RTT 叠加去掉
    let nextIndex = 0;
    let done = 0;
    const worker = async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= total) return;
        if (isCancelled?.()) throw new Error('上传已取消');
        const position = index * chunkSize;
        const length = Math.min(chunkSize, size - position);
        const dataB64 = await FileSystem.readAsStringAsync(attachment.uri, {
          encoding: FileSystem.EncodingType.Base64, position, length,
        });
        await imApi.attachmentChunk(uploadId, index, dataB64);
        done += 1;
        onProgress?.(Math.round((done / total) * 100));
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, total) }, () => worker()));
    return await imApi.attachmentComplete(uploadId);
  } catch (error) {
    if (isCancelled?.()) await imApi.attachmentCancel(uploadId);
    throw error;
  }
}

const imageCacheDir = `${FileSystem.cacheDirectory}im/`;

async function ensureCacheDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(imageCacheDir);
  if (!info.exists) await FileSystem.makeDirectoryAsync(imageCacheDir, { intermediates: true });
}

/**
 * 图片显示：缩略图落本地缓存（消息气泡加载时顺带下载，灯箱打开即命中，无网络等待）；
 * 全图走签名直链交给 RN Image 缓存，避免为了预览先下载几 MB。
 */
export async function resolveImageUri(attachmentId: number, thumb: boolean): Promise<string> {
  await ensureCacheDir();
  const target = `${imageCacheDir}${attachmentId}${thumb ? '-thumb' : ''}`;
  const cached = await FileSystem.getInfoAsync(target);
  if (cached.exists) return target;

  const signed = await imApi.signedImageUrl(attachmentId, thumb);
  if (thumb && signed) {
    await FileSystem.downloadAsync(signed, target);
    return target;
  }
  if (signed) return signed;

  const token = await getToken();
  const url = await imApi.attachmentDownloadPath(attachmentId, thumb);
  await FileSystem.downloadAsync(url, target, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return target;
}

export async function downloadAndShare(attachmentId: number, filename: string): Promise<void> {
  await ensureCacheDir();
  const target = `${imageCacheDir}${Date.now()}-${filename.replace(/[^\w.\-]/g, '_')}`;
  const token = await getToken();
  const url = await imApi.attachmentDownloadPath(attachmentId, false);
  await FileSystem.downloadAsync(url, target, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!(await Sharing.isAvailableAsync())) throw new Error('当前设备不支持分享文件');
  await Sharing.shareAsync(target, { dialogTitle: filename });
}

/** 后端 normalize_avatar 只接受 png/jpeg/webp/gif 的 data URL，且不超过 256KB。 */
const AVATAR_MAX_BYTES = 256 * 1024;
const AVATAR_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif',
};

function normalizedAvatarMime(mime: string, name: string): string {
  const normalized = mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mime.toLowerCase();
  if (Object.values(AVATAR_MIME_BY_EXT).includes(normalized)) return normalized;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const fallback = AVATAR_MIME_BY_EXT[ext];
  if (!fallback) throw new Error('头像仅支持 PNG / JPG / WEBP / GIF 图片');
  return fallback;
}

export async function readAsAvatarDataUrl(attachment: PendingAttachment): Promise<string> {
  const mime = normalizedAvatarMime(attachment.mime, attachment.name);
  const base64 = await FileSystem.readAsStringAsync(attachment.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const bytes = Math.floor(base64.length * 3 / 4);
  if (bytes > AVATAR_MAX_BYTES) {
    throw new Error(`图片约 ${Math.round(bytes / 1024)}KB，超过头像上限 256KB，请裁剪后重试`);
  }
  return `data:${mime};base64,${base64}`;
}
