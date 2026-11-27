import React, { useEffect, useState } from 'react';
import {
  View, Text, Image, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Linking,
} from 'react-native';

import { resolveImageUri } from '../../services/imAttachment';
import {
  isVideoAttachment, systemNoticeText, type ImMessage,
} from '../../types/im';
import { splitLinks } from '../../utils/linkify';
import type { ImColors } from './colors';

interface Props {
  message: ImMessage
  isSelf: boolean
  colors: ImColors
  mentioned?: boolean
  selectMode: boolean
  selected: boolean
  onPress: (message: ImMessage) => void
  onLongPress: (message: ImMessage) => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function openUrl(url: string): Promise<void> {
  try {
    if (!(await Linking.canOpenURL(url))) {
      Alert.alert('提示', '当前设备没有可打开该网址的应用');
      return;
    }
    await Linking.openURL(url);
  } catch {
    Alert.alert('提示', '网址打开失败，请长按复制后手动粘贴');
  }
}

export default function MessageBubble({
  message, isSelf, colors, mentioned, selectMode, selected, onPress, onLongPress,
}: Props) {
  const [imageUri, setImageUri] = useState<string | null>(message.local_uri || null);
  const attachment = message.attachment;
  const video = message.kind === 'file' && isVideoAttachment(attachment);

  useEffect(() => {
    // 乐观消息直接用本地文件预览，上传完成前不发任何网络请求
    if (message.local_uri) {
      setImageUri(message.local_uri);
      return;
    }
    let active = true;
    if (message.kind === 'image' && attachment && attachment.id > 0 && !message.recalled) {
      resolveImageUri(attachment.id, true)
        .then((uri) => { if (active) setImageUri(uri); })
        .catch(() => { if (active) setImageUri(null); });
    }
    return () => { active = false; };
  }, [message.kind, message.recalled, attachment?.id, message.local_uri]);

  if (message.kind === 'system') {
    return (
      <View style={styles.systemWrap}>
        <Text style={[styles.system, { color: colors.textMuted }]}>{systemNoticeText(message.content_text)}</Text>
      </View>
    );
  }

  const bubbleStyle = [
    styles.bubble,
    { backgroundColor: isSelf ? colors.bubbleSelf : colors.bubbleOther },
    message.kind === 'image' && styles.imageBubble,
    selectMode && styles.selectable,
    selected && [styles.selected, { borderColor: colors.accent }],
  ];
  const linkColor = isSelf ? '#FFFFFF' : colors.accent;

  return (
    <View style={[styles.row, isSelf ? styles.rowSelf : styles.rowOther]}>
      {!isSelf && (
        <View style={[styles.avatar, { backgroundColor: colors.avatarBg }]}>
          <Text style={[styles.avatarText, { color: colors.accent }]}>{(message.sender_name || '用').slice(0, 1)}</Text>
        </View>
      )}
      <TouchableOpacity
        style={bubbleStyle}
        onLongPress={() => onLongPress(message)}
        onPress={() => onPress(message)}
        activeOpacity={0.9}
      >
        {selectMode && selected && (
          <View style={[styles.selectedBadge, { backgroundColor: colors.accent }]}>
            <Text style={styles.selectedBadgeText}>✓</Text>
          </View>
        )}
        {mentioned && (
          <Text style={[styles.mentionTag, { color: linkColor }]}>@我</Text>
        )}
        {message.mention_all && (
          <Text style={[styles.mentionTag, { color: linkColor }]}>@所有人</Text>
        )}
        {!!message.reply_to && (
          <View style={styles.reply}>
            <Text style={[styles.replyName, { color: isSelf ? '#E8F1FF' : colors.textMuted }]}>
              {message.reply_to.sender_name || '消息'}
            </Text>
            <Text style={[styles.replyText, { color: isSelf ? '#E8F1FF' : colors.textSecondary }]} numberOfLines={2}>
              {message.reply_to.preview || '[消息]'}
            </Text>
          </View>
        )}
        {message.recalled ? (
          <Text style={[styles.text, { color: colors.textMuted, fontStyle: 'italic' }]}>消息已撤回</Text>
        ) : message.kind === 'image' && attachment ? (
          imageUri ? (
            <Image source={{ uri: imageUri }} style={styles.image} resizeMode="cover" />
          ) : (
            <View style={styles.imageLoading}><ActivityIndicator color={colors.accent} /></View>
          )
        ) : message.kind === 'file' && attachment ? (
          <View style={styles.fileCard}>
            <Text style={[styles.fileName, { color: isSelf ? '#FFFFFF' : colors.textPrimary }]} numberOfLines={2}>
              {video ? '▶ 视频' : '📎'} {attachment.original_name}
            </Text>
            <Text style={[styles.fileSize, { color: isSelf ? '#E8F1FF' : colors.textMuted }]}>
              {video ? '点击在线播放 · ' : ''}{formatSize(attachment.size_bytes)}
            </Text>
          </View>
        ) : (
          <Text style={[styles.text, { color: isSelf ? colors.bubbleSelfText : colors.textPrimary }]}>
            {splitLinks(message.content_text || '').map((part, index) => part.url ? (
              <Text
                key={index}
                onPress={() => void openUrl(part.url!)}
                onLongPress={() => onLongPress(message)}
                style={[styles.link, { color: linkColor }]}
              >
                {part.text}
              </Text>
            ) : <Text key={index}>{part.text}</Text>)}
          </Text>
        )}
        {message.pending && <ActivityIndicator size="small" color={isSelf ? '#FFFFFF' : colors.accent} />}
        {message.failed && (
          <TouchableOpacity onPress={() => onLongPress(message)}>
            <Text style={styles.failed}>发送失败</Text>
          </TouchableOpacity>
        )}
      </TouchableOpacity>
      {isSelf && <View style={styles.avatar} />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 12, marginVertical: 4 },
  rowSelf: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },
  avatar: { width: 32, height: 32, borderRadius: 16, marginRight: 7, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 14, fontWeight: '600' },
  bubble: { maxWidth: '76%', borderRadius: 12, paddingHorizontal: 11, paddingVertical: 8, position: 'relative' },
  selectable: { borderWidth: 1, borderColor: 'transparent' },
  selected: { borderWidth: 2 },
  selectedBadge: {
    position: 'absolute', top: -7, right: -7,
    width: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  selectedBadgeText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  imageBubble: { padding: 3 },
  text: { fontSize: 15, lineHeight: 21 },
  link: { textDecorationLine: 'underline' },
  mentionTag: { fontSize: 11, fontWeight: '600', marginBottom: 2 },
  reply: { borderLeftWidth: 2, borderLeftColor: 'rgba(128,128,128,0.5)', paddingLeft: 6, marginBottom: 5 },
  replyName: { fontSize: 11 },
  replyText: { fontSize: 12, marginTop: 2 },
  image: { width: 180, height: 180, borderRadius: 9 },
  imageLoading: { width: 140, height: 100, alignItems: 'center', justifyContent: 'center' },
  fileCard: { minWidth: 150 },
  fileName: { fontSize: 14 },
  fileSize: { fontSize: 11, marginTop: 4 },
  systemWrap: { alignItems: 'center', paddingVertical: 8 },
  system: { fontSize: 11, backgroundColor: 'rgba(128,128,128,0.12)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  failed: { color: '#FFD0D0', fontSize: 11, marginTop: 4 },
});
