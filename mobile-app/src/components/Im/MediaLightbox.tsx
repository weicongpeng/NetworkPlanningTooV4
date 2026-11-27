/** 聊天媒体灯箱：图片点击退出/捏合缩放/平移，视频 WebView 在线播放，下方编辑/下载/转发/查看。 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Image, FlatList, Modal, Animated, PanResponder, ActivityIndicator, Alert,
  TouchableOpacity, TouchableWithoutFeedback, StyleSheet,
  type NativeSyntheticEvent, type NativeTouchEvent,
} from 'react-native';
import { WebView } from 'react-native-webview';

import { imApi } from '../../services/imApi';
import { isVideoAttachment, type ImMessage } from '../../types/im';
import type { ImColors } from './colors';

type TouchEvent = NativeSyntheticEvent<NativeTouchEvent>;
type Touch = { pageX: number; pageY: number };

const MIN_SCALE = 1;
const MAX_SCALE = 5;

function distance(a: Touch, b: Touch): number {
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface Props {
  kind: 'image' | 'video'
  uri: string
  fullUri?: string
  messageId: number
  mediaItems: ImMessage[]
  colors: ImColors
  onClose: () => void
  onSwitch: (message: ImMessage) => void
  onSwitchByOffset: (delta: number) => void
  onDownload: () => void
  onForward: () => void
  onEdit: () => void
}

function videoHtml(uri: string): string {
  const safe = uri.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">`
    + `<style>html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}`
    + `video{width:100%;height:100%;object-fit:contain;background:#000}</style></head>`
    + `<body><video src="${safe}" controls autoplay playsinline webkit-playsinline preload="auto"></video></body></html>`;
}

export default function MediaLightbox({
  kind, uri, fullUri, mediaItems, colors, onClose, onSwitch, onSwitchByOffset, onDownload, onForward, onEdit,
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const [videoLoading, setVideoLoading] = useState(true);
  const [fullLoaded, setFullLoaded] = useState(false);
  const [showGallery, setShowGallery] = useState(false);

  useEffect(() => { setFullLoaded(false); }, [fullUri]);

  // PanResponder 只在首次渲染创建，必须通过 ref 读取最新回调，否则翻页永远从初始消息算 +1/-1
  const switchRef = useRef(onSwitchByOffset);
  switchRef.current = onSwitchByOffset;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const gesture = useRef({
    mode: 0, scale: 1, x: 0, y: 0,
    startScale: 1, startDistance: 0,
    startX: 0, startY: 0, baseX: 0, baseY: 0,
  }).current;

  const reset = () => {
    gesture.scale = 1; gesture.x = 0; gesture.y = 0;
    Animated.parallel([
      Animated.timing(scale, { toValue: 1, duration: 160, useNativeDriver: true }),
      Animated.timing(translateX, { toValue: 0, duration: 160, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 160, useNativeDriver: true }),
    ]).start();
  };

  const beginPinch = (touches: Touch[]) => {
    gesture.startDistance = distance(touches[0], touches[1]);
    gesture.startScale = gesture.scale;
    gesture.mode = 2;
  };

  const beginPan = (touches: Touch[]) => {
    gesture.startX = touches[0].pageX;
    gesture.startY = touches[0].pageY;
    gesture.baseX = gesture.x;
    gesture.baseY = gesture.y;
    gesture.mode = 1;
  };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event: TouchEvent) => {
      const touches = event.nativeEvent.touches as unknown as Touch[];
      if (touches.length >= 2) beginPinch(touches);
      else if (touches.length === 1) beginPan(touches);
    },
    onPanResponderMove: (event: TouchEvent) => {
      const touches = event.nativeEvent.touches as unknown as Touch[];
      if (touches.length >= 2) {
        if (gesture.mode < 2 || gesture.startDistance <= 0) beginPinch(touches);
        const next = clamp(
          gesture.startScale * distance(touches[0], touches[1]) / gesture.startDistance,
          MIN_SCALE, MAX_SCALE,
        );
        gesture.scale = next;
        scale.setValue(next);
        if (next <= MIN_SCALE) {
          gesture.x = 0; gesture.y = 0;
          translateX.setValue(0); translateY.setValue(0);
        }
        return;
      }
      if (touches.length === 1 && gesture.scale > MIN_SCALE) {
        // 未放大时不做平移，留给松手后的左右翻页判断
        if (gesture.mode > 1) beginPan(touches);
        gesture.x = gesture.baseX + (touches[0].pageX - gesture.startX);
        gesture.y = gesture.baseY + (touches[0].pageY - gesture.startY);
        translateX.setValue(gesture.x);
        translateY.setValue(gesture.y);
      }
    },
    onPanResponderRelease: (_event: TouchEvent, state: { dx: number; dy: number }) => {
      const singleTap = gesture.mode === 1
        && Math.abs(state.dx) < 10 && Math.abs(state.dy) < 10;
      const horizontalSwipe = gesture.mode === 1 && gesture.scale <= MIN_SCALE
        && Math.abs(state.dx) > 60 && Math.abs(state.dx) > Math.abs(state.dy) * 1.5;
      if (singleTap) closeRef.current();
      else if (horizontalSwipe) switchRef.current(state.dx < 0 ? 1 : -1);
      else if (gesture.scale <= MIN_SCALE) reset();
      gesture.mode = 0;
      gesture.startDistance = 0;
    },
    onPanResponderTerminate: () => {
      if (gesture.scale <= MIN_SCALE) reset();
      gesture.mode = 0;
      gesture.startDistance = 0;
    },
    onPanResponderTerminationRequest: () => false,
  })).current;

  const actions = [
    {
      key: 'edit', label: '编辑', icon: '✎', disabled: false,
      onPress: () => {
        if (kind === 'video') {
          Alert.alert('提示', '当前仅支持图片标注，视频请先下载后再编辑');
          return;
        }
        onEdit();
      },
    },
    { key: 'download', label: '下载', icon: '↓', disabled: false, onPress: onDownload },
    { key: 'forward', label: '转发', icon: '↗', disabled: false, onPress: onForward },
    { key: 'gallery', label: '查看', icon: '▦', disabled: false, onPress: () => setShowGallery(true) },
  ];

  return (
    <View style={[styles.container, { backgroundColor: colors.overlayBg }]}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.blank} />
      </TouchableWithoutFeedback>

      <View style={styles.mediaArea}>
        {kind === 'image' ? (
          <View style={styles.mediaInner} {...pan.panHandlers}>
            <Animated.Image
              source={{ uri }}
              style={[styles.image, { transform: [{ translateX }, { translateY }, { scale }] }]}
              resizeMode="contain"
            />
            {!!fullUri && fullUri !== uri && (
              <Animated.Image
                source={{ uri: fullUri }}
                style={[
                  styles.image, styles.fullImage,
                  { transform: [{ translateX }, { translateY }, { scale }], opacity: fullLoaded ? 1 : 0 },
                ]}
                resizeMode="contain"
                onLoadEnd={() => setFullLoaded(true)}
              />
            )}
          </View>
        ) : (
          <View style={styles.mediaInner}>
            <WebView
              source={{ html: videoHtml(uri) }}
              style={styles.video}
              allowsInlineMediaPlayback
              allowsFullscreenVideo
              mediaPlaybackRequiresUserAction={false}
              javaScriptEnabled
              domStorageEnabled
              mixedContentMode="always"
              onLoadEnd={() => setVideoLoading(false)}
            />
            {videoLoading && (
              <View style={styles.loading}>
                <ActivityIndicator color="#FFFFFF" size="large" />
              </View>
            )}
          </View>
        )}
      </View>

      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.blank} />
      </TouchableWithoutFeedback>

      <View style={[styles.toolbar, { borderTopColor: colors.cardBorder }]}>
        {actions.map((action) => (
          <TouchableOpacity
            key={action.key}
            style={styles.action}
            onPress={action.onPress}
            disabled={action.disabled}
            activeOpacity={0.7}
          >
            <Text style={[styles.actionIcon, { color: action.disabled ? colors.textMuted : '#FFFFFF' }]}>
              {action.icon}
            </Text>
            <Text style={[styles.actionLabel, { color: action.disabled ? colors.textMuted : '#FFFFFF' }]}>
              {action.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Modal visible={showGallery} transparent animationType="fade" onRequestClose={() => setShowGallery(false)}>
        <TouchableWithoutFeedback onPress={() => setShowGallery(false)}>
          <View style={[styles.galleryOverlay, { backgroundColor: colors.overlayBg }]}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={[styles.galleryPanel, { backgroundColor: colors.card }]}>
                <Text style={[styles.galleryTitle, { color: colors.textPrimary }]}>
                  全部图片 / 视频（{mediaItems.length}）
                </Text>
                <FlatList
                  data={mediaItems}
                  numColumns={4}
                  keyExtractor={(item) => String(item.id)}
                  renderItem={({ item }) => {
                    const video = isVideoAttachment(item.attachment);
                    // 会话页已批量预热缩略图签名，这里同步命中缓存，零网络等待
                    const url = item.attachment ? imApi.peekSignedUrl(item.attachment.id, true) : null;
                    return (
                      <TouchableOpacity
                        style={styles.thumbCell}
                        onPress={() => { setShowGallery(false); onSwitch(item); }}
                      >
                        {video || !url ? (
                          <View style={[styles.thumb, { backgroundColor: colors.inputBg }]}>
                            <Text style={{ color: colors.textMuted, fontSize: 20 }}>{video ? '▶' : '▧'}</Text>
                          </View>
                        ) : (
                          <Image source={{ uri: url }} style={styles.thumb} resizeMode="cover" />
                        )}
                      </TouchableOpacity>
                    );
                  }}
                />
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  blank: { flex: 1 },
  mediaArea: { height: '62%', overflow: 'hidden' },
  mediaInner: { flex: 1 },
  image: { width: '100%', height: '100%' },
  fullImage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  video: { flex: 1, backgroundColor: '#000000' },
  loading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  toolbar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 10 },
  action: { flex: 1, alignItems: 'center', paddingVertical: 4 },
  actionIcon: { fontSize: 22, lineHeight: 26 },
  actionLabel: { fontSize: 12, marginTop: 3 },
  galleryOverlay: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  galleryPanel: { width: '92%', maxHeight: '72%', borderRadius: 12, padding: 12 },
  galleryTitle: { fontSize: 14, fontWeight: '600', marginBottom: 10 },
  thumbCell: { width: '25%', padding: 3 },
  thumb: { width: '100%', aspectRatio: 1, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
});
