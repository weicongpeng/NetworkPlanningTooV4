/**
 * 覆盖层（标签 / 圈选框）跟随相机的探测函数。
 *
 * 背景（2026-10-14 用户报"3D 标签不跟随要素、错位"）：
 * 覆盖层重绘原先挂在 `camera.changed` 事件上，而该事件受 `camera.percentageChanged`
 * 阈值（当时为 0.25＝相机变化 25%）限制 —— 小幅平移/缩放根本不会触发，
 * 标签就停在旧的屏幕位置不动，看起来"不跟随要素、错位"。
 * 2D（Leaflet）的 `LabelLayoutManager` 是每个 `move` 帧都重绘，3D 必须等价。
 *
 * 做法：在 `scene.postRender`（本帧相机已就绪）里逐帧调用本探测函数，
 * 只要相机状态与上次不同就重绘。比较 `positionWC` / `directionWC` / `upWC`
 * （Cesium 每帧原地更新的公开属性，避免 `viewMatrix` getter 的 updateMembers 计算）
 * 加画布宽度（窗口 resize 改变视锥宽度、但相机自身不变，也要重绘）。
 */

/** 探测的状态槽位数：位置 ×3、朝向 ×3、上方向 ×3、画布宽 ×1 */
const PROBE_SLOTS = 10

export interface CameraProbeSource {
  positionWC: { x: number; y: number; z: number }
  directionWC: { x: number; y: number; z: number }
  upWC: { x: number; y: number; z: number }
}

/**
 * 创建一个带记忆的探测函数：返回 true 表示相机/画布自上次调用后变化过，
 * 并把当前状态记为最新（下一次比较以它为基准）。
 */
export function createCameraMoveProbe(): (
  camera: CameraProbeSource,
  canvasWidth: number,
) => boolean {
  const probe: number[] = new Array(PROBE_SLOTS).fill(NaN)
  return (camera, canvasWidth) => {
    let moved = false
    const write = (i: number, v: number) => {
      if (probe[i] !== v) { probe[i] = v; moved = true }
    }
    write(0, camera.positionWC.x)
    write(1, camera.positionWC.y)
    write(2, camera.positionWC.z)
    write(3, camera.directionWC.x)
    write(4, camera.directionWC.y)
    write(5, camera.directionWC.z)
    write(6, camera.upWC.x)
    write(7, camera.upWC.y)
    write(8, camera.upWC.z)
    write(9, canvasWidth)
    return moved
  }
}
