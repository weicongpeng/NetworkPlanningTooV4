/** 根导航：底部 Tab + 聊天/资料/转发/数据二级页。 */
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import TabsLayout from '../(tabs)/_layout';
import DataScreen from '../(tabs)/data';
import FavoritesScreen from '../(tabs)/favorites';
import ChatScreen from '../chat/ChatScreen';
import GroupInfoScreen from '../chat/GroupInfoScreen';
import ForwardScreen from '../chat/ForwardScreen';

const Stack = createNativeStackNavigator();

export default function AppNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
      <Stack.Screen name="Tabs" component={TabsLayout} />
      <Stack.Screen name="Chat" component={ChatScreen} />
      <Stack.Screen name="GroupInfo" component={GroupInfoScreen} />
      <Stack.Screen name="Forward" component={ForwardScreen} />
      <Stack.Screen name="DataCenter" component={DataScreen} />
      <Stack.Screen name="Favorites" component={FavoritesScreen} />
    </Stack.Navigator>
  );
}
