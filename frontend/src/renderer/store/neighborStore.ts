import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type WizardStep = 'idle' | 'task_created' | 'params_set' | 'cells_selected' | 'executing' | 'completed'
type LeftTab = 'history' | 'task-config' | 'planning-result'

interface NeighborConfig {
  planningType: string
  maxNeighbors: number
  coverageDistanceFactor: number
  coverageRadiusFactor: number
  denseSpacingThreshold?: number
  denseMultiplier?: number
  outdoorToIndoorMaxDistance?: number
  indoorToIndoorRadius?: number
  indoorToOutdoorMultiplier?: number
  outdoorSpacingSiteCount?: number
}

interface NeighborState {
  wizardStep: WizardStep
  config: NeighborConfig
  selectedCellIds: string[]
  activeLeftTab: LeftTab
  taskName: string

  setWizardStep: (step: WizardStep) => void
  setConfig: (config: Partial<NeighborConfig>) => void
  setSelectedCellIds: (ids: string[]) => void
  setActiveLeftTab: (tab: LeftTab) => void
  setTaskName: (name: string) => void
  resetConfig: () => void
}

const defaultConfig: NeighborConfig = {
  planningType: 'LTE-LTE',
  maxNeighbors: 64,
  coverageDistanceFactor: 0.5,
  coverageRadiusFactor: 0.5,
  denseSpacingThreshold: 1.0,
  denseMultiplier: 1.3,
  outdoorToIndoorMaxDistance: 0.6,
  indoorToIndoorRadius: 0.35,
  indoorToOutdoorMultiplier: 1.5,
  outdoorSpacingSiteCount: 9,
}

export const useNeighborStore = create<NeighborState>()(
  persist(
    (set) => ({
      wizardStep: 'idle',
      config: { ...defaultConfig },
      selectedCellIds: [],
      activeLeftTab: 'history',
      taskName: '',

      setWizardStep: (step) => set({ wizardStep: step }),
      setConfig: (partial) => set((state) => ({ config: { ...state.config, ...partial } })),
      setSelectedCellIds: (ids) => set({ selectedCellIds: ids }),
      setActiveLeftTab: (tab) => set({ activeLeftTab: tab }),
      setTaskName: (name) => set({ taskName: name }),
      resetConfig: () =>
        set({
          wizardStep: 'idle',
          config: { ...defaultConfig },
          selectedCellIds: [],
          taskName: '',
        }),
    }),
    {
      name: 'neighbor-planning-storage',
      partialize: (state) => ({
        wizardStep: state.wizardStep,
        config: state.config,
        selectedCellIds: state.selectedCellIds,
        activeLeftTab: state.activeLeftTab,
        taskName: state.taskName,
      }),
    }
  )
)
