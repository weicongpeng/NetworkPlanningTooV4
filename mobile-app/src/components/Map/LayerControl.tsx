import React, { forwardRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';

interface Props {
  active?: boolean;
  onPress?: () => void;
}

const LayerControl = forwardRef<View, Props>(({ active, onPress }, ref) => {
  return (
    <View ref={ref} collapsable={false}>
      <TouchableOpacity
        style={[styles.btn, active && styles.btnActive]}
        onPress={onPress}
        activeOpacity={0.8}
      >
        <Text style={[styles.btnText, active && styles.btnTextActive]}>图层</Text>
      </TouchableOpacity>
    </View>
  );
});

const styles = StyleSheet.create({
  btn: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  btnActive: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  btnText: {
    fontSize: 12,
    color: '#333',
  },
  btnTextActive: {
    color: '#fff',
  },
});

export default LayerControl;
