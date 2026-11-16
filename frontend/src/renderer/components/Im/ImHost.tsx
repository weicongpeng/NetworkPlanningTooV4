/** 协作沟通全局入口：网页端悬浮图标（与「下载应用」同款）+ 懒加载窗口；桌面端入口在标题栏。 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, MessageSquare } from 'lucide-react'

import { desktopLoginApi } from '../../services/api'
import {
  IM_CLOUD_WS_ACTIVE_EVENT, IM_CLOUD_WS_FALLBACK_EVENT, imCloudWebSocket,
} from '../../services/imCloudWebSocket'
import { useAuthStore } from '../../store/authStore'
import { attachImEvents, useImStore } from '../../store/imStore'
import { useToastStore } from '../../store/toastStore'
import { playImMentionSound } from '../../utils/messageSound'
import { ImScreenshotDialog } from './ImScreenshotDialog'
import { ImScreenshotSettingsDialog } from './ImScreenshotSettingsDialog'
import {
  CAPTURE_FLAG, clearCaptureFlags, fireScreenshotHotkey, HOTKEY_RECORDING_FLAG,
  prepareScreenshotDom, SCREENSHOT_HOTKEY_EVENT, SCREENSHOT_OPEN_EVENT,
  SCREENSHOT_SETTINGS_EVENT, waitForStableFrames,
} from './screenshotBus'
import {
  getScreenshotSettings, matchesScreenshotHotkey, refreshScreenshotSettings,
} from './screenshotSettings'

const ImWindow = lazy(() => import('./ImWindow').then(module => ({ default: module.ImWindow })))

/** 与 MainLayout 的「下载应用」悬浮图标一致：w-11 h-11 = 44px */
const ICON_SIZE = 44
const MARGIN = 12

interface Pos { x: number; y: number }

function iconKey(userId: number | null): string {
  return `im-icon-pos-user-${userId ?? 'anon'}`
}

function defaultPos(): Pos {
  return {
    x: Math.max(MARGIN, window.innerWidth - ICON_SIZE - 16),
    y: Math.max(MARGIN, window.innerHeight - ICON_SIZE - 76),
  }
}

function loadPos(userId: number | null): Pos {
  try {
    const raw = localStorage.getItem(iconKey(userId))
    if (raw) {
      const parsed = JSON.parse(raw) as Pos
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed
    }
  } catch { /* 位置损坏时回落默认 */ }
  return defaultPos()
}

function clampPos(pos: Pos): Pos {
  return {
    x: Math.min(Math.max(pos.x, MARGIN), Math.max(MARGIN, window.innerWidth - ICON_SIZE - MARGIN)),
    y: Math.min(Math.max(pos.y, MARGIN), Math.max(MARGIN, window.innerHeight - ICON_SIZE - MARGIN)),
  }
}

export function ImHost() {
  const { t } = useTranslation()
  const user = useAuthStore(s => s.user)
  const desktopMode = useAuthStore(s => s.desktopMode)
  const desktopRunMode = useAuthStore(s => s.desktopRunMode)
  const open = useImStore(s => s.open)
  const setOpen = useImStore(s => s.setOpen)
  const toggleOpen = useImStore(s => s.toggleOpen)
  const unreadTotal = useImStore(s => s.unreadTotal)
  const mentionNotice = useImStore(s => s.mentionNotice)
  const [pos, setPos] = useState<Pos>(() => loadPos(user?.id ?? null))
  const posRef = useRef(pos)
  const iconRef = useRef<HTMLButtonElement | null>(null)
  const lastNoticeKeyRef = useRef<number | null>(null)
  const [hint, setHint] = useState('')
  const [screenshotOpen, setScreenshotOpen] = useState(false)
  const [screenshotBlob, setScreenshotBlob] = useState<Blob | null>(null)
  const [desktopCapture, setDesktopCapture] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const queueScreenshot = useImStore(s => s.queueScreenshot)
  // 壳层取景会话：基线序号 + 轮询定时器；gen 用于丢弃上一轮遗留的轮询回调
  const captureRef = useRef<{ seq: number; timer: number | null } | null>(null)
  const captureGenRef = useRef(0)
  const hideImRef = useRef(false)

  // 仅明确为单机模式时隐藏；探测阶段（null）保持可用，避免桌面共享模式误伤
  const standalone = desktopMode && desktopRunMode === 'standalone'

  // 被 @ 的即时提醒：Toast 文案在组件层翻译（store 不依赖 react-i18next），
  // 提示音走专用的上行三音，与普通消息「叮咚」互斥。
  useEffect(() => {
    if (!mentionNotice || lastNoticeKeyRef.current === mentionNotice.key) return
    lastNoticeKeyRef.current = mentionNotice.key
    useToastStore.getState().show(t(
      mentionNotice.mentionAll ? 'im.mention.noticeAll' : 'im.mention.notice',
      {
        defaultValue: mentionNotice.mentionAll
          ? '{{sender}} 在项目沟通中 @ 了所有人'
          : '{{sender}} 在项目沟通中 @ 了你',
        sender: mentionNotice.senderName || t('im.mention.someone', '有人'),
      },
    ))
    playImMentionSound()
  }, [mentionNotice, t])

  useEffect(() => {
    const next = clampPos(loadPos(user?.id ?? null))
    posRef.current = next
    setPos(next)
  }, [user?.id])

  useEffect(() => {
    // 单机模式没有跨用户通信能力：不注册事件、不请求、不轮询
    if (!user || standalone) return
    const detach = attachImEvents()
    void useImStore.getState().bootstrap()
    // 桌面共享模式没有服务端 WS 广播，消息全靠本机后端转发到云端 relay：
    // 用 1.5s 高频轮询会话列表，且窗口收起/失焦也不停（单机模式不走这段逻辑）。
    // 消息一落地就把未读数推到标题栏「项目沟通」红点并触发提示音；窗口重新
    // 可见时 startPolling 还会立即补刷一次，避免等下一个 tick。
    useImStore.getState().startPolling(desktopMode ? 1500 : 15000, desktopMode)
    return detach
  }, [user, desktopMode, standalone])

  useEffect(() => {
    const onResize = () => {
      const next = clampPos(posRef.current)
      posRef.current = next
      setPos(next)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /** 结束一轮取景：停轮询、无条件恢复所有浮层、让上一轮遗留回调全部失效 */
  const stopCapture = useCallback(() => {
    captureGenRef.current += 1
    const capture = captureRef.current
    if (capture && capture.timer !== null) window.clearTimeout(capture.timer)
    captureRef.current = null
    clearCaptureFlags()
    hideImRef.current = false
  }, [])

  const closeScreenshot = useCallback(() => {
    if (captureRef.current) {
      // 用户提前关窗：中止仍在进行中的壳层蒙层，避免置顶窗口残留
      void desktopLoginApi.screenshotCancel().catch(() => { /* 会话已结束 */ })
    }
    stopCapture()
    setScreenshotOpen(false)
    setScreenshotBlob(null)
    setDesktopCapture(false)
  }, [stopCapture])

  /** 壳层未注入 / 非 Windows：完整退回网页端原有的共享窗口选择流程 */
  const fallbackToWebCapture = useCallback(() => {
    stopCapture()
    setDesktopCapture(false)
    setScreenshotBlob(null)
    setScreenshotOpen(true)
  }, [stopCapture])

  const pollCaptureResult = useCallback((seq: number, gen: number) => {
    const startedAt = Date.now()
    const tick = async () => {
      if (gen !== captureGenRef.current) return
      if (Date.now() - startedAt > 60000) { closeScreenshot(); return }
      try {
        const response = await desktopLoginApi.screenshotResult(seq)
        const data = response?.data
        if (data?.ready) {
          const blob = await desktopLoginApi.screenshotImage()
          stopCapture()
          if (blob) {
            setDesktopCapture(true)
            setScreenshotBlob(blob)
            setScreenshotOpen(true)
          } else closeScreenshot()
          return
        }
        if (data?.cancelled) { closeScreenshot(); return }
      } catch { /* 旧壳 / 网络抖动，等下一次轮询 */ }
      const capture = captureRef.current
      if (!capture || gen !== captureGenRef.current) return
      capture.timer = window.setTimeout(() => { void tick() }, 400)
    }
    const capture = captureRef.current
    if (capture) capture.timer = window.setTimeout(() => { void tick() }, 250)
  }, [stopCapture, closeScreenshot])

  /**
   * 桌面端发起壳层取景：按「屏幕原样」抓取 —— 不主动打开会话窗口，只保证
   * 当前屏幕上已存在的浮层（含已打开的会话窗口）能完整出现在冻结帧里。
   * 抓屏前先做 DOM 稳定化并等两个渲染帧，壳层收到 frame_ready 才允许 ImageGrab。
   */
  const startDesktopCapture = useCallback(async () => {
    const settings = getScreenshotSettings()
    stopCapture()
    setScreenshotBlob(null)
    setScreenshotOpen(false)                       // 关掉 z-[10000] 的编辑页遮罩
    prepareScreenshotDom(settings.hideImWindow)   // 收起下拉 / 清残留标记 / 按开关设隐藏
    hideImRef.current = settings.hideImWindow
    const gen = captureGenRef.current
    await waitForStableFrames()
    // 等待期间可能被重复触发或关闭：旧轮不得再发 POST，也不能误杀新一轮的标记
    if (gen !== captureGenRef.current) return
    // 遮罩或取景标记仍在说明 React 批处理比预期慢一帧，再等一轮再抓屏
    if (document.body.hasAttribute(CAPTURE_FLAG)
        || document.querySelector('[data-screenshot-overlay]')) {
      await waitForStableFrames()
      if (gen !== captureGenRef.current) return
    }
    try {
      const response = await desktopLoginApi.screenshotCapture(settings.hideImWindow, true)
      if (gen !== captureGenRef.current) return
      const data = response?.data
      if (!data?.started) {
        if (data?.busy) {
          // 已有蒙层在取景（重复触发）：复用当前序号继续等结果，别把这一轮截图丢掉
          const pendingSeq = Number(data.seq || 0)
          captureRef.current = { seq: pendingSeq, timer: null }
          setDesktopCapture(true)
          pollCaptureResult(pendingSeq, gen)
          return
        }
        fallbackToWebCapture()            // 非 Windows 壳 / 旧版本：降级
        return
      }
      const seq = Number(data.seq || 0)
      captureRef.current = { seq, timer: null }
      setDesktopCapture(true)
      pollCaptureResult(seq, gen)
    } catch {
      if (gen === captureGenRef.current) fallbackToWebCapture()
    }
  }, [stopCapture, fallbackToWebCapture, pollCaptureResult])

  /**
   * 截图统一入口：桌面端走壳层取景，网页端保留 getDisplayMedia 窗口选择。
   * 桌面端「不强行开窗」——保持屏幕原样，确认截图后才由 onConfirm 展开会话窗口。
   */
  const triggerScreenshot = useCallback(() => {
    if (!user) return
    if (useAuthStore.getState().desktopMode) {
      void startDesktopCapture()
    } else {
      setDesktopCapture(false)
      setScreenshotBlob(null)
      setScreenshotOpen(true)
    }
  }, [user, startDesktopCapture])

  // 应用级快捷键：组合键读共享配置（网页端与桌面端同一份），不必打开会话也能唤起。
  // 桌面壳另注册了 Win32 全局热键，其它应用窗口 / 窗口后台时通过下方轮询投递同一事件。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 设置面板录制快捷键时让路：按下当前组合键不应直接开始截图
      if (document.body.hasAttribute(HOTKEY_RECORDING_FLAG)) return
      if (!matchesScreenshotHotkey(event, getScreenshotSettings())) return
      event.preventDefault()
      event.stopPropagation()
      triggerScreenshot()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener(SCREENSHOT_OPEN_EVENT, triggerScreenshot)
    window.addEventListener(SCREENSHOT_HOTKEY_EVENT, triggerScreenshot)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener(SCREENSHOT_OPEN_EVENT, triggerScreenshot)
      window.removeEventListener(SCREENSHOT_HOTKEY_EVENT, triggerScreenshot)
    }
  }, [triggerScreenshot])

  // 桌面端从壳层拉权威配置（快捷键可能被设置面板改过）；网页端沿用 localStorage
  useEffect(() => { void refreshScreenshotSettings(Boolean(desktopMode)) }, [desktopMode])

  useEffect(() => {
    const onOpenSettings = () => setSettingsOpen(true)
    window.addEventListener(SCREENSHOT_SETTINGS_EVENT, onOpenSettings)
    return () => window.removeEventListener(SCREENSHOT_SETTINGS_EVENT, onOpenSettings)
  }, [])

  // 组件卸载兜底：停轮询并无条件恢复所有浮层
  useEffect(() => () => {
    const capture = captureRef.current
    if (capture && capture.timer !== null) window.clearTimeout(capture.timer)
    captureRef.current = null
    clearCaptureFlags()
  }, [])

  /**
   * 桌面共享模式直连云端 WS 接收 im_message 轻通知：鉴权成功后停掉 1.5s relay 轮询，
   * 旧服务端 / 许可失效 / Tunnel 抖动则自动恢复轮询。单机模式与网页端不启用。
   * 监听必须先于 start() 注册：配置不可用时客户端会同步派发 fallback 事件。
   */
  useEffect(() => {
    if (!user || !desktopMode || standalone) return
    const onActive = () => useImStore.getState().stopPolling()
    const onFallback = () => useImStore.getState().startPolling(1500, true)
    window.addEventListener(IM_CLOUD_WS_ACTIVE_EVENT, onActive)
    window.addEventListener(IM_CLOUD_WS_FALLBACK_EVENT, onFallback)
    void imCloudWebSocket.start()
    return () => {
      window.removeEventListener(IM_CLOUD_WS_ACTIVE_EVENT, onActive)
      window.removeEventListener(IM_CLOUD_WS_FALLBACK_EVENT, onFallback)
      imCloudWebSocket.stop()
    }
  }, [user, desktopMode, standalone])

  // 桌面壳 Win32 全局热键（组合键可配置）的序号增量；400ms 轮询，
  // 窗口最小化 / 在其它应用窗口时也能触发截图 —— 只要应用进程不关闭就始终生效
  useEffect(() => {
    if (!desktopMode) return
    let baseline: number | null = null
    let inFlight = false
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const response = await desktopLoginApi.screenshotHotkey()
        const seq = Number(response?.data?.seq ?? 0)
        if (baseline === null) baseline = seq
        else if (seq > baseline) { baseline = seq; fireScreenshotHotkey() }
      } catch { /* 非桌面壳 / 网络抖动，忽略本次 */ }
      finally { inFlight = false }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 400)
    return () => window.clearInterval(timer)
  }, [desktopMode])

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const origin = { px: event.clientX, py: event.clientY, pos: { ...posRef.current } }
    let moved = false
    let latest = origin.pos

    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - origin.px
      const dy = move.clientY - origin.py
      if (!moved && Math.hypot(dx, dy) < 4) return
      moved = true
      latest = clampPos({ x: origin.pos.x + dx, y: origin.pos.y + dy })
      if (iconRef.current) {
        iconRef.current.style.left = `${latest.x}px`
        iconRef.current.style.top = `${latest.y}px`
      }
    }
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      if (!moved) {
        toggleOpen()
        return
      }
      const snapped = clampPos({
        x: latest.x + ICON_SIZE / 2 < window.innerWidth / 2 ? MARGIN : window.innerWidth - ICON_SIZE - MARGIN,
        y: latest.y,
      })
      posRef.current = snapped
      setPos(snapped)
      try { localStorage.setItem(iconKey(user?.id ?? null), JSON.stringify(snapped)) } catch { /* 忽略 */ }
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }

  if (!user) return null

  return (
    <>
      {/* 网页端：样式/尺寸对齐 MainLayout 的「下载应用」悬浮图标。
          桌面端入口在自绘标题栏 WindowTitleBar 的下载按钮左侧，这里不再渲染悬浮图标，
          但下方（useEffect + ImWindow）的事件注册、轮询与窗口渲染必须保留。 */}
      {!desktopMode && (
        <button
          ref={iconRef}
          type="button"
          data-im-fab
          onPointerDown={onPointerDown}
          onMouseEnter={() => setHint(t('im.host.hint', '项目沟通 · 消息与通讯录'))}
          onMouseLeave={() => setHint('')}
          title={t('im.host.title', '项目沟通（拖动可移动，单击展开）')}
          className="group fixed z-[2900] flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-lg transition-colors hover:bg-muted hover:text-foreground cursor-grab active:cursor-grabbing touch-none select-none"
          style={{ left: pos.x, top: pos.y, width: ICON_SIZE, height: ICON_SIZE, touchAction: 'none' }}
        >
          <MessageSquare size={18} />
          {unreadTotal > 0 && (
            <span className="absolute -right-1 -top-1 flex h-[19px] min-w-[19px] items-center justify-center rounded-full border-2 border-card bg-red-500 px-1 text-[10px] font-semibold leading-none text-white shadow-sm">
              {unreadTotal > 99 ? '99+' : unreadTotal}
            </span>
          )}
          {hint && (
            <span className="pointer-events-none absolute right-[52px] whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1 text-[11px] text-popover-foreground shadow-lg">
              {hint}
            </span>
          )}
        </button>
      )}

      {open && !standalone && (
        <Suspense fallback={
          <div data-im-fab className="fixed bottom-24 right-6 z-[6000] flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-xs shadow-2xl">
            <Loader2 size={15} className="animate-spin text-primary" />
            {t('im.host.opening', '正在打开项目沟通…')}
          </div>
        }>
          <ImWindow userId={user.id ?? null} desktopMode={desktopMode} onClose={() => setOpen(false)} />
        </Suspense>
      )}

      {/* 截图弹窗挂在应用级：快捷键在未打开协作沟通窗口 / 无激活会话时同样可用。
          桌面端用壳层裁剪出的 PNG 直接进编辑页（不弹共享窗口选择器），
          确认后 File 进 imStore 队列，由当前会话的 ImComposer 自动加载为待发送附件。 */}
      <ImScreenshotDialog
        open={screenshotOpen}
        onClose={closeScreenshot}
        onConfirm={file => {
          queueScreenshot(file)
          useImStore.getState().setOpen(true)
        }}
        initialBlob={screenshotBlob}
        onInitialConsumed={() => setScreenshotBlob(null)}
        captureMode={desktopCapture ? 'desktop' : 'web'}
        onRecapture={() => { void startDesktopCapture() }}
      />
      <ImScreenshotSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        desktopMode={Boolean(desktopMode)}
      />
    </>
  )
}
