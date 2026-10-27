/**
 * 3D 图层配置去重：
 *
 * `syncGeoJsonLayers` 会在任一 store 配置变化时把配置推给**所有**图层。
 * 早先每次推送都无条件重建（整层重新三角化），切一个图层的显隐/标签就会让
 * 所有已打开图层卡一下。这里锁住：
 * 1. 配置内容没变 → 不重建；
 * 2. 隐藏 → 直接摘图元，显示才重建；
 * 3. 标签配置只影响 Canvas 覆盖层，不重建几何；
 * 4. 扇区层配置内容没变 → update() 不重建。
 */
import { describe, it, expect } from 'vitest'
import { CesiumGeoJsonLayer } from '../CesiumGeoJsonLayer'
import { CesiumSectorLayer } from '../CesiumSectorLayer'
import type { RenderSectorData } from '../../../../services/mapDataService'

function makeCesiumMock() {
  let adds = 0
  const live: any[] = []
  const C: any = {
    Cartesian3: {
      fromDegrees: (...a: number[]) => a,
      fromDegreesArray: (a: number[]) => a,
    },
    Color: {
      fromCssColorString: (css: string) => ({
        css,
        withAlpha: (alpha: number) => ({ css, alpha }),
      }),
    },
    ColorGeometryInstanceAttribute: { fromColor: (color: any) => ({ color }) },
    GeometryInstance: class {
      geometry: any; attributes: any; id: any
      constructor(opts: any) {
        this.geometry = opts.geometry
        this.attributes = opts.attributes
        this.id = opts.id
      }
    },
    PolygonGeometry: class { constructor(public opts: any) {} },
    GroundPolylineGeometry: class { constructor(public opts: any) {} },
    PolygonHierarchy: class { constructor(public positions: any) {} },
    PerInstanceColorAppearance: Object.assign(
      class { constructor(_?: any) {} },
      { VERTEX_FORMAT: 'v' },
    ),
    PolylineColorAppearance: class {},
    GroundPrimitive: class { show = true; constructor(public opts: any) {} },
    GroundPolylinePrimitive: class { show = true; constructor(public opts: any) {} },
    PointPrimitiveCollection: class {
      show = true
      items: any[] = []
      add(o: any) { this.items.push(o); return o }
    },
  }
  const viewer: any = {
    scene: {
      primitives: {
        add: (p: any) => { adds += 1; live.push(p); return p },
        remove: (p: any) => {
          const i = live.indexOf(p)
          if (i >= 0) live.splice(i, 1)
        },
      },
    },
  }
  return { C, viewer, live, getAdds: () => adds }
}

const flushFrames = () => new Promise<void>((resolve) => setTimeout(resolve, 40))

function polygonFeature(name: string) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[[114, 23], [114.01, 23], [114.01, 23.01], [114, 23]]],
    },
    properties: { name },
  }
}

describe('CesiumGeoJsonLayer 配置去重', () => {
  it('applyConfig 内容没变 → 不重建', async () => {
    const mock = makeCesiumMock()
    const layer = new CesiumGeoJsonLayer(mock.C, mock.viewer, 'layer-1')
    layer.setFeatureCollection({ features: [polygonFeature('甲')] } as any)
    const before = mock.getAdds()
    expect(before).toBeGreaterThan(0)

    layer.applyConfig({ visible: true, color: null, thematic: null, labelEnabled: false, label: null })
    await flushFrames()
    expect(mock.getAdds()).toBe(before)
  })

  it('隐藏/显示只切换 show、不重建几何；标签配置不触发几何重建', async () => {
    const mock = makeCesiumMock()
    const layer = new CesiumGeoJsonLayer(mock.C, mock.viewer, 'layer-1')
    layer.setFeatureCollection({ features: [polygonFeature('甲')] } as any)
    const built = mock.getAdds()
    expect(built).toBeGreaterThan(0)

    layer.applyConfig({ visible: false })
    expect(mock.getAdds()).toBe(built) // 隐藏不重建
    expect(mock.live.every((p) => p.show === false)).toBe(true)

    layer.applyConfig({ visible: true })
    await flushFrames()
    expect(mock.getAdds()).toBe(built) // 已建块直接复用
    expect(mock.live.every((p) => p.show === true)).toBe(true)

    const afterShow = mock.getAdds()
    layer.applyConfig({ labelEnabled: true, label: { content: 'name' } as any })
    await flushFrames()
    expect(mock.getAdds()).toBe(afterShow)
  })
})

describe('CesiumGeoJsonLayer 分块渲染', () => {
  it('大图层：视野外的块只切 show 不重建，移回视野直接复用', async () => {
    const mock = makeCesiumMock()
    const layer = new CesiumGeoJsonLayer(mock.C, mock.viewer, 'layer-1')
    const features: any[] = []
    for (let i = 0; i < 3000; i++) {
      const lng = 114 + (i % 50) * 0.002
      const lat = 23 + Math.floor(i / 50) * 0.002
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [lng, lat], [lng + 0.0015, lat],
            [lng + 0.0015, lat + 0.0015], [lng, lat],
          ]],
        },
        properties: { id: `f${i}` },
      })
    }
    layer.setFeatureCollection({ features } as any)
    await new Promise((r) => setTimeout(r, 300)) // 分帧构建全部块
    const allBuilt = mock.getAdds()
    expect(allBuilt).toBeGreaterThan(2) // 多块，而不是整层一个批次

    // 只看向左下角一小片：其余块应隐藏（show=false），且不触发重建
    layer.setView({ south: 23.0, north: 23.03, west: 114.0, east: 114.03, zoom: 15 })
    await new Promise((r) => setTimeout(r, 150))
    expect(mock.getAdds()).toBe(allBuilt)
    expect(mock.live.some((p) => p.show === false)).toBe(true)

    const beforeBack = mock.getAdds()
    layer.setView({ south: 23.0, north: 23.12, west: 114.0, east: 114.12, zoom: 12 })
    await new Promise((r) => setTimeout(r, 150))
    // 已构建的块直接复用，不重新三角化
    expect(mock.getAdds()).toBe(beforeBack)
    expect(mock.live.every((p) => p.show === true)).toBe(true)
  })
})

describe('CesiumSectorLayer 配置去重', () => {
  const sector = {
    id: 's1',
    networkType: 'LTE',
    originalLat: 23,
    originalLng: 114,
    displayLat: 23,
    displayLng: 114,
    cell_cover_type: 1,
    azimuth: 0,
    beamwidth: 65,
  } as unknown as RenderSectorData
  const view = { south: 22.9, north: 23.1, west: 113.9, east: 114.1, zoom: 16 }

  it('样式配置内容没变 → update 不重建；内容变了才重建', () => {
    const mock = makeCesiumMock()
    const layer = new CesiumSectorLayer(mock.C, mock.viewer, 'LTE')
    layer.setRenderData([sector])
    layer.setStyleContext({ colorOverrides: { fillOpacity: 0.6, borderWidth: 2 }, pciFrequencies: [100] })
    layer.setHighlight({ pci: { selectedId: 's1', relatedIds: ['s1'] } })
    layer.update(view)
    const built = mock.getAdds()
    expect(built).toBeGreaterThan(0)

    // 新对象、内容相同：不应标脏重建
    layer.setStyleContext({ colorOverrides: { fillOpacity: 0.6, borderWidth: 2 }, pciFrequencies: [100] })
    layer.setHighlight({ pci: { selectedId: 's1', relatedIds: ['s1'] } })
    layer.update(view)
    expect(mock.getAdds()).toBe(built)

    // 内容变化：重建一次
    layer.setStyleContext({ colorOverrides: { fillOpacity: 0.3, borderWidth: 2 }, pciFrequencies: [100] })
    layer.update(view)
    expect(mock.getAdds()).toBeGreaterThan(built)

    // 外部状态（频点自定义颜色/PCI 同步值）变化：refresh 必须强制重建
    const afterStyleChange = mock.getAdds()
    layer.refresh()
    layer.update(view)
    expect(mock.getAdds()).toBeGreaterThan(afterStyleChange)
  })
})
