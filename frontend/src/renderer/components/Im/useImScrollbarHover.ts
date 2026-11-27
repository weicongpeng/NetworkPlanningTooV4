import { useEffect } from 'react'

interface ScrollAreaRef {
  readonly current: Element | null
}

const VISIBLE_CLASS = 'im-scrollbar-visible'

/** 用光标坐标判定滚动条显隐：不受覆盖层和子元素 :hover 传播影响。 */
export function useImScrollbarHover(ref: ScrollAreaRef): void {
  useEffect(() => {
    const update = (event: MouseEvent) => {
      const node = ref.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      const inside = event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom
      node.classList.toggle(VISIBLE_CLASS, inside)
    }
    const hide = () => ref.current?.classList.remove(VISIBLE_CLASS)

    document.addEventListener('mousemove', update, { passive: true })
    document.addEventListener('mouseleave', hide)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('mousemove', update)
      document.removeEventListener('mouseleave', hide)
      window.removeEventListener('blur', hide)
      hide()
    }
  }, [ref])
}
