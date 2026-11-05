/**
 * PCI核查页面跨页切换时的状态保持：
 * 执行中切到别的页面再切回来，必须仍是执行进度画面，且不能清掉活跃任务 ID。
 * （历史缺陷：挂载时无条件按「新建任务」页签重置向导，进度画面丢失）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const apiMock = vi.hoisted(() => ({
  pciCheckApi: {
    plan: vi.fn(),
    getProgress: vi.fn(),
    getResult: vi.fn(),
    getHistory: vi.fn(),
    deleteHistory: vi.fn(),
    export: vi.fn(),
  },
}))

vi.mock('../../services/api', () => ({
  pciCheckApi: apiMock.pciCheckApi,
  pciApi: { getHistory: vi.fn(), deleteHistory: vi.fn(), getProgress: vi.fn() },
  neighborApi: { getHistory: vi.fn(), deleteHistory: vi.fn(), getProgress: vi.fn() },
  tacApi: { getHistory: vi.fn(), deleteHistory: vi.fn(), getProgress: vi.fn() },
  tacPlanningApi: { getHistory: vi.fn(), deleteHistory: vi.fn(), getProgress: vi.fn() },
  parameterUpdateApi: { getHistory: vi.fn(), deleteHistory: vi.fn(), getProgress: vi.fn() },
}))

vi.mock('../../services/mapDataService', () => ({
  default: { clearCache: vi.fn() },
  mapDataService: { clearCache: vi.fn() },
  getCellList: vi.fn().mockResolvedValue({ lte: [], nr: [] }),
  clearCellListCache: vi.fn(),
}))

// 向导只回显当前步骤与勾选数，聚焦页面层的状态保持行为
vi.mock('../../components/PCI/PCICheckWizard', () => ({
  PCICheckWizard: (props: { wizardStep: string; selectedCellIds: Set<string> }) => (
    <div data-testid="wizard-step">{`${props.wizardStep}:${props.selectedCellIds.size}`}</div>
  ),
}))

vi.mock('../../components/PCI/PCICheckResultPanel', () => ({
  PCICheckResultPanel: () => <div data-testid="result-panel" />,
  totalRowCount: (result: any) =>
    Object.values(result?.summary || {}).reduce((sum: number, count: any) => sum + count, 0),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}))

import { PCICheckPage } from '../PCICheckPage'
import { useTaskStore } from '../../store/taskStore'
import { usePCICheckStore } from '../../store/pciCheckStore'

const RUNNING_TASK = {
  id: 't-running',
  type: 'pci_check' as const,
  status: 'running' as const,
  progress: 42,
  startTime: Date.now(),
}

const resetStores = (activeLeftTab: 'history' | 'task-config' | 'planning-result') => {
  useTaskStore.setState({
    tasks: { 't-running': RUNNING_TASK },
    activeTaskIds: {
      parameter_update: null, pci_planning: null, neighbor_planning: null,
      tac_check: null, tac_planning: null, pci_check: 't-running', upload: null,
    },
    historyCounts: {
      parameter_update: 0, pci_planning: 0, neighbor_planning: 0,
      tac_check: 0, tac_planning: 0, pci_check: 1, upload: 0,
    },
  })
  usePCICheckStore.setState({
    wizardStep: 'executing',
    config: {
      networkType: 'LTE',
      macroPairDistance: 200, mixedPairDistance: 100, indoorPairDistance: 50,
      minReuseDistanceMacro: 2000, minReuseDistanceIndoor: 500,
      macroFacingAngle: 90, indoorFacingAngle: 60,
      reuseCheck: true, collisionCheck: true, confusionCheck: true,
      mod3Check: true, mod30Check: true, neighborAssoc: true,
    },
    selectedCellIds: ['S1_1', 'S2_1'],
    activeLeftTab,
    taskName: '核查任务',
  })
}

describe('PCICheckPage 切页返回保持执行状态', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.pciCheckApi.getProgress.mockResolvedValue({
      success: true,
      data: { taskId: 't-running', status: 'processing', progress: 42 },
    })
    apiMock.pciCheckApi.getHistory.mockResolvedValue({
      success: true,
      data: { tasks: [], total: 1, page: 1, page_size: 20 },
    })
  })

  it('重新挂载后仍是执行画面，且不丢活跃任务与勾选', async () => {
    resetStores('task-config')
    const first = render(<PCICheckPage />)
    expect((await screen.findByTestId('wizard-step')).textContent).toContain('executing:2')

    first.unmount()
    render(<PCICheckPage />)

    await waitFor(() => {
      expect(screen.getByTestId('wizard-step').textContent).toContain('executing:2')
    })
    expect(useTaskStore.getState().activeTaskIds.pci_check).toBe('t-running')
    expect(usePCICheckStore.getState().wizardStep).toBe('executing')

    useTaskStore.getState().stopGlobalPolling('pci_check')
  })

  it('执行中切到「新建任务」页签不打断任务', async () => {
    resetStores('planning-result')
    render(<PCICheckPage />)
    expect(await screen.findByTestId('result-panel')).toBeTruthy()

    usePCICheckStore.setState({ activeLeftTab: 'task-config' })

    await waitFor(() => {
      expect(screen.getByTestId('wizard-step').textContent).toContain('executing:2')
    })
    expect(useTaskStore.getState().activeTaskIds.pci_check).toBe('t-running')

    useTaskStore.getState().stopGlobalPolling('pci_check')
  })

  it('空闲态切到「新建任务」页签仍会重置向导', async () => {
    resetStores('planning-result')
    useTaskStore.setState({
      tasks: {
        't-running': {
          ...RUNNING_TASK,
          status: 'completed',
          endTime: Date.now(),
          result: { taskId: 't-running', status: 'completed', progress: 100, summary: { collision: 1 }, results: { collision: [] } },
        },
      },
    })
    usePCICheckStore.setState({ wizardStep: 'completed' })

    render(<PCICheckPage />)
    expect(await screen.findByTestId('result-panel')).toBeTruthy()

    usePCICheckStore.setState({ activeLeftTab: 'task-config' })

    await waitFor(() => {
      expect(screen.getByTestId('wizard-step').textContent).toContain('idle:0')
    })
    expect(useTaskStore.getState().activeTaskIds.pci_check).toBeNull()
  })
})
