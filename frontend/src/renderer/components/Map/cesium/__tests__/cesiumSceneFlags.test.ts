/**
 * Cesium 图元选项守卫。
 *
 * 为什么用源码扫描而不是行为测试：这些选项的后果只发生在 Cesium 内部的 GPU 渲染管线里
 * （分类体拉伸、测地线细分），单元测试环境（jsdom）既没有 Cesium 也没有 WebGL，
 * 锁不住行为 —— 所以直接锁源码：允许在注释里解释，但不允许把值改回去。
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

describe('3D 贴地多边形：选中态不得加整面填充', () => {
  it('选中只改描边（与 2D setSelectionHighlight 同口径），不得出现选中填充色', () => {
    // 选中态用描边色常量
    expect(geoJsonLayerSource).toContain('SELECTED_STROKE_COLOR')
    // 不得再引入"整面铺半透明红"的选中填充：贴地分类渲染会把它拖到建筑上（超出）
    // 或被建筑/地形挡出缺口（空洞），用户已明确要求去掉
    expect(geoJsonLayerSource).not.toContain('SELECTED_FILL_COLOR')
    expect(geoJsonLayerSource).not.toContain('SELECTED_FILL_OPACITY')
  })
})
