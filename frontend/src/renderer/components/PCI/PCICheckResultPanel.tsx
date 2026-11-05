import { AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LoadingSpinner } from '../LoadingSpinner'
import { CHECK_TYPES, PCICheckResultTable, type CheckTypeKey } from './PCICheckResultTable'
import { btn } from '../../utils/buttonStyles'
import type { PCICheckConfig } from '../../store/pciCheckStore'
import type { SkippedCellInfo } from '@shared/types'

export interface PCICheckResultData {
  taskId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  networkType?: 'LTE' | 'NR'
  macroPairDistanceM?: number
  mixedPairDistanceM?: number
  indoorPairDistanceM?: number
  minReuseDistanceMacroM?: number
  minReuseDistanceIndoorM?: number
  macroFacingAngleDeg?: number
  indoorFacingAngleDeg?: number
  totalCells?: number
  poolCells?: number
  neighborPairCount?: number
  reuseCheck?: boolean
  collisionCheck?: boolean
  confusionCheck?: boolean
  mod3Check?: boolean
  mod30Check?: boolean
  neighborAssoc?: boolean
  summary?: Record<string, number>
  skippedCells?: SkippedCellInfo[]
  skippedCount?: number
  /** { 核查类型: 异常小区对行列表 } */
  results?: Record<string, any[]>
  startTime: string
  endTime?: string
  error?: string
}

/** 异常小区对总数（历史列表摘要只有 summary 或 results 之一，两者都能算） */
export function totalRowCount(result: PCICheckResultData | null | undefined): number {
  if (!result) return 0
  if (result.summary) return Object.values(result.summary).reduce((sum, count) => sum + count, 0)
  if (result.results) return Object.values(result.results).reduce((sum, rows) => sum + (rows?.length || 0), 0)
  return 0
}

interface PCICheckResultPanelProps {
  result: PCICheckResultData | null
  config: PCICheckConfig
  loading: boolean
  /** 无结果时的引导文案（区分“未建任务”和“未开始核查”） */
  emptyHint: string
  activeCategory: CheckTypeKey
  onCategoryChange: (category: CheckTypeKey) => void
  exportState: 'idle' | 'exporting' | 'success'
  onExportAll: () => void
  onExportCsv: (category: CheckTypeKey) => void
}

/** PCI核查结果面板：统计卡 + 预规划邻区提示 + 分类页签 + 异常小区对表 */
export function PCICheckResultPanel(props: PCICheckResultPanelProps) {
  const { t } = useTranslation()
  const {
    result, config, loading, emptyHint, activeCategory,
    onCategoryChange, exportState, onExportAll, onExportCsv
  } = props

  if (loading) return <LoadingSpinner variant="spinner" text={t('common.loadingResult') || '正在加载核查结果...'} />
  if (!result) return <p className="text-sm text-muted-foreground">{emptyHint}</p>

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {result.status === 'failed' && result.error && (
        <div className="mb-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2">
          <AlertCircle size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-600">{result.error}</p>
        </div>
      )}

      {result.status === 'completed' && (
        <>
          <div className="mb-3 shrink-0 grid grid-cols-4 xl:grid-cols-7 gap-2">
            <Stat label={t('pciCheck.networkType') || '网络类型'} value={result.networkType || '-'} />
            <Stat label={t('pciCheck.totalCells') || '核查小区'} value={result.totalCells || 0} />
            <Stat label={t('pciCheck.poolCells') || '对照小区池'} value={result.poolCells || 0} />
            <Stat
              label={t('pciCheck.pairThresholds') || '对打门限(宏/混/室)'}
              value={`${result.macroPairDistanceM ?? config.macroPairDistance}/${result.mixedPairDistanceM ?? config.mixedPairDistance}/${result.indoorPairDistanceM ?? config.indoorPairDistance}米`}
              title={`${t('pciCheck.macroFacingAngle') || '宏站对打小区夹角门限(°)'}: ${result.macroFacingAngleDeg ?? config.macroFacingAngle}° / ${t('pciCheck.indoorFacingAngle') || '室分对打小区夹角门限(°)'}: ${result.indoorFacingAngleDeg ?? config.indoorFacingAngle}°`}
            />
            <Stat
              label={t('pciCheck.reuseThresholds') || '复用距离门限'}
              value={`${result.minReuseDistanceMacroM ?? config.minReuseDistanceMacro}米宏 / ${result.minReuseDistanceIndoorM ?? config.minReuseDistanceIndoor}米室`}
            />
            <Stat
              label={t('pciCheck.abnormalPairs') || '异常小区对'}
              value={totalRowCount(result)}
              tone="blue"
            />
            <Stat label={t('pciCheck.skippedCells') || '跳过小区'} value={result.skippedCount || 0} />
          </div>

          <div className={`mb-3 p-2 rounded-md flex items-start gap-2 shrink-0 ${result.neighborAssoc === false ? 'bg-muted/60' : 'bg-amber-500/10 border border-amber-500/20'}`}>
            <AlertCircle size={14} className={`${result.neighborAssoc === false ? 'text-muted-foreground' : 'text-amber-600'} flex-shrink-0 mt-0.5`} />
            <p className={`text-[11px] ${result.neighborAssoc === false ? 'text-muted-foreground' : 'text-amber-700'}`}>
              {result.neighborAssoc === false
                ? (t('pciCheck.neighborOffNotice') || '邻区关联已关闭：PCI冲突按复用距离口径核查，PCI混淆未核查。')
                : (t('pciCheck.neighborBasedNotice') || 'PCI冲突与PCI混淆基于预规划邻区对辅助核查，不是现网邻区数据核查结果。')}
            </p>
          </div>

          <div className="flex items-center gap-1 mb-3 border-b border-border shrink-0 overflow-x-auto">
            {/* 只渲染本次启用的类别：后端按开关返回类别，NR/邻区口径不固定 */}
            {CHECK_TYPES.filter((category) => category.key in (result.results || {})).map((category) => (
              <button
                key={category.key}
                onClick={() => onCategoryChange(category.key)}
                className={`whitespace-nowrap px-3 py-1.5 text-sm rounded-t-md transition-colors ${activeCategory === category.key ? btn.activeTab : btn.ghost}`}
              >
                {t(`pciCheck.types.${category.key}`) || category.label}
                <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                  {result.summary?.[category.key] ?? 0}
                </span>
              </button>
            ))}
          </div>

          {totalRowCount(result) === 0 ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              {t('pciCheck.noAbnormal') || '未发现PCI配置问题'}
            </div>
          ) : (
            <PCICheckResultTable
              rows={result.results?.[activeCategory] || []}
              checkType={activeCategory}
              exportState={exportState}
              onExportAll={onExportAll}
              onExportCsv={() => onExportCsv(activeCategory)}
            />
          )}
        </>
      )}
    </div>
  )
}

function Stat({ label, value, tone, title }: { label: string; value: string | number; tone?: 'blue'; title?: string }) {
  const toneClass = tone === 'blue'
    ? 'bg-blue-500/10 border border-blue-500/20'
    : 'bg-muted/50'
  const valueClass = tone === 'blue' ? 'text-sm font-semibold text-blue-600' : 'text-sm font-semibold'
  const labelClass = tone === 'blue' ? 'text-[10px] text-blue-600' : 'text-[10px] text-muted-foreground'
  return (
    <div className={`px-2.5 py-1.5 rounded-md ${toneClass}`} title={title}>
      <p className={labelClass}>{label}</p>
      <p className={valueClass}>{value}</p>
    </div>
  )
}
