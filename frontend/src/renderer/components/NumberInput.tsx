import { useState, useCallback, useEffect, useRef } from 'react'

interface NumberInputProps {
  /** 当前有效数值 */
  value: number
  /** 数值变更回调 */
  onChange: (value: number) => void
  min?: number
  max?: number
  placeholder?: string
  disabled?: boolean
  className?: string
}

/**
 * 数字输入框
 * - 允许在输入过程中清空全部内容（按 Backspace/Delete）
 * - 失去焦点时自动校验并回退到有效值
 * - 使用 type="text" 避免浏览器对 number input 的强制干预
 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  placeholder,
  disabled,
  className = '',
}: NumberInputProps) {
  // 内部字符串状态：允许空字符串和任意中间输入
  const [inputValue, setInputValue] = useState(String(value))
  // 追踪外部 value 的变化（如重置配置时）
  const prevExternalRef = useRef(value)
  const isFocusedRef = useRef(false)

  // 外部 value 变化时同步（仅在非编辑状态下）
  useEffect(() => {
    if (value !== prevExternalRef.current && !isFocusedRef.current) {
      prevExternalRef.current = value
      setInputValue(String(value))
    }
  }, [value])

  // 失去焦点时校验并应用
  const handleBlur = useCallback(() => {
    isFocusedRef.current = false
    const trimmed = inputValue.trim()
    if (trimmed === '' || trimmed === '-') {
      // 空值：回退为最小值或 0
      const fallback = min !== undefined ? min : 0
      onChange(fallback)
      setInputValue(String(fallback))
      prevExternalRef.current = fallback
      return
    }
    const parsed = parseFloat(trimmed)
    if (isNaN(parsed)) {
      // 非法输入，回退到当前有效值
      setInputValue(String(value))
      return
    }
    // 范围限制
    let clamped = parsed
    if (min !== undefined) clamped = Math.max(min, clamped)
    if (max !== undefined) clamped = Math.min(max, clamped)
    onChange(clamped)
    setInputValue(String(clamped))
    prevExternalRef.current = clamped
  }, [inputValue, value, min, max, onChange])

  // 回车时也触发校验
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur()
    }
  }, [])

  return (
    <input
      type="text"
      inputMode="decimal"
      value={inputValue}
      onChange={(e) => setInputValue(e.target.value)}
      onFocus={() => { isFocusedRef.current = true }}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      disabled={disabled}
      className={`w-20 px-2 py-1 text-sm bg-background border border-border rounded-lg 
        focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary
        disabled:opacity-60 disabled:cursor-not-allowed ${className}`}
    />
  )
}
