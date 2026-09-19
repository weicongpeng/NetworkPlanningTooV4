/**
 * 热力图图例组件（分级色块列表，参考 Surfer 的 Grid Appearance 图例）
 *
 * 悬浮在地图容器右下角，显示所有"已勾选可见且启用热力图"的图层：
 * 图层名 - 权重字段 + N 级离散色块列表（高值在上）+ 点数。
 * 与 ThematicLegend 平级挂载，位置错开（专题在右上，热力在右下）。
 *
 * 注意：图例是**按设置分级呈现**的色块列表，不是连续色条；
 * 地图上的着色仍是连续渐变（分级方法只决定"值→色带"的映射与图例标注）。
 */
import { useTranslation } from 'react-i18next'
import type { HeatmapSettings } from './LabelSettingsModal'
import { formatLegendValue, gradientColorAt, resolveHeatGradient, resolveLevelGradient } from '../../utils/heatmap'
import type { HeatmapStats } from './HeatmapLayerManager'
import { LegendFrame } from './LegendFrame'

export interface HeatmapLegendItem {
  id: string
  name: string
  settings: HeatmapSettings
}

interface HeatmapLegendProps {
  /** 已过滤的图例项（可见且启用热力图的图层） */
  items: HeatmapLegendItem[]
  /** 权重统计（按图层 id） */
  stats?: Record<string, HeatmapStats | null>
  /** 双击图例跳转到该图层热力设置 */
  onItemDoubleClick?: (item: HeatmapLegendItem) => void
}

export function HeatmapLegend({ items, stats = {}, onItemDoubleClick }: HeatmapLegendProps) {
  const { t } = useTranslation()

  if (!items || items.length === 0) return null

  return (
    <LegendFrame
      layoutKey="heatmap"
      className="heatmap-legend"
      title={t('map.heatmapLayer')}
      defaultAnchor={{ bottom: 24, right: 10 }}
      defaultMaxWidth={260}
      defaultMaxHeight="50vh"
      dragHint={t('map.legendDragHint')}
      resizeHint={t('map.legendResizeHint')}
    >
      {items.map(item => {
        const st = stats[item.id]
        const direction = item.settings.colorDirection
        const stops = resolveHeatGradient(item.settings.colorScheme, direction)
        const method = item.settings.method ?? 'cellCount'
        const round = item.settings.round ?? 0.1
        // 图例按「图例标签顺序」设置呈现（desc=高值在上，默认；asc=低值在上）；
        // 手工编辑占比后原始顺序可能不再单调，必须先按色带位置排序
        const levels = [...(st?.levels ?? [])].sort((a, b) => a.t - b.t)
        if (item.settings.legendOrder !== 'asc') levels.reverse()
        // 图例色块与对比度解耦：按分级原始占比位取色（对比度只作用于地图着色）；
        // 自定义色按原始位注册到色带
        const levelStops = resolveLevelGradient(
          stops,
          (st?.levels ?? []).map(l => ({ t: l.t, color: l.color })),
          direction
        )
        return (
          <div
            key={item.id}
            onDoubleClick={() => onItemDoubleClick?.(item)}
            title={onItemDoubleClick ? t('map.thematicLegendEditHint') : undefined}
            style={{ marginBottom: '8px', cursor: onItemDoubleClick ? 'pointer' : 'default' }}
          >
            <div style={{ fontWeight: 500, color: 'hsl(var(--foreground))', marginBottom: '3px', wordBreak: 'break-all' }}>
              {item.name}{item.settings.field ? ` - ${item.settings.field}` : ''}
            </div>
            <div>
              {levels.map((lv, idx) => (
                <div
                  key={idx}
                  style={{ display: 'flex', alignItems: 'center', gap: '5px', lineHeight: '15px' }}
                  title={`${t('map.heatmapLegendValue')}: ${formatLegendValue(lv.value, round)}`}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: '14px',
                      height: '10px',
                      borderRadius: '2px',
                      border: '1px solid hsl(var(--border))',
                      backgroundColor: lv.color ?? gradientColorAt(levelStops, lv.t),
                      flexShrink: 0
                    }}
                  />
                  <span style={{ color: 'hsl(var(--foreground))' }}>{lv.label}</span>
                  {method === 'cellCount' && (
                    <span style={{ color: 'hsl(var(--muted-foreground))', marginLeft: 'auto' }}>
                      {formatLegendValue(lv.value, round)}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div style={{ color: 'hsl(var(--muted-foreground))', marginTop: '3px' }}>
              {t('map.heatmapPointCount', { count: st?.count ?? 0 })}
              {st?.sampled ? ` · ${t('map.heatmapSampledHint')}` : ''}
            </div>
          </div>
        )
      })}
    </LegendFrame>
  )
}
