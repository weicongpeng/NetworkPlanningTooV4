import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, Modal,
  RefreshControl, Clipboard, KeyboardAvoidingView, Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useImColors } from '../../src/components/Im/colors';
import MessageBubble from '../../src/components/Im/MessageBubble';
import MediaLightbox from '../../src/components/Im/MediaLightbox';
import ImageEditor from '../../src/components/Im/ImageEditor';
import ImComposer from '../../src/components/Im/ImComposer';
import { useImStore, EMPTY_MESSAGES } from '../../src/store/imStore';
import { useMapStore } from '../../src/store/mapStore';
import { imApi } from '../../src/services/imApi';
import { resolveImageUri, downloadAndShare } from '../../src/services/imAttachment';
import { navigateToTab } from '../../src/utils/navigation';
import {
  formatDaySeparator, isVideoAttachment, isWithinRecallWindow,
  type ImMember, type ImMessage,
} from '../../src/types/im';

type LightboxMedia = { kind: 'image' | 'video'; uri: string; fullUri?: string; messageId: number };

export default function ChatScreen({ route, navigation }: any) {
  const conversationId: number = Number(route.params?.conversationId);
  const insets = useSafeAreaInsets();
  const colors = useImColors();
  const darkMode = useMapStore((s) => s.darkMode);
  const conversations = useImStore((s) => s.conversations);
  const messages = useImStore((s) => s.messages[conversationId] ?? EMPTY_MESSAGES);
  const cursor = useImStore((s) => s.cursors[conversationId]);
  const loading = useImStore((s) => s.loadingMessages[conversationId] || false);
  const myUserId = useImStore((s) => s.myUserId);
  const mentionBadges = useImStore((s) => s.mentionBadges);
  const error = useImStore((s) => s.error);
  const sessionExpired = useImStore((s) => s.sessionExpired);
  const setActiveConversation = useImStore((s) => s.setActiveConversation);
  const loadMessages = useImStore((s) => s.loadMessages);
  const setReplyDraft = useImStore((s) => s.setReplyDraft);
  const recall = useImStore((s) => s.recall);

  const [members, setMembers] = useState<ImMember[]>([]);
  const [lightbox, setLightbox] = useState<LightboxMedia | null>(null);
  const [editingMessage, setEditingMessage] = useState<ImMessage | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const listRef = useRef<FlatList<ImMessage>>(null);
  const initialScrollRef = useRef(true);
  const atBottomRef = useRef(true);
  const lastCountRef = useRef(0);

  const conv = useMemo(() => conversations.find((c) => c.id === conversationId), [conversations, conversationId]);
  const title = route.params?.title || conv?.name || '会话';

  useEffect(() => {
    void setActiveConversation(conversationId);
    void imApi.members(conversationId).then(setMembers).catch(() => setMembers([]));
    return () => { void setActiveConversation(null); };
  }, [conversationId, setActiveConversation]);

  const viewportHeightRef = useRef(0);
  const contentHeightRef = useRef(0);

  // scrollToEnd 在 flexGrow 容器下会停在旧尺寸位置；用真实 contentHeight 算偏移更可靠
  const jumpToLatest = useCallback((animated = false) => {
    const list: any = listRef.current;
    if (!list) return;
    const offset = Math.max(0, contentHeightRef.current - viewportHeightRef.current);
    if (offset > 0) list.scrollToOffset({ offset, animated });
    else list.scrollToEnd({ animated });
  }, []);

  // 同一帧内多次尺寸变化只调度一次，避免滚动/渲染互相触发造成卡顿
  const jumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleJump = useCallback(() => {
    if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
    jumpTimerRef.current = setTimeout(() => {
      jumpTimerRef.current = null;
      jumpToLatest(false);
    }, 16);
  }, [jumpToLatest]);

  useEffect(() => () => {
    if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
  }, []);

  // 会话切换：重新进入「定位最新」状态；布局完成后再定位，覆盖已加载过的会话
  useEffect(() => {
    initialScrollRef.current = true;
    atBottomRef.current = true;
    lastCountRef.current = messages.length;
    setSelectMode(false);
    setSelectedIds([]);
    scheduleJump();
  }, [conversationId, scheduleJump]);

  const handleContentSizeChange = useCallback((_width: number, height: number) => {
    contentHeightRef.current = height;
    if (initialScrollRef.current || atBottomRef.current) scheduleJump();
  }, [scheduleJump]);

  const handleLayout = useCallback((event: any) => {
    viewportHeightRef.current = event.nativeEvent.layout.height;
    if (initialScrollRef.current) scheduleJump();
  }, [scheduleJump]);

  const handleScroll = useCallback((event: any) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    atBottomRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
  }, []);

  // 首批数据加载稳定后关闭自动定位，避免加载更早消息时把视口拉回最新
  useEffect(() => {
    if (loading || !initialScrollRef.current) return;
    const timer = setTimeout(() => { initialScrollRef.current = false; }, 250);
    return () => clearTimeout(timer);
  }, [loading]);

  // 之后只有新消息追加、且用户本来就在底部时才跟随
  useEffect(() => {
    const count = messages.length;
    const appended = count > lastCountRef.current;
    lastCountRef.current = count;
    if (appended && atBottomRef.current && !initialScrollRef.current) jumpToLatest(true);
  }, [messages.length, jumpToLatest]);

  const loadOlder = useCallback(() => {
    atBottomRef.current = false;
    void loadMessages(conversationId, 'older');
  }, [conversationId, loadMessages]);

  // 一页消息只发一次签名请求，避免每张缩略图各打一次 /im/attachments/urls
  const prewarmed = useRef(new Set<number>());
  useEffect(() => {
    const items = messages
      .filter((m) => m.kind === 'image' && m.attachment && m.attachment.id > 0
        && !m.local_uri && !prewarmed.current.has(m.attachment.id))
      .slice(0, 200)
      .map((m) => ({ attachment_id: m.attachment!.id, thumb: true }));
    if (!items.length) return;
    items.forEach((item) => prewarmed.current.add(item.attachment_id));
    void imApi.attachmentUrls(items);
  }, [messages]);

  const showMedia = async (message: ImMessage) => {
    const attachment = message.attachment;
    if (!attachment) return;
    try {
      if (isVideoAttachment(attachment)) {
        // 直接用会话页已预热的签名（缓存命中即微任务，无网络等待）；
        // thumb=true 对无缩略图的视频返回原文件且 Content-Disposition 为 inline。
        const signed = await imApi.signedImageUrl(attachment.id, true);
        if (signed) setLightbox({ kind: 'video', uri: signed, messageId: message.id });
        else await downloadAndShare(attachment.id, attachment.original_name);
        return;
      }
      // 缩略图常驻底层瞬时显示；全图作为上层叠加，加载完成前不动底层，避免闪烁
      setLightbox({
        kind: 'image',
        uri: await resolveImageUri(attachment.id, true),
        messageId: message.id,
      });
      void resolveImageUri(attachment.id, false).then((full) => {
        setLightbox((prev) => (
          prev && prev.kind === 'image' && prev.messageId === message.id && full !== prev.uri
            ? { ...prev, fullUri: full }
            : prev
        ));
      }).catch(() => {});
    } catch (e) {
      Alert.alert('提示', e instanceof Error ? e.message : '媒体加载失败');
    }
  };

  // 查看入口用：当前会话全部图片/视频，按消息顺序
  const mediaItems = useMemo(() => messages.filter((m) => (
    !!m.attachment && m.attachment.id > 0 && !m.local_uri
    && (m.kind === 'image' || isVideoAttachment(m.attachment))
  )), [messages]);

  const openFile = async (message: ImMessage) => {
    if (!message.attachment) return;
    try {
      await downloadAndShare(message.attachment.id, message.attachment.original_name);
    } catch (e) {
      Alert.alert('提示', e instanceof Error ? e.message : '文件打开失败');
    }
  };

  const showMessageActions = (message: ImMessage) => {
    const self = message.sender_id === myUserId;
    const buttons: any[] = [
      {
        text: '引用', onPress: () => setReplyDraft(conversationId, {
          id: message.id,
          sender_name: message.sender_name,
          kind: message.kind,
          preview: message.content_text || (message.kind === 'image' ? '[图片]' : '[文件]'),
          attachment: message.attachment,
        }),
      },
      { text: '转发', onPress: () => navigation.navigate('Forward', { messageIds: [message.id] }) },
      { text: '复制', onPress: () => Clipboard.setString(message.content_text || '') },
    ];
    if (self && message.id > 0 && !message.recalled && isWithinRecallWindow(message.created_at)) {
      buttons.push({
        text: '撤回', style: 'destructive',
        onPress: () => { void recall(conversationId, message.id); },
      });
    }
    buttons.push({ text: '取消', style: 'cancel' });
    Alert.alert('消息操作', undefined, buttons);
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds([]);
  };

  const handleBubblePress = (message: ImMessage) => {
    if (selectMode) {
      setSelectedIds((prev) => (
        prev.includes(message.id) ? prev.filter((id) => id !== message.id) : [...prev, message.id]
      ));
      return;
    }
    if (message.recalled || !message.attachment) return;
    if (message.kind === 'image' || isVideoAttachment(message.attachment)) void showMedia(message);
    else if (message.kind === 'file') void openFile(message);
  };

  const handleBubbleLongPress = (message: ImMessage) => {
    if (!selectMode) {
      setSelectMode(true);
      setSelectedIds([message.id]);
      return;
    }
    // 多选态下长按仍保留引用/复制/撤回等单条操作
    showMessageActions(message);
  };

  const renderItem = useCallback(({ item, index }: { item: ImMessage; index: number }) => {
    const previous = messages[index - 1];
    const showDay = !previous
      || formatDaySeparator(previous.created_at) !== formatDaySeparator(item.created_at);
    const isSelf = item.sender_id === myUserId;
    return (
      <View>
        {showDay && (
          <View style={styles.dayWrap}>
            <Text style={[styles.day, { color: colors.textMuted }]}>{formatDaySeparator(item.created_at)}</Text>
          </View>
        )}
        <MessageBubble
          message={item}
          isSelf={isSelf}
          colors={colors}
          mentioned={!!mentionBadges[item.id]}
          selectMode={selectMode}
          selected={selectedIds.includes(item.id)}
          onPress={handleBubblePress}
          onLongPress={handleBubbleLongPress}
        />
      </View>
    );
  }, [messages, myUserId, colors, mentionBadges, selectMode, selectedIds, handleBubblePress, handleBubbleLongPress]);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bg, paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar style={darkMode ? 'light' : 'dark'} />
      <View style={[styles.header, { borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={[styles.backText, { color: colors.accent }]}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.headerTitle} onPress={() => {
          if (conv && conv.kind !== 'direct') navigation.navigate('GroupInfo', { conversationId });
        }}>
          <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>{title}</Text>
          {conv && conv.kind !== 'direct' && (
            <Text style={[styles.subtitle, { color: colors.textMuted }]}>{conv.member_count} 人 · 群资料</Text>
          )}
        </TouchableOpacity>
        {selectMode ? (
          <View style={styles.headerActions}>
            <TouchableOpacity
              onPress={() => {
                if (!selectedIds.length) { Alert.alert('提示', '请选择消息'); return; }
                navigation.navigate('Forward', { messageIds: selectedIds });
                exitSelectMode();
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={[styles.headerAction, { color: colors.accent }]}>转发({selectedIds.length})</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={exitSelectMode} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={[styles.headerAction, { color: colors.textMuted }]}>取消</Text>
            </TouchableOpacity>
          </View>
        ) : <View style={styles.back} />}
      </View>

      {sessionExpired ? (
        <TouchableOpacity onPress={() => navigateToTab(navigation, 'profile')}>
          <Text style={[styles.error, { color: colors.danger }]}>{sessionExpired} · 点击前往登录</Text>
        </TouchableOpacity>
      ) : error ? (
        <Text style={[styles.error, { color: colors.danger }]} numberOfLines={2}>{error}</Text>
      ) : null}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={handleContentSizeChange}
        onLayout={handleLayout}
        onScroll={handleScroll}
        scrollEventThrottle={100}
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        windowSize={7}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews
        refreshControl={(
          <RefreshControl
            refreshing={loading}
            onRefresh={loadOlder}
            tintColor={colors.accent}
          />
        )}
        ListHeaderComponent={cursor?.prev ? (
          <TouchableOpacity style={styles.older} onPress={loadOlder}>
            <Text style={[styles.olderText, { color: colors.accent }]}>加载更早消息</Text>
          </TouchableOpacity>
        ) : null}
      />

      <ImComposer
        conversationId={conversationId}
        members={members}
        myRole={conv?.my_role}
        colors={colors}
      />

      <Modal visible={!!lightbox} transparent animationType="none" onRequestClose={() => setLightbox(null)}>
        {lightbox ? (
          <MediaLightbox
            kind={lightbox.kind}
            uri={lightbox.uri}
            fullUri={lightbox.fullUri}
            messageId={lightbox.messageId}
            mediaItems={mediaItems}
            colors={colors}
            onClose={() => setLightbox(null)}
            onSwitch={(m) => void showMedia(m)}
            onSwitchByOffset={(delta) => {
              const index = mediaItems.findIndex((m) => m.id === lightbox.messageId);
              const target = mediaItems[index + delta];
              if (target) void showMedia(target);
            }}
            onDownload={() => {
              const target = messages.find((m) => m.id === lightbox.messageId);
              if (!target?.attachment) return;
              void downloadAndShare(target.attachment.id, target.attachment.original_name)
                .catch((e) => Alert.alert('提示', e instanceof Error ? e.message : '下载失败'));
            }}
            onForward={() => {
              setLightbox(null);
              navigation.navigate('Forward', { messageIds: [lightbox.messageId] });
            }}
            onEdit={() => {
              const target = messages.find((m) => m.id === lightbox.messageId);
              if (target) setEditingMessage(target);
            }}
          />
        ) : null}
      </Modal>

      {editingMessage && (
        <ImageEditor
          message={editingMessage}
          colors={colors}
          onClose={() => setEditingMessage(null)}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { width: 30 },
  backText: { fontSize: 32, lineHeight: 30 },
  headerTitle: { flex: 1, alignItems: 'center' },
  title: { fontSize: 16, fontWeight: '600', maxWidth: '90%' },
  subtitle: { fontSize: 11, marginTop: 2 },
  headerAction: { fontSize: 14, paddingHorizontal: 4 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  error: { fontSize: 12, paddingHorizontal: 12, paddingTop: 4 },
  list: { flex: 1 },
  listContent: { paddingVertical: 6, flexGrow: 1, justifyContent: 'flex-end' },
  dayWrap: { alignItems: 'center', paddingVertical: 6 },
  day: { fontSize: 11 },
  older: { alignItems: 'center', paddingVertical: 10 },
  olderText: { fontSize: 12 },
});
