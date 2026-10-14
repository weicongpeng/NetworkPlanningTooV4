/**
 * 场景开关守卫：`scene.pickTranslucentDepth` 必须保持默认关闭。
 *
 * 为什么用源码扫描而不是行为测试：这个开关的代价发生在 Cesium 内部（相机控制器滚轮缩放
 * 每步都会走 `pickPositionWorldCoordinates` → `renderTranslucentDepthForPick` 旁路渲染），
 * 只有真实 GPU + 图元增删才会让它抛 `_target`（CesiumGS/cesium#12617，至今 open）。
 * 单元测试环境（jsdom）既没有 Cesium 也没有 WebGL，锁不住这个回归 —— 所以直接锁源码：
 * 允许在注释里解释它，但不允许把它置为 true。
 */
import { describe, expect, it } from 'vitest'
// Vite 的 ?raw 导入：拿到 CesiumMap 的源码文本（不需要 node 类型）
import cesiumMapSource from '../CesiumMap.tsx?raw'

describe('3D 场景开关守卫', () => {
  it('不得开启 scene.pickTranslucentDepth（缩放必崩 _target 的根因）', () => {
    // 允许 `scene.pickTranslucentDepth = false` 或只出现在注释里
    expect(/scene\.pickTranslucentDepth\s*=\s*true/.test(cesiumMapSource)).toBe(false)
    // 说明文字还在（防止有人顺手删掉注释后又把开关加回来）
    expect(cesiumMapSource).toContain('12617')
  })
})
