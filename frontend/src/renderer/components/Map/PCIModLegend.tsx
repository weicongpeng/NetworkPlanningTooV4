/**
 * 小区PCI模值图例
 *
 * 悬浮在地图容器左上方，显示已启用"小区PCI渲染"的基站扇区图层（LTE/NR）。
 * 渲染条件：同频点且同模值才同色，故图例按"频点"分组：
 * - 每个频点一个小标题；模 3 为三行色块（0/1/2），模 30 为紧凑网格（6列×5行）；
 * - 灰色行：无有效PCI / 无有效频点的小区数（这两类小区保持原配色）。
 * 颜色与扇区渲染同源（utils/pciModColor 调色板按"频点×模值"组合编号）。
 */
import { useTranslation } from 'react-i18next'
import { LegendFrame } from './LegendFrame'
import { buildPciModPalette } from '../../utils/pciModColor'
import type { PciMod, PciRenderStats } from '../../utils/pciModColor'

export interface PciModLegendItem {
  id: string
  /** 分组名（LTE / NR） */
  name: string
  /** 取模方式 */
  mod: PciMod
}

export type { PciRenderStats }

interface PciModLegendProps {
  items: PciModLegendItem[]
  stats?: Record<string, PciRenderStats | null>
  /** 双击分组（跳转到对应图层的默认设置） */
  onItemDoubleClick?: (item: PciModLegendItem) => void
}

export function PciModLegend({ items, stats = {}, onItemDoubleClick }: PciModLegendProps) {
  const { t } = useTranslation()

  if (!items || items.length === 0) return null

  return (
    <LegendFrame
      layoutKey="pci-mod"
      className="pci-mod-legend"
      title={t('map.pciModLegendTitle')}
      defaultAnchor={{ top: 10, left: 10 }}
      defaultMaxWidth={220}
      defaultMaxHeight="70vh"
      dragHint={t('map.legendDragHint')}
      resizeHint={t('map.legendResizeHint')}
    >
      {items.map(item => {
        const st = stats[item.id]
        return (
          <div
            key={item.id}
            onDoubleClick={() => onItemDoubleClick?.(item)}
            title={onItemDoubleClick ? t('map.thematicLegendEditHint') : undefined}
            style={{ marginBottom: '8px', cursor: onItemDoubleClick ? 'pointer' : 'default' }}
          >
            <div style={{ fontWeight: 500, color: 'hsl(var(--foreground))', marginBottom: '4px' }}>
              {item.name}
              <span style={{ color: 'hsl(var(--muted-foreground))', fontWeight: 400 }}>
                {' · '}{item.mod === 3 ? t('map.pciMod3') : t('map.pciMod30')}
              </span>
            </div>

            {/* 各频点分组（颜色序号 = 频点序号 × mod + 模值） */}
            {st?.frequencies.map((group, freqIndex) => (
              <div key={group.frequency} style={{ marginBottom: '6px' }}>
                <div style={{
                  color: 'hsl(var(--muted-foreground))',
                  fontSize: '11px',
                  marginBottom: '2px'
                }}>
                  {t('map.pciFrequency', { frequency: group.frequency })}
                </div>

                {item.mod === 3 ? (
                  [0, 1, 2].map(value => {
                    const count = group.counts[value]
                    const pct = group.total > 0 ? Math.round((count / group.total) * 100) : null
                    return (
                      <div key={value} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '1px 0' }}>
                        <span
                          style={{
                            width: '12px',
                            height: '12px',
                            backgroundColor: st ? colorAt(st, freqIndex, 3, value) : undefined,
                            border: '1px solid rgba(0,0,0,0.2)',
                            borderRadius: '2px',
                            flexShrink: 0
                          }}
                        />
                        <span style={{ color: 'hsl(var(--foreground))' }}>
                          {value}
                          {pct !== null && (
                            <span style={{ color: 'hsl(var(--muted-foreground))' }}>
                              {t('map.pciCountPct', { count, pct })}
                            </span>
                          )}
                        </span>
                      </div>
                    )
                  })
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '2px' }}>
                    {Array.from({ length: 30 }, (_, value) => {
                      const count = group.counts[value]
                      return (
                        <div
                          key={value}
                          title={t('map.pciFreqModCount', {
                            frequency: group.frequency, value, count
                          })}
                          style={{
                            height: '20px',
                            backgroundColor: colorAt(st, freqIndex, 30, value),
                            border: '1px solid rgba(0,0,0,0.2)',
                            borderRadius: '2px',
                            color: '#fff',
                            fontSize: '9px',
                            lineHeight: '18px',
                            textAlign: 'center',
                            textShadow: '0 0 2px rgba(0,0,0,0.9)'
                          }}
                        >
                          {value}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}

            {/* 无有效PCI（勾选频点下无PCI，保持原配色）；数量为0不显示 */}
            {(st?.noPci ?? 0) > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '1px 0' }}>
                <span
                  style={{
                    width: '12px',
                    height: '12px',
                    backgroundColor: 'hsl(var(--muted))',
                    border: '1px solid rgba(0,0,0,0.2)',
                    borderRadius: '2px',
                    flexShrink: 0
                  }}
                />
                <span style={{ color: 'hsl(var(--muted-foreground))', fontSize: '11px' }}>
                  {t('map.pciNoPciCount', { count: st!.noPci })}
                </span>
              </div>
            )}
            {/* 无有效频点（保持原配色）；数量为0不显示 */}
            {(st?.noFrequency ?? 0) > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '1px 0' }}>
                <span
                  style={{
                    width: '12px',
                    height: '12px',
                    backgroundColor: 'hsl(var(--muted))',
                    border: '1px dashed rgba(0,0,0,0.35)',
                    borderRadius: '2px',
                    flexShrink: 0
                  }}
                />
                <span style={{ color: 'hsl(var(--muted-foreground))', fontSize: '11px' }}>
                  {t('map.pciNoFrequencyCount', { count: st!.noFrequency })}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </LegendFrame>
  )
}

/**
 * 取统计中"频点×模值"组合的颜色。
 * 统计与渲染共用同一调色板（freqCount × mod 个黄金角色），按同输入重建取色。
 */
function colorAt(st: PciRenderStats, freqIndex: number, mod: PciMod, modValue: number): string {
  return buildPciModPalette(st.frequencies.length, mod)[freqIndex * mod + modValue]
}
