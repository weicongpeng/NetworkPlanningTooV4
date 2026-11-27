import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, Modal, Alert, Image, ActivityIndicator,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';

import AuthGuard from '../../src/components/Auth/AuthGuard';
import { useImColors } from '../../src/components/Im/colors';
import { useImStore } from '../../src/store/imStore';
import { useMapStore } from '../../src/store/mapStore';
import { avatarUri, imDisplayName, type ImGroup, type ImUser } from '../../src/types/im';
import { navigateToTab } from '../../src/utils/navigation';

export default function ContactsScreen({ embedded = false }: { embedded?: boolean }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const colors = useImColors();
  const darkMode = useMapStore((s) => s.darkMode);
  const contacts = useImStore((s) => s.contacts);
  const conversations = useImStore((s) => s.conversations);
  const error = useImStore((s) => s.error);
  const sessionExpired = useImStore((s) => s.sessionExpired);
  const loadContacts = useImStore((s) => s.loadContacts);
  const refreshConversations = useImStore((s) => s.refreshConversations);
  const openDirect = useImStore((s) => s.openDirect);
  const createGroup = useImStore((s) => s.createGroup);
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [pendingUserId, setPendingUserId] = useState<number | null>(null);

  useFocusEffect(useCallback(() => {
    void loadContacts();
  }, [loadContacts]));

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const users = (contacts?.users || []).filter((u) => !keyword
      || u.username.toLowerCase().includes(keyword)
      || (u.nickname || '').toLowerCase().includes(keyword)
      || `${u.city || ''}${u.operator || ''}`.includes(keyword));
    const groups = (contacts?.groups || []).filter((g) => g.joined
      && (!keyword || (g.name || '').toLowerCase().includes(keyword)));
    return {
      online: users.filter((u) => u.is_online),
      offline: users.filter((u) => !u.is_online),
      groups,
    };
  }, [contacts, query]);

  const startChat = async (userId: number, title: string) => {
    // 已有单聊直接跳转，零网络请求；这是「点人很慢」的主要来源
    const existing = conversations.find((c) => c.kind === 'direct' && c.other_user?.id === userId);
    if (existing) {
      navigation.navigate('Chat', { conversationId: existing.id, title });
      return;
    }
    setPendingUserId(userId);
    try {
      const id = await openDirect(userId);
      if (id) navigation.navigate('Chat', { conversationId: id, title });
      else Alert.alert('提示', '无法创建会话，请稍后重试');
    } finally {
      setPendingUserId(null);
    }
  };

  const openGroup = (group: ImGroup) => {
    void refreshConversations();
    navigation.navigate('Chat', { conversationId: group.id, title: group.name || '群聊' });
  };

  const submitGroup = async () => {
    if (!groupName.trim()) { Alert.alert('提示', '请输入群名称'); return; }
    if (selected.length === 0) { Alert.alert('提示', '请至少选择一位成员'); return; }
    const id = await createGroup(groupName.trim(), selected);
    setShowCreate(false);
    setGroupName('');
    setSelected([]);
    if (id) navigation.navigate('Chat', { conversationId: id, title: groupName.trim() });
    else Alert.alert('提示', '创建群聊失败，请稍后重试');
  };

  const toggleSelected = (id: number) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  };

  const renderUser = (user: ImUser) => {
    const avatar = avatarUri(user.avatar);
    return (
      <TouchableOpacity
        key={user.id}
        style={[styles.row, { backgroundColor: colors.card }]}
        onPress={() => void startChat(user.id, imDisplayName(user))}
        activeOpacity={0.65}
      >
        {avatar ? <Image source={{ uri: avatar }} style={styles.avatar} /> : (
          <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: colors.avatarBg }]}>
            <Text style={[styles.avatarText, { color: colors.accent }]}>{imDisplayName(user).slice(0, 1)}</Text>
          </View>
        )}
        <View style={styles.userInfo}>
          <Text style={[styles.name, { color: colors.textPrimary }]}>{imDisplayName(user)}</Text>
          <Text style={[styles.sub, { color: colors.textMuted }]}>
            {[user.city, user.operator].filter(Boolean).join(' · ') || user.username}
          </Text>
        </View>
        {pendingUserId === user.id
          ? <ActivityIndicator size="small" color={colors.accent} />
          : <View style={[styles.statusDot, { backgroundColor: user.is_online ? colors.success : colors.textMuted }]} />}
      </TouchableOpacity>
    );
  };

  return (
    <AuthGuard>
      <View style={[styles.container, { paddingTop: embedded ? 0 : insets.top, backgroundColor: colors.bg }]}>
        {!embedded && <StatusBar style={darkMode ? 'light' : 'dark'} />}
        <View style={styles.searchRow}>
          <View style={[styles.searchWrap, { backgroundColor: colors.inputBg }]}>
            <TextInput
              style={[styles.search, { color: colors.textPrimary }]}
              placeholder="搜索联系人或群聊"
              placeholderTextColor={colors.textMuted}
              value={query}
              onChangeText={setQuery}
            />
          </View>
          <TouchableOpacity
            style={[styles.addBtn, { backgroundColor: colors.inputBg }]}
            onPress={() => setShowCreate(true)}
            activeOpacity={0.7}
          >
            <Text style={[styles.add, { color: colors.accent }]}>＋</Text>
          </TouchableOpacity>
        </View>
        {sessionExpired ? (
          <TouchableOpacity onPress={() => navigateToTab(navigation, 'profile')}>
            <Text style={[styles.error, { color: colors.danger }]}>{sessionExpired} · 点击前往登录</Text>
          </TouchableOpacity>
        ) : error ? (
          <Text style={[styles.error, { color: colors.danger }]} numberOfLines={2}>{error}</Text>
        ) : null}

        <FlatList
          data={[
            { key: 'online', title: `在线 · ${filtered.online.length}`, users: filtered.online },
            { key: 'offline', title: `离线 · ${filtered.offline.length}`, users: filtered.offline },
          ]}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => (
            <View>
              <Text style={[styles.section, { color: colors.textMuted }]}>{item.title}</Text>
              {item.users.length === 0 ? (
                <Text style={[styles.sectionEmpty, { color: colors.textMuted }]}>暂无联系人</Text>
              ) : item.users.map(renderUser)}
            </View>
          )}
          ListFooterComponent={(
            <View>
              <Text style={[styles.section, { color: colors.textMuted }]}>我的群聊 · {filtered.groups.length}</Text>
              {filtered.groups.length === 0 ? (
                <Text style={[styles.sectionEmpty, { color: colors.textMuted }]}>暂无群聊</Text>
              ) : filtered.groups.map((group) => (
                <TouchableOpacity
                  key={group.id}
                  style={[styles.row, { backgroundColor: colors.card }]}
                  onPress={() => openGroup(group)}
                  activeOpacity={0.65}
                >
                  <View style={[styles.avatar, styles.groupAvatar, { backgroundColor: colors.avatarBg }]}>
                    <Text style={[styles.avatarText, { color: colors.accent }]}>群</Text>
                  </View>
                  <View style={styles.userInfo}>
                    <Text style={[styles.name, { color: colors.textPrimary }]}>{group.name || '未命名群组'}</Text>
                    <Text style={[styles.sub, { color: colors.textMuted }]}>
                      {group.member_count} 人 · {group.is_auto ? '数据组群' : '自建群'}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
              <View style={{ height: 30 }} />
            </View>
          )}
        />
      </View>

      <Modal visible={showCreate} transparent animationType="slide">
        <View style={[styles.modalBg, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.modal, { backgroundColor: colors.card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>新建群聊</Text>
              <TouchableOpacity onPress={() => setShowCreate(false)}>
                <Text style={[styles.modalClose, { color: colors.accent }]}>取消</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={[styles.groupInput, { borderColor: colors.cardBorder, color: colors.textPrimary }]}
              placeholder="输入群名称"
              placeholderTextColor={colors.textMuted}
              value={groupName}
              onChangeText={setGroupName}
            />
            <FlatList
              style={styles.memberList}
              data={contacts?.users || []}
              keyExtractor={(item) => String(item.id)}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.memberRow} onPress={() => toggleSelected(item.id)}>
                  <Text style={[styles.memberName, { color: colors.textPrimary }]}>{imDisplayName(item)}</Text>
                  <Text style={[styles.check, { color: selected.includes(item.id) ? colors.accent : colors.textMuted }]}>
                    {selected.includes(item.id) ? '✓' : '○'}
                  </Text>
                </TouchableOpacity>
              )}
            />
            <TouchableOpacity style={[styles.confirm, { backgroundColor: colors.accent }]} onPress={() => void submitGroup()}>
              <Text style={styles.confirmText}>创建（{selected.length}）</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </AuthGuard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginTop: 10, gap: 8 },
  searchWrap: { flex: 1, borderRadius: 10, paddingHorizontal: 12, height: 38, justifyContent: 'center' },
  addBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  add: { fontSize: 24, lineHeight: 26 },
  search: { fontSize: 14 },
  error: { fontSize: 12, paddingHorizontal: 14, paddingTop: 6 },
  section: { fontSize: 12, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  sectionEmpty: { fontSize: 12, paddingHorizontal: 16, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E5E5E5' },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#E5E5E5' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  groupAvatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 17, fontWeight: '600' },
  userInfo: { flex: 1, marginLeft: 11 },
  name: { fontSize: 14, fontWeight: '500' },
  sub: { fontSize: 11, marginTop: 3 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  modalBg: { flex: 1, justifyContent: 'flex-end' },
  modal: { borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '85%', padding: 16 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  modalTitle: { fontSize: 17, fontWeight: '600' },
  modalClose: { fontSize: 14 },
  groupInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, height: 40, marginBottom: 8 },
  memberList: { maxHeight: 340 },
  memberRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 11 },
  memberName: { fontSize: 14 },
  check: { fontSize: 16 },
  confirm: { borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  confirmText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
