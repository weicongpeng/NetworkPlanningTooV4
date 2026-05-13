/**
 * 通用要素属性信息面板
 * 
 * 功能:
 * - 显示地图要素（MapInfo/地理化数据）的所有属性
 * - 两栏布局：左边是属性名，右边是属性值
 * - 支持内容复制
 * - 固定默认尺寸，支持滚动浏览
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import L from 'leaflet'

export interface FeatureInfoPanelProps {
    /** 标题（通常是图层名称或要素ID） */
    title?: string
    /** 属性数据对象 */
    properties: Record<string, any> | null
    /** 是否显示 */
    visible: boolean
    /** 关闭回调 */
    onClose: () => void
    /** 弹窗位置 */
    position?: { x: number; y: number }
}

export function FeatureInfoPanel({ title, properties, visible, onClose, position }: FeatureInfoPanelProps) {
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

    // 处理复制功能
    const handleCopy = useCallback((e: React.MouseEvent) => {
        e.stopPropagation()
        const textToCopy = pendingSelectedText || window.getSelection()?.toString()
        if (textToCopy) {
            navigator.clipboard.writeText(textToCopy)
                .then(() => console.log('[FeatureInfoPanel] 已复制到剪切板'))
                .catch(err => console.error('[FeatureInfoPanel] 复制失败:', err))
        }
        setContextMenu(null)
        setPendingSelectedText('')
    }, [pendingSelectedText])

    if (!properties) return null

    // 计算位置逻辑（参考 SectorInfoPanel）
    const calculatePosition = () => {
        const panelWidth = 320
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight

        let left = position ? position.x + 10 : 20
        let right = position ? 'auto' : 20
        let top: number | 'auto' = position ? position.y : 80
        let bottom: number | 'auto' = 'auto'

        if (position) {
            if (viewportHeight - position.y < 350) {
                bottom = viewportHeight - position.y + 10
                top = 'auto'
            }
            if (left + panelWidth > viewportWidth) {
                left = position.x - panelWidth - 10
                if (left < 0) left = 20
            }
        }

        return { top, left, right, bottom }
    }

    const { top, left, right, bottom } = calculatePosition()

    const style: React.CSSProperties = {
        position: 'fixed',
        top,
        bottom,
        left: `${left}px`,
        right,
        width: '320px',
        maxHeight: '40vh',
        overflow: 'hidden',
        zIndex: 10000,
        opacity: visible ? 1 : 0,
        visibility: visible ? 'visible' : 'hidden',
        background: 'white',
        color: '#000000',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
        borderRadius: '8px',
        border: '1px solid #e2e8f0',
        display: 'flex',
        flexDirection: 'column'
    }

    // 处理并打平属性，特别是处理嵌套的 properties 对象
    const displayProperties: Array<{ key: string; value: any }> = []

    const processProperties = (obj: Record<string, any>) => {
        Object.entries(obj).forEach(([key, value]) => {
            // 过滤掉内部保留字段和 GeoJSON 特殊字段
            if (
                key === '_style' ||
                key === 'geometry' ||
                key === 'type' ||
                key === 'displayLng' ||
                key === 'displayLat' ||
                key === 'longitude' ||
                key === 'latitude'
            ) {
                return
            }

            // 特殊处理：如果属性名是 'properties' 且值是对象或 JSON 字符串
            if (key === 'properties') {
                let nestedProps = value
                if (typeof value === 'string') {
                    try {
                        nestedProps = JSON.parse(value)
                    } catch (e) {
                        // 忽略解析错误
                    }
                }

                if (nestedProps && typeof nestedProps === 'object' && !Array.isArray(nestedProps)) {
                    processProperties(nestedProps)
                    return
                }
            }

            displayProperties.push({ key, value })
        })
    }

    processProperties(properties)

    return (
        <>
            <div
                ref={panelRef}
                style={style}
                tabIndex={0} // 使面板可以获得焦点，支持键盘事件
                className="feature-info-panel outline-none"
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
                {/* 头部 */}
                <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200 rounded-t-lg">
                    <span className="text-xs font-semibold text-gray-700 truncate mr-4">
                        {title || '要素属性'}
                    </span>
                    <button
                        onClick={onClose}
                        className="p-1 hover:bg-gray-200 rounded-full transition-colors"
                    >
                        <X size={14} />
                    </button>
                </div>

                {/* 属性列表正文 - 两栏布局 */}
                <div className="flex-1 overflow-y-auto p-0 scrollbar-thin">
                    <table className="w-full text-xs border-collapse">
                        <tbody className="divide-y divide-gray-100">
                            {displayProperties.length === 0 ? (
                                <tr>
                                    <td className="px-4 py-4 text-center text-gray-400 italic">暂无属性信息</td>
                                </tr>
                            ) : (
                                displayProperties.map(({ key, value }) => {
                                    let displayValue = value
                                    // 处理嵌套对象（非 properties 的其他对象）
                                    if (displayValue && typeof displayValue === 'object') {
                                        displayValue = JSON.stringify(displayValue)
                                    }

                                    return (
                                        <tr key={key} className="hover:bg-gray-50 transition-colors">
                                            <td className="px-4 py-2 font-medium text-gray-500 w-1/3 break-all border-r border-gray-50 bg-gray-50/50">
                                                {key}
                                            </td>
                                            <td className="px-4 py-2 text-gray-900 break-all select-text cursor-text">
                                                {displayValue !== null && displayValue !== undefined ? String(displayValue) : '-'}
                                            </td>
                                        </tr>
                                    )
                                })
                            )}
                        </tbody>
                    </table>
                </div>

                {/* 底部装饰或提示 */}
                <div className="px-4 py-1.5 bg-gray-50 border-t border-gray-100 text-[10px] text-gray-400 text-right">
                    共 {displayProperties.length} 项属性
                </div>

                <style>{`
                .feature-info-panel .scrollbar-thin::-webkit-scrollbar {
                  width: 6px;
                }
                .feature-info-panel .scrollbar-thin::-webkit-scrollbar-track {
                  background: #f8fafc;
                }
                .feature-info-panel .scrollbar-thin::-webkit-scrollbar-thumb {
                  background: #cbd5e1;
                  border-radius: 3px;
                }
                .feature-info-panel .scrollbar-thin::-webkit-scrollbar-thumb:hover {
                  background: #94a3b8;
                }
            `}</style>
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
 * Hook for managing feature info panel state
 */
export function useFeatureInfoPanel() {
    const [featureProperties, setFeatureProperties] = useState<Record<string, any> | null>(null)
    const [featurePanelVisible, setFeaturePanelVisible] = useState(false)
    const [featureTitle, setFeatureTitle] = useState<string>('')
    const [featureClickPosition, setFeatureClickPosition] = useState<{ x: number; y: number } | undefined>(undefined)

    const showFeatureInfo = useCallback((properties: Record<string, any>, event?: L.LeafletMouseEvent, title?: string) => {
        setFeatureTitle(title || '要素属性')
        setFeatureProperties(properties)
        setFeaturePanelVisible(true)
        if (event) {
            setFeatureClickPosition({ x: event.originalEvent.clientX, y: event.originalEvent.clientY })
        }
    }, [])

    const hideFeatureInfo = useCallback(() => {
        setFeaturePanelVisible(false)
    }, [])

    return {
        featureProperties,
        featurePanelVisible,
        featureTitle,
        featureClickPosition,
        showFeatureInfo,
        hideFeatureInfo
    }
}
