/**
 * IM 消息本地缓存：每会话一个 JSON 文件，按 username 分桶（切账号绝不串数据）。
 * 仅缓存消息正文与元数据；媒体文件仍走 imAttachment 的本地缓存。
 */
import * as FileSystem from 'expo-file-system';

import { IM_MAX_MESSAGES, type ImMessage } from '../types/im';

const ROOT = `${FileSystem.documentDirectory}im_chat_cache/`;
let userKey = '';
const pending = new Map<number, ImMessage[]>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** 由 imStore.bootstrap 在确认身份后调用；空串表示未登录，禁止读写。 */
export function setImCacheUser(username: string | null | undefined): void {
  const next = username || '';
  if (next !== userKey) {
    // 切账号时丢弃尚未落盘的旧用户数据，避免写到新用户目录
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
    pending.clear();
  }
  userKey = next;
}

function currentDir(): string {
  return `${ROOT}${encodeURIComponent(userKey)}/`;
}

function messageFile(conversationId: number): string {
  return `${currentDir()}${conversationId}.json`;
}

export async function loadCachedMessages(conversationId: number): Promise<ImMessage[]> {
  if (!userKey) return [];
  try {
    const info = await FileSystem.getInfoAsync(messageFile(conversationId));
    if (!info.exists) return [];
    const raw = await FileSystem.readAsStringAsync(messageFile(conversationId));
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ImMessage[] : [];
  } catch {
    return [];
  }
}

/** 500ms 防抖：WS 连续推消息/轮询刷新时只落盘一次，避免 JSON.stringify + 写文件拖慢主线程。 */
export function saveCachedMessages(conversationId: number, messages: ImMessage[]): void {
  if (!userKey || !messages.length) return;
  pending.set(conversationId, messages.filter((m) => m.id > 0).slice(-IM_MAX_MESSAGES));
  if (timers.has(conversationId)) return;
  const timer = setTimeout(() => {
    timers.delete(conversationId);
    const data = pending.get(conversationId);
    pending.delete(conversationId);
    if (!data || !userKey) return;
    void (async () => {
      try {
        const dir = currentDir();
        const info = await FileSystem.getInfoAsync(dir);
        if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        await FileSystem.writeAsStringAsync(messageFile(conversationId), JSON.stringify(data));
      } catch {
        // 磁盘满或权限异常不影响聊天，下次同步会重写
      }
    })();
  }, 500);
  timers.set(conversationId, timer);
}
