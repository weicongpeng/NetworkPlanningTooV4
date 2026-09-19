/**
 * 网优助手图表渲染
 * - line/bar：内联 SVG，零新依赖（多指标趋势点连线 / 柱状对比）
 * - scatter：react-leaflet 地图散点（项目已用 leaflet）
 * chart spec 完全由后端返回，前端只渲染，不造数。
 */
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { AssistantChart } from '../../services/api'

const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899']
const W = 640
const H = 260
const PAD = { l: 48, r: 16, t: 20, b: 40 }

function useScales(categories: string[], series: any[]) {
  const allVals = series.flatMap((s: any) => (s.data || []).map((v: any) => Number(v)).filter((v: number) => !Number.isNaN(v)))
  const vmin = Math.min(...allVals, 0)
  const vmax = Math.max(...allVals, 1)
  const span = vmax - vmin || 1
  const iw = W - PAD.l - PAD.r
  const ih = H - PAD.t - PAD.b
  const x = (i: number) => PAD.l + (categories.length <= 1 ? iw / 2 : (i / (categories.length - 1)) * iw)
  const y = (v: number) => PAD.t + ih - ((v - vmin) / span) * ih
  return { x, y, vmin, vmax, ih }
}

function Axis({ y, vmin, vmax }: { y: (v: number) => number; vmin: number; vmax: number }) {
  const ticks = 4
  return (
    <>
      {Array.from({ length: ticks + 1 }).map((_, i) => {
        const v = vmin + ((vmax - vmin) * i) / ticks
        return (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#e5e7eb" strokeWidth={1} />
            <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" fontSize={10} fill="#6b7280">{v.toFixed(2)}</text>
          </g>
        )
      })}
    </>
  )
}

export function LineChart({ chart }: { chart: AssistantChart }) {
  const categories: string[] = chart.xAxis?.[0]?.categories || []
  const series = chart.series || []
  const { x, y, vmin, vmax } = useScales(categories, series)
  const labelEvery = Math.ceil(categories.length / 8)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <Axis y={y} vmin={vmin} vmax={vmax} />
      {series.map((s: any, si: number) => {
        const color = COLORS[si % COLORS.length]
        const pts = (s.data || []).map((v: any, i: number) =>
          Number.isNaN(Number(v)) ? null : `${x(i)},${y(Number(v))}`).filter(Boolean)
        return (
          <g key={si}>
            <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={2} />
            {(s.data || []).map((v: any, i: number) =>
              Number.isNaN(Number(v)) ? null : (
                <circle key={i} cx={x(i)} cy={y(Number(v))} r={3} fill={color}>
                  <title>{`${categories[i]}: ${v}`}</title>
                </circle>
              ))}
          </g>
        )
      })}
      {categories.map((c: string, i: number) =>
        i % labelEvery === 0 ? (
          <text key={i} x={x(i)} y={H - PAD.b + 16} textAnchor="middle" fontSize={10} fill="#6b7280">
            {c.length > 10 ? c.slice(5) : c}
          </text>
        ) : null)}
      <Legend series={series} />
    </svg>
  )
}

export function BarChart({ chart }: { chart: AssistantChart }) {
  const categories: string[] = chart.xAxis?.[0]?.categories || []
  const series = chart.series || []
  const { x, y, vmin, vmax, ih } = useScales(categories, series)
  const groupW = (W - PAD.l - PAD.r) / Math.max(categories.length, 1)
  const barW = Math.min(24, (groupW / Math.max(series.length, 1)) * 0.7)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <Axis y={y} vmin={vmin} vmax={vmax} />
      {categories.map((c: string, ci: number) =>
        series.map((s: any, si: number) => {
          const v = Number(s.data?.[ci])
          if (Number.isNaN(v)) return null
          const bx = x(ci) - (series.length * barW) / 2 + si * barW
          const by = y(v)
          return <rect key={`${ci}-${si}`} x={bx} y={by} width={barW - 2} height={PAD.t + ih - by} fill={COLORS[si % COLORS.length]}><title>{`${s.name} ${c}: ${v}`}</title></rect>
        }))}
      <Legend series={series} />
    </svg>
  )
}

function Legend({ series }: { series: any[] }) {
  return (
    <g>
      {series.map((s: any, i: number) => (
        <g key={i} transform={`translate(${PAD.l + i * 120}, ${H - 8})`}>
          <rect width={10} height={10} fill={COLORS[i % COLORS.length]} />
          <text x={14} y={9} fontSize={10} fill="#374151">{s.name}</text>
        </g>
      ))}
    </g>
  )
}

export function ScatterMap({ chart }: { chart: AssistantChart }) {
  const points = chart.points || []
  const center = chart.center || points[0]?.value || [114.7, 23.7]
  return (
    <div className="h-72 w-full rounded overflow-hidden border border-gray-200 dark:border-gray-700">
      <MapContainer center={[center[1], center[0]]} zoom={14} style={{ height: '100%', width: '100%' }}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {chart.center && (
          <CircleMarker center={[chart.center[1], chart.center[0]]} radius={8} pathOptions={{ color: '#dc2626', fillColor: '#dc2626', fillOpacity: 0.9 }}>
            <Popup>中心：{chart.title}</Popup>
          </CircleMarker>
        )}
        {points.map((p: any, i: number) => (
          <CircleMarker key={i} center={[p.value[1], p.value[0]]} radius={5}
            pathOptions={{ color: COLORS[i % COLORS.length], fillOpacity: 0.7 }}>
            <Popup>{`${p.name} (${p.net || ''}) ${p.distance_km}km`}</Popup>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  )
}

export function ChartRenderer({ chart }: { chart: AssistantChart }) {
  if (!chart) return null
  return (
    <div className="mt-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
      {chart.title && <div className="text-sm font-medium mb-2 text-gray-800 dark:text-gray-100">{chart.title}</div>}
      {chart.type === 'line' && <LineChart chart={chart} />}
      {chart.type === 'bar' && <BarChart chart={chart} />}
      {chart.type === 'scatter' && <ScatterMap chart={chart} />}
    </div>
  )
}
