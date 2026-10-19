/**
 * 频点颜色映射器测试（含自定义配色覆盖）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { FrequencyColorMapper } from '../frequencyColors'

describe('FrequencyColorMapper', () => {
  let mapper: FrequencyColorMapper

  beforeEach(() => {
    mapper = new FrequencyColorMapper()
  })

  it('应为 LTE/NR 频点生成默认颜色', () => {
    const lte = mapper.getColor(1835, 'LTE')
    const nr = mapper.getColor(3408.96, 'NR')
    expect(lte.color).toMatch(/^#|^hsl/)
    expect(lte.strokeColor).toBeTruthy()
    expect(nr.color).toMatch(/^#|^hsl/)
    expect(nr.strokeColor).toBeTruthy()
  })

  it('应优先返回自定义配色', () => {
    mapper.setCustomColor(1835, 'LTE', '#FF0000', '#AA0000')
    const c = mapper.getColor(1835, 'LTE')
    expect(c.color).toBe('#FF0000')
    expect(c.strokeColor).toBe('#AA0000')
  })

  it('删除自定义配色后应回退到默认颜色', () => {
    const before = mapper.getColor(1835, 'LTE')
    mapper.setCustomColor(1835, 'LTE', '#FF0000', '#AA0000')
    mapper.removeCustomColor(1835, 'LTE')
    const after = mapper.getColor(1835, 'LTE')
    expect(after.color).toBe(before.color)
  })

  it('自定义配色不串网类型（LTE 自定义不影响 NR）', () => {
    mapper.setCustomColor(954, 'LTE', '#FF0000', '#AA0000')
    const nr = mapper.getColor(954, 'NR')
    expect(nr.color).not.toBe('#FF0000')
  })

  it('getCustomColors / loadCustomColors 应能持久化往返', () => {
    mapper.setCustomColor(1835, 'LTE', '#FF0000', '#AA0000')
    mapper.setCustomColor(3408.96, 'NR', '#00FF00', '#008800')
    const saved = mapper.getCustomColors()

    const restored = new FrequencyColorMapper()
    restored.loadCustomColors(saved)
    expect(restored.getColor(1835, 'LTE').color).toBe('#FF0000')
    expect(restored.getColor(3408.96, 'NR').color).toBe('#00FF00')
    // 未自定义的频点不受影响
    expect(restored.getColor(1850, 'LTE').color).toBe(mapper.getColor(1850, 'LTE').color)
  })

  it('clear() 应保留自定义配色（数据刷新后仍生效）', () => {
    mapper.setCustomColor(1835, 'LTE', '#FF0000', '#AA0000')
    mapper.getColor(1835, 'LTE')
    mapper.clear()
    // clear 后再取该频点，仍应命中自定义色
    const c = mapper.getColor(1835, 'LTE')
    expect(c.color).toBe('#FF0000')
  })

  it('loadCustomColors(null/undefined) 应清空自定义配色', () => {
    mapper.setCustomColor(1835, 'LTE', '#FF0000', '#AA0000')
    mapper.loadCustomColors(null)
    expect(mapper.getCustomColors()).toEqual({})
  })
})
