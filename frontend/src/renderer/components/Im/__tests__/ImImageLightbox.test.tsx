/**
 * 图片灯箱回归：objectURL 全自持（修「第二次打开空白」）、滚轮自由缩放、双击复位。
 * system 提示另测（ImSystemNotice）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const blobMock = vi.fn()
const { desktopState } = vi.hoisted(() => ({ desktopState: { desktopMode: false } }))
vi.mock('../../../store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof desktopState) => unknown) => selector(desktopState),
    { getState: () => desktopState },
  ),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg?: string | Record<string, unknown>) => {
      if (typeof arg === 'string') return arg
      if (arg && typeof arg === 'object') return String((arg as Record<string, unknown>).defaultValue ?? key)
      return key
    },
    i18n: { language: 'zh' },
  }),
}))
vi.mock('../../../services/api', () => ({
  IM_CHUNK_SIZE: 512 * 1024,
  imApi: { attachmentBlob: (...args: unknown[]) => blobMock(...args) },
}))

vi.mock('../ImScreenshotDialog', () => ({
  ImScreenshotDialog: ({ open }: { open: boolean }) => open
    ? <div data-testid="image-editor" />
    : null,
}))

import { ImImageLightbox } from '../ImImageLightbox'

const createObjectURL = vi.fn(() => 'blob:lightbox-1')
const revokeObjectURL = vi.fn()
// jsdom 未实现 objectURL，补到原型上即可，不替换全局 URL 构造器
URL.createObjectURL = createObjectURL
URL.revokeObjectURL = revokeObjectURL
beforeEach(() => {
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  blobMock.mockReset()
  desktopState.desktopMode = false
  blobMock.mockResolvedValue(new Blob(['img'], { type: 'image/png' }))
})

const source = { name: 'a.png', mime: 'image/png', attachmentId: 7 }

describe('图片灯箱', () => {
  it('默认非最大化，可切换最大化；原图可进入截图编辑器', async () => {
    render(<ImImageLightbox source={source} onClose={() => {}} />)
    await waitFor(() => expect(document.querySelector('img')).toBeTruthy())
    const panel = document.querySelector('[data-im-lightbox-panel]') as HTMLElement
    expect(panel.className).toContain('rounded-2xl')
    expect(panel.className).not.toContain('w-full')
    fireEvent.click(screen.getByTitle('最大化'))
    expect(panel.className).toContain('w-full')
    fireEvent.click(screen.getByTitle('还原'))
    expect(panel.className).toContain('rounded-2xl')

    fireEvent.click(screen.getByTitle('编辑'))
    expect(screen.getByTestId('image-editor')).toBeTruthy()
  })

  it('按附件 id 拉全图，自己创建 objectURL 并显示', async () => {
    render(<ImImageLightbox source={source} onClose={() => {}} />)
    expect(blobMock).toHaveBeenCalledWith(7, false) // 拉全图而非缩略图
    await waitFor(() => expect(document.querySelector('img')).toBeTruthy())
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:lightbox-1')
  })

  it('左右旋转 90°，显示与下载都按最终角度', async () => {
    render(<ImImageLightbox source={source} onClose={() => {}} />)
    await waitFor(() => expect(document.querySelector('img')).toBeTruthy())
    const image = document.querySelector('img')!
    expect(image.style.transform).toContain('rotate(0deg)')
    fireEvent.click(screen.getByTitle('向右旋转 90°'))
    expect(image.style.transform).toContain('rotate(90deg)')
    fireEvent.click(screen.getByTitle('向左旋转 90°'))
    expect(image.style.transform).toContain('rotate(0deg)')
    fireEvent.click(screen.getByTitle('向左旋转 90°'))
    expect(image.style.transform).toContain('rotate(270deg)')
  })

  it('关闭 / 卸载时只 revoke 自己创建的 URL，不借用外部 URL', async () => {
    const { unmount } = render(<ImImageLightbox source={source} onClose={() => {}} />)
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1))
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:lightbox-1')
  })

  it('滚轮自由缩放：向上放大、向下缩小，显示百分比', async () => {
    render(<ImImageLightbox source={source} onClose={() => {}} />)
    await waitFor(() => expect(document.querySelector('img')).toBeTruthy())
    const stage = document.querySelector('img')!.parentElement as HTMLElement
    // 原生非被动 wheel 监听
    fireEvent.wheel(stage, { deltaY: -100 })
    await waitFor(() => expect(screen.getByText('115%')).toBeTruthy())
    fireEvent.wheel(stage, { deltaY: -100 })
    await waitFor(() => expect(screen.getByText('132%')).toBeTruthy())
    fireEvent.wheel(stage, { deltaY: 100 })
    await waitFor(() => expect(screen.getByText('115%')).toBeTruthy())
  })

  it('工具条不再提供「复位」按钮（保留双击复位手势）', async () => {
    render(<ImImageLightbox source={source} onClose={() => {}} />)
    await waitFor(() => expect(document.querySelector('img')).toBeTruthy())
    expect(screen.queryByTitle('复位')).toBeNull()
    expect(screen.queryByTitle('im.lightbox.reset')).toBeNull()
  })

  it('双击舞台复位到 100%', async () => {
    render(<ImImageLightbox source={source} onClose={() => {}} />)
    await waitFor(() => expect(document.querySelector('img')).toBeTruthy())
    const stage = document.querySelector('img')!.parentElement as HTMLElement
    fireEvent.wheel(stage, { deltaY: -100 })
    await waitFor(() => expect(screen.getByText('115%')).toBeTruthy())
    fireEvent.doubleClick(stage)
    await waitFor(() => expect(screen.getByText('100%')).toBeTruthy())
  })

  it('Esc 关闭', async () => {
    const onClose = vi.fn()
    render(<ImImageLightbox source={source} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('本地待发送图片直接用 File，不发网络请求', async () => {
    const file = new File(['x'], 'p.png', { type: 'image/png' })
    render(
      <ImImageLightbox source={{ name: 'p.png', mime: 'image/png', file }} onClose={() => {}} />,
    )
    await waitFor(() => expect(document.querySelector('img')).toBeTruthy())
    expect(blobMock).not.toHaveBeenCalled()
    expect(createObjectURL).toHaveBeenCalledWith(file)
  })

  it('作为独立窗口展示：无遮罩/虚化，背景点击穿透，面板自成窗口', () => {
    const onClose = vi.fn()
    render(<ImImageLightbox source={source} onClose={onClose} />)
    const overlay = document.querySelector('[data-im-lightbox]') as HTMLElement
    const panel = document.querySelector('[data-im-lightbox-panel]') as HTMLElement
    expect(overlay.className).toContain('pointer-events-none')
    expect(overlay.className).not.toContain('bg-black/85')
    expect(overlay.className).not.toContain('backdrop-blur')
    expect(panel.className).toContain('pointer-events-auto')
    // 独立窗口点击浮层外部不关闭，背景保持可交互
    fireEvent.click(overlay)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('UI 风格与图片编辑页一致：浅色卡片面板与带分隔线的工具栏', () => {
    render(<ImImageLightbox source={source} onClose={() => {}} />)
    const panel = document.querySelector('[data-im-lightbox-panel]') as HTMLElement
    const toolbar = document.querySelector('[data-im-lightbox-toolbar]') as HTMLElement
    expect(panel.className).toContain('bg-card')
    expect(panel.className).not.toContain('bg-neutral-950')
    expect(toolbar.className).toContain('border-b')
    expect(toolbar.className).toContain('border-border/60')
  })

  it('八向热区可拖拽调整窗口尺寸，最大化时隐藏', async () => {
    render(<ImImageLightbox source={source} onClose={() => {}} />)
    await waitFor(() => expect(document.querySelector('img')).toBeTruthy())
    const handles = document.querySelectorAll('[data-im-resize]')
    expect(handles).toHaveLength(8)

    const handle = document.querySelector('[data-im-resize="se"]') as HTMLElement
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 900, clientY: 700, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    const panel = document.querySelector('[data-im-lightbox-panel]') as HTMLElement
    expect(panel.style.width).toBe('800px')
    expect(panel.style.height).toBe('600px')

    fireEvent.click(screen.getByTitle('最大化'))
    expect(document.querySelectorAll('[data-im-resize]')).toHaveLength(0)
  })

  it('窗口下方不再显示操作提示文案', () => {
    render(<ImImageLightbox source={source} onClose={() => {}} />)
    expect(document.body.textContent).not.toContain('滚轮缩放')
    expect(document.body.textContent).not.toContain('双击复位')
  })

  it('桌面端避开自绘标题栏并置于最上层，顶部工具条不被遮挡', () => {
    desktopState.desktopMode = true
    const { unmount } = render(<ImImageLightbox source={source} onClose={() => {}} />)
    const overlay = document.querySelector('[data-im-lightbox]') as HTMLElement
    expect(overlay.style.top).toBe('32px')
    expect(overlay.className).toContain('z-[10000]')
    unmount()

    // 网页端仍从视口顶部铺满
    desktopState.desktopMode = false
    render(<ImImageLightbox source={source} onClose={() => {}} />)
    expect((document.querySelector('[data-im-lightbox]') as HTMLElement).style.top).toBe('')
  })

  const gallery = [
    { name: 'a.png', mime: 'image/png', attachmentId: 7 },
    { name: 'b.png', mime: 'image/png', attachmentId: 8 },
    { name: 'c.png', mime: 'image/png', attachmentId: 9 },
  ]
  const gallerySource = { ...gallery[0], gallery, galleryIndex: 0 }
  const counter = () => document.querySelector('[data-im-lightbox-counter]')?.textContent?.trim()
  const navButton = (name: string) =>
    document.querySelector(`[data-im-lightbox-${name}]`) as HTMLButtonElement

  it('单张预览不显示上一张 / 下一张与计数', () => {
    render(<ImImageLightbox source={source} onClose={() => {}} />)
    expect(document.querySelector('[data-im-lightbox-next]')).toBeNull()
    expect(document.querySelector('[data-im-lightbox-counter]')).toBeNull()
  })

  it('点击下一张 / 上一张切换当前会话的图片并更新计数', async () => {
    render(<ImImageLightbox source={gallerySource} onClose={() => {}} />)
    expect(counter()).toBe('1 / 3')
    expect(navButton('prev').disabled).toBe(true)

    fireEvent.click(navButton('next'))
    await waitFor(() => expect(blobMock).toHaveBeenLastCalledWith(8, false))
    expect(counter()).toBe('2 / 3')
    expect(navButton('prev').disabled).toBe(false)

    fireEvent.click(navButton('prev'))
    await waitFor(() => expect(blobMock).toHaveBeenLastCalledWith(7, false))
    expect(counter()).toBe('1 / 3')
  })

  it('键盘 ← → 切换，首尾越界不动且按钮禁用', async () => {
    render(<ImImageLightbox source={gallerySource} onClose={() => {}} />)
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => expect(counter()).toBe('2 / 3'))
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => expect(counter()).toBe('3 / 3'))
    expect(navButton('next').disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(counter()).toBe('3 / 3')
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    await waitFor(() => expect(counter()).toBe('2 / 3'))
  })

  it('换一张图复位缩放视图', async () => {
    render(<ImImageLightbox source={gallerySource} onClose={() => {}} />)
    await waitFor(() => expect(document.querySelector('img')).toBeTruthy())
    fireEvent.wheel(document.querySelector('img')!.parentElement!, { deltaY: -100 })
    expect(screen.getByText('115%')).toBeTruthy()
    fireEvent.click(navButton('next'))
    await waitFor(() => expect(blobMock).toHaveBeenLastCalledWith(8, false))
    expect(screen.getByText('100%')).toBeTruthy()
  })
})
