import React, { forwardRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useMapStore } from '../../store/mapStore';

interface Props {
  active?: boolean;
  onPress?: () => void;
}

const LIGHT_COLORS = {
  bg: 'rgba(255,255,255,0.95)',
  border: '#E5E5E5',
  text: '#1A1A1A',
  activeBg: '#2563EB',
  activeBorder: '#1D4ED8',
  activeText: '#fff',
} as const;

const DARK_COLORS = {
  bg: 'rgba(54,54,58,0.95)',
  border: '#4A4A50',
  text: '#E8E6E3',
  activeBg: '#3B5998',
  activeBorder: '#2D4373',
  activeText: '#fff',
} as const;

const LayerControl = forwardRef<View, Props>(({ active, onPress }, ref) => {
  const darkMode = useMapStore((s) => s.darkMode);
  const COLORS = darkMode ? DARK_COLORS : LIGHT_COLORS;
  return (
    <View ref={ref} collapsable={false}>
      <TouchableOpacity
        style={[
          styles.btn,
          { backgroundColor: COLORS.bg, borderColor: COLORS.border },
          active && { backgroundColor: COLORS.activeBg, borderColor: COLORS.activeBorder },
        ]}
        onPress={onPress}
        activeOpacity={0.8}
      >
        <Text style={[styles.btnText, { color: COLORS.text }, active && { color: COLORS.activeText }]}>图层</Text>
      </TouchableOpacity>
    </View>
  );
});

const styles = StyleSheet.create({
  btn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 1,
    minWidth: 56,
    alignItems: 'center',
  },
  btnText: {
    fontSize: 12,
    fontWeight: '500',
  },
});

export default LayerControl;
