/**
 * LabelSettingsModal 实时预览：验证不会发生"下发→父级setState→重渲染→再下发"
 * 的自激循环（线上 React error #185 白屏根因），以及打开弹框不自动下发。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { useState } from 'react'
import '../../../i18n'
import { LabelSettingsModal, type LayerColorSettings } from '../LabelSettingsModal'

vi.useFakeTimers()

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
})
