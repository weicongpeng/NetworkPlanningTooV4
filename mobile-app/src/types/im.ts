/** 协作沟通移动端类型：与 /api/v1/im/* 契约保持一致，文案仅中文。 */

export type ImConversationKind = 'direct' | 'auto_group' | 'custom_group'
export type ImMessageKind = 'text' | 'image' | 'file' | 'system'

export const IM_RECALL_WINDOW_MS = 5 * 60 * 1000
export const IM_PAGE_SIZE = 30
export const IM_MAX_MESSAGES = 300

export interface ImUser {
  id: number
  username: string
  nickname?: string | null
  is_online?: boolean
  city?: string
  operator?: string
  avatar?: string | null
}

export interface ImAttachmentBrief {
  id: number
  original_name: string
  mime: string
  size_bytes: number
  has_thumb: boolean
}

export interface ImMention {
  id: number
  username: string
}

export interface ImReplyPreview {
  id: number
  sender_name?: string
  kind?: ImMessageKind
  preview?: string
  attachment?: ImAttachmentBrief | null
}

export interface ImMessage {
  id: number
  conversation_id: number
  sender_id: number
  sender_name: string
  sender_avatar?: string | null
  kind: ImMessageKind
  content_text: string | null
  attachment: ImAttachmentBrief | null
  client_msg_id?: string | null
  created_at: string
  recalled?: boolean
  mention_all?: boolean
  mentions?: ImMention[]
  mentioned_me?: boolean
  reply_to_id?: number | null
  reply_to?: ImReplyPreview | null
  /** 乐观发送中的本地消息：id 为负数，成功后由服务端消息替换 */
  pending?: boolean
  failed?: boolean
  /** 乐观图片消息的本地文件 URI（上传完成前直接预览） */
  local_uri?: string
}

export interface ImLastMessage {
  id: number
  kind: ImMessageKind
  preview: string
  sender_id?: number
  created_at: string
}

export interface ImConversation {
  id: number
  kind: ImConversationKind
  name: string | null
  group_key?: string | null
  avatar?: string | null
  owner_id?: number | null
  my_role?: string
  other_user?: ImUser | null
  is_self?: boolean
  member_count: number
  last_message: ImLastMessage | null
  last_message_at: string | null
  unread: number
  muted: boolean
}

export interface ImGroup {
  id: number
  kind: ImConversationKind
  name: string | null
  avatar?: string | null
  owner_id?: number | null
  member_count: number
  is_auto: boolean
  city?: string
  operator?: string
  joined: boolean
}

export interface ImContacts {
  users: ImUser[]
  groups: ImGroup[]
  online_count: number
  server_time: string
}

export interface ImMember extends ImUser {
  role: string
  joined_at: string
}

export interface ImMessagesPage {
  items: ImMessage[]
  has_more: boolean
  next_cursor: number | null
  prev_cursor: number | null
}

export interface ImSignedAttachment {
  token: string
  path: string
  thumb: boolean
  expires_at: number
  url?: string
}

export interface ImSystemPayload {
  event: string
  actor?: string
  names?: string[]
}

export interface PendingAttachment {
  uri: string
  name: string
  mime: string
  size: number
}

export function imDisplayName(user?: ImUser | ImMember | null): string {
  if (!user) return '用户'
  return user.nickname || user.username || '用户'
}

export function conversationTitle(conv: ImConversation): string {
  if (conv.kind === 'direct') {
    if (conv.is_self) return '自己'
    return imDisplayName(conv.other_user)
  }
  return conv.name || '未命名群组'
}

export function avatarUri(value?: string | null): string | undefined {
  if (!value) return undefined
  if (value.startsWith('data:') || value.startsWith('http')) return value
  return `data:image/png;base64,${value}`
}

export function formatImTime(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export function formatDaySeparator(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return '今天'
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export function parseSystemMessage(text: string | null | undefined): ImSystemPayload | null {
  if (!text) return null
  try {
    const data: unknown = JSON.parse(text)
    if (data && typeof data === 'object' && typeof (data as ImSystemPayload).event === 'string') {
      return data as ImSystemPayload
    }
  } catch { /* 普通文本不是 JSON */ }
  return null
}

export function systemNoticeText(text: string | null | undefined): string {
  const payload = parseSystemMessage(text)
  if (!payload) return '群内通知'
  const names = (payload.names || []).join('、')
  switch (payload.event) {
    case 'members_added':
      return `${payload.actor || ''} 邀请 ${names} 加入了群聊`
    case 'member_removed':
      return `${payload.actor || ''} 将 ${names} 移出了群聊`
    case 'member_left':
      return `${payload.actor || ''} 退出了群聊`
    default:
      return '群内通知'
  }
}

export function messagePreview(message: ImMessage | ImLastMessage | null | undefined): string {
  if (!message) return '暂无消息'
  if ('recalled' in message && message.recalled) return '消息已撤回'
  if (message.kind === 'system') {
    return systemNoticeText('content_text' in message ? message.content_text : message.preview)
  }
  if (message.kind === 'image') return '[图片]'
  if (message.kind === 'file') return '[文件]'
  if ('content_text' in message) return message.content_text || ''
  return (message as ImLastMessage).preview || ''
}

export function isWithinRecallWindow(createdAt: string, now = Date.now()): boolean {
  const sentAt = new Date(createdAt).getTime()
  if (!Number.isFinite(sentAt)) return false
  const age = now - sentAt
  return age >= -60_000 && age <= IM_RECALL_WINDOW_MS
}

export function isAdminRole(role?: string): boolean {
  return role === 'owner' || role === 'admin'
}

/** 视频在后端按普通 file 附件存储，靠 mime / 扩展名识别后交给媒体灯箱播放。 */
const PLAYABLE_VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm', '3gp']

export function isVideoAttachment(attachment: ImAttachmentBrief | null | undefined): boolean {
  if (!attachment) return false
  if ((attachment.mime || '').toLowerCase().startsWith('video/')) return true
  const ext = attachment.original_name.split('.').pop()?.toLowerCase() || ''
  return PLAYABLE_VIDEO_EXTS.includes(ext)
}
