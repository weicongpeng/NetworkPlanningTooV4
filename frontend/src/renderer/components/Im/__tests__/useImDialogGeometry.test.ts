import { describe, expect, it } from 'vitest'

import { clampImDialogOffset } from '../useImDialogGeometry'

const baseRect = { left: 200, top: 100, width: 800, height: 600 }

describe('图片浮层拖动边界', () => {
  it('保留普通拖动偏移', () => {
    expect(clampImDialogOffset({ x: 20, y: 30 }, baseRect, 1280, 800))
      .toEqual({ x: 20, y: 30 })
  })

  it('拖出四边时钳制到可视区域', () => {
    expect(clampImDialogOffset({ x: -500, y: -300 }, baseRect, 1280, 800))
      .toEqual({ x: -192, y: -92 })
    expect(clampImDialogOffset({ x: 500, y: 300 }, baseRect, 1280, 800))
      .toEqual({ x: 272, y: 92 })
  })

  it('桌面端顶部边界避开自绘标题栏', () => {
    expect(clampImDialogOffset({ x: 0, y: -300 }, baseRect, 1280, 800, 32).y)
      .toBe(-60)
  })
})
