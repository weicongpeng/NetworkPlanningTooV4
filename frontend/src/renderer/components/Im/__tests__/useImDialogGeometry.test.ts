import { describe, expect, it } from 'vitest'

import { clampImDialogOffset, IM_DIALOG_RESIZE_HANDLES } from '../useImDialogGeometry'

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

describe('图片浮层 8 向缩放热区', () => {
  it('四边四角各一个，鼠标指针方向正确', () => {
    expect(IM_DIALOG_RESIZE_HANDLES).toHaveLength(8)
    expect(new Set(IM_DIALOG_RESIZE_HANDLES.map(h => h.dir)).size).toBe(8)
    const cursor = (dir: string) => IM_DIALOG_RESIZE_HANDLES.find(h => h.dir === dir)!.className
    expect(cursor('e')).toContain('cursor-e-resize')
    expect(cursor('s')).toContain('cursor-s-resize')
    expect(cursor('se')).toContain('cursor-nwse-resize')
    expect(cursor('nw')).toContain('cursor-nwse-resize')
  })
})
