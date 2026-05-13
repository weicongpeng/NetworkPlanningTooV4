import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text, View, StyleSheet, Platform, TouchableOpacity, Animated } from 'react-native';
import MapScreen from './index';
import DataScreen from './data';
import FavoritesScreen from './favorites';
import SettingsScreen from './settings';
import { useMapStore } from '../../src/store/mapStore';

const Tab = createBottomTabNavigator();
const BOTTOM_PADDING = Platform.OS === 'ios' ? 8 : 0;

function CustomTabBar({ state, descriptors, navigation }: any) {
  const navUiHidden = useMapStore((s) => s.navUiHidden);
  const isMapTab = state.routes[state.index]?.name === 'map';
  const shouldHide = navUiHidden && isMapTab;

  const tabs = [
    { name: 'map', label: '地图', icon: '🗺️' },
    { name: 'data', label: '数据', icon: '📊' },
    { name: 'favorites', label: '收藏', icon: '⭐' },
    { name: 'settings', label: '设置', icon: '⚙️' },
  ];

  return (
    <View style={[styles.tabBar, shouldHide && styles.tabBarHidden]}>
      {tabs.map((tab, index) => {
        const route = state.routes[index];
        const isFocused = state.index === index;

        return (
          <TouchableOpacity
            key={tab.name}
            style={styles.tabItem}
            onPress={() => navigation.navigate(route.name)}
            activeOpacity={1}
            pointerEvents={shouldHide ? 'none' : 'auto'}
          >
            <Text style={[styles.tabIcon, isFocused && styles.tabIconActive]}>{tab.icon}</Text>
            <Text style={[styles.tabLabel, isFocused && styles.tabLabelActive]} numberOfLines={1}>{tab.label}</Text>
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
      screenOptions={{
        headerShown: false,
      }}
    >
      <Tab.Screen name="map" component={MapScreen} />
      <Tab.Screen name="data" component={DataScreen} />
      <Tab.Screen name="favorites" component={FavoritesScreen} />
      <Tab.Screen name="settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    flexDirection: 'row',
    height: 52,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    paddingBottom: BOTTOM_PADDING,
    paddingTop: 6,
    elevation: 8,
    transitionProperty: 'opacity, transform',
    transitionDuration: 200,
  },
  tabBarHidden: {
    opacity: 0,
    transform: [{ translateY: 20 }],
    pointerEvents: 'none',
    height: 0,
    overflow: 'hidden',
  },
  tabItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    paddingHorizontal: 0,
    minWidth: 0,
  },
  tabIcon: {
    fontSize: 17,
    marginRight: 2,
  },
  tabIconActive: {
    fontSize: 18,
  },
  tabLabel: {
    fontSize: 12,
    color: '#333',
    flexShrink: 1,
  },
  tabLabelActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
});
