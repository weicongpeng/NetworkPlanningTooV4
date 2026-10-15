/**
 * DesktopUpdateReadyDialog：**后台**下载安装包完成后，要弹「重启更新 / 稍后更新」对话框。
 *
 * 回归点：
 * - 只有 `background === true` 且 `phase === 'ready'` 才弹（前台下载由 DesktopUpdateDialog
 *   自己提示，不叠两个对话框；主弹窗可见时也避让）
 * - 「重启更新」= POST /desktop/update/install（与更新弹窗同一后端动作）；
 *   code===0（连接被切断，应用正在退出）不算失败
 * - 「稍后更新」按版本记忆，不反复打扰
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import i18n from '../../i18n'

vi.mock('../../services/api', () => ({
  desktopUpdateApi: {
    progress: vi.fn(),
    install: vi.fn(),
    status: vi.fn(),
    download: vi.fn(),
    background: vi.fn(),
  },
}))

// 桌面形态 + 主弹窗不可见（否则会避让）
const desktopModeState = { desktopMode: true }
vi.mock('../../store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel(desktopModeState),
}))
const storeState = { mainDialogVisible: false }
vi.mock('../../store/desktopUpdateStore', () => ({
  useDesktopUpdateStore: (sel: (s: unknown) => unknown) => sel(storeState),
}))

import { DesktopUpdateReadyDialog } from '../DesktopUpdateReadyDialog'
import { desktopUpdateApi } from '../../services/api'

const TITLE = i18n.t('desktopUpdate.downloadDoneTitle')
const READY = i18n.t('desktopUpdate.updateReady')
const LATER = i18n.t('desktopUpdate.updateLater')
const RESTART = i18n.t('desktopUpdate.restartUpdate')

describe('DesktopUpdateReadyDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    storeState.mainDialogVisible = false
  })
  afterEach(() => cleanup())

  it('后台下载未完成（downloading）时不弹', async () => {
    vi.mocked(desktopUpdateApi.progress).mockResolvedValue({
      success: true, data: { phase: 'downloading', background: true, version: '0.0.33' },
    } as any)
    render(<DesktopUpdateReadyDialog />)
    await waitFor(() => expect(desktopUpdateApi.progress).toHaveBeenCalled())
    expect(screen.queryByText(TITLE)).toBeNull()
  })

  it('前台下载完成（background=false）不弹 —— 由主更新弹窗提示', async () => {
    vi.mocked(desktopUpdateApi.progress).mockResolvedValue({
      success: true, data: { phase: 'ready', background: false, version: '0.0.33' },
    } as any)
    render(<DesktopUpdateReadyDialog />)
    await waitFor(() => expect(desktopUpdateApi.progress).toHaveBeenCalled())
    expect(screen.queryByText(TITLE)).toBeNull()
  })

  it('后台下载完成 → 弹出「重启更新 / 稍后更新」与目标版本', async () => {
    vi.mocked(desktopUpdateApi.progress).mockResolvedValue({
      success: true, data: { phase: 'ready', background: true, version: '0.0.33' },
    } as any)
    render(<DesktopUpdateReadyDialog />)
    expect(await screen.findByText(TITLE)).toBeTruthy()
    expect(screen.getByText(READY)).toBeTruthy()
    expect(screen.getByText('0.0.33')).toBeTruthy()
    expect(screen.getByText(LATER)).toBeTruthy()
    expect(screen.getByText(RESTART)).toBeTruthy()
  })

  it('点「重启更新」调用 install；真实错误码给出提示', async () => {
    vi.mocked(desktopUpdateApi.progress).mockResolvedValue({
      success: true, data: { phase: 'ready', background: true, version: '0.0.33' },
    } as any)
    vi.mocked(desktopUpdateApi.install).mockRejectedValue({ code: 500, message: 'boom' } as any)
    render(<DesktopUpdateReadyDialog />)
    fireEvent.click(await screen.findByText(RESTART))
    await waitFor(() => expect(desktopUpdateApi.install).toHaveBeenCalled())
    expect(await screen.findByText('boom')).toBeTruthy()
  })

  it('code===0（连接被切断＝正在退出安装）不算失败', async () => {
    vi.mocked(desktopUpdateApi.progress).mockResolvedValue({
      success: true, data: { phase: 'ready', background: true, version: '0.0.33' },
    } as any)
    vi.mocked(desktopUpdateApi.install).mockRejectedValue({ code: 0 } as any)
    render(<DesktopUpdateReadyDialog />)
    fireEvent.click(await screen.findByText(RESTART))
    await waitFor(() => expect(desktopUpdateApi.install).toHaveBeenCalled())
    expect(screen.queryByText(i18n.t('desktopUpdate.installFailed'))).toBeNull()
  })

  it('「稍后更新」关闭弹窗并按版本记忆（不再弹）', async () => {
    vi.mocked(desktopUpdateApi.progress).mockResolvedValue({
      success: true, data: { phase: 'ready', background: true, version: '0.0.33' },
    } as any)
    render(<DesktopUpdateReadyDialog />)
    fireEvent.click(await screen.findByText(LATER))
    expect(screen.queryByText(TITLE)).toBeNull()
    // 已记忆：重新挂载也不该再弹
    render(<DesktopUpdateReadyDialog />)
    await waitFor(() => expect(desktopUpdateApi.progress).toHaveBeenCalled())
    expect(screen.queryByText(TITLE)).toBeNull()
  })

  it('主更新弹窗可见时避让（不叠两个对话框）', async () => {
    storeState.mainDialogVisible = true
    vi.mocked(desktopUpdateApi.progress).mockResolvedValue({
      success: true, data: { phase: 'ready', background: true, version: '0.0.33' },
    } as any)
    render(<DesktopUpdateReadyDialog />)
    await new Promise((r) => setTimeout(r, 30))
    expect(desktopUpdateApi.progress).not.toHaveBeenCalled()
    expect(screen.queryByText(TITLE)).toBeNull()
  })
})
