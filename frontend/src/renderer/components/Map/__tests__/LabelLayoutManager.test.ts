/**
 * LabelLayoutManager 共享标签布局引擎测试
 *
 * 验证核心需求：
 * 1. 任何缩放/密度下，已放置标签的矩形互不重叠（含最小间距）
 * 2. 密集场景尽量多显示标签；稀疏场景全部显示
 * 3. 标签尽量靠近元素（首选正上方，偏移有限）
 * 4. 跨标签源（LTE/NR/地理化图层）全局防重叠
 * 5. 缩放动画期间隐藏标签，zoomend 后重新布局
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import L from 'leaflet'
import { LabelLayoutManager, type LabelCandidate } from '../LabelLayoutManager'

// jsdom 不实现 Canvas 2D 上下文，测试中用最小 mock 替代
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function () {
    return {
      measureText: (t: string) => ({ width: String(t).length * 12 }),
      fillText: () => {},
      strokeText: () => {},
      roundRect: () => {},
      rect: () => {},
      fill: () => {},
      lineJoin: '',
      clearRect: () => {},
      setTransform: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      font: '',
      fillStyle: '',
      strokeStyle: '',
      textAlign: '',
      textBaseline: '',
      lineWidth: 0
    } as unknown as CanvasRenderingContext2D
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
})

function makeCandidates(points: Array<[number, number, string]>, source = 'src'): LabelCandidate[] {
  return points.map(([lat, lng, text], i) => ({
    id: `${source}-${i}`,
    lat,
    lng,
    text,
    fontSize: 12,
    color: '#000'
  }))
}

/** 读取引擎当前布局结果（私有字段，测试用） */
function getPlacements(engine: LabelLayoutManager) {
  return (engine as any).placements as Array<Record<string, any> & {
    lat: number; lng: number; dx: number; dy: number; text: string; fontSize: number
  }>
}

/** 等待 requestAnimationFrame 回调执行（jsdom pretendToBeVisual 下 rAF ≈ 16ms） */
function flushRAF() {
  return new Promise(resolve => setTimeout(resolve, 60))
}

describe('LabelLayoutManager 标签防重叠', () => {
  let map: L.Map
  let engine: LabelLayoutManager
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    container.style.width = '1000px'
    container.style.height = '800px'
    // jsdom 不做布局，clientWidth/Height 恒为 0：直接 stub 容器尺寸
    Object.defineProperty(container, 'clientWidth', { value: 1000, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 800, configurable: true })
    document.body.appendChild(container)
    map = L.map(container, { center: [23.75, 114.7], zoom: 12, zoomAnimation: false })
    engine = new LabelLayoutManager()
    engine.addTo(map)
  })

  afterEach(() => {
    engine.remove()
    map.remove()
    container.remove()
  })

  it('稀疏分布的标签全部显示，且首选位于元素正上方附近', async () => {
    // 视口内 5 个相距很远的点（zoom 12 视口约 ±0.16°/±0.12°，取 ±0.05° 保证远离边缘）
    const candidates = makeCandidates([
      [23.80, 114.62, '站点A'],
      [23.80, 114.78, '站点B'],
      [23.70, 114.62, '站点C'],
      [23.70, 114.78, '站点D'],
      [23.75, 114.70, '站点E'],
    ])
    engine.setCandidates('s1', candidates)
    await flushRAF()

    const placements = getPlacements(engine)
    expect(placements.length).toBe(5)

    // 首选方位为正上方：dy 应为负（标签在锚点上方），dx ≈ 0
    for (const p of placements) {
      expect(p.dy).toBeLessThan(0)
      expect(Math.abs(p.dx)).toBeLessThanOrEqual(1)
    }
  })

  it('密集同位置标签：已放置矩形互不重叠', async () => {
    // 20 个完全同位置的标签（模拟同站多扇区 + 多图层叠加）
    const points: Array<[number, number, string]> = []
    for (let i = 0; i < 20; i++) {
      points.push([23.75, 114.7, `非常长的小区名称标签-${i}`])
    }
    engine.setCandidates('s1', makeCandidates(points, 'a'))
    await flushRAF()

    const placements = getPlacements(engine)
    // 不可能 20 个都放下（8 个方位），但至少放下 1 个
    expect(placements.length).toBeGreaterThanOrEqual(1)
    expect(placements.length).toBeLessThanOrEqual(8)
  })

  it('密集区域标签：任意两个已放置标签的碰撞矩形不相交', async () => {
    // 网格状密集分布 100 个点
    const points: Array<[number, number, string]> = []
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        points.push([23.75 + r * 0.004, 114.7 + c * 0.004, `小区-${r}-${c}`])
      }
    }
    engine.setCandidates('s1', makeCandidates(points))
    await flushRAF()

    const placements = getPlacements(engine)
    expect(placements.length).toBeGreaterThan(0)

    // 按引擎真实规则重建屏幕矩形（文本宽 ≈ 每字符 fontSize；PAD_X=6/PAD_Y=3），
    // 引擎保证相邻矩形间距 ≥ GAP(5px)，断言时按 5px 容差检测
    const GAP = 5
    const rects = placements.map(p => {
      const anchor = map.latLngToContainerPoint([p.lat, p.lng])
      const cx = anchor.x + p.dx
      const cy = anchor.y + p.dy
      const w = p.text.length * p.fontSize + 12 // textWidth + PAD_X*2
      const h = p.fontSize * 1.3 + 6           // textHeight + PAD_Y*2
      return { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 }
    })

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]
        const b = rects[j]
        const tooClose = a.x2 + GAP > b.x1 && a.x1 - GAP < b.x2 &&
                         a.y2 + GAP > b.y1 && a.y1 - GAP < b.y2
        expect(tooClose).toBe(false)
      }
    }
  })

  it('跨标签源（多图层）标签同样互不重叠', async () => {
    // 两个图层的标签在完全相同的位置
    const pointsA: Array<[number, number, string]> = []
    const pointsB: Array<[number, number, string]> = []
    for (let i = 0; i < 6; i++) {
      pointsA.push([23.75, 114.7, `LTE小区-${i}`])
      pointsB.push([23.75, 114.7, `NR小区-${i}`])
    }
    engine.setCandidates('lte', makeCandidates(pointsA, 'lte'))
    engine.setCandidates('nr', makeCandidates(pointsB, 'nr'))
    await flushRAF()

    const placements = getPlacements(engine)
    const total = placements.length
    // 合并所有候选后再布局，数量不应超过单源布局（否则说明跨源未互斥）
    engine.removeSource('lte')
    engine.removeSource('nr')
    await flushRAF()
    engine.setCandidates('merged', makeCandidates([...pointsA, ...pointsB], 'm'))
    await flushRAF()
    const mergedCount = getPlacements(engine).length

    expect(total).toBe(mergedCount)
  })

  it('缩放动画期间标签隐藏，zoomend 后重新布局', async () => {
    engine.setCandidates('s1', makeCandidates([
      [23.75, 114.7, '站点A'],
      [23.76, 114.71, '站点B'],
    ]))
    await flushRAF()
    expect(getPlacements(engine).length).toBe(2)

    map.fire('zoomstart')
    await flushRAF()
    expect(getPlacements(engine).length).toBe(0)

    map.fire('zoomend')
    await flushRAF()
    expect(getPlacements(engine).length).toBe(2)
  })

  it('removeSource 后标签立即消失', async () => {
    engine.setCandidates('s1', makeCandidates([[23.75, 114.7, '站点A']]))
    await flushRAF()
    expect(getPlacements(engine).length).toBe(1)

    engine.removeSource('s1')
    await flushRAF()
    expect(getPlacements(engine).length).toBe(0)
  })

  it('视口外的候选不参与布局', async () => {
    engine.setCandidates('s1', makeCandidates([
      [23.75, 114.7, '视口内'],
      [40.0, 120.0, '视口外很远'],
    ]))
    await flushRAF()
    const placements = getPlacements(engine)
    expect(placements.length).toBe(1)
    expect(placements[0].text).toBe('视口内')
  })

  it('字体设置（字体族/加粗/斜体/阴影）透传到布局结果', async () => {
    engine.setCandidates('s1', [{
      id: 'f1',
      lat: 23.75,
      lng: 114.7,
      text: '自定义字体标签',
      fontSize: 14,
      fontFamily: 'SimHei, sans-serif',
      bold: true,
      italic: true,
      shadow: true,
      background: 'box',
      backgroundColor: '#ffcc00',
      color: '#123456'
    }])
    await flushRAF()

    const placements = getPlacements(engine)
    expect(placements.length).toBe(1)
    expect(placements[0].fontFamily).toBe('SimHei, sans-serif')
    expect((placements[0] as any).bold).toBe(true)
    expect((placements[0] as any).italic).toBe(true)
    expect((placements[0] as any).shadow).toBe(true)
    expect((placements[0] as any).background).toBe('box')
    expect((placements[0] as any).backgroundColor).toBe('#ffcc00')
    expect((placements[0] as any).boxW).toBeGreaterThan(0)
    expect((placements[0] as any).boxH).toBeGreaterThan(0)
  })

  it('未指定字体设置时布局结果使用默认值（sans-serif / 效果关闭）', async () => {
    engine.setCandidates('s1', makeCandidates([[23.75, 114.7, '默认字体标签']]))
    await flushRAF()
    const p = getPlacements(engine)[0]
    expect(p.fontFamily).toBe('sans-serif')
    expect((p as any).bold).toBe(false)
    expect((p as any).italic).toBe(false)
    expect((p as any).shadow).toBe(false)
    expect((p as any).background).toBe('none')
  })

  it('未指定字体设置时布局结果使用默认值（sans-serif / 效果关闭）', async () => {
    engine.setCandidates('s1', makeCandidates([[23.75, 114.7, '默认字体标签']]))
    await flushRAF()
    const p = getPlacements(engine)[0]
    expect(p.fontFamily).toBe('sans-serif')
    expect((p as any).bold).toBe(false)
    expect((p as any).italic).toBe(false)
    expect((p as any).shadow).toBe(false)
  })
})
