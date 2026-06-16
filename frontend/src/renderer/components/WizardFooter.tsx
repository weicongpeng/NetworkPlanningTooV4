import { Loader2, ArrowRight, Eye, X, ChevronLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface WizardFooterProps {
  /** 当前步骤 0=idle/task_created 1=params_set 2=cells_selected 3=executing 4=completed */
  currentStep: number
  /** 是否正在执行中 */
  isExecuting: boolean
  /** 当前步骤是否可以继续 */
  canProceed: boolean
  /** 下一步回调 */
  onNext: () => void
  /** 取消回调（回到初始状态） */
  onCancel: () => void
  /** 上一步回调 */
  onBack?: () => void
  /** 是否显示取消按钮 */
  showCancel?: boolean
  /** 是否处于任务名称输入步骤（idle→task_created 后，指示器未跳转） */
  isTaskNameStep?: boolean
}

/**
 * Wizard 流程底部导航栏
 * 居中显示"取消"、"上一步"、"下一步"按钮
 * 执行完成后只显示"查看"按钮
 */
export function WizardFooter({
  currentStep,
  isExecuting,
  canProceed,
  onNext,
  onCancel,
  onBack,
  showCancel,
  isTaskNameStep,
}: WizardFooterProps) {
  const { t } = useTranslation()

  // 当前向导状态
  const isIdle = currentStep === 0 && !isTaskNameStep
  const isExecutingStep = currentStep === 3
  const isCompleted = currentStep >= 4

  // 按钮文案
  const btnLabel = (() => {
    if (isExecuting) return t('common.executing') || '执行中...'
    if (isCompleted) return t('common.viewResult') || '查看'
    if (currentStep === 2) return t('common.execute') || '执行'  // cells_selected → 执行
    if (isIdle) return t('common.newTask') || '新建任务'
    return t('common.nextStep') || '下一步'
  })()

  // 上一步按钮可见：参数设置(1)、小区选择(2) 时显示
  const showBack = onBack && currentStep >= 1 && currentStep <= 2
  // 取消按钮可见：task_created ~ cells_selected (含) 时显示，idle 时不显示
  const canCancel = showCancel ?? (currentStep >= 0 && currentStep <= 2 && !isExecuting && !isIdle)

  // 执行完成后：只显示"查看"按钮
  if (isCompleted) {
    return (
      <div className="shrink-0 border-t border-border bg-background px-6 py-3">
        <div className="flex items-center justify-center">
          <button
            onClick={onNext}
            className="inline-flex items-center gap-2 px-10 py-2.5 text-sm font-semibold rounded-lg
              bg-primary text-primary-foreground hover:bg-primary/90 shadow-md hover:shadow-lg
              transition-all duration-200 active:scale-[0.98]"
          >
            <Eye size={16} />
            {btnLabel}
          </button>
        </div>
      </div>
    )}

  return (
    <div className="shrink-0 border-t border-border bg-background px-6 py-3">
      <div className="flex items-center justify-center gap-4">
        {/* 取消按钮 */}
        {canCancel && (
          <button
            onClick={onCancel}
            disabled={isExecuting}
            className="inline-flex items-center gap-2 px-6 py-2.5 text-sm font-medium
              bg-muted text-muted-foreground rounded-lg
              hover:bg-muted/80 active:scale-[0.98]
              transition-all duration-150
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <X size={16} />
            {t('common.cancel') || '取消'}
          </button>
        )}

        {/* 上一步按钮：参数设置和小区选择步骤时显示，高亮样式 */}
        {showBack && (
          <button
            onClick={onBack}
            disabled={isExecuting}
            className="inline-flex items-center gap-2 px-6 py-2.5 text-sm font-medium
              border border-primary text-primary rounded-lg
              hover:bg-primary/10 active:scale-[0.98]
              transition-all duration-150
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={16} />
            {t('common.prevStep') || '上一步'}
          </button>
        )}

        {/* 下一步 / 执行 / 新建任务 按钮 */}
        <button
          onClick={onNext}
          disabled={!canProceed || isExecuting}
          className={`inline-flex items-center gap-2 px-8 py-2.5 text-sm font-semibold rounded-lg
            transition-all duration-200 active:scale-[0.98]
            ${isExecuting
              ? 'bg-primary/70 text-primary-foreground cursor-wait'
              : canProceed
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-md hover:shadow-lg'
                : 'bg-muted text-muted-foreground cursor-not-allowed'
            }`}
        >
          {isExecuting ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              {btnLabel}
            </>
          ) : (
            <>
              {btnLabel}
              {!isExecutingStep && !isCompleted && <ArrowRight size={16} />}
            </>
          )}
        </button>
      </div>
    </div>
  )
}
