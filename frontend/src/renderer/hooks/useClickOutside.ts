import { useEffect, useRef } from 'react'

/**
 * 点击元素外部时触发回调（用于自定义下拉/浮层点击其他区域自动收回）。
 *
 * 参考 MainLayout 用户信息浮层已验证的模式：document 上监听 mousedown，
 * 目标不在容器内即视为"外部"。mousedown 先于 click 触发，
 * 故容器内按钮的 toggle 逻辑不会被本监听意外打断。
 *
 * @param onOutside 点击外部的回调
 * @param active 是否启用监听（传入下拉的 open 状态，关闭时不绑定）
 * @returns 绑定到下拉容器的 ref
 */
export function useClickOutside<T extends HTMLElement>(
  onOutside: () => void,
  active: boolean = true
) {
  const ref = useRef<T>(null)

  useEffect(() => {
    if (!active) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOutside()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onOutside, active])

  return ref
}
