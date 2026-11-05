import { RefreshCw, CheckSquare, Check, Trash2, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  triggerBatchApply, triggerBatchDelete, triggerHistoryRefresh, triggerHistorySelectAll,
} from './HistoryTable'

interface HistoryTabActionsProps {
  /** 已选中的任务数（为 0 时「删除」置灰） */
  selectedCount: number
  /** 选中且尚未应用的任务数（为 0 时「应用」置灰） */
  unappliedCount?: number
  applying?: boolean
  deleting?: boolean
}

const BASE = 'p-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

/**
 * 历史任务页签栏右端的操作图标（刷新 / 全选 / 应用 / 删除）。
 *
 * - 仅「历史任务」页签渲染（其它页签没有可操作的列表，由调用方条件渲染）
 * - 显示期间常驻，不随选中状态显隐；无底色，只保留图形（与列表内操作列同一风格）
 * - 选中数为 0 时「应用」「删除」置灰，避免点了没反应
 */
export function HistoryTabActions({
  selectedCount, unappliedCount = 0, applying = false, deleting = false,
}: HistoryTabActionsProps) {
  const { t } = useTranslation()
  const busy = applying || deleting

  return (
    <div className="ml-auto flex items-center gap-2 mr-8">
      <button
        onClick={() => triggerHistoryRefresh()}
        disabled={busy}
        className={`${BASE} text-muted-foreground hover:text-foreground`}
        title={t('common.refresh') || '刷新'}
      >
        <RefreshCw size={15} />
      </button>
      <button
        onClick={() => triggerHistorySelectAll()}
        disabled={busy}
        className={`${BASE} text-muted-foreground hover:text-foreground`}
        title={t('common.toggleSelectAll') || '全选 / 取消全选'}
      >
        <CheckSquare size={15} />
      </button>
      <button
        onClick={() => triggerBatchApply()}
        disabled={busy || unappliedCount === 0}
        className={`${BASE} ${unappliedCount === 0 ? 'text-muted-foreground' : 'text-primary hover:text-primary/70'}`}
        title={t('common.batchApply') || '批量应用'}
      >
        {applying ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} strokeWidth={2.5} />}
      </button>
      <button
        onClick={() => triggerBatchDelete()}
        disabled={busy || selectedCount === 0}
        className={`${BASE} text-muted-foreground hover:text-destructive`}
        title={t('common.batchDelete') || '批量删除'}
      >
        {deleting ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
      </button>
    </div>
  )
}
