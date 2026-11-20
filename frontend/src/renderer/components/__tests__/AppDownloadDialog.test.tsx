/**
 * AppDownloadDialog：「移动 APP 下载」/「桌面端更新」两栏。
 *
 * 回归点：
 * - 桌面端形态下**两栏都渲染**（早先桌面端直接隐藏了电脑端栏，用户无从查更新）
 * - 桌面端栏读本机 OTA 状态，展示当前版本；有更新时给「立即更新」，
 *   点击把状态交给全局 DesktopUpdateDialog 并关闭本弹窗（不维护第二套更新 UI）
 * - 无更新时显示「已是最新版本」
 * - 网页端形态仍走桌面安装包下载（不碰本机 OTA 接口）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from '../../i18n'
import { useAuthStore } from '../../store/authStore'
import { useDesktopUpdateStore } from '../../store/desktopUpdateStore'

vi.mock('../../services/api', () => ({
  appVersionsApi: { getLatest: vi.fn() },
  desktopCloudApi: { appVersion: vi.fn() },
  desktopReleasesApi: { latestPublic: vi.fn() },
  desktopUpdateApi: { status: vi.fn() },
}))

import { AppDownloadDialog } from '../AppDownloadDialog'
import { appVersionsApi, desktopCloudApi, desktopReleasesApi, desktopUpdateApi } from '../../services/api'

const STATUS_WITH_UPDATE = {
  current: '0.0.51',
  channel: 'stable',
  update_available: true,
  release: {
    id: 36,
    version: '0.0.52',
    channel: 'stable',
    file_size_display: '120 MB',
    release_notes: '修复 3D 底图闪烁',
    update_available: true,
    download_url: '/api/v1/desktop-releases/36/download',
  },
  download: { phase: 'idle', downloaded: 0, total: 0 },
}

const STATUS_UP_TO_DATE = {
  ...STATUS_WITH_UPDATE,
  update_available: false,
  release: null,
}

describe('AppDownloadDialog', () => {
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    useDesktopUpdateStore.setState({ requested: null })
    vi.mocked(appVersionsApi.getLatest).mockResolvedValue({ success: false } as any)
    vi.mocked(desktopCloudApi.appVersion).mockResolvedValue({ success: false } as any)
    vi.mocked(desktopReleasesApi.latestPublic).mockResolvedValue({ success: false } as any)
  })

  afterEach(() => {
    cleanup()
    useAuthStore.setState({ desktopMode: false })
  })

  it('桌面端形态下两栏都可见，且桌面端栏展示当前版本并可立即更新', async () => {
    useAuthStore.setState({ desktopMode: true })
    vi.mocked(desktopUpdateApi.status).mockResolvedValue({
      success: true,
      data: STATUS_WITH_UPDATE,
    } as any)

    render(<AppDownloadDialog open onClose={onClose} />)

    // 两栏都在（早先 desktopMode 下整排被隐藏）
    fireEvent.click(screen.getByText(i18n.t('app.tabDesktop')))
    await waitFor(() => expect(desktopUpdateApi.status).toHaveBeenCalled())

    expect(await screen.findByText(new RegExp(i18n.t('desktopUpdate.currentVersion')))).toBeTruthy()
    expect(screen.getByText(/0\.0\.51/)).toBeTruthy()
    expect(screen.getByText(/0\.0\.52/)).toBeTruthy()

    fireEvent.click(screen.getByText(i18n.t('desktopUpdate.updateNow')))
    // 交给全局更新弹窗（下载/安装进度都在那里），本弹窗关闭
    expect(useDesktopUpdateStore.getState().requested).toEqual(STATUS_WITH_UPDATE)
    expect(onClose).toHaveBeenCalled()
  })

  it('无更新时桌面端栏显示「已是最新版本」，且没有立即更新按钮', async () => {
    useAuthStore.setState({ desktopMode: true })
    vi.mocked(desktopUpdateApi.status).mockResolvedValue({
      success: true,
      data: STATUS_UP_TO_DATE,
    } as any)

    render(<AppDownloadDialog open onClose={onClose} />)
    fireEvent.click(screen.getByText(i18n.t('app.tabDesktop')))

    expect(await screen.findByText(i18n.t('desktopUpdate.upToDate'))).toBeTruthy()
    expect(screen.queryByText(i18n.t('desktopUpdate.updateNow'))).toBeNull()
  })

  it('网页端形态仍下载桌面安装包，不调用本机 OTA 接口', async () => {
    useAuthStore.setState({ desktopMode: false })
    vi.mocked(desktopReleasesApi.latestPublic).mockResolvedValue({
      success: true,
      data: { version: '0.0.52', download_url: '/api/v1/desktop-releases/36/download' },
    } as any)

    render(<AppDownloadDialog open onClose={onClose} />)
    fireEvent.click(screen.getByText(i18n.t('app.tabDesktop')))

    expect(await screen.findByText(i18n.t('app.downloadDesktop'))).toBeTruthy()
    expect(desktopUpdateApi.status).not.toHaveBeenCalled()
  })
})
