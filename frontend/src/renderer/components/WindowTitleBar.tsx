/**
 * 桌面端（frameless 窗口）自绘标题栏。
 *
 * 桌面壳去掉了原生边框（launcher create_window frameless=True），窗口控制由本组件承担：
 * - 拖拽：标题区按下并移动超过阈值 → POST window-control drag，由壳层发
 *   WM_NCLBUTTONDOWN(HTCAPTION) 走**系统原生移动循环**（贴边最大化、侧边分屏、四分屏都靠它）。
 *   单击不触发拖动：最大化窗口若在按下瞬间就交给壳层，壳层会先还原窗口（单击也会"掉下来"）。
 *   双击标题区 = 最大化/还原。
 * - 按钮（仿原生窗口按钮，右对齐）：应用下载（原悬浮图标入口迁入）| 最小化 | 最大化/还原 | 关闭
 * - 缩放把手：frameless 后原生边缘拖拽消失，这里贴视口右/下/右下角三条热区，
 *   拖拽经 POST /desktop/window-control resize 交给壳层（壳层 clamp min_size）；
 *   最大化时隐藏。起始尺寸取 outerWidth/outerHeight 快照（CSS px 与壳层逻辑像素一致）
 * - 状态收敛：按钮动作响应带回 maximized；窗口 focus/visibilitychange 时 GET window-state
 *   校准一次（Win+↑/↓ 等系统路径经壳层 events 缓存自然正确），不轮询
 *
 * 仅 desktopMode 渲染（App.tsx 挂载，登录页也可见）；网页端不渲染、仍用悬浮下载图标。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Boxes, Download } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { desktopLoginApi } from '../services/api'
import { useDesktopStatusLabel } from './desktopStatusLabel'
import { AppDownloadDialog } from './AppDownloadDialog'

/** 原生风格窗口按钮：46x32（宽 x 高） */
const BUTTON_CLASS =
  'flex items-center justify-center h-full w-[46px] text-foreground hover:bg-foreground/10 transition-colors'

/** 按下后移动超过该距离才进入原生拖窗；低于阈值视为单击（不还原最大化窗口） */
const DRAG_START_THRESHOLD_PX = 4

type ResizeDir = 'e' | 's' | 'se'

type PendingDrag = {
  onMove: (e: MouseEvent) => void
  onUp: () => void
}

export function WindowTitleBar() {
  const { t } = useTranslation()
  const desktopMode = useAuthStore((s) => s.desktopMode)
  const desktopStatus = useDesktopStatusLabel()
  const [maximized, setMaximized] = useState(true) // 桌面启动即最大化
  const [showAppDownload, setShowAppDownload] = useState(false)
  /** 上一次标题栏按下的时间戳：用来判定双击（原生移动循环会吃掉 dblclick） */
  const lastDragDownRef = useRef(0)
  /** 已按下但尚未越过拖动阈值：单击时在这里收尾，不惊动壳层 */
  const pendingDragRef = useRef<PendingDrag | null>(null)
  const resizeRef = useRef<{
    dir: ResizeDir
    sx: number
    sy: number
    w0: number
    h0: number
    raf: number | null
    next: { w: number; h: number } | null
  } | null>(null)

  const sendResize = useCallback((w: number, h: number) => {
    desktopLoginApi
      .windowControl('resize', { width: Math.round(w), height: Math.round(h) })
      .then((res: any) => {
        if (typeof res?.data?.maximized === 'boolean') setMaximized(res.data.maximized)
      })
      .catch(() => {
        /* 非桌面壳/请求失败：静默（把手只在桌面端渲染） */
      })
  }, [])

  /** 按钮动作统一入口：响应带 maximized 时同步图标状态 */
  const control = useCallback((action: 'minimize' | 'toggle-maximize' | 'close') => {
    desktopLoginApi
      .windowControl(action)
      .then((res: any) => {
        if (typeof res?.data?.maximized === 'boolean') setMaximized(res.data.maximized)
      })
      .catch(() => {
        /* 壳层不可用（403/网络）：静默 */
      })
  }, [])

  /** 移除待定拖动的全局监听（松开/开始拖动/卸载时都要清） */
  const clearPendingDrag = useCallback(() => {
    const pending = pendingDragRef.current
    if (!pending) return
    window.removeEventListener('mousemove', pending.onMove)
    window.removeEventListener('mouseup', pending.onUp)
    pendingDragRef.current = null
  }, [])

  useEffect(() => clearPendingDrag, [clearPendingDrag])

  /**
   * 标题栏按下：先记下起点，移动超过阈值才把拖动交回壳层，由系统走自己的移动循环。
   *
   * 早先在 mousedown 就立即发 drag：最大化窗口会被壳层先 SW_RESTORE 再进入移动循环，
   * 于是**单击标题栏/上边缘**也会把窗口还原成小窗（用户报的"点一下就缩放"）。
   * 现在单击只做双击计时，不触发任何窗口动作；拖动 / 双击最大化还原的手感与原生标题栏一致。
   *
   * 双击在这里自己判定（320ms 内第二次按下）：原生移动循环会吃掉浏览器自己的 dblclick。
   */
  const onDragMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const now = Date.now()
      const isDouble = now - lastDragDownRef.current < 320
      lastDragDownRef.current = isDouble ? 0 : now
      clearPendingDrag()
      if (isDouble) {
        control('toggle-maximize')
        return
      }

      const startX = e.clientX
      const startY = e.clientY
      const onMove = (ev: MouseEvent) => {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_START_THRESHOLD_PX) return
        // 进入拖窗后本次按下不再参与双击判定（拖完松手后的下一次按下算单击）
        lastDragDownRef.current = 0
        clearPendingDrag()
        desktopLoginApi
          .windowControl('drag')
          .catch(() => {
            /* 旧版壳层没有该动作：本次拖动无效，其余功能不受影响 */
          })
      }
      const onUp = () => clearPendingDrag()
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      pendingDragRef.current = { onMove, onUp }
    },
    [clearPendingDrag, control],
  )

  // 窗口聚焦/标签页可见时向壳层校准一次最大化状态（不轮询）
  useEffect(() => {
    if (!desktopMode) return
    const sync = () => {
      desktopLoginApi
        .windowState()
        .then((res: any) => {
          if (typeof res?.data?.maximized === 'boolean') setMaximized(res.data.maximized)
        })
        .catch(() => {
          /* 非桌面壳：静默 */
        })
    }
    sync()
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync()
    }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [desktopMode])

  const onResizePointerDown = (dir: ResizeDir) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    resizeRef.current = {
      dir,
      sx: e.clientX,
      sy: e.clientY,
      w0: window.outerWidth,
      h0: window.outerHeight,
      raf: null,
      next: null,
    }
  }

  const onResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = resizeRef.current
    if (!d) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    d.next = {
      w: d.dir === 'e' || d.dir === 'se' ? d.w0 + dx : d.w0,
      h: d.dir === 's' || d.dir === 'se' ? d.h0 + dy : d.h0,
    }
    if (d.raf !== null) return
    // rAF 合并帧：一帧最多发一次本机请求，后发请求生效
    d.raf = requestAnimationFrame(() => {
      d.raf = null
      if (d.next) {
        sendResize(d.next.w, d.next.h)
        d.next = null
      }
    })
  }

  const onResizePointerUp = () => {
    const d = resizeRef.current
    if (d?.raf != null) cancelAnimationFrame(d.raf)
    resizeRef.current = null
  }

  if (!desktopMode) return null

  const title = desktopStatus?.title || t('common.appName', '网优引擎')

  return (
    <>
      <div
        data-app-titlebar
        className="relative z-[9998] flex h-8 flex-shrink-0 items-center border-b border-border/60 bg-background select-none"
      >
        {/* 拖拽区：交互交给壳层的原生标题栏拖动（见 onDragMouseDown） */}
        <div
          data-titlebar-drag
          className="flex h-full flex-1 items-center gap-2 overflow-hidden pl-2"
          onMouseDown={onDragMouseDown}
        >
          <Boxes size={16} className="shrink-0 text-primary" />
          <span className="truncate text-xs text-foreground">{title}</span>
        </div>
        {/* 窗口按钮：应用下载 | 最小化 | 最大化/还原 | 关闭（仿原生：透明底 hover 浅灰，关闭 hover 红） */}
        <div className="flex h-full items-stretch">
          <button
            className={BUTTON_CLASS}
            title={t('app.downloadTitle')}
            onClick={() => setShowAppDownload(true)}
          >
            <Download size={14} strokeWidth={1.5} />
          </button>
          <button
            className={BUTTON_CLASS}
            title={t('titleBar.minimize')}
            onClick={() => control('minimize')}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
            </svg>
          </button>
          <button
            className={BUTTON_CLASS}
            title={maximized ? t('titleBar.restore') : t('titleBar.maximize')}
            onClick={() => control('toggle-maximize')}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
                <rect x="2.5" y="0.5" width="7" height="3" fill="none" stroke="currentColor" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
              </svg>
            )}
          </button>
          <button
            className="flex h-full w-[46px] items-center justify-center text-foreground transition-colors hover:bg-[#c42b1c] hover:text-white"
            title={t('titleBar.close')}
            onClick={() => control('close')}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
        </div>
      </div>

      {/* 边缘缩放把手（仅非最大化）：贴视口右/下/右下角，拖拽经 window-control resize 交给壳层 */}
      {!maximized && (
        <>
          <div
            className="fixed top-8 right-0 bottom-[10px] z-[9997] w-[5px] cursor-ew-resize"
            onPointerDown={onResizePointerDown('e')}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
          />
          <div
            className="fixed right-[10px] bottom-0 left-0 z-[9997] h-[5px] cursor-ns-resize"
            onPointerDown={onResizePointerDown('s')}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
          />
          <div
            className="fixed right-0 bottom-0 z-[9997] h-[10px] w-[10px] cursor-nwse-resize"
            onPointerDown={onResizePointerDown('se')}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
          />
        </>
      )}

      <AppDownloadDialog open={showAppDownload} onClose={() => setShowAppDownload(false)} />
    </>
  )
}
