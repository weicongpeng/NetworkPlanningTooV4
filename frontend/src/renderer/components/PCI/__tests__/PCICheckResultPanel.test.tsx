import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const dict: Record<string, string> = {
  'pciCheck.types.collision': 'PCI冲突',
  'pciCheck.types.confusion': 'PCI混淆',
  'pciCheck.column.bCgi': '目标1-CGI',
  'pciCheck.column.cCgi': '目标2-小区CGI',
  'pciCheck.column.cPci': '目标2-小区PCI',
  'pciCheck.column.pci': '目标1-PCI',
  'pciCheck.column.distanceM': '源小区与目标1-小区距离(米)',
  'pciCheck.column.aToCDistanceM': '源小区与目标2-小区距离(米)',
  'pciCheck.export': '导出',
  'pciCheck.exportAll': '全部导出',
  'pciCheck.exportCsv': '导出当前页',
  'pciCheck.search': '搜索',
  'pciCheck.exporting': '导出中',
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => dict[key] ?? fallback ?? key,
  }),
}))

import { PCICheckResultPanel } from '../PCICheckResultPanel'

const ROW = {
  aCgi: 'S1-1', bCgi: 'S2-1', cCgi: 'S3-1',
  aSiteId: 'S1', bSiteId: 'S2', cSiteId: 'S3',
  aSiteName: '站点1', bSiteName: '站点2', cSiteName: '站点3',
  aSectorId: '1', bSectorId: '1', cSectorId: '1',
  aSectorName: '小区1', bSectorName: '小区2', cSectorName: '小区3',
  bPci: 120, cPci: 120, pci: 120,
  distanceM: 1200, aToCDistanceM: 800, bToCDistanceM: 400,
  reason: '测试',
}

const RESULT = {
  taskId: 't-1',
  status: 'completed' as const,
  progress: 100,
  networkType: 'LTE' as const,
  totalCells: 10,
  poolCells: 100,
  neighborAssoc: true,
  skippedCount: 0,
  startTime: '',
  summary: { collision: 1, confusion: 1 },
  results: { collision: [ROW], confusion: [ROW] },
}

const renderPanel = (activeCategory: 'collision' | 'confusion') => {
  const onExportAll = vi.fn()
  const onExportCsv = vi.fn()
  const view = render(
    <PCICheckResultPanel
      result={RESULT}
      config={{} as any}
      loading={false}
      emptyHint=""
      activeCategory={activeCategory}
      onCategoryChange={vi.fn()}
      exportState="idle"

      onExportAll={onExportAll}
      onExportCsv={onExportCsv}
    />
  )
  return { ...view, onExportAll, onExportCsv }
}

describe('PCICheckResultPanel', () => {
  it('非混淆表格不区分目标1/目标2，且页签标签不重复', () => {
    renderPanel('collision')
    expect(screen.getByRole('columnheader', { name: '目标PCI' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '目标CGI' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '源小区与目标小区距离(米)' })).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: '目标1-PCI' })).toBeNull()
    // 类别名只在页签出现一次，下方结果表不再重复标签
    expect(screen.getAllByText('PCI冲突')).toHaveLength(1)
  })

  it('混淆表格保留目标1/目标2列名', () => {
    renderPanel('confusion')
    expect(screen.getByRole('columnheader', { name: '目标1-PCI' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '目标2-小区CGI' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '目标2-小区PCI' })).toBeTruthy()
  })

  it('搜索在导出左侧，导出下拉提供全部导出与导出当前页', () => {
    const { onExportAll, onExportCsv } = renderPanel('collision')
    const searchButton = screen.getByRole('button', { name: /搜索/ })
    const exportButton = screen.getByRole('button', { name: /导出/ })
    expect(searchButton.compareDocumentPosition(exportButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(exportButton)
    expect(screen.getByRole('button', { name: '全部导出' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '导出当前页' }))
    expect(onExportCsv).toHaveBeenCalledTimes(1)

    fireEvent.click(exportButton)
    fireEvent.click(screen.getByRole('button', { name: '全部导出' }))
    expect(onExportAll).toHaveBeenCalledTimes(1)
  })
})
