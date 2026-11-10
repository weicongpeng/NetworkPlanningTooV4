/**
 * PCI 规划「上传附件选择小区 → 执行」链路回归。
 *
 * 历史缺陷：上传附件只写本地 Set、没同步 zustand store，而执行提交读的是 store，
 * 导致界面显示已选中 N 个小区、后端却收到 selectedCellIds: []，退回去找
 * cell-tree-export 数据集并报「未找到待规划小区文件」。
 *
 * 本用例同时锁死两处修复：
 * 1. 上传附件后 store.selectedCellIds 必须被同步（setSelectedCellIds 收到 N 个）；
 * 2. /pci/plan 的 payload.selectedCellIds 必须是界面选中的那 N 个。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const CELL_COUNT = 151

const h = vi.hoisted(() => {
  const CELL_IDS = Array.from({ length: 151 }, (_, i) => `S1_${i + 1}`)
  const setSelectedCellIds = vi.fn()
  const plan = vi.fn()
  const state = {
    wizardStep: 'cells_selected' as const,
    config: {
      networkType: 'LTE',
      distanceThreshold: 10,
      inheritModulus: false,
      useMod3: true,
      useMod30: false,
      useMod6: true,
      useMod4: true,
      pciRange: '0-503',
      enableTACPlanning: true,
    },
    selectedCellIds: [] as string[],
    activeLeftTab: 'task-config' as const,
    taskName: '上传附件任务',
    setWizardStep: vi.fn(),
    setConfig: vi.fn(),
    setSelectedCellIds,
    setActiveLeftTab: vi.fn(),
    setTaskName: vi.fn(),
    // no-op：组件挂载时会 resetConfig，这里要保留「小区选择」步骤与空 store
    resetConfig: vi.fn(),
  }
  const taskState: Record<string, any> = {
    updateTaskProgress: vi.fn(),
    completeTask: vi.fn(),
    failTask: vi.fn(),
    activeTaskIds: { pci_planning: null },
    setActiveTaskId: vi.fn(),
    startTask: vi.fn(),
    getLatestPCITask: vi.fn(() => null),
    startGlobalPolling: vi.fn(),
    isGlobalPollingActive: vi.fn(() => false),
    syncHistoryFromBackend: vi.fn(() => Promise.resolve()),
    stopGlobalPolling: vi.fn(),
    tasks: {},
    historyCounts: { pci_planning: 0 },
  }
  return { state, taskState, setSelectedCellIds, plan, CELL_IDS }
})

vi.mock('../../store/pciStore', () => ({
  usePCIStore: (selector?: any) => (selector ? selector(h.state) : h.state),
}))

vi.mock('../../store/taskStore', () => {
  const useTaskStore: any = (selector?: any) => (selector ? selector(h.taskState) : h.taskState)
  useTaskStore.getState = () => h.taskState
  useTaskStore.setState = vi.fn()
  return { useTaskStore }
})

vi.mock('../../store/mapStore', () => ({
  useMapStore: (selector?: any) =>
    selector ? selector({ setGlobalShowMap: vi.fn(), mapSettings: {} }) : { setGlobalShowMap: vi.fn(), mapSettings: {} },
}))

vi.mock('../../store/authStore', () => ({
  useAuthStore: (selector?: any) => selector({ user: { username: 'tester' } }),
}))

vi.mock('../../store/dataStore', () => ({
  triggerDataRefresh: vi.fn(),
  DATA_REFRESH_EVENT: 'data-refresh',
}))

vi.mock('../../services/api', () => ({
  pciApi: {
    plan: h.plan,
    getResult: vi.fn(),
    getHistory: vi.fn(),
    deleteHistory: vi.fn(),
    getProgress: vi.fn(),
    export: vi.fn(),
    applyToParams: vi.fn(),
    markApplied: vi.fn(),
    getApplyResult: vi.fn(),
  },
  dataApi: { list: vi.fn() },
}))

vi.mock('../../services/mapDataService', () => ({
  getCellList: vi.fn(() => Promise.resolve({
    lte: h.CELL_IDS.map(id => ({ id, siteId: 'S1', sectorId: id.split('_')[1] })),
    nr: [],
  })),
  clearCellListCache: vi.fn(),
  bumpDataVersion: vi.fn(),
  mapDataService: { clearCache: vi.fn() },
}))

vi.mock('../../services/pciDataSyncService', () => ({
  pciDataSyncService: {
    initialize: vi.fn(() => Promise.resolve()),
    setPCIResults: vi.fn(),
    findSector: vi.fn(),
    getSyncedData: vi.fn(),
    findSameFrequencyPCI: vi.fn(() => []),
    syncSectorPCI: vi.fn(),
  },
}))

vi.mock('../../utils/cellFileHelper', async importOriginal => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    extractCellIdsFromFile: vi.fn(() => Promise.resolve(h.CELL_IDS)),
    downloadCellTreeTemplate: vi.fn(),
  }
})

vi.mock('../../utils/cellValidation', () => ({
  buildMissingCellsError: vi.fn(() => null),
}))

// 返回空串让页面里的 `t(key) || '中文兜底'` 走到中文兜底，
// selectedCountText 才能把 {{count}} 替换成真实的选中数量
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: unknown) =>
      typeof fallback === 'string' ? fallback : '',
    i18n: { language: 'zh' },
  }),
}))

vi.mock('../../components/CellSelectionTable', () => ({
  CellSelectionTable: (props: any) => (
    <div data-testid="cell-selection">{props.selectedCountText}</div>
  ),
}))

vi.mock('../../components/WizardFooter', () => ({
  WizardFooter: (props: any) => (
    <button data-testid="wizard-next" onClick={props.onNext}>下一步</button>
  ),
}))

vi.mock('../../components/StepIndicator', () => ({ StepIndicator: () => <div /> }))
vi.mock('../../components/HistoryTable', () => ({ HistoryTable: () => <div /> }))
vi.mock('../../components/HistoryTabActions', () => ({ HistoryTabActions: () => <div /> }))
vi.mock('../../components/LoadingSpinner', () => ({ LoadingSpinner: () => <div /> }))
vi.mock('../../components/Map/PCILegend', () => ({ PCILegend: () => <div /> }))
vi.mock('../../components/Map/MapCanvas', () => ({ MapCanvas: () => <div /> }))
vi.mock('../../components/Map/MapSourceSwitch', () => ({ MapSourceSwitch: () => <div /> }))

import { PCIPage } from '../PCIPage'

describe('PCI 规划上传附件选择小区', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.plan.mockResolvedValue({ success: true, data: { taskId: 't-new', message: '' } })
  })

  it('导入 151 个小区后执行：store 同步，且提交给后端的 selectedCellIds 为这 151 个', async () => {
    const { container } = render(<PCIPage />)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).toBeTruthy()
    fireEvent.change(fileInput, {
      target: { files: [new File(['dummy'], 'cell-tree-export.xlsx')] },
    })

    // 上传附件后界面与 store 都必须记住这 151 个小区
    await waitFor(() => {
      expect(screen.getByTestId('cell-selection').textContent).toContain(String(CELL_COUNT))
    })
    await waitFor(() => {
      const calls = h.setSelectedCellIds.mock.calls
      const ids = calls[calls.length - 1]?.[0] as string[]
      expect(ids).toHaveLength(CELL_COUNT)
      expect(ids).toContain('S1_1')
    })

    fireEvent.click(screen.getByTestId('wizard-next'))

    await waitFor(() => expect(h.plan).toHaveBeenCalledTimes(1))
    const payload = h.plan.mock.calls[0][0]
    expect(payload.selectedCellIds).toHaveLength(CELL_COUNT)
    expect(payload.selectedCellIds).toContain('S1_1')
    expect(payload.selectedCellIds).toContain(`S1_${CELL_COUNT}`)
    // 新增的次级模约束开关必须随请求体传到后端
    expect(payload.useMod6).toBe(true)
    expect(payload.useMod4).toBe(true)
  })
})
