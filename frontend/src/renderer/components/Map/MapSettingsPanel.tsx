/**
 * 地图页右键弹出的「设置」框（FloatingPanel：可拖拽 / 缩放 / 几何持久化）。
 *
 * 两个分区：
 * - 地图设置：三个引擎（高德地图 / 天地图 / CesiumJS）的 Key / Token 配置与注记开关。
 *   这里**只做配置，不切图**——地图源切换统一走工具栏的「地图切换」下拉
 *   （高德矢量图 / 高德卫星图 / 天地图矢量图 / 天地图卫星图 / 3D地图 / 空地图）。
 * - 工具栏设置：标签显隐、恢复默认布局（沿用原右键菜单能力）
 */
import { useState } from 'react'
import { Map as MapIcon, Globe, Layers, Eye, EyeOff, Check, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { FloatingPanel } from './FloatingPanel'
import { useMapStore, type CesiumBuildingStyle, type CesiumQuality } from '../../store/mapStore'
import { DEFAULT_CESIUM_ION_TOKEN } from '../../services/cesiumLoader'
import { DEFAULT_TIANDITU_KEY, engineOf, type Map2dEngine } from '../../config/mapSources'
import { maskSecret } from '../../utils/secretMask'

interface MapSettingsPanelProps {
  /** 面板左上角（相对地图容器） */
  anchor: { x: number; y: number }
  onClose: () => void
  getBounds: () => HTMLElement | null
  /** 工具栏设置 */
  showLabels: boolean
  onToggleLabels: () => void
  onResetToolbar: () => void
}

const PANEL_RECT = { width: 380, height: 720 }

/** 三个引擎配置页签 */
type EngineTab = Map2dEngine | 'cesium'

/** 3D 清晰度档位选项 */
const QUALITY_TIERS: Array<{ id: CesiumQuality; labelKey: string; fallback: string }> = [
  { id: 'smooth', labelKey: 'map.qualitySmooth', fallback: '流畅' },
  { id: 'balanced', labelKey: 'map.qualityBalanced', fallback: '均衡' },
  { id: 'sharp', labelKey: 'map.qualitySharp', fallback: '清晰' },
]

/** CesiumJS 建筑（OSM 3D Tiles）着色方式选项 */
const BUILDING_STYLES: Array<{
  id: CesiumBuildingStyle
  labelKey: string
  fallback: string
}> = [
  { id: 'material', labelKey: 'map.styleByMaterial', fallback: '按建筑材料着色' },
  { id: 'height', labelKey: 'map.styleByHeight', fallback: '按建筑高度着色' },
  { id: 'hideLow', labelKey: 'map.styleHideLow', fallback: '隐藏 20m 以下建筑' },
  { id: 'none', labelKey: 'map.styleNone', fallback: '默认（无样式）' },
]

/** 单个注记/显隐开关行 */
function ToggleRow({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs rounded-md text-foreground hover:bg-muted transition-colors"
    >
      <span>{label}</span>
      <span
        className={`relative w-8 h-4 rounded-full transition-colors ${
          checked ? 'bg-primary' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${
            checked ? 'left-4' : 'left-0.5'
          }`}
        />
      </span>
    </button>
  )
}

/** 脱敏密钥输入：展示态只读脱敏值 + 更换 / 恢复默认 */
function SecretField({
  label, value, defaultValue, placeholder, hint, restoreLabel, onChange,
}: {
  label: string
  value: string
  defaultValue: string
  placeholder: string
  hint: string
  restoreLabel: string
  onChange: (v: string) => void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [reveal, setReveal] = useState(false)

  const confirm = () => {
    const next = draft.trim()
    if (next) onChange(next)
    setEditing(false)
  }

  return (
    <div className="space-y-1.5">
      <label className="text-[11px] text-muted-foreground">{label}</label>

      {editing ? (
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <input
              type={reveal ? 'text' : 'password'}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirm() }}
              placeholder={placeholder}
              className="w-full px-2.5 py-1.5 pr-7 text-xs rounded-md border border-border bg-input text-foreground outline-none focus:border-primary"
            />
            <button
              onClick={() => setReveal(v => !v)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
          <button
            onClick={confirm}
            className="p-1.5 rounded-md border border-border text-foreground hover:bg-muted"
            title={t('map.confirm') || '确定'}
          >
            <Check size={13} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            readOnly
            value={maskSecret(value)}
            className="flex-1 px-2.5 py-1.5 text-xs rounded-md border border-border bg-input text-muted-foreground outline-none"
          />
          <button
            onClick={() => { setDraft(''); setReveal(false); setEditing(true) }}
            className="px-2 py-1.5 rounded-md border border-border text-xs text-foreground hover:bg-muted"
          >
            {t('map.change') || '更换'}
          </button>
        </div>
      )}

      <button
        onClick={() => { onChange(defaultValue); setEditing(false) }}
        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary"
      >
        <RotateCcw size={11} />
        {restoreLabel}
      </button>
      <p className="text-[10px] text-muted-foreground leading-relaxed">{hint}</p>
    </div>
  )
}

export function MapSettingsPanel({
  anchor,
  onClose,
  getBounds,
  showLabels,
  onToggleLabels,
  onResetToolbar,
}: MapSettingsPanelProps) {
  const { t } = useTranslation()
  const {
    mapSettings, setMapSettings, setTiandituAnnotation,
    setCesiumPlaceNameVisible, setCesiumBuildingStyle, setCesiumQuality,
  } = useMapStore()

  // 配置页签：默认跟随当前地图源对应的引擎（3D / 空地图落到 CesiumJS / 高德）
  const [tab, setTab] = useState<EngineTab>(() => engineOf(mapSettings.mapSource) ?? 'cesium')

  const tabs: { id: EngineTab; label: string; icon: React.ReactNode }[] = [
    { id: 'amap', label: t('map.providerAmap') || '高德地图', icon: <MapIcon size={14} /> },
    { id: 'tianditu', label: t('map.providerTianditu') || '天地图', icon: <Layers size={14} /> },
    { id: 'cesium', label: t('map.providerCesium') || 'CesiumJS', icon: <Globe size={14} /> },
  ]

  return (
    <FloatingPanel
      title={t('map.settings') || '设置'}
      onClose={onClose}
      initialRect={{ x: anchor.x, y: anchor.y, ...PANEL_RECT }}
      minSize={{ width: 340, height: 360 }}
      storageKey="map-settings-panel-rect"
      getBounds={getBounds}
    >
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">

        {/* ===== 地图设置（只配置，不切图） ===== */}
        <section className="space-y-2.5">
          <h4 className="text-xs font-semibold text-foreground">
            {t('map.mapSettings') || '地图设置'}
          </h4>

          {/* 引擎页签 */}
          <div className="grid grid-cols-3 gap-2">
            {tabs.map(({ id, label, icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center justify-center gap-1.5 px-2 py-2 rounded-md border text-xs transition-colors ${
                  tab === id
                    ? 'border-primary text-primary bg-primary/5'
                    : 'border-border text-foreground hover:bg-muted'
                }`}
              >
                {icon}
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>

          <p className="text-[10px] text-muted-foreground leading-relaxed">
            {t('map.mapSourceHint') || '此处只配置各引擎的 Key / Token；切换地图源请用工具栏的「地图切换」下拉。'}
          </p>

          {/* 高德地图 */}
          {tab === 'amap' && (
            <div className="space-y-1.5">
              <label className="text-[11px] text-muted-foreground">
                {t('map.amapApiKey') || '高德 API Key'}
              </label>
              <input
                type="text"
                value={mapSettings.amapApiKey}
                onChange={(e) => setMapSettings({ amapApiKey: e.target.value })}
                placeholder={t('map.amapKeyPlaceholder') || '默认可留空（免 Key）'}
                className="w-full px-2.5 py-1.5 text-xs rounded-md border border-border bg-input text-foreground outline-none focus:border-primary"
              />
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                {t('map.amapKeyHint') || '高德瓦片默认免 Key，可留空；如需使用自己的 Key 可在此填写。'}
              </p>
            </div>
          )}

          {/* 天地图 */}
          {tab === 'tianditu' && (
            <div className="space-y-3">
              <SecretField
                label={t('map.tiandituApiKey') || '天地图 Key'}
                value={mapSettings.tiandituApiKey}
                defaultValue={DEFAULT_TIANDITU_KEY}
                placeholder={t('map.tiandituKeyPlaceholder') || '粘贴新的天地图 Key'}
                hint={t('map.tiandituKeyHint') ||
                  '用于加载天地图底图与注记图层，可到 lbs.tianditu.gov.cn 申请自己的 Key（浏览器端类型）。'}
                restoreLabel={t('map.restoreDefaultTiandituKey') || '恢复默认 Key'}
                onChange={(v) => setMapSettings({ tiandituApiKey: v })}
              />
              <div className="space-y-0.5 border-t border-border pt-3">
                <div className="text-[11px] text-muted-foreground mb-1">
                  {t('map.tiandituAnnotation') || '注记图层'}
                </div>
                <ToggleRow
                  label={t('map.annotationVector') || '矢量注记'}
                  checked={mapSettings.tiandituAnnotations.vector}
                  onChange={(v) => setTiandituAnnotation('vector', v)}
                />
                <ToggleRow
                  label={t('map.annotationImage') || '影像注记'}
                  checked={mapSettings.tiandituAnnotations.image}
                  onChange={(v) => setTiandituAnnotation('image', v)}
                />
                <ToggleRow
                  label={t('map.annotationTerrain') || '地形注记'}
                  checked={mapSettings.tiandituAnnotations.terrain}
                  onChange={(v) => setTiandituAnnotation('terrain', v)}
                />
                <p className="text-[10px] text-muted-foreground leading-relaxed pt-1">
                  {t('map.annotationMatchHint') ||
                    '注记只在对应的天地图底图上显示：矢量注记→矢量图，影像注记→卫星图。当前下拉没有地形底图，地形注记暂不显示。'}
                </p>
              </div>
            </div>
          )}

          {/* CesiumJS */}
          {tab === 'cesium' && (
            <div className="space-y-3">
              <SecretField
                label={t('map.cesiumIonToken') || 'Cesium ion Access Token'}
                value={mapSettings.cesiumIonToken}
                defaultValue={DEFAULT_CESIUM_ION_TOKEN}
                placeholder={t('map.cesiumTokenPlaceholder') || '粘贴新的 Access Token'}
                hint={t('map.cesiumTokenHint') ||
                  '用于加载 OSM 建筑 3D Tiles 与全球地形，可到 ion.cesium.com 申请自己的 Token。'}
                restoreLabel={t('map.restoreDefaultToken') || '恢复默认 Token'}
                onChange={(v) => setMapSettings({ cesiumIonToken: v })}
              />
              <div className="space-y-0.5 border-t border-border pt-3">
                <div className="text-[11px] text-muted-foreground mb-1">
                  {t('map.tiandituAnnotation') || '注记图层'}
                </div>
                <ToggleRow
                  label={t('map.annotationPlaceName') || '三维地名'}
                  checked={mapSettings.cesiumAnnotations.placeName}
                  onChange={setCesiumPlaceNameVisible}
                />
              </div>

              {/* 建筑样式（原为地图右上角悬浮下拉，统一收到这里） */}
              <div className="space-y-1.5 border-t border-border pt-3">
                <div className="text-[11px] text-muted-foreground">
                  {t('map.buildingStyle') || '建筑样式'}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {BUILDING_STYLES.map(({ id, labelKey, fallback }) => (
                    <button
                      key={id}
                      onClick={() => setCesiumBuildingStyle(id)}
                      className={`px-2 py-1.5 rounded-md border text-xs transition-colors ${
                        mapSettings.cesiumBuildingStyle === id
                          ? 'border-primary text-primary bg-primary/5'
                          : 'border-border text-foreground hover:bg-muted'
                      }`}
                    >
                      {t(labelKey) || fallback}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {t('map.buildingStyleHint') || '仅影响 OSM 3D 建筑；关闭底图建筑可明显提升 3D 交互流畅度。'}
                </p>
              </div>

              {/* 3D 清晰度：3D 底图看起来比 2D 糊的主因是渲染分辨率，按机器性能取舍 */}
              <div className="space-y-1.5 border-t border-border pt-3">
                <div className="text-[11px] text-muted-foreground">
                  {t('map.cesiumQuality') || '3D 清晰度'}
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {QUALITY_TIERS.map(({ id, labelKey, fallback }) => (
                    <button
                      key={id}
                      onClick={() => setCesiumQuality(id)}
                      className={`px-2 py-1.5 rounded-md border text-xs transition-colors ${
                        mapSettings.cesiumQuality === id
                          ? 'border-primary text-primary bg-primary/5'
                          : 'border-border text-foreground hover:bg-muted'
                      }`}
                    >
                      {t(labelKey) || fallback}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {t('map.cesiumQualityHint') ||
                    '3D 底图比 2D 略糊源于渲染分辨率（非瓦片源）。「清晰」按设备像素渲染，画质最好但更吃显卡。'}
                </p>
              </div>
            </div>
          )}
        </section>

        {/* ===== 工具栏设置 ===== */}
        <section className="space-y-2 border-t border-border pt-4">
          <h4 className="text-xs font-semibold text-foreground">
            {t('map.toolbarSettings') || '工具栏设置'}
          </h4>
          <button
            onClick={onToggleLabels}
            className="w-full text-left px-2.5 py-1.5 text-xs text-foreground rounded-md hover:bg-muted hover:text-primary transition-colors"
          >
            {showLabels
              ? (t('map.toolbarHideLabels') || '隐藏标签文字')
              : (t('map.toolbarShowLabels') || '显示标签文字')}
          </button>
          <button
            onClick={onResetToolbar}
            className="w-full text-left px-2.5 py-1.5 text-xs text-foreground rounded-md hover:bg-muted hover:text-primary transition-colors"
          >
            {t('map.toolbarResetLayout') || '恢复默认布局'}
          </button>
          <p className="text-[10px] text-muted-foreground">
            {t('map.toolbarDragHint') || '拖动按钮可调整位置'}
          </p>
        </section>
      </div>
    </FloatingPanel>
  )
}
