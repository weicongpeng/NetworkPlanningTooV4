/**
 * WindowTitleBar：桌面端（frameless 窗口）自绘标题栏。
 *
 * 回归点：
 * - 仅 desktopMode 渲染；网页端（desktopMode=false）不出现（悬浮图标仍在 MainLayout）
 * - 「应用下载」入口从悬浮图标迁入：点击打开 AppDownloadDialog（功能不变）
 * - 最小化 / 最大化(还原) / 关闭 → POST /desktop/window-control 对应动作；
 *   toggle-maximize 响应带回 maximized 时同步按钮图标与 title
 * - 单击标题区不还原最大化窗口；按住并移动超过阈值才交给壳层拖窗
 * - 双击标题区 = 最大化/还原
 * - 非最大化时四边四角共八条缩放热区，按下即发 window-control resize-edge
 * - 窗口聚焦校准：mount 时 GET /desktop/window-state，用缓存修正按钮状态
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from '../../i18n'
import { useAuthStore } from '../../store/authStore'

vi.mock('../../services/api', () => ({
  desktopLoginApi: {
    windowControl: vi.fn(),
    windowState: vi.fn(),
  },
  appVersionsApi: { getLatest: vi.fn() },
  desktopCloudApi: { appVersion: vi.fn() },
  desktopReleasesApi: { latestPublic: vi.fn() },
  desktopUpdateApi: { status: vi.fn() },
}))

import { WindowTitleBar } from '../WindowTitleBar'
import { desktopCloudApi, desktopLoginApi } from '../../services/api'

describe('WindowTitleBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(desktopLoginApi.windowControl).mockResolvedValue({ success: true, data: {} } as any)
    vi.mocked(desktopLoginApi.windowState).mockResolvedValue({
      success: true,
      data: { maximized: true, fullscreen: false },
    } as any)
    // 下载弹窗打开即加载版本信息：桌面端取服务器最新 APK 版本
    vi.mocked(desktopCloudApi.appVersion).mockResolvedValue({ success: false } as any)
  })
  afterEach(() => {
    cleanup()
    useAuthStore.setState({ desktopMode: false })
  })

  it('网页端（非桌面形态）完全不渲染', () => {
    useAuthStore.setState({ desktopMode: false })
    const { container } = render(<WindowTitleBar />)
    expect(container.firstChild).toBeNull()
  })

  it('桌面端渲染四个按钮：下载 | 最小化 | 还原（启动即最大化）| 关闭', async () => {
    useAuthStore.setState({ desktopMode: true })
    render(<WindowTitleBar />)

    expect(screen.getByTitle(i18n.t('app.downloadTitle'))).toBeTruthy()
    expect(screen.getByTitle(i18n.t('titleBar.minimize'))).toBeTruthy()
    expect(screen.getByTitle(i18n.t('titleBar.restore'))).toBeTruthy()
    expect(screen.getByTitle(i18n.t('titleBar.close'))).toBeTruthy()
    await waitFor(() => expect(desktopLoginApi.windowState).toHaveBeenCalled())
  })

  it('按钮动作转发 window-control；toggle-maximize 响应回写图标状态', async () => {
    useAuthStore.setState({ desktopMode: true })
    render(<WindowTitleBar />)

    fireEvent.click(screen.getByTitle(i18n.t('titleBar.minimize')))
    await waitFor(() => expect(desktopLoginApi.windowControl).toHaveBeenCalledWith('minimize'))

    // 还原：壳层返回 maximized=false → 按钮 title 切换为「最大化」
    vi.mocked(desktopLoginApi.windowControl).mockResolvedValueOnce({
      success: true,
      data: { maximized: false },
    } as any)
    fireEvent.click(screen.getByTitle(i18n.t('titleBar.restore')))
    expect(await screen.findByTitle(i18n.t('titleBar.maximize'))).toBeTruthy()

    // 关闭
    fireEvent.click(screen.getByTitle(i18n.t('titleBar.close')))
    await waitFor(() =>
      expect(desktopLoginApi.windowControl).toHaveBeenCalledWith('close')
    )
  })

  it('非最大化时四边四角都有缩放热区，按下即交给壳层原生缩放', async () => {
    useAuthStore.setState({ desktopMode: true })
    vi.mocked(desktopLoginApi.windowState).mockResolvedValue({
      success: true,
      data: { maximized: false, fullscreen: false },
    } as any)
    const { container } = render(<WindowTitleBar />)

    await waitFor(() =>
      expect(container.querySelectorAll('[data-resize-dir]')).toHaveLength(8)
    )
    const dirs = Array.from(container.querySelectorAll('[data-resize-dir]')).map((el) =>
      el.getAttribute('data-resize-dir')
    )
    expect(dirs.sort()).toEqual(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w'])

    // 左边框：早些时候只有右/下两条边能拉，这里锁定"任意边/角都行"
    fireEvent.pointerDown(container.querySelector('[data-resize-dir="w"]') as HTMLElement)
    await waitFor(() =>
      expect(desktopLoginApi.windowControl).toHaveBeenCalledWith('resize-edge', { direction: 'w' })
    )
  })

  it('最大化时隐藏缩放热区', async () => {
    useAuthStore.setState({ desktopMode: true })
    const { container } = render(<WindowTitleBar />)
    await waitFor(() => expect(desktopLoginApi.windowState).toHaveBeenCalled())
    expect(container.querySelector('[data-resize-dir]')).toBeNull()
  })

  it('单击标题区不触发拖窗（最大化窗口不得因单击被还原）', async () => {
    useAuthStore.setState({ desktopMode: true })
    const { container } = render(<WindowTitleBar />)

    const dragRegion = container.querySelector('[data-titlebar-drag]') as HTMLElement
    fireEvent.mouseDown(dragRegion, { button: 0, clientX: 100, clientY: 10 })
    fireEvent.mouseUp(window)
    // 给潜在的错误请求留出一个微任务窗口
    await Promise.resolve()
    expect(desktopLoginApi.windowControl).not.toHaveBeenCalledWith('drag')
  })

  it('按住标题区并移动超过阈值 = 交给壳层走原生拖窗（贴边分屏的前提）', async () => {
    useAuthStore.setState({ desktopMode: true })
    const { container } = render(<WindowTitleBar />)

    const dragRegion = container.querySelector('[data-titlebar-drag]') as HTMLElement
    fireEvent.mouseDown(dragRegion, { button: 0, clientX: 100, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 100 + 8, clientY: 10 })
    await waitFor(() => expect(desktopLoginApi.windowControl).toHaveBeenCalledWith('drag'))
  })

  it('标题区双击 = 最大化/还原（原生移动循环会吃掉 dblclick，需自己判定）', async () => {
    useAuthStore.setState({ desktopMode: true })
    const { container } = render(<WindowTitleBar />)
    const dragRegion = container.querySelector('[data-titlebar-drag]') as HTMLElement

    fireEvent.mouseDown(dragRegion, { button: 0 })
    fireEvent.mouseDown(dragRegion, { button: 0 })
    await waitFor(() => expect(desktopLoginApi.windowControl).toHaveBeenCalledWith('toggle-maximize'))
  })

  it('点击「下载」按钮打开应用下载弹窗（原悬浮图标功能迁入）', async () => {
    useAuthStore.setState({ desktopMode: true })
    vi.mocked(desktopLoginApi.windowState).mockResolvedValue({
      success: true,
      data: { maximized: true, fullscreen: false },
    } as any)
    render(<WindowTitleBar />)

    fireEvent.click(screen.getByTitle(i18n.t('app.downloadTitle')))
    // 弹窗头部标题出现（h2 文本，区别于按钮 title 属性）
    expect(await screen.findByText(i18n.t('app.downloadTitle'))).toBeTruthy()
  })
})
