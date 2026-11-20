import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export interface ImDialogOffset { x: number; y: number }
interface BaseRect { left: number; top: number; width: number; height: number }

const EDGE = 8

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

/** 图片浏览/编辑浮层共用：默认还原尺寸，工具栏空白区左键拖动，最大化时锁定位置。 */
export function useImDialogGeometry(open: boolean, topOffset: number) {
  const [maximized, setMaximized] = useState(false)
  const [offset, setOffset] = useState<ImDialogOffset>({ x: 0, y: 0 })
  const panelRef = useRef<HTMLDivElement | null>(null)
  const offsetRef = useRef(offset)
  const topOffsetRef = useRef(topOffset)
  offsetRef.current = offset
  topOffsetRef.current = topOffset

  useEffect(() => {
    if (!open) return
    setMaximized(false)
    setOffset({ x: 0, y: 0 })
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

  return {
    panelRef, maximized,
    toggleMaximize: () => setMaximized(value => !value),
    startDrag,
    panelStyle: maximized ? undefined : { transform: `translate(${offset.x}px, ${offset.y}px)` },
  }
}
