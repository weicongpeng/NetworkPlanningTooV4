import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text, View, StyleSheet, Platform, TouchableOpacity } from 'react-native';
import MapScreen from './index';
import CommunicationScreen from './communication';
import ProfileScreen from './profile';
import { useMapStore } from '../../src/store/mapStore';
import { useImStore } from '../../src/store/imStore';

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

/** 通讯 Tab 图标：主流消息气泡 + 三个省略点 */
const ChatBubbleIcon = ({ color, bg, size = 24 }: { color: string; bg: string; size?: number }) => (
  <View style={{ width: size, height: size }}>
    <View style={{
      position: 'absolute', left: size * 0.04, top: size * 0.08,
      width: size * 0.92, height: size * 0.7,
      borderRadius: size * 0.3, backgroundColor: color,
      alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: size * 0.11,
    }}>
      <View style={{ width: size * 0.1, height: size * 0.1, borderRadius: size * 0.05, backgroundColor: bg }} />
      <View style={{ width: size * 0.1, height: size * 0.1, borderRadius: size * 0.05, backgroundColor: bg }} />
      <View style={{ width: size * 0.1, height: size * 0.1, borderRadius: size * 0.05, backgroundColor: bg }} />
    </View>
    <View style={{
      position: 'absolute', left: size * 0.12, top: size * 0.6,
      width: 0, height: 0,
      borderLeftWidth: size * 0.09, borderLeftColor: 'transparent',
      borderTopWidth: size * 0.17, borderTopColor: color,
      transform: [{ rotate: '-20deg' }],
    }} />
  </View>
);

/** 地图 Tab 图标：主流定位图钉（水滴形 + 中心镂空） */
const MapPinIcon = ({ color, bg, size = 24 }: { color: string; bg: string; size?: number }) => (
  <View style={{ width: size, height: size }}>
    <View style={{
      position: 'absolute', left: size * 0.17, top: 0,
      width: size * 0.66, height: size * 0.66,
      borderRadius: size * 0.33, backgroundColor: color,
      alignItems: 'center', justifyContent: 'center',
    }}>
      <View style={{ width: size * 0.24, height: size * 0.24, borderRadius: size * 0.12, backgroundColor: bg }} />
    </View>
    <View style={{
      position: 'absolute', left: size * 0.31, top: size * 0.48,
      width: 0, height: 0,
      borderLeftWidth: size * 0.19, borderLeftColor: 'transparent',
      borderRightWidth: size * 0.19, borderRightColor: 'transparent',
      borderTopWidth: size * 0.4, borderTopColor: color,
    }} />
  </View>
);

const TABS: { name: string; label: string; icon: string | ((color: string, bg: string) => React.ReactNode) }[] = [
  { name: 'map', label: '地图', icon: (color, bg) => <MapPinIcon color={color} bg={bg} /> },
  { name: 'communication', label: '通讯', icon: (color, bg) => <ChatBubbleIcon color={color} bg={bg} /> },
  { name: 'profile', label: '我的', icon: (color) => <PersonIcon color={color} /> },
];

const TAB_BG_LIGHT = '#FFFFFF';
const TAB_BG_DARK = '#36363A';
const ACTIVE_COLOR_LIGHT = '#007AFF';
const INACTIVE_COLOR_LIGHT = '#9A9A9A';
const ACTIVE_COLOR_DARK = '#64B5F6';
const INACTIVE_COLOR_DARK = '#777777';

function CustomTabBar({ state, navigation }: any) {
  const navUiHidden = useMapStore((s) => s.navUiHidden);
  const darkMode = useMapStore((s) => s.darkMode);
  const unread = useImStore((s) => s.conversations.reduce(
    (sum, conv) => sum + (conv.muted ? 0 : (conv.unread || 0)), 0,
  ));
  const isMapTab = state.routes[state.index]?.name === 'map';
  const shouldHide = navUiHidden && isMapTab;

  const ACTIVE_COLOR = darkMode ? ACTIVE_COLOR_DARK : ACTIVE_COLOR_LIGHT;
  const INACTIVE_COLOR = darkMode ? INACTIVE_COLOR_DARK : INACTIVE_COLOR_LIGHT;
  const TAB_BG = darkMode ? TAB_BG_DARK : TAB_BG_LIGHT;

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
                tab.icon(color, TAB_BG)
              ) : (
                <Text style={[styles.tabIcon, { color }]}>{tab.icon}</Text>
              )}
              {tab.name === 'communication' && unread > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text>
                </View>
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
      <Tab.Screen name="communication" component={CommunicationScreen} />
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
  badge: {
    position: 'absolute',
    top: -4,
    right: -9,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#FF3B30',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '600',
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
