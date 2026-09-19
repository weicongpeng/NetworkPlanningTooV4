/**
 * AuthGuard —— 未登录守卫组件
 *
 * 行为：
 *   - 已登录：透传 children，不渲染任何东西
 *   - 未登录：children 仍渲染（可预览），但上方覆盖半透明遮罩 + 居中"前往登录"按钮
 *   - 按钮点击通过 navigation.navigate('profile') 切到"我的" Tab
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useMapStore } from '../../store/mapStore';

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const isLoggedIn = useMapStore((s) => s.isLoggedIn);
  const navigation = useNavigation<any>();

  if (isLoggedIn) return <>{children}</>;

  return (
    <View style={styles.wrapper}>
      {children}
      <View style={styles.overlay} pointerEvents="auto">
        <TouchableOpacity
          style={styles.button}
          activeOpacity={0.85}
          onPress={() => navigation.navigate('profile')}
        >
          <Text style={styles.buttonText}>前往登录</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(245, 245, 245, 0.78)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: {
    backgroundColor: '#007AFF',
    paddingVertical: 12, paddingHorizontal: 40,
    borderRadius: 8, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12, shadowRadius: 6,
    elevation: 4,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
