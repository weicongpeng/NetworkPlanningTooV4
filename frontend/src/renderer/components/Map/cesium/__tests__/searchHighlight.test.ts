/**
 * 3D 搜索定位红框：id 口径必须与搜索弹窗一致。
 *
 * 背景：MapSearchDialog 给出的 featureId 是「自然 ID（extractFeatureId）或
 * 图层ID#序号」，而 3D 图层渲染侧曾用「props.id ?? 序号」—— 大多数 MapInfo
 * 要素没有 properties.id，两边 id 对不上 → 定位只飞行、不渲染红色描边。
 * 这里锁死：按弹窗口径算出来的 id 能被图层认出来。
 */
import { describe, it, expect } from 'vitest'
import { CesiumGeoJsonLayer } from '../CesiumGeoJsonLayer'
import { featureSelectionId } from '../cesiumGeoJson'
import { extractFeatureId } from '../../../../utils/featureId'

function makeCesiumMock() {
  const polyLines: any[] = []
  const C: any = {
    Cartesian3: { fromDegrees: (...a: number[]) => a, fromDegreesArray: (a: number[]) => a },
    Color: { fromCssColorString: (css: string) => ({ css, withAlpha: (alpha: number) => ({ css, alpha }) }) },
    ColorGeometryInstanceAttribute: { fromColor: (color: any) => ({ color }) },
    GeometryInstance: class {
      constructor(public opts: any) {
        this.geometry = opts.geometry
        this.attributes = opts.attributes
        this.id = opts.id
      }
      geometry: any; attributes: any; id: any
    },
    PolygonGeometry: class { constructor(public opts: any) {} },
    GroundPolylineGeometry: class { constructor(public opts: any) {} },
    PolygonHierarchy: class { constructor(public positions: any) {} },
    PerInstanceColorAppearance: Object.assign(class {}, { VERTEX_FORMAT: 'v' }),
    PolylineColorAppearance: class {},
    GroundPrimitive: class {
      kind = 'ground-polygon'
      constructor(public opts: any) {}
    },
    GroundPolylinePrimitive: class {
      kind = 'ground-polyline'
      geometryInstances: any[]
      constructor(opts: any) {
        this.geometryInstances = opts.geometryInstances
        polyLines.push(this)
      }
    },
    PointPrimitiveCollection: class {
      kind = 'points'
      items: any[] = []
      add(o: any) { this.items.push(o); return o }
    },
  }
  const viewer: any = { scene: { primitives: { add: (p: any) => p, remove: () => {} } } }
  return { C, viewer, polyLines }
}

/** 造一个面要素：只有 name，没有 id（MapInfo 图层最常见） */
function polyWithName(name: string, idx: number) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [114.0 + idx * 0.01, 23.0],
        [114.01 + idx * 0.01, 23.0],
        [114.01 + idx * 0.01, 23.01],
        [114.0 + idx * 0.01, 23.0],
      ]],
    },
    properties: { name, 小区名称: name },
  }
}

const LAYER_ID = 'layer-file-1'

/** 等一帧（rAF 合并的重建） */
function flushFrames(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40))
}

describe('3D 搜索定位红框（id 口径一致性）', () => {
  it('弹窗口径的自然 ID 能被图层认成选中（红色描边）', async () => {
    const mock = makeCesiumMock()
    const layer = new CesiumGeoJsonLayer(mock.C, mock.viewer, LAYER_ID)
    const features = [polyWithName('站点甲', 0), polyWithName('站点乙', 1)]
    layer.setFeatureCollection({ features } as any)

    // 复刻 MapSearchDialog.prepareMapInfoRecord 的 featureId 算法
    const dialogId = extractFeatureId(features[1].properties) || `${LAYER_ID}#${1}`
    expect(dialogId).toBe('站点乙')

    layer.setSelectionIds(new Set([String(dialogId)]))
    await flushFrames() // setSelectionIds 走 rAF 合并重建，要等一帧
    // 选中边框走单独一批图元（最后 add）
    const selectedBatch = mock.polyLines[mock.polyLines.length - 1]
    expect(selectedBatch.geometryInstances).toHaveLength(1)
    expect(selectedBatch.geometryInstances[0].attributes.color.color.css).toBe('#ef4444')
    expect(selectedBatch.geometryInstances[0].id.selectionId).toBe('站点乙')
  })

  it('弹窗口径的 图层ID#序号 兜底 id 也能被认成选中', async () => {
    const mock = makeCesiumMock()
    const layer = new CesiumGeoJsonLayer(mock.C, mock.viewer, LAYER_ID)
    // 要素没有任何标识字段 → 弹窗用 图层ID#序号
    const features = [{
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[114, 23], [114.01, 23], [114.01, 23.01], [114, 23]]] },
      properties: { foo: 'bar' },
    }]
    layer.setFeatureCollection({ features } as any)

    const dialogId = extractFeatureId(features[0].properties) || `${LAYER_ID}#${0}`
    expect(dialogId).toBe(`${LAYER_ID}#0`)
    expect(featureSelectionId(features[0].properties, LAYER_ID, 0)).toBe(dialogId)

    layer.setSelectionIds(new Set([dialogId]))
    await flushFrames()
    const selectedBatch = mock.polyLines[mock.polyLines.length - 1]
    expect(selectedBatch.geometryInstances[0].attributes.color.color.css).toBe('#ef4444')
  })

  it('圈选收集侧与渲染侧同一套 id（圈到了就高亮）', async () => {
    const features = [polyWithName('站点甲', 0)]
    // CesiumMap.layerSelectables 用的就是 featureSelectionId(properties, layerId, i)
    const collected = featureSelectionId(features[0].properties, LAYER_ID, 0)
    const mock = makeCesiumMock()
    const layer = new CesiumGeoJsonLayer(mock.C, mock.viewer, LAYER_ID)
    layer.setFeatureCollection({ features } as any)
    layer.setSelectionIds(new Set([collected]))
    await flushFrames()
    const selectedBatch = mock.polyLines[mock.polyLines.length - 1]
    expect(selectedBatch.geometryInstances[0].attributes.color.color.css).toBe('#ef4444')
  })
})
