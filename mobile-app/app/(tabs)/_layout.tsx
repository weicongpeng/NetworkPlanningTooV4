import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text, View, StyleSheet, Platform, TouchableOpacity } from 'react-native';
import MapScreen from './index';
import DataScreen from './data';
import FavoritesScreen from './favorites';
import ProfileScreen from './profile';
import { useMapStore } from '../../src/store/mapStore';

const Tab = createBottomTabNavigator();

/**
 * 黑白浅色系 Tab 栏:
 * - 图标在上、文字在下
 * - 选中态：图标/文字本身变蓝 #007AFF + 字重 600（无背景色块）
 * - 未选中：中性灰 #9A9A9A
 * - 等宽分布,无装饰
 * - 图标使用纯字符符号(避免 emoji 字体不一致)
 */

/** 我的 Tab 图标：实心人体上半身剪影（头部圆 + 肩部半圆），用纯 View 渲染 */
const PersonIcon = ({ color, size = 22 }: { color: string; size?: number }) => {
  const headSize = size * 0.42;        // 头部直径
  const headTop = size * 0.05;         // 头部到顶部留白
  const bodyWidth = size * 0.85;       // 肩部宽度
  const bodyHeight = size * 0.45;      // 肩部高度
  const bodyGap = size * 0.04;         // 头肩间距
  return (
    <View style={{ width: size, height: size, alignItems: 'center' }}>
      {/* 头部：实心圆 */}
      <View
        style={{
          width: headSize,
          height: headSize,
          borderRadius: headSize / 2,
          backgroundColor: color,
          marginTop: headTop,
        }}
      />
      {/* 肩部：上半圆 + 下边齐平，模拟人体肩宽剪影 */}
      <View
        style={{
          width: bodyWidth,
          height: bodyHeight,
          borderTopLeftRadius: bodyWidth / 2,
          borderTopRightRadius: bodyWidth / 2,
          backgroundColor: color,
          marginTop: bodyGap,
        }}
      />
    </View>
  );
};

const TABS: { name: string; label: string; icon: string | ((color: string) => React.ReactNode) }[] = [
  { name: 'map', label: '地图', icon: '◉' },
  { name: 'data', label: '数据', icon: '▤' },
  { name: 'favorites', label: '收藏', icon: '★' },
  { name: 'profile', label: '我的', icon: (color) => <PersonIcon color={color} /> },
];

const ACTIVE_COLOR_LIGHT = '#007AFF';
const INACTIVE_COLOR_LIGHT = '#9A9A9A';
const ACTIVE_COLOR_DARK = '#64B5F6';
const INACTIVE_COLOR_DARK = '#777777';

function CustomTabBar({ state, navigation }: any) {
  const navUiHidden = useMapStore((s) => s.navUiHidden);
  const darkMode = useMapStore((s) => s.darkMode);
  const isMapTab = state.routes[state.index]?.name === 'map';
  const shouldHide = navUiHidden && isMapTab;

  const ACTIVE_COLOR = darkMode ? ACTIVE_COLOR_DARK : ACTIVE_COLOR_LIGHT;
  const INACTIVE_COLOR = darkMode ? INACTIVE_COLOR_DARK : INACTIVE_COLOR_LIGHT;

  return (
    <View style={[styles.tabBar, shouldHide && styles.tabBarHidden, darkMode && styles.tabBarDark]}>
      {TABS.map((tab, index) => {
        const route = state.routes[index];
        const isFocused = state.index === index;
        const color = isFocused ? ACTIVE_COLOR : INACTIVE_COLOR;
        const weight = isFocused ? '600' : '400';

        return (
          <TouchableOpacity
            key={tab.name}
            style={styles.tabItem}
            onPress={() => navigation.navigate(route.name)}
            activeOpacity={0.6}
            disabled={shouldHide}
          >
            <View style={styles.iconBox}>
              {typeof tab.icon === 'function' ? (
                tab.icon(color)
              ) : (
                <Text style={[styles.tabIcon, { color }]}>{tab.icon}</Text>
              )}
            </View>
            <Text
              style={[styles.tabLabel, { color, fontWeight: weight }]}
              numberOfLines={1}
            >
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tab.Navigator
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="map" component={MapScreen} />
      <Tab.Screen name="data" component={DataScreen} />
      <Tab.Screen name="favorites" component={FavoritesScreen} />
      <Tab.Screen name="profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    flexDirection: 'row',
    height: 58,
    backgroundColor: '#FFFFFF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5E5',
    paddingBottom: Platform.OS === 'ios' ? 6 : 4,
    paddingTop: 6,
    elevation: 0,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
  },
  tabBarHidden: {
    opacity: 0,
    transform: [{ translateY: 20 }],
    pointerEvents: 'none',
    height: 0,
    overflow: 'hidden',
  },
  tabBarDark: {
    backgroundColor: '#36363A',
    borderTopColor: '#4A4A50',
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
  },
  iconBox: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 3,
  },
  tabIcon: {
    fontSize: 22,
    lineHeight: 26,
  },
  tabLabel: {
    fontSize: 11,
    letterSpacing: 0.2,
  },
});
