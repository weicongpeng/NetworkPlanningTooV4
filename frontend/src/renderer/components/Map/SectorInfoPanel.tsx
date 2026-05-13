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
import { RenderSectorData } from '../../services/mapDataService'
import L from 'leaflet'

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
  /** 位置信息 */
  position?: {
    x: number
    y: number
  }
  /** 鼠标进入回调（暂停自动关闭计时器） */
  onMouseEnter?: () => void
  /** 鼠标离开回调（恢复自动关闭计时器） */
  onMouseLeave?: () => void
}

/**
 * 扇区属性信息面板
 */
export function SectorInfoPanel({ sector, visible, position, onClose, onMouseEnter, onMouseLeave }: SectorInfoPanelProps) {
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

  // 计算面板位置，确保始终显示在视口内
  const calculatePosition = () => {
    const panelWidth = 280
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    let left = position ? position.x + 10 : 20
    let right = position ? 'auto' : 20
    let top: number | 'auto'
    let bottom: number | 'auto' = 'auto'

    // 如果提供了点击事件，根据鼠标位置智能定位
    if (position) {
      // 计算鼠标位置到视口底部的距离
      const distanceToBottom = viewportHeight - position.y

      // 如果鼠标靠近底部边缘，将弹窗显示在鼠标上方
      if (distanceToBottom < 300) {
        // 弹窗显示在鼠标上方，距离鼠标10px
        bottom = viewportHeight - position.y + 10
        top = 'auto'
      } else {
        // 正常显示在鼠标下方
        top = position.y
        bottom = 'auto'
      }

      // 如果面板超出右侧视口，调整为左侧显示
      if (left + panelWidth > viewportWidth) {
        left = position.x - panelWidth - 10
        if (left < 0) left = 20
      }
    } else {
      // 没有点击事件时的默认位置
      top = 80
      bottom = 'auto'
    }

    return { top, left, right, bottom }
  }

  const { top, left, right, bottom } = calculatePosition()

  // 面板样式 - 直接设置所有颜色和样式，确保不被覆盖
  const panelStyle: React.CSSProperties = {
    position: 'fixed',
    top: top,
    bottom: bottom,
    left: `${left}px`,
    right: right,
    width: 'auto',
    minWidth: '200px',
    maxWidth: '300px',
    maxHeight: '70vh',
    overflowY: 'auto',
    zIndex: 10000,
    opacity: visible ? 1 : 0,
    visibility: visible ? 'visible' : 'hidden',
    pointerEvents: visible ? 'auto' : 'none',
    background: 'white',
    color: '#000000', // 直接设置字体颜色为黑色，确保不透明
    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
    userSelect: 'text',
    cursor: 'auto',
    border: '1px solid #e2e8f0',
    borderRadius: '8px',
    padding: '8px 12px',
    fontFamily: 'Arial, sans-serif',
    fontSize: '14px',
    lineHeight: '1.2' // 减小行间距
  }

  return (
    <>
      <div
        ref={panelRef}
        style={panelStyle}
        tabIndex={0} // 使面板可以获得焦点，支持键盘事件
        className="bg-white border border-gray-300 rounded-lg shadow-lg outline-none"
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
        <div className="p-4 space-y-1 relative">
          {/* 关闭按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            style={{
              position: 'absolute',
              top: '6px',
              right: '8px',
              width: '20px',
              height: '20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              borderRadius: '4px',
              color: '#999',
              fontSize: '14px',
              lineHeight: '1',
              padding: 0,
              zIndex: 1
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLElement).style.background = '#f3f4f6'
              ;(e.target as HTMLElement).style.color = '#374151'
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLElement).style.background = 'transparent'
              ;(e.target as HTMLElement).style.color = '#999'
            }}
            title="关闭"
          >
            ✕
          </button>

          {/* 小区名称 - 标题样式 - 确保不透明 */}
          <div style={{
            color: '#000000',
            fontSize: '12px',
            fontWeight: '600',
            opacity: 1,
            paddingBottom: '6px',
            borderBottom: '1px solid #e2e8f0',
            marginBottom: '6px',
            userSelect: 'text',
            cursor: 'text'
          }}>
            {sector.name || '未命名小区'}
          </div>

          {/* 属性网格 */}
          <div className="grid grid-cols-2 gap-1 text-sm">
            {/* 网络类型 */}
            <AttributeLabel label="网络类型" />
            <AttributeValue value={sector.networkType} highlight />

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
            background: 'white',
            border: '1px solid #e2e8f0',
            borderRadius: '4px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
            padding: '4px 0',
            minWidth: '80px'
          }}
          onClick={handleCopy}
        >
          <div className="px-4 py-2 hover:bg-blue-50 cursor-pointer text-sm flex items-center">
            <span className="mr-2">复制</span>
            <span className="text-gray-400 text-xs">Ctrl+C</span>
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
      color: '#000000',
      fontSize: '12px',
      fontWeight: '600',
      opacity: 1, // 透明度100% = 不透明
      marginBottom: '2px',
      lineHeight: '1.0', // 减小行间距
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
  const textColor = highlight ? '#2563eb' : '#000000'

  return (
    <div
      style={{
        color: textColor,
        fontSize: '12px',
        fontWeight: '500',
        opacity: 1, // 透明度100% = 不透明
        marginBottom: '2px',
        lineHeight: '1.0', // 减小行间距
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
