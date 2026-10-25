/**
 * 3D 相机瞬时跳转：把目标点放到屏幕中心。
 *
 * 相机倾斜（pitch ≠ -90°）时，`camera.setView({ destination: 目标点 })` 只是把相机
 * **位置**摆到目标点上空，视线仍沿俯仰角朝前看，目标会落到视窗下方甚至视窗外。
 * 屏幕中心的点必在视线上：目标 = 相机位置 + 视线方向 × 距离，
 * 因此相机位置 = 目标 - 视线方向 × 距离。
 *
 * 视线方向按**目标点的东-北-天局部坐标系**计算（heading/pitch 本就是相对该坐标系），
 * 跨城市远距离跳转时也不会因两地局部坐标系不同而偏出屏幕中心。
 *
 * `viewHeight` 是期望的相机对地高度：俯视时距离 = 高度（与旧的 setView 行为完全一致），
 * 倾斜时距离 = 高度 / sin(|pitch|)，相机高度保持不变、目标始终居中。
 */
export function jumpCameraToPoint(
  C: any, viewer: any, wlng: number, wlat: number, viewHeight: number,
): void {
  const camera = viewer.camera
  const { heading, pitch, roll } = camera
  // 下限防 pitch≈0（近似平视）时除零；正常倾斜视角不会触发
  const range = viewHeight / Math.max(Math.sin(Math.abs(pitch)), 1e-3)
  const target = C.Cartesian3.fromDegrees(wlng, wlat)
  const enu = C.Transforms.eastNorthUpToFixedFrame(target)
  // 视线方向（东、北、天）：heading 0 指北，pitch 为负表示向下看
  const cosPitch = Math.cos(pitch)
  const dirLocal = new C.Cartesian3(
    cosPitch * Math.sin(heading),
    cosPitch * Math.cos(heading),
    Math.sin(pitch),
  )
  const offsetLocal = C.Cartesian3.multiplyByScalar(dirLocal, -range, new C.Cartesian3())
  const destination = C.Matrix4.multiplyByPoint(enu, offsetLocal, new C.Cartesian3())
  camera.setView({ destination, orientation: { heading, pitch, roll } })
}
