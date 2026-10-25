/**
 * 3D 搜索定位瞬时跳转：目标点必须落在屏幕中心。
 *
 * 历史问题：倾斜视角下 `setView({ destination: 目标点 })` 只是把相机摆到目标点上空，
 * 视线朝前看，目标落到视窗下方甚至视窗外；2D/俯视时因相机正对目标才看起来正常。
 * 这里锁住：相机位置按目标点局部坐标系沿视线反推，目标点始终在相机视线上（即屏幕中心）。
 */
import { describe, it, expect, vi } from 'vitest'
import { jumpCameraToPoint } from '../cesiumCameraJump'

function makeCesiumMock() {
  class Cartesian3 {
    x: number; y: number; z: number
    constructor(x = 0, y = 0, z = 0) {
      this.x = x; this.y = y; this.z = z
    }
  }
  const C: any = {
    Cartesian3: Object.assign(Cartesian3, {
      fromDegrees: (lng: number, lat: number, height = 0) => new Cartesian3(lng, lat, height),
      multiplyByScalar: (v: any, s: number, out: any) => {
        out.x = v.x * s; out.y = v.y * s; out.z = v.z * s
        return out
      },
    }),
    // 测试里把目标点局部 ENU 当作与世界轴对齐的平移：east→x，north→y，up→z
    Transforms: {
      eastNorthUpToFixedFrame: (target: any) => ({ origin: target }),
    },
    Matrix4: {
      multiplyByPoint: (m: any, p: any, out: any) => {
        out.x = m.origin.x + p.x
        out.y = m.origin.y + p.y
        out.z = m.origin.z + p.z
        return out
      },
    },
  }
  return C
}

function makeViewer(pitch: number, roll = 0) {
  const setView = vi.fn()
  const camera: any = { heading: 0, pitch, roll, setView }
  return { viewer: { camera }, camera }
}

describe('jumpCameraToPoint：跳转后目标位于屏幕中心', () => {
  it('俯视（pitch=-90°）与旧行为一致：相机在目标正上方，高度=viewHeight', () => {
    const C = makeCesiumMock()
    const { viewer, camera } = makeViewer(-Math.PI / 2)
    jumpCameraToPoint(C, viewer, 114.7, 23.7, 1000)

    expect(camera.setView).toHaveBeenCalledTimes(1)
    const { destination, orientation } = camera.setView.mock.calls[0][0]
    expect(destination.x).toBeCloseTo(114.7, 9)
    expect(destination.y).toBeCloseTo(23.7, 9)
    expect(destination.z).toBeCloseTo(1000, 9)
    expect(orientation).toEqual({ heading: 0, pitch: -Math.PI / 2, roll: 0 })
  })

  it('倾斜 45°：相机沿视线反推，相机高度不变且目标在视线上', () => {
    const C = makeCesiumMock()
    const pitch = -Math.PI / 4
    const { viewer, camera } = makeViewer(pitch)
    jumpCameraToPoint(C, viewer, 114.7, 23.7, 1000)

    const { destination, orientation } = camera.setView.mock.calls[0][0]
    // 距离 = 高度 / sin(45°) = 1414.2 → 相机在目标正南 1000、等高 1000
    expect(destination.x).toBeCloseTo(114.7, 6)
    expect(destination.y).toBeCloseTo(23.7 - 1000, 6)
    expect(destination.z).toBeCloseTo(1000, 6)
    // 目标 - 相机位置 与视线方向同向（⇒ 目标在屏幕中心）
    const toTarget = { x: 114.7 - destination.x, y: 23.7 - destination.y, z: 0 - destination.z }
    const range = Math.hypot(toTarget.x, toTarget.y, toTarget.z)
    expect(toTarget.y / range).toBeCloseTo(Math.SQRT1_2, 9)
    expect(toTarget.z / range).toBeCloseTo(-Math.SQRT1_2, 9)
    // 沿用当前俯仰/朝向，不重置视角
    expect(orientation).toEqual({ heading: 0, pitch, roll: 0 })
  })

  it('保留当前 roll（不重置相机姿态）', () => {
    const C = makeCesiumMock()
    const { viewer, camera } = makeViewer(-Math.PI / 3, 0.2)
    jumpCameraToPoint(C, viewer, 114.7, 23.7, 500)
    expect(camera.setView.mock.calls[0][0].orientation.roll).toBe(0.2)
  })
})
