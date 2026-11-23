/**
 * LabelSettingsModal 实时预览：验证不会发生"下发→父级setState→重渲染→再下发"
 * 的自激循环（线上 React error #185 白屏根因），以及打开弹框不自动下发。
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, fireEvent, act, screen } from '@testing-library/react'
import { useState } from 'react'
import '../../../i18n'
import {
  DEFAULT_HEATMAP_SETTINGS,
  LabelSettingsModal,
  type HeatmapSettings,
  type LayerColorSettings,
} from '../LabelSettingsModal'

vi.useFakeTimers()

// 热力图子页会渲染色带（canvas 渐变）；jsdom 未实现 getContext，补最小桩
beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    createLinearGradient: () => ({ addColorStop: () => {} }),
    fillRect: () => {},
    getImageData: (_x: number, _y: number, w: number) => ({ data: new Uint8ClampedArray(w * 4) }),
    set fillStyle(_v: unknown) {},
  })) as never)
})

const COLOR: LayerColorSettings = {
  fillColor: '#3b82f6',
  fillOpacity: 1,
  borderWidth: 2,
  borderColor: 'none',
}

/**
 * 父级包装：onPreview 被调用时 setN（模拟 MapPage/LayerControl 收到设置后
 * setState 产生的重渲染）。修复无效时这里会无限递归 → React error #185。
 */
function Wrapper({ onPreviewColor }: { onPreviewColor: (s: LayerColorSettings) => void }) {
  const [, setN] = useState(0)
  return (
    <LabelSettingsModal
      isOpen
      onClose={() => {}}
      title="t"
      activeTab="color"
      currentColorSettings={COLOR}
      onSave={() => {}}
      onPreviewColor={(s) => { onPreviewColor(s); setN(x => x + 1) }}
    />
  )
}

const HEAT: HeatmapSettings = {
  ...DEFAULT_HEATMAP_SETTINGS,
  enabled: true,
  field: 'rsrp',
  sampleMode: 'grid',
}

/** 热力图预览用父级：props 保持稳定，便于外部 rerender 模拟父级重渲染 */
function HeatModal({
  onPreviewHeatmap,
  onSaveHeatmap,
  onCancel,
}: {
  onPreviewHeatmap: (s: HeatmapSettings | null) => void
  onSaveHeatmap?: (s: HeatmapSettings | null) => void
  onCancel?: () => void
}) {
  return (
    <LabelSettingsModal
      isOpen
      onClose={() => {}}
      title="t"
      activeTab="color"
      mode="thematic"
      initialColorSubTab="heatmap"
      showThematicTab
      fieldOptions={[{ value: 'rsrp', label: 'RSRP' }]}
      currentColorSettings={COLOR}
      currentHeatmapSettings={HEAT}
      onSave={() => {}}
      onSaveHeatmap={onSaveHeatmap}
      onPreviewHeatmap={onPreviewHeatmap}
      onCancel={onCancel}
    />
  )
}

describe('LabelSettingsModal 实时预览', () => {
  beforeEach(() => { vi.clearAllTimers() })

  it('打开弹框不自动下发（初始化抑制期吸收表单同步）', () => {
    const onPreviewColor = vi.fn()
    render(
      <LabelSettingsModal
        isOpen
        onClose={() => {}}
        title="t"
        activeTab="color"
        currentColorSettings={COLOR}
        onSave={() => {}}
        onPreviewColor={onPreviewColor}
      />
    )
    // 推进到初始化抑制解除后再等一个预览窗口
    act(() => { vi.advanceTimersByTime(350 + 250) })
    expect(onPreviewColor).not.toHaveBeenCalled()
  })

  it('用户改值仅下发一次：父级因下发而重渲染不再触发下发（无 #185 循环）', () => {
    const onPreviewColor = vi.fn()
    const { container } = render(<Wrapper onPreviewColor={onPreviewColor} />)

    // 解除初始化抑制
    act(() => { vi.advanceTimersByTime(350) })

    // 找到"边框宽度"滑杆（basic 子页，max=8；不透明度滑杆 max=100），模拟用户改值
    const widthInput = container.querySelector('input[type="range"][max="8"]') as HTMLInputElement | null
    expect(widthInput).not.toBeNull()
    act(() => {
      fireEvent.change(widthInput!, { target: { value: '5' } })
    })

    // 推进预览 debounce
    act(() => { vi.advanceTimersByTime(250) })

    // 关键：只下发一次。若自激循环存在，这里会是很多次并已抛 #185
    expect(onPreviewColor).toHaveBeenCalledTimes(1)
    expect(onPreviewColor.mock.calls[0][0]).toMatchObject({ borderWidth: 5 })

    // 再推进一个时间窗：父级重渲染早已完成，签名=基线，不应再有下发
    act(() => { vi.advanceTimersByTime(500) })
    expect(onPreviewColor).toHaveBeenCalledTimes(1)
  })

  it('热力图切到「原始采样」：地图即时预览，无需保存', () => {
    const onPreviewHeatmap = vi.fn()
    render(<HeatModal onPreviewHeatmap={onPreviewHeatmap} />)
    act(() => { vi.advanceTimersByTime(350) })

    const original = screen.getByText('原始采样').closest('button')!
    act(() => { fireEvent.click(original) })
    act(() => { vi.advanceTimersByTime(250) })

    expect(onPreviewHeatmap).toHaveBeenCalledTimes(1)
    expect(onPreviewHeatmap.mock.calls[0][0]).toMatchObject({ enabled: true, sampleMode: 'original' })
  })

  it('热力图滑动「细节增强」：地图即时预览', () => {
    const onPreviewHeatmap = vi.fn()
    const { container } = render(<HeatModal onPreviewHeatmap={onPreviewHeatmap} />)
    act(() => { vi.advanceTimersByTime(350) })

    const detailLabel = Array.from(container.querySelectorAll('label'))
      .find(l => l.textContent?.includes('细节增强'))
    const detailInput = detailLabel?.parentElement?.querySelector('input[type="range"]') as HTMLInputElement | null
    expect(detailInput).not.toBeNull()
    act(() => { fireEvent.change(detailInput!, { target: { value: '50' } }) })
    act(() => { vi.advanceTimersByTime(250) })

    expect(onPreviewHeatmap).toHaveBeenCalled()
    const lastCall = onPreviewHeatmap.mock.calls[onPreviewHeatmap.mock.calls.length - 1]
    expect(lastCall[0]).toMatchObject({ detail: 50 })
  })

  it('预览不改持久设置：点「保存」才提交，点「取消」只走还原', () => {
    const onPreviewHeatmap = vi.fn()
    const onSaveHeatmap = vi.fn()
    const onCancel = vi.fn()
    render(
      <HeatModal
        onPreviewHeatmap={onPreviewHeatmap}
        onSaveHeatmap={onSaveHeatmap}
        onCancel={onCancel}
      />
    )
    act(() => { vi.advanceTimersByTime(350) })

    const original = screen.getByText('原始采样').closest('button')!
    act(() => { fireEvent.click(original) })
    act(() => { vi.advanceTimersByTime(250) })

    expect(onPreviewHeatmap).toHaveBeenCalled()
    expect(onSaveHeatmap).not.toHaveBeenCalled()

    const saveButtons = screen.getAllByText('保存')
      .map(el => el.closest('button'))
      .filter((b): b is HTMLButtonElement => !!b)
    act(() => { fireEvent.click(saveButtons[saveButtons.length - 1]) })
    expect(onSaveHeatmap).toHaveBeenCalledTimes(1)
    expect(onSaveHeatmap.mock.calls[0][0]).toMatchObject({ sampleMode: 'original' })
  })

  it('取消不保存，交由调用方按快照还原', () => {
    const onSaveHeatmap = vi.fn()
    const onCancel = vi.fn()
    render(
      <HeatModal
        onPreviewHeatmap={() => {}}
        onSaveHeatmap={onSaveHeatmap}
        onCancel={onCancel}
      />
    )
    act(() => { vi.advanceTimersByTime(350) })
    act(() => { fireEvent.click(screen.getByText('取消')) })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSaveHeatmap).not.toHaveBeenCalled()
  })

  it('父级持续重渲染不得饿死预览下发', () => {
    const onPreviewHeatmap = vi.fn()
    const view = render(<HeatModal onPreviewHeatmap={onPreviewHeatmap} />)
    act(() => { vi.advanceTimersByTime(350) })

    const original = screen.getByText('原始采样').closest('button')!
    act(() => { fireEvent.click(original) })

    // 每 50ms 一次父级重渲染（模拟地图/统计轮询），跨越 debounce 窗口
    for (let i = 0; i < 10; i++) {
      act(() => { vi.advanceTimersByTime(50) })
      act(() => { view.rerender(<HeatModal onPreviewHeatmap={onPreviewHeatmap} />) })
    }

    expect(onPreviewHeatmap).toHaveBeenCalledTimes(1)
    expect(onPreviewHeatmap.mock.calls[0][0]).toMatchObject({ sampleMode: 'original' })
  })

  it('预览 debounce 期间父级重渲染不得吞掉本次下发', () => {
    const onPreviewHeatmap = vi.fn()
    const view = render(<HeatModal onPreviewHeatmap={onPreviewHeatmap} />)
    act(() => { vi.advanceTimersByTime(350) })

    const original = screen.getByText('原始采样').closest('button')!
    act(() => { fireEvent.click(original) })
    // 200ms debounce 到期前，父级因其它状态更新重渲染
    act(() => { vi.advanceTimersByTime(50) })
    act(() => { view.rerender(<HeatModal onPreviewHeatmap={onPreviewHeatmap} />) })
    act(() => { vi.advanceTimersByTime(300) })

    expect(onPreviewHeatmap).toHaveBeenCalledTimes(1)
    expect(onPreviewHeatmap.mock.calls[0][0]).toMatchObject({ sampleMode: 'original' })
  })
})
