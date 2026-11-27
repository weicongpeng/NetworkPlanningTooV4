import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';

import AuthGuard from '../../src/components/Auth/AuthGuard';
import ConversationRow from '../../src/components/Im/ConversationRow';
import { useImColors } from '../../src/components/Im/colors';
import { useImStore } from '../../src/store/imStore';
import { useMapStore } from '../../src/store/mapStore';
import { conversationTitle, messagePreview } from '../../src/types/im';
import { navigateToTab } from '../../src/utils/navigation';

export default function MessagesScreen({ embedded = false }: { embedded?: boolean }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const colors = useImColors();
  const darkMode = useMapStore((s) => s.darkMode);
  const conversations = useImStore((s) => s.conversations);
  const loading = useImStore((s) => s.loadingConversations);
  const error = useImStore((s) => s.error);
  const sessionExpired = useImStore((s) => s.sessionExpired);
  const refresh = useImStore((s) => s.refreshConversations);
  const [query, setQuery] = useState('');

  useFocusEffect(useCallback(() => {
    void refresh();
  }, [refresh]));

  const items = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return [...conversations]
      .filter((conv) => !keyword
        || conversationTitle(conv).toLowerCase().includes(keyword)
        || messagePreview(conv.last_message).toLowerCase().includes(keyword))
      .sort((a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || ''));
  }, [conversations, query]);

  return (
    <AuthGuard>
      <View style={[styles.container, { paddingTop: embedded ? 0 : insets.top, backgroundColor: colors.bg }]}>
        {!embedded && <StatusBar style={darkMode ? 'light' : 'dark'} />}
        <View style={[styles.searchWrap, { backgroundColor: colors.inputBg }]}>
          <TextInput
            style={[styles.search, { color: colors.textPrimary }]}
            placeholder="搜索会话"
            placeholderTextColor={colors.textMuted}
            value={query}
            onChangeText={setQuery}
          />
        </View>

        {sessionExpired ? (
          <TouchableOpacity onPress={() => navigateToTab(navigation, 'profile')}>
            <Text style={[styles.error, { color: colors.danger }]}>{sessionExpired} · 点击前往登录</Text>
          </TouchableOpacity>
        ) : error ? (
          <Text style={[styles.error, { color: colors.danger }]} numberOfLines={2}>{error}</Text>
        ) : null}

        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <ConversationRow
              conv={item}
              colors={colors}
              onPress={() => navigation.navigate('Chat', {
                conversationId: item.id,
                title: conversationTitle(item),
              })}
            />
          )}
          onRefresh={() => void refresh()}
          refreshing={loading}
          initialNumToRender={15}
          maxToRenderPerBatch={10}
          windowSize={7}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews
          contentContainerStyle={items.length === 0 ? styles.emptyContainer : undefined}
          ListEmptyComponent={(
            <View style={styles.empty}>
              <Text style={[styles.emptyIcon, { color: colors.textMuted }]}>✉</Text>
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>暂无会话</Text>
              <Text style={[styles.emptyHint, { color: colors.textMuted }]}>去通讯录找同事开始聊天</Text>
            </View>
          )}
        />
      </View>
    </AuthGuard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchWrap: { marginHorizontal: 12, marginTop: 10, borderRadius: 10, paddingHorizontal: 12, height: 38, justifyContent: 'center' },
  search: { fontSize: 14 },
  error: { fontSize: 12, paddingHorizontal: 14, paddingTop: 6 },
  emptyContainer: { flexGrow: 1 },
  empty: { alignItems: 'center', paddingTop: 90 },
  emptyIcon: { fontSize: 42 },
  emptyText: { fontSize: 15, marginTop: 12 },
  emptyHint: { fontSize: 12, marginTop: 6 },
});
