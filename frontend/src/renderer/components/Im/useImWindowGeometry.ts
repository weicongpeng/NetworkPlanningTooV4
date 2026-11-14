/** 全局 fixed 浮窗几何：拖拽 / 8 向缩放 / 视口钳制 / 最大化 / 按用户持久化。
 * 拖拽期间直接改 DOM style 且不触发 React 重渲染，松手才提交状态，保证不掉帧。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export interface ImRect { x: number; y: number; w: number; h: number }
export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const MIN_W = 420
const MIN_H = 360
const DEFAULT_W = 900
const DEFAULT_H = 620
const EDGE = 8

function storageKey(userId: number | null): string {
  return `im-window-geometry-user-${userId ?? 'anon'}`
}

function defaultRect(topOffset: number): ImRect {
  const w = Math.min(DEFAULT_W, Math.max(MIN_W, window.innerWidth - EDGE * 2))
  const h = Math.min(DEFAULT_H, Math.max(MIN_H, window.innerHeight - topOffset - EDGE * 2))
  return {
    x: Math.max(EDGE, window.innerWidth - w - 24),
    y: Math.max(topOffset, window.innerHeight - h - 88),
    w, h,
  }
}

function loadRect(userId: number | null, topOffset: number): ImRect {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (raw) {
      const parsed = JSON.parse(raw) as ImRect
      if (typeof parsed.x === 'number' && typeof parsed.w === 'number') {
        return clampRect(parsed, topOffset)
      }
    }
  } catch { /* 几何损坏时回落到默认 */ }
  return defaultRect(topOffset)
}

function clampRect(rect: ImRect, topOffset: number): ImRect {
  const maxW = Math.max(MIN_W, window.innerWidth - EDGE * 2)
  const maxH = Math.max(MIN_H, window.innerHeight - topOffset - EDGE * 2)
  const w = Math.min(Math.max(rect.w, MIN_W), maxW)
  const h = Math.min(Math.max(rect.h, MIN_H), maxH)
  const x = Math.min(Math.max(rect.x, EDGE), Math.max(EDGE, window.innerWidth - w - EDGE))
  const y = Math.min(Math.max(rect.y, topOffset), Math.max(topOffset, window.innerHeight - h - EDGE))
  return { x, y, w, h }
}

function applyDom(element: HTMLElement | null, rect: ImRect): void {
  if (!element) return
  element.style.left = `${rect.x}px`
  element.style.top = `${rect.y}px`
  element.style.width = `${rect.w}px`
  element.style.height = `${rect.h}px`
}

export function useImWindowGeometry(userId: number | null, topOffset: number) {
  const [rect, setRect] = useState<ImRect>(() => loadRect(userId, topOffset))
  const [maximized, setMaximized] = useState(false)
  const rectRef = useRef(rect)
  const restoreRef = useRef<ImRect | null>(null)
  const elementRef = useRef<HTMLDivElement | null>(null)
  const topOffsetRef = useRef(topOffset)
  topOffsetRef.current = topOffset

  const commit = useCallback((next: ImRect) => {
    const clamped = clampRect(next, topOffsetRef.current)
    rectRef.current = clamped
    applyDom(elementRef.current, clamped)
    setRect(clamped)
    try { localStorage.setItem(storageKey(userId), JSON.stringify(clamped)) } catch { /* 隐私模式忽略 */ }
  }, [userId])

  useEffect(() => {
    const onResize = () => {
      if (maximized) {
        commit({ x: EDGE, y: topOffsetRef.current, w: window.innerWidth - EDGE * 2,
                 h: window.innerHeight - topOffsetRef.current - EDGE * 2 })
      } else {
        commit(rectRef.current)
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [commit, maximized])

  // 拖拽期间只改 DOM 不 setState；若此时因新消息等触发 React 重渲染，
  // style prop 会用旧 rect 覆盖位置，这里在每次渲染后立即用 ref 的最新几何写回。
  useLayoutEffect(() => {
    applyDom(elementRef.current, rectRef.current)
  })

  const startDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (maximized || event.button !== 0) return
    const target = event.currentTarget
    if ((event.target as HTMLElement).closest('[data-im-no-drag]')) return
    target.setPointerCapture(event.pointerId)
    const origin = { px: event.clientX, py: event.clientY, rect: { ...rectRef.current } }
    let latest = origin.rect

    const onMove = (move: PointerEvent) => {
      latest = clampRect({
        ...origin.rect,
        x: origin.rect.x + move.clientX - origin.px,
        y: origin.rect.y + move.clientY - origin.py,
      }, topOffsetRef.current)
      rectRef.current = latest
      applyDom(elementRef.current, latest)
    }
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      commit(latest)
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }, [commit, maximized])

  const startResize = useCallback((event: ReactPointerEvent<HTMLElement>, dir: ResizeDir) => {
    if (maximized || event.button !== 0) return
    event.stopPropagation()
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const origin = { px: event.clientX, py: event.clientY, rect: { ...rectRef.current } }
    let latest = origin.rect

    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - origin.px
      const dy = move.clientY - origin.py
      const r = origin.rect
      let { x, y, w, h } = r
      if (dir.includes('e')) w = r.w + dx
      if (dir.includes('s')) h = r.h + dy
      if (dir.includes('w')) { w = r.w - dx; x = r.x + dx }
      if (dir.includes('n')) { h = r.h - dy; y = r.y + dy }
      if (w < MIN_W) { if (dir.includes('w')) x -= (MIN_W - w); w = MIN_W }
      if (h < MIN_H) { if (dir.includes('n')) y -= (MIN_H - h); h = MIN_H }
      latest = clampRect({ x, y, w, h }, topOffsetRef.current)
      rectRef.current = latest
      applyDom(elementRef.current, latest)
    }
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      commit(latest)
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }, [commit, maximized])

  const toggleMaximize = useCallback(() => {
    if (maximized) {
      commit(restoreRef.current || defaultRect(topOffsetRef.current))
      restoreRef.current = null
      setMaximized(false)
    } else {
      restoreRef.current = { ...rectRef.current }
      commit({ x: EDGE, y: topOffsetRef.current, w: window.innerWidth - EDGE * 2,
               h: window.innerHeight - topOffsetRef.current - EDGE * 2 })
      setMaximized(true)
    }
  }, [commit, maximized])

  return {
    rect, elementRef,
    maximized,
    toggleMaximize,
    startDrag,
    startResize,
  }
}
