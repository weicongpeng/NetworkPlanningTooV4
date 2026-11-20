/**
 * 通用要素属性信息面板
 * 
 * 功能:
 * - 显示地图要素（MapInfo/地理化数据）的所有属性
 * - 两栏布局：左边是属性名，右边是属性值
 * - 编辑态（editable）下字段值可直接修改，失焦/回车提交到编辑工作集，保存工具写入文件
 * - 支持内容复制
 * - 固定默认尺寸，支持滚动浏览
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { X, ArrowLeft, Plus, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { clampPopupPosition, type MapViewportBounds } from './popupPosition'
import type { AttributeErrorCode } from '../../store/layerEditStore'

/** 弹窗固定尺寸（内容超出时正文区域纵向滚动） */
const PANEL_WIDTH = 460
const PANEL_HEIGHT = 520

export interface FeatureInfoPanelProps {
    /** 标题（要素名称/标识） */
    title?: string
    /** 副标题（所属图层名称） */
    subtitle?: string
    /** 属性数据对象 */
    properties: Record<string, any> | null
    /** 是否显示 */
    visible: boolean
    /** 关闭回调 */
    onClose: () => void
    /** 返回回调（从重叠要素列表进入属性框时提供，显示返回按钮回到列表） */
    onBack?: () => void
    /** 弹窗位置 */
    position?: { x: number; y: number }
    /** 地图视口矩形（弹窗始终完整落在该区域内） */
    viewportBounds?: MapViewportBounds | null
    /** 是否为可编辑要素（编辑开关图层 + 编辑会话要素）：字段值可修改 */
    editable?: boolean
    /** 字段提交回调（失焦/回车触发；由调用方写回编辑工作集，保存工具落盘） */
    onPropertyChange?: (key: string, value: string) => void
    /**
     * 新增图层属性字段（字段名 + 值）：字段对图层全部要素生效。
     * @returns 错误码（调用方校验失败时）；null 表示成功
     */
    onAddProperty?: (key: string, value: string) => AttributeErrorCode | null
}

export function FeatureInfoPanel({ title, subtitle, properties, visible, onClose, onBack, position, viewportBounds, editable, onPropertyChange, onAddProperty }: FeatureInfoPanelProps) {
    const { t } = useTranslation()
    const panelRef = useRef<HTMLDivElement>(null)
    // 添加属性表单（仅编辑态可用）
    const [showAddForm, setShowAddForm] = useState(false)
    const [newKey, setNewKey] = useState('')
    const [newVal, setNewVal] = useState('')
    const [addError, setAddError] = useState('')
    const newKeyRef = useRef<HTMLInputElement>(null)

    // 打开表单时聚焦字段名；切换/关闭要素时收起
    useEffect(() => {
        if (showAddForm) newKeyRef.current?.focus()
    }, [showAddForm])
    useEffect(() => {
        if (!visible) return
        setShowAddForm(false)
        setNewKey(''); setNewVal(''); setAddError('')
    }, [visible, properties])

    const resetAddForm = () => {
        setShowAddForm(false)
        setNewKey(''); setNewVal(''); setAddError('')
    }

    const submitAddProperty = () => {
        if (!onAddProperty) return
        const code = onAddProperty(newKey, newVal)
        if (code) {
            setAddError(t(`map.attrError.${code}`) || code)
            return
        }
        resetAddForm()
    }
    // 右键复制菜单（面板附属交互，点击它不应触发"点击外部关闭"）
    const contextMenuRef = useRef<HTMLDivElement>(null)

    // 右键菜单状态
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number } | null>(null)
    // 待复制的文本内容
    const [pendingSelectedText, setPendingSelectedText] = useState<string>('')

    // ===== 编辑态字段编辑 =====
    // 本地草稿（key → 输入中的值）：失焦/回车提交，面板关闭前兜底提交未失焦的修改。
    // committedRef 记录各字段最近一次已提交的值，避免 blur 与关闭兜底重复提交。
    const [draft, setDraft] = useState<Record<string, string>>({})
    const draftRef = useRef<Record<string, string>>({})
    const committedRef = useRef<Record<string, string>>({})

    // 切换 / 重新打开要素时清空草稿
    useEffect(() => {
        if (!visible) return
        draftRef.current = {}
        committedRef.current = {}
        setDraft({})
    }, [visible, properties])

    const updateDraft = (key: string, value: string) => {
        const next = { ...draftRef.current, [key]: value }
        draftRef.current = next
        setDraft(next)
    }

    const revertDraft = (key: string) => {
        const next = { ...draftRef.current }
        const sent = committedRef.current[key]
        if (sent !== undefined) next[key] = sent
        else delete next[key]
        draftRef.current = next
        setDraft(next)
    }

    /** 提交草稿字段（省略 keys 时提交全部；未修改的字段不写回） */
    const commitDraft = useCallback((keys?: string[]) => {
        if (!editable || !onPropertyChange || !properties) return
        const pending = { ...draftRef.current }
        const targets = keys ?? Object.keys(pending)
        for (const key of targets) {
            if (!(key in pending)) continue
            const value = pending[key]
            const orig = properties[key]
            const baseline = committedRef.current[key] ?? (orig === null || orig === undefined ? '' : String(orig))
            if (value !== baseline) {
                onPropertyChange(key, value)
                committedRef.current[key] = value
            }
        }
        // 草稿保留已提交值：面板继续打开时输入框仍显示新值（props.properties 仍是点击时的快照）
        draftRef.current = pending
        setDraft(pending)
    }, [editable, onPropertyChange, properties])

    // 点击面板外部区域时关闭面板（与扇区属性框行为一致）：
    // 覆盖"手形工具拖动地图"（mousedown 起手即关闭）以及点击工具栏/控制面板/扇区等其他区域。
    useEffect(() => {
        if (!visible) return
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node
            if (panelRef.current?.contains(target)) return
            if (contextMenuRef.current?.contains(target)) return
            // 关闭前兜底提交未失焦的字段修改（capture mousedown 早于 blur，此处草稿仍是最新值）
            commitDraft()
            onClose()
        }
        // 使用 mousedown：拖动地图/点击其他区域按下即关闭，避免与 Leaflet click 处理冲突
        document.addEventListener('mousedown', handleClickOutside, true)
        return () => {
            document.removeEventListener('mousedown', handleClickOutside, true)
        }
    }, [visible, onClose, commitDraft])

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

    // 固定宽高：地图视口过小时按视口收缩，正文区域纵向滚动
    const availW = viewportBounds ? viewportBounds.right - viewportBounds.left - 16 : window.innerWidth
    const availH = viewportBounds ? viewportBounds.bottom - viewportBounds.top - 16 : window.innerHeight
    const panelW = Math.min(PANEL_WIDTH, Math.max(280, availW))
    const panelH = Math.min(PANEL_HEIGHT, Math.max(240, availH))

    // 点击位置在地图视口内时按视口钳制；无点击位置时停靠地图视口右上角
    const anchor = position ?? (viewportBounds
        ? { x: viewportBounds.right - 20, y: viewportBounds.top + 60 }
        : { x: window.innerWidth - 40, y: 80 })
    const { left, top } = clampPopupPosition(anchor, { width: panelW, height: panelH }, viewportBounds)

    const style: React.CSSProperties = {
        position: 'fixed',
        top,
        left,
        width: `${panelW}px`,
        height: `${panelH}px`,
        maxWidth: '96vw',
        maxHeight: '96vh',
        overflow: 'hidden',
        zIndex: 10000,
        opacity: visible ? 1 : 0,
        visibility: visible ? 'visible' : 'hidden',
        background: 'hsl(var(--popover) / 0.98)',
        color: 'hsl(var(--foreground))',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.22)',
        borderRadius: '12px',
        border: '1px solid hsl(var(--border))',
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
                <div className="flex items-center justify-between px-5 py-3 bg-muted border-b border-border rounded-t-lg">
                    {onBack && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation()
                                onBack()
                            }}
                            className="p-1.5 hover:bg-accent rounded-full transition-colors flex-shrink-0 mr-1"
                            title={t('map.backToOverlapList')}
                            aria-label={t('map.backToOverlapList')}
                        >
                            <ArrowLeft size={17} />
                        </button>
                    )}
                    <span className="flex flex-col min-w-0 mr-4 flex-1">
                        <span className="text-sm font-semibold text-foreground truncate" title={title || ''}>
                            {title || '要素属性'}
                        </span>
                        {subtitle && (
                            <span className="text-xs text-muted-foreground truncate mt-0.5" title={subtitle}>
                                {subtitle}
                            </span>
                        )}
                    </span>
                    <button
                        onClick={() => { commitDraft(); onClose() }}
                        className="p-1.5 hover:bg-accent rounded-full transition-colors flex-shrink-0"
                    >
                        <X size={17} />
                    </button>
                </div>

                {/* 属性列表正文 - 两栏布局 */}
                <div className="flex-1 overflow-y-auto p-0 scrollbar-thin">
                    <table className="w-full text-sm border-collapse">
                        <tbody className="divide-y divide-border/60">
                            {displayProperties.length === 0 ? (
                                <tr>
                                    <td className="px-5 py-6 text-center text-muted-foreground italic">暂无属性信息</td>
                                </tr>
                            ) : (
                                displayProperties.map(({ key, value }) => {
                                    let displayValue = value
                                    // 处理嵌套对象（非 properties 的其他对象）
                                    if (displayValue && typeof displayValue === 'object') {
                                        displayValue = JSON.stringify(displayValue)
                                    }
                                    // 编辑态：标量字段可修改（对象值保持只读展示）；
                                    // 空值字段（新要素继承的字段尚未填值）同样可编辑，可直接填值
                                    const editableRow = !!editable && !!onPropertyChange
                                        && (value === null || value === undefined || typeof value !== 'object')

                                    return (
                                        <tr key={key} className="hover:bg-muted/50 transition-colors">
                                            <td className="px-5 py-2.5 font-medium text-muted-foreground w-1/3 break-all border-r border-border/60 bg-muted/30 leading-relaxed">
                                                {key}
                                            </td>
                                            <td className={`px-5 py-2.5 text-foreground break-all leading-relaxed ${editableRow ? '' : 'select-text cursor-text'}`}>
                                                {editableRow ? (
                                                    <input
                                                        type="text"
                                                        value={draft[key] ?? (displayValue !== null && displayValue !== undefined ? String(displayValue) : '')}
                                                        onChange={(e) => updateDraft(key, e.target.value)}
                                                        onBlur={() => commitDraft([key])}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') {
                                                                e.preventDefault()
                                                                e.currentTarget.blur()
                                                            } else if (e.key === 'Escape') {
                                                                revertDraft(key)
                                                                e.currentTarget.blur()
                                                            }
                                                        }}
                                                        /* 阻止冒泡：避免触发面板根节点 onClick 的 focus() 抢走输入框焦点 */
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="w-full px-2 py-1 text-sm rounded border border-border bg-background text-foreground outline-none focus:border-primary"
                                                    />
                                                ) : (
                                                    displayValue !== null && displayValue !== undefined ? String(displayValue) : '-'
                                                )}
                                            </td>
                                        </tr>
                                    )
                                })
                            )}
                        </tbody>
                    </table>

                    {/* 新增图层属性字段（编辑态）：字段对图层全部要素生效 */}
                    {editable && onAddProperty && (
                        <div className="border-t border-border/60 px-5 py-3">
                            {showAddForm ? (
                                <div className="flex flex-col gap-2">
                                    <div className="flex gap-2">
                                        <input
                                            ref={newKeyRef}
                                            type="text"
                                            value={newKey}
                                            onChange={(e) => { setNewKey(e.target.value); setAddError('') }}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') { e.preventDefault(); submitAddProperty() }
                                                else if (e.key === 'Escape') resetAddForm()
                                            }}
                                            onClick={(e) => e.stopPropagation()}
                                            placeholder={t('map.attrNamePlaceholder') || '字段名'}
                                            className="w-2/5 px-2 py-1.5 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary"
                                        />
                                        <input
                                            type="text"
                                            value={newVal}
                                            onChange={(e) => { setNewVal(e.target.value); setAddError('') }}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') { e.preventDefault(); submitAddProperty() }
                                                else if (e.key === 'Escape') resetAddForm()
                                            }}
                                            onClick={(e) => e.stopPropagation()}
                                            placeholder={t('map.attrValuePlaceholder') || '值'}
                                            className="flex-1 px-2 py-1.5 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary"
                                        />
                                    </div>
                                    {addError && <span className="text-xs text-red-500">{addError}</span>}
                                    <div className="flex justify-end gap-2">
                                        <button
                                            onClick={(e) => { e.stopPropagation(); resetAddForm() }}
                                            className="px-2.5 py-1 text-xs rounded border border-border text-muted-foreground hover:bg-muted transition-colors"
                                        >
                                            {t('common.cancel') || '取消'}
                                        </button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); submitAddProperty() }}
                                            className="px-2.5 py-1 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity flex items-center gap-1"
                                        >
                                            <Check size={12} />
                                            {t('common.confirm') || '确定'}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <button
                                    onClick={(e) => { e.stopPropagation(); setShowAddForm(true) }}
                                    className="w-full py-1.5 text-xs text-primary hover:bg-muted rounded transition-colors flex items-center justify-center gap-1"
                                >
                                    <Plus size={13} />
                                    {t('map.addAttribute') || '添加属性'}
                                </button>
                            )}
                        </div>
                    )}
                </div>

                {/* 底部装饰或提示 */}
                <div className="px-5 py-2.5 bg-muted border-t border-border/60 text-xs text-muted-foreground flex items-center justify-between gap-3">
                    <span className="text-amber-600 leading-relaxed">
                        {editable ? (t('map.featureEditHint') || '编辑态：字段值可直接修改，修改后使用保存工具写入文件') : ''}
                    </span>
                    <span className="text-right shrink-0">共 {displayProperties.length} 项属性</span>
                </div>

                <style>{`
                .feature-info-panel .scrollbar-thin::-webkit-scrollbar {
                  width: 6px;
                }
                .feature-info-panel .scrollbar-thin::-webkit-scrollbar-track {
                  background: hsl(var(--muted) / 0.5);
                }
                .feature-info-panel .scrollbar-thin::-webkit-scrollbar-thumb {
                  background: hsl(var(--muted-foreground) / 0.35);
                  border-radius: 3px;
                }
                .feature-info-panel .scrollbar-thin::-webkit-scrollbar-thumb:hover {
                  background: hsl(var(--muted-foreground) / 0.5);
                }
            `}</style>
            </div>

            {/* 自定义右键复制菜单 */}
            {contextMenu && (
                <div
                    ref={contextMenuRef}
                    style={{
                        position: 'fixed',
                        top: contextMenu.y,
                        left: contextMenu.x,
                        zIndex: 11000,
                        background: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '4px',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                        padding: '4px 0',
                        minWidth: '80px',
                        color: 'hsl(var(--popover-foreground))'
                    }}
                    onClick={handleCopy}
                >
                    <div className="px-4 py-2 hover:bg-accent cursor-pointer text-sm flex items-center">
                        <span className="mr-2">复制</span>
                        <span className="text-muted-foreground text-xs">Ctrl+C</span>
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
    const [featureSubtitle, setFeatureSubtitle] = useState<string>('')
    const [featureClickPosition, setFeatureClickPosition] = useState<{ x: number; y: number } | undefined>(undefined)

    const showFeatureInfo = useCallback((properties: Record<string, any>, event?: L.LeafletMouseEvent, title?: string, subtitle?: string) => {
        setFeatureTitle(title || '要素属性')
        setFeatureSubtitle(subtitle || '')
        setFeatureProperties(properties)
        setFeaturePanelVisible(true)
        // 防御：Canvas 渲染的点击事件 originalEvent 可能缺失，缺失时使用默认位置，避免抛错导致面板不显示
        if (event && event.originalEvent) {
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
        featureSubtitle,
        featureClickPosition,
        showFeatureInfo,
        hideFeatureInfo
    }
}
