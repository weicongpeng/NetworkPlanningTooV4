import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeMode = 'dark' | 'light'
export type ColorScheme = 'blue' | 'green' | 'purple' | 'orange' | 'pink'

export interface ThemeColors {
  primary: string
  primaryForeground: string
}

export const THEME_COLORS: Record<ColorScheme, ThemeColors> = {
  blue: {
    primary: '207 90% 54%',
    primaryForeground: '0 0% 100%'
  },
  green: {
    primary: '142.1 76.2% 36.3%',
    primaryForeground: '355.7 100% 97.3%'
  },
  purple: {
    primary: '262.1 83.3% 57.8%',
    primaryForeground: '210 40% 98%'
  },
  orange: {
    primary: '24.6 95% 53.1%',
    primaryForeground: '60 9.1% 97.8%'
  },
  pink: {
    primary: '330 81% 60%',
    primaryForeground: '210 40% 98%'
  }
}

export const DARK_THEME_VARS = {
  // 高级灰（淡雅、低饱和、微冷）：app 背景 < 卡片 < 嵌套面/表头 < 浮层(最亮)
  background: '220 13% 15%',          // L~15% - 页面底色，中性偏冷高级灰
  foreground: '210 24% 92%',          // L~92% - 主文字
  card: '220 12% 18%',                // L~18% - 卡片表面，比背景亮 3%
  cardForeground: '210 24% 92%',
  popover: '220 11% 24%',             // L~24% - 浮层面板/下拉，最亮表面
  popoverForeground: '210 24% 92%',
  secondary: '220 11% 22%',           // L~22% - 次级按钮/选中底
  secondaryForeground: '210 24% 92%',
  muted: '220 10% 25%',               // L~25% - 表头/分组/嵌套面
  mutedForeground: '220 12% 68%',     // L~68% - 次要文字
  accent: '220 11% 28%',              // L~28% - hover/强调底
  accentForeground: '210 24% 92%',
  destructive: '0 70% 62%',           // L~62% - 暗色下提亮确保可读
  destructiveForeground: '0 0% 100%',
  border: '220 9% 31%',               // L~31% - 边框，比卡片高 13%，清晰可见
  input: '220 11% 22%',               // L~22% - 输入框填充
  ring: '207 90% 54%'
}

export const LIGHT_THEME_VARS = {
  // 冷灰色阶：app 背景(浅灰蓝) < 卡片(白) < 嵌套面(浅灰) < hover < popover
  background: '220 20% 96%',          // L~95% - 页面底色，浅蓝灰底衬托白卡片
  foreground: '222 47% 11%',          // L~11% - 主文字
  card: '0 0% 100%',                  // 白 - 卡片/侧栏，在灰底上清晰区分
  cardForeground: '222 47% 11%',
  popover: '0 0% 100%',               // 白 + 强阴影 - 浮层/下拉
  popoverForeground: '222 47% 11%',
  secondary: '220 18% 94%',           // L~94% - 次级按钮底
  secondaryForeground: '222 47% 11%',
  muted: '220 18% 97%',               // L~97% - 表头/上传区/分组底，比卡片更"凹陷"
  mutedForeground: '215 16% 45%',     // L~47% - 次要文字，WCAG AA
  accent: '220 16% 94%',              // L~94% - hover 态
  accentForeground: '222 47% 11%',
  destructive: '0 72% 51%',           // 鲜艳红
  destructiveForeground: '0 0% 100%',
  border: '220 14% 88%',              // L~88% - 比现状深 3%，清晰可见
  input: '220 16% 95%',               // 输入框填充
  ring: '207 90% 54%'
}

interface ThemeState {
  themeMode: ThemeMode
  colorScheme: ColorScheme
  setThemeMode: (mode: ThemeMode) => void
  setColorScheme: (scheme: ColorScheme) => void
  applyTheme: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      themeMode: 'dark',
      colorScheme: 'blue',

      setThemeMode: (mode: ThemeMode) => {
        set({ themeMode: mode })
        get().applyTheme()
      },

      setColorScheme: (scheme: ColorScheme) => {
        set({ colorScheme: scheme })
        get().applyTheme()
      },

      applyTheme: () => {
        try {
          const { themeMode, colorScheme } = get()
          const root = document.documentElement

          // Apply theme mode variables
          const themeVars = themeMode === 'dark' ? DARK_THEME_VARS : LIGHT_THEME_VARS
          Object.entries(themeVars).forEach(([key, value]) => {
            root.style.setProperty(`--${key}`, value)
          })

          // Apply color scheme variables
          const colorVars = THEME_COLORS[colorScheme]
          Object.entries(colorVars).forEach(([key, value]) => {
            root.style.setProperty(`--${kebabCase(key)}`, value)
          })
        } catch (error) {
          console.error('Failed to apply theme:', error)
        }
      }
    }),
    {
      name: 'theme-storage',
      onRehydrateStorage: () => (state) => {
        state?.applyTheme()
      }
    }
  )
)

export function kebabCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}
