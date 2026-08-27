import { describe, it, expect } from 'vitest'
import { computeCellChanges } from '../CellQueryUpdateCard'

const base = (over: Record<string, unknown> = {}) => ({
  id: 'r1', managedElementId: '2001', siteId: '111', cellId: '1', cellName: 'TH-1',
  mcc: '460', mnc: '11', longitude: '113', latitude: '23', azimuth: '0',
  frequency: '1825', ssbFrequency: '', cellCoverType: 1, ...over,
})

describe('computeCellChanges', () => {
  it('检测字段修改（旧→新）', () => {
    const orig = [base()]
    const edited = [base({ cellName: 'TH-1-改', azimuth: '90' })]
    const changes = computeCellChanges(orig, edited, new Set(), 'LTE')
    expect(changes.updates).toHaveLength(1)
    expect(changes.updates[0].diff).toMatchObject({
      cellName: ['TH-1', 'TH-1-改'],
      azimuth: ['0', '90'],
    })
    expect(changes.deletes).toHaveLength(0)
  })

  it('未修改的行不产生变更', () => {
    const orig = [base()]
    const edited = [base()]
    const changes = computeCellChanges(orig, edited, new Set(), 'LTE')
    expect(changes.updates).toHaveLength(0)
  })

  it('删除标记行进入 deletes', () => {
    const orig = [base()]
    const edited = [base()]
    const changes = computeCellChanges(orig, edited, new Set(['r1']), 'LTE')
    expect(changes.deletes).toHaveLength(1)
    expect(changes.deletes[0]).toMatchObject({
      rowKey: 'r1', networkType: 'LTE', cellName: 'TH-1', siteId: '111', cellId: '1',
    })
  })

  it('删除标记行不产生 update（优先删除）', () => {
    const orig = [base()]
    const edited = [base({ cellName: '改' })]
    const changes = computeCellChanges(orig, edited, new Set(['r1']), 'LTE')
    expect(changes.deletes).toHaveLength(1)
    expect(changes.updates).toHaveLength(0)
  })
})
