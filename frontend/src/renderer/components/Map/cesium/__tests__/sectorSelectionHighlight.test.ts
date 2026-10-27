/**
 * 3D 工参搜索定位红框：选中集合里的扇区必须画出红色边框。
 *
 * 2D `locateSector` 会把搜索到的扇区 id 推给渲染器画红框；3D 早前只移动相机、
 * 没写选中集合 → 跳过去后目标扇区没有任何红色描边。这里锁住渲染侧口径：
 * 选中集合命中（id / 站点ID_小区ID / 小区名）的扇区描边必须是 #ef4444。
 */
import { describe, it, expect } from 'vitest'
import { CesiumSectorLayer } from '../CesiumSectorLayer'
import type { RenderSectorData } from '../../../../services/mapDataService'

function makeCesiumMock() {
  const primitives: any[] = []
  const C: any = {
    Cartesian3: { fromDegreesArray: (a: number[]) => a },
    Color: {
      fromCssColorString: (css: string) => ({ css, withAlpha: (alpha: number) => ({ css, alpha }) }),
    },
    ColorGeometryInstanceAttribute: { fromColor: (color: any) => ({ color }) },
    GeometryInstance: class {
      constructor(opts: any) {
        this.geometry = opts.geometry
        this.attributes = opts.attributes
        this.id = opts.id
      }
      geometry: any; attributes: any; id: any
    },
    PolygonGeometry: class { constructor(public opts: any) {} },
    PolygonHierarchy: class { constructor(public positions: any) {} },
    PerInstanceColorAppearance: Object.assign(class { constructor(_?: any) {} }, { VERTEX_FORMAT: 'v' }),
    PolylineColorAppearance: class {},
    GroundPolylineGeometry: class { constructor(public opts: any) {} },
    GroundPrimitive: class { constructor(public opts: any) {} },
    GroundPolylinePrimitive: class { constructor(public opts: any) {} },
  }
  const viewer = {
    scene: {
      primitives: {
        add: (p: any) => { primitives.push(p); return p },
        remove: () => {},
      },
    },
  }
  return { C, viewer, primitives }
}

function sector(overrides: Partial<RenderSectorData> = {}): RenderSectorData {
  return {
    id: 's1',
    networkType: 'LTE',
    originalLat: 23,
    originalLng: 114,
    displayLat: 23,
    displayLng: 114,
    cell_cover_type: 1,
    azimuth: 0,
    beamwidth: 65,
    ...overrides,
  } as unknown as RenderSectorData
}

const VIEW = { south: 22.9, north: 23.1, west: 113.9, east: 114.1, zoom: 16 }

function outlineColors(mock: ReturnType<typeof makeCesiumMock>): string[] {
  const outline = mock.primitives
    .filter(p => p instanceof mock.C.GroundPolylinePrimitive)
    .pop()
  expect(outline).toBeTruthy()
  return outline.opts.geometryInstances.map((gi: any) => gi.attributes.color.color.css)
}

describe('3D 扇区搜索定位红框', () => {
  it('选中扇区的边框渲染为 #ef4444，未选中的保持原描边色', () => {
    const mock = makeCesiumMock()
    const layer = new CesiumSectorLayer(mock.C, mock.viewer, 'LTE')
    layer.setRenderData([
      sector({ id: 's1' }),
      sector({ id: 's2', originalLng: 114.01 }),
    ])
    layer.setSelectionIds(new Set(['s1']))
    layer.update(VIEW)

    const colors = outlineColors(mock)
    expect(colors.filter(c => c === '#ef4444')).toHaveLength(1)
  })

  it('复合 id（站点ID_小区ID）与小区名同样能命中红框（与 2D isSelected 同口径）', () => {
    const mock = makeCesiumMock()
    const layer = new CesiumSectorLayer(mock.C, mock.viewer, 'LTE')
    layer.setRenderData([
      sector({ id: 's1', siteId: 'SITE-A', sectorId: '7', name: '小区甲' }),
    ])

    layer.setSelectionIds(new Set(['SITE-A_7']))
    layer.update(VIEW)
    expect(outlineColors(mock).filter(c => c === '#ef4444')).toHaveLength(1)

    layer.setSelectionIds(new Set(['小区甲']))
    layer.update(VIEW)
    expect(outlineColors(mock).filter(c => c === '#ef4444')).toHaveLength(1)
  })
})
