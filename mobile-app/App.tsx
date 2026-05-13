import { registerRootComponent } from 'expo';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import TabsLayout from './app/(tabs)/_layout';

function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <TabsLayout />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

registerRootComponent(App);
