/**
 * 截图设置的共享状态与组合键工具。
 *
 * 桌面端的权威配置在壳层本机文件（``DATA_ROOT/screenshot_settings.json``），由
 * ``/desktop/screenshot-settings`` 读写；网页端没有壳层，退化为 localStorage 的本机设置
 * （只影响应用内快捷键与「隐藏会话窗口」开关）。
 *
 * 模块级 store + ``useSyncExternalStore``：输入区下拉、ImHost 的快捷键监听、设置面板
 * 三处共享同一份配置，任一处保存后立刻同步，不引入新的 zustand store。
 */
import { useSyncExternalStore } from 'react'

import { desktopLoginApi } from '../../services/api'

export type HotkeyModifier = 'ctrl' | 'alt' | 'shift' | 'win'

export interface ScreenshotHotkey {
  modifiers: HotkeyModifier[]
  key: string
}

export interface ScreenshotSettings {
  hotkey: ScreenshotHotkey
  /** 截图时隐藏协作沟通会话浮窗（默认关闭，关闭时会话窗口可被截进去） */
  hideImWindow: boolean
}

export interface SaveScreenshotSettingsResult {
  settings: ScreenshotSettings
  /** Win32 RegisterHotKey 返回 1409：组合键被其它应用占用 */
  conflict: boolean
  registered: boolean
  reverted: boolean
}

const STORAGE_KEY = 'npt-screenshot-settings'

export const DEFAULT_SCREENSHOT_SETTINGS: ScreenshotSettings = {
  hotkey: { modifiers: ['alt'], key: 'Z' },
  hideImWindow: false,
}

const MODIFIER_ORDER: HotkeyModifier[] = ['ctrl', 'alt', 'shift', 'win']
const MODIFIER_LABEL: Record<HotkeyModifier, string> = {
  ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win',
}
/** 系统保留键：注册后必然冲突或会打断系统操作，录制时直接拒绝 */
export const RESERVED_KEYS = ['ESCAPE', 'TAB', 'ENTER', 'PRINTSCREEN']

function validKey(key: string): boolean {
  return /^[A-Z0-9]$/.test(key)
    || /^F([1-9]|1[0-2])$/.test(key)
    || ['SPACE', 'INSERT', 'DELETE', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN',
      'UP', 'DOWN', 'LEFT', 'RIGHT', 'SCROLLLOCK', 'PAUSE', 'BACKSPACE',
      '`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/'].includes(key)
}

/** 把 KeyboardEvent 转成配置里的主键名；与后端 key_from_code 口径一致 */
export function keyFromEvent(event: Pick<KeyboardEvent, 'code' | 'key'>): string {
  const code = String(event.code || '')
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6)
  if (/^F([1-9]|1[0-2])$/.test(code)) return code
  const map: Record<string, string> = {
    Space: 'SPACE', Insert: 'INSERT', Delete: 'DELETE', Home: 'HOME', End: 'END',
    PageUp: 'PAGEUP', PageDown: 'PAGEDOWN', ArrowUp: 'UP', ArrowDown: 'DOWN',
    ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', ScrollLock: 'SCROLLLOCK',
    Pause: 'PAUSE', Backspace: 'BACKSPACE', Backquote: '`', Minus: '-',
    Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Escape: 'ESCAPE', Tab: 'TAB', Enter: 'ENTER', PrintScreen: 'PRINTSCREEN',
  }
  if (map[code]) return map[code]
  const fallback = String(event.key || '').toUpperCase()
  return validKey(fallback) ? fallback : ''
}

/** 从按键事件录制组合键；返回 error 时表示不能作为快捷键 */
export function hotkeyFromEvent(event: KeyboardEvent): {
  hotkey: ScreenshotHotkey | null
  error: string
} {
  const modifiers: HotkeyModifier[] = MODIFIER_ORDER.filter(modifier => {
    if (modifier === 'ctrl') return event.ctrlKey
    if (modifier === 'alt') return event.altKey
    if (modifier === 'shift') return event.shiftKey
    return event.metaKey
  })
  if (!modifiers.length) return { hotkey: null, error: 'MODIFIER_REQUIRED' }
  const key = keyFromEvent(event)
  if (!key) return { hotkey: null, error: 'INVALID_KEY' }
  if (RESERVED_KEYS.includes(key) || !validKey(key)) {
    return { hotkey: null, error: 'RESERVED_KEY' }
  }
  return { hotkey: { modifiers, key }, error: '' }
}

/** 判断按键事件是否命中当前配置的截图快捷键 */
export function matchesScreenshotHotkey(
  event: KeyboardEvent, settings: ScreenshotSettings,
): boolean {
  const modifiers = settings.hotkey.modifiers
  if (event.ctrlKey !== modifiers.includes('ctrl')) return false
  if (event.altKey !== modifiers.includes('alt')) return false
  if (event.shiftKey !== modifiers.includes('shift')) return false
  if (event.metaKey !== modifiers.includes('win')) return false
  const key = keyFromEvent(event)
  return Boolean(key) && key === settings.hotkey.key
}

export function formatHotkey(hotkey: ScreenshotHotkey): string {
  return [...hotkey.modifiers.map(m => MODIFIER_LABEL[m] ?? m), hotkey.key].join('+')
}

/** 任意来源（localStorage / 接口 / 旧版本残留）规范化，非法项回落默认值 */
export function normalizeScreenshotSettings(raw: unknown): ScreenshotSettings {
  const value = raw as Partial<ScreenshotSettings> | null
  const fallback: ScreenshotSettings = {
    hotkey: { ...DEFAULT_SCREENSHOT_SETTINGS.hotkey,
      modifiers: [...DEFAULT_SCREENSHOT_SETTINGS.hotkey.modifiers] },
    hideImWindow: DEFAULT_SCREENSHOT_SETTINGS.hideImWindow,
  }
  if (!value || typeof value !== 'object') return fallback
  const hotkey = value.hotkey
  if (hotkey && Array.isArray(hotkey.modifiers)) {
    const cleaned = MODIFIER_ORDER.filter(m => hotkey.modifiers.includes(m))
    if (cleaned.length) fallback.hotkey.modifiers = cleaned
  }
  const key = String(hotkey?.key || '').toUpperCase()
  if (key && validKey(key) && !RESERVED_KEYS.includes(key)) fallback.hotkey.key = key
  fallback.hideImWindow = Boolean(value.hideImWindow)
  return fallback
}

function readLocal(): ScreenshotSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return normalizeScreenshotSettings(JSON.parse(raw))
  } catch { /* 损坏时回落默认 */ }
  return normalizeScreenshotSettings(DEFAULT_SCREENSHOT_SETTINGS)
}

let current: ScreenshotSettings = readLocal()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function snapshot(): ScreenshotSettings {
  return current
}

export function getScreenshotSettings(): ScreenshotSettings {
  return current
}

export function applyScreenshotSettings(next: ScreenshotSettings): void {
  current = normalizeScreenshotSettings(next)
  listeners.forEach(listener => listener())
}

/** 组件内订阅共享配置（useSyncExternalStore 要求快照引用稳定，apply 时才替换） */
export function useScreenshotSettings(): ScreenshotSettings {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

function persistLocal(settings: ScreenshotSettings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)) } catch { /* 忽略 */ }
}

/** 桌面端启动时从壳层拉权威配置；网页端保留 localStorage 设置 */
export async function refreshScreenshotSettings(desktopMode: boolean): Promise<ScreenshotSettings> {
  if (!desktopMode) return current
  try {
    const response = await desktopLoginApi.getScreenshotSettings()
    const settings = normalizeScreenshotSettings(response?.data?.settings)
    applyScreenshotSettings(settings)
    persistLocal(settings)
    return settings
  } catch { /* 旧版壳 / 接口不可用：沿用本机缓存 */ }
  return current
}

/** 保存设置；桌面端由壳层重注册全局热键并回报是否被其它应用占用 */
export async function saveScreenshotSettings(
  settings: ScreenshotSettings, desktopMode: boolean,
): Promise<SaveScreenshotSettingsResult> {
  const normalized = normalizeScreenshotSettings(settings)
  if (!desktopMode) {
    persistLocal(normalized)
    applyScreenshotSettings(normalized)
    return { settings: normalized, conflict: false, registered: false, reverted: false }
  }
  const response = await desktopLoginApi.putScreenshotSettings(normalized)
  const data = response?.data
  const effective = normalizeScreenshotSettings(data?.settings ?? normalized)
  persistLocal(effective)
  applyScreenshotSettings(effective)
  return {
    settings: effective,
    conflict: Boolean(data?.conflict),
    registered: Boolean(data?.registered),
    reverted: Boolean(data?.reverted),
  }
}
