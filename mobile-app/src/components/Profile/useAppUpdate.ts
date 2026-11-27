/** 「我的」页的版本检查与 APK 下载状态；逻辑与 UI 解耦，供弹层直接消费。 */
import { useState, useCallback } from 'react';
import { Alert } from 'react-native';
import Constants from 'expo-constants';

import { apiService } from '../../services/api';
import { downloadApk, installApk, DownloadProgressInfo } from '../../services/downloadService';

export type DownloadPhase = 'idle' | 'downloading' | 'installing' | 'done' | 'error';

export function useAppUpdate() {
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [downloadModalVisible, setDownloadModalVisible] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [downloadPhase, setDownloadPhase] = useState<DownloadPhase>('idle');

  const handleCheckUpdate = useCallback(async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const latest = await apiService.checkAppVersion();
      if (!latest || !latest.version) {
        Alert.alert('检查失败', '无法获取版本信息，请检查网络或后端地址');
        return;
      }
      const currentVersion = Constants.expoConfig?.version || '2.0.0';
      const isNewer = (server: string, current: string): boolean => {
        try {
          const sp = server.split('.').map(Number);
          const cp = current.split('.').map(Number);
          for (let i = 0; i < Math.max(sp.length, cp.length); i += 1) {
            const sv = sp[i] || 0;
            const cv = cp[i] || 0;
            if (sv !== cv) return sv > cv;
          }
          return false;
        } catch {
          return server !== current;
        }
      };
      if (!isNewer(latest.version, currentVersion)) {
        Alert.alert('已是最新版本', `当前版本 V${currentVersion}`);
        return;
      }
      const baseUrl = await apiService.getCurrentBaseUrl();
      const downloadUrl = latest.download_url?.startsWith('http')
        ? latest.download_url
        : `${baseUrl.replace(/\/api\/v1\/?$/, '')}${latest.download_url || ''}`;
      if (!downloadUrl) {
        Alert.alert('错误', '未获取到下载地址');
        return;
      }
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
              setDownloadPercent(0);
              setDownloadedBytes(0);
              setTotalBytes(0);
              setDownloadPhase('downloading');
              setDownloadModalVisible(true);
              downloadApk(downloadUrl, baseUrl, (info: DownloadProgressInfo) => {
                setDownloadPercent(info.percent);
                setDownloadedBytes(info.downloadedBytes);
                setTotalBytes(info.totalBytes);
              })
                .then(async (result) => {
                  if (result.ok) {
                    setDownloadPhase('installing');
                    try {
                      await installApk(result.uri);
                      setDownloadPhase('done');
                    } catch (e: any) {
                      setDownloadPhase('error');
                      Alert.alert('安装失败', 'APK 已下载但无法直接安装。\n\n' + (e?.message || ''), [{ text: '知道了' }]);
                    }
                  } else {
                    setDownloadPhase('error');
                    Alert.alert(
                      '下载失败',
                      '是否使用浏览器下载？\n\n' + (result as any).error,
                      [
                        { text: '取消', style: 'cancel' },
                        {
                          text: '浏览器下载',
                          onPress: () => {
                            const { Linking } = require('react-native');
                            Linking.openURL(downloadUrl).catch(() => {});
                          },
                        },
                      ],
                    );
                  }
                })
                .catch((e) => {
                  setDownloadPhase('error');
                  Alert.alert('下载失败', e?.message || '未知错误');
                });
            },
          },
        ],
      );
    } catch (e: any) {
      Alert.alert('检查失败', e?.message || '未知错误');
    } finally {
      setCheckingUpdate(false);
    }
  }, [checkingUpdate]);

  return {
    checkingUpdate,
    downloadModalVisible,
    setDownloadModalVisible,
    downloadPercent,
    downloadedBytes,
    totalBytes,
    downloadPhase,
    handleCheckUpdate,
  };
}
