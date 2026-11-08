/**
 * LegendFrame 回归：
 * 1. 默认展开；点击折叠按钮收起为悬浮图标；点击图标（无位移）恢复展开。
 * 2. 跨端同步来的越界绝对布局在挂载时立即被拉回可视区域
 *    （桌面端地图容器 overflow:hidden 会把越界图例整个裁掉）。
 * 3. 折叠态拖动只改位置，不把 34x34 的图标尺寸写进窗口布局。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const storeState: {
  legendLayout: Record<string, { x?: number; y?: number; width?: number; height?: number }>
  setLegendLayout: ReturnType<typeof vi.fn>
} = {
  legendLayout: {},
  setLegendLayout: vi.fn(),
}

vi.mock('../../../store/mapStore', () => ({
  useMapStore: (sel: (s: unknown) => unknown) =>
    sel({
      mapSettings: { legendLayout: storeState.legendLayout },
      setLegendLayout: storeState.setLegendLayout,
    }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { LegendFrame } from '../LegendFrame'

/** jsdom 无 ResizeObserver；父容器固定 800x600，元素固定 260x300 */
class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState.legendLayout = {}
  storeState.setLegendLayout.mockImplementation((key: string, value: unknown) => {
    ;(storeState.legendLayout as Record<string, unknown>)[key] = value
  })
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverMock
  // 父容器 800x600；展开态浮窗 260x300；折叠态图标 34x34
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isFrame = this.classList.contains('legend-frame-test')
    const isCollapsed = isFrame && this.getAttribute('role') === 'button'
    const w = isCollapsed ? 34 : isFrame ? 260 : 800
    const h = isCollapsed ? 34 : isFrame ? 300 : 600
    return {
      left: 0, top: 0, width: w, height: h, right: w, bottom: h,
      x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect
  })
})

function renderFrame() {
  return render(
    <LegendFrame
      layoutKey="heatmap"
      className="legend-frame-test"
      defaultAnchor={{ bottom: 24, right: 10 }}
      title="热力图"
    >
      <span>图例内容</span>
    </LegendFrame>
  )
}

describe('LegendFrame 折叠与越界纠偏', () => {
  it('默认展开；折叠图标右吸附，点击展开后窗口以右锚定向左展开', () => {
    const { container } = renderFrame()
    const frame = () => container.querySelector('.legend-frame-test') as HTMLElement
    expect(screen.getByText('图例内容')).toBeTruthy()
    // 十字拖动图标已移除：标题栏只剩折叠按钮一个图标（拖动仍挂在标题栏上）
    expect(frame().querySelectorAll('svg').length).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'map.legendCollapse' }))
    expect(screen.queryByText('图例内容')).toBeNull()
    const icon = screen.getByRole('button', { name: 'map.legendExpand' })
    // 折叠图标贴地图右边缘，不再沿用窗口的左侧绝对位置
    expect(frame().style.right).toBe('10px')
    expect(frame().style.left).toBe('')

    // 点击（无位移）：pointerdown 开始交互，window pointerup 结束 → 展开
    fireEvent.pointerDown(icon, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(window, { clientX: 100, clientY: 100 })
    expect(screen.getByText('图例内容')).toBeTruthy()
    // 展开后共用右锚点：窗口向左展开（不设 left）
    expect(frame().style.right).toBe('10px')
    expect(frame().style.left).toBe('')
    cleanup()
  })

  it('已有自定义左侧布局时折叠仍强制右吸附', () => {
    storeState.legendLayout = { heatmap: { x: 400, y: 200 } }
    const { container } = renderFrame()
    fireEvent.click(screen.getByRole('button', { name: 'map.legendCollapse' }))
    const frame = container.querySelector('.legend-frame-test') as HTMLElement
    expect(frame.style.right).toBe('10px')
    expect(frame.style.left).toBe('')
    cleanup()
  })

  it('挂载时把越界的持久化布局拉回可视区域', () => {
    storeState.legendLayout = { heatmap: { x: 3000, y: 2000 } }
    renderFrame()
    expect(storeState.setLegendLayout).toHaveBeenCalled()
    const [, corrected] = storeState.setLegendLayout.mock.calls[0] as unknown as [
      string,
      { x: number; y: number },
    ]
    expect(corrected.x).toBeLessThanOrEqual(800)
    expect(corrected.y).toBeLessThanOrEqual(600)
    cleanup()
  })

  it('折叠态拖动只保存位置，不把图标尺寸写进窗口布局', () => {
    renderFrame()
    fireEvent.click(screen.getByRole('button', { name: 'map.legendCollapse' }))
    const icon = screen.getByRole('button', { name: 'map.legendExpand' })

    fireEvent.pointerDown(icon, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 160, clientY: 140 })
    fireEvent.pointerUp(window, { clientX: 160, clientY: 140 })

    expect(storeState.setLegendLayout).toHaveBeenCalled()
    const [, saved] = storeState.setLegendLayout.mock.calls[0] as unknown as [
      string,
      { x?: number; y?: number; width?: number; height?: number },
    ]
    expect(saved.x).toBeGreaterThan(0)
    expect(saved.width).toBeUndefined()
    expect(saved.height).toBeUndefined()
    // 拖动过不展开
    expect(screen.queryByText('图例内容')).toBeNull()
    cleanup()
  })
})
