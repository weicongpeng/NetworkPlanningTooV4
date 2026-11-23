/**
 * 截图设置面板（截图按钮下拉的「设置」项）。
 *
 * - 快捷键：点击录制区后直接按下组合键，必须含至少一个修饰键；
 *   桌面端保存时由壳层重注册 Win32 全局热键，被其它应用占用（1409）时
 *   后端回滚配置、这里给出明确的「请更换」提示 + Toast。
 * - 隐藏窗口截图开关（默认关闭）：开启后截图画面不出现协作沟通会话窗口控件。
 *
 * 配置在 screenshotSettings.ts 里跨组件共享：下拉勾选、ImHost 快捷键监听与这里同步。
 */
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Keyboard, RotateCcw, Settings2, X } from 'lucide-react'

import { useToastStore } from '../../store/toastStore'
import { setHotkeyRecordingFlag } from './screenshotBus'
import {
  DEFAULT_SCREENSHOT_SETTINGS, formatHotkey, hotkeyFromEvent,
  normalizeScreenshotSettings, saveScreenshotSettings, useScreenshotSettings,
} from './screenshotSettings'
import type { ScreenshotSettings } from './screenshotSettings'

interface Props {
  open: boolean
  onClose: () => void
  desktopMode: boolean
}

const MODIFIER_ONLY_KEYS = ['Control', 'Alt', 'Shift', 'Meta']

function errorText(code: string, t: (key: string, fallback: string) => string): string {
  if (code === 'MODIFIER_REQUIRED') {
    return t('im.screenshot.settings.modifierRequired', '请同时按住 Ctrl / Alt / Shift / Win 中的至少一个修饰键')
  }
  if (code === 'RESERVED_KEY') {
    return t('im.screenshot.settings.reservedKey', '该按键为系统保留键，请换一个')
  }
  return t('im.screenshot.settings.invalidKey', '无法识别该按键，请换一个')
}

export function ImScreenshotSettingsDialog({ open, onClose, desktopMode }: Props) {
  const { t } = useTranslation()
  const settings = useScreenshotSettings()
  const [draft, setDraft] = useState<ScreenshotSettings>(settings)
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const recordRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    setDraft(normalizeScreenshotSettings(settings))
    setError('')
    setNotice('')
    setBusy(false)
    setRecording(false)
    // 只在打开瞬间取一次快照；编辑过程中共享配置变化不应覆盖用户未保存的录入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 录制期间给 <body> 打标记，让 ImHost 的应用级快捷键监听让路；卸载/关闭务必清除
  useEffect(() => {
    setHotkeyRecordingFlag(open && recording)
    return () => setHotkeyRecordingFlag(false)
  }, [open, recording])

  if (!open) return null

  const tr = (key: string, fallback: string) => String(t(key, fallback))

  const onRecordKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return
    event.preventDefault()
    event.stopPropagation()
    if (MODIFIER_ONLY_KEYS.includes(event.key)) return
    const result = hotkeyFromEvent(event.nativeEvent)
    if (!result.hotkey) {
      setError(result.error)
      return
    }
    setDraft(current => ({ ...current, hotkey: result.hotkey! }))
    setError('')
    setNotice('')
    setRecording(false)
    recordRef.current?.blur()
  }

  const save = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await saveScreenshotSettings(draft, desktopMode)
      setDraft(result.settings)
      if (result.conflict) {
        const message = tr('im.screenshot.settings.conflict',
          '该快捷键已被其它应用占用，已恢复原来的设置，请更换一个组合键')
        setNotice(message)
        useToastStore.getState().show(message)
        return
      }
      useToastStore.getState().show(tr('im.screenshot.settings.saved', '截图设置已保存'))
      onClose()
    } catch {
      setError(tr('im.screenshot.settings.saveFailed', '保存失败，请稍后重试'))
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/60 p-4"
         onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <Settings2 size={17} className="text-primary" />
          <h3 className="flex-1 text-sm font-semibold">
            {tr('im.screenshot.settings.title', '截图设置')}
          </h3>
          <button type="button" onClick={onClose}
                  title={tr('im.common.close', '关闭')}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <section>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
              <Keyboard size={14} className="text-muted-foreground" />
              {tr('im.screenshot.settings.hotkey', '截图快捷键')}
            </p>
            <button
              ref={recordRef}
              type="button"
              onClick={() => { setRecording(true); setError(''); recordRef.current?.focus() }}
              onKeyDown={onRecordKeyDown}
              onBlur={() => setRecording(false)}
              className={`flex h-11 w-full items-center justify-between rounded-xl border px-3 text-sm transition-colors cursor-pointer
                ${recording
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border/70 bg-background/60 hover:border-primary/50'}`}>
              <span className="font-mono font-semibold">{formatHotkey(draft.hotkey)}</span>
              <span className="text-[11px] text-muted-foreground">
                {recording
                  ? tr('im.screenshot.settings.recording', '请按下组合键…')
                  : tr('im.screenshot.settings.clickToRecord', '点击录制')}
              </span>
            </button>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {desktopMode
                ? tr('im.screenshot.settings.hotkeyHintDesktop',
                  '组合键为系统级快捷键：应用运行期间，在其它应用窗口按下也能唤起截图。')
                : tr('im.screenshot.settings.hotkeyHintWeb',
                  '组合键在本页面内生效；跨应用截图请安装桌面版。')}
            </p>
          </section>

          <section className="rounded-xl border border-border/60 bg-background/40 p-3">
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" className="mt-0.5 h-4 w-4"
                     checked={draft.hideImWindow}
                     onChange={event => setDraft(current => ({
                       ...current, hideImWindow: event.target.checked,
                     }))} />
              <span className="min-w-0">
                <span className="block text-xs font-medium">
                  {tr('im.screenshot.settings.hideImWindow', '隐藏窗口截图')}
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                  {tr('im.screenshot.settings.hideImWindowHint',
                    '开启后截图画面不出现当前会话窗口控件；关闭时可把会话窗口一起截进去。')}
                </span>
              </span>
            </label>
          </section>

          {error && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive">
              {errorText(error, tr)}
            </p>
          )}
          {notice && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-500">
              {notice}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border/60 px-4 py-3">
          <button type="button" disabled={busy}
                  onClick={() => {
                    setDraft(normalizeScreenshotSettings(DEFAULT_SCREENSHOT_SETTINGS))
                    setError('')
                    setNotice('')
                  }}
                  className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 cursor-pointer">
            <RotateCcw size={13} />
            {tr('im.screenshot.settings.reset', '恢复默认')}
          </button>
          <span className="flex-1" />
          <button type="button" onClick={onClose} disabled={busy}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-40 cursor-pointer">
            {tr('im.common.cancel', '取消')}
          </button>
          <button type="button" onClick={() => { void save() }} disabled={busy}
                  className="rounded-lg bg-primary px-4 py-1.5 text-xs text-primary-foreground hover:brightness-110 disabled:opacity-40 cursor-pointer">
            {tr('im.common.save', '保存')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
