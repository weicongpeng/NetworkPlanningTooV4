/**
 * 扇区属性信息面板
 *
 * 功能:
 * - 显示小区关键属性
 * - 点击面板外部区域自动关闭
 * - 右上角 X 关闭按钮
 * - 5秒无交互自动关闭（鼠标悬停暂停计时）
 * - 支持自定义属性字段
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { RenderSectorData } from '../../services/mapDataService'
import L from 'leaflet'
import { clampPopupPosition, type MapViewportBounds } from './popupPosition'

/** 弹窗固定宽度（高度随内容，上限为地图视口高度，超出纵向滚动） */
const PANEL_WIDTH = 420

/**
 * 属性面板属性
 */
export interface SectorInfoPanelProps {
  /** 扇区数据 */
  sector: RenderSectorData | null
  /** 是否显示 */
  visible: boolean
  /** 关闭回调 */
  onClose: () => void
  /** 返回回调（从重叠扇区列表进入属性框时提供，显示返回按钮回到列表） */
  onBack?: () => void
  /** 位置信息 */
  position?: {
    x: number
    y: number
  }
  /** 地图视口矩形（弹窗始终完整落在该区域内） */
  viewportBounds?: MapViewportBounds | null
  /** 鼠标进入回调（暂停自动关闭计时器） */
  onMouseEnter?: () => void
  /** 鼠标离开回调（恢复自动关闭计时器） */
  onMouseLeave?: () => void
}

/**
 * 扇区属性信息面板
 */
export function SectorInfoPanel({ sector, visible, position, viewportBounds, onClose, onBack, onMouseEnter, onMouseLeave }: SectorInfoPanelProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number } | null>(null)
  // 待复制的文本内容
  const [pendingSelectedText, setPendingSelectedText] = useState<string>('')

  // 处理全局点击以关闭右键菜单
  useEffect(() => {
    const handleGlobalClick = () => {
      setContextMenu(null)
      setPendingSelectedText('')
    }
    if (contextMenu) {
      window.addEventListener('click', handleGlobalClick)
      window.addEventListener('contextmenu', handleGlobalClick)
    }
    return () => {
      window.removeEventListener('click', handleGlobalClick)
      window.removeEventListener('contextmenu', handleGlobalClick)
    }
  }, [contextMenu])

  // 点击面板外部区域时关闭面板（比依赖地图click事件更可靠）
  useEffect(() => {
    if (!visible) return
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // 使用 mousedown 确保在 mouseup 前捕获，避免与 Leaflet 事件冲突
    document.addEventListener('mousedown', handleClickOutside, true)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true)
    }
  }, [visible, onClose])

  // 处理复制功能
  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    const textToCopy = pendingSelectedText || window.getSelection()?.toString()
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy)
        .then(() => console.log('[SectorInfoPanel] 已复制到剪切板'))
        .catch(err => console.error('[SectorInfoPanel] 复制失败:', err))
    }
    setContextMenu(null)
    setPendingSelectedText('')
  }, [pendingSelectedText])

  // 如果扇区数据不存在，不渲染面板
  if (!sector) {
    return null
  }

  // 固定宽度；高度上限取地图视口（无视口信息时回退 70vh），内容超出纵向滚动
  const availW = viewportBounds ? viewportBounds.right - viewportBounds.left - 16 : window.innerWidth
  const panelW = Math.min(PANEL_WIDTH, Math.max(280, availW))
  const maxH = viewportBounds
    ? viewportBounds.bottom - viewportBounds.top - 16
    : window.innerHeight * 0.7

  // 点击位置在地图视口内时按视口钳制；无点击位置时停靠视口右上角
  const anchor = position ?? (viewportBounds
    ? { x: viewportBounds.right - 20, y: viewportBounds.top + 60 }
    : { x: window.innerWidth - 40, y: 80 })
  const { left, top } = clampPopupPosition(anchor, { width: panelW, height: maxH }, viewportBounds)

  // 面板样式 - 直接设置所有颜色和样式，确保不被覆盖
  const panelStyle: React.CSSProperties = {
    position: 'fixed',
    top,
    left: `${left}px`,
    width: `${panelW}px`,
    maxWidth: '96vw',
    maxHeight: `${maxH}px`,
    overflowY: 'auto',
    zIndex: 10000,
    opacity: visible ? 1 : 0,
    visibility: visible ? 'visible' : 'hidden',
    pointerEvents: visible ? 'auto' : 'none',
    background: 'hsl(var(--popover) / 0.98)',
    color: 'hsl(var(--foreground))',
    boxShadow: '0 8px 28px rgba(0, 0, 0, 0.22)',
    userSelect: 'text',
    cursor: 'auto',
    border: '1px solid hsl(var(--border))',
    borderRadius: '12px',
    padding: '14px 18px',
    fontFamily: 'Arial, sans-serif',
    fontSize: '15px',
    lineHeight: '1.5'
  }

  return (
    <>
      <div
        ref={panelRef}
        style={panelStyle}
        tabIndex={0} // 使面板可以获得焦点，支持键盘事件
        className="bg-card border border-border rounded-lg shadow-lg outline-none"
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={(e) => {
          // 阻止事件冒泡到地图，防止点击面板时关闭面板
          e.stopPropagation()
          // 点击时聚焦面板，确保 Ctrl+C 能够工作
          panelRef.current?.focus()
        }}
        onMouseDown={(e) => {
          // 只阻止事件冒泡，允许文本选择的默认行为
          e.stopPropagation()
        }}
        onMouseUp={(e) => {
          // 只阻止事件冒泡，允许文本选择的默认行为
          e.stopPropagation()
        }}
        onMouseMove={(e) => {
          // 阻止事件冒泡，防止影响地图
          e.stopPropagation()
        }}
        onContextMenu={(e) => {
          // 阻止默认右键菜单，显示自定义复制菜单
          e.preventDefault()
          e.stopPropagation()

          // 在右键按下瞬间捕捉选中的文本，防止后续点击菜单时由于焦点改变导致选择丢失
          const text = window.getSelection()?.toString() || ''
          setPendingSelectedText(text)
          setContextMenu({ x: e.clientX, y: e.clientY })
        }}
      >


        {/* 属性列表 */}
        <div className="p-3 space-y-2 relative">
          {/* 返回重叠列表按钮（从重叠扇区列表进入属性框时显示，与要素属性框返回行为一致） */}
          {onBack && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onBack()
              }}
              style={{
                position: 'absolute',
                top: '10px',
                left: '12px',
                width: '28px',
                height: '28px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                borderRadius: '6px',
                color: 'hsl(var(--muted-foreground))',
                padding: 0,
                zIndex: 1
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'hsl(var(--accent))'
                e.currentTarget.style.color = 'hsl(var(--foreground))'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = 'hsl(var(--muted-foreground))'
              }}
              title={t('map.backToOverlapList')}
              aria-label={t('map.backToOverlapList')}
            >
              <ArrowLeft size={17} />
            </button>
          )}

          {/* 关闭按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            style={{
              position: 'absolute',
              top: '10px',
              right: '12px',
              width: '28px',
              height: '28px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              borderRadius: '6px',
              color: 'hsl(var(--muted-foreground))',
              fontSize: '16px',
              lineHeight: '1',
              padding: 0,
              zIndex: 1
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLElement).style.background = 'hsl(var(--accent))'
              ;(e.target as HTMLElement).style.color = 'hsl(var(--foreground))'
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLElement).style.background = 'transparent'
              ;(e.target as HTMLElement).style.color = 'hsl(var(--muted-foreground))'
            }}
            title="关闭"
          >
            ✕
          </button>

          {/* 小区名称 - 标题样式 - 确保不透明 */}
          <div style={{
            color: 'hsl(var(--foreground))',
            fontSize: '16px',
            fontWeight: '600',
            opacity: 1,
            paddingBottom: '10px',
            paddingRight: '32px',
            paddingLeft: onBack ? '32px' : undefined,
            borderBottom: '1px solid hsl(var(--border))',
            marginBottom: '12px',
            userSelect: 'text',
            cursor: 'text'
          }}>
            {sector.name || '未命名小区'}
          </div>

          {/* 属性网格 */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            {/* 网络类型 */}
            <AttributeLabel label="网络类型" />
            <AttributeValue value={sector.networkType} highlight />

            {/* 网元ID（映射全量工参「管理网元ID」，站点级） */}
            <AttributeLabel label={t('map.netElementId')} />
            <AttributeValue value={sector.managedElementId || '-'} />

            {/* 基站ID */}
            <AttributeLabel label="基站ID" />
            <AttributeValue value={sector.siteId || '-'} />

            {/* 小区ID */}
            <AttributeLabel label="小区ID" />
            <AttributeValue value={sector.sectorId || '-'} />

            {/* 覆盖类型 */}
            {sector.cell_cover_type !== undefined && (
              <>
                <AttributeLabel label="覆盖类型" />
                <AttributeValue
                  value={sector.cell_cover_type === 1 ? '室外小区' : sector.cell_cover_type === 4 ? '室内小区' : `类型${sector.cell_cover_type}`}
                  highlight={sector.cell_cover_type === 4}
                />
              </>
            )}

            {/* 下行频点（MHz） */}
            <AttributeLabel label="下行频点（MHz）" />
            <AttributeValue value={sector.frequency || '-'} />

            {/* PCI */}
            <AttributeLabel label="PCI" />
            <AttributeValue value={sector.pci} highlight />

            {/* TAC */}
            <AttributeLabel label="TAC" />
            <AttributeValue value={sector.tac || '-'} />

            {/* 经度 */}
            <AttributeLabel label="经度" />
            <AttributeValue value={sector.longitude?.toFixed(6) || '-'} />

            {/* 纬度 */}
            <AttributeLabel label="纬度" />
            <AttributeValue value={sector.latitude?.toFixed(6) || '-'} />

            {/* 方向角 */}
            <AttributeLabel label="方向角" />
            <AttributeValue value={`${sector.azimuth}°`} />

            {/* 天线挂高 */}
            {sector.height !== undefined && (
              <>
                <AttributeLabel label="天线挂高" />
                <AttributeValue value={`${sector.height}m`} />
              </>
            )}

            {/* 是否共享 */}
            <AttributeLabel label="是否共享" />
            <AttributeValue value={sector.is_shared || '-'} />

            {/* 厂家（第一分组） */}
            <AttributeLabel label="厂家" />
            <AttributeValue value={sector.first_group || '-'} />
          </div>


        </div>
      </div>

      {/* 自定义右键复制菜单 */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 11000,
            background: 'hsl(var(--popover))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '8px',
            boxShadow: '0 6px 20px rgba(0,0,0,0.2)',
            padding: '6px 0',
            minWidth: '130px'
          }}
          onClick={handleCopy}
        >
          <div className="px-4 py-2.5 hover:bg-accent cursor-pointer text-sm flex items-center">
            <span className="mr-2">复制</span>
            <span className="text-muted-foreground text-xs">Ctrl+C</span>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * 属性标签组件 - 确保文本不透明
 */
function AttributeLabel({ label }: { label: string }) {
  return (
    <div style={{
      color: 'hsl(var(--muted-foreground))',
      fontSize: '13px',
      fontWeight: '500',
      opacity: 1,
      marginBottom: '3px',
      lineHeight: '1.4',
      userSelect: 'text'
    }}>
      {label}
    </div>
  )
}

/**
 * 属性值组件 - 确保文本不透明
 */
function AttributeValue({ value, highlight }: { value: string | number | undefined | null; highlight?: boolean }) {
  // 简化条件，确保所有值都能显示，包括0
  const displayValue = value === undefined || value === null ? '-' : String(value)
  const textColor = highlight ? 'hsl(var(--primary))' : 'hsl(var(--foreground))'

  return (
    <div
      style={{
        color: textColor,
        fontSize: '14px',
        fontWeight: highlight ? '600' : '500',
        opacity: 1,
        marginBottom: '3px',
        lineHeight: '1.4',
        wordBreak: 'break-word',
        userSelect: 'text',
        cursor: 'text'
      }}
    >
      {displayValue}
    </div>
  )
}

/**
 * 使用属性面板的 Hook
 */
export function useSectorInfoPanel() {
  const [selectedSector, setSelectedSector] = useState<RenderSectorData | null>(null)
  const [panelVisible, setPanelVisible] = useState(false)
  const [clickPosition, setClickPosition] = useState<{ x: number; y: number } | undefined>(undefined)
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  const showSectorInfo = (sector: RenderSectorData, event?: L.LeafletMouseEvent) => {
    // 清除之前的定时器
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }

    console.log('[useSectorInfoPanel] showSectorInfo called:', {
      sectorName: sector.name,
      networkType: sector.networkType,
      isShared: sector.is_shared,
      sectorData: sector
    })
    setSelectedSector(sector)
    setPanelVisible(true)

    // 如果提供了点击事件，记录位置
    if (event && event.originalEvent) {
      setClickPosition({
        x: event.originalEvent.clientX,
        y: event.originalEvent.clientY
      })
    } else {
      setClickPosition(undefined)
    }

    // 5秒后自动关闭
    timerRef.current = setTimeout(() => {
      setPanelVisible(false)
      timerRef.current = null
    }, 5000)
  }

  const hideSectorInfo = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    console.log('[useSectorInfoPanel] hideSectorInfo called')
    setPanelVisible(false)
  }

  // 鼠标进入面板时暂停自动关闭计时器
  const onPanelMouseEnter = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  // 鼠标离开面板时重新启动 5 秒自动关闭计时器
  const onPanelMouseLeave = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }
    timerRef.current = setTimeout(() => {
      setPanelVisible(false)
      timerRef.current = null
    }, 5000)
  }

  return {
    selectedSector,
    panelVisible,
    clickPosition,
    showSectorInfo,
    hideSectorInfo,
    onPanelMouseEnter,
    onPanelMouseLeave
  }
}
