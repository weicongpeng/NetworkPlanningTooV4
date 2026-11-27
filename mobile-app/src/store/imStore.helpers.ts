import { IM_MAX_MESSAGES, type ImConversation, type ImMessage, type ImReplyPreview } from '../types/im';

/** 按 id 去重合并；乐观消息的 client_msg_id 命中后替换本地负数 id。 */
export function mergeMessages(existing: ImMessage[], incoming: ImMessage[]): ImMessage[] {
  const map = new Map<number, ImMessage>();
  existing.forEach((m) => map.set(m.id, m));
  const pendingByClientId = new Map<string, number>();
  existing.forEach((m) => {
    if (m.pending && m.client_msg_id) pendingByClientId.set(m.client_msg_id, m.id);
  });
  incoming.forEach((m) => {
    if (m.id > 0 && m.client_msg_id) {
      const pendingId = pendingByClientId.get(m.client_msg_id);
      if (pendingId !== undefined) map.delete(pendingId);
    }
    map.set(m.id, m);
  });
  return [...map.values()].sort((a, b) => a.id - b.id).slice(-IM_MAX_MESSAGES);
}

/** 高频轮询不带头像：用上一次的头像补回，避免列表头像闪空。 */
export function mergeConversations(existing: ImConversation[], incoming: ImConversation[]): ImConversation[] {
  const oldMap = new Map(existing.map((c) => [c.id, c]));
  return incoming.map((conv) => {
    const old = oldMap.get(conv.id);
    if (!old) return conv;
    return {
      ...conv,
      avatar: conv.avatar ?? old.avatar,
      other_user: conv.other_user
        ? { ...conv.other_user, avatar: conv.other_user.avatar ?? old.other_user?.avatar }
        : old.other_user,
    };
  });
}

export function maxMessageId(messages: ImMessage[]): number {
  let max = 0;
  messages.forEach((m) => { if (m.id > max) max = m.id; });
  return max;
}

export function createOptimisticMessage(
  conversationId: number,
  senderId: number,
  senderName: string,
  kind: 'text' | 'image' | 'file',
  contentText: string | undefined,
  clientMsgId: string,
  replyTo?: ImReplyPreview | null,
): ImMessage {
  return {
    id: -Date.now(),
    conversation_id: conversationId,
    sender_id: senderId,
    sender_name: senderName,
    kind,
    content_text: contentText || null,
    attachment: null,
    client_msg_id: clientMsgId,
    created_at: new Date().toISOString(),
    pending: true,
    reply_to_id: replyTo ? replyTo.id : undefined,
    reply_to: replyTo
      ? {
          id: replyTo.id,
          sender_name: replyTo.sender_name,
          kind: replyTo.kind,
          preview: replyTo.preview || (replyTo.kind === 'image' ? '[图片]' : '[文件]'),
          attachment: replyTo.attachment,
        }
      : undefined,
  };
}
