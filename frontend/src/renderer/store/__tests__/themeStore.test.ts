/**
 * 主题变量写入回归测试
 *
 * 覆盖修复：applyTheme 曾直接拼 `--${key}`，驼峰 key（cardForeground /
 * mutedForeground / warningForeground 等）写出的变量名与 CSS 期望的
 * `--card-foreground` / `--muted-foreground` / `--warning-foreground` 不一致，
 * 导致浅色主题下这些 token 一直沿用 :root 的深色默认值
 * （muted 文字过浅、工参导入警告提示仍是亮黄）。
 */
import { describe, it, expect } from 'vitest'
import {
  useThemeStore,
  DARK_THEME_VARS,
  LIGHT_THEME_VARS,
  kebabCase
} from '../themeStore'

const rootStyle = () => document.documentElement.style

describe('themeStore 主题变量写入', () => {
  it('驼峰 key 统一写为 kebab-case（与 index.css / tailwind 的 var 名一致）', () => {
    useThemeStore.getState().setThemeMode('light')

    expect(rootStyle().getPropertyValue('--warning-foreground'))
      .toBe(LIGHT_THEME_VARS.warningForeground)
    expect(rootStyle().getPropertyValue('--muted-foreground'))
      .toBe(LIGHT_THEME_VARS.mutedForeground)
    expect(rootStyle().getPropertyValue('--card-foreground'))
      .toBe(LIGHT_THEME_VARS.cardForeground)
    expect(rootStyle().getPropertyValue('--popover-foreground'))
      .toBe(LIGHT_THEME_VARS.popoverForeground)

    // 不残留 CSS 无法识别的驼峰变量名
    expect(rootStyle().getPropertyValue('--warningForeground')).toBe('')
    expect(rootStyle().getPropertyValue('--mutedForeground')).toBe('')
  })

  it('单词 key 不受影响（--background / --foreground）', () => {
    useThemeStore.getState().setThemeMode('dark')
    expect(rootStyle().getPropertyValue('--background')).toBe(DARK_THEME_VARS.background)
    expect(rootStyle().getPropertyValue('--foreground')).toBe(DARK_THEME_VARS.foreground)
  })

  it('警告提示文字：深色用亮黄、浅色用深黄（浅色可辨认）', () => {
    useThemeStore.getState().setThemeMode('dark')
    const dark = rootStyle().getPropertyValue('--warning-foreground')
    useThemeStore.getState().setThemeMode('light')
    const light = rootStyle().getPropertyValue('--warning-foreground')

    expect(dark).toBe(DARK_THEME_VARS.warningForeground)
    expect(light).toBe(LIGHT_THEME_VARS.warningForeground)
    expect(light).not.toBe(dark)
    // 浅色档应比深色档暗（HSL 亮度更低）
    const lightness = (v: string) => parseFloat(v.split(/\s+/)[2])
    expect(lightness(light)).toBeLessThan(lightness(dark))
  })

  it('kebabCase 只转换大写字母', () => {
    expect(kebabCase('warningForeground')).toBe('warning-foreground')
    expect(kebabCase('background')).toBe('background')
  })
})
