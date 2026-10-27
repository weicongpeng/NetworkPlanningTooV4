import { describe, it, expect } from 'vitest'
import { cleanUserProperties } from '../featureProps'

describe('cleanUserProperties', () => {
  it('剔除所有 _ 前缀内部字段，保留用户字段', () => {
    const out = cleanUserProperties({
      _editId: 'e1',
      _editStyle: { color: '#f00' },
      _style: { fillColor: '#0f0' },
      _shape: 'circle',
      name: '测试点',
      等级: 'A',
      value: 123,
    })
    expect(out).toEqual({ name: '测试点', 等级: 'A', value: 123 })
  })

  it('返回新对象（不修改入参）', () => {
    const input = { _editId: 'e1', name: 'x' }
    const out = cleanUserProperties(input)
    expect(out).not.toBe(input)
    expect(input._editId).toBe('e1')
  })

  it('空/空值入参安全处理', () => {
    expect(cleanUserProperties(null)).toEqual({})
    expect(cleanUserProperties(undefined)).toEqual({})
    expect(cleanUserProperties({})).toEqual({})
  })

  it('全部为内部字段时返回空对象', () => {
    expect(cleanUserProperties({ _editId: 'e1', _isNew: true })).toEqual({})
  })
})
