/**
 * Cesium 图元选项守卫。
 *
 * 为什么用源码扫描而不是行为测试：这些选项的后果只发生在 Cesium 内部的 GPU 渲染管线里
 * （分类体拉伸、测地线细分），单元测试环境（jsdom）既没有 Cesium 也没有 WebGL，
 * 锁不住行为 —— 所以直接锁源码：允许在注释里解释，但不允许把值退回去。
 */
import { describe, expect, it } from 'vitest'
// Vite 的 ?raw 导入：拿到源码文本（不需要 node 类型）
import cesiumMapSource from '../CesiumMap.tsx?raw'
import geoJsonLayerSource from '../CesiumGeoJsonLayer.ts?raw'

describe('3D 场景开关守卫', () => {
  it('不得开启 scene.pickTranslucentDepth（缩放必崩 _target 的根因）', () => {
    // 允许 `scene.pickTranslucentDepth = false` 或只出现在注释里
    expect(/scene\.pickTranslucentDepth\s*=\s*true/.test(cesiumMapSource)).toBe(false)
    // 说明文字还在（防止有人顺手删掉注释后又把开关加回来）
    expect(cesiumMapSource).toContain('12617')
  })
})

describe('3D 贴地多边形填充：必须只贴地形、且边走恒向线', () => {
  it('GroundPrimitive 必须限定 ClassificationType.TERRAIN（否则面会爬到 3D 建筑上）', () => {
    // 默认 BOTH 会把面涂到 OSM 建筑上，斜视下阴影看起来跑到图形外面
    expect(geoJsonLayerSource).toContain('classificationType: C.ClassificationType.TERRAIN')
    // 不能出现把它改回 BOTH 的写法
    expect(/classificationType:\s*C\.ClassificationType\.(BOTH|CESIUM_3D_TILE)/.test(geoJsonLayerSource)).toBe(false)
  })

  it('PolygonGeometry 必须用 ArcType.RHUMB（与 2D 墨卡托直线同口径）', () => {
    expect(geoJsonLayerSource).toContain('arcType: C.ArcType.RHUMB')
    // 默认 GEODESIC 会让大跨度边外鼓，填充与贴地描边对不上
    expect(/arcType:\s*C\.ArcType\.GEODESIC/.test(geoJsonLayerSource)).toBe(false)
  })
})
