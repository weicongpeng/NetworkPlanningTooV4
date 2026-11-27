import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';

import { imDisplayName, type ImMember } from '../../types/im';
import type { ImColors } from './colors';

interface Props {
  members: ImMember[]
  colors: ImColors
  canMentionAll: boolean
  onSelect: (member: ImMember | null) => void
}

export default function MentionPicker({ members, colors, canMentionAll, onSelect }: Props) {
  return (
    <View style={[styles.wrap, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {canMentionAll && (
          <TouchableOpacity style={[styles.chip, { backgroundColor: colors.inputBg }]} onPress={() => onSelect(null)}>
            <Text style={[styles.chipText, { color: colors.accent }]}>@所有人</Text>
          </TouchableOpacity>
        )}
        {members.map((member) => (
          <TouchableOpacity
            key={member.id}
            style={[styles.chip, { backgroundColor: colors.inputBg }]}
            onPress={() => onSelect(member)}
          >
            <Text style={[styles.chipText, { color: colors.textPrimary }]} numberOfLines={1}>
              @{imDisplayName(member)}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 7 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, marginRight: 6, maxWidth: 130 },
  chipText: { fontSize: 13 },
});
