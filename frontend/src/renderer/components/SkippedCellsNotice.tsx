import { AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SkippedCellInfo } from '@shared/types'

/** 明细最多列出的小区数，超出用「等共 N 个」概括 */
const MAX_LISTED = 5

interface SkippedCellsNoticeProps {
  /** i18n 分组：tac=核查 / tacPlanning=规划 */
  group: 'tac' | 'tacPlanning'
  /** 因工参数据不全被跳过的小区 */
  skipped: SkippedCellInfo[]
  /** 实际完成核查/规划的小区数 */
  checkedCount: number
}

/**
 * 工参数据不全被跳过的小区提示横幅（黄色，非阻断）
 * 挂在错误横幅同区域，核查/规划完成与查看历史任务时均展示
 */
export function SkippedCellsNotice({ group, skipped, checkedCount }: SkippedCellsNoticeProps) {
  const { t } = useTranslation()
  if (!skipped || skipped.length === 0) return null

  const reasonText = (reason: SkippedCellInfo['reason']) => {
    switch (reason) {
      case 'missing_ids':
        return t(`${group}.skipReasonMissingIds`) || '缺少基站ID或小区ID'
      case 'not_in_params':
        return t(`${group}.skipReasonNotInParams`) || '工参中未找到该小区'
      default:
        return t(`${group}.skipReasonMissingCoordinates`) || '缺少经纬度，无法定位'
    }
  }

  const cellName = (cell: SkippedCellInfo) => cell.sectorName || cell.sectorId || '-'

  return (
    <div className="mb-6 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-start gap-2 shrink-0">
      <AlertCircle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="text-amber-500 text-sm font-medium">
          {t(`${group}.skippedCellsTitle`, { count: skipped.length }) ||
            `已跳过 ${skipped.length} 个工参数据不全的小区`}
        </p>
        <p className="text-amber-600 text-xs mt-0.5">
          {t(`${group}.skippedCellsSummary`, { skipped: skipped.length, checked: checkedCount })}
        </p>
        <ul className="mt-1 ml-4 list-disc text-xs text-amber-600 space-y-0.5">
          {skipped.slice(0, MAX_LISTED).map((cell, i) => (
            <li key={`${cell.siteId || ''}_${cell.sectorId || ''}_${i}`}>
              {t(`${group}.skippedCellItem`, { name: cellName(cell), reason: reasonText(cell.reason) })}
            </li>
          ))}
        </ul>
        {skipped.length > MAX_LISTED && (
          <p className="mt-1 ml-4 text-xs text-amber-600">
            {t(`${group}.skippedCellsMore`, { count: skipped.length - MAX_LISTED })}
          </p>
        )}
      </div>
    </div>
  )
}
