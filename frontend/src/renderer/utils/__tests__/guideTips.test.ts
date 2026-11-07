import { describe, it, expect, beforeEach } from 'vitest'
import {
  GUIDE_TIP_DURATION_MS,
  GUIDE_TIP_TRIGGER_DELAY_MS,
  GUIDE_TIP_MAX_SHOWS,
  GUIDE_TIPS,
  sessionFingerprint,
  getTipShowCounts,
  canShowTip,
  bumpTipShowCount,
  getSessionShown,
  markSessionShown,
} from '../guideTips'

describe('跨周期累计计数（每条按账号累计 30 次后不再提示）', () => {
  beforeEach(() => localStorage.clear())

  it('初始计数为空且可展示', () => {
    expect(getTipShowCounts('alice')).toEqual({})
    expect(canShowTip('alice', 'pci-new-task')).toBe(true)
  })

  it('每次 bump 累加 1，且按账号隔离', () => {
    bumpTipShowCount('alice', 'pci-new-task')
    bumpTipShowCount('alice', 'pci-new-task')
    expect(getTipShowCounts('alice')).toEqual({ 'pci-new-task': 2 })
    expect(getTipShowCounts('bob')).toEqual({})
    expect(canShowTip('bob', 'pci-new-task')).toBe(true)
  })

  it('第 29 次仍可展示，达到 30 次后不可展示', () => {
    for (let i = 0; i < GUIDE_TIP_MAX_SHOWS - 1; i++) bumpTipShowCount('alice', 'result-show-map')
    expect(canShowTip('alice', 'result-show-map')).toBe(true)
    bumpTipShowCount('alice', 'result-show-map')
    expect(canShowTip('alice', 'result-show-map')).toBe(false)
  })

  it('一条达上限不影响其它提示', () => {
    for (let i = 0; i < GUIDE_TIP_MAX_SHOWS; i++) bumpTipShowCount('alice', 'pci-new-task')
    expect(canShowTip('alice', 'pci-new-task')).toBe(false)
    expect(canShowTip('alice', 'cell-tools-expand')).toBe(true)
  })

  it('损坏数据按空处理', () => {
    localStorage.setItem('npt-guide-counts:v1:alice', 'not-json')
    expect(getTipShowCounts('alice')).toEqual({})
    expect(canShowTip('alice', 'pci-new-task')).toBe(true)
  })

  it('数组/非法值不污染计数', () => {
    localStorage.setItem('npt-guide-counts:v1:alice', JSON.stringify({ 'pci-new-task': -1, ok: 3.7, bad: 'x' }))
    expect(getTipShowCounts('alice')).toEqual({ ok: 3 })
  })
})

describe('登录周期内去重（刷新不重弹、重新登录才算新周期）', () => {
  beforeEach(() => localStorage.clear())

  it('令牌指纹稳定且不同令牌不同、空令牌退化', () => {
    const a = sessionFingerprint('token-aaa')
    expect(sessionFingerprint('token-aaa')).toBe(a)
    expect(sessionFingerprint('token-bbb')).not.toBe(a)
    expect(sessionFingerprint(null)).toBe('anonymous')
  })

  it('同一登录周期内已提示的文案不再提示（刷新场景）', () => {
    const fp = sessionFingerprint('token-aaa')
    expect(getSessionShown('alice', fp)).toEqual([])
    markSessionShown('alice', fp, 'pci-new-task')
    expect(getSessionShown('alice', fp)).toEqual(['pci-new-task'])
  })

  it('标记幂等且按账号隔离', () => {
    const fp = sessionFingerprint('token-aaa')
    markSessionShown('alice', fp, 'pci-new-task')
    markSessionShown('alice', fp, 'pci-new-task')
    expect(getSessionShown('alice', fp)).toEqual(['pci-new-task'])
    expect(getSessionShown('bob', fp)).toEqual([])
  })

  it('令牌变化（重新登录）视为新周期，重新可提示', () => {
    const oldFp = sessionFingerprint('token-aaa')
    markSessionShown('alice', oldFp, 'pci-new-task')
    expect(getSessionShown('alice', oldFp)).toEqual(['pci-new-task'])
    const newFp = sessionFingerprint('token-bbb')
    expect(getSessionShown('alice', newFp)).toEqual([])
    markSessionShown('alice', newFp, 'pci-new-task')
    expect(getSessionShown('alice', newFp)).toEqual(['pci-new-task'])
    // 新周期写入后，旧指纹也不再命中
    expect(getSessionShown('alice', oldFp)).toEqual([])
  })

  it('损坏数据按空处理', () => {
    localStorage.setItem('npt-guide-session:v1:alice', 'not-json')
    expect(getSessionShown('alice', sessionFingerprint('token-aaa'))).toEqual([])
  })
})

describe('引导清单与常量', () => {
  it('常量：3 秒触发、2 分钟停留、30 次上限', () => {
    expect(GUIDE_TIP_TRIGGER_DELAY_MS).toBe(3000)
    expect(GUIDE_TIP_DURATION_MS).toBe(120000)
    expect(GUIDE_TIP_MAX_SHOWS).toBe(30)
  })
  it('锚点 id 不重复', () => {
    const ids = GUIDE_TIPS.map((tip) => tip.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
