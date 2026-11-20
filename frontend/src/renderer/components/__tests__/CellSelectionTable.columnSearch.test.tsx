/**
 * 小区选择表的列搜索：默认关闭（不影响其他页面），
 * 点「搜索」按钮后表头下方出现按列的模糊过滤输入框。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CellSelectionTable } from '../CellSelectionTable'

const sectors = [
  { id: 'S1_1', siteId: 'S1', name: '小区甲', frequency: 100, pci: 12, longitude: 114.1, latitude: 30.1 },
  { id: 'S2_1', siteId: 'S2', name: '小区乙', frequency: 200, pci: 30, longitude: 114.2, latitude: 30.2 },
]

const baseProps = {
  sectors,
  selectedCellIds: new Set<string>(),
  onToggleCell: vi.fn(),
  onSelectAll: vi.fn(),
  onClearSelections: vi.fn(),
}

describe('CellSelectionTable 列搜索', () => {
  it('未启用时没有列过滤输入框', () => {
    render(<CellSelectionTable {...baseProps} />)
    expect(screen.queryByLabelText('PCI筛选')).toBeNull()
    expect(screen.queryByRole('button', { name: '搜索' })).toBeNull()
  })

  it('点「搜索」后按 PCI 列模糊过滤', () => {
    render(<CellSelectionTable {...baseProps} enableColumnSearch />)
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    const pciInput = screen.getByLabelText('PCI筛选')
    expect(screen.getByLabelText('小区名称筛选')).toBeTruthy()

    fireEvent.change(pciInput, { target: { value: '3' } })
    expect(screen.queryByText('小区甲')).toBeNull()
    expect(screen.getByText('小区乙')).toBeTruthy()
  })

  it('多列过滤取交集，关闭搜索后恢复全量', () => {
    render(<CellSelectionTable {...baseProps} enableColumnSearch />)
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.change(screen.getByLabelText('PCI筛选'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('基站ID筛选'), { target: { value: 'S9' } })
    expect(screen.queryByText('小区乙')).toBeNull()

    fireEvent.change(screen.getByLabelText('基站ID筛选'), { target: { value: 'S2' } })
    expect(screen.getByText('小区乙')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.getByText('小区甲')).toBeTruthy()
    expect(screen.getByText('小区乙')).toBeTruthy()
  })
})
