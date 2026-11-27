import { registerRootComponent } from 'expo';
import React, { useEffect } from 'react';
import { Alert, AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import Constants from 'expo-constants';
import AppNavigator from './app/navigation/AppNavigator';
import { useRestoreAuth } from './src/hooks/useRestoreAuth';
import { useHeartbeat } from './src/hooks/useHeartbeat';
import { apiService } from './src/services/api';
import { downloadAndInstall } from './src/services/downloadService';
import { setUnauthorizedHandler } from './src/services/sessionEvents';
import { invalidateSession } from './src/services/sessionGuard';
import { useImStore } from './src/store/imStore';

function App() {
  // APP 启动时从 AsyncStorage 恢复登录状态，确保 AuthGuard 在所有页面正确判断
  useRestoreAuth();
  // 心跳放在根组件常驻，避免 Tab 懒加载导致 profile 未挂载、会话空闲超时
  useHeartbeat();

  // 任意带 token 的请求返回 401：统一清理本地登录态，不再让页面停在「假登录」
  useEffect(() => {
    setUnauthorizedHandler((message) => { void invalidateSession(message); });
    return () => setUnauthorizedHandler(null);
  }, []);

  // 前后台切换：前台补拉 IM 增量，后台停掉轮询省电
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      useImStore.getState().setAppActive(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  // APP 启动时检查新版本（静默失败不阻塞启动）
  useEffect(() => {
    (async () => {
      try {
        const latest = await apiService.checkAppVersion();
        if (!latest || !latest.version) return;

        const currentAppVersion = Constants.expoConfig?.version || '2.0.0';

        // 比较版本号
        const isNewer = (server: string, current: string): boolean => {
          try {
            const sp = server.split('.').map(Number);
            const cp = current.split('.').map(Number);
            for (let i = 0; i < Math.max(sp.length, cp.length); i++) {
              const sv = sp[i] || 0;
              const cv = cp[i] || 0;
              if (sv !== cv) return sv > cv;
            }
            return false;
          } catch {
            return server !== current;
          }
        };

        if (isNewer(latest.version, currentAppVersion)) {
          // 构建完整下载 URL
          const baseUrl = await apiService.getCurrentBaseUrl();
          const downloadUrl = latest.download_url?.startsWith('http')
            ? latest.download_url
            : `${baseUrl.replace(/\/api\/v1\/?$/, '')}${latest.download_url || ''}`;

          Alert.alert(
            '发现新版本',
            `最新版本: V${latest.version}${latest.file_size_display ? ` (${latest.file_size_display})` : ''}\n\n` +
            (latest.changelog ? `更新说明:\n${latest.changelog}\n\n` : '') +
            '是否立即下载更新？',
            [
              { text: '稍后再说', style: 'cancel' },
              {
                text: '立即下载',
                onPress: () => {
                  if (downloadUrl) {
                    // 应用内下载（Tailscale 直连优先，绕过 CF Tunnel 限速）
                    // 启动时静默下载，无进度 UI；下载完成自动调起安装器
                    downloadAndInstall(downloadUrl, baseUrl).catch(() => {
                      // downloadAndInstall 内部已处理所有兜底弹窗
                    });
                  }
                },
              },
            ]
          );
        }
      } catch {
        // 版本检查失败不影响正常使用
      }
    })();
  }, []);

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <AppNavigator />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

registerRootComponent(App);
