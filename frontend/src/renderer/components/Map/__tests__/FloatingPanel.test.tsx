/**
 * FloatingPanel：验证调用方传"内联 getBounds/minSize"（每次渲染新引用）时，
 * 不会发生 useLayoutEffect→setRect→重渲染 的自激循环（React error #185 白屏根因）。
 */
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { FloatingPanel } from '../FloatingPanel'

// 假容器：有足够大的尺寸，让挂载时的钳制 effect 真正走到 setRect
const BOUNDS = { clientWidth: 2000, clientHeight: 2000 } as HTMLElement

function Box() {
  const [n, setN] = useState(0)
  return (
    <div>
      <FloatingPanel
        title="panel"
        onClose={() => {}}
        initialRect={{ x: 10, y: 10, width: 500, height: 400 }}
        // 刻意内联：每次渲染都是新引用（模拟 LabelSettingsModal 的真实传法）
        getBounds={() => BOUNDS}
        minSize={{ width: 100, height: 100 }}
      >
        <div>panel-content</div>
      </FloatingPanel>
      <button onClick={() => setN(n + 1)}>rerender</button>
      <span>{n}</span>
    </div>
  )
}

describe('FloatingPanel', () => {
  it('挂载即显示内容，无 #185 循环（钳制值未变时不重渲染）', () => {
    // 修复前：render 这里直接抛 Maximum update depth exceeded
    const { getByText } = render(<Box />)
    expect(getByText('panel-content')).toBeTruthy()
  })

  it('父级多次重渲染（传入新内联函数/对象）面板仍稳定、几何不变', () => {
    const { getByText, container } = render(<Box />)
    for (let i = 0; i < 5; i++) fireEvent.click(getByText('rerender'))
    expect(getByText('panel-content')).toBeTruthy()
    expect(getByText('5')).toBeTruthy()
    // 几何保持初始值，没有被循环反复改写
    const panel = container.querySelector('.absolute.z-\\[5000\\]') as HTMLElement
    expect(panel.style.width).toBe('500px')
    expect(panel.style.height).toBe('400px')
    expect(panel.style.left).toBe('10px')
    expect(panel.style.top).toBe('10px')
  })
})
