/** 协作沟通状态：会话/消息分桶、游标、未读、实时与轮询；消息按账号落本地文件缓存。 */
import { create } from 'zustand';
import { AppState } from 'react-native';

import { imApi, clearSignedAttachmentCache } from '../services/imApi';
import { imWebSocket } from '../services/imWebSocket';
import { getToken, getStoredUser, type AuthUser } from '../services/auth';
import { newClientMsgId, uploadAttachment } from '../services/imAttachment';
import { loadCachedMessages, saveCachedMessages, setImCacheUser } from '../services/imMessageCache';
import { IM_PAGE_SIZE, type ImContacts, type ImConversation, type ImMessage, type ImReplyPreview, type ImUser, type PendingAttachment } from '../types/im';
import { createOptimisticMessage, maxMessageId, mergeConversations, mergeMessages } from './imStore.helpers';

interface ConversationCursor {
  after: number
  prev: number
  hasMore: boolean
  initialized: boolean
}

interface ImState {
  initialized: boolean
  connected: boolean
  /** 会话空闲超时/被注销后的提示；由 sessionGuard 写入，重新登录时清除 */
  sessionExpired: string | null
  myUserId: number | null
  myName: string
  conversations: ImConversation[]
  contacts: ImContacts | null
  messages: Record<number, ImMessage[]>
  cursors: Record<number, ConversationCursor>
  loadingConversations: boolean
  loadingMessages: Record<number, boolean>
  activeConversationId: number | null
  drafts: Record<number, string>
  replyDrafts: Record<number, ImReplyPreview | null>
  pendingAttachments: Record<number, PendingAttachment[]>
  uploadProgress: Record<string, number>
  mentionBadges: Record<number, boolean>
  error: string | null

  setIdentity: (user: AuthUser | null) => void
  setSessionExpired: (message: string | null) => void
  bootstrap: () => Promise<void>
  resync: () => Promise<void>
  refreshConversations: (withAvatars?: boolean) => Promise<void>
  loadContacts: () => Promise<void>
  loadMessages: (id: number, mode?: 'initial' | 'older' | 'incremental', maxRounds?: number) => Promise<void>
  setActiveConversation: (id: number | null) => Promise<void>
  markRead: (id: number) => Promise<void>
  sendText: (id: number, text: string, options?: {
    mentions?: number[]; mentionAll?: boolean; replyTo?: ImReplyPreview | null;
  }) => Promise<boolean>
  sendAttachment: (id: number, attachment: PendingAttachment, clientMsgId?: string) => Promise<boolean>
  cancelUpload: (clientMsgId: string) => void
  recall: (id: number, messageId: number) => Promise<void>
  forward: (messageIds: number[], conversationIds: number[]) => Promise<void>
  openDirect: (peerUserId: number) => Promise<number | null>
  createGroup: (name: string, memberIds: number[]) => Promise<number | null>
  addMembers: (id: number, memberIds: number[]) => Promise<void>
  removeMember: (id: number, userId: number) => Promise<void>
  leaveGroup: (id: number) => Promise<void>
  dissolveGroup: (id: number) => Promise<void>
  markMentionSeen: (messageId: number) => void
  setDraft: (id: number, text: string) => void
  setReplyDraft: (id: number, reply: ImReplyPreview | null) => void
  addPendingAttachment: (id: number, attachment: PendingAttachment) => void
  removePendingAttachment: (id: number, index: number) => void
  clearPendingAttachments: (id: number) => void
  handleImMessage: (data: { conversation_id: number; message_id: number }) => Promise<void>
  handleImRecall: (data: { conversation_id: number; message_id: number }) => Promise<void>
  handleImPresence: (data: { user_id: number; online: boolean }) => void
  startPolling: (intervalMs?: number) => void
  stopPolling: () => void
  setAppActive: (active: boolean) => void
  resetForUserSwitch: () => void
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;
let startedToken: string | null = null;
let appActive = true;
const loadingIds = new Set<number>();
const cancelledUploads = new Set<string>();

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}

function identityOf(user: AuthUser | null): { id: number | null; name: string } {
  const raw = user?.id;
  const id = raw === undefined || raw === null ? Number.NaN : Number(raw);
  return { id: Number.isFinite(id) ? id : null, name: user?.username || '' };
}

export const useImStore = create<ImState>((set, get) => ({
  initialized: false,
  connected: false,
  sessionExpired: null,
  myUserId: null,
  myName: '',
  conversations: [],
  contacts: null,
  messages: {},
  cursors: {},
  loadingConversations: false,
  loadingMessages: {},
  activeConversationId: null,
  drafts: {},
  replyDrafts: {},
  pendingAttachments: {},
  uploadProgress: {},
  mentionBadges: {},
  error: null,

  setIdentity: (user) => {
    const identity = identityOf(user);
    set({ myUserId: identity.id, myName: identity.name });
  },

  setSessionExpired: (message) => set({ sessionExpired: message }),

  bootstrap: async () => {
    const token = await getToken();
    if (!token) return;
    if (startedToken === token && get().initialized) return;
    const restoredUser = await getStoredUser();
    get().setIdentity(restoredUser);
    setImCacheUser(restoredUser?.username || get().myName || null);
    if (startedToken && startedToken !== token) imWebSocket.stop();
    startedToken = token;
    imWebSocket.configure({
      onMessage: (data) => { void get().handleImMessage(data); },
      onRecall: (data) => { void get().handleImRecall(data); },
      onPresence: (data) => { get().handleImPresence(data); },
      onResync: () => { void get().resync(); },
      onStatus: (connected) => set({ connected }),
    });
    void imWebSocket.start(token);
    get().startPolling();
    set({ initialized: true, sessionExpired: null });
    await Promise.all([get().refreshConversations(), get().loadContacts()]);
  },

  refreshConversations: async (withAvatars = false) => {
    if (refreshing) return;
    refreshing = true;
    set({ loadingConversations: true });
    try {
      const data = await imApi.conversations(withAvatars);
      set((state) => ({
        conversations: mergeConversations(state.conversations, data.items || []),
        error: null,
      }));
    } catch (e) {
      set({ error: errorMessage(e) });
    } finally {
      refreshing = false;
      set({ loadingConversations: false });
    }
  },

  loadContacts: async () => {
    try {
      const contacts = await imApi.contacts();
      set({ contacts, error: null });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  loadMessages: async (id, mode = 'initial', maxRounds = 10) => {
    if (loadingIds.has(id)) return;
    loadingIds.add(id);
    set((state) => ({ loadingMessages: { ...state.loadingMessages, [id]: true } }));
    try {
      if (mode === 'older') {
        const cursor = get().cursors[id];
        if (cursor?.prev) {
          const older = await imApi.messages(id, { before_id: cursor.prev, limit: IM_PAGE_SIZE });
          set((state) => {
            const existing = state.messages[id] || [];
            const current = state.cursors[id];
            if (!current) return state;
            return {
              messages: { ...state.messages, [id]: mergeMessages(older.items, existing) },
              cursors: {
                ...state.cursors,
                [id]: { ...current, prev: older.prev_cursor || older.items[0]?.id || current.prev },
              },
            };
          });
        }
      } else if (mode === 'initial') {
        const page = await imApi.messages(id, { limit: IM_PAGE_SIZE });
        set((state) => ({
          messages: { ...state.messages, [id]: mergeMessages([], page.items) },
          cursors: {
            ...state.cursors,
            [id]: {
              after: page.next_cursor || maxMessageId(page.items),
              prev: page.prev_cursor || 0,
              hasMore: page.has_more,
              initialized: true,
            },
          },
        }));
      } else {
        const cursor = get().cursors[id];
        if (!cursor?.initialized) {
          const page = await imApi.messages(id, { limit: IM_PAGE_SIZE });
          set((state) => ({
            messages: { ...state.messages, [id]: mergeMessages([], page.items) },
            cursors: {
              ...state.cursors,
              [id]: {
                after: page.next_cursor || maxMessageId(page.items),
                prev: page.prev_cursor || 0,
                hasMore: page.has_more,
                initialized: true,
              },
            },
          }));
        } else {
          let after = cursor.after;
          const collected: ImMessage[] = [];
          for (let round = 0; round < maxRounds; round += 1) {
            const batch = await imApi.messages(id, { after_id: after, limit: IM_PAGE_SIZE });
            collected.push(...batch.items);
            if (batch.items.length) after = batch.next_cursor || batch.items[batch.items.length - 1].id;
            if (!batch.has_more) break;
          }
          if (collected.length) {
            set((state) => {
              const current = state.cursors[id];
              if (!current) return state;
              return {
                messages: { ...state.messages, [id]: mergeMessages(state.messages[id] || [], collected) },
                cursors: { ...state.cursors, [id]: { ...current, after } },
              };
            });
          }
        }
      }
      const loaded = get().messages[id] || [];
      const viewing = get().activeConversationId === id;
      set((state) => {
        const badges = { ...state.mentionBadges };
        if (!viewing) {
          loaded.forEach((m) => {
            if (m.mentioned_me && badges[m.id] === undefined) badges[m.id] = true;
          });
        }
        return { mentionBadges: badges, error: null };
      });
    } catch (e) {
      set({ error: errorMessage(e) });
    } finally {
      loadingIds.delete(id);
      set((state) => ({ loadingMessages: { ...state.loadingMessages, [id]: false } }));
      const all = get().messages[id];
      if (all?.length) void saveCachedMessages(id, all);
    }
  },

  setActiveConversation: async (id) => {
    set({ activeConversationId: id });
    if (id === null) return;
    if (!get().cursors[id]?.initialized) {
      // 先渲染本地缓存的历史，再按游标增量同步，避免每次进会话都等网络全量拉取
      const cached = await loadCachedMessages(id);
      if (cached.length) {
        set((state) => ({
          messages: { ...state.messages, [id]: cached },
          cursors: {
            ...state.cursors,
            [id]: {
              after: maxMessageId(cached),
              prev: cached[0]?.id || 0,
              hasMore: true,
              initialized: true,
            },
          },
        }));
        await get().loadMessages(id, 'incremental');
      } else {
        await get().loadMessages(id, 'initial');
      }
    }
    await get().markRead(id);
    set((state) => {
      const badges = { ...state.mentionBadges };
      (state.messages[id] || []).forEach((m) => { badges[m.id] = false; });
      return { mentionBadges: badges };
    });
  },

  markRead: async (id) => {
    const last = maxMessageId(get().messages[id] || []);
    if (!last) return;
    set((state) => ({
      conversations: state.conversations.map((c) => (c.id === id ? { ...c, unread: 0 } : c)),
    }));
    try { await imApi.markRead(id, last); } catch { /* 已读失败不影响本地体验 */ }
  },

  sendText: async (id, text, options = {}) => {
    const content = text.trim();
    if (!content) return false;
    const me = get().myUserId || 0;
    const clientMsgId = newClientMsgId();
    const optimistic = createOptimisticMessage(
      id, me, get().myName, 'text', content, clientMsgId, options.replyTo,
    );
    set((state) => ({
      messages: { ...state.messages, [id]: mergeMessages(state.messages[id] || [], [optimistic]) },
    }));
    try {
      const saved = await imApi.send(id, {
        kind: 'text',
        content_text: content,
        client_msg_id: clientMsgId,
        mentions: options.mentions,
        mention_all: options.mentionAll,
        reply_to_id: options.replyTo?.id,
      });
      set((state) => ({
        messages: { ...state.messages, [id]: mergeMessages(state.messages[id] || [], [saved]) },
      }));
      void saveCachedMessages(id, get().messages[id] || []);
      await get().refreshConversations();
      return true;
    } catch (e) {
      set((state) => ({
        messages: {
          ...state.messages,
          [id]: (state.messages[id] || []).map((m) => (
            m.client_msg_id === clientMsgId ? { ...m, pending: false, failed: true } : m
          )),
        },
        error: errorMessage(e),
      }));
      return false;
    }
  },

  sendAttachment: async (id, attachment, providedClientMsgId) => {
    const clientMsgId = providedClientMsgId || newClientMsgId();
    const kind = attachment.mime.startsWith('image/') ? 'image' : 'file';
    // 上传前先插入本地预览：用户立刻看到图片，不必等分片+发送+再拉一次消息
    const optimistic = createOptimisticMessage(
      id, get().myUserId || 0, get().myName, kind, undefined, clientMsgId,
    );
    optimistic.attachment = {
      id: 0, original_name: attachment.name, mime: attachment.mime,
      size_bytes: attachment.size, has_thumb: false,
    };
    optimistic.local_uri = attachment.uri;
    set((state) => ({
      messages: { ...state.messages, [id]: mergeMessages(state.messages[id] || [], [optimistic]) },
      uploadProgress: { ...state.uploadProgress, [clientMsgId]: 0 },
    }));
    try {
      const uploaded = await uploadAttachment(
        id, attachment,
        (percent) => set((state) => ({
          uploadProgress: { ...state.uploadProgress, [clientMsgId]: percent },
        })),
        () => cancelledUploads.has(clientMsgId),
      );
      const saved = await imApi.send(id, {
        kind,
        attachment_id: uploaded.id,
        client_msg_id: clientMsgId,
      });
      // 用发送响应直接替换乐观消息，省掉一次增量拉取；会话摘要交给后台刷新
      set((state) => ({
        messages: { ...state.messages, [id]: mergeMessages(state.messages[id] || [], [saved]) },
      }));
      void saveCachedMessages(id, get().messages[id] || []);
      void get().refreshConversations();
      return true;
    } catch (e) {
      set((state) => ({
        messages: {
          ...state.messages,
          [id]: (state.messages[id] || []).map((m) => (
            m.client_msg_id === clientMsgId ? { ...m, pending: false, failed: true } : m
          )),
        },
        error: errorMessage(e),
      }));
      return false;
    } finally {
      cancelledUploads.delete(clientMsgId);
      set((state) => {
        const next = { ...state.uploadProgress };
        delete next[clientMsgId];
        return { uploadProgress: next };
      });
    }
  },

  cancelUpload: (clientMsgId) => { cancelledUploads.add(clientMsgId); },

  recall: async (id, messageId) => {
    try {
      await imApi.recall(id, messageId);
      const page = await imApi.messages(id, { ids: String(messageId) });
      if (page.items.length) {
        set((state) => ({
          messages: { ...state.messages, [id]: mergeMessages(state.messages[id] || [], page.items) },
        }));
        void saveCachedMessages(id, get().messages[id] || []);
      }
      await get().refreshConversations();
    } catch (e) { set({ error: errorMessage(e) }); }
  },

  forward: async (messageIds, conversationIds) => {
    try {
      await imApi.forward(messageIds, conversationIds);
      await get().refreshConversations();
    } catch (e) { set({ error: errorMessage(e) }); throw e; }
  },

  openDirect: async (peerUserId) => {
    try {
      const conv = await imApi.createDirect(peerUserId);
      void get().refreshConversations();
      return conv.id;
    } catch (e) { set({ error: errorMessage(e) }); return null; }
  },

  createGroup: async (name, memberIds) => {
    try {
      const conv = await imApi.createGroup(name, memberIds);
      void get().refreshConversations();
      void get().loadContacts();
      return conv.id;
    } catch (e) { set({ error: errorMessage(e) }); return null; }
  },

  addMembers: async (id, memberIds) => {
    try {
      await imApi.addMembers(id, memberIds);
      await get().refreshConversations();
    } catch (e) { set({ error: errorMessage(e) }); throw e; }
  },

  removeMember: async (id, userId) => {
    try {
      await imApi.removeMember(id, userId);
      await get().refreshConversations();
    } catch (e) { set({ error: errorMessage(e) }); throw e; }
  },

  leaveGroup: async (id) => {
    try {
      await imApi.leaveGroup(id);
      await get().refreshConversations();
    } catch (e) { set({ error: errorMessage(e) }); throw e; }
  },

  dissolveGroup: async (id) => {
    try {
      await imApi.dissolveGroup(id);
      await get().refreshConversations();
    } catch (e) { set({ error: errorMessage(e) }); throw e; }
  },

  markMentionSeen: (messageId) => {
    set((state) => ({ mentionBadges: { ...state.mentionBadges, [messageId]: false } }));
  },

  setDraft: (id, text) => set((state) => ({ drafts: { ...state.drafts, [id]: text } })),
  setReplyDraft: (id, reply) => set((state) => ({ replyDrafts: { ...state.replyDrafts, [id]: reply } })),
  addPendingAttachment: (id, attachment) => set((state) => ({
    pendingAttachments: { ...state.pendingAttachments, [id]: [...(state.pendingAttachments[id] || []), attachment] },
  })),
  removePendingAttachment: (id, index) => set((state) => ({
    pendingAttachments: {
      ...state.pendingAttachments,
      [id]: (state.pendingAttachments[id] || []).filter((_, i) => i !== index),
    },
  })),
  clearPendingAttachments: (id) => set((state) => ({
    pendingAttachments: { ...state.pendingAttachments, [id]: [] },
  })),

  handleImMessage: async (data) => {
    const id = Number(data?.conversation_id);
    if (!id) return;
    const ready = !!get().cursors[id]?.initialized;
    await Promise.all([
      get().refreshConversations(),
      ready ? get().loadMessages(id, 'incremental', 2) : Promise.resolve(),
    ]);
    if (get().activeConversationId === id) await get().markRead(id);
  },

  handleImRecall: async (data) => {
    const id = Number(data?.conversation_id);
    const messageId = Number(data?.message_id);
    if (!id || !messageId) return;
    try {
      const page = await imApi.messages(id, { ids: String(messageId) });
      if (page.items.length) {
        set((state) => ({
          messages: { ...state.messages, [id]: mergeMessages(state.messages[id] || [], page.items) },
        }));
        void saveCachedMessages(id, get().messages[id] || []);
      }
      await get().refreshConversations();
    } catch { /* 对账失败等下次拉列表 */ }
  },

  handleImPresence: (data) => {
    const userId = Number(data?.user_id);
    const online = !!data?.online;
    if (!userId) return;
    set((state) => ({
      contacts: state.contacts
        ? {
            ...state.contacts,
            users: state.contacts.users.map((u: ImUser) => (
              u.id === userId ? { ...u, is_online: online } : u
            )),
          }
        : null,
      conversations: state.conversations.map((c) => (
        c.other_user?.id === userId
          ? { ...c, other_user: { ...c.other_user, is_online: online } }
          : c
      )),
    }));
  },

  resync: async () => {
    if (!get().initialized) return;
    await get().refreshConversations();
    const ids = Object.keys(get().cursors).map(Number).filter((id) => get().cursors[id]?.initialized);
    await Promise.all(ids.map((id) => get().loadMessages(id, 'incremental', 2)));
  },

  startPolling: (intervalMs = 10000) => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!appActive || AppState.currentState !== 'active' || !get().initialized) return;
      void get().refreshConversations();
      const active = get().activeConversationId;
      if (active && get().cursors[active]?.initialized) void get().loadMessages(active, 'incremental', 2);
    }, intervalMs);
  },

  stopPolling: () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  },

  setAppActive: (active) => {
    appActive = active;
    if (!active) return;
    void imWebSocket.resume();
    void get().resync();
  },

  resetForUserSwitch: () => {
    get().stopPolling();
    imWebSocket.stop();
    startedToken = null;
    cancelledUploads.clear();
    clearSignedAttachmentCache();
    setImCacheUser('');
    set({
      initialized: false,
      connected: false,
      myUserId: null,
      myName: '',
      conversations: [],
      contacts: null,
      messages: {},
      cursors: {},
      loadingConversations: false,
      loadingMessages: {},
      activeConversationId: null,
      drafts: {},
      replyDrafts: {},
      pendingAttachments: {},
      uploadProgress: {},
      mentionBadges: {},
      error: null,
    });
  },
}));

/**
 * Zustand v5 用 useSyncExternalStore 校验 selector 结果引用；
 * 组件里写 `s.messages[id] || []` 会每次返回新数组，导致无限重渲染。
 * 这里提供模块级稳定空数组供 selector 复用。
 */
export const EMPTY_MESSAGES: ImMessage[] = [];
export const EMPTY_ATTACHMENTS: PendingAttachment[] = [];
