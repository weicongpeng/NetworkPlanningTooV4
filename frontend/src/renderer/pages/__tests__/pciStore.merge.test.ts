/**
 * pciStore persist.merge 回归：老用户 localStorage 里没有 useMod6/useMod4，
 * 重新进入页面时新开关必须按默认值(true)补齐，避免 checkbox 变非受控、
 * 请求体缺字段。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'pci-planning-storage'

describe('PCI 规划参数持久化', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('全新状态：次级模开关默认选中', async () => {
    const { usePCIStore } = await import('../../store/pciStore')
    const { config } = usePCIStore.getState()
    expect(config.useMod6).toBe(true)
    expect(config.useMod4).toBe(true)
  })

  it('旧缓存缺新字段：merge 按默认值补齐且保留旧字段', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      state: {
        wizardStep: 'idle',
        config: {
          networkType: 'LTE',
          distanceThreshold: 5,
          inheritModulus: false,
          useMod3: true,
          useMod30: false,
          pciRange: '0-503',
          enableTACPlanning: true,
        },
      },
      version: 0,
    }))
    const { usePCIStore } = await import('../../store/pciStore')
    const { config } = usePCIStore.getState()
    expect(config.useMod6).toBe(true)
    expect(config.useMod4).toBe(true)
    expect(config.distanceThreshold).toBe(5)
  })
})
