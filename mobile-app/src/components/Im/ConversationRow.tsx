import React from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet } from 'react-native';

import {
  avatarUri, conversationTitle, formatImTime, messagePreview,
  type ImConversation,
} from '../../types/im';
import type { ImColors } from './colors';

interface Props {
  conv: ImConversation
  colors: ImColors
  onPress: () => void
}

export default function ConversationRow({ conv, colors, onPress }: Props) {
  const title = conversationTitle(conv);
  const avatar = avatarUri(conv.kind === 'direct' ? conv.other_user?.avatar : conv.avatar);
  const unread = conv.muted ? 0 : conv.unread || 0;

  return (
    <TouchableOpacity style={[styles.row, { backgroundColor: colors.card }]} onPress={onPress} activeOpacity={0.65}>
      {avatar ? (
        <Image source={{ uri: avatar }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: colors.avatarBg }]}>
          <Text style={[styles.avatarText, { color: colors.accent }]}>{title.slice(0, 1)}</Text>
        </View>
      )}
      <View style={styles.content}>
        <View style={styles.titleLine}>
          <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>{title}</Text>
          <Text style={[styles.time, { color: colors.textMuted }]}>{formatImTime(conv.last_message_at)}</Text>
        </View>
        <View style={styles.previewLine}>
          <Text style={[styles.preview, { color: colors.textSecondary }]} numberOfLines={1}>
            {messagePreview(conv.last_message)}
          </Text>
          {unread > 0 && (
            <View style={[styles.unread, { backgroundColor: colors.badge }]}>
              <Text style={styles.unreadText}>{unread > 99 ? '99+' : unread}</Text>
            </View>
          )}
        </View>
      </View>
      {conv.kind !== 'direct' && (
        <Text style={[styles.groupTag, { color: colors.textMuted }]}>{conv.member_count}人</Text>
      )}
      {conv.other_user?.is_online && (
        <View style={[styles.onlineDot, { borderColor: colors.card }]} />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E5E5E5',
  },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#E5E5E5' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 20, fontWeight: '600' },
  content: { flex: 1, marginLeft: 11 },
  titleLine: { flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1, fontSize: 15, fontWeight: '600' },
  time: { fontSize: 11, marginLeft: 8 },
  previewLine: { flexDirection: 'row', alignItems: 'center', marginTop: 5 },
  preview: { flex: 1, fontSize: 13 },
  unread: { minWidth: 19, height: 19, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5, marginLeft: 8 },
  unreadText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600' },
  groupTag: { fontSize: 10, marginLeft: 6 },
  onlineDot: { position: 'absolute', left: 51, top: 48, width: 10, height: 10, borderRadius: 5, backgroundColor: '#34A853', borderWidth: 2 },
});
