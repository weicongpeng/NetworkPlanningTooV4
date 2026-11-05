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
import sectorLayerSource from '../CesiumSectorLayer.ts?raw'

describe('3D 场景开关守卫', () => {
  it('不得开启 scene.pickTranslucentDepth（缩放必崩 _target 的根因）', () => {
    // 允许 `scene.pickTranslucentDepth = false` 或只出现在注释里
    expect(/scene\.pickTranslucentDepth\s*=\s*true/.test(cesiumMapSource)).toBe(false)
    // 说明文字还在（防止有人顺手删掉注释后又把开关加回来）
    expect(cesiumMapSource).toContain('12617')
  })

  it('贴地图元不得异步构建（worker 就绪前新旧两批同时渲染会闪）', () => {
    expect(sectorLayerSource).not.toContain('asynchronous: true')
    expect(geoJsonLayerSource).not.toContain('asynchronous: true')
  })
})

describe('3D 场景效果瘦身（性能优化）', () => {
  /**
   * 这些是逐像素/逐帧的全屏 shader 开销，而本工具视角是城市级、2D 侧也没有对应效果，
   * 关闭后与 2D 观感拉齐。锁源码防止有人"觉得好看"又开回来。
   */
  it('关闭太阳光照 / 大气 / 天空 / 雾 / 日月 billboard', () => {
    expect(cesiumMapSource).toContain('viewer.scene.globe.enableLighting = false')
    expect(cesiumMapSource).toContain('viewer.scene.skyAtmosphere.show = false')
    expect(cesiumMapSource).toContain('viewer.scene.globe.showGroundAtmosphere = false')
    expect(cesiumMapSource).toContain('viewer.scene.fog.enabled = false')
    expect(cesiumMapSource).toContain('viewer.scene.sun.show = false')
    expect(cesiumMapSource).toContain('viewer.scene.moon.show = false')
  })

  /**
   * 交互期降渲染分辨率（pan/zoom 时像素量降到约 56%，停下恢复）。
   * 恢复必须发生在相机停下的防抖回调里 —— 少了这一步就会一直糊着。
   */
  it('交互中压低 resolutionScale，停下后恢复清晰度基准', () => {
    expect(cesiumMapSource).toContain('INTERACTION_RESOLUTION_SCALE')
    // 交互开始：按基准比例缩放（桌面端 base=DPR，不能写死 0.75）
    expect(cesiumMapSource).toContain(
      'baseResolutionScaleRef.current * INTERACTION_RESOLUTION_SCALE')
    // 相机停下（防抖回调）：恢复清晰度基准
    expect(cesiumMapSource).toContain('viewer.resolutionScale = baseResolutionScaleRef.current')
    // 清晰度档位 effect：把基准记进 ref（交互恢复时要用）
    expect(cesiumMapSource).toContain('baseResolutionScaleRef.current = base')
  })

  /**
   * 桌面端 WebView2 的滚轮/触控板手势偶发不发 camera.moveEnd，交互降载会一直卡住
   * （resolutionScale=0.75 + SSE=4 → 永远发虚、瓦片层级低）。必须有相机静止的兜底恢复。
   */
  it('交互降载要有相机静止兜底（不能只依赖 moveEnd）', () => {
    expect(cesiumMapSource).toContain('lastCameraActivityAt')
    expect(cesiumMapSource).toContain('Date.now() - lastCameraActivityAt > 320')
  })

  /**
   * 视口裁剪：宿主必须在相机停下 / syncAll 时把视野推给 GeoJSON 图层，
   * 否则大图层永远不会裁剪。
   */
  it('相机停下与 syncAll 都把视野推给 GeoJSON 图层（setView）', () => {
    const setViewCalls = cesiumMapSource.match(/\.setView\(/g)
    expect(setViewCalls?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  /**
   * 3D 底图清晰度：zoom >= 15 必须把 globe SSE 收紧到 1，否则 Cesium 永远铺低一层瓦片
   * （zoom 15 用 z14 影像），用户必须放大到 16/17 才觉得清楚。
   */
  it('zoom >= 15 收紧 globe 屏幕空间误差（底图瓦片层级与 2D 对齐）', () => {
    expect(cesiumMapSource).toContain('cesiumGlobeSse(')
    expect(cesiumMapSource).toContain('viewer.scene.globe.maximumScreenSpaceError =')
    // 桌面端 WebView2 需要再多一级瓦片超采样（SSE 0.5），网页端保持 1
    expect(cesiumMapSource).toContain('DESKTOP_BASEMAP_SSE')
    expect(cesiumMapSource).toContain('basemapSseFloor()')
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
