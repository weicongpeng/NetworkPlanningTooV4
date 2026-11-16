/** 协作沟通模块共享类型（与 docs/协作沟通设计方案.md §4 契约一致） */

export type ImConversationKind = 'direct' | 'auto_group' | 'custom_group'
/** system = 群内系统提示（管理员加人/踢人、成员进出），由服务端落库，前端按语言渲染 */
export type ImMessageKind = 'text' | 'image' | 'file' | 'system'
export type ImTab = 'messages' | 'contacts'

/** 群内系统提示的结构化载荷（content_text 里的 JSON），文案一律前端 t() 渲染 */
export interface ImSystemPayload {
  event: string
  actor?: string
  names?: string[]
}

export function parseSystemMessage(contentText: string | null | undefined): ImSystemPayload | null {
  if (!contentText) return null
  try {
    const data: unknown = JSON.parse(contentText)
    if (data && typeof data === 'object' && typeof (data as ImSystemPayload).event === 'string') {
      return data as ImSystemPayload
    }
  } catch { /* 普通文本消息不是 JSON */ }
  return null
}

/** 图片灯箱来源：远端附件按 id 拉全图，本地待发送图片直接给 File；objectURL 由灯箱自持 */
export interface ImLightboxSource {
  name: string
  mime: string
  attachmentId?: number
  file?: File
  /** 当前会话内已加载的图片（按消息顺序）；有 2 张以上时灯箱可上一张 / 下一张 */
  gallery?: ImLightboxSource[]
  /** 打开时的起始下标 */
  galleryIndex?: number
}

export interface ImUser {
  id: number
  username: string
  /** 协作沟通昵称；空则回落 username。仅 IM 展示用，不影响登录账号 */
  nickname?: string | null
  is_online: boolean
  city: string
  operator: string
  /** 裁剪后的 base64 头像 data URL；null / 缺省显示首字母 */
  avatar?: string | null
  /** 仅群成员接口返回（owner/admin/member）；通讯录用户没有该字段 */
  role?: 'owner' | 'admin' | 'member'
}

/**
 * 协作沟通内统一的展示名：有昵称用昵称，否则登录账号 username。
 * 昵称只在协作沟通模块生效；应用其它位置一律直接用 username，不要调用此函数。
 */
export function imDisplayName(user: {
  username: string
  nickname?: string | null
} | null | undefined): string {
  if (!user) return ''
  return user.nickname?.trim() || user.username
}

/** 群成员（list_members 响应），供 @ 下拉与群成员弹窗共用 */
export type ImMember = ImUser & { joined_at?: string }

/** @ 候选项：id === 'all' 为「@所有人」特殊项 */
export interface ImMentionTarget {
  id: number | 'all'
  username: string
  is_online?: boolean
}

/** 消息里被点名的成员（服务端序列化） */
export interface ImMention {
  id: number
  username: string
}

/** 发送时随消息提交的结构化 @ 载荷 */
export interface ImSendMention {
  mentions: number[]
  mention_all: boolean
}

export interface ImGroup {
  id: number
  kind: ImConversationKind
  name: string
  member_count: number
  is_auto: boolean
  city: string
  operator: string
  joined: boolean
  avatar?: string | null
  owner_id?: number | null
}

/**
 * IM 身份 id：共享桌面模式下本机镜像账号 id 与服务器 id 不同，
 * 消息 sender_id / 会话成员 id 一律是服务器 id，必须用 im_user_id 判定「自己」。
 */
export function imUserId(
  user: { id: number; im_user_id?: number | null } | null | undefined,
): number | null {
  if (!user) return null
  return typeof user.im_user_id === 'number' && user.im_user_id > 0
    ? user.im_user_id
    : user.id ?? null
}

export interface ImAttachmentInfo {
  id: number
  original_name: string
  mime: string
  size_bytes: number
  has_thumb: boolean
}

export interface ImLastMessage {
  id: number
  kind: ImMessageKind
  preview: string
  sender_id: number
  sender_name: string
  created_at: string
}

export interface ImConversation {
  id: number
  kind: ImConversationKind
  name: string | null
  group_key: string | null
  avatar?: string | null
  owner_id?: number | null
  /** 当前用户在本会话中的角色（群主/管理员/成员），用于展示管理入口 */
  my_role?: 'owner' | 'admin' | 'member'
  other_user: {
    id: number; username: string; nickname?: string | null
    is_online: boolean; avatar?: string | null
  } | null
  /** 自己 ↔ 自己会话（文件传输助手），other_user 恒为 null */
  is_self?: boolean
  member_count: number
  last_message: ImLastMessage | null
  last_message_at: string | null
  unread: number
  muted: boolean
}

/** 被引用的历史消息摘要（服务端已在发送时刻固化，不会递归嵌套） */
export interface ImReplyPreview {
  id: number
  sender_id: number
  sender_name: string
  kind: ImMessageKind
  preview: string
}

export interface ImMessage {
  id: number
  conversation_id: number
  sender_id: number
  sender_name: string
  /** 发送者头像（服务端按发送时刻的 users.avatar 序列化） */
  sender_avatar?: string | null
  kind: ImMessageKind
  content_text: string | null
  attachment: ImAttachmentInfo | null
  client_msg_id: string | null
  created_at: string
  /** 结构化 @：名单在发送时刻由服务端固化，历史消息重拉/换设备后仍在 */
  mention_all?: boolean
  mentions?: ImMention[]
  /** 服务端按当前请求用户计算，前端不靠解析正文猜测 */
  mentioned_me?: boolean
  /** 引用回复：指向同会话的历史消息 */
  reply_to_id?: number | null
  reply_to?: ImReplyPreview | null
  /** 本地发送状态（乐观消息） */
  pending?: boolean
  failed?: boolean
}

export interface ImMessagesPage {
  items: ImMessage[]
  has_more: boolean
  next_cursor: number | null
  prev_cursor: number | null
}

export interface ImContactsData {
  users: ImUser[]
  groups: ImGroup[]
  online_count: number
  server_time: string
}

export interface ImConversationsData {
  items: ImConversation[]
  server_time: string
}

export interface ImEnvelope<T> {
  success: boolean
  data: T
}

export interface ImAttachmentUploadResult {
  id: number
  original_name: string
  mime: string
  size_bytes: number
  has_thumb: boolean
}

/** 会话显示名：单聊取对方用户名，群聊取群名；兜底文案由调用方按当前语言传入 */
export function conversationTitle(conv: ImConversation, labels?: {
  unknownUser?: string
  unnamedGroup?: string
  self?: string
}): string {
  if (conv.kind === 'direct') {
    if (conv.is_self || !conv.other_user) return labels?.self || '自己'
    return imDisplayName(conv.other_user)
      || `${labels?.unknownUser || '用户'} ${conv.other_user?.id ?? ''}`.trim()
  }
  return conv.name || labels?.unnamedGroup || '未命名群组'
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function formatConversationTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return formatClock(iso)
  return `${date.getMonth() + 1}/${date.getDate()}`
}
