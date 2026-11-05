import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type WizardStep = 'idle' | 'task_created' | 'params_set' | 'cells_selected' | 'executing' | 'completed'
type LeftTab = 'history' | 'task-config' | 'planning-result'

export interface PCICheckConfig {
  networkType: 'LTE' | 'NR'
  /** 宏站到宏站对打距离门限（米） */
  macroPairDistance: number
  /** 宏站到室分对打距离门限（米） */
  mixedPairDistance: number
  /** 室分到室分对打距离门限（米） */
  indoorPairDistance: number
  /** 宏站PCI最小复用距离（米） */
  minReuseDistanceMacro: number
  /** 室分PCI最小复用距离（米） */
  minReuseDistanceIndoor: number
  /** 宏站对打小区夹角门限（度） */
  macroFacingAngle: number
  /** 室分对打小区夹角门限（度） */
  indoorFacingAngle: number
  /** PCI复用距离核查 */
  reuseCheck: boolean
  /** PCI冲突核查 */
  collisionCheck: boolean
  /** PCI混淆核查 */
  confusionCheck: boolean
  /** PCI模3核查（LTE/NR 通用） */
  mod3Check: boolean
  /** PCI模30核查（仅 NR） */
  mod30Check: boolean
  /** 邻区关联开关：冲突/混淆/模值邻区核查依赖预规划同频邻区对 */
  neighborAssoc: boolean
}

const defaultConfig: PCICheckConfig = {
  networkType: 'LTE',
  macroPairDistance: 200,
  mixedPairDistance: 100,
  indoorPairDistance: 50,
  minReuseDistanceMacro: 2000,
  minReuseDistanceIndoor: 500,
  macroFacingAngle: 90,
  indoorFacingAngle: 60,
  reuseCheck: true,
  collisionCheck: true,
  confusionCheck: true,
  mod3Check: true,
  mod30Check: true,
  neighborAssoc: true,
}

interface PCICheckState {
  wizardStep: WizardStep
  config: PCICheckConfig
  /** 已勾选小区（siteId_sectorId），切页返回后恢复勾选 */
  selectedCellIds: string[]
  activeLeftTab: LeftTab
  taskName: string

  setWizardStep: (step: WizardStep) => void
  setConfig: (config: Partial<PCICheckConfig>) => void
  setSelectedCellIds: (ids: string[]) => void
  setActiveLeftTab: (tab: LeftTab) => void
  setTaskName: (name: string) => void
  resetConfig: () => void
}

export const usePCICheckStore = create<PCICheckState>()(
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
      name: 'pci-check-storage',
      // 旧版本缓存里没有新增门限/开关字段，按默认值补齐
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<PCICheckState>
        return {
          ...current,
          ...saved,
          config: { ...defaultConfig, ...(saved.config ?? {}) },
        }
      },
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
