/**
 * 专题图层图例组件
 *
 * 悬浮在地图容器内，显示所有"已勾选可见且启用专题图层"的图层图例：
 * - 数值类：连续区间色块（min ~ max）
 * - 文本类：不同文本值色块（"其他"为未列出的取值兜底）
 * 与 OnlineMap 平级挂载（同 PCILegend/TACLegend 模式），由 MapPage 计算并传入 items。
 */
import { useTranslation } from 'react-i18next'
import type { ThematicSettings } from './LabelSettingsModal'

export interface ThematicLegendItem {
  id: string
  name: string
  settings: ThematicSettings
}

/** 区间统计（每个区间的要素数与总数） */
export interface ThematicLegendStats {
  counts: number[]
  total: number
  /** 渲染为黑色“其他”的要素数（未匹配区间 / 未配置属性值 / 未列出的文本值） */
  other: number
}

interface ThematicLegendProps {
  /** 已过滤的图例项（可见且启用专题的图层） */
  items: ThematicLegendItem[]
  /** 区间统计（按图层 id，区间配色模式显示个数与占比） */
  stats?: Record<string, ThematicLegendStats | null>
  /** 双击某个图层图例的回调（跳转到对应图层的专题图层设置） */
  onItemDoubleClick?: (item: ThematicLegendItem) => void
}

/** 数值显示：最多保留 2 位小数，去掉尾随 0 */
function formatNum(v: number): string {
  return String(Math.round(v * 100) / 100)
}

/** 图例“其他”行（黑色兜底）：个数与占比受 showStats 开关控制 */
function OthersRow({ st, showCount }: { st?: ThematicLegendStats | null; showCount: boolean }) {
  const { t } = useTranslation()
  const count = st?.other ?? 0
  const pct = st && st.total > 0 ? Math.round((count / st.total) * 100) : null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '1px 0' }}>
      <span
        style={{
          width: '12px',
          height: '12px',
          backgroundColor: '#000000',
          border: '1px solid rgba(0,0,0,0.2)',
          borderRadius: '2px',
          flexShrink: 0
        }}
      />
      <span style={{ color: '#333' }}>
        {t('map.thematicOthers')}
        {showCount && pct !== null && (
          <span style={{ color: '#888' }}> （{count}，{pct}%）</span>
        )}
      </span>
    </div>
  )
}

export function ThematicLegend({ items, stats = {}, onItemDoubleClick }: ThematicLegendProps) {
  const { t } = useTranslation()

  if (!items || items.length === 0) return null

  return (
    <div
      className="thematic-legend"
      style={{
        position: 'absolute',
        top: '10px',
        right: '10px',
        backgroundColor: 'rgba(255, 255, 255, 0.95)',
        padding: '8px 10px',
        borderRadius: '6px',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
        zIndex: 1000,
        fontSize: '11px',
        maxWidth: '240px',
        maxHeight: '70vh',
        overflowY: 'auto'
      }}
    >
      <div style={{ fontWeight: 600, color: '#333', marginBottom: '6px' }}>
        {t('map.thematicLegendTitle')}
      </div>
      {items.map(item => (
        <div
          key={item.id}
          onDoubleClick={() => onItemDoubleClick?.(item)}
          title={onItemDoubleClick ? t('map.thematicLegendEditHint') : undefined}
          style={{ marginBottom: '8px', cursor: onItemDoubleClick ? 'pointer' : 'default' }}
        >
          <div style={{ fontWeight: 500, color: '#555', marginBottom: '3px', wordBreak: 'break-all' }}>
            {item.name}{item.settings.field ? ` - ${item.settings.field}` : ''}
          </div>
          {item.settings.fieldType === 'numeric' ? (
            item.settings.colorMode === 'value' ? (
              // 属性值配色模式
              <>
                {(item.settings.valueColors || []).map((c, i) => {
                  const st = stats[item.id]
                  const showCount = item.settings.showStats !== false
                  const count = st?.counts?.[i] ?? 0
                  const pct = st && st.total > 0 ? Math.round((count / st.total) * 100) : null
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '1px 0' }}>
                      <span
                        style={{
                          width: '12px',
                          height: '12px',
                          backgroundColor: c.color,
                          border: '1px solid rgba(0,0,0,0.2)',
                          borderRadius: '2px',
                          flexShrink: 0
                        }}
                      />
                      <span style={{ color: '#333', wordBreak: 'break-all' }}>
                        {c.value}
                        {showCount && pct !== null && (
                          <span style={{ color: '#888' }}> （{count}，{pct}%）</span>
                        )}
                      </span>
                    </div>
                  )
                })}
                {/* 未分配的值 → 黑色（其他） */}
                <OthersRow st={stats[item.id]} showCount={item.settings.showStats !== false} />
              </>
            ) : (
              // 区间配色模式
              <>
                {item.settings.ranges.map((r, i) => {
                  const st = stats[item.id]
                  const showCount = item.settings.showStats !== false
                  const count = st?.counts?.[i] ?? 0
                  const pct = st && st.total > 0 ? Math.round((count / st.total) * 100) : null
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '1px 0' }}>
                      <span
                        style={{
                          width: '12px',
                          height: '12px',
                          backgroundColor: r.color,
                          border: '1px solid rgba(0,0,0,0.2)',
                          borderRadius: '2px',
                          flexShrink: 0
                        }}
                      />
                      <span style={{ color: '#333' }}>
                        {formatNum(r.min)} ~ {formatNum(r.max)}
                        {showCount && pct !== null && (
                          <span style={{ color: '#888' }}> （{count}，{pct}%）</span>
                        )}
                      </span>
                    </div>
                  )
                })}
                {/* 未匹配/空值 → 黑色（其他） */}
                <OthersRow st={stats[item.id]} showCount={item.settings.showStats !== false} />
              </>
            )
          ) : (
            item.settings.categories.map((c, i) => {
              const st = stats[item.id]
              const showCount = item.settings.showStats !== false
              const count = st?.counts?.[i] ?? 0
              const pct = st && st.total > 0 ? Math.round((count / st.total) * 100) : null
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '1px 0' }}>
                  <span
                    style={{
                      width: '12px',
                      height: '12px',
                      backgroundColor: c.color,
                      border: '1px solid rgba(0,0,0,0.2)',
                      borderRadius: '2px',
                      flexShrink: 0
                    }}
                  />
                  <span style={{ color: '#333', wordBreak: 'break-all' }}>
                    {c.value === '__other__' ? t('map.thematicOthers') : c.value}
                    {showCount && pct !== null && (
                      <span style={{ color: '#888' }}> （{count}，{pct}%）</span>
                    )}
                  </span>
                </div>
              )
            })
          )}
        </div>
      ))}
    </div>
  )
}
