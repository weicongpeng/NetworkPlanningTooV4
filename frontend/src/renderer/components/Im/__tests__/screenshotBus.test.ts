/** 截图抓屏前的 DOM 稳定化：标记不残留、按开关只隐藏会话浮窗、等两帧。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CAPTURE_FLAG, HIDE_IM_FLAG, SCREENSHOT_STABILIZE_EVENT,
  clearCaptureFlags, prepareScreenshotDom, setCaptureFlag,
  setHideImWindowFlag, waitForStableFrames,
} from '../screenshotBus'

describe('截图 DOM 稳定化', () => {
  beforeEach(() => {
    clearCaptureFlags()
  })

  afterEach(() => {
    clearCaptureFlags()
    vi.unstubAllGlobals()
  })

  it('关闭隐藏开关时两个标记都不存在，会话窗口保持屏幕原样', () => {
    setCaptureFlag(true)
    setHideImWindowFlag(true)
    const onStabilize = vi.fn()
    window.addEventListener(SCREENSHOT_STABILIZE_EVENT, onStabilize)

    prepareScreenshotDom(false)

    expect(onStabilize).toHaveBeenCalledTimes(1)
    expect(document.body.hasAttribute(CAPTURE_FLAG)).toBe(false)
    expect(document.body.hasAttribute(HIDE_IM_FLAG)).toBe(false)
    window.removeEventListener(SCREENSHOT_STABILIZE_EVENT, onStabilize)
  })

  it('开启隐藏开关时只设置 data-npt-hide-im', () => {
    prepareScreenshotDom(true)
    expect(document.body.hasAttribute(CAPTURE_FLAG)).toBe(false)
    expect(document.body.hasAttribute(HIDE_IM_FLAG)).toBe(true)
  })

  it('clearCaptureFlags 无条件清掉两个标记，避免会话窗口被永久隐藏', () => {
    setCaptureFlag(true)
    setHideImWindowFlag(true)
    clearCaptureFlags()
    expect(document.body.hasAttribute(CAPTURE_FLAG)).toBe(false)
    expect(document.body.hasAttribute(HIDE_IM_FLAG)).toBe(false)
  })

  it('waitForStableFrames 等过两个渲染帧才允许抓屏', async () => {
    let frames = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames += 1
      return window.setTimeout(() => cb(0), 0)
    })
    let resolved = false
    const promise = waitForStableFrames().then(() => { resolved = true })
    expect(resolved).toBe(false)
    await promise
    expect(frames).toBe(2)
    expect(resolved).toBe(true)
  })
})
