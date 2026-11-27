/** 我的资料：头像（拍照/相册/恢复默认）与协作沟通昵称，复用 /im/avatar、/im/nickname 与 PC 同步。 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, Modal, TouchableOpacity, Image, ActivityIndicator, Alert, StyleSheet,
} from 'react-native';

import { imApi } from '../../services/imApi';
import { pickFromCamera, pickFromLibrary, readAsAvatarDataUrl } from '../../services/imAttachment';
import { useImStore } from '../../store/imStore';
import type { AuthUser } from '../../services/auth';
import type { AppColors } from './ProfileUi';

export interface ProfilePatch {
  avatar?: string | null
  nickname?: string | null
}

interface Props {
  visible: boolean
  colors: AppColors
  styles: any
  user: AuthUser | null
  onClose: () => void
  onSaved: (patch: ProfilePatch) => void
}

export default function ProfileEditor({ visible, colors, styles, user, onClose, onSaved }: Props) {
  const [nickname, setNickname] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) setNickname(user?.nickname || '');
  }, [visible, user?.nickname]);

  const refreshImContacts = () => { void useImStore.getState().loadContacts(); };

  const setAvatar = async (source: 'camera' | 'library' | 'reset') => {
    if (saving) return;
    setSaving(true);
    try {
      if (source === 'reset') {
        const result = await imApi.updateAvatar('');
        onSaved({ avatar: result.avatar });
      } else {
        const picked = source === 'camera' ? await pickFromCamera(true) : await pickFromLibrary(true);
        if (!picked) return;
        const dataUrl = await readAsAvatarDataUrl(picked);
        const result = await imApi.updateAvatar(dataUrl);
        onSaved({ avatar: result.avatar });
      }
      refreshImContacts();
    } catch (e) {
      Alert.alert('提示', e instanceof Error ? e.message : '更新头像失败');
    } finally {
      setSaving(false);
    }
  };

  const saveNickname = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const result = await imApi.updateNickname(nickname.trim() || null);
      onSaved({ nickname: result.nickname });
      refreshImContacts();
      Alert.alert('已保存', '昵称已更新，电脑端刷新后同步显示');
    } catch (e) {
      Alert.alert('提示', e instanceof Error ? e.message : '更新昵称失败');
    } finally {
      setSaving(false);
    }
  };

  const avatarUri = user?.avatar && (user.avatar.startsWith('data:') || user.avatar.startsWith('http'))
    ? user.avatar
    : null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.modalOverlay, { backgroundColor: colors.overlayBg }]}>
        <View style={[styles.sheetModal, { maxHeight: '80%', backgroundColor: colors.card }]}>
          <View style={[styles.sheetHeader, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.sheetTitle, { color: colors.textPrimary }]}>修改资料</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={[styles.sheetClose, { color: colors.accent }]}>完成</Text>
            </TouchableOpacity>
          </View>

          <View style={localStyles.avatarRow}>
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={localStyles.avatarImage} />
            ) : (
              <View style={[localStyles.avatarImage, localStyles.avatarFallback, { backgroundColor: colors.avatarBg }]}>
                <Text style={[styles.avatarText, { color: '#fff' }]}>
                  {(user?.username || 'U').substring(0, 1).toUpperCase()}
                </Text>
              </View>
            )}
            <Text style={[localStyles.avatarTip, { color: colors.textMuted }]}>
              头像上限 256KB，支持 PNG / JPG / WEBP / GIF
            </Text>
          </View>

          <View style={localStyles.buttonRow}>
            <TouchableOpacity
              style={[localStyles.button, { backgroundColor: colors.inputBg, borderColor: colors.cardBorder }]}
              onPress={() => void setAvatar('camera')}
              disabled={saving}
            >
              <Text style={[localStyles.buttonText, { color: colors.textPrimary }]}>拍照</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[localStyles.button, { backgroundColor: colors.inputBg, borderColor: colors.cardBorder }]}
              onPress={() => void setAvatar('library')}
              disabled={saving}
            >
              <Text style={[localStyles.buttonText, { color: colors.textPrimary }]}>从相册选择</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[localStyles.button, { backgroundColor: colors.inputBg, borderColor: colors.cardBorder }]}
              onPress={() => void setAvatar('reset')}
              disabled={saving}
            >
              <Text style={[localStyles.buttonText, { color: colors.danger }]}>恢复默认</Text>
            </TouchableOpacity>
          </View>

          <Text style={[styles.sheetSection, { color: colors.textMuted, textTransform: 'none' }]}>昵称</Text>
          <View style={localStyles.nicknameRow}>
            <TextInput
              style={[localStyles.nicknameInput, {
                borderColor: colors.cardBorder, backgroundColor: colors.inputBg, color: colors.textPrimary,
              }]}
              value={nickname}
              onChangeText={setNickname}
              placeholder={`留空则显示账号名 ${user?.username || ''}`}
              placeholderTextColor={colors.textMuted}
              maxLength={24}
            />
            <TouchableOpacity
              style={[localStyles.saveBtn, { backgroundColor: colors.accent }]}
              onPress={() => void saveNickname()}
              disabled={saving}
            >
              {saving
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={localStyles.saveText}>保存</Text>}
            </TouchableOpacity>
          </View>
          <View style={{ height: 24 }} />
        </View>
      </View>
    </Modal>
  );
}

const localStyles = StyleSheet.create({
  avatarRow: { alignItems: 'center', paddingVertical: 18 },
  avatarImage: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#E5E5E5' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarTip: { fontSize: 11, marginTop: 8 },
  buttonRow: { flexDirection: 'row', justifyContent: 'center', paddingHorizontal: 12, marginBottom: 10 },
  button: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 9, alignItems: 'center', marginHorizontal: 4 },
  buttonText: { fontSize: 13 },
  nicknameRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  nicknameInput: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14 },
  saveBtn: { borderRadius: 8, paddingHorizontal: 16, paddingVertical: 11, alignItems: 'center', marginLeft: 8 },
  saveText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
});
