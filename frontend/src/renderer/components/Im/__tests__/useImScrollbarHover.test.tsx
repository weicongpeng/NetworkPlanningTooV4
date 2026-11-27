import { act, render } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it } from 'vitest'

import { useImScrollbarHover } from '../useImScrollbarHover'

interface Props {
  testId: string
  left: number
  right: number
}

function ScrollArea({ testId, left, right }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  useImScrollbarHover(ref)
  return (
    <div
      ref={node => {
        ref.current = node
        if (!node) return
        node.getBoundingClientRect = () => ({
          left, right, top: 0, bottom: 100,
          width: right - left, height: 100, x: left, y: 0,
          toJSON: () => ({}),
        }) as DOMRect
      }}
      data-testid={testId}
    />
  )
}

const moveTo = (x: number, y: number) => {
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }))
  })
}

describe('沟通助手滚动条显隐区域', () => {
  it('光标只落在对应滚动区时该区滑块可见，移出后隐藏', () => {
    const { getByTestId } = render(
      <>
        <ScrollArea testId="sidebar" left={0} right={100} />
        <ScrollArea testId="chat" left={200} right={300} />
      </>,
    )
    const sidebar = getByTestId('sidebar')
    const chat = getByTestId('chat')
    const visible = (element: HTMLElement) => element.classList.contains('im-scrollbar-visible')

    moveTo(50, 50)
    expect(visible(sidebar)).toBe(true)
    expect(visible(chat)).toBe(false)

    moveTo(250, 50)
    expect(visible(sidebar)).toBe(false)
    expect(visible(chat)).toBe(true)

    moveTo(500, 50)
    expect(visible(sidebar)).toBe(false)
    expect(visible(chat)).toBe(false)
  })
})
