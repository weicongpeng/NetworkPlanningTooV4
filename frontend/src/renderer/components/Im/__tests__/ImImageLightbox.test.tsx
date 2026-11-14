/**
 * 图片灯箱回归：objectURL 全自持（修「第二次打开空白」）、滚轮自由缩放、双击复位。
 * system 提示另测（ImSystemNotice）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const blobMock = vi.fn()
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
  blobMock.mockResolvedValue(new Blob(['img'], { type: 'image/png' }))
})

const source = { name: 'a.png', mime: 'image/png', attachmentId: 7 }

describe('图片灯箱', () => {
  it('按附件 id 拉全图，自己创建 objectURL 并显示', async () => {
    render(<ImImageLightbox source={source} onClose={() => {}} />)
    expect(blobMock).toHaveBeenCalledWith(7, false) // 拉全图而非缩略图
    await waitFor(() => expect(document.querySelector('img')).toBeTruthy())
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:lightbox-1')
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
})
