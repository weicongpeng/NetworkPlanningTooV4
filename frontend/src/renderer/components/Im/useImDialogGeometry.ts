import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export interface ImDialogOffset { x: number; y: number }
interface BaseRect { left: number; top: number; width: number; height: number }

const EDGE = 8
const MIN_W = 420
const MIN_H = 300

export type ImResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * 8 向缩放热区：图片浏览/编辑浮层共用。绝对定位在面板边缘，
 * 面板自身需带 `relative`，由各组件在面板内渲染并绑定 startResize。
 */
export const IM_DIALOG_RESIZE_HANDLES: { dir: ImResizeDir; className: string }[] = [
  { dir: 'n', className: 'left-3 right-3 top-0 h-1.5 cursor-n-resize' },
  { dir: 's', className: 'bottom-0 left-3 right-3 h-1.5 cursor-s-resize' },
  { dir: 'e', className: 'bottom-3 right-0 top-3 w-1.5 cursor-e-resize' },
  { dir: 'w', className: 'bottom-3 left-0 top-3 w-1.5 cursor-w-resize' },
  { dir: 'ne', className: 'right-0 top-0 h-3 w-3 cursor-nesw-resize' },
  { dir: 'nw', className: 'left-0 top-0 h-3 w-3 cursor-nwse-resize' },
  { dir: 'se', className: 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize' },
  { dir: 'sw', className: 'bottom-0 left-0 h-3 w-3 cursor-nesw-resize' },
]

export function clampImDialogOffset(
  offset: ImDialogOffset,
  baseRect: BaseRect,
  viewportWidth: number,
  viewportHeight: number,
  topOffset = 0,
): ImDialogOffset {
  const minX = EDGE - baseRect.left
  const maxX = viewportWidth - EDGE - baseRect.left - baseRect.width
  const minY = topOffset + EDGE - baseRect.top
  const maxY = viewportHeight - EDGE - baseRect.top - baseRect.height
  return {
    x: minX <= maxX ? Math.min(maxX, Math.max(minX, offset.x)) : minX,
    y: minY <= maxY ? Math.min(maxY, Math.max(minY, offset.y)) : minY,
  }
}

/** 图片浏览/编辑浮层共用：拖动、8 向缩放、视口钳制；最大化时锁定几何。 */
export function useImDialogGeometry(open: boolean, topOffset: number) {
  const [maximized, setMaximized] = useState(false)
  const [offset, setOffset] = useState<ImDialogOffset>({ x: 0, y: 0 })
  // null 表示沿用各自的默认尺寸类；用户拖拽过手柄后改用显式像素尺寸
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const offsetRef = useRef(offset)
  const topOffsetRef = useRef(topOffset)
  const sizeRef = useRef(size)
  offsetRef.current = offset
  topOffsetRef.current = topOffset
  sizeRef.current = size

  useEffect(() => {
    if (!open) return
    setMaximized(false)
    setOffset({ x: 0, y: 0 })
    setSize(null)
  }, [open])

  useEffect(() => {
    const onResize = () => {
      const panel = panelRef.current
      if (!panel || maximized) return
      const current = offsetRef.current
      const rect = panel.getBoundingClientRect()
      const next = clampImDialogOffset(current, {
        left: rect.left - current.x, top: rect.top - current.y,
        width: rect.width, height: rect.height,
      }, window.innerWidth, window.innerHeight, topOffsetRef.current)
      offsetRef.current = next
      setOffset(next)
      // 视口缩小后同步收窄用户设定的尺寸，避免窗口被顶出可视区
      const preferred = sizeRef.current
      if (preferred) {
        const w = Math.min(preferred.w, Math.max(MIN_W, window.innerWidth - EDGE * 2))
        const h = Math.min(
          preferred.h, Math.max(MIN_H, window.innerHeight - topOffsetRef.current - EDGE * 2),
        )
        if (w !== preferred.w || h !== preferred.h) setSize({ w, h })
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [maximized])

  const startDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (maximized || event.button !== 0) return
    const target = event.currentTarget
    const originTarget = event.target as HTMLElement | null
    if (originTarget?.closest('button, input, label, select, textarea, [data-im-no-drag]')) return
    const panel = panelRef.current
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    const current = offsetRef.current
    const origin = {
      px: event.clientX, py: event.clientY, offset: current,
      baseRect: {
        left: rect.left - current.x, top: rect.top - current.y,
        width: rect.width, height: rect.height,
      },
    }
    try { target.setPointerCapture(event.pointerId) } catch { /* 旧 WebView 可能未实现 */ }

    const onMove = (move: PointerEvent) => {
      const next = clampImDialogOffset({
        x: origin.offset.x + move.clientX - origin.px,
        y: origin.offset.y + move.clientY - origin.py,
      }, origin.baseRect, window.innerWidth, window.innerHeight, topOffsetRef.current)
      offsetRef.current = next
      setOffset(next)
    }
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      target.removeEventListener('lostpointercapture', onUp)
      try {
        if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId)
      } catch { /* 捕获已释放 */ }
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
    target.addEventListener('lostpointercapture', onUp)
  }, [maximized])

  /** 从边缘/角手柄拖拽改尺寸：固定对侧边，钳制最小尺寸与视口边界。 */
  const startResize = useCallback((event: ReactPointerEvent<HTMLElement>, dir: ImResizeDir) => {
    if (maximized || event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    const panel = panelRef.current
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    const target = event.currentTarget
    const origin = {
      px: event.clientX, py: event.clientY,
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    }
    try { target.setPointerCapture(event.pointerId) } catch { /* 旧 WebView 可能未实现 */ }

    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - origin.px
      const dy = move.clientY - origin.py
      let { left, top, width, height } = origin
      if (dir.includes('e')) width = origin.width + dx
      if (dir.includes('s')) height = origin.height + dy
      if (dir.includes('w')) { width = origin.width - dx; left = origin.left + dx }
      if (dir.includes('n')) { height = origin.height - dy; top = origin.top + dy }
      if (width < MIN_W) { if (dir.includes('w')) left -= MIN_W - width; width = MIN_W }
      if (height < MIN_H) { if (dir.includes('n')) top -= MIN_H - height; height = MIN_H }
      const viewportW = window.innerWidth
      const viewportH = window.innerHeight
      const topInset = topOffsetRef.current
      width = Math.min(width, Math.max(MIN_W, viewportW - EDGE * 2))
      height = Math.min(height, Math.max(MIN_H, viewportH - topInset - EDGE * 2))
      left = Math.min(Math.max(left, EDGE), Math.max(EDGE, viewportW - width - EDGE))
      top = Math.min(Math.max(top, topInset), Math.max(topInset, viewportH - height - EDGE))
      // 面板由 m-auto 居中，把绝对位置换算回「居中基准 + translate」
      const baseLeft = (viewportW - width) / 2
      const baseTop = topInset + (viewportH - topInset - height) / 2
      const next = { x: left - baseLeft, y: top - baseTop }
      offsetRef.current = next
      setOffset(next)
      setSize({ w: width, h: height })
    }
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      target.removeEventListener('lostpointercapture', onUp)
      try {
        if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId)
      } catch { /* 捕获已释放 */ }
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
    target.addEventListener('lostpointercapture', onUp)
  }, [maximized])

  return {
    panelRef, maximized, size,
    toggleMaximize: () => setMaximized(value => !value),
    startDrag,
    startResize,
    panelStyle: maximized ? undefined : {
      transform: `translate(${offset.x}px, ${offset.y}px)`,
      ...(size ? { width: size.w, height: size.h } : {}),
    },
  }
}
