/** 「我的」页共用的配色、行组件与格式化工具。 */
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Switch } from 'react-native';

export interface AppColors {
  bg: string;
  card: string;
  cardBorder: string;
  divider: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  danger: string;
  success: string;
  avatarBg: string;
  inputBg: string;
  switchTrackFalse: string;
  overlayBg: string;
}

export const LIGHT_COLORS: AppColors = {
  bg: '#f5f5f5', card: '#FFFFFF', cardBorder: '#E5E5E5', divider: '#EEEEEE',
  textPrimary: '#1A1A1A', textSecondary: '#666666', textMuted: '#999999',
  accent: '#007AFF', danger: '#E53935', success: '#16A34A', avatarBg: '#FFB300',
  inputBg: '#f0f0f0', switchTrackFalse: '#E0E0E0', overlayBg: 'rgba(0,0,0,0.4)',
};

export const DARK_COLORS: AppColors = {
  bg: '#2B2B2F', card: '#36363A', cardBorder: '#4A4A50', divider: '#424248',
  textPrimary: '#E8E6E3', textSecondary: '#B0AEA8', textMuted: '#8A8880',
  accent: '#7EB6F6', danger: '#F07070', success: '#7EC87E', avatarBg: '#C49A2A',
  inputBg: '#3A3A3F', switchTrackFalse: '#55555A', overlayBg: 'rgba(0,0,0,0.55)',
};

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatDistance(m: number): string {
  if (m > 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.round(m)} m`;
}

export function SettingRow({ icon, title, subtitle, onPress, colors, iconColor }: {
  icon: React.ReactNode; title: string; subtitle?: string; onPress: () => void;
  colors: AppColors; iconColor?: string;
}) {
  return (
    <TouchableOpacity style={styles.settingRow} onPress={onPress} activeOpacity={0.6}>
      <View style={[styles.settingIcon, { backgroundColor: colors.bg }]}>
        {typeof icon === 'string' ? (
          <Text style={[styles.settingIconText, { color: iconColor || colors.textPrimary }]}>{icon}</Text>
        ) : icon}
      </View>
      <View style={styles.textBlock}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
        {subtitle && <Text style={[styles.subtitle, { color: colors.textMuted }]}>{subtitle}</Text>}
      </View>
      <Text style={[styles.chevron, { color: colors.textMuted }]}>›</Text>
    </TouchableOpacity>
  );
}

/** 我的足迹图标：View 自绘，避免 emoji 字体强制彩色。 */
export function FootprintIcon({ color, size = 18 }: { color: string; size?: number }) {
  const toeSizes = [0.22, 0.17, 0.15, 0.13];
  const toeOffsets = [-0.18, -0.04, 0.10, 0.22];
  const toeTops = [0.05, 0.07, 0.11, 0.17];
  return (
    <View style={{ width: size, height: size, alignItems: 'center' }}>
      {toeSizes.map((ratio, index) => {
        const dot = size * ratio;
        return (
          <View
            key={index}
            style={{
              position: 'absolute', left: size * 0.5 - dot / 2 + size * toeOffsets[index],
              top: size * toeTops[index], width: dot, height: dot,
              borderRadius: dot / 2, backgroundColor: color,
            }}
          />
        );
      })}
      <View
        style={{
          width: size * 0.5, height: size * 0.55, borderRadius: size * 0.25,
          backgroundColor: color, marginTop: size * 0.30,
        }}
      />
    </View>
  );
}

export function SettingSwitchRow({ title, subtitle, value, onValueChange, trackFalseColor, colors }: {
  title: string; subtitle?: string; value: boolean; onValueChange: (v: boolean) => void;
  trackFalseColor?: string; colors: AppColors;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.textBlock}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
        {subtitle && <Text style={[styles.subtitle, { color: colors.textMuted }]}>{subtitle}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: trackFalseColor || '#E0E0E0', true: colors.accent }}
        thumbColor="#FFFFFF"
      />
    </View>
  );
}

export function Divider({ colors }: { colors: AppColors }) {
  return <View style={[styles.divider, { backgroundColor: colors.divider }]} />;
}

const styles = StyleSheet.create({
  settingRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 14 },
  settingIcon: { width: 32, height: 32, borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  settingIconText: { fontSize: 16 },
  textBlock: { flex: 1 },
  title: { fontSize: 15, fontWeight: '500' },
  subtitle: { fontSize: 11, marginTop: 2 },
  chevron: { fontSize: 18, marginLeft: 8 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 56 },
});
