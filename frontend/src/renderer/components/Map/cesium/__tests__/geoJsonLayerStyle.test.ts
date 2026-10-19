/**
 * CesiumGeoJsonLayer 的要素配色解析与批量图元结构锁定。
 *
 * 后端把 TAB/MIF/KML 的逐要素样式注入到 `properties._style`（见
 * `backend/app/services/mapinfo_service.py`），2D `MapInfoLayer` 按
 * 「默认 < _style < 图层级用户设置 < 专题」合并；Cesium 侧此前完全忽略 `_style`，
 * 于是 3D 里"图层文件"丢掉了文件原有配色。
 *
 * 渲染也从"逐 Entity"改成"面/线/点/标签各一个批量图元"（加载自有图层卡顿的主因）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { CesiumGeoJsonLayer } from '../CesiumGeoJsonLayer'
import { NO_FILL_COLOR } from '../../../../utils/fieldValue'

/** 极简 Cesium mock：覆盖 CesiumGeoJsonLayer 用到的部分，并记录创建出的批量图元 */
function makeCesiumMock() {
  const primitives: any[] = []

  const makeCollection = (kind: 'point' | 'label') => class {
    items: any[] = []
    add(opts: any) { const it = { ...opts, kind }; this.items.push(it); return it }
  }

  const C: any = {
    CustomDataSource: class {
      entities = { removeAll: () => {}, add: () => {} }
      constructor(public name: string) {}
    },
    Entity: class { constructor(opts: any) { Object.assign(this, opts) } },
    PolygonHierarchy: class { constructor(public positions: any) {} },
    Cartesian3: {
      fromDegrees: (...a: number[]) => a,
      fromDegreesArray: (a: number[]) => a,
    },
    Color: {
      fromCssColorString: (css: string) => ({
        css,
        withAlpha(alpha: number) { return { css, alpha } },
      }),
    },
    ColorGeometryInstanceAttribute: {
      fromColor: (color: any) => ({ color }),
    },
    GeometryInstance: class {
      constructor(public opts: any) {
        this.geometry = opts.geometry
        this.attributes = opts.attributes
        this.id = opts.id
      }
      geometry: any
      attributes: any
      id: any
    },
    PolygonGeometry: class { constructor(public opts: any) {} },
    GroundPolylineGeometry: class { constructor(public opts: any) {} },
    ArcType: { GEODESIC: 0, RHUMB: 1 },
    ClassificationType: { TERRAIN: 0, CESIUM_3D_TILE: 1, BOTH: 2 },
    PerInstanceColorAppearance: Object.assign(
      class { constructor(public opts?: any) {} },
      { VERTEX_FORMAT: 'vertexFormat' },
    ),
    PolylineColorAppearance: class { constructor(public opts?: any) {} },
    GroundPrimitive: class {
      kind = 'ground-polygon'
      geometryInstances: any[]
      constructor(opts: any) {
        this.geometryInstances = opts.geometryInstances
        primitives.push(this)
      }
    },
    GroundPolylinePrimitive: class {
      kind = 'ground-polyline'
      geometryInstances: any[]
      constructor(opts: any) {
        this.geometryInstances = opts.geometryInstances
        primitives.push(this)
      }
    },
    PointPrimitiveCollection: class extends makeCollection('point') {
      kind = 'points'
      constructor() { super(); primitives.push(this) }
    },
    LabelCollection: class extends makeCollection('label') {
      kind = 'labels'
      constructor() { super(); primitives.push(this) }
    },
    HeightReference: { CLAMP_TO_GROUND: 1 },
    LabelStyle: { FILL_AND_OUTLINE: 1 },
    Cartesian2: class { constructor(public x: number, public y: number) {} },
    VerticalOrigin: { BOTTOM: 1 },
    HorizontalOrigin: { CENTER: 1 },
  }
  const viewer: any = {
    dataSources: { add: () => {}, remove: () => {} },
    scene: { primitives: { add: (p: any) => p, remove: () => {} } },
  }
  return { C, viewer, primitives }
}

function polygonFeature(style: Record<string, unknown> | undefined) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[[114.0, 23.0], [114.01, 23.0], [114.01, 23.01], [114.0, 23.0]]],
    },
    properties: { id: 'f1', _style: style },
  }
}

function pointFeature(style: Record<string, unknown> | undefined) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [114.0, 23.0] },
    properties: { id: 'p1', _style: style },
  }
}

/** 取出面图元的第一个实例填充色 */
function fillColorOf(primitives: any[]) {
  const p = primitives.find((x) => x.kind === 'ground-polygon')
  return p?.geometryInstances?.[0]?.attributes?.color?.color
}

/** 取出线图元的第一个实例描边色 */
function strokeColorOf(primitives: any[]) {
  const p = primitives.find((x) => x.kind === 'ground-polyline')
  return p?.geometryInstances?.[0]?.attributes?.color?.color
}

function strokeWidthOf(primitives: any[]) {
  const p = primitives.find((x) => x.kind === 'ground-polyline')
  return p?.geometryInstances?.[0]?.geometry?.opts?.width
}

describe('CesiumGeoJsonLayer 要素配色（_style 还原）', () => {
  let primitives: any[]
  let layer: CesiumGeoJsonLayer

  beforeEach(() => {
    const mock = makeCesiumMock()
    primitives = mock.primitives
    layer = new CesiumGeoJsonLayer(mock.C, mock.viewer, 'layer-1')
  })

  it('面要素：文件自带 _style 的填充/边框被还原', () => {
    layer.setFeatureCollection({
      features: [polygonFeature({
        fillColor: '#ff0000', fillOpacity: 0.4,
        strokeColor: '#00ff00', strokeWidth: 5,
      })],
    } as any)

    expect(fillColorOf(primitives).css).toBe('#ff0000')
    expect(fillColorOf(primitives).alpha).toBeCloseTo(0.4)
    expect(strokeColorOf(primitives).css).toBe('#00ff00')
    expect(strokeWidthOf(primitives)).toBe(5)
  })

  /**
   * 回归：`defaultStyle` 不得参与渲染配色。
   *
   * 后端 `_get_layer_default_style` 在命名规则未命中时用 `_palette_color(图层名)` 返回
   * **按图层名固定的一种颜色**。它一旦进入渲染优先级链，就会无条件盖掉逐要素的 `_style`，
   * 表现为「整层被刷成同一种颜色」——例如按 RSRP 分级、多段配色的线全部变绿。
   * 2D `MapInfoLayer` 从不把 defaultStyle 放进渲染链，这里锁死同一口径。
   */
  it('逐要素 _style 不会被图层 defaultStyle 覆盖（多段配色必须还原）', () => {
    layer.applyConfig({
      base: { fillColor: '#10b981', fillOpacity: 0.35, borderColor: '#10b981' },
    } as any)
    layer.setFeatureCollection({
      features: [polygonFeature({ fillColor: '#ffd600', strokeColor: '#d50000' })],
    } as any)

    expect(fillColorOf(primitives).css).toBe('#ffd600')
    expect(strokeColorOf(primitives).css).toBe('#d50000')
  })

  it('图层级用户设置优先于文件自带 _style（保存后要生效）', () => {
    layer.applyConfig({ color: {
      fillColor: '#123456', fillOpacity: 0.9, borderColor: '#654321', borderWidth: 1,
    } as any })
    layer.setFeatureCollection({
      features: [polygonFeature({
        fillColor: '#ff0000', fillOpacity: 0.4,
        strokeColor: '#00ff00', strokeWidth: 5,
      })],
    } as any)

    expect(fillColorOf(primitives).css).toBe('#123456')
    expect(strokeColorOf(primitives).css).toBe('#654321')
    expect(strokeWidthOf(primitives)).toBe(1)
  })

  it('无 _style 时回落到默认配色（与 2D DEFAULT_STYLES 一致）', () => {
    layer.setFeatureCollection({ features: [polygonFeature(undefined)] } as any)
    expect(fillColorOf(primitives).css).toBe('#10b981')
  })

  /**
   * 默认不透明度必须是 100%（用户要求：地图上所有图形的默认不透明度都是 100%）。
   * 早先面默认 0.3、点默认 0.8，与 2D 改后的口径不一致，且"打开自定义设置不保存"
   * 时会把弹窗默认值写上去，导致地图配色悄悄变化。
   */
  it('默认填充不透明度 100%（面/点/线，无 _style 无用户设置时）', () => {
    layer.setFeatureCollection({ features: [polygonFeature(undefined)] } as any)
    expect(fillColorOf(primitives).alpha).toBe(1)

    const mock2 = makeCesiumMock()
    const layer2 = new CesiumGeoJsonLayer(mock2.C, mock2.viewer, 'layer-2')
    layer2.setFeatureCollection({
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [114, 23.7] }, properties: {} }],
    } as any)
    const pointColl = mock2.primitives.find((x) => x.kind === 'points')
    expect(pointColl?.items?.[0]?.color?.alpha).toBe(1)
  })

  /**
   * 选中态只改描边色、不铺整面填充（2D `setSelectionHighlight` 同口径）：
   * 填充 alpha 必须保持要素/默认的 100%，不能出现"选中后变半透明红"的那一层。
   */
  it('选中态只改描边色，填充仍是不透明的原填充', () => {
    layer.setSelectionIds(new Set(['f1']))
    layer.setFeatureCollection({ features: [polygonFeature(undefined)] } as any)
    const fill = fillColorOf(primitives)
    expect(fill.css).toBe('#10b981')
    expect(fill.alpha).toBe(1)
    expect(strokeColorOf(primitives).css).toBe('#ef4444')
  })

  it('KML <fill>0</fill>：视觉上只画边框，但保留一个近乎全透明的面图元用于点击命中', () => {
    layer.setFeatureCollection({
      features: [polygonFeature({ fill: false, strokeColor: '#000000' })],
    } as any)
    // 面图元仍在（否则点击多边形内部拾取不到，只能点中边框那几个像素），
    // 但 alpha 被压到 0.01 —— 肉眼看等于"只画边框"。
    const fill = primitives.find((x) => x.kind === 'ground-polygon')
    expect(fill).toBeTruthy()
    expect(fillColorOf(primitives).alpha).toBeLessThan(0.02)
    expect(primitives.find((x) => x.kind === 'ground-polyline')).toBeTruthy()
  })

  it('边框色为「无色」哨兵时不画边框', () => {
    layer.setFeatureCollection({
      features: [polygonFeature({ fillColor: '#abcdef', strokeColor: NO_FILL_COLOR })],
    } as any)
    expect(primitives.find((x) => x.kind === 'ground-polygon')).toBeTruthy()
    expect(primitives.find((x) => x.kind === 'ground-polyline')).toBeUndefined()
  })

  it('点要素：markerColor / markerSize 被还原', () => {
    layer.setFeatureCollection({
      features: [pointFeature({ markerColor: '#00aaff', markerSize: 12 })],
    } as any)
    const coll = primitives.find((x) => x.kind === 'points')
    expect(coll.items[0].color.css).toBe('#00aaff')
    expect(coll.items[0].pixelSize).toBe(12)
  })

  it('线要素：线色取 strokeColor，透明度取 strokeOpacity', () => {
    layer.setFeatureCollection({
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[114.0, 23.0], [114.01, 23.01]] },
        properties: { id: 'l1', _style: { strokeColor: '#ff00ff', strokeWidth: 4, strokeOpacity: 0.5 } },
      }],
    } as any)
    expect(strokeColorOf(primitives).css).toBe('#ff00ff')
    expect(strokeColorOf(primitives).alpha).toBeCloseTo(0.5)
    expect(strokeWidthOf(primitives)).toBe(4)
  })

  it('不可见图层不产生任何图元', () => {
    layer.applyConfig({ visible: false })
    layer.setFeatureCollection({ features: [polygonFeature({ fillColor: '#ff0000' })] } as any)
    expect(primitives).toHaveLength(0)
  })

  it('拾取标识挂在批量图元上（供点击弹属性框）', () => {
    layer.setFeatureCollection({ features: [polygonFeature(undefined)] } as any)
    const inst = primitives.find((x) => x.kind === 'ground-polygon').geometryInstances[0]
    expect(inst.id.layerId).toBe('layer-1')
    expect(inst.id.feature.properties.id).toBe('f1')
  })
})
