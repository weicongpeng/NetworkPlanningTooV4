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

  const statusInfo = STATUS[status];

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar style="dark" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {/* 标题 */}
        <Text style={styles.title}>设置</Text>

        {/* 当前连接状态 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>后端连接</Text>
          <View style={styles.statusRow}>
            <Text style={styles.label}>当前地址：</Text>
            <Text style={styles.urlText} numberOfLines={2} selectable>
              {currentUrl || '检测中...'}
            </Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.label}>状态：</Text>
            <View style={styles.statusBadge}>
              <View style={[styles.statusDot, { backgroundColor: statusInfo.color }]} />
              <Text style={[styles.statusLabel, { color: statusInfo.color }]}>
                {statusInfo.label}
              </Text>
            </View>
          </View>
        </View>

        {/* 手动配置 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>手动配置后端地址</Text>
          <Text style={styles.hint}>
            外场测试时输入 Cloudflare 地址，如：https://apk.pengwc.asia
          </Text>

          <TextInput
            style={styles.input}
            value={inputUrl}
            onChangeText={setInputUrl}
            placeholder="输入后端地址，例如 https://apk.pengwc.asia"
            placeholderTextColor="#999"
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

        {/* 使用说明 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>使用说明</Text>
          <Text style={styles.helpText}>
            • 办公室/内网：保持空或重置为自动发现，App会自动连接电脑局域网IP{'\n'}
            • GPS外场测试：输入 https://apk.pengwc.asia 并保存{'\n'}
            • 切换地址后无需重新安装App，立即生效{'\n'}
            • 点击"测试连接"可以先验证地址是否可达{'\n'}
            • 长按地址文本可复制
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 20,
    marginTop: Platform.OS === 'android' ? 20 : 0,
  },
  section: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 12,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  label: {
    fontSize: 14,
    color: '#666',
    width: 80,
  },
  urlText: {
    fontSize: 13,
    color: '#1a1a1a',
    flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
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
    fontSize: 14,
    fontWeight: '500',
  },
  hint: {
    fontSize: 12,
    color: '#999',
    marginBottom: 10,
    lineHeight: 18,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: '#333',
    backgroundColor: '#FAFAFA',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  buttonRow: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 10,
  },
  btn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  btnTest: {
    backgroundColor: '#F0F7FF',
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  btnTestText: {
    color: '#007AFF',
    fontSize: 14,
    fontWeight: '600',
  },
  btnSave: {
    backgroundColor: '#007AFF',
  },
  btnSaveText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  resetBtn: {
    marginTop: 12,
    alignItems: 'center',
    paddingVertical: 8,
  },
  resetText: {
    color: '#FF3B30',
    fontSize: 13,
  },
  helpText: {
    fontSize: 13,
    color: '#666',
    lineHeight: 22,
  },
});
