/**
 * FeatureInfoPanel 编辑态属性行回归测试
 *
 * 覆盖修复：手绘要素继承图层字段后字段值为 null（null 占位），编辑态必须给输入框
 * 让其直接填值（此前 null 走只读 '-' 分支 → 用户只能改用"添加属性"补同名键，
 * 被"该字段已存在于图层"拒绝，表现为"手绘要素无法添加属性"）。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { FeatureInfoPanel } from '../FeatureInfoPanel'
import '../../../i18n'

function renderPanel(props: Record<string, any>, opts: { editable?: boolean; onPropertyChange?: any } = {}) {
  return render(
    <FeatureInfoPanel
      title="镇界"
      subtitle="镇界"
      properties={props}
      visible
      onClose={() => {}}
      editable={opts.editable}
      onPropertyChange={opts.onPropertyChange}
    />,
  )
}

describe('FeatureInfoPanel 编辑态字段行', () => {
  it('空值字段（null）在编辑态渲染输入框，失焦提交填写的值', () => {
    const onPropertyChange = vi.fn()
    renderPanel({ 名称: null, 编码: '7150' }, { editable: true, onPropertyChange })

    const nameRow = screen.getByText('名称').closest('tr')!
    const input = within(nameRow).getByRole('textbox')
    expect((input as HTMLInputElement).value).toBe('')

    fireEvent.change(input, { target: { value: '贝岭镇' } })
    fireEvent.blur(input)
    expect(onPropertyChange).toHaveBeenCalledWith('名称', '贝岭镇')
  })

  it('只读态（未开编辑）空值字段仍显示 -，不出现输入框', () => {
    renderPanel({ 名称: null })

    const nameRow = screen.getByText('名称').closest('tr')!
    expect(within(nameRow).queryByRole('textbox')).toBeNull()
    expect(within(nameRow).getByText('-')).toBeTruthy()
  })

  it('对象值字段保持只读（不可编辑）', () => {
    renderPanel({ 子对象: { a: 1 } }, { editable: true, onPropertyChange: vi.fn() })

    const row = screen.getByText('子对象').closest('tr')!
    expect(within(row).queryByRole('textbox')).toBeNull()
  })
})
