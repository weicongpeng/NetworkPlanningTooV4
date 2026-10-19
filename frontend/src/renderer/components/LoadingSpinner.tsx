/**
 * LoadingSpinner - 优雅的加载动画组件
 *
 * 提供三种加载动画风格：
 * - 'spinner': 旋转渐变环（默认，用于结果/历史加载）
 * - 'ripple': 脉冲波纹（用于页面加载）
 * - 'dots': 弹性弹跳点（用于轻量加载）
 *
 * 支持自定义文案和容器高度。
 */
import { useTranslation } from 'react-i18next'

interface LoadingSpinnerProps {
  /** 动画风格 */
  variant?: 'spinner' | 'ripple' | 'dots'
  /** 加载提示文案（覆盖默认翻译） */
  text?: string
  /** 容器高度（默认 h-full） */
  className?: string
  /** 图标大小（默认 48） */
  size?: number
}

export function LoadingSpinner({
  variant = 'spinner',
  text,
  className = '',
  size = 48,
}: LoadingSpinnerProps) {
  const { t } = useTranslation()

  const defaultText = t('common.loading') || '加载中...'

  return (
    <div
      className={`flex-1 flex flex-col items-center justify-center gap-4 animate-in fade-in duration-500 ${className}`}
    >
      {variant === 'spinner' && (
        <div
          className="relative"
          style={{ width: size, height: size }}
        >
          {/* 背景环 */}
          <svg
            className="absolute inset-0 -rotate-90"
            width={size}
            height={size}
            viewBox="0 0 48 48"
          >
            <circle
              cx="24" cy="24" r="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              className="text-border opacity-40"
            />
          </svg>
          {/* 渐变旋转弧 */}
          <svg
            className="absolute inset-0 -rotate-90 animate-spin"
            style={{ animationDuration: '1.2s' }}
            width={size}
            height={size}
            viewBox="0 0 48 48"
          >
            <defs>
              <linearGradient id="spinner-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="hsl(var(--primary))" />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.3" />
              </linearGradient>
            </defs>
            <circle
              cx="24" cy="24" r="20"
              fill="none"
              stroke="url(#spinner-grad)"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray="126"
              strokeDashoffset="80"
            />
          </svg>
        </div>
      )}

      {variant === 'ripple' && (
        <div
          className="relative flex items-center justify-center"
          style={{ width: size, height: size }}
        >
          <div
            className="absolute inset-0 rounded-full border-2 border-primary/30 animate-[ping_1.5s_cubic-bezier(0,0,0.2,1)_infinite]"
          />
          <div
            className="absolute inset-2 rounded-full border-2 border-primary/50 animate-[ping_1.5s_cubic-bezier(0,0,0.2,1)_infinite]"
            style={{ animationDelay: '0.5s' }}
          />
          <div
            className="w-3 h-3 rounded-full bg-primary animate-pulse"
          />
        </div>
      )}

      {variant === 'dots' && (
        <div className="flex items-center gap-1.5" style={{ height: size * 0.4 }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-full bg-primary/70 animate-bounce"
              style={{
                width: size * 0.16,
                height: size * 0.16,
                animationDelay: `${i * 0.15}s`,
                animationDuration: '0.8s',
              }}
            />
          ))}
        </div>
      )}

      {/* 加载文案 */}
      <p className="text-sm text-muted-foreground animate-pulse">
        {text || defaultText}
      </p>
    </div>
  )
}

export default LoadingSpinner
