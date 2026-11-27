/** 通讯：消息 / 通讯录 两栏，默认展示消息。 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import MessagesScreen from './messages';
import ContactsScreen from './contacts';
import { useMapStore } from '../../src/store/mapStore';
import { useImStore } from '../../src/store/imStore';

type Channel = 'messages' | 'contacts';

export default function CommunicationScreen() {
  const [channel, setChannel] = useState<Channel>('messages');
  const insets = useSafeAreaInsets();
  const darkMode = useMapStore((s) => s.darkMode);
  const unread = useImStore((s) => s.conversations.reduce(
    (sum, conv) => sum + (conv.muted ? 0 : (conv.unread || 0)), 0,
  ));
  const colors = darkMode
    ? { bg: '#2B2B2F', card: '#36363A', text: '#E8E6E3', muted: '#8A8880', accent: '#7EB6F6', badge: '#F07070' }
    : { bg: '#f5f5f5', card: '#FFFFFF', text: '#1A1A1A', muted: '#999999', accent: '#007AFF', badge: '#FF3B30' };

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.bg }]}>
      <StatusBar style={darkMode ? 'light' : 'dark'} />
      <View style={[styles.switcher, { backgroundColor: colors.card }]}>
        {([
          { key: 'messages', label: '消息' },
          { key: 'contacts', label: '通讯录' },
        ] as Array<{ key: Channel; label: string }>).map((item) => (
          <TouchableOpacity
            key={item.key}
            style={[styles.switchItem, channel === item.key && { borderBottomColor: colors.accent }]}
            onPress={() => setChannel(item.key)}
            activeOpacity={0.7}
          >
            <Text style={[styles.switchLabel, { color: channel === item.key ? colors.accent : colors.muted }]}>
              {item.label}
              {item.key === 'messages' && unread > 0 ? ` · ${unread > 99 ? '99+' : unread}` : ''}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.content}>
        {channel === 'messages' ? <MessagesScreen embedded /> : <ContactsScreen embedded />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  switcher: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E5E5E5' },
  switchItem: { flex: 1, alignItems: 'center', paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  switchLabel: { fontSize: 15, fontWeight: '600' },
  content: { flex: 1 },
});
