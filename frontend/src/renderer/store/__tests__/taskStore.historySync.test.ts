import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/api', () => ({
  pciApi: { getHistory: vi.fn(), deleteHistory: vi.fn() },
  neighborApi: { getHistory: vi.fn(), deleteHistory: vi.fn() },
  tacApi: { getHistory: vi.fn(), deleteHistory: vi.fn() },
  tacPlanningApi: { getHistory: vi.fn(), deleteHistory: vi.fn() },
}))

import { useTaskStore } from '../taskStore'
import { pciApi } from '../../services/api'

/** 构造一条后端历史列表项 */
const hItem = (id: string, createdAt: string, isApplied = false) => ({
  taskId: id,
  taskType: 'pci',
  status: 'completed',
  isApplied,
  createdAt,
  completedAt: createdAt,
})

describe('taskStore 历史同步：跨端删除', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTaskStore.setState({
      tasks: {},
      historyCounts: {},
      activeTaskIds: {
        parameter_update: null, pci_planning: null, neighbor_planning: null,
        tac_check: null, tac_planning: null, upload: null,
      },
    })
  })

  it('同组其他端删除的记录（比本页最早一条更新）从本地移除', async () => {
    // 本地残留：t-deleted 已被别端删除；t-viewed 同批被删；t-viewed-old 在更后面的分页；t-running 运行中
    useTaskStore.setState({
      tasks: {
        't-1': { id: 't-1', type: 'pci_planning', status: 'completed', startTime: new Date('2026-10-08T10:00:00').getTime() },
        't-2': { id: 't-2', type: 'pci_planning', status: 'completed', startTime: new Date('2026-10-08T09:00:00').getTime() },
        't-deleted': { id: 't-deleted', type: 'pci_planning', status: 'completed', startTime: new Date('2026-10-08T09:30:00').getTime() },
        't-viewed': { id: 't-viewed', type: 'pci_planning', status: 'completed', result: { results: [{ siteId: 'A' }] }, startTime: new Date('2026-10-08T09:40:00').getTime() },
        't-viewed-old': { id: 't-viewed-old', type: 'pci_planning', status: 'completed', result: { results: [{ siteId: 'B' }] }, startTime: new Date('2026-10-07T09:00:00').getTime() },
        't-running': { id: 't-running', type: 'pci_planning', status: 'running', startTime: new Date('2026-10-08T10:30:00').getTime() },
      },
    })
    vi.mocked(pciApi.getHistory).mockResolvedValue({
      success: true,
      data: { tasks: [hItem('t-1', '2026-10-08T10:00:00'), hItem('t-2', '2026-10-08T09:00:00')], total: 2, page: 1, page_size: 20 },
    } as any)

    await useTaskStore.getState().syncHistoryFromBackend('pci_planning', 1, 20)

    const ids = Object.keys(useTaskStore.getState().tasks)
    expect(ids).toContain('t-1')
    expect(ids).toContain('t-2')
    expect(ids).not.toContain('t-deleted')      // 已被别端删除 → 移除
    expect(ids).not.toContain('t-viewed')       // 看过结果但已被别端删除 → 也要移除
    expect(ids).toContain('t-viewed-old')      // 早于本页边界，可能在后续分页 → 保留
    expect(ids).toContain('t-running')         // 运行中 → 保留
  })

  it('同组其他端应用结果后，已应用标记随列表刷新同步', async () => {
    vi.mocked(pciApi.getHistory).mockResolvedValue({
      success: true,
      data: { tasks: [hItem('t-1', '2026-10-08T10:00:00', true)], total: 1, page: 1, page_size: 20 },
    } as any)

    await useTaskStore.getState().syncHistoryFromBackend('pci_planning', 1, 20)
    expect(useTaskStore.getState().tasks['t-1'].isApplied).toBe(true)
  })
})
