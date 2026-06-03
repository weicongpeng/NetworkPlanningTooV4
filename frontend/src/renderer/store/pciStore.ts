import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type WizardStep = 'idle' | 'task_created' | 'params_set' | 'cells_selected' | 'executing' | 'completed'
type LeftTab = 'history' | 'task-config' | 'planning-result'

interface PCIConfig {
  networkType: string
  distanceThreshold: number
  inheritModulus: boolean
  useMod3: boolean
  useMod30: boolean
  pciRange: string
  enableTACPlanning: boolean
}

interface PCIState {
  wizardStep: WizardStep
  config: PCIConfig
  selectedCellIds: string[]
  activeLeftTab: LeftTab
  taskName: string

  setWizardStep: (step: WizardStep) => void
  setConfig: (config: Partial<PCIConfig>) => void
  setSelectedCellIds: (ids: string[]) => void
  setActiveLeftTab: (tab: LeftTab) => void
  setTaskName: (name: string) => void
  resetConfig: () => void
}

const defaultConfig: PCIConfig = {
  networkType: 'LTE',
  distanceThreshold: 10.0,
  inheritModulus: false,
  useMod3: true,
  useMod30: false,
  pciRange: '0-503',
  enableTACPlanning: true,
}

export const usePCIStore = create<PCIState>()(
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
      name: 'pci-planning-storage',
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
