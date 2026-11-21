/** 截图标注纯函数：箭头几何、各类型尺寸与 canvas 绘制（含马赛克采样）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  arrowHead, arrowPoints, arrowShaftEnd, clamp, composeFullImage, createMosaicTile,
  drawAnnotations, drawMosaicStrokes, fontFor, isEditableShape, isMosaic, mosaicBlocksFor,
  mosaicRangeFor, mosaicSizeFor, moveShapeVertex, paintMosaicPoint, paintMosaicSegment,
  shapeHandleIndex, shapeHit, shapeSize, shapeVertices, strokeFor, translateShape,
} from '../screenshotAnnotation'
import type { Annotation } from '../screenshotAnnotation'

function fakeContext() {
  return {
    drawImage: vi.fn(), strokeRect: vi.fn(), ellipse: vi.fn(), beginPath: vi.fn(),
    stroke: vi.fn(), fill: vi.fn(), closePath: vi.fn(), clearRect: vi.fn(),
    fillRect: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), fillText: vi.fn(),
    save: vi.fn(), restore: vi.fn(),
    imageSmoothingEnabled: true,
    strokeStyle: '', fillStyle: '', lineWidth: 1, lineJoin: '', lineCap: '',
    font: '', textBaseline: '',
  }
}

let ctx: ReturnType<typeof fakeContext>

beforeEach(() => {
  ctx = fakeContext()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
})

afterEach(() => { vi.restoreAllMocks() })

describe('screenshotAnnotation', () => {
  it('arrowHead 终点为箭头尖，两翼落在终点后方且上下对称', () => {
    const [tip, wingA, wingB] = arrowHead(0, 0, 100, 0, 20)
    expect(tip).toEqual({ x: 100, y: 0 })
    expect(wingA.x).toBeLessThan(100)
    expect(wingB.x).toBeLessThan(100)
    expect(wingA.y).toBeCloseTo(-wingB.y, 6)
    // 尖嘴：张角收窄到 π/12，无论缩放都是细长尖角
    expect(Math.abs(wingA.y) / (100 - wingA.x)).toBeCloseTo(Math.tan(Math.PI / 12), 6)
    expect(arrowPoints(0, 0, 100, 0, 20)).toContain('100,0')
    // 箭杆末端回退，粗线圆帽不会盖住三角形尖端
    expect(arrowShaftEnd(0, 0, 100, 0, 20).x).toBeCloseTo(83, 6)
  })

  it('尺寸 / 颜色辅助函数边界稳定', () => {
    expect(clamp(-5, 0, 10)).toBe(0)
    expect(clamp(50, 0, 10)).toBe(10)
    expect(strokeFor(800)).toBe(2)
    expect(fontFor(800)).toBe(18)
    // 笔刷按图片宽度放大，避免高分辨率截图上色块小到看不见
    expect(mosaicSizeFor(800)).toBe(25)
    expect(mosaicSizeFor(1920)).toBe(60)
    expect(mosaicRangeFor(800)).toEqual({ min: 12, max: 100 })
    // 小笔刷用更少色块 → 每块更大 → 模糊更明显；大笔刷保持 8×8
    expect(mosaicBlocksFor(16)).toBe(5)
    expect(mosaicBlocksFor(25)).toBe(5)
    expect(mosaicBlocksFor(40)).toBe(6)
    expect(mosaicBlocksFor(60)).toBe(8)
    expect(isMosaic({ kind: 'mosaic', points: [], size: 25 })).toBe(true)
  })

  it('shapeSize 覆盖矩形、线段、箭头、文字与马赛克笔画', () => {
    expect(shapeSize({ kind: 'rect', x: 0, y: 0, w: 3, h: 4, color: '#f00' })).toBe(5)
    expect(shapeSize({ kind: 'line', x1: 0, y1: 0, x2: 3, y2: 4, color: '#f00' })).toBe(5)
    expect(shapeSize({ kind: 'arrow', x1: 0, y1: 0, x2: 3, y2: 4, color: '#f00' })).toBe(5)
    expect(shapeSize({
      kind: 'text', x: 0, y: 0, text: '备注', color: '#f00', fontSize: 18,
    })).toBe(2)
    expect(shapeSize({
      kind: 'mosaic', size: 16,
      points: [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }],
    })).toBe(11)
  })

  it('形状顶点编辑：矩形四角 / 线段两端，命中与拖动后几何正确', () => {
    const rect: Annotation = { kind: 'rect', x: 20, y: 30, w: 180, h: 140, color: '#f00' }
    const line: Annotation = { kind: 'line', x1: 0, y1: 0, x2: 100, y2: 0, color: '#f00' }
    expect(isEditableShape(rect)).toBe(true)
    expect(isEditableShape(line)).toBe(true)
    expect(isEditableShape({ kind: 'text', x: 0, y: 0, text: 'a', color: '#f00', fontSize: 18 }))
      .toBe(false)

    if (!isEditableShape(rect) || !isEditableShape(line)) return
    expect(shapeVertices(rect)).toEqual([
      { x: 20, y: 30 }, { x: 200, y: 30 }, { x: 20, y: 170 }, { x: 200, y: 170 },
    ])
    expect(shapeVertices(line)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }])
    expect(shapeHandleIndex(rect, { x: 200, y: 170 }, 8)).toBe(3)
    expect(shapeHandleIndex(line, { x: 100, y: 2 }, 8)).toBe(1)
    expect(shapeHit(line, { x: 50, y: 3 }, 8)).toBe(true)
    expect(shapeHit(line, { x: 50, y: 30 }, 8)).toBe(false)

    const grown = moveShapeVertex(rect, 3, { x: 300, y: 270 })
    expect(grown).toMatchObject({ x: 20, y: 30, w: 280, h: 240 })
    const moved = moveShapeVertex(line, 1, { x: 150, y: 40 })
    expect(moved).toMatchObject({ x1: 0, y1: 0, x2: 150, y2: 40 })

    expect(translateShape(rect, 30, 15)).toMatchObject({ x: 50, y: 45, w: 180, h: 140 })
    expect(translateShape(line, 30, 15)).toMatchObject({ x1: 30, y1: 15, x2: 130, y2: 15 })
  })

  it('drawAnnotations：矩形 / 箭头 / 文字分别落到 canvas，马赛克不在这里绘制', () => {
    const items: Annotation[] = [
      { kind: 'rect', x: 10, y: 20, w: 30, h: 40, color: '#ff3b30' },
      { kind: 'arrow', x1: 0, y1: 0, x2: 100, y2: 0, color: '#007aff' },
      { kind: 'text', x: 5, y: 6, text: 'A\nB', color: '#fff', fontSize: 18 },
      { kind: 'mosaic', size: 16, points: [{ x: 1, y: 1 }] },
    ]
    drawAnnotations(ctx as unknown as CanvasRenderingContext2D, items, 5, 7, 2)

    expect(ctx.strokeRect).toHaveBeenCalledWith(5, 13, 30, 40) // dx/dy 裁剪偏移生效
    expect(ctx.moveTo).toHaveBeenCalledWith(-5, -7)
    // 箭头箭杆末端回退到三角形内部（x2-dx=95，headSize=16，back=13.6 → 81.4）
    expect(ctx.lineTo.mock.calls.some(([x, y]) =>
      Math.abs(x - 81.4) < 0.01 && Math.abs(y + 7) < 0.01)).toBe(true)
    expect(ctx.fill).toHaveBeenCalledTimes(1) // 箭头头部三角形
    expect(ctx.fillText).toHaveBeenCalledTimes(2) // 多行文字
    expect(ctx.drawImage).not.toHaveBeenCalled() // 马赛克交给 drawMosaicStrokes
  })

  it('paintMosaicPoint / drawMosaicStrokes 逐点采样并恢复平滑设置', () => {
    const tile = createMosaicTile()
    expect(tile).not.toBeNull()
    const painter = {
      ctx: ctx as unknown as CanvasRenderingContext2D,
      source: { width: 200, height: 200 } as unknown as CanvasImageSource,
      sourceWidth: 200, sourceHeight: 200,
      tile: tile as HTMLCanvasElement,
    }
    ctx.imageSmoothingEnabled = true
    paintMosaicPoint(painter, { x: 190, y: 10 }, 20)
    // mock 下 tile 与目标画布共用同一个 ctx：采样（源图→tile）+ 放大（tile→画布）各一次
    expect(ctx.drawImage).toHaveBeenCalledTimes(2)
    // size=20 → 采样到 5×5 小画布（而非固定 8×8），色块更大、模糊更强
    expect(ctx.drawImage.mock.calls[0].slice(5)).toEqual([0, 0, 5, 5])
    expect(ctx.drawImage.mock.calls[1].slice(3, 5)).toEqual([5, 5])
    expect(ctx.imageSmoothingEnabled).toBe(true) // 调用后恢复

    drawMosaicStrokes(painter, [
      { kind: 'mosaic', size: 20, points: [{ x: 20, y: 20 }, { x: 40, y: 20 }] },
    ])
    expect(ctx.imageSmoothingEnabled).toBe(true)
  })

  it('马赛克 tile 不可用时仍绘制可见色块，绝不静默跳过（回归：工具点了没反应）', () => {
    const painter = {
      ctx: ctx as unknown as CanvasRenderingContext2D,
      source: { width: 200, height: 200 } as unknown as CanvasImageSource,
      sourceWidth: 200, sourceHeight: 200,
      tile: null,
    }
    paintMosaicPoint(painter, { x: 100, y: 100 }, 24)
    expect(ctx.fillRect).toHaveBeenCalledTimes(1)

    // 导出走 composeFullImage 时也必须带上马赛克（旧实现 if(tile) 会整段跳过）
    ctx.fillRect.mockClear()
    const full = composeFullImage(
      { width: 200, height: 200 } as unknown as CanvasImageSource, 200, 200,
      [{ kind: 'mosaic', size: 24, points: [{ x: 100, y: 100 }] }],
    )
    expect(full).not.toBeNull()
    expect(ctx.drawImage.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('快速拖动会补点，导出重放与预览逐点一致', () => {
    const tile = createMosaicTile() as HTMLCanvasElement
    const painter = {
      ctx: ctx as unknown as CanvasRenderingContext2D,
      source: { width: 400, height: 400 } as unknown as CanvasImageSource,
      sourceWidth: 400, sourceHeight: 400, tile,
    }
    const points = paintMosaicSegment(painter, { x: 20, y: 20 }, { x: 220, y: 20 }, 25)
    expect(points.length).toBeGreaterThan(5)
    expect(points[points.length - 1]).toEqual({ x: 220, y: 20 })
    expect(ctx.drawImage.mock.calls.length).toBe(points.length * 2)
  })

  it('composeFullImage 按原图尺寸合成，马赛克与其它标注都落在一张整图 canvas 上', () => {
    const source = { width: 800, height: 600 } as unknown as CanvasImageSource
    const full = composeFullImage(source, 800, 600, [
      { kind: 'mosaic', size: 16, points: [{ x: 100, y: 100 }] },
      { kind: 'rect', x: 0, y: 0, w: 50, h: 50, color: '#fff' },
    ])
    expect(full).not.toBeNull()
    expect(full?.width).toBe(800)
    expect(full?.height).toBe(600)
    expect(ctx.strokeRect).toHaveBeenCalledWith(0, 0, 50, 50)
    expect(ctx.drawImage.mock.calls.length).toBeGreaterThanOrEqual(2) // 原图 + 马赛克点
  })
})
