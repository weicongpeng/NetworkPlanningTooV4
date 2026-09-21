import { useEffect, useState } from 'react'
import { X, Palette } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMapStore } from '../../store/mapStore'
import type { DrawGeometryType } from '@shared/types'

const PRESET_COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#9775fa', '#ff922b', '#20c997', '#e64980']

const DEFAULT_STYLES: Record<DrawGeometryType, any> = {
  point: { markerShape: 'circle', markerSize: 8, markerColor: '#ff6b6b', borderColor: '#cc2b2b' },
  line: { color: '#ff6b6b', weight: 2.5, opacity: 0.95, dashArray: '' },
  polygon: { fillColor: '#ff6b6b', fillOpacity: 0.3, borderColor: '#cc2b2b', borderWidth: 2, borderDash: '', shape: 'polygon' },
}

const DASH_OPTIONS: Array<{ value: string; key: string; fallback: string }> = [
  { value: '', key: 'map.lineSolid', fallback: '实线' },
  { value: '5,5', key: 'map.lineDashed', fallback: '虚线' },
  { value: '10,10', key: 'map.lineLongDash', fallback: '长虚线' },
  { value: '2,4', key: 'map.lineDotted', fallback: '点线' },
]

const POLYGON_SHAPES: Array<{ value: string; key: string; fallback: string }> = [
  { value: 'polygon', key: 'map.shapePolygon', fallback: '多边形' },
  { value: 'circle', key: 'map.shapeCircle', fallback: '圆形' },
  { value: 'square', key: 'map.shapeSquare', fallback: '方形' },
  { value: 'triangle', key: 'map.shapeTriangle', fallback: '三角形' },
]

const TABS: Array<{ key: DrawGeometryType; label: string }> = [
  { key: 'point', label: 'point' },
  { key: 'line', label: 'line' },
  { key: 'polygon', label: 'polygon' },
]

interface DrawStyleModalProps {
  open: boolean
  tab: DrawGeometryType
  onClose: () => void
}

function ColorRow({ label, value, onChange, allowNoFill }: {
  label: string
  value: string
  onChange: (v: string) => void
  /** 提供"无色"选项（面填充色=镂空仅显示边框） */
  allowNoFill?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-[78px] px-1.5 py-1 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary"
        />
        {allowNoFill && (
          <button
            type="button"
            onClick={() => onChange('none')}
            title={t('map.noFillColor') || '无色'}
            aria-label={t('map.noFillColor') || '无色'}
            className={`relative w-7 h-7 rounded border-2 overflow-hidden bg-background flex-shrink-0 transition-all ${
              value === 'none'
                ? 'border-primary ring-1 ring-primary ring-offset-1'
                : 'border-border hover:border-muted-foreground/50'
            }`}
          >
            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 24 24" preserveAspectRatio="none">
              <line x1="3" y1="21" x2="21" y2="3" stroke="#ef4444" strokeWidth="2.5" />
            </svg>
          </button>
        )}
        <input
          type="color"
          value={value && value !== 'none' ? value : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="w-7 h-7 rounded border border-border cursor-pointer bg-transparent p-0"
        />
      </div>
    </div>
  )
}

export default function DrawStyleModal({ open, tab, onClose }: DrawStyleModalProps) {
  const { t } = useTranslation()
  const drawStyleMap = useMapStore((s) => s.mapSettings.drawStyleMap)
  const setDrawStyle = useMapStore((s) => s.setDrawStyle)
  const [activeTab, setActiveTab] = useState<DrawGeometryType>(tab)

  useEffect(() => { if (open) setActiveTab(tab) }, [open, tab])

  if (!open) return null

  const current: any = drawStyleMap?.[activeTab] || DEFAULT_STYLES[activeTab]
  const update = (patch: Record<string, any>) => setDrawStyle(activeTab, { ...current, ...patch })

  const tabLabel = (k: string) =>
    k === 'point' ? (t('map.point') || '点') : k === 'line' ? (t('map.line') || '线') : (t('map.polygon') || '面')

  return (
    <div className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/20" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-lg p-5 w-[340px] flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Palette size={16} className="text-primary" />
            {t('map.drawStyleTitle') || '绘制样式'}
          </div>
          <button className="text-muted-foreground hover:text-foreground transition-colors" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* 页签 */}
        <div className="flex gap-1 p-0.5 bg-muted rounded">
          {TABS.map((tt) => (
            <button
              key={tt.key}
              onClick={() => setActiveTab(tt.key)}
              className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                activeTab === tt.key ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tabLabel(tt.key)}
            </button>
          ))}
        </div>

        {/* 预设配色 */}
        <div>
          <div className="text-xs text-muted-foreground mb-1.5">{t('map.presetStyles') || '预设风格'}</div>
          <div className="flex gap-1.5 flex-wrap">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => {
                  if (activeTab === 'point') update({ markerColor: c, borderColor: c })
                  else if (activeTab === 'line') update({ color: c })
                  else update({ fillColor: c, borderColor: c })
                }}
                className="w-6 h-6 rounded-full border border-border hover:scale-110 transition-transform"
                style={{ background: c }}
                title={c}
              />
            ))}
          </div>
        </div>

        {/* 点样式 */}
        {activeTab === 'point' && (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t('map.markerShape') || '形状'}</span>
              <select
                value={current.markerShape}
                onChange={(e) => update({ markerShape: e.target.value })}
                className="px-1.5 py-1 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary"
              >
                <option value="circle">{t('map.shapeCircle') || '圆形'}</option>
                <option value="square">{t('map.shapeSquare') || '方形'}</option>
                <option value="diamond">{t('map.shapeDiamond') || '菱形'}</option>
                <option value="triangle">{t('map.shapeTriangle') || '三角形'}</option>
              </select>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t('map.markerSize') || '大小'}</span>
              <input type="range" min={4} max={22} step={1} value={current.markerSize}
                onChange={(e) => update({ markerSize: Number(e.target.value) })} className="w-40" />
              <span className="text-xs text-foreground w-6 text-right">{current.markerSize}</span>
            </div>
            <ColorRow label={t('map.fillColor') || '填充色'} value={current.markerColor} onChange={(v) => update({ markerColor: v })} />
            <ColorRow label={t('map.borderColor') || '边框色'} value={current.borderColor} onChange={(v) => update({ borderColor: v })} />
          </div>
        )}

        {/* 线样式 */}
        {activeTab === 'line' && (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t('map.lineShape') || '图形样式'}</span>
              <select
                value={current.shape || 'line'}
                onChange={(e) => update({ shape: e.target.value })}
                className="px-1.5 py-1 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary"
              >
                <option value="line">{t('map.lineStraight') || '直线'}</option>
                <option value="curve">{t('map.lineCurve') || '曲线'}</option>
              </select>
            </div>
            <ColorRow label={t('map.lineColor') || '线颜色'} value={current.color} onChange={(v) => update({ color: v })} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t('map.lineWidth') || '线宽'}</span>
              <input type="range" min={1} max={7} step={0.5} value={current.weight}
                onChange={(e) => update({ weight: Number(e.target.value) })} className="w-40" />
              <span className="text-xs text-foreground w-6 text-right">{current.weight}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t('map.opacity') || '透明度'}</span>
              <input type="range" min={10} max={100} step={5} value={Math.round(current.opacity * 100)}
                onChange={(e) => update({ opacity: Number(e.target.value) / 100 })} className="w-40" />
              <span className="text-xs text-foreground w-6 text-right">{Math.round(current.opacity * 100)}%</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t('map.lineDash') || '线型'}</span>
              <select
                value={current.dashArray || ''}
                onChange={(e) => update({ dashArray: e.target.value })}
                className="px-1.5 py-1 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary"
              >
                <option value="">{t('map.lineSolid') || '实线'}</option>
                <option value="5,5">{t('map.lineDashed') || '虚线'}</option>
                <option value="10,10">{t('map.lineLongDash') || '长虚线'}</option>
                <option value="2,4">{t('map.lineDotted') || '点线'}</option>
              </select>
            </div>
          </div>
        )}

        {/* 面样式 */}
        {activeTab === 'polygon' && (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t('map.polygonShape') || '图形样式'}</span>
              <select
                value={current.shape || 'polygon'}
                onChange={(e) => update({ shape: e.target.value })}
                className="px-1.5 py-1 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary"
              >
                {POLYGON_SHAPES.map((o) => (
                  <option key={o.value} value={o.value}>{t(o.key) || o.fallback}</option>
                ))}
              </select>
            </div>
            <ColorRow label={t('map.fillColor') || '填充色'} value={current.fillColor} allowNoFill onChange={(v) => update({ fillColor: v })} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t('map.fillOpacity') || '填充透明度'}</span>
              <input type="range" min={0} max={100} step={5} value={Math.round(current.fillOpacity * 100)}
                onChange={(e) => update({ fillOpacity: Number(e.target.value) / 100 })} className="w-40" />
              <span className="text-xs text-foreground w-6 text-right">{Math.round(current.fillOpacity * 100)}%</span>
            </div>
            <ColorRow label={t('map.borderColor') || '边框色'} value={current.borderColor} onChange={(v) => update({ borderColor: v })} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t('map.borderWidth') || '边框宽'}</span>
              <input type="range" min={1} max={6} step={0.5} value={current.borderWidth}
                onChange={(e) => update({ borderWidth: Number(e.target.value) })} className="w-40" />
              <span className="text-xs text-foreground w-6 text-right">{current.borderWidth}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t('map.borderDash') || '边框线型'}</span>
              <select
                value={current.borderDash || ''}
                onChange={(e) => update({ borderDash: e.target.value })}
                className="px-1.5 py-1 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary"
              >
                {DASH_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{t(o.key) || o.fallback}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="flex justify-end mt-1">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >
            {t('common.confirm') || '完成'}
          </button>
        </div>
      </div>
    </div>
  )
}
