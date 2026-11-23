/** 冒泡提示只在前台且未被遮挡时累计停留时间。 */
import { describe, expect, it, vi } from 'vitest'
import {
  isGuideAnchorUnobstructed,
  isGuideSurfaceActive,
} from '../GuideTipsHost'

describe('GuideTipsHost 前台与遮挡判定', () => {
  it('页面可见且窗口有焦点时才激活', () => {
    expect(isGuideSurfaceActive('visible', true)).toBe(true)
    expect(isGuideSurfaceActive('hidden', true)).toBe(false)
    expect(isGuideSurfaceActive('visible', false)).toBe(false)
  })

  it('锚点自身、子元素或 pointer-events:none 时的父容器都不算遮挡', () => {
    const wrapper = document.createElement('div')
    const anchor = document.createElement('span')
    const label = document.createElement('span')
    anchor.appendChild(label)
    wrapper.appendChild(anchor)
    document.body.appendChild(wrapper)

    const rect = { left: 100, top: 100, width: 40, height: 20 }
    expect(isGuideAnchorUnobstructed(anchor, rect, () => anchor)).toBe(true)
    expect(isGuideAnchorUnobstructed(anchor, rect, () => label)).toBe(true)

    anchor.style.pointerEvents = 'none'
    expect(isGuideAnchorUnobstructed(anchor, rect, () => wrapper)).toBe(true)
  })

  it('可交互锚点被祖先层挡住时仍视为遮挡', () => {
    const wrapper = document.createElement('div')
    const anchor = document.createElement('button')
    wrapper.appendChild(anchor)
    document.body.appendChild(wrapper)
    const rect = { left: 100, top: 100, width: 40, height: 20 }

    expect(isGuideAnchorUnobstructed(anchor, rect, () => wrapper)).toBe(false)
  })

  it('锚点被弹窗/遮罩覆盖时不激活', () => {
    const anchor = document.createElement('button')
    const overlay = document.createElement('div')
    document.body.append(anchor, overlay)

    const rect = { left: 100, top: 100, width: 40, height: 20 }
    expect(isGuideAnchorUnobstructed(anchor, rect, () => overlay)).toBe(false)
    expect(isGuideAnchorUnobstructed(anchor, rect, () => null)).toBe(false)
  })

  it('锚点中心移出视口时不激活', () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const resolve = vi.fn(() => anchor)

    expect(isGuideAnchorUnobstructed(
      anchor,
      { left: -500, top: 100, width: 40, height: 20 },
      resolve,
    )).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
  })
})
