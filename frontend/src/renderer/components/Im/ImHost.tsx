/** 协作沟通全局入口：网页端悬浮图标（与「下载应用」同款）+ 懒加载窗口；桌面端入口在标题栏。 */
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, MessageSquare } from 'lucide-react'

import { desktopLoginApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'
import { attachImEvents, useImStore } from '../../store/imStore'
import { useToastStore } from '../../store/toastStore'
import { playImMentionSound } from '../../utils/messageSound'
import { ImScreenshotDialog } from './ImScreenshotDialog'
import {
  fireScreenshotHotkey, SCREENSHOT_HOTKEY_EVENT, SCREENSHOT_OPEN_EVENT,
} from './screenshotBus'

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
  const queueScreenshot = useImStore(s => s.queueScreenshot)

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

  // 截图快捷键 Alt+Z：应用级监听，只要应用在运行（不必打开协作沟通窗口 / 会话）即可唤起。
  // 桌面壳另注册了 Win32 全局热键，窗口不在前台时通过下方轮询投递同一事件。
  useEffect(() => {
    const trigger = () => {
      if (!user) return
      useImStore.getState().setOpen(true)
      setScreenshotOpen(true)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return
      if (event.code !== 'KeyZ' && event.key.toLowerCase() !== 'z') return
      event.preventDefault()
      event.stopPropagation()
      trigger()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener(SCREENSHOT_OPEN_EVENT, trigger)
    window.addEventListener(SCREENSHOT_HOTKEY_EVENT, trigger)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener(SCREENSHOT_OPEN_EVENT, trigger)
      window.removeEventListener(SCREENSHOT_HOTKEY_EVENT, trigger)
    }
  }, [user])

  // 桌面壳 RegisterHotKey(Alt+Z) 的序号增量；400ms 轮询，窗口最小化 / 后台也能触发
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

      {/* 截图弹窗挂在应用级：Alt+Z 在未打开协作沟通窗口 / 无激活会话时同样可用。
          确认后 File 进 imStore 队列，由当前会话的 ImComposer 自动加载为待发送附件。 */}
      <ImScreenshotDialog
        open={screenshotOpen}
        onClose={() => setScreenshotOpen(false)}
        onConfirm={file => {
          queueScreenshot(file)
          useImStore.getState().setOpen(true)
        }}
      />
    </>
  )
}
