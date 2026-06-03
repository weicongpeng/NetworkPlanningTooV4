import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

interface StepConfig {
  key: string
  labelKey: string
  fallback: string
}

const DEFAULT_STEPS: StepConfig[] = [
  { key: 'new_task',   labelKey: 'common.newTask',           fallback: '新建' },
  { key: 'params',     labelKey: 'neighbor.planningParams',  fallback: '参数设置' },
  { key: 'cells',      labelKey: 'pci.cellSelection',        fallback: '选择小区' },
  { key: 'execute',    labelKey: 'common.execute',           fallback: '执行' },
  { key: 'done',       labelKey: 'common.completed',         fallback: '完成' },
]

interface StepIndicatorProps {
  currentStep: number
  onStepClick?: (index: number) => void
  steps?: StepConfig[]
  /** 执行进度百分比 (0-100)，仅在 executing 步骤时有效 */
  executingProgress?: number
}

export function StepIndicator({ currentStep, onStepClick, steps = DEFAULT_STEPS, executingProgress }: StepIndicatorProps) {
  const { t } = useTranslation()

  return (
    <div className="flex items-center justify-center gap-0 py-3 px-6 select-none">
      {steps.map((step, idx) => {
        const isActive = idx === currentStep
        const isCompleted = idx < currentStep
        const isClickable = idx < currentStep
        const isExecuting = idx === 3 && isActive && executingProgress !== undefined && executingProgress >= 0

        return (
          <div key={step.key} className="flex items-center gap-0">
            <button
              onClick={() => isClickable && onStepClick?.(idx)}
              disabled={!isClickable}
              className={`
                flex items-center gap-2 px-3 py-2 rounded-full text-sm
                transition-all duration-200 whitespace-nowrap
                ${isActive
                  ? 'bg-primary text-primary-foreground shadow-md scale-105'
                  : isCompleted
                    ? 'bg-primary/20 text-primary cursor-pointer hover:bg-primary/30'
                    : 'bg-muted text-muted-foreground'
                }
                ${!isClickable && !isActive ? 'cursor-default' : ''}
              `}
            >
              <span className={`
                inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold shrink-0
                ${isCompleted
                  ? 'bg-primary text-primary-foreground'
                  : isActive
                    ? 'bg-primary-foreground text-primary'
                    : 'bg-muted-foreground/30 text-muted-foreground'
                }`}>
                {isExecuting ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : isCompleted ? (
                  '✓'
                ) : (
                  idx + 1
                )}
              </span>
              <span className="hidden sm:inline">
                {t(step.labelKey) || step.fallback}
                {isExecuting && executingProgress > 0 && (
                  <span className="ml-1 font-mono text-xs">{executingProgress}%</span>
                )}
              </span>
            </button>

            {idx < steps.length - 1 && (
              <div className={`
                w-6 h-0.5 mx-0.5 rounded
                ${idx < currentStep ? 'bg-primary' : 'bg-muted-foreground/20'}
              `} />
            )}
          </div>
        )
      })}
    </div>
  )
}
