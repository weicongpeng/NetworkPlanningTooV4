import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface TACPlanningState {
    taskId: string | null
    config: {
        networkType: 'LTE' | 'NR'
    } | null
    result: any | null
    setTaskId: (taskId: string | null) => void
    setConfig: (config: { networkType: 'LTE' | 'NR' }) => void
    setResult: (result: any) => void
    clearTAC: () => void
}

export const useTACPlanningStore = create<TACPlanningState>()(
    persist(
        (set) => ({
            taskId: null,
            config: null,
            result: null,
            setTaskId: (taskId) => set({ taskId }),
            setConfig: (config) => set({ config }),
            setResult: (result) => set({ result }),
            clearTAC: () => set({ taskId: null, result: null })
        }),
        {
            name: 'tac-planning-storage',
            partialize: (state) => ({
                taskId: state.taskId,
                config: state.config,
                result: state.result
            })
        }
    )
)
