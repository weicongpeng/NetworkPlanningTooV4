import { useMapStore } from '../../store/mapStore';

export interface ImColors {
  bg: string; card: string; cardBorder: string; divider: string;
  textPrimary: string; textSecondary: string; textMuted: string;
  accent: string; danger: string; success: string;
  bubbleSelf: string; bubbleOther: string; bubbleSelfText: string;
  badge: string; inputBg: string; overlayBg: string; avatarBg: string;
}

const LIGHT: ImColors = {
  bg: '#f5f5f5', card: '#FFFFFF', cardBorder: '#E5E5E5', divider: '#EEEEEE',
  textPrimary: '#1A1A1A', textSecondary: '#666666', textMuted: '#999999',
  accent: '#007AFF', danger: '#E53935', success: '#34A853',
  bubbleSelf: '#007AFF', bubbleOther: '#FFFFFF', bubbleSelfText: '#FFFFFF',
  badge: '#FF3B30', inputBg: '#F2F2F7', overlayBg: 'rgba(0,0,0,0.45)',
  avatarBg: '#D9E9FF',
} as const;

const DARK: ImColors = {
  bg: '#2B2B2F', card: '#36363A', cardBorder: '#4A4A50', divider: '#424248',
  textPrimary: '#E8E6E3', textSecondary: '#B0AEA8', textMuted: '#8A8880',
  accent: '#7EB6F6', danger: '#F07070', success: '#7EC87E',
  bubbleSelf: '#3A6EA5', bubbleOther: '#45454A', bubbleSelfText: '#FFFFFF',
  badge: '#F07070', inputBg: '#3A3A3F', overlayBg: 'rgba(0,0,0,0.55)',
  avatarBg: '#3E5570',
} as const;

export function useImColors(): ImColors {
  const darkMode = useMapStore((s) => s.darkMode);
  return darkMode ? DARK : LIGHT;
}
