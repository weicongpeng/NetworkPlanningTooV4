/**
 * 全局 fixed 浮窗几何：拖拽 / 8 向缩放 / 视口钳制 / 最大化 / 按用户持久化。
 *
 * 「用户期望几何」（preferred，落盘）与「当前视口钳制后的显示几何」（rect）分开保存：
 * 桌面端切页面 / 地图全屏 / 窗口还原会让视口短暂变小，旧实现把钳制结果写回偏好，
 * 视口恢复后窗口也不会自己变回来（用户报的「切页面回来窗口自动缩小」）。
 * 现在 resize 只按偏好重新钳制，偏好只在用户主动拖拽 / 缩放 / 还原时更新；
 * 最大化状态单独持久化，窗口重新挂载后不会退回普通尺寸。
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

function maximizedKey(userId: number | null): string {
  return `im-window-maximized-user-${userId ?? 'anon'}`
}

/** 最大化矩形：铺满自绘标题栏以下的窗口内容区 */
function maximizedRect(topOffset: number): ImRect {
  return {
    x: EDGE, y: topOffset,
    w: window.innerWidth - EDGE * 2,
    h: window.innerHeight - topOffset - EDGE * 2,
  }
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

/** 读取用户期望几何；旧版本存的也是纯 ImRect，格式兼容 */
function loadPreferred(userId: number | null, topOffset: number): ImRect {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (raw) {
      const parsed = JSON.parse(raw) as ImRect
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number'
          && typeof parsed.w === 'number' && typeof parsed.h === 'number') {
        return parsed
      }
    }
  } catch { /* 几何损坏时回落到默认 */ }
  return defaultRect(topOffset)
}

function loadMaximized(userId: number | null): boolean {
  try { return localStorage.getItem(maximizedKey(userId)) === '1' } catch { return false }
}

function savePreferred(userId: number | null, rect: ImRect): void {
  try { localStorage.setItem(storageKey(userId), JSON.stringify(rect)) } catch { /* 隐私模式忽略 */ }
}

function saveMaximized(userId: number | null, value: boolean): void {
  try { localStorage.setItem(maximizedKey(userId), value ? '1' : '0') } catch { /* 隐私模式忽略 */ }
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
  // 懒初始化：localStorage 只在挂载时读一次，避免每次重渲染重复解析
  const initialRef = useRef<{
    preferred: ImRect; rect: ImRect; maximized: boolean
  } | null>(null)
  if (initialRef.current === null) {
    const preferred = loadPreferred(userId, topOffset)
    const maximized = loadMaximized(userId)
    initialRef.current = {
      preferred,
      rect: maximized ? maximizedRect(topOffset) : clampRect(preferred, topOffset),
      maximized,
    }
  }
  const initial = initialRef.current

  const [rect, setRect] = useState<ImRect>(initial.rect)
  const [maximized, setMaximized] = useState(initial.maximized)
  const rectRef = useRef(rect)
  /** 用户主动设定的尺寸：不随视口临时变化被改小 */
  const preferredRef = useRef<ImRect>(initial.preferred)
  const restoreRef = useRef<ImRect | null>(null)
  const elementRef = useRef<HTMLDivElement | null>(null)
  const topOffsetRef = useRef(topOffset)
  topOffsetRef.current = topOffset

  /**
   * 写入显示几何。只有 persist=true 才同步更新并落盘用户期望几何：
   * resize 造成的视口钳制必须传 false，否则视口一小窗口尺寸就被永久改小。
   */
  const commit = useCallback((next: ImRect, persist = true) => {
    const clamped = clampRect(next, topOffsetRef.current)
    rectRef.current = clamped
    applyDom(elementRef.current, clamped)
    setRect(clamped)
    if (persist) {
      preferredRef.current = next
      savePreferred(userId, next)
    }
  }, [userId])

  useEffect(() => {
    const onResize = () => {
      if (maximized) commit(maximizedRect(topOffsetRef.current), false)
      else commit(preferredRef.current, false)
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
      // 重新挂载后 restoreRef 为空，回落到最后保存的普通尺寸
      const restore = restoreRef.current || preferredRef.current
      restoreRef.current = null
      commit(restore)
      saveMaximized(userId, false)
      setMaximized(false)
    } else {
      restoreRef.current = { ...preferredRef.current }
      // 最大化矩形只是临时显示，不能覆盖用户偏好
      commit(maximizedRect(topOffsetRef.current), false)
      saveMaximized(userId, true)
      setMaximized(true)
    }
  }, [commit, maximized, userId])

  return {
    rect, elementRef,
    maximized,
    toggleMaximize,
    startDrag,
    startResize,
  }
}
