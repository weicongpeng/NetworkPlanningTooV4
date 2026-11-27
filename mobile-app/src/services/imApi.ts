/** 协作沟通 REST 客户端：复用 apiService 单例，统一拆 {success,data} 信封。 */
import { apiService } from './api';
import { getEffectiveApiBaseUrl } from '../utils/config';
import type {
  ImAttachmentBrief, ImContacts, ImConversation, ImMember, ImMessage,
  ImMessagesPage, ImSignedAttachment,
} from '../types/im';

const TIMEOUT = 15000;

function unwrap<T>(raw: any): T {
  if (raw && typeof raw === 'object' && 'success' in raw && 'data' in raw) return raw.data as T;
  return raw as T;
}

function toError(e: any, fallback: string): Error {
  const detail = e?.response?.data?.detail;
  if (typeof detail === 'string' && detail) return new Error(detail);
  if (typeof e?.message === 'string' && e.message) return new Error(e.message);
  return new Error(fallback);
}

interface SignedEntry {
  info: ImSignedAttachment;
  url: string;
}

const signedCache = new Map<string, SignedEntry>();
const signedKey = (id: number, thumb: boolean) => `${id}:${thumb ? 1 : 0}`;

export function clearSignedAttachmentCache(): void {
  signedCache.clear();
}

export const imApi = {
  async conversations(includeAvatars = false): Promise<{ items: ImConversation[]; server_time: string }> {
    try {
      return unwrap(await apiService.request({
        method: 'GET', url: '/im/conversations', params: { include_avatars: includeAvatars }, timeout: TIMEOUT,
      }));
    } catch (e) { throw toError(e, '获取会话列表失败'); }
  },

  async createDirect(peerUserId: number): Promise<ImConversation> {
    try {
      return unwrap(await apiService.request({
        method: 'POST', url: '/im/conversations',
        data: { kind: 'direct', peer_user_id: peerUserId }, timeout: TIMEOUT,
      }));
    } catch (e) { throw toError(e, '创建单聊失败'); }
  },

  async createGroup(name: string, memberIds: number[]): Promise<ImConversation> {
    try {
      return unwrap(await apiService.request({
        method: 'POST', url: '/im/conversations',
        data: { kind: 'custom_group', name, member_ids: memberIds }, timeout: TIMEOUT,
      }));
    } catch (e) { throw toError(e, '创建群聊失败'); }
  },

  async dissolveGroup(conversationId: number): Promise<void> {
    try {
      await apiService.request({ method: 'DELETE', url: `/im/conversations/${conversationId}`, timeout: TIMEOUT });
    } catch (e) { throw toError(e, '解散群聊失败'); }
  },

  async members(conversationId: number): Promise<ImMember[]> {
    try {
      return unwrap(await apiService.request({
        method: 'GET', url: `/im/conversations/${conversationId}/members`, timeout: TIMEOUT,
      }));
    } catch (e) { throw toError(e, '获取群成员失败'); }
  },

  async addMembers(conversationId: number, memberIds: number[]): Promise<void> {
    try {
      await apiService.request({
        method: 'POST', url: `/im/conversations/${conversationId}/members`,
        data: { member_ids: memberIds }, timeout: TIMEOUT,
      });
    } catch (e) { throw toError(e, '添加成员失败'); }
  },

  async removeMember(conversationId: number, userId: number): Promise<void> {
    try {
      await apiService.request({
        method: 'DELETE', url: `/im/conversations/${conversationId}/members/${userId}`, timeout: TIMEOUT,
      });
    } catch (e) { throw toError(e, '移除成员失败'); }
  },

  async leaveGroup(conversationId: number): Promise<void> {
    try {
      await apiService.request({
        method: 'DELETE', url: `/im/conversations/${conversationId}/members/me`, timeout: TIMEOUT,
      });
    } catch (e) { throw toError(e, '退群失败'); }
  },

  async messages(conversationId: number, params: {
    after_id?: number; before_id?: number; limit?: number; ids?: string;
  } = {}): Promise<ImMessagesPage> {
    try {
      return unwrap(await apiService.request({
        method: 'GET', url: `/im/conversations/${conversationId}/messages`, params, timeout: TIMEOUT,
      }));
    } catch (e) { throw toError(e, '加载消息失败'); }
  },

  async send(conversationId: number, payload: {
    kind: 'text' | 'image' | 'file';
    content_text?: string;
    attachment_id?: number;
    client_msg_id?: string;
    mentions?: number[];
    mention_all?: boolean;
    reply_to_id?: number;
  }): Promise<ImMessage> {
    try {
      return unwrap(await apiService.request({
        method: 'POST', url: `/im/conversations/${conversationId}/messages`, data: payload, timeout: TIMEOUT,
      }));
    } catch (e) { throw toError(e, '发送消息失败'); }
  },

  async recall(conversationId: number, messageId: number): Promise<void> {
    try {
      await apiService.request({
        method: 'POST', url: `/im/conversations/${conversationId}/messages/${messageId}/recall`, timeout: TIMEOUT,
      });
    } catch (e) { throw toError(e, '撤回失败'); }
  },

  async forward(messageIds: number[], conversationIds: number[]): Promise<void> {
    try {
      await apiService.request({
        method: 'POST', url: '/im/messages/forward',
        data: { message_ids: messageIds, conversation_ids: conversationIds }, timeout: TIMEOUT,
      });
    } catch (e) { throw toError(e, '转发失败'); }
  },

  async markRead(conversationId: number, lastReadMessageId: number): Promise<void> {
    try {
      await apiService.request({
        method: 'POST', url: `/im/conversations/${conversationId}/read`,
        data: { last_read_message_id: lastReadMessageId }, timeout: TIMEOUT,
      });
    } catch (e) { throw toError(e, '标记已读失败'); }
  },

  /** 修改当前用户头像；传空串恢复默认首字母头像。与网页端共用 /im/avatar。 */
  async updateAvatar(avatar: string | null): Promise<{ avatar: string | null }> {
    try {
      return unwrap(await apiService.request({
        method: 'PUT', url: '/im/avatar', data: { avatar: avatar || '' }, timeout: TIMEOUT,
      }));
    } catch (e) { throw toError(e, '更新头像失败'); }
  },

  /** 修改协作沟通昵称；传空串清除昵称并回落 username。 */
  async updateNickname(nickname: string | null): Promise<{ nickname: string | null }> {
    try {
      return unwrap(await apiService.request({
        method: 'PUT', url: '/im/nickname', data: { nickname: nickname || '' }, timeout: TIMEOUT,
      }));
    } catch (e) { throw toError(e, '更新昵称失败'); }
  },

  async contacts(params: { limit?: number; query?: string } = {}): Promise<ImContacts> {
    try {
      return unwrap(await apiService.request({
        method: 'GET', url: '/im/contacts', params, timeout: TIMEOUT,
      }));
    } catch (e) { throw toError(e, '获取通讯录失败'); }
  },

  async attachmentStart(conversationId: number, originalName: string, mime: string, sizeBytes: number): Promise<{
    upload_id: string; chunk_size: number; total_chunks: number;
  }> {
    try {
      return unwrap(await apiService.request({
        method: 'POST', url: '/im/attachments/start',
        data: {
          conversation_id: conversationId, original_name: originalName,
          mime, size_bytes: sizeBytes,
        }, timeout: TIMEOUT,
      }));
    } catch (e) { throw toError(e, '开始上传失败'); }
  },

  async attachmentChunk(uploadId: string, chunkIndex: number, dataB64: string): Promise<void> {
    try {
      await apiService.request({
        method: 'POST', url: '/im/attachments/chunk',
        data: { upload_id: uploadId, chunk_index: chunkIndex, data_b64: dataB64 },
        timeout: 60000,
      });
    } catch (e) { throw toError(e, '上传分片失败'); }
  },

  async attachmentComplete(uploadId: string): Promise<ImAttachmentBrief> {
    try {
      return unwrap(await apiService.request({
        method: 'POST', url: '/im/attachments/complete',
        data: { upload_id: uploadId }, timeout: TIMEOUT,
      }));
    } catch (e) { throw toError(e, '完成上传失败'); }
  },

  async attachmentCancel(uploadId: string): Promise<void> {
    try {
      await apiService.request({
        method: 'POST', url: '/im/attachments/cancel',
        data: { upload_id: uploadId }, timeout: TIMEOUT,
      });
    } catch (e) { /* 取消失败不影响原错误 */ }
  },

  async attachmentUrls(items: Array<{ attachment_id: number; thumb?: boolean }>): Promise<void> {
    if (!items.length) return;
    try {
      const data = unwrap<{ tokens: Record<string, ImSignedAttachment> }>(await apiService.request({
        method: 'POST', url: '/im/attachments/urls', data: { items }, timeout: TIMEOUT,
      }));
      const base = (await getEffectiveApiBaseUrl()).replace(/\/+$/, '');
      const tokens = data?.tokens || {};
      Object.entries(tokens).forEach(([key, info]) => {
        if (!info?.token || !info?.path) return;
        const query = `token=${encodeURIComponent(info.token)}${info.thumb ? '&thumb=true' : ''}`;
        signedCache.set(key, { info, url: `${base}${info.path}?${query}` });
      });
    } catch { /* 老服务端无签名直链：后续走 Bearer 下载 */ }
  },

  /** 同步读取缓存中的签名 URL（不过期判断由调用方的预热流程保证），供列表瞬时渲染。 */
  peekSignedUrl(attachmentId: number, thumb: boolean): string | null {
    return signedCache.get(signedKey(attachmentId, thumb))?.url || null;
  },

  /** 返回可直接给 Image 组件的 URL；null 表示需要 Bearer 回退下载。 */
  async signedImageUrl(attachmentId: number, thumb: boolean): Promise<string | null> {
    const key = signedKey(attachmentId, thumb);
    const cached = signedCache.get(key);
    if (cached && cached.info.expires_at * 1000 - 30_000 > Date.now()) return cached.url;
    await imApi.attachmentUrls([{ attachment_id: attachmentId, thumb }]);
    const fresh = signedCache.get(key);
    if (!fresh || fresh.info.expires_at * 1000 - 30_000 <= Date.now()) return null;
    return fresh.url;
  },

  /** Bearer 回退下载路径（expo-file-system 的 headers 由调用方补 Authorization）。 */
  async attachmentDownloadPath(attachmentId: number, thumb: boolean): Promise<string> {
    const base = await getEffectiveApiBaseUrl();
    return `${base.replace(/\/+$/, '')}/im/attachments/${attachmentId}${thumb ? '/thumb' : ''}`;
  },
};
