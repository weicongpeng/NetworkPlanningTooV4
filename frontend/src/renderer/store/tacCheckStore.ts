import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type WizardStep = 'idle' | 'task_created' | 'params_set' | 'cells_selected' | 'executing' | 'completed'
type LeftTab = 'history' | 'task-config' | 'planning-result'

interface TACCheckConfig {
  networkType: 'LTE' | 'NR'
}

interface TACCheckState {
  wizardStep: WizardStep
  config: TACCheckConfig
  selectedCellIds: string[]
  activeLeftTab: LeftTab
  taskName: string

  setWizardStep: (step: WizardStep) => void
  setConfig: (config: Partial<TACCheckConfig>) => void
  setSelectedCellIds: (ids: string[]) => void
  setActiveLeftTab: (tab: LeftTab) => void
  setTaskName: (name: string) => void
  resetConfig: () => void
}

export const useTACCheckStore = create<TACCheckState>()(
  persist(
    (set) => ({
      wizardStep: 'idle',
      config: { networkType: 'LTE' },
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
          config: { networkType: 'LTE' },
          selectedCellIds: [],
          taskName: '',
        }),
    }),
    {
      name: 'tac-check-storage',
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
