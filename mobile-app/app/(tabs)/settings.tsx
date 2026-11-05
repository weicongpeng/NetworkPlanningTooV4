import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  ScrollView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { apiService } from '../../src/services/api';

// 预设后端地址
const PRESET_URLS = {
  default: 'https://app.pengwc.asia',
  alternate: 'https://armbian.tail362392.ts.net',
} as const;

const STATUS = {
  checking: { color: '#999', label: '检测中...' },
  connected: { color: '#34C759', label: '已连接' },
  disconnected: { color: '#FF3B30', label: '未连接' },
} as const;

type StatusKey = keyof typeof STATUS;

export default function SettingsScreen() {
  const [currentUrl, setCurrentUrl] = useState('');
  const [inputUrl, setInputUrl] = useState('');
  const [status, setStatus] = useState<StatusKey>('checking');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  // 页面加载时获取当前地址并检查连接
  const refreshStatus = useCallback(async () => {
    const url = await apiService.getCurrentBaseUrl();
    setCurrentUrl(url);
    setInputUrl(url);

    setStatus('checking');
    const result = await apiService.testConnection(url);
    setStatus(result.ok ? 'connected' : 'disconnected');
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // 测试连接
  const handleTest = async () => {
    const url = inputUrl.trim().replace(/\/+$/, '');
    if (!url) {
      Alert.alert('提示', '请输入后端地址');
      return;
    }

    setTesting(true);
    setStatus('checking');
    const result = await apiService.testConnection(url);
    setStatus(result.ok ? 'connected' : 'disconnected');
    setTesting(false);

    Alert.alert(result.ok ? '✅ 连接成功' : '❌ 连接失败', result.message);
  };

  // 保存地址
  const handleSave = async () => {
    const url = inputUrl.trim().replace(/\/+$/, '');
    if (!url) {
      Alert.alert('提示', '请输入后端地址');
      return;
    }

    setSaving(true);
    await apiService.updateApiUrl(url);
    setCurrentUrl(url);
    setSaving(false);

    // 自动测试
    setTesting(true);
    setStatus('checking');
    const result = await apiService.testConnection(url);
    setStatus(result.ok ? 'connected' : 'disconnected');
    setTesting(false);

    Alert.alert(
      '已保存',
      result.ok
        ? '后端地址已更新，连接正常'
        : '地址已保存，但连接失败，请检查地址是否正确',
    );
  };

  // 重置为自动发现
  const handleReset = async () => {
    await apiService.resetApiUrl();
    refreshStatus();
    Alert.alert('已重置', '后端地址将使用自动发现模式（LAN IP / localhost）');
  };

  // 切换到预设地址
  const handlePresetSwitch = async (url: string) => {
    setInputUrl(url);
    setSaving(true);
    await apiService.updateApiUrl(url);
    setCurrentUrl(url);
    setSaving(false);

    // 自动测试
    setTesting(true);
    setStatus('checking');
    const result = await apiService.testConnection(url);
    setStatus(result.ok ? 'connected' : 'disconnected');
    setTesting(false);

    Alert.alert(
      '已切换',
      result.ok
        ? '后端地址已切换，连接正常'
        : '地址已切换，但连接失败，请检查网络',
    );
  };

  const statusInfo = STATUS[status];

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.title}>设置</Text>
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.card}>
          {/* 连接状态 */}
          <View style={styles.statusRow}>
            <Text style={styles.label}>当前地址</Text>
            <Text style={styles.urlText} numberOfLines={2} selectable>
              {currentUrl || '检测中...'}
            </Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.label}>连接状态</Text>
            <View style={styles.statusBadge}>
              <View style={[styles.statusDot, { backgroundColor: statusInfo.color }]} />
              <Text style={[styles.statusLabel, { color: statusInfo.color }]}>
                {statusInfo.label}
              </Text>
            </View>
          </View>

          <View style={styles.divider} />

          {/* 预设地址 */}
          <View style={styles.presetRow}>
            <TouchableOpacity
              style={[
                styles.presetBtn,
                currentUrl === PRESET_URLS.default && styles.presetBtnActive,
              ]}
              onPress={() => handlePresetSwitch(PRESET_URLS.default)}
              disabled={saving || testing}
            >
              <Text
                style={[
                  styles.presetBtnText,
                  currentUrl === PRESET_URLS.default && styles.presetBtnTextActive,
                ]}
              >
                默认服务器
              </Text>
              <Text style={styles.presetUrlText}>{PRESET_URLS.default}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.presetBtn,
                currentUrl === PRESET_URLS.alternate && styles.presetBtnActive,
              ]}
              onPress={() => handlePresetSwitch(PRESET_URLS.alternate)}
              disabled={saving || testing}
            >
              <Text
                style={[
                  styles.presetBtnText,
                  currentUrl === PRESET_URLS.alternate && styles.presetBtnTextActive,
                ]}
              >
                备用服务器
              </Text>
              <Text style={styles.presetUrlText}>{PRESET_URLS.alternate}</Text>
            </TouchableOpacity>
          </View>

          <TextInput
            style={styles.input}
            value={inputUrl}
            onChangeText={setInputUrl}
            placeholder="输入后端地址"
            placeholderTextColor="#bbb"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.btn, styles.btnTest]}
              onPress={handleTest}
              disabled={testing}
            >
              {testing ? (
                <ActivityIndicator color="#007AFF" size="small" />
              ) : (
                <Text style={styles.btnTestText}>测试连接</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btn, styles.btnSave]}
              onPress={handleSave}
              disabled={saving || testing}
            >
              {saving ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.btnSaveText}>保存</Text>
              )}
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.resetBtn} onPress={handleReset}>
            <Text style={styles.resetText}>重置为自动发现模式</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 12,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#eee',
    marginVertical: 10,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  label: {
    fontSize: 12,
    color: '#666',
    width: 68,
  },
  urlText: {
    fontSize: 12,
    color: '#333',
    flex: 1,
    fontFamily: 'monospace',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  presetRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 8,
  },
  presetBtn: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#ddd',
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
  },
  presetBtnActive: {
    borderColor: '#A5D6A7',
    backgroundColor: '#E8F5E9',
  },
  presetBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#555',
    marginBottom: 2,
  },
  presetBtnTextActive: {
    color: '#388E3C',
  },
  presetUrlText: {
    fontSize: 10,
    color: '#999',
    fontFamily: 'monospace',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
    color: '#333',
    backgroundColor: '#f0f0f0',
    fontFamily: 'monospace',
  },
  buttonRow: {
    flexDirection: 'row',
    marginTop: 8,
    gap: 6,
  },
  btn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
  },
  btnTest: {
    backgroundColor: '#f0f0f0',
    borderWidth: 1,
    borderColor: '#ddd',
  },
  btnTestText: {
    color: '#555',
    fontSize: 11,
    fontWeight: '600',
  },
  btnSave: {
    backgroundColor: '#007AFF',
  },
  btnSaveText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  resetBtn: {
    marginTop: 8,
    alignItems: 'center',
    paddingVertical: 6,
  },
  resetText: {
    color: '#E53935',
    fontSize: 11,
    fontWeight: '600',
  },
});
