/**
 * 地图页内浮动面板：标题栏可拖拽、8 向边缘/角可调整尺寸。
 *
 * - absolute 定位在最近的 positioned 祖先（地图容器 relative）内，不遮挡地图、
 *   弹框打开时地图仍可正常交互。
 * - 纯 Pointer Events 实现（含 touch），位置/尺寸用 localStorage 持久化。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'

export interface FloatingRect {
  x: number
  y: number
  width: number
  height: number
}

interface FloatingPanelProps {
  title: ReactNode
  onClose: () => void
  initialRect: FloatingRect
  minSize?: { width: number; height: number }
  /** 几何持久化 key（不传则不持久化） */
  storageKey?: string
  /** 约束范围元素（默认面板的 offsetParent，即最近 positioned 祖先） */
  getBounds?: () => HTMLElement | null
  children: ReactNode
  /** 内容区额外类名（背景/内边距等） */
  className?: string
}

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface Interaction {
  kind: 'move' | 'resize'
  edge?: ResizeEdge
  pointerId: number
  startX: number
  startY: number
  rect: FloatingRect
  bw: number
  bh: number
}

const CURSORS: Record<ResizeEdge, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
}

/** 默认最小尺寸（模块级常量，引用稳定，避免每次渲染新建对象触发 effect） */
const DEFAULT_MIN_SIZE = { width: 420, height: 360 }

function loadRect(storageKey: string | undefined, initial: FloatingRect): FloatingRect {
  if (!storageKey) return initial
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw) return { ...initial, ...(JSON.parse(raw) as Partial<FloatingRect>) }
  } catch { /* ignore */ }
  return initial
}

export function FloatingPanel({
  title,
  onClose,
  initialRect,
  minSize = DEFAULT_MIN_SIZE,
  storageKey,
  getBounds,
  children,
  className = '',
}: FloatingPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const interactionRef = useRef<Interaction | null>(null)
  const [rect, setRect] = useState<FloatingRect>(() => loadRect(storageKey, initialRect))

  // 不稳定入参（调用方常传内联箭头/对象）放进 ref，绝不进 effect 依赖，
  // 否则每次渲染引用都变 → effect 重跑 → setRect(新对象) → 无限循环（React #185）。
  const getBoundsRef = useRef(getBounds)
  getBoundsRef.current = getBounds
  const minSizeRef = useRef(minSize)
  minSizeRef.current = minSize

  const resolveBoundsEl = useCallback((): HTMLElement | null => {
    const g = getBoundsRef.current
    if (g) return g()
    return (panelRef.current?.offsetParent as HTMLElement | null) ?? null
  }, [])

  // 把面板钳制回容器内；值没变时返回原对象（React 据此 bail out，不重渲染）
  const clampIntoBounds = useCallback(() => {
    const el = resolveBoundsEl()
    if (!el) return
    setRect(prev => {
      const next = clampRect(prev, el.clientWidth, el.clientHeight, minSizeRef.current)
      return equalRect(prev, next) ? prev : next
    })
  }, [resolveBoundsEl])

  // 挂载时钳一次 + 窗口尺寸变化时重新钳（依赖稳定，不会每渲染触发）
  useLayoutEffect(() => {
    clampIntoBounds()
    window.addEventListener('resize', clampIntoBounds)
    return () => window.removeEventListener('resize', clampIntoBounds)
  }, [clampIntoBounds])

  // 几何持久化
  useEffect(() => {
    if (!storageKey) return
    try { localStorage.setItem(storageKey, JSON.stringify(rect)) } catch { /* ignore */ }
  }, [rect, storageKey])

  const begin = useCallback((e: React.PointerEvent, kind: 'move' | 'resize', edge?: ResizeEdge) => {
    if (e.button !== 0) return
    const el = resolveBoundsEl()
    interactionRef.current = {
      kind,
      edge,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      rect: { ...rect },
      bw: el?.clientWidth ?? window.innerWidth,
      bh: el?.clientHeight ?? window.innerHeight,
    }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }, [rect, resolveBoundsEl])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const it = interactionRef.current
    if (!it || e.pointerId !== it.pointerId) return
    const dx = e.clientX - it.startX
    const dy = e.clientY - it.startY
    if (it.kind === 'move') {
      setRect(clampRect({ ...it.rect, x: it.rect.x + dx, y: it.rect.y + dy }, it.bw, it.bh, minSize))
    } else if (it.edge) {
      setRect(applyResize(it.rect, it.edge, dx, dy, it.bw, it.bh, minSize))
    }
  }, [minSize])

  const end = useCallback((e: React.PointerEvent) => {
    const it = interactionRef.current
    if (!it || e.pointerId !== it.pointerId) return
    interactionRef.current = null
  }, [])

  // Esc 关闭（输入控件聚焦时不拦截，避免误触）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (t?.isContentEditable) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      ref={panelRef}
      className={`absolute z-[5000] flex flex-col bg-card border border-border rounded-lg shadow-lg ${className}`}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      {/* 标题栏（拖拽手柄） */}
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b border-border cursor-grab active:cursor-grabbing select-none"
        style={{ touchAction: 'none' }}
        onPointerDown={(e) => {
          // 点关闭按钮不触发拖拽
          if ((e.target as Element).closest('button')) return
          begin(e, 'move')
        }}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <h3 className="text-sm font-semibold truncate pointer-events-none">{title}</h3>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
        >
          <X size={14} />
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {children}
      </div>

      {/* 8 向调整尺寸手柄 */}
      {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as ResizeEdge[]).map(edge => (
        <div
          key={edge}
          style={{ touchAction: 'none', cursor: CURSORS[edge], ...handleStyle(edge) }}
          onPointerDown={(e) => { e.stopPropagation(); begin(e, 'resize', edge) }}
          onPointerMove={onPointerMove}
          onPointerUp={end}
          onPointerCancel={end}
        />
      ))}
    </div>
  )
}

function handleStyle(edge: ResizeEdge): React.CSSProperties {
  const T = 7 // 命中厚度 px
  const C = 14 // 角命中区 px
  const base: React.CSSProperties = { position: 'absolute' }
  switch (edge) {
    case 'n': return { ...base, top: -T / 2, left: C, right: C, height: T }
    case 's': return { ...base, bottom: -T / 2, left: C, right: C, height: T }
    case 'w': return { ...base, left: -T / 2, top: C, bottom: C, width: T }
    case 'e': return { ...base, right: -T / 2, top: C, bottom: C, width: T }
    case 'nw': return { ...base, left: -T / 2, top: -T / 2, width: C, height: C }
    case 'ne': return { ...base, right: -T / 2, top: -T / 2, width: C, height: C }
    case 'sw': return { ...base, left: -T / 2, bottom: -T / 2, width: C, height: C }
    case 'se': return { ...base, right: -T / 2, bottom: -T / 2, width: C, height: C }
  }
}

function equalRect(a: FloatingRect, b: FloatingRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function clampRect(r: FloatingRect, bw: number, bh: number, min: { width: number; height: number }): FloatingRect {
  const width = Math.min(Math.max(r.width, min.width), bw)
  const height = Math.min(Math.max(r.height, min.height), bh)
  const x = Math.min(Math.max(r.x, 0), Math.max(0, bw - width))
  const y = Math.min(Math.max(r.y, 0), Math.max(0, bh - height))
  return { x, y, width, height }
}

function applyResize(
  start: FloatingRect,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  bw: number,
  bh: number,
  min: { width: number; height: number },
): FloatingRect {
  let { x, y, width, height } = start
  if (edge.includes('e')) width = start.width + dx
  if (edge.includes('s')) height = start.height + dy
  if (edge.includes('w')) {
    width = start.width - dx
    x = start.x + dx
  }
  if (edge.includes('n')) {
    height = start.height - dy
    y = start.y + dy
  }

  // 最小尺寸：w/n 边回拉时同步修正 x/y
  if (width < min.width) {
    if (edge.includes('w')) x -= min.width - width
    width = min.width
  }
  if (height < min.height) {
    if (edge.includes('n')) y -= min.height - height
    height = min.height
  }

  // 不超出容器
  if (x < 0) { width += x; x = 0 }
  if (y < 0) { height += y; y = 0 }
  if (x + width > bw) width = bw - x
  if (y + height > bh) height = bh - y

  return { x, y, width, height }
}
