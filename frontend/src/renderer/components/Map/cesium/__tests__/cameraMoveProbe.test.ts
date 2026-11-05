/**
 * 覆盖层"跟随相机"探测（2026-10-14 用户报"3D 标签不跟随要素移动、错位"的回归锁定）。
 *
 * 锁定点：探测必须识别**任意幅度**的相机变化 —— 早先重绘挂在 `camera.changed` 事件上，
 * 它受 `camera.percentageChanged`（0.25 = 25%）阈值限制，小幅平移/缩放不触发重绘，
 * 标签就停在旧屏幕位置不动、看起来与要素错位。
 */
import { describe, expect, it } from 'vitest'
import { createCameraMoveProbe } from '../cesiumCameraProbe'

function camera(px = 0, py = 0, pz = 0, dx = 1, dy = 0, dz = 0, ux = 0, uy = 0, uz = 1) {
  return {
    positionWC: { x: px, y: py, z: pz },
    directionWC: { x: dx, y: dy, z: dz },
    upWC: { x: ux, y: uy, z: uz },
  }
}

describe('createCameraMoveProbe', () => {
  it('首帧即视为"变化过"（需要首绘）', () => {
    const probe = createCameraMoveProbe()
    expect(probe(camera(), 800)).toBe(true)
  })

  it('相机静止时返回 false（不做无谓重绘）', () => {
    const probe = createCameraMoveProbe()
    const cam = camera()
    probe(cam, 800)
    expect(probe(cam, 800)).toBe(false)
    expect(probe(cam, 800)).toBe(false)
  })

  it('极小幅度平移也必须识别（这正是 percentageChanged 阈值漏掉的情形）', () => {
    const probe = createCameraMoveProbe()
    probe(camera(0, 0, 0), 800)
    // 0.5 米 —— 远小于 camera.percentageChanged=0.25 的触发阈值
    expect(probe(camera(0.5, 0, 0), 800)).toBe(true)
  })

  it('朝向 / 上方向变化（旋转、俯仰）必须识别', () => {
    const probe = createCameraMoveProbe()
    probe(camera(), 800)
    expect(probe(camera(0, 0, 0, 0.999, 0.01, 0), 800)).toBe(true)

    const probe2 = createCameraMoveProbe()
    probe2(camera(), 800)
    expect(probe2(camera(0, 0, 0, 1, 0, 0, 0, 0.02, 0.9998), 800)).toBe(true)
  })

  it('画布宽度变化（窗口 resize）视为需要重绘', () => {
    const probe = createCameraMoveProbe()
    probe(camera(), 800)
    expect(probe(camera(), 1024)).toBe(true)
  })

  it('识别过变化后状态被记住：紧接着的相同状态返回 false', () => {
    const probe = createCameraMoveProbe()
    probe(camera(), 800)
    expect(probe(camera(0.5, 0, 0), 800)).toBe(true)
    expect(probe(camera(0.5, 0, 0), 800)).toBe(false)
  })
})
