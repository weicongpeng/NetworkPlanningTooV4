/**
 * 网优助手图表渲染
 *
 * 规格由后端 chart_spec 生成（受 schema 控制），前端只渲染、不造数：
 * - line / bar / stacked_bar / heatmap：ECharts（动态 import，独立 chunk）
 * - 加载失败（极端情况）：折线/柱状降级为内联 SVG，热力图提示看明细表
 * - scatter：react-leaflet 地图散点（周边站点查询沿用旧结构）
 *
 * 主题：项目主题只切换 :root 上的 CSS 变量（不加 .dark 类），所以这里既不用 dark: 变体，
 * 也不写死颜色——ECharts 的坐标轴/文字/提示框颜色在渲染时从 CSS 变量读取，
 * 并订阅 themeMode 变化重建，保证深浅色切换后图表跟着变。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { loadECharts } from '../../services/echartsLoader'
import { useThemeStore } from '../../store/themeStore'
import type { AssistantChart } from '../../services/api'

const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899']
const W = 640
const H = 260
const PAD = { l: 48, r: 16, t: 20, b: 40 }

/** 读取主题 CSS 变量（值为 "H S% L%" 三元组），拼成 hsl() 供 canvas 用 */
function cssHsl(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return raw ? `hsl(${raw})` : fallback
}

function readChartColors() {
  return {
    text: cssHsl('--muted-foreground', '#8b95a5'),
    title: cssHsl('--foreground', '#e6ebf2'),
    axis: cssHsl('--border', '#4a4f57'),
    grid: cssHsl('--border', '#4a4f57'),
    tooltipBg: cssHsl('--popover', '#34383f'),
    tooltipBorder: cssHsl('--border', '#4a4f57'),
    tooltipText: cssHsl('--popover-foreground', '#e6ebf2'),
    split: cssHsl('--muted', '#3a3f47'),
  }
}

export function ChartRenderer({ chart }: { chart: AssistantChart }) {
  if (!chart || !chart.type) return null
  if (chart.type === 'big_number') return <BigNumber chart={chart} />
  if (chart.type === 'scatter' && chart.points?.length) return <ScatterMap chart={chart} />
  return <EChartFigure chart={chart} />
}

function BigNumber({ chart }: { chart: AssistantChart }) {
  const value = chart.value
  const text = value === null || value === undefined
    ? '—'
    : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 })}${chart.unit === 'percent' ? '%' : ''}`
  return (
    <div className="mt-2 rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{chart.label || chart.title}</div>
      <div className="text-2xl font-semibold text-foreground">{text}</div>
      {chart.note && <div className="mt-1 text-[11px] text-warning-foreground">{chart.note}</div>}
    </div>
  )
}

function ScatterMap({ chart }: { chart: AssistantChart }) {
  const center = chart.center || [0, 0]
  return (
    <div className="mt-2 h-64 rounded-lg overflow-hidden border border-border">
      <MapContainer center={[center[1], center[0]]} zoom={14} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          url="https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}"
          subdomains={['1', '2', '3', '4']}
        />
        {(chart.points || []).map((p: any, i: number) => (
          <CircleMarker key={i} center={[p.value[1], p.value[0]]} radius={6} pathOptions={{ color: '#3b82f6' }}>
            <Popup>
              <div className="text-xs">
                <div className="font-medium">{p.name}</div>
                <div>{p.net} · {p.distance_km} km</div>
              </div>
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  )
}

function EChartFigure({ chart }: { chart: AssistantChart }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [echarts, setEcharts] = useState<any>(null)
  const [failed, setFailed] = useState(false)
  const themeMode = useThemeStore((s) => s.themeMode)

  useEffect(() => {
    let alive = true
    loadECharts()
      .then((lib) => { if (alive) setEcharts(lib) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!echarts || !boxRef.current) return
    const instance = echarts.init(boxRef.current)
    instance.setOption(buildOption(chart, readChartColors()), true)
    const onResize = () => instance.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      instance.dispose()
    }
  }, [echarts, chart, themeMode])

  if (failed) return <SvgFallback chart={chart} />
  return (
    <div className="mt-2">
      <div className="text-xs text-muted-foreground mb-1">{chart.title}</div>
      <div ref={boxRef} className="w-full" style={{ height: 260 }} />
      {chart.note && <div className="text-[11px] text-warning-foreground">{chart.note}</div>}
    </div>
  )
}

function buildOption(chart: AssistantChart, colors: ReturnType<typeof readChartColors>): any {
  const base = {
    color: COLORS,
    backgroundColor: 'transparent',
    textStyle: { color: colors.text },
    tooltip: {
      trigger: chart.type === 'heatmap' ? 'item' : 'axis',
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      textStyle: { color: colors.tooltipText, fontSize: 11 },
    },
  }

  if (chart.type === 'heatmap') {
    const xs = Array.from(new Set((chart.values || []).map((v) => v.x)))
    const ys = Array.from(new Set((chart.values || []).map((v) => v.y)))
    const data = (chart.values || []).map((v) => [xs.indexOf(v.x), ys.indexOf(v.y), v.v ?? 0])
    const nums = data.map((d) => Number(d[2])).filter((n) => !Number.isNaN(n))
    return {
      ...base,
      tooltip: { ...base.tooltip, position: 'top' },
      grid: { left: 70, right: 20, top: 20, bottom: 60 },
      xAxis: {
        type: 'category', data: xs,
        axisLabel: { fontSize: 10, color: colors.text },
        axisLine: { lineStyle: { color: colors.axis } },
      },
      yAxis: {
        type: 'category', data: ys,
        axisLabel: { fontSize: 10, color: colors.text },
        axisLine: { lineStyle: { color: colors.axis } },
        splitLine: { lineStyle: { color: colors.split } },
      },
      visualMap: {
        min: Math.min(...nums, 0), max: Math.max(...nums, 1), calculable: true,
        orient: 'horizontal', left: 'center', bottom: 0,
        textStyle: { fontSize: 10, color: colors.text },
      },
      series: [{ type: 'heatmap', data, label: { show: false } }],
    }
  }

  const seriesType = chart.type === 'line' ? 'line' : 'bar'
  return {
    ...base,
    grid: { left: 56, right: 20, top: 24, bottom: (chart.series?.length || 0) > 1 ? 56 : 40 },
    legend: (chart.series?.length || 0) > 1
      ? { bottom: 0, textStyle: { fontSize: 10, color: colors.text }, itemWidth: 14, itemHeight: 8 }
      : undefined,
    xAxis: {
      type: 'category', data: chart.x?.categories || [],
      axisLabel: {
        fontSize: 10, color: colors.text,
        rotate: (chart.x?.categories?.length || 0) > 10 ? 30 : 0,
      },
      axisLine: { lineStyle: { color: colors.axis } },
      axisTick: { lineStyle: { color: colors.axis } },
    },
    yAxis: {
      type: 'value', name: chart.y?.label || '',
      nameTextStyle: { fontSize: 10, color: colors.text },
      axisLabel: { fontSize: 10, color: colors.text },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: colors.split } },
      scale: true,
    },
    series: (chart.series || []).map((s) => ({
      name: s.name, type: seriesType, data: s.data,
      stack: chart.type === 'stacked_bar' ? 'total' : undefined,
      smooth: false, symbolSize: 4, connectNulls: false,
    })),
  }
}

/** ECharts 不可用时的降级：折线/柱状用内联 SVG（颜色取主题变量），热力图直接说明 */
function SvgFallback({ chart }: { chart: AssistantChart }) {
  const { t } = useTranslation()
  const categories = chart.x?.categories || []
  const series = chart.series || []
  const allVals = series.flatMap((s) => (s.data || []).map((v) => Number(v)))
    .filter((v) => !Number.isNaN(v))
  if (chart.type === 'heatmap' || !categories.length || !allVals.length) {
    return (
      <div className="mt-2 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
        {chart.title}：{t('assistant.chartUnavailable')}
      </div>
    )
  }
  const vmin = Math.min(...allVals, 0)
  const vmax = Math.max(...allVals, 1)
  const span = vmax - vmin || 1
  const iw = W - PAD.l - PAD.r
  const ih = H - PAD.t - PAD.b
  const x = (i: number) => PAD.l + (categories.length <= 1 ? iw / 2 : (i / (categories.length - 1)) * iw)
  const y = (v: number) => PAD.t + ih - ((v - vmin) / span) * ih
  const labelEvery = Math.max(1, Math.ceil(categories.length / 8))
  const gridStyle = { stroke: 'hsl(var(--border))' }
  const textStyle = { fill: 'hsl(var(--muted-foreground))' }
  return (
    <div className="mt-2">
      <div className="text-xs text-muted-foreground mb-1">{chart.title}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        {Array.from({ length: 5 }).map((_, i) => {
          const v = vmin + (span * i) / 4
          return (
            <g key={i}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} strokeWidth={1} style={gridStyle} />
              <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" fontSize={10} style={textStyle}>
                {v.toFixed(2)}
              </text>
            </g>
          )
        })}
        {series.map((s, si) => {
          const color = COLORS[si % COLORS.length]
          const pts = (s.data || [])
            .map((v, i) => (v === null || Number.isNaN(Number(v)) ? null : `${x(i)},${y(Number(v))}`))
            .filter(Boolean)
          return (
            <g key={si}>
              {chart.type === 'line' ? (
                <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={2} />
              ) : (
                (s.data || []).map((v, i) => {
                  if (v === null || Number.isNaN(Number(v))) return null
                  const zero = y(Math.max(vmin, 0))
                  return (
                    <rect key={i} x={x(i) - 6} y={y(Number(v))} width={12}
                      height={Math.abs(zero - y(Number(v)))} fill={color} opacity={0.85}>
                      <title>{`${categories[i]}: ${v}`}</title>
                    </rect>
                  )
                })
              )}
            </g>
          )
        })}
        {categories.map((c, i) => i % labelEvery === 0 ? (
          <text key={i} x={x(i)} y={H - PAD.b + 16} textAnchor="middle" fontSize={10} style={textStyle}>
            {String(c).length > 10 ? String(c).slice(5) : c}
          </text>
        ) : null)}
      </svg>
    </div>
  )
}
