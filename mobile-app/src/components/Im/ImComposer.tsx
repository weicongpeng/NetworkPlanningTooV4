import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Modal,
} from 'react-native';

import {
  newClientMsgId, pickFromCamera, pickFromLibrary, pickFromFile,
} from '../../services/imAttachment';
import { useImStore, EMPTY_ATTACHMENTS } from '../../store/imStore';
import { imDisplayName, isAdminRole, type ImMember } from '../../types/im';
import type { ImColors } from './colors';
import MentionPicker from './MentionPicker';

interface Props {
  conversationId: number
  members: ImMember[]
  myRole?: string
  colors: ImColors
}

const EMOJIS = [
  '😀', '😂', '😊', '😍', '😉', '😎', '🤔', '😢',
  '👍', '👌', '🙏', '💪', '🎉', '❤️', '🔥', '✅',
  '📷', '📎', '📍', '🚗', '📡', '🗺️', '⚡', '👋',
];

const ACTIONS: Array<{ key: 'camera' | 'library' | 'file'; label: string; icon: string; hint: string }> = [
  { key: 'camera', label: '照相', icon: '◉', hint: '调用相机拍摄并发送' },
  { key: 'library', label: '图片', icon: '▧', hint: '从相册选择图片' },
  { key: 'file', label: '附件', icon: '▤', hint: '选择任意文件（表格、文档等）' },
];

function SmileIcon({ color }: { color: string }) {
  return (
    <View style={[styles.smileOuter, { borderColor: color }]}>
      <View style={[styles.smileEye, { left: 7, backgroundColor: color }]} />
      <View style={[styles.smileEye, { right: 7, backgroundColor: color }]} />
      <View style={[styles.smileMouth, { borderBottomColor: color }]} />
    </View>
  );
}

function PlusIcon({ color }: { color: string }) {
  return (
    <View style={styles.plusWrap}>
      <View style={[styles.plusBar, styles.plusHorizontal, { backgroundColor: color }]} />
      <View style={[styles.plusBar, styles.plusVertical, { backgroundColor: color }]} />
    </View>
  );
}

export default function ImComposer({ conversationId, members, myRole, colors }: Props) {
  const draft = useImStore((s) => s.drafts[conversationId] || '');
  const reply = useImStore((s) => s.replyDrafts[conversationId] || null);
  const pending = useImStore((s) => s.pendingAttachments[conversationId] ?? EMPTY_ATTACHMENTS);
  const progress = useImStore((s) => s.uploadProgress);
  const setDraft = useImStore((s) => s.setDraft);
  const setReplyDraft = useImStore((s) => s.setReplyDraft);
  const addPendingAttachment = useImStore((s) => s.addPendingAttachment);
  const removePendingAttachment = useImStore((s) => s.removePendingAttachment);
  const clearPendingAttachments = useImStore((s) => s.clearPendingAttachments);
  const sendText = useImStore((s) => s.sendText);
  const sendAttachment = useImStore((s) => s.sendAttachment);
  const cancelUpload = useImStore((s) => s.cancelUpload);

  const [showMentions, setShowMentions] = useState(false);
  const [mentionedIds, setMentionedIds] = useState<number[]>([]);
  const [mentionAll, setMentionAll] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploadKey, setUploadKey] = useState<string | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);

  const changeText = (text: string) => {
    setDraft(conversationId, text);
    setShowMentions(/@[^@\s]*$/.test(text));
  };

  const selectMention = (member: ImMember | null) => {
    const name = member ? imDisplayName(member) : '所有人';
    const next = draft.replace(/@[^@\s]*$/, '') + `@${name} `;
    setDraft(conversationId, next);
    if (member) setMentionedIds((prev) => (prev.includes(member.id) ? prev : [...prev, member.id]));
    else setMentionAll(true);
    setShowMentions(false);
  };

  const pick = async (source: 'camera' | 'library' | 'file') => {
    setShowActions(false);
    try {
      const result = source === 'camera'
        ? await pickFromCamera()
        : source === 'library' ? await pickFromLibrary() : await pickFromFile();
      // 用户主动取消系统选择器：静默返回，不再弹「已取消选择」
      if (!result) return;
      addPendingAttachment(conversationId, result);
    } catch (e) {
      Alert.alert('提示', e instanceof Error ? e.message : '选择附件失败');
    }
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && pending.length === 0) || sending) return;
    setSending(true);
    setShowMentions(false);
    setShowEmoji(false);
    try {
      if (text) {
        const ok = await sendText(conversationId, text, {
          mentions: mentionedIds,
          mentionAll,
          replyTo: reply,
        });
        if (!ok) return;
        setDraft(conversationId, '');
        setReplyDraft(conversationId, null);
        setMentionedIds([]);
        setMentionAll(false);
      }
      while ((useImStore.getState().pendingAttachments[conversationId] || []).length > 0) {
        const attachment = useImStore.getState().pendingAttachments[conversationId][0];
        const key = newClientMsgId();
        setUploadKey(key);
        const ok = await sendAttachment(conversationId, attachment, key);
        removePendingAttachment(conversationId, 0);
        if (!ok) break;
      }
    } finally {
      setUploadKey(null);
      setSending(false);
    }
  };

  const percent = uploadKey ? progress[uploadKey] : undefined;
  const canSend = draft.trim().length > 0 || pending.length > 0;

  return (
    <>
      <View style={[styles.wrap, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
        {showMentions && members.length > 0 && (
          <MentionPicker
            members={members}
            colors={colors}
            canMentionAll={isAdminRole(myRole)}
            onSelect={selectMention}
          />
        )}
        {reply && (
          <View style={[styles.replyBar, { borderLeftColor: colors.accent }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.replyName, { color: colors.accent }]}>回复 {reply.sender_name}</Text>
              <Text style={[styles.replyText, { color: colors.textSecondary }]} numberOfLines={1}>
                {reply.preview || '[消息]'}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setReplyDraft(conversationId, null)}>
              <Text style={[styles.cancel, { color: colors.textMuted }]}>×</Text>
            </TouchableOpacity>
          </View>
        )}
        {pending.length > 0 && (
          <View style={styles.pendingWrap}>
            {pending.map((item, index) => (
              <View key={`${item.uri}-${index}`} style={[styles.pending, { backgroundColor: colors.inputBg }]}>
                <Text style={[styles.pendingName, { color: colors.textPrimary }]} numberOfLines={1}>{item.name}</Text>
                <TouchableOpacity
                  onPress={() => {
                    if (uploadKey && percent !== undefined && percent < 100) cancelUpload(uploadKey);
                    removePendingAttachment(conversationId, index);
                  }}
                >
                  <Text style={[styles.cancel, { color: colors.textMuted }]}>×</Text>
                </TouchableOpacity>
              </View>
            ))}
            {percent !== undefined && (
              <Text style={[styles.progress, { color: colors.accent }]}>上传中 {percent}%</Text>
            )}
            <TouchableOpacity onPress={() => clearPendingAttachments(conversationId)}>
              <Text style={[styles.clear, { color: colors.textMuted }]}>清空待发送附件</Text>
            </TouchableOpacity>
          </View>
        )}
        {showEmoji && (
          <View style={[styles.emojiPanel, { backgroundColor: colors.inputBg }]}>
            {EMOJIS.map((emoji) => (
              <TouchableOpacity
                key={emoji}
                style={styles.emojiItem}
                onPress={() => changeText(draft + emoji)}
              >
                <Text style={styles.emoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={styles.inputRow}>
          {/* 语音转文字需要录音库 + 服务端 ASR，当前版本未接入，置灰并给出可操作替代 */}
          <TouchableOpacity
            style={[styles.roundBtn, styles.voiceBtn, { borderColor: colors.cardBorder }]}
            onPress={() => Alert.alert(
              '语音输入',
              '语音转文字需要录音库与服务端语音识别，当前版本暂未接入。\n\n可点右侧「+」→ 附件，选择语音文件发送。',
            )}
          >
            <View style={styles.wave}>
              {[6, 12, 8, 14, 6].map((height, index) => (
                <View
                  key={index}
                  style={{ width: 2, height, borderRadius: 1, marginHorizontal: 1, backgroundColor: colors.textMuted }}
                />
              ))}
            </View>
          </TouchableOpacity>

          <View style={[styles.inputWrap, { backgroundColor: colors.inputBg }]}>
            <TextInput
              style={[styles.input, { color: colors.textPrimary }]}
              placeholder="输入消息，@ 提醒成员"
              placeholderTextColor={colors.textMuted}
              value={draft}
              onChangeText={changeText}
              multiline
              maxLength={8000}
            />
            {canSend && !sending && (
              <TouchableOpacity style={[styles.inlineSend, { backgroundColor: colors.accent }]} onPress={() => void send()}>
                <Text style={styles.sendText}>发送</Text>
              </TouchableOpacity>
            )}
            {sending && <ActivityIndicator color={colors.accent} size="small" style={styles.inlineSpinner} />}
          </View>

          <TouchableOpacity
            style={styles.roundBtn}
            onPress={() => { setShowEmoji((v) => !v); setShowMentions(false); }}
          >
            <SmileIcon color={colors.textPrimary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.roundBtn}
            onPress={() => { setShowActions(true); setShowEmoji(false); }}
          >
            <PlusIcon color={colors.textPrimary} />
          </TouchableOpacity>
        </View>
      </View>

      <Modal visible={showActions} transparent animationType="slide" onRequestClose={() => setShowActions(false)}>
        <TouchableOpacity
          style={[styles.actionOverlay, { backgroundColor: colors.overlayBg }]}
          activeOpacity={1}
          onPress={() => setShowActions(false)}
        >
          <View style={[styles.actionSheet, { backgroundColor: colors.card }]}>
            <Text style={[styles.actionTitle, { color: colors.textMuted }]}>发送附件</Text>
            {ACTIONS.map((action) => (
              <TouchableOpacity
                key={action.key}
                style={[styles.actionRow, { borderBottomColor: colors.divider }]}
                onPress={() => void pick(action.key)}
                activeOpacity={0.6}
              >
                <View style={[styles.actionIcon, { backgroundColor: colors.inputBg }]}>
                  <Text style={[styles.actionIconText, { color: colors.accent }]}>{action.icon}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.actionLabel, { color: colors.textPrimary }]}>{action.label}</Text>
                  <Text style={[styles.actionHint, { color: colors.textMuted }]}>{action.hint}</Text>
                </View>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.actionCancel} onPress={() => setShowActions(false)}>
              <Text style={[styles.actionCancelText, { color: colors.textSecondary }]}>取消</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth },
  replyBar: { flexDirection: 'row', alignItems: 'center', borderLeftWidth: 3, paddingHorizontal: 12, paddingVertical: 6 },
  replyName: { fontSize: 12, fontWeight: '600' },
  replyText: { fontSize: 12, marginTop: 2 },
  cancel: { fontSize: 20, paddingHorizontal: 6 },
  pendingWrap: { paddingHorizontal: 12, paddingTop: 6 },
  pending: { flexDirection: 'row', alignItems: 'center', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, marginBottom: 4 },
  pendingName: { flex: 1, fontSize: 12 },
  progress: { fontSize: 11, paddingBottom: 4 },
  clear: { fontSize: 11, textAlign: 'right', paddingBottom: 6 },
  emojiPanel: { flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 8, paddingHorizontal: 6, maxHeight: 150 },
  emojiItem: { width: '12.5%', alignItems: 'center', paddingVertical: 7 },
  emoji: { fontSize: 22 },
  inputRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8 },
  roundBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', marginHorizontal: 3 },
  voiceBtn: { opacity: 0.55, borderWidth: 1, borderRadius: 17 },
  wave: { flexDirection: 'row', alignItems: 'center' },
  smileOuter: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 1.6,
    alignItems: 'center', justifyContent: 'center',
  },
  smileEye: { position: 'absolute', top: 7, width: 2.6, height: 2.6, borderRadius: 1.3 },
  smileMouth: { position: 'absolute', top: 12, width: 10, height: 5, borderRadius: 5, borderBottomWidth: 1.6 },
  plusWrap: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  plusBar: { position: 'absolute', borderRadius: 1 },
  plusHorizontal: { width: 17, height: 1.8 },
  plusVertical: { width: 1.8, height: 17 },
  inputWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', borderRadius: 8, marginHorizontal: 3, paddingLeft: 10 },
  input: { flex: 1, minHeight: 36, maxHeight: 100, fontSize: 14, paddingVertical: 8 },
  inlineSend: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, marginLeft: 4 },
  inlineSpinner: { marginHorizontal: 10 },
  sendText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  actionOverlay: { flex: 1, justifyContent: 'flex-end' },
  actionSheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 12, paddingBottom: 16 },
  actionTitle: { fontSize: 12, paddingHorizontal: 18, paddingBottom: 8 },
  actionRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  actionIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  actionIconText: { fontSize: 18 },
  actionLabel: { fontSize: 15, fontWeight: '500' },
  actionHint: { fontSize: 11, marginTop: 2 },
  actionCancel: { alignItems: 'center', paddingVertical: 14 },
  actionCancelText: { fontSize: 14 },
});
