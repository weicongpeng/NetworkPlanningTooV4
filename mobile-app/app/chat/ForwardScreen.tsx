import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useImColors } from '../../src/components/Im/colors';
import { useImStore } from '../../src/store/imStore';
import { useMapStore } from '../../src/store/mapStore';
import { conversationTitle, messagePreview } from '../../src/types/im';

export default function ForwardScreen({ route, navigation }: any) {
  const messageIds: number[] = route.params?.messageIds || [];
  const insets = useSafeAreaInsets();
  const colors = useImColors();
  const darkMode = useMapStore((s) => s.darkMode);
  const conversations = useImStore((s) => s.conversations);
  const forward = useImStore((s) => s.forward);
  const [selected, setSelected] = useState<number[]>([]);
  const [sending, setSending] = useState(false);

  const submit = async () => {
    if (!selected.length) { Alert.alert('提示', '请选择目标会话'); return; }
    setSending(true);
    try {
      await forward(messageIds, selected);
      navigation.goBack();
    } catch {
      Alert.alert('提示', '转发失败，请稍后重试');
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.bg }]}>
      <StatusBar style={darkMode ? 'light' : 'dark'} />
      <View style={[styles.header, { borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={[styles.backText, { color: colors.accent }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.textPrimary }]}>转发 {messageIds.length} 条消息</Text>
        <TouchableOpacity onPress={() => void submit()} disabled={sending}>
          <Text style={[styles.submit, { color: colors.accent }]}>{sending ? '发送中' : '确定'}</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={conversations}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => {
          const checked = selected.includes(item.id);
          return (
            <TouchableOpacity
              style={[styles.row, { backgroundColor: colors.card }]}
              onPress={() => setSelected((prev) => (
                checked ? prev.filter((v) => v !== item.id) : [...prev, item.id]
              ))}
            >
              <View style={[styles.check, { borderColor: checked ? colors.accent : colors.textMuted, backgroundColor: checked ? colors.accent : 'transparent' }]}>
                {checked ? <Text style={styles.checkText}>✓</Text> : null}
              </View>
              <View style={styles.info}>
                <Text style={[styles.name, { color: colors.textPrimary }]}>{conversationTitle(item)}</Text>
                <Text style={[styles.preview, { color: colors.textMuted }]} numberOfLines={1}>
                  {messagePreview(item.last_message)}
                </Text>
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={<Text style={[styles.empty, { color: colors.textMuted }]}>暂无会话</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { width: 34 },
  backText: { fontSize: 32, lineHeight: 30 },
  title: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '600' },
  submit: { fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E5E5E5' },
  check: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  checkText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },
  info: { flex: 1, marginLeft: 12 },
  name: { fontSize: 14 },
  preview: { fontSize: 11, marginTop: 3 },
  empty: { textAlign: 'center', marginTop: 60 },
});
