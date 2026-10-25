/**
 * 地图搜索弹窗（Ctrl+F 调出）
 *
 * 数据源来自「数据管理」已导入数据，分三组：
 * - 基站工参（excel 工参文件）：模糊搜索小区/基站，定位方式与原工参搜索一致（瞬时定位 + 标记点）
 * - 图层文件（MapInfo 图层）：模糊搜索要素属性，定位到要素并红色边框高亮
 * - 地理化数据（Excel 点/扇区/多边形）：同上，红色边框高亮
 *
 * 坐标约定：工参/地理化点数据为 WGS84（前端转 GCJ02）；
 * MapInfo getLayerData 与地理化多边形 path 后端已转 GCJ02，直接使用。
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Search, X, Database, Layers, MapPin, Loader2, FileSpreadsheet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { layerApi, dataApi } from '../../services/api'
import { useDataStore } from '../../store/dataStore'
import { useMapDataCacheStore } from '../../store/mapDataCacheStore'
import { CoordinateTransformer } from '../../utils/coordinate'
import { extractFeatureId } from '../../utils/featureId'

type SourceGroup = 'workbook' | 'mapinfo' | 'geo'

interface SearchSource {
  key: string
  group: SourceGroup
  name: string
  dataId: string
  /** MapInfo 子图层 ID（图层文件组） */
  layerId?: string
}

export interface LayerFeatureLocate {
  layerId: string
  featureId: string
  /** GCJ02 [lat, lng] */
  center?: [number, number]
  /** GCJ02 [[南,西],[北,东]] */
  bounds?: [[number, number], [number, number]]
}

export interface SectorLocate {
  /** 扇区渲染 ID（与扇区图层 setSelectionHighlight 匹配） */
  id: string
  lat: number
  lng: number
  /** 制式（定位前自动开启对应图层） */
  networkType?: string
}

/** 工参搜索结果（复用原"搜索定位"工参搜索逻辑，坐标为 GCJ02 渲染坐标） */
export interface WorkbookSearchResult {
  id: string
  name: string
  networkType?: string
  siteId?: string
  sectorId?: string
  lat?: number
  lng?: number
}

interface PreparedRecord {
  /** 要素/小区显示名 */
  name: string
  /** 拼接后的可搜索文本（小写） */
  searchText: string
  /** 结果副标题 */
  detail: string
  kind: 'sector' | 'feature'
  /** feature 高亮 ID */
  featureId?: string
  /** feature 所属图层 ID（图层文件=子图层ID，地理化=文件ID） */
  layerId?: string
  center?: [number, number]
  bounds?: [[number, number], [number, number]]
  networkType?: string
  /** 工参扇区渲染 ID（kind=sector 时用于红色边框高亮扇区图形） */
  sectorId?: string
  /** 可展示的字段键值对（用于在结果中显示命中关键字的字段内容） */
  fieldPairs: Array<{ key: string; value: string }>
}

/** 搜索结果（附带命中关键字的字段） */
interface SearchResultRecord extends PreparedRecord {
  matches: Array<{ key: string; value: string }>
}

interface MapSearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 工参搜索（复用原"搜索定位"逻辑：搜当前数据源 LTE/NR 小区名/基站ID/小区ID） */
  searchWorkbook: (keyword: string) => WorkbookSearchResult[]
  /** 当前工参数据源名称（工参分组条目显示名） */
  workbookSourceName?: string
  /** 工参搜索结果定位（瞬时定位 + 搜索标记，与原搜索框行为一致） */
  onLocateSector: (r: SectorLocate) => void
  /** 图层/地理化要素定位（瞬时定位 + 红色边框高亮） */
  onLocateLayerFeature: (r: LayerFeatureLocate) => Promise<boolean>
}

// 模块级数据缓存（弹窗多次开关复用，避免重复请求）
const _mapLayersCache = new Map<string, any[]>()          // dataId -> MapInfo 图层列表
const _recordsCache = new Map<string, PreparedRecord[]>() // sourceKey -> 预处理记录

/** 从后端返回中提取扁平行数组（兼容数组 / {data} / {default} / {LTE,NR} 等结构） */
function normalizeRows(payload: any): any[] {
  const d = payload?.data ?? payload
  if (Array.isArray(d)) return d
  if (!d || typeof d !== 'object') return []
  if (Array.isArray(d.data)) return d.data
  if (Array.isArray(d.default)) return d.default

  // 工参结构：{ LTE: [站点...], NR: [站点...] }，站点为 { id, name, longitude, latitude, sectors: [小区...] }。
  // 必须展平到小区级（sectors），否则扇区字段（小区名/PCI/频点/TAC 等）无法被搜索，且 NR 子表丢失。
  const expandSites = (sites: any[], net: string): any[] => {
    const out: any[] = []
    for (const site of sites) {
      if (site && Array.isArray(site.sectors) && site.sectors.length > 0) {
        for (const sec of site.sectors) {
          out.push({
            ...sec,
            // 站点级信息补充到小区行（扇区缺失字段时回退站点值）
            longitude: sec.longitude ?? site.longitude,
            latitude: sec.latitude ?? site.latitude,
            networkType: sec.networkType || net || site.networkType,
            siteName: sec.siteName ?? site.name,
            __net: net
          })
        }
      } else if (site && typeof site === 'object') {
        // 扁平小区行（如 target_cells），直接使用
        out.push({ ...site, __net: net })
      }
    }
    return out
  }

  const rows: any[] = []
  for (const key of ['LTE', 'NR', 'lte', 'nr']) {
    if (Array.isArray(d[key])) {
      rows.push(...expandSites(d[key], key.toUpperCase()))
    }
  }
  return rows
}

/** 从行对象提取可展示字段键值（跳过内部字段、对象值、空值） */
function extractFieldPairs(row: Record<string, any>): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = []
  for (const [k, v] of Object.entries(row)) {
    if (k === '__net' || k === 'sectors' || k === '_style' || k === 'geometry' || k === 'type') continue
    if (v === null || v === undefined || v === '') continue
    if (typeof v === 'object') continue
    pairs.push({ key: k, value: String(v) })
  }
  return pairs
}

/** 递归展平 GeoJSON 要素属性（嵌套 properties 对象按 FeatureInfoPanel 同款规则打平） */
function flattenFeatureProps(props: any): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = []
  const walk = (obj: Record<string, any>) => {
    for (const [k, v] of Object.entries(obj)) {
      if (['_style', 'geometry', 'type', 'displayLng', 'displayLat', 'longitude', 'latitude', 'path'].includes(k)) continue
      if (v === null || v === undefined || v === '') continue
      if (typeof v === 'object') {
        if (k === 'properties' && !Array.isArray(v)) { walk(v); continue }
        continue
      }
      pairs.push({ key: k, value: String(v) })
    }
  }
  if (props) walk(props)
  return pairs
}

/** 递归收集要素属性中的字符串值（用于模糊搜索），跳过样式/几何字段 */
function collectPropValues(props: any): string[] {
  const out: string[] = []
  const walk = (obj: any) => {
    if (!obj || typeof obj !== 'object') return
    for (const [k, v] of Object.entries(obj)) {
      if (k === '_style' || k === 'geometry' || k === 'type') continue
      if (v === null || v === undefined) continue
      if (typeof v === 'object') {
        walk(v)
        continue
      }
      out.push(String(v))
    }
  }
  walk(props)
  return out
}

/** 从 GeoJSON 几何计算中心与包围盒（坐标为 GCJ02，GeoJSON 序为 [lng,lat]） */
function geometryCenterAndBounds(geom: any): { center?: [number, number]; bounds?: [[number, number], [number, number]] } {
  if (!geom || !geom.coordinates) return {}
  const positions: [number, number][] = []
  const walk = (coords: any) => {
    if (typeof coords[0] === 'number') {
      positions.push([coords[1], coords[0]])
      return
    }
    for (const c of coords) walk(c)
  }
  walk(geom.coordinates)
  if (positions.length === 0) return {}
  const lats = positions.map(p => p[0])
  const lngs = positions.map(p => p[1])
  const south = Math.min(...lats)
  const north = Math.max(...lats)
  const west = Math.min(...lngs)
  const east = Math.max(...lngs)
  return {
    bounds: [[south, west], [north, east]],
    center: [(south + north) / 2, (west + east) / 2]
  }
}

export function MapSearchDialog({ open, onOpenChange, searchWorkbook, workbookSourceName, onLocateSector, onLocateLayerFeature }: MapSearchDialogProps) {
  const { t } = useTranslation()
  const items = useDataStore(s => s.items)

  const [mapLayersMap, setMapLayersMap] = useState<Record<string, any[]>>({})
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [records, setRecords] = useState<PreparedRecord[]>([])
  const [loadingData, setLoadingData] = useState(false)
  const [locating, setLocating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const loadTokenRef = useRef(0)

  // 构建数据源分组：
  // - 基站工参：固定单条，复用原"搜索定位"工参搜索（当前数据源 LTE/NR 小区），不逐文件加载
  // - 图层文件/地理化数据：来自数据管理已导入文件
  const sources = useMemo<{ workbooks: SearchSource[]; mapinfos: SearchSource[]; geos: SearchSource[] }>(() => {
    const workbooks: SearchSource[] = [{
      key: 'workbook:current',
      group: 'workbook',
      name: workbookSourceName || t('map.searchGroupWorkbook'),
      dataId: ''
    }]
    const mapinfos: SearchSource[] = []
    const geos: SearchSource[] = []

    for (const item of items) {
      if (item.status === 'processing' || item.status === 'error') continue
      if (item.type === 'map') {
        const layers = mapLayersMap[item.id] || []
        for (const layer of layers) {
          mapinfos.push({
            key: `mapinfo:${item.id}:${layer.id}`,
            group: 'mapinfo',
            name: layer.name || layer.id,
            dataId: item.id,
            layerId: layer.id
          })
        }
      } else if (item.type === 'excel') {
        const isGeo =
          (item.geometryType && ['point', 'sector', 'polygon'].includes(item.geometryType)) ||
          item.fileType === 'default' ||
          item.fileType === 'geo_data' ||
          !item.fileType
        if (isGeo) {
          geos.push({ key: `geo:${item.id}`, group: 'geo', name: item.name, dataId: item.id })
        }
      }
    }
    return { workbooks, mapinfos, geos }
  }, [items, mapLayersMap, workbookSourceName, t])

  const allSources = useMemo(
    () => [...sources.workbooks, ...sources.mapinfos, ...sources.geos],
    [sources]
  )

  // Esc 关闭弹窗
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  // 弹窗打开时：加载 MapInfo 图层列表、聚焦输入框
  useEffect(() => {
    if (!open) return
    setKeyword('')
    setRecords([])
    setTimeout(() => inputRef.current?.focus(), 50)

    const mapItems = items.filter(i => i.type === 'map' && i.status !== 'processing' && i.status !== 'error')
    Promise.all(mapItems.map(async item => {
      if (_mapLayersCache.has(item.id)) return { id: item.id, layers: _mapLayersCache.get(item.id)! }
      try {
        const resp = await layerApi.getLayers(item.id)
        const layers = resp.success && resp.data?.layers ? resp.data.layers : []
        _mapLayersCache.set(item.id, layers)
        return { id: item.id, layers }
      } catch {
        return { id: item.id, layers: [] }
      }
    })).then(results => {
      const next: Record<string, any[]> = {}
      for (const r of results) next[r.id] = r.layers
      setMapLayersMap(prev => ({ ...prev, ...next }))
    })
  }, [open, items])

  // 默认选中第一个数据源
  useEffect(() => {
    if (open && !selectedKey && allSources.length > 0) {
      setSelectedKey(allSources[0].key)
    }
  }, [open, selectedKey, allSources])

  /** 预处理地理化数据行记录 */
  const prepareGeoRecord = useCallback((row: any, idx: number, sourceName: string, layerId: string): PreparedRecord | null => {
    const name = row.name ?? extractFeatureId(row) ?? `要素${idx + 1}`
    const searchText = Object.entries(row)
      .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
      .map(([, v]) => String(v).toLowerCase())
      .join(' ')

    let center: [number, number] | undefined
    let bounds: [[number, number], [number, number]] | undefined

    if (Array.isArray(row.path) && row.path.length >= 3) {
      // 多边形：path 后端已转 GCJ02，格式 [[lat,lng],...]
      const lats = row.path.map((p: any[]) => p[0])
      const lngs = row.path.map((p: any[]) => p[1])
      const south = Math.min(...lats), north = Math.max(...lats)
      const west = Math.min(...lngs), east = Math.max(...lngs)
      bounds = [[south, west], [north, east]]
      center = [(south + north) / 2, (west + east) / 2]
    } else {
      const lng = Number(row.displayLng ?? row.longitude)
      const lat = Number(row.displayLat ?? row.latitude)
      if (isFinite(lng) && isFinite(lat)) {
        if (row.displayLng !== undefined && row.displayLat !== undefined) {
          center = [lat, lng]
        } else {
          const [glat, glng] = CoordinateTransformer.wgs84ToGcj02(lat, lng)
          center = [glat, glng]
        }
      }
    }

    return {
      name: String(name),
      searchText,
      detail: sourceName,
      kind: 'feature',
      layerId,
      // 兜底口径与 MapInfo 一致（`图层ID#序号`）：3D 图层渲染侧按同一套生成 id，
      // 用裸序号会让"无自然 ID 的地理化要素"定位时匹配不上（只有飞行没有红框）。
      featureId: String(row.name ?? row.id ?? extractFeatureId(row) ?? `${layerId}#${idx}`),
      fieldPairs: extractFieldPairs(row),
      center,
      bounds
    }
  }, [])

  /** 预处理 MapInfo 要素记录 */
  const prepareMapInfoRecord = useCallback((feature: any, idx: number, layerId: string, sourceName: string): PreparedRecord => {
    const props = feature.properties || {}
    const naturalId = extractFeatureId(props)
    const geo = geometryCenterAndBounds(feature.geometry)
    return {
      name: naturalId || `要素${idx + 1}`,
      searchText: collectPropValues(props).map(v => v.toLowerCase()).join(' '),
      detail: sourceName,
      kind: 'feature',
      // 与 MapInfoLayer 构建时分配的 _nptSelectionId 规则一致（自然ID 或「图层ID#序号」）
      featureId: naturalId || `${layerId}#${idx}`,
      layerId,
      fieldPairs: flattenFeatureProps(props),
      center: geo.center,
      bounds: geo.bounds
    }
  }, [])

  // 选中数据源变化时加载并预处理记录（工参组复用父组件搜索，无需加载记录）
  useEffect(() => {
    if (!open || !selectedKey) {
      setRecords([])
      return
    }

    const source = allSources.find(s => s.key === selectedKey)
    if (!source) return
    if (source.group === 'workbook') {
      setLoadingData(false)
      setRecords([])
      return
    }

    const cached = _recordsCache.get(selectedKey)
    if (cached) {
      setRecords(cached)
      return
    }

    const token = ++loadTokenRef.current
    setLoadingData(true)
    setRecords([])

    const load = async (): Promise<PreparedRecord[]> => {
      if (source.group === 'geo') {
        const resp = await dataApi.get(source.dataId)
        const rows = normalizeRows(resp)
        return rows.map((r, i) => prepareGeoRecord(r, i, source.name, source.dataId)).filter((r): r is PreparedRecord => !!r)
      }
      // mapinfo：优先用地图数据缓存中的 GeoJSON
      let geojson = useMapDataCacheStore.getState().layers[source.layerId!]?.geojson
      if (!geojson) {
        const resp = await layerApi.getLayerData(source.dataId, source.layerId!)
        if (resp.success && resp.data) geojson = resp.data
      }
      const features = geojson?.features || []
      return features.map((f: any, i: number) => prepareMapInfoRecord(f, i, source.layerId!, source.name))
    }

    load().then(prepared => {
      if (token !== loadTokenRef.current) return
      _recordsCache.set(selectedKey, prepared)
      setRecords(prepared)
      setLoadingData(false)
    }).catch(err => {
      if (token !== loadTokenRef.current) return
      console.error('[MapSearchDialog] 数据加载失败:', err)
      setLoadingData(false)
    })
  }, [open, selectedKey, allSources, prepareGeoRecord, prepareMapInfoRecord])

  // 关键字过滤（防抖 200ms）
  const [debouncedKeyword, setDebouncedKeyword] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword.trim().toLowerCase()), 200)
    return () => clearTimeout(timer)
  }, [keyword])

  const selectedSource = useMemo(
    () => allSources.find(s => s.key === selectedKey),
    [allSources, selectedKey]
  )

  const results = useMemo<SearchResultRecord[]>(() => {
    if (!debouncedKeyword) return []
    // 工参组：复用原"搜索定位"工参搜索逻辑（当前数据源 LTE/NR 小区）
    if (selectedSource?.group === 'workbook') {
      return searchWorkbook(debouncedKeyword).slice(0, 50).map(s => ({
        name: s.name || '未命名',
        searchText: '',
        detail: [
          s.networkType,
          s.siteId ? `基站ID: ${s.siteId}` : '',
          s.sectorId ? `小区ID: ${s.sectorId}` : ''
        ].filter(Boolean).join(' · '),
        kind: 'sector' as const,
        networkType: s.networkType,
        fieldPairs: [],
        matches: [],
        sectorId: s.id,
        center: (s.lat != null && s.lng != null) ? [s.lat, s.lng] as [number, number] : undefined
      }))
    }
    return records
      .filter(r => r.searchText.includes(debouncedKeyword))
      .slice(0, 50)
      .map(r => ({
        ...r,
        // 命中关键字的字段（最多 3 个），结果行直接展示这些字段的内容
        matches: r.fieldPairs
          .filter(p => p.value.toLowerCase().includes(debouncedKeyword))
          .slice(0, 3)
      }))
  }, [records, debouncedKeyword, selectedSource, searchWorkbook])

  const handleLocate = useCallback(async (record: PreparedRecord) => {
    if (locating) return
    setLocating(true)
    try {
      if (record.kind === 'sector') {
        if (!record.center || !record.sectorId) {
          alert(t('map.noCoordinate') || '缺少坐标信息')
          return
        }
        onLocateSector({
          id: record.sectorId,
          lat: record.center[0],
          lng: record.center[1],
          networkType: record.networkType
        })
        onOpenChange(false)
      } else if (record.layerId && record.featureId) {
        const ok = await onLocateLayerFeature({
          layerId: record.layerId,
          featureId: record.featureId,
          center: record.center,
          bounds: record.bounds
        })
        if (ok) {
          onOpenChange(false)
        } else {
          alert(t('map.searchLocateFailed'))
        }
      }
    } finally {
      setLocating(false)
    }
  }, [locating, onLocateSector, onLocateLayerFeature, onOpenChange, t])

  // 回车选中第一条结果
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault()
      handleLocate(results[0])
    }
  }

  if (!open) return null

  const renderSourceGroup = (groupSources: SearchSource[], label: string, icon: React.ReactNode) => {
    if (groupSources.length === 0) return null
    return (
      <div className="mb-1">
        <div className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          {icon}
          <span>{label}</span>
        </div>
        {groupSources.map(s => (
          <button
            key={s.key}
            onClick={() => setSelectedKey(s.key)}
            className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors rounded-md mx-1 w-[calc(100%-8px)] ${
              selectedKey === s.key
                ? 'bg-primary/15 text-primary font-medium'
                : 'text-foreground/80 hover:bg-accent'
            }`}
            title={s.name}
          >
            <span className="truncate">{s.name}</span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-[3000] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onOpenChange(false) }}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '780px', maxWidth: '95vw', height: '560px', maxHeight: '90vh' }}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-muted/50">
          <div className="flex items-center gap-2">
            <Search size={16} className="text-primary" />
            <span className="text-sm font-semibold text-foreground">{t('map.searchDialogTitle')}</span>
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* 主体：左数据源 + 右搜索 */}
        <div className="flex flex-1 min-h-0">
          {/* 数据源列表 */}
          <div className="w-56 flex-shrink-0 border-r border-border overflow-y-auto py-1">
            {allSources.length === 0 ? (
              <div className="px-4 py-6 text-xs text-muted-foreground">{t('map.searchDialogEmpty')}</div>
            ) : (
              <>
                {renderSourceGroup(sources.workbooks, t('map.searchGroupWorkbook'), <Database size={12} />)}
                {renderSourceGroup(sources.mapinfos, t('map.searchGroupMapInfo'), <Layers size={12} />)}
                {renderSourceGroup(sources.geos, t('map.searchGroupGeo'), <FileSpreadsheet size={12} />)}
              </>
            )}
          </div>

          {/* 搜索区 */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="p-3 border-b border-border">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={inputRef}
                  type="text"
                  value={keyword}
                  onChange={e => setKeyword(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={selectedKey ? t('map.searchDialogPlaceholder') : t('map.searchDialogNoSource')}
                  disabled={!selectedKey}
                  className="w-full pl-9 pr-3 py-2 text-xs border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground disabled:opacity-50"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto min-h-0">
              {loadingData || locating ? (
                <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
                  <Loader2 size={16} className="animate-spin" />
                  {locating ? t('map.searchDialogLocating') : t('map.searchDialogLoading')}
                </div>
              ) : !selectedKey ? (
                <div className="px-4 py-10 text-center text-xs text-muted-foreground">{t('map.searchDialogNoSource')}</div>
              ) : debouncedKeyword && results.length === 0 ? (
                <div className="px-4 py-10 text-center text-xs text-muted-foreground">{t('map.searchDialogNoResults')}</div>
              ) : (
                results.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => handleLocate(r)}
                    className="w-full text-left px-4 py-2.5 flex items-start gap-2.5 hover:bg-accent transition-colors border-b border-border/50 last:border-0"
                  >
                    {r.kind === 'sector'
                      ? <Database size={14} className={`mt-0.5 shrink-0 ${r.networkType === 'LTE' ? 'text-blue-500' : 'text-green-500'}`} />
                      : <MapPin size={14} className="mt-0.5 shrink-0 text-red-500" />}
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-medium text-foreground break-words whitespace-normal leading-relaxed">
                        <HighlightText text={r.name} keyword={debouncedKeyword} />
                      </span>
                      {/* 命中关键字的字段：输入中文显示中文片段、输入数值显示数值字段（完整换行显示，不截断） */}
                      {r.matches.slice(0, 2).map((m, mi) => (
                        <span key={mi} className="block text-[11px] text-muted-foreground break-words whitespace-normal mt-0.5 leading-relaxed">
                          <span className="opacity-75">{m.key}:</span>{' '}
                          <HighlightText text={m.value} keyword={debouncedKeyword} />
                        </span>
                      ))}
                      {r.matches.length === 0 && (
                        <span className="block text-[11px] text-muted-foreground break-words whitespace-normal mt-0.5 leading-relaxed">{r.detail}</span>
                      )}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 关键字高亮：完整显示文本（容器负责换行），命中片段用主题色加粗
 */
function HighlightText({ text, keyword }: { text: string; keyword: string }) {
  const kw = keyword.toLowerCase()
  if (!kw) return <>{text}</>
  const lower = text.toLowerCase()
  const idx = lower.indexOf(kw)
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <span className="text-primary font-semibold">{text.slice(idx, idx + kw.length)}</span>
      {text.slice(idx + kw.length)}
    </>
  )
}
