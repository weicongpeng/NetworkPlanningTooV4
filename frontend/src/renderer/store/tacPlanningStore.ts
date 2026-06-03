import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type LeftTab = 'history' | 'task-config' | 'planning-result'

interface TACPlanningState {
    taskId: string | null
    config: {
        networkType: 'LTE' | 'NR'
    } | null
    result: any | null
    activeLeftTab: LeftTab
    setTaskId: (taskId: string | null) => void
    setConfig: (config: { networkType: 'LTE' | 'NR' }) => void
    setResult: (result: any) => void
    setActiveLeftTab: (tab: LeftTab) => void
    clearTAC: () => void
}

export const useTACPlanningStore = create<TACPlanningState>()(
    persist(
        (set) => ({
            taskId: null,
            config: { networkType: 'LTE' },
            result: null,
            activeLeftTab: 'history',
            setTaskId: (taskId) => set({ taskId }),
            setConfig: (config) => set({ config }),
            setResult: (result) => set({ result }),
            setActiveLeftTab: (tab) => set({ activeLeftTab: tab }),
            clearTAC: () => set({ taskId: null, result: null })
        }),
        {
            name: 'tac-planning-storage',
            partialize: (state) => ({
                taskId: state.taskId,
                config: state.config,
                result: state.result,
                activeLeftTab: state.activeLeftTab,
            })
        }
    )
)
