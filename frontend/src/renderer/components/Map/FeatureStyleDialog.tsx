import { useEffect, useMemo, useState } from 'react'
import { X, Ruler, Palette } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLayerEditStore, type InspectFeature } from '../../store/layerEditStore'
import { useMapStore } from '../../store/mapStore'
import { NO_FILL_COLOR } from '../../utils/fieldValue'
import { wgs84ToGcj02 } from '../../utils/coordinate'
import type { DrawGeometryType } from '@shared/types'

const EARTH_R = 6378137

const DEFAULT_STYLES: Record<DrawGeometryType, Record<string, any>> = {
  point: { markerShape: 'circle', markerSize: 8, markerColor: '#ff6b6b', borderColor: '#cc2b2b' },
  line: { color: '#ff6b6b', weight: 2.5, opacity: 1, dashArray: '' },
  polygon: { fillColor: '#ff6b6b', fillOpacity: 1, borderColor: '#cc2b2b', borderWidth: 2, borderDash: '', shape: 'polygon' },
}

const DASH_OPTIONS: Array<{ value: string; key: string; fallback: string }> = [
  { value: '', key: 'map.lineSolid', fallback: '实线' },
  { value: '5,5', key: 'map.lineDashed', fallback: '虚线' },
  { value: '10,10', key: 'map.lineLongDash', fallback: '长虚线' },
  { value: '2,4', key: 'map.lineDotted', fallback: '点线' },
]

const toRad = (d: number) => (d * Math.PI) / 180

/**
 * GCJ02 → WGS84 精确逆变换（固定点迭代，与后端保存时口径一致）。
 * 一阶近似 w = g - offset(g) 残留 0.3~2m 误差，中心点展示 6 位小数时可见，
 * 这里迭代到往返位级一致（单点开销可忽略；共享工具保持一阶近似供 3D 批量转换）。
 */
function gcj02ToWgs84Exact(lat: number, lng: number): [number, number] {
  let wLat = lat
  let wLng = lng
  for (let i = 0; i < 6; i++) {
    const [fLat, fLng] = wgs84ToGcj02(wLat, wLng)
    wLat += lat - fLat
    wLng += lng - fLng
  }
  return [wLat, wLng]
}

function haversine(a: [number, number], b: [number, number]): number {
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** 环长度（closed=true 时首尾相连） */
function ringLength(ring: Array<[number, number]>, closed: boolean): number {
  let total = 0
  for (let i = 0; i < ring.length - 1; i++) total += haversine(ring[i], ring[i + 1])
  if (closed && ring.length > 2) total += haversine(ring[ring.length - 1], ring[0])
  return total
}

/** 球面近似面积（m²），环坐标为 [lng, lat] */
function ringArea(ring: Array<[number, number]>): number {
  if (ring.length < 3) return 0
  let total = 0
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i]
    const p2 = ring[(i + 1) % ring.length]
    total += toRad(p2[0] - p1[0]) * (2 + Math.sin(toRad(p1[1])) + Math.sin(toRad(p2[1])))
  }
  return Math.abs((total * EARTH_R * EARTH_R) / 2)
}

interface GeometryStats {
  kind: DrawGeometryType
  typeLabel: string
  nodeCount: number
  lengthM: number | null
  perimeterM: number | null
  areaM2: number | null
  centroid: [number, number] | null
}

function computeStats(geometry: any): GeometryStats | null {
  if (!geometry?.type) return null
  const t = geometry.type
  const coords = geometry.coordinates
  const rings: Array<Array<[number, number]>> =
    t === 'Polygon' ? (coords || []) : t === 'MultiPolygon' ? (coords || []).flat() : []

  const countNodes = (c: any): number => {
    if (!Array.isArray(c)) return 0
    if (typeof c[0] === 'number') return 1
    return c.reduce((s: number, x: any) => s + countNodes(x), 0)
  }

  const centroid = (): [number, number] | null => {
    const pts: Array<[number, number]> = []
    const walk = (c: any) => {
      if (!Array.isArray(c)) return
      if (typeof c[0] === 'number') pts.push([c[0], c[1]])
      else c.forEach(walk)
    }
    walk(coords)
    if (pts.length === 0) return null
    const lng = pts.reduce((s, p) => s + p[0], 0) / pts.length
    const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length
    return [lng, lat]
  }

  if (t === 'Point' || t === 'MultiPoint') {
    const single = t === 'Point'
    return {
      kind: 'point',
      typeLabel: single ? 'Point' : 'MultiPoint',
      nodeCount: single ? 1 : countNodes(coords),
      lengthM: null,
      perimeterM: null,
      areaM2: null,
      centroid: single ? coords : centroid(),
    }
  }

  if (t === 'LineString' || t === 'MultiLineString') {
    const lines: Array<Array<[number, number]>> = t === 'LineString' ? [coords] : coords
    let len = 0
    let nodes = 0
    lines.forEach((l) => {
      len += ringLength(l, false)
      nodes += l?.length || 0
    })
    return {
      kind: 'line',
      typeLabel: t,
      nodeCount: nodes,
      lengthM: len,
      perimeterM: null,
      areaM2: null,
      centroid: centroid(),
    }
  }

  let perimeter = 0
  let area = 0
  let nodes = 0
  rings.forEach((r, i) => {
    perimeter += ringLength(r, true)
    const a = ringArea(r)
    area += i === 0 ? a : -a
    nodes += Math.max(0, (r?.length || 1) - 1)
  })
  return {
    kind: 'polygon',
    typeLabel: t,
    nodeCount: nodes,
    lengthM: null,
    perimeterM: perimeter,
    areaM2: Math.abs(area),
    centroid: centroid(),
  }
}

function fmtLength(m: number, t: any): string {
  return m >= 1000 ? `${(m / 1000).toFixed(3)} km` : `${m.toFixed(2)} ${t('map.meters') || '米'}`
}

/** 周长统一千米（边界/长度类量按需求统一口径） */
function fmtPerimeterKm(m: number): string {
  return `${(m / 1000).toFixed(3)} km`
}

function fmtArea(m2: number): string {
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(3)} km²`
  if (m2 >= 1e4) return `${(m2 / 666.667).toFixed(2)} 亩`
  return `${m2.toFixed(2)} m²`
}

function ColorRow({ label, value, onChange, disabled, allowNoFill }: {
  label: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  /** 提供"无色"选项（图形颜色=镂空/不描边） */
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
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-[78px] px-1.5 py-1 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary disabled:opacity-50"
        />
        {allowNoFill && (
          <button
            type="button"
            onClick={() => onChange(NO_FILL_COLOR)}
            disabled={disabled}
            title={t('map.noFillColor') || '无色'}
            aria-label={t('map.noFillColor') || '无色'}
            className={`relative w-7 h-7 rounded border-2 overflow-hidden bg-background flex-shrink-0 transition-all disabled:opacity-50 ${
              value === NO_FILL_COLOR
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
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-7 h-7 rounded border border-border cursor-pointer bg-transparent p-0 disabled:opacity-50"
        />
      </div>
    </div>
  )
}

function SelectRow({ label, value, options, onChange, disabled }: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="px-1.5 py-1 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary disabled:opacity-50 min-w-[92px]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}

function RangeRow({ label, value, min, max, step, suffix, onChange, disabled }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix: string
  onChange: (v: number) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-32 disabled:opacity-50"
        />
        <span className="text-xs text-foreground w-10 text-right">{suffix}</span>
      </div>
    </div>
  )
}

interface FeatureStyleDialogProps {
  open: boolean
  data: InspectFeature | null
  layerName?: string
  onClose: () => void
}

/**
 * 要素属性/风格配置弹窗（"选择"工具下双击要素打开）：
 * 上半部分是几何统计（类型/节点数/长度/周长/面积/中心点），
 * 下半部分是风格配置（图形类型、颜色、边框色、边框线型、线宽、点大小）。
 */
export default function FeatureStyleDialog({ open, data, layerName, onClose }: FeatureStyleDialogProps) {
  const { t } = useTranslation()
  const drawStyleMap = useMapStore((s) => s.mapSettings.drawStyleMap)
  const updateFeatureStyle = useLayerEditStore((s) => s.updateFeatureStyle)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const stats = useMemo(() => (open && data ? computeStats(data.geometry) : null), [open, data])
  // 几何统计与命中几何均为渲染坐标（GCJ02），中心点展示给用户前转回 WGS84，
  // 与地图打点/属性弹窗的展示口径一致（见 utils/coordinate.ts）
  const centerWgs84 = useMemo(() => {
    if (!stats?.centroid) return null
    const [lat, lng] = gcj02ToWgs84Exact(stats.centroid[1], stats.centroid[0])
    return [lng, lat] as [number, number]
  }, [stats])
  const initialStyle = useMemo(() => {
    if (!data || !stats) return null
    const own = data.properties?._editStyle
    if (own && typeof own === 'object' && !(own as any).point && !(own as any).line && !(own as any).polygon) {
      return { ...DEFAULT_STYLES[stats.kind], ...own }
    }
    return { ...DEFAULT_STYLES[stats.kind], ...(drawStyleMap?.[stats.kind] || {}) }
  }, [data, stats, drawStyleMap])

  const [style, setStyle] = useState<Record<string, any> | null>(null)
  useEffect(() => {
    if (open) setStyle(initialStyle)
  }, [open, initialStyle])

  if (!open || !data || !stats || !style) return null

  const canEdit = !!data.editable && !!data.layerId && !!data.editId
  const patch = (p: Record<string, any>) => setStyle((s) => ({ ...(s || {}), ...p }))

  const apply = () => {
    if (!canEdit) return
    updateFeatureStyle(data.layerId, data.editId!, style)
    onClose()
  }

  // 线要素线型选项（点/面形状下拉已移除）
  const lineDashOptions = DASH_OPTIONS.map((o) => ({ value: o.value, label: t(o.key) || o.fallback }))

  return (
    <div className="fixed inset-0 z-[5200] flex items-center justify-center bg-black/20" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-lg p-5 w-[380px] max-h-[80vh] overflow-y-auto flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground min-w-0">
            <Ruler size={16} className="text-primary shrink-0" />
            <span className="truncate">{t('map.featureStyleTitle') || '图形属性'}</span>
          </div>
          <button className="text-muted-foreground hover:text-foreground transition-colors" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {data.name || layerName || data.layerName ? (
          <div className="text-xs text-muted-foreground truncate">
            {[data.name, layerName || data.layerName].filter(Boolean).join(' · ')}
          </div>
        ) : null}

        {/* 统计信息 */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 border border-border rounded-md p-3">
          <span className="text-xs text-muted-foreground">{t('map.geomType') || '图形类型'}</span>
          <span className="text-xs text-foreground text-right">{stats.typeLabel}</span>
          <span className="text-xs text-muted-foreground">{t('map.nodeCount') || '节点数'}</span>
          <span className="text-xs text-foreground text-right">{stats.nodeCount}</span>
          {stats.lengthM !== null && (
            <>
              <span className="text-xs text-muted-foreground">{t('map.geomLength') || '长度'}</span>
              <span className="text-xs text-foreground text-right">{fmtLength(stats.lengthM, t)}</span>
            </>
          )}
          {stats.perimeterM !== null && (
            <>
              <span className="text-xs text-muted-foreground">{t('map.geomPerimeter') || '周长(km)'}</span>
              <span className="text-xs text-foreground text-right">{fmtPerimeterKm(stats.perimeterM)}</span>
            </>
          )}
          {stats.areaM2 !== null && (
            <>
              <span className="text-xs text-muted-foreground">{t('map.geomArea') || '面积'}</span>
              <span className="text-xs text-foreground text-right">{fmtArea(stats.areaM2)}</span>
            </>
          )}
          {centerWgs84 && (
            <>
              <span className="text-xs text-muted-foreground">{t('map.geomCentroid') || '中心点'}</span>
              <span className="text-xs text-foreground text-right">
                {centerWgs84[0].toFixed(6)}, {centerWgs84[1].toFixed(6)}
              </span>
            </>
          )}
        </div>

        {/* 风格配置 */}
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Palette size={15} className="text-primary" />
          {t('map.styleSection') || '风格配置'}
        </div>

        <div className="flex flex-col gap-2.5">
          {/* 形状下拉已移除（点/面绘制形状不可改）；仅线要素保留线型（实线/虚线） */}
          {stats.kind === 'line' && (
            <SelectRow
              label={t('map.markerShape') || '图形类型'}
              value={style.dashArray || ''}
              options={lineDashOptions}
              disabled={!canEdit}
              onChange={(v) => patch({ dashArray: v })}
            />
          )}

          {stats.kind === 'point' && (
            <>
              <RangeRow
                label={t('map.markerSize') || '点大小'}
                value={style.markerSize ?? 8}
                min={4} max={22} step={1}
                suffix={String(style.markerSize ?? 8)}
                disabled={!canEdit}
                onChange={(v) => patch({ markerSize: v })}
              />
              <ColorRow label={t('map.fillColor') || '图形颜色'} value={style.markerColor} disabled={!canEdit} allowNoFill onChange={(v) => patch({ markerColor: v })} />
              <ColorRow label={t('map.borderColor') || '边框颜色'} value={style.borderColor} disabled={!canEdit} onChange={(v) => patch({ borderColor: v })} />
            </>
          )}

          {stats.kind === 'line' && (
            <>
              <ColorRow label={t('map.lineColor') || '图形颜色'} value={style.color} disabled={!canEdit} allowNoFill onChange={(v) => patch({ color: v })} />
              <RangeRow
                label={t('map.lineWidth') || '线宽'}
                value={style.weight ?? 2.5}
                min={1} max={7} step={0.5}
                suffix={String(style.weight ?? 2.5)}
                disabled={!canEdit}
                onChange={(v) => patch({ weight: v })}
              />
              <RangeRow
                label={t('map.opacity') || '透明度'}
                value={Math.round((style.opacity ?? 1) * 100)}
                min={10} max={100} step={5}
                suffix={`${Math.round((style.opacity ?? 1) * 100)}%`}
                disabled={!canEdit}
                onChange={(v) => patch({ opacity: v / 100 })}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{t('map.lineArrow') || '带方向线段的线'}</span>
                <input
                  type="checkbox"
                  checked={!!style.arrow}
                  disabled={!canEdit}
                  onChange={(e) => patch({ arrow: e.target.checked })}
                  className="layer-standard-checkbox"
                />
              </div>
            </>
          )}

          {stats.kind === 'polygon' && (
            <>
              <ColorRow label={t('map.fillColor') || '图形颜色'} value={style.fillColor} disabled={!canEdit} allowNoFill onChange={(v) => patch({ fillColor: v })} />
              <RangeRow
                label={t('map.fillOpacity') || '填充透明度'}
                value={Math.round((style.fillOpacity ?? 1) * 100)}
                min={0} max={100} step={5}
                suffix={`${Math.round((style.fillOpacity ?? 1) * 100)}%`}
                disabled={!canEdit}
                onChange={(v) => patch({ fillOpacity: v / 100 })}
              />
              <ColorRow label={t('map.borderColor') || '边框颜色'} value={style.borderColor} disabled={!canEdit} onChange={(v) => patch({ borderColor: v })} />
              <RangeRow
                label={t('map.borderWidth') || '边框宽'}
                value={style.borderWidth ?? 2}
                min={1} max={6} step={0.5}
                suffix={String(style.borderWidth ?? 2)}
                disabled={!canEdit}
                onChange={(v) => patch({ borderWidth: v })}
              />
              <SelectRow
                label={t('map.borderDash') || '边框线型'}
                value={style.borderDash || ''}
                options={DASH_OPTIONS.map((o) => ({ value: o.value, label: t(o.key) || o.fallback }))}
                disabled={!canEdit}
                onChange={(v) => patch({ borderDash: v })}
              />
            </>
          )}

          {!canEdit && (
            <div className="text-[11px] text-amber-600 leading-relaxed">
              {t('map.styleDisabledHint') || '该图层未开启编辑（图层面板铅笔开关），开启后可修改此要素样式'}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-1">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:bg-muted transition-colors"
          >
            {t('common.cancel') || '取消'}
          </button>
          <button
            onClick={apply}
            disabled={!canEdit}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {t('map.applyStyle') || '应用'}
          </button>
        </div>
      </div>
    </div>
  )
}
