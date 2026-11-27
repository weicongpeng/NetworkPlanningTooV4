import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Modal, Alert, ActivityIndicator,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';

import { useImColors } from '../../src/components/Im/colors';
import { useImStore } from '../../src/store/imStore';
import { useMapStore } from '../../src/store/mapStore';
import { imApi } from '../../src/services/imApi';
import { imDisplayName, isAdminRole, type ImMember } from '../../src/types/im';

export default function GroupInfoScreen({ route, navigation }: any) {
  const conversationId: number = Number(route.params?.conversationId);
  const insets = useSafeAreaInsets();
  const colors = useImColors();
  const darkMode = useMapStore((s) => s.darkMode);
  const conv = useImStore((s) => s.conversations.find((c) => c.id === conversationId));
  const contacts = useImStore((s) => s.contacts);
  const addMembers = useImStore((s) => s.addMembers);
  const removeMember = useImStore((s) => s.removeMember);
  const leaveGroup = useImStore((s) => s.leaveGroup);
  const dissolveGroup = useImStore((s) => s.dissolveGroup);

  const [members, setMembers] = useState<ImMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try { setMembers(await imApi.members(conversationId)); }
    catch { setMembers([]); }
    finally { setLoading(false); }
  }, [conversationId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const candidates = useMemo(() => {
    const existing = new Set(members.map((m) => m.id));
    return (contacts?.users || []).filter((u) => !existing.has(u.id));
  }, [contacts, members]);

  const isAdmin = isAdminRole(conv?.my_role);

  const confirm = (title: string, message: string, action: () => Promise<void>) => {
    Alert.alert(title, message, [
      { text: '取消', style: 'cancel' },
      {
        text: '确定', style: 'destructive',
        onPress: () => {
          void action().then(() => navigation.goBack()).catch((e) => {
            Alert.alert('提示', e instanceof Error ? e.message : '操作失败');
          });
        },
      },
    ]);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.bg }]}>
      <StatusBar style={darkMode ? 'light' : 'dark'} />
      <View style={[styles.header, { borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={[styles.backText, { color: colors.accent }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.textPrimary }]}>群资料</Text>
        <View style={styles.back} />
      </View>

      {loading ? <ActivityIndicator color={colors.accent} style={styles.loading} /> : (
        <FlatList
          data={members}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <View style={[styles.row, { backgroundColor: colors.card }]}>
              <View style={[styles.avatar, { backgroundColor: colors.avatarBg }]}>
                <Text style={[styles.avatarText, { color: colors.accent }]}>{imDisplayName(item).slice(0, 1)}</Text>
              </View>
              <View style={styles.info}>
                <Text style={[styles.name, { color: colors.textPrimary }]}>{imDisplayName(item)}</Text>
                <Text style={[styles.sub, { color: colors.textMuted }]}>
                  {item.role === 'owner' ? '群主' : item.role === 'admin' ? '管理员' : '成员'}
                  {item.is_online ? ' · 在线' : ''}
                </Text>
              </View>
              {isAdmin && item.role !== 'owner' && (
                <TouchableOpacity
                  onPress={() => confirm('移除成员', `确定将 ${imDisplayName(item)} 移出群聊？`,
                    () => removeMember(conversationId, item.id))}
                >
                  <Text style={[styles.action, { color: colors.danger }]}>移除</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
          ListHeaderComponent={(
            <View style={[styles.summary, { backgroundColor: colors.card }]}>
              <Text style={[styles.summaryTitle, { color: colors.textPrimary }]}>{conv?.name || '群聊'}</Text>
              <Text style={[styles.summarySub, { color: colors.textMuted }]}>{members.length} 位成员</Text>
            </View>
          )}
        />
      )}

      <View style={[styles.footer, { borderColor: colors.cardBorder }]}>
        {isAdmin && (
          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.accent }]} onPress={() => setShowAdd(true)}>
            <Text style={styles.btnText}>添加成员</Text>
          </TouchableOpacity>
        )}
        {conv?.kind === 'custom_group' && (
          isAdmin ? (
            <TouchableOpacity
              style={[styles.btn, { borderColor: colors.danger }]}
              onPress={() => confirm('解散群聊', '解散后所有成员将无法继续查看该群消息。',
                () => dissolveGroup(conversationId))}
            >
              <Text style={[styles.btnDanger, { color: colors.danger }]}>解散群聊</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.btn, { borderColor: colors.danger }]}
              onPress={() => confirm('退出群聊', '确定要退出该群聊？', () => leaveGroup(conversationId))}
            >
              <Text style={[styles.btnDanger, { color: colors.danger }]}>退出群聊</Text>
            </TouchableOpacity>
          )
        )}
      </View>

      <Modal visible={showAdd} transparent animationType="slide">
        <View style={[styles.modalBg, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.modal, { backgroundColor: colors.card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>添加成员</Text>
              <TouchableOpacity onPress={() => setShowAdd(false)}>
                <Text style={[styles.modalClose, { color: colors.accent }]}>取消</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              style={styles.memberList}
              data={candidates}
              keyExtractor={(item) => String(item.id)}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.memberRow}
                  onPress={() => setSelected((prev) => (
                    prev.includes(item.id) ? prev.filter((v) => v !== item.id) : [...prev, item.id]
                  ))}
                >
                  <Text style={[styles.memberName, { color: colors.textPrimary }]}>{imDisplayName(item)}</Text>
                  <Text style={[styles.check, { color: selected.includes(item.id) ? colors.accent : colors.textMuted }]}>
                    {selected.includes(item.id) ? '✓' : '○'}
                  </Text>
                </TouchableOpacity>
              )}
            />
            <TouchableOpacity
              style={[styles.confirm, { backgroundColor: colors.accent }]}
              onPress={() => {
                if (!selected.length) { Alert.alert('提示', '请选择成员'); return; }
                void addMembers(conversationId, selected)
                  .then(() => { setShowAdd(false); setSelected([]); return load(); })
                  .catch((e) => Alert.alert('提示', e instanceof Error ? e.message : '添加失败'));
              }}
            >
              <Text style={styles.confirmText}>确定（{selected.length}）</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { width: 34 },
  backText: { fontSize: 32, lineHeight: 30 },
  title: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600' },
  loading: { marginTop: 40 },
  summary: { padding: 16, alignItems: 'center', marginBottom: 8 },
  summaryTitle: { fontSize: 17, fontWeight: '600' },
  summarySub: { fontSize: 12, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E5E5E5' },
  avatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 16, fontWeight: '600' },
  info: { flex: 1, marginLeft: 10 },
  name: { fontSize: 14 },
  sub: { fontSize: 11, marginTop: 3 },
  action: { fontSize: 13 },
  footer: { flexDirection: 'row', gap: 10, borderTopWidth: StyleSheet.hairlineWidth, padding: 12 },
  btn: { flex: 1, borderRadius: 8, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: 'transparent' },
  btnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  btnDanger: { fontSize: 14 },
  modalBg: { flex: 1, justifyContent: 'flex-end' },
  modal: { borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '80%', padding: 16 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  modalTitle: { fontSize: 17, fontWeight: '600' },
  modalClose: { fontSize: 14 },
  memberList: { maxHeight: 360 },
  memberRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 11 },
  memberName: { fontSize: 14 },
  check: { fontSize: 16 },
  confirm: { borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginTop: 8 },
  confirmText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
});
