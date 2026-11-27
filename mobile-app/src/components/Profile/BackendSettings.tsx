/** 后端地址设置：预设/自定义切换、连通性测试、恢复自动发现。 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Alert, Platform } from 'react-native';

import { apiService } from '../../services/api';
import type { AppColors } from './ProfileUi';

const PRESET_URLS = {
  default: 'https://app.pengwc.asia',
  alternate: 'https://armbian.tail362392.ts.net',
} as const;

export default function BackendSettings({ colors }: { colors: AppColors }) {
  const [currentUrl, setCurrentUrl] = useState('');
  const [inputUrl, setInputUrl] = useState('');
  const [status, setStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const statusColors = {
    checking: { color: colors.textMuted, label: '检测中' },
    connected: { color: colors.success, label: '已连接' },
    disconnected: { color: colors.danger, label: '未连接' },
  };
  const statusInfo = statusColors[status];

  const refreshStatus = useCallback(async () => {
    const url = await apiService.getCurrentBaseUrl();
    setCurrentUrl(url);
    setInputUrl(url);
    setStatus('checking');
    const result = await apiService.testConnection(url);
    setStatus(result.ok ? 'connected' : 'disconnected');
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const handleTest = async () => {
    const url = inputUrl.trim().replace(/\/+$/, '');
    if (!url) { Alert.alert('提示', '请输入后端地址'); return; }
    setTesting(true);
    setStatus('checking');
    const result = await apiService.testConnection(url);
    setStatus(result.ok ? 'connected' : 'disconnected');
    setTesting(false);
    Alert.alert(result.ok ? '连接成功' : '连接失败', result.message);
  };

  const handleSave = async () => {
    const url = inputUrl.trim().replace(/\/+$/, '');
    if (!url) { Alert.alert('提示', '请输入后端地址'); return; }
    setSaving(true);
    await apiService.updateApiUrl(url);
    setCurrentUrl(url);
    setSaving(false);
    setTesting(true);
    setStatus('checking');
    const result = await apiService.testConnection(url);
    setStatus(result.ok ? 'connected' : 'disconnected');
    setTesting(false);
    Alert.alert('已保存', result.ok ? '后端地址已更新，连接正常' : '地址已保存，但连接失败');
  };

  const handleReset = async () => {
    await apiService.resetApiUrl();
    void refreshStatus();
    Alert.alert('已重置', '后端地址将使用自动发现模式');
  };

  const handlePresetSwitch = async (url: string) => {
    setInputUrl(url);
    setSaving(true);
    await apiService.updateApiUrl(url);
    setCurrentUrl(url);
    setSaving(false);
    setTesting(true);
    setStatus('checking');
    const result = await apiService.testConnection(url);
    setStatus(result.ok ? 'connected' : 'disconnected');
    setTesting(false);
    Alert.alert('已切换', result.ok ? '后端地址已切换，连接正常' : '地址已切换，但连接失败');
  };

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusInfo.color, marginRight: 8 }} />
        <Text style={{ fontSize: 12, fontWeight: '500', color: colors.textPrimary, marginRight: 8 }}>{statusInfo.label}</Text>
        <Text style={{ fontSize: 11, color: colors.textMuted, flex: 1 }} numberOfLines={1}>{currentUrl || '—'}</Text>
      </View>

      <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 6, fontWeight: '500' }}>预设</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        {[{ key: 'default', title: '默认', url: PRESET_URLS.default }, { key: 'alternate', title: '备用', url: PRESET_URLS.alternate }].map((preset) => (
          <TouchableOpacity
            key={preset.key}
            style={{
              flex: 1, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1,
              borderColor: currentUrl === preset.url ? colors.accent : colors.cardBorder,
              backgroundColor: currentUrl === preset.url ? `${colors.accent}15` : colors.inputBg,
              alignItems: 'center',
            }}
            onPress={() => void handlePresetSwitch(preset.url)}
            disabled={saving || testing}
            activeOpacity={0.7}
          >
            <Text style={{ fontSize: 11, fontWeight: '600', color: currentUrl === preset.url ? colors.accent : colors.textSecondary, marginBottom: 2 }}>
              {preset.title}
            </Text>
            <Text style={{ fontSize: 9, color: colors.textMuted }} numberOfLines={1}>{preset.url}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 6, fontWeight: '500' }}>自定义</Text>
      <TextInput
        style={{
          borderWidth: 1, borderColor: colors.cardBorder, borderRadius: 8, paddingHorizontal: 12,
          paddingVertical: 8, fontSize: 12, color: colors.textPrimary, backgroundColor: colors.inputBg,
          marginBottom: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        }}
        value={inputUrl}
        onChangeText={setInputUrl}
        placeholder="输入后端地址"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />

      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
        <TouchableOpacity
          style={{
            flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
            backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.cardBorder,
          }}
          onPress={() => void handleTest()}
          disabled={testing}
          activeOpacity={0.7}
        >
          {testing
            ? <ActivityIndicator color={colors.textPrimary} size="small" />
            : <Text style={{ fontSize: 13, fontWeight: '500', color: colors.textPrimary }}>测试</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          style={{
            flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
            backgroundColor: colors.accent,
          }}
          onPress={() => void handleSave()}
          disabled={saving || testing}
          activeOpacity={0.7}
        >
          {saving
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>保存</Text>}
        </TouchableOpacity>
      </View>

      <TouchableOpacity onPress={() => void handleReset()} hitSlop={{ top: 8, bottom: 8 }} style={{ alignItems: 'center', paddingVertical: 4 }}>
        <Text style={{ fontSize: 12, color: colors.textMuted }}>重置为自动发现</Text>
      </TouchableOpacity>
    </View>
  );
}
