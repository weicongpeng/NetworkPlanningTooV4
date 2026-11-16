/** 截图设置：组合键解析 / 格式化 / 校验、本机持久化与共享状态。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/api', () => ({
  desktopLoginApi: {
    getScreenshotSettings: vi.fn(),
    putScreenshotSettings: vi.fn(),
  },
}))

import {
  applyScreenshotSettings, DEFAULT_SCREENSHOT_SETTINGS, formatHotkey,
  getScreenshotSettings, hotkeyFromEvent, keyFromEvent, matchesScreenshotHotkey,
  normalizeScreenshotSettings, saveScreenshotSettings,
} from '../screenshotSettings'

function keyEvent(parts: {
  code?: string
  key?: string
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}): KeyboardEvent {
  return {
    code: parts.code ?? '', key: parts.key ?? '',
    ctrlKey: parts.ctrlKey ?? false, altKey: parts.altKey ?? false,
    shiftKey: parts.shiftKey ?? false, metaKey: parts.metaKey ?? false,
  } as unknown as KeyboardEvent
}

describe('截图设置', () => {
  beforeEach(() => {
    localStorage.clear()
    applyScreenshotSettings(DEFAULT_SCREENSHOT_SETTINGS)
  })

  it('默认 Alt+Z、隐藏窗口开关默认关闭', () => {
    expect(formatHotkey(DEFAULT_SCREENSHOT_SETTINGS.hotkey)).toBe('Alt+Z')
    expect(DEFAULT_SCREENSHOT_SETTINGS.hideImWindow).toBe(false)
    expect(getScreenshotSettings().hideImWindow).toBe(false)
  })

  it('规范化脏数据：去重排序修饰键、非法键回落、非法输入回落默认值', () => {
    expect(normalizeScreenshotSettings({
      hotkey: { modifiers: ['alt', 'ctrl', 'ctrl', 'bogus'], key: 'q' },
      hideImWindow: true,
    })).toEqual({
      hotkey: { modifiers: ['ctrl', 'alt'], key: 'Q' },
      hideImWindow: true,
    })
    expect(normalizeScreenshotSettings(null)).toEqual(DEFAULT_SCREENSHOT_SETTINGS)
    expect(normalizeScreenshotSettings({ hotkey: { modifiers: [], key: 'ESCAPE' } }))
      .toEqual(DEFAULT_SCREENSHOT_SETTINGS)
  })

  it('keyFromEvent 覆盖字母 / 数字 / 功能键 / 符号键', () => {
    expect(keyFromEvent({ code: 'KeyZ', key: 'z' } as KeyboardEvent)).toBe('Z')
    expect(keyFromEvent({ code: 'Digit2', key: '2' } as KeyboardEvent)).toBe('2')
    expect(keyFromEvent({ code: 'F5', key: 'F5' } as KeyboardEvent)).toBe('F5')
    expect(keyFromEvent({ code: 'Space', key: ' ' } as KeyboardEvent)).toBe('SPACE')
    expect(keyFromEvent({ code: '', key: 'a' } as KeyboardEvent)).toBe('A')
  })

  it('录制组合键要求至少一个修饰键，并拒绝系统保留键', () => {
    expect(hotkeyFromEvent(keyEvent({ code: 'KeyA', key: 'a' })).error)
      .toBe('MODIFIER_REQUIRED')
    expect(hotkeyFromEvent(keyEvent({ code: 'Escape', key: 'Escape', ctrlKey: true })).error)
      .toBe('RESERVED_KEY')
    expect(hotkeyFromEvent(keyEvent({
      code: 'KeyZ', key: 'z', altKey: true, ctrlKey: true,
    })).hotkey).toEqual({ modifiers: ['ctrl', 'alt'], key: 'Z' })
  })

  it('matchesScreenshotHotkey 精确匹配修饰键组合，多按/少按都不触发', () => {
    const settings = normalizeScreenshotSettings({
      hotkey: { modifiers: ['ctrl', 'shift'], key: 'A' }, hideImWindow: false,
    })
    expect(matchesScreenshotHotkey(keyEvent({
      code: 'KeyA', key: 'a', ctrlKey: true, shiftKey: true,
    }), settings)).toBe(true)
    expect(matchesScreenshotHotkey(keyEvent({
      code: 'KeyA', key: 'a', ctrlKey: true,
    }), settings)).toBe(false)
    expect(matchesScreenshotHotkey(keyEvent({
      code: 'KeyA', key: 'a', ctrlKey: true, shiftKey: true, altKey: true,
    }), settings)).toBe(false)
  })

  it('网页端保存到 localStorage 并同步共享状态', async () => {
    const target = normalizeScreenshotSettings({
      hotkey: { modifiers: ['shift'], key: 'F8' }, hideImWindow: true,
    })
    const result = await saveScreenshotSettings(target, false)
    expect(result.conflict).toBe(false)
    expect(result.settings).toEqual(target)
    expect(getScreenshotSettings()).toEqual(target)
    expect(JSON.parse(localStorage.getItem('npt-screenshot-settings') || '{}'))
      .toEqual(target)
  })
})
