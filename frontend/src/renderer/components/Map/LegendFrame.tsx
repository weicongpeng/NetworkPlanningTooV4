/**
 * 图例浮窗容器（专题图层图例 / 热力图图例 / PCI模值图例共用）
 *
 * 交互：
 * - 拖拽标题栏：自由移动位置
 * - 拖拽右下角手柄：自由调整窗口大小
 * - 点击标题栏折叠按钮：收起为一个悬浮图标；点击该图标展开（默认展开）
 * - 折叠后的悬浮图标同样可按住拖动，位置与窗口布局一并持久化
 * - 位置/大小按登录用户持久化（mapStore.mapSettings.legendLayout），
 *   随现有 mapSettings → 后端 user_settings 链路跨会话保存
 *
 * 未自定义过布局时沿用默认锚点（专题右上、热力右下），首次拖拽/缩放后转为绝对定位。
 *
 * 布局是跨端共享的绝对像素坐标：桌面端地图容器可能比网页端小，挂载时以及容器
 * 尺寸变化时都必须把越界布局拉回可视区域，否则图例会被地图容器的
 * overflow:hidden 整个裁掉（"桌面端热力图没有图例、网页端正常"的根因）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronUp, List } from 'lucide-react'
import { useMapStore, type LegendLayout } from '../../store/mapStore'

export type LegendLayoutKey = 'thematic' | 'heatmap' | 'pci-mod'

/** 浮窗最小尺寸（拖拽缩放下限） */
const MIN_WIDTH = 140
const MIN_HEIGHT = 48
/** 折叠后悬浮图标的边长 */
const COLLAPSED_SIZE = 34
/** 右吸附时距地图容器右边缘的间距（折叠图标与展开窗口共用右锚点） */
const EDGE_GAP = 10

interface InteractionState {
  mode: 'move' | 'resize'
  startX: number
  startY: number
  /** 交互开始时的布局快照（已转为相对父容器的绝对定位） */
  start: Required<Pick<LegendLayout, 'x' | 'y' | 'width' | 'height'>>
  parentWidth: number
  parentHeight: number
}

interface LegendFrameProps {
  layoutKey: LegendLayoutKey
  /** 无自定义布局时的默认锚点（相对地图容器，px） */
  defaultAnchor: { top?: number; right?: number; bottom?: number; left?: number }
  /** 无自定义宽高时的自适应上限 */
  defaultMaxWidth?: number
  defaultMaxHeight?: string | number
  /** 内容区标题（同时作为拖拽手柄） */
  title: ReactNode
  /** 标题栏拖拽提示（title 属性，建议传 i18n 文案） */
  dragHint?: string
  /** 右下角缩放手柄提示 */
  resizeHint?: string
  className?: string
  children: ReactNode
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function LegendFrame({
  layoutKey,
  defaultAnchor,
  defaultMaxWidth = 260,
  defaultMaxHeight = '60vh',
  title,
  dragHint,
  resizeHint,
  className,
  children
}: LegendFrameProps) {
  const { t } = useTranslation()
  const layout = useMapStore(s => s.mapSettings.legendLayout?.[layoutKey])
  const setLegendLayout = useMapStore(s => s.setLegendLayout)

  const frameRef = useRef<HTMLDivElement>(null)
  /** 拖拽/缩放过程中的临时布局（松手后写入 store） */
  const [draft, setDraft] = useState<LegendLayout | null>(null)
  const draftRef = useRef<LegendLayout | null>(null)
  draftRef.current = draft
  const [interaction, setInteraction] = useState<InteractionState | null>(null)
  /** 本次交互是否真的产生位移（仅点击标题/手柄不写入布局，保持默认锚点） */
  const movedRef = useRef(false)
  /** 默认展开；折叠态不持久化，每次进入图例都是展开的 */
  const [collapsed, setCollapsed] = useState(false)
  /**
   * 右吸附模式：点折叠按钮后置位，悬浮图标贴地图右边缘；点图标展开后窗口复用同一
   * 右锚点向左展开。任一拖动开始时退出该模式，恢复用户自定义位置（拖动仍可用）。
   */
  const [docked, setDocked] = useState(false)

  const effective = draft ?? layout ?? {}

  /** 读取当前实际渲染尺寸并换算为相对父容器的绝对定位 */
  const measure = useCallback((): InteractionState['start'] | null => {
    const el = frameRef.current
    const parent = el?.parentElement
    if (!el || !parent) return null
    const elRect = el.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()
    return {
      x: Math.round(elRect.left - parentRect.left),
      y: Math.round(elRect.top - parentRect.top),
      width: Math.round(elRect.width),
      height: Math.round(elRect.height),
    }
  }, [])

  const beginInteraction = useCallback((mode: InteractionState['mode']) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    const start = measure()
    const parent = frameRef.current?.parentElement
    if (!start || !parent) return
    e.preventDefault()
    e.stopPropagation()
    const parentRect = parent.getBoundingClientRect()
    movedRef.current = false
    // 先把当前渲染位置固化为绝对定位，避免拖拽瞬间因锚点切换而跳动
    setDraft(start)
    setInteraction({
      mode,
      startX: e.clientX,
      startY: e.clientY,
      start,
      parentWidth: parentRect.width,
      parentHeight: parentRect.height,
    })
  }, [measure])

  const endInteraction = useCallback(() => {
    // 仅点击（无位移）不落地布局，避免把默认锚点固化成绝对定位
    const finalLayout = movedRef.current ? draftRef.current : null
    if (finalLayout) {
      setLegendLayout(layoutKey, {
        ...(layout ?? {}),
        x: finalLayout.x,
        y: finalLayout.y,
        // 折叠态拖动只改位置：窗口宽高保留展开态的自定义值，别把 34x34 写进布局
        ...(collapsed ? {} : { width: finalLayout.width, height: finalLayout.height }),
      })
    } else if (collapsed) {
      // 折叠态点击图标（无位移）→ 展开；拖动过则只保存位置、不展开
      setCollapsed(false)
    }
    setDraft(null)
    setInteraction(null)
  }, [layoutKey, setLegendLayout, collapsed, layout])

  // 交互期间在 window 上跟踪指针：移出浮窗/地图容器也能继续拖拽
  useEffect(() => {
    if (!interaction) return
    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - interaction.startX
      const dy = e.clientY - interaction.startY
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        // 真正拖动才退出右吸附；单纯点击（随后展开）保持右锚定
        if (!movedRef.current) setDocked(false)
        movedRef.current = true
      }
      if (interaction.mode === 'move') {
        setDraft({
          ...interaction.start,
          x: Math.round(clamp(interaction.start.x + dx, 0, interaction.parentWidth - interaction.start.width)),
          y: Math.round(clamp(interaction.start.y + dy, 0, interaction.parentHeight - interaction.start.height)),
        })
      } else {
        setDraft({
          ...interaction.start,
          width: Math.round(clamp(interaction.start.width + dx, MIN_WIDTH, interaction.parentWidth - interaction.start.x)),
          height: Math.round(clamp(interaction.start.height + dy, MIN_HEIGHT, interaction.parentHeight - interaction.start.y)),
        })
      }
    }
    const onUp = () => endInteraction()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [interaction, endInteraction])

  // 把越界的持久化布局拉回可视区域并持久化。
  // 必须挂载时立即纠正（而非仅 window resize）：布局跨端共享，桌面端地图容器常比网页端小，
  // 从网页端同步来的大坐标会让浮窗整个落在容器外、被 overflow:hidden 裁掉。
  // ResizeObserver 额外覆盖侧栏展开/容器初次完成布局等不触发 window resize 的情况。
  useEffect(() => {
    // 折叠态元素只有 34px，不能代表窗口尺寸，此时纠偏会把布局算错；展开后再纠正
    if (!layout || collapsed) return
    const parent = frameRef.current?.parentElement
    if (!parent) return
    const correct = () => {
      const el = frameRef.current
      if (!el) return
      const parentRect = parent.getBoundingClientRect()
      // 容器尚未完成布局（flex-1 高度为 0）时不要写回，等 ResizeObserver 的下一次回调
      if (parentRect.width <= 0 || parentRect.height <= 0) return
      const elRect = el.getBoundingClientRect()
      const width = layout.width !== undefined ? Math.min(layout.width, parentRect.width) : undefined
      const height = layout.height !== undefined ? Math.min(layout.height, parentRect.height) : undefined
      const x = Math.round(clamp(layout.x ?? elRect.left - parentRect.left, 0, Math.max(0, parentRect.width - (width ?? elRect.width))))
      const y = Math.round(clamp(layout.y ?? elRect.top - parentRect.top, 0, Math.max(0, parentRect.height - (height ?? elRect.height))))
      if (x === layout.x && y === layout.y && width === layout.width && height === layout.height) return
      setLegendLayout(layoutKey, { x, y, width, height })
    }
    correct()
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(correct)
      observer.observe(parent)
    }
    window.addEventListener('resize', correct)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', correct)
    }
  }, [layout, layoutKey, setLegendLayout, collapsed])

  const style: CSSProperties = {
    position: 'absolute',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: 'hsl(var(--popover) / 0.95)',
    borderRadius: '6px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
    fontSize: '11px',
    overflow: 'hidden'
  }
  if (docked && !draft) {
    // 折叠图标贴地图右边缘；展开窗口共用右锚点，宽度自适应即向左展开。
    // 垂直位置沿用自定义 y 或默认锚点，避免折叠/展开时上下跳动。
    style.right = EDGE_GAP
    if (effective.y !== undefined) {
      style.top = effective.y
    } else if (defaultAnchor.top !== undefined) {
      style.top = defaultAnchor.top
    } else if (defaultAnchor.bottom !== undefined) {
      style.bottom = defaultAnchor.bottom
    }
  } else {
    if (effective.x !== undefined) {
      style.left = effective.x
    } else {
      if (defaultAnchor.left !== undefined) style.left = defaultAnchor.left
      if (defaultAnchor.right !== undefined) style.right = defaultAnchor.right
    }
    if (effective.y !== undefined) {
      style.top = effective.y
    } else {
      if (defaultAnchor.top !== undefined) style.top = defaultAnchor.top
      if (defaultAnchor.bottom !== undefined) style.bottom = defaultAnchor.bottom
    }
  }
  if (effective.width !== undefined) {
    style.width = effective.width
  } else {
    style.maxWidth = defaultMaxWidth
  }
  if (effective.height !== undefined) {
    style.height = effective.height
  } else {
    style.maxHeight = defaultMaxHeight
  }
  if (interaction) {
    style.userSelect = 'none'
    style.cursor = interaction.mode === 'move' ? 'move' : 'nwse-resize'
  }

  if (collapsed) {
    style.width = COLLAPSED_SIZE
    style.height = COLLAPSED_SIZE
    style.maxWidth = undefined
    style.maxHeight = undefined
    style.flexDirection = undefined
    style.alignItems = 'center'
    style.justifyContent = 'center'
    style.border = '1px solid hsl(var(--border))'
    style.color = 'hsl(var(--foreground))'
    style.cursor = interaction?.mode === 'move' ? 'grabbing' : 'grab'
    style.touchAction = 'none'
  }

  // 折叠态：一个可按住拖动的悬浮图标；点击（无位移）由 endInteraction 展开
  if (collapsed) {
    return (
      <div
        ref={frameRef}
        className={className}
        style={style}
        role="button"
        tabIndex={0}
        title={typeof title === 'string' ? `${title} · ${t('map.legendExpand')}` : t('map.legendExpand')}
        aria-label={t('map.legendExpand')}
        onPointerDown={beginInteraction('move')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setCollapsed(false)
          }
        }}
      >
        <List size={16} />
      </div>
    )
  }

  return (
    <div ref={frameRef} className={className} style={style}>
      <div
        onPointerDown={beginInteraction('move')}
        title={dragHint}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '6px 8px 0',
          cursor: 'move',
          touchAction: 'none',
          flexShrink: 0
        }}
      >
        <span style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}>{title}</span>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => { setDocked(true); setCollapsed(true) }}
          title={t('map.legendCollapse')}
          aria-label={t('map.legendCollapse')}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            marginLeft: 'auto', padding: 0, border: 'none', background: 'transparent', lineHeight: 0,
            color: 'hsl(var(--muted-foreground))', cursor: 'pointer', flexShrink: 0
          }}
        >
          <ChevronUp size={12} />
        </button>
      </div>
      <div style={{ padding: '6px 10px 8px', overflowY: 'auto', overflowX: 'hidden', flex: 1, minHeight: 0 }}>
        {children}
      </div>
      <div
        onPointerDown={beginInteraction('resize')}
        title={resizeHint}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          borderLeft: '11px solid transparent',
          borderBottom: '11px solid hsl(var(--muted-foreground) / 0.45)',
          cursor: 'nwse-resize',
          touchAction: 'none'
        }}
      />
    </div>
  )
}
